// Anti-Link Bot v2.9.3 - Deterministic Owner Exempt + Session Persistence

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");

// IMPORTANT: Put your number in env ADMIN_NUMBER too, to avoid edits
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || "254106090661";
const DEBUG_MODE = true;
const AUTH_FOLDER = "./auth_info";

// Health check server for Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Anti-Link Bot Running");
}).listen(PORT, () => console.log("Health server on port " + PORT));

// IMPORTANT CHANGE:
// Track strikes by normalized phone (not raw JID) so device-variants don't create new strike buckets.
const userViolations = new Map();
const notAdminGroups = new Map();
const NOT_ADMIN_CACHE_TTL = 60 * 60 * 1000;

const recentMessages = new Map();
const DUP_WINDOW_MS = 30000;
const DUP_BLOCK_FROM = 2;

// ===== Flood & throughput hardening (anti-coordinated spam) =====
// 1) Sender-based flood ban: if a sender posts more than FLOOD_MAX_MSG in FLOOD_WINDOW_MS => queued immediate remove
const senderRate = new Map();
const floodBanned = new Map();
const FLOOD_WINDOW_MS = 3000;
const FLOOD_MAX_MSG = 5;
const FLOOD_BAN_TTL_MS = 60000;

// 3) Bulk moderation: buffer deletes/removal per sender to reduce API churn under flood
const pendingActions = new Map();
const BULK_DELAY_MS = 600;
const DELETE_PARALLEL = 6;

// 2) Optimized queue processing: drain in parallel batches with a hard concurrency limit
const incomingQueue = [];
let drainingQueue = false;
const QUEUE_BATCH_SIZE = 25;
const QUEUE_PARALLEL = 8;

let hasConnectedBefore = false;

// Deterministic: we learn the bot's own JID once connected
let BOT_SELF_JID = "";
let BOT_SELF_PHONE = "";

// Some WhatsApp clients expose sender as @lid (Linked-ID), not phone.
// If your messages appear as @lid with fromMe:false, set OWNER_LID to your @lid.
// You can hardcode it here or override via env OWNER_LID.
// IMPORTANT: Your logs show: 22793995452644@lid
let OWNER_LID = process.env.OWNER_LID || "22793995452644@lid";

const createSilentLogger = () => {
  const noOp = () => {};
  return {
    level: "silent",
    trace: noOp, debug: noOp, info: noOp, warn: noOp, error: noOp, fatal: noOp,
    child: () => createSilentLogger(),
  };
};

function getEncryptionKey() {
  const key = process.env.SESSION_KEY || "AntiLinkBotDefaultKey2024SecureX";
  return crypto.createHash("sha256").update(key).digest();
}

function encrypt(text) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  } catch (error) {
    console.log("Encryption error:", error.message);
    return null;
  }
}

function decrypt(text) {
  try {
    const parts = text.split(":");
    const iv = Buffer.from(parts.shift(), "hex");
    const encryptedText = parts.join(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", getEncryptionKey(), iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.log("Decryption error:", error.message);
    return null;
  }
}

function restoreSessionFromEnv() {
  try {
    const encrypted = process.env.WHATSAPP_SESSION;
    if (!encrypted) {
      console.log("ℹ️ No saved session found in environment variables");
      return false;
    }

    console.log("🔄 Restoring session from environment variable...");
    const decrypted = decrypt(encrypted);
    if (!decrypted) {
      console.log("❌ Failed to decrypt session");
      return false;
    }

    const sessionData = JSON.parse(decrypted);
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    for (const [filename, content] of Object.entries(sessionData)) {
      const filePath = path.join(AUTH_FOLDER, filename);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    }

    console.log("✅ Session restored successfully!");
    return true;
  } catch (error) {
    console.log("❌ Error restoring session:", error.message);
    return false;
  }
}

function saveSessionToEnv() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return;

    const files = fs.readdirSync(AUTH_FOLDER);
    const sessionData = {};

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = fs.readFileSync(path.join(AUTH_FOLDER, file), "utf8");
        sessionData[file] = JSON.parse(content);
      } catch (e) {}
    }

    if (Object.keys(sessionData).length === 0) return;

    const encrypted = encrypt(JSON.stringify(sessionData));
    if (!encrypted) return;

    console.log("");
    console.log("=".repeat(60));
    console.log("📁 COPY THIS SESSION DATA TO RENDER ENVIRONMENT VARIABLE:");
    console.log("=".repeat(60));
    console.log("VARIABLE NAME: WHATSAPP_SESSION");
    console.log("VARIABLE VALUE:");
    console.log(encrypted);
    console.log("=".repeat(60));
    console.log("1. Go to Render Dashboard → Your Service → Environment");
    console.log("2. Add/Update Environment Variable: WHATSAPP_SESSION");
    console.log("3. Paste the value above");
    console.log("=".repeat(60));
    console.log("");
  } catch (error) {
    console.log("❌ Error saving session:", error.message);
  }
}

function normalizeNumber(s) {
  return String(s || "").replace(/\D/g, "");
}

function extractPhoneNumber(jid) {
  if (!jid) return "";
  let clean = String(jid).split("@")[0];
  clean = clean.split(":")[0];
  return normalizeNumber(clean);
}

function jidMatchesNumber(senderJid, phoneDigits) {
  if (!senderJid || !phoneDigits) return false;
  const sj = String(senderJid);
  const digits = extractPhoneNumber(senderJid);
  const target = normalizeNumber(phoneDigits);
  if (!target) return false;

  if (digits === target) return true;
  if (sj.includes(target)) return true;

  if (digits.length >= 9 && target.length >= 9) {
    if (digits.slice(-9) === target.slice(-9)) return true;
  }

  return false;
}

function isOwner(senderJid) {
  // Deterministic owner check (phone-based):
  // - ADMIN_NUMBER: your number
  // - BOT_SELF_PHONE: the phone number of the WhatsApp account the bot is logged into
  // Note: some clients show participants as @lid (not phone). In those cases,
  // we rely on isSelfMessage(msg) and hardOwner firewall in handleMessage.
  if (jidMatchesNumber(senderJid, ADMIN_NUMBER)) return true;
  if (BOT_SELF_PHONE && jidMatchesNumber(senderJid, BOT_SELF_PHONE)) return true;
  return false;
}

function isLidJid(jid) {
  return String(jid || "").endsWith("@lid");
}

function isOwnerLid(senderJid) {
  if (!senderJid) return false;
  if (!isLidJid(senderJid)) return false;
  if (!OWNER_LID) return false;
  return String(senderJid) === String(OWNER_LID);
}

function isSelfMessage(msg) {
  // Multi-device reality:
  // - fromMe is the strongest signal (even if participant is @lid)
  // - participant/remoteJid can be group, or @lid, or phone@s.whatsapp.net
  if (!msg?.key) return false;
  if (msg.key.fromMe) return true;

  const sender = msg.key.participant || msg.key.remoteJid;
  if (BOT_SELF_JID && sender === BOT_SELF_JID) return true;

  // if we know bot phone, match against sender
  if (BOT_SELF_PHONE && jidMatchesNumber(sender, BOT_SELF_PHONE)) return true;

  return false;
}

function isExempt(msg) {
  // Single place to decide exemption.
  // IMPORTANT: @lid participants often won't match phone numbers.
  // Priority:
  // 1) fromMe (strongest)
  // 2) learned OWNER_LID match
  // 3) phone-based owner/self
  // 4) exact self JID
  if (!msg?.key) return false;
  if (msg.key.fromMe) return true;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (isOwnerLid(senderJid)) return true;
  if (isOwner(senderJid)) return true;
  if (BOT_SELF_JID && senderJid === BOT_SELF_JID) return true;
  if (BOT_SELF_PHONE && jidMatchesNumber(senderJid, BOT_SELF_PHONE)) return true;

  return false;
}

// Fast path: single precompiled regex for speed during heavy load
const FAST_LINK_REGEX = /(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|whatsapp\.com)\/\S+|\b[A-Za-z0-9-]{1,63}\.(?:com|net|org|io|co|me|app|tech|info|biz|store|online|ly|ge|ke|uk|us|tv|gg|site|blog|news|vip|link)(?:\/\S*)?\b/i;

function detectLinks(text) {
  if (!text) return false;
  return FAST_LINK_REGEX.test(text);
}

function detectPhoneNumbers(text) {
  if (!text) return false;
  return /\d{9,}/.test(text);
}

function isAPKFile(msg) {
  return msg.message?.documentMessage?.mimetype === "application/vnd.android.package-archive";
}

function isZipFile(msg) {
  const doc = msg.message?.documentMessage;
  if (!doc) return false;
  if (doc.mimetype === "application/zip") return true;
  const fileName = (doc.fileName || doc.title || "").toLowerCase();
  if (fileName.endsWith(".zip")) return true;
  return false;
}

function isAudioFile(msg) {
  const m = msg.message || {};
  if (m.audioMessage) return true;

  const vo = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
  if (vo?.audioMessage) return true;

  const doc = m.documentMessage;
  if (doc) {
    const mimetype = (doc.mimetype || "").toLowerCase();
    const fileName = (doc.fileName || doc.title || "").toLowerCase();
    if (mimetype.startsWith("audio/")) return true;
    const audioExtensions = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".wma", ".opus"];
    if (audioExtensions.some(ext => fileName.endsWith(ext))) return true;
  }

  return false;
}

function isBusinessPost(msg) {
  const p = msg.message?.productMessage;
  const c = msg.message?.catalogMessage;
  const ext = msg.message?.extendedTextMessage?.contextInfo?.externalAdReply;

  if ((!p && !c) && ext && (ext.sourceUrl || ext.mediaUrl || ext.title)) {
    const src = String(ext.sourceUrl || "");
    if (/\b(?:wa\.me|whatsapp\.com)\/(?:catalog|c)\/?/i.test(src)) return true;
  }

  if (p) {
    const prod = p.product || {};
    if (prod.productImage || prod.title || prod.description || prod.currency || prod.priceAmount1000) return true;
  }

  if (c) {
    const cat = c.catalog || {};
    if (cat.title || (cat.products && cat.products.length > 0)) return true;
  }

  return false;
}

const KEYWORDS = [
  "child","rape","free","price","payment","rupees","rupee","rs",
  "offer","discount","deal","promo","promotion","sell","selling",
  "buy","order","wholesale","cheap","delivery","inbox","mpesa",
  "ksh","kes","usd","call","business","contact","message"
];

const KEYWORDS_REGEX = new RegExp("\\b(?:" + KEYWORDS.join("|") + ")\\b", "i");

function detectKeyword(text) {
  if (!text) return false;
  return KEYWORDS_REGEX.test(text);
}

function extractTextFromContent(content) {
  if (!content || typeof content !== "object") return "";
  const texts = [];
  const push = (t) => { if (t && typeof t === "string") texts.push(t); };

  push(content.conversation);
  push(content.extendedTextMessage?.text);
  push(content.imageMessage?.caption);
  push(content.videoMessage?.caption);
  push(content.documentMessage?.caption);

  const bm = content.buttonsMessage;
  if (bm) {
    push(bm.contentText); push(bm.footerText); push(bm.headerText);
    (bm.buttons || []).forEach((b) => push(b.buttonText?.displayText));
  }

  const tmpl = content.templateMessage?.hydratedTemplate;
  if (tmpl) {
    push(tmpl.hydratedContentText);
    push(tmpl.hydratedFooterText);
    push(tmpl.hydratedTitleText);
    (tmpl.hydratedButtons || []).forEach((btn) => {
      if (!btn) return;
      if (btn.quickReplyButton) push(btn.quickReplyButton.displayText);
      if (btn.urlButton) { push(btn.urlButton.displayText); push(btn.urlButton.url); }
      if (btn.callButton) push(btn.callButton.displayText);
    });
  }

  const list = content.listMessage;
  if (list) {
    push(list.title); push(list.description); push(list.footerText); push(list.text);
    (list.sections || []).forEach((sec) => {
      (sec.rows || []).forEach((row) => { push(row.title); push(row.description); });
    });
  }

  const im = content.interactiveMessage;
  if (im) {
    push(im.body?.text);
    push(im.footer?.text);
    push(im.header?.title);
  }

  const ext = content.extendedTextMessage?.contextInfo?.externalAdReply;
  if (ext) {
    push(ext.title);
    push(ext.body);
    push(ext.mediaUrl);
    push(ext.sourceUrl);
  }

  const quoted = content.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quoted && typeof quoted === "object") push(extractTextFromContent(quoted));

  const vo = content.viewOnceMessage?.message ||
             content.viewOnceMessageV2?.message ||
             content.viewOnceMessageV2Extension?.message;
  if (vo) push(extractTextFromContent(vo));

  return texts.join(" ").trim();
}

function extractVisibleText(msg) {
  try { return extractTextFromContent(msg.message || {}) || ""; }
  catch { return ""; }
}

function hasButtons(msg) {
  const m = msg.message || {};
  return !!(m.buttonsMessage || m.templateMessage || m.listMessage || m.interactiveMessage);
}

function isContactMessage(msg) {
  const m = msg.message || {};
  if (m.contactMessage || m.contactsArrayMessage) return true;
  const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quoted?.contactMessage || quoted?.contactsArrayMessage) return true;
  const vo = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
  if (vo?.contactMessage || vo?.contactsArrayMessage) return true;
  return false;
}

function checkDuplicate(groupJid, senderJid, visibleText) {
  const text = (visibleText || "").trim().toLowerCase();
  if (!text || text.length < 5) return { isDuplicate: false, count: 0 };

  const key = groupJid + "-" + senderJid;
  const now = Date.now();
  const prev = recentMessages.get(key);

  if (!prev || (now - prev.ts) > DUP_WINDOW_MS) {
    recentMessages.set(key, { last: text, count: 1, ts: now });
    return { isDuplicate: false, count: 1 };
  }

  if (prev.last === text) {
    prev.count += 1;
    prev.ts = now;
    return { isDuplicate: prev.count >= DUP_BLOCK_FROM, count: prev.count };
  }

  recentMessages.set(key, { last: text, count: 1, ts: now });
  return { isDuplicate: false, count: 1 };
}

function cleanupCaches() {
  const now = Date.now();
  for (const [k, v] of recentMessages.entries()) {
    if ((now - v.ts) > DUP_WINDOW_MS * 3) recentMessages.delete(k);
  }
  for (const [k, v] of notAdminGroups.entries()) {
    if ((now - v) > NOT_ADMIN_CACHE_TTL) notAdminGroups.delete(k);
  }

  // Flood/rate-limit housekeeping
  for (const [k, arr] of senderRate.entries()) {
    const pruned = (arr || []).filter((ts) => (now - ts) < FLOOD_WINDOW_MS);
    if (pruned.length) senderRate.set(k, pruned);
    else senderRate.delete(k);
  }
  for (const [k, ts] of floodBanned.entries()) {
    if ((now - ts) > FLOOD_BAN_TTL_MS) floodBanned.delete(k);
  }
  for (const [k, rec] of pendingActions.entries()) {
    if (!rec || !rec.lastTs) { pendingActions.delete(k); continue; }
    if ((now - rec.lastTs) > 5 * 60 * 1000) pendingActions.delete(k);
  }
}

async function startBot() {
  try {
    restoreSessionFromEnv();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const keyStore = makeCacheableSignalKeyStore(state.keys, createSilentLogger());

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log("📱 WA v" + version.join(".") + " (latest: " + isLatest + ")");

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: keyStore },
      logger: createSilentLogger(),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 2000,
      maxRetries: 5,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      getMessage: async () => undefined,
      msgRetryCounterCache: new Map(),
    });

    if (!state.creds.registered) {
      console.log("");
      console.log("📱 Requesting pairing code for: " + ADMIN_NUMBER);
      console.log("⏳ Please wait...");
      await new Promise(r => setTimeout(r, 3000));
      try {
        const code = await sock.requestPairingCode(ADMIN_NUMBER);
        console.log("");
        console.log("╔════════════════════════════════════════╗");
        console.log("║ 📱 PAIRING CODE (Valid for 60 seconds) ║");
        console.log("╠════════════════════════════════════════╣");
        console.log("║                                        ║");
        console.log("║     " + code + "                         ║");
        console.log("║                                        ║");
        console.log("╠════════════════════════════════════════╣");
        console.log("║ 1. Open WhatsApp on your phone         ║");
        console.log("║ 2. Go to: Settings → Linked Devices    ║");
        console.log("║ 3. Tap 'Link a Device'                 ║");
        console.log("║ 4. Enter the 8-digit code above        ║");
        console.log("╚════════════════════════════════════════╝");
        console.log("");
      } catch (e) {
        console.log("⚠️ Pairing code error:", e?.message);
        console.log("🔄 Will retry in 10 seconds...");
      }
    }

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      saveSessionToEnv();
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        hasConnectedBefore = true;

        BOT_SELF_JID = sock.user?.id || "";
        BOT_SELF_PHONE = extractPhoneNumber(BOT_SELF_JID);

        console.log("");
        console.log("╔══════════════════════════════════════════╗");
        console.log("║ ✅ ANTI-LINK BOT ONLINE                  ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log("║ 🤖 Bot: " + (BOT_SELF_JID || "unknown").substring(0,30).padEnd(31) + "║");
        console.log("║ 👑 Owner: " + String(ADMIN_NUMBER).padEnd(30) + "║");
        console.log("║ 📋 Mode: All groups                      ║");
        console.log("║ 💃 We R 🆗 Baby!! 🤫                     ║");
        console.log("╚══════════════════════════════════════════╝");
        console.log("");

        if (DEBUG_MODE) {
          console.log("🔎 Debug owner match targets:");
          console.log("- ADMIN_NUMBER: " + ADMIN_NUMBER);
          console.log("- BOT_SELF_JID: " + BOT_SELF_JID);
          console.log("- BOT_SELF_PHONE: " + BOT_SELF_PHONE);
        }

        saveSessionToEnv();
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "unknown";

        console.log("🔌 Connection closed: " + reason);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("❌ Logged out. Delete WHATSAPP_SESSION env var and redeploy.");
          if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        } else {
          const delay = hasConnectedBefore ? 5000 : 10000;
          console.log("🔄 Reconnecting in " + (delay/1000) + " seconds...");
          setTimeout(() => startBot().catch(console.error), delay);
        }
      }
    });

    async function safeDelete(groupJid, msgKey) {
      const notAdmin = notAdminGroups.get(groupJid);
      if (notAdmin && (Date.now() - notAdmin) < NOT_ADMIN_CACHE_TTL) {
        if (DEBUG_MODE) console.log("⏭️ Skipping - cached as not admin");
        return false;
      }

      const maxAttempts = 3;
      let delay = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (delay) await new Promise(r => setTimeout(r, delay));
        try {
          await sock.sendMessage(groupJid, { delete: msgKey });
          return true;
        } catch (e) {
          const errMsg = String(e?.message || e || "");

          if (errMsg.includes("rate-overlimit")) {
            delay = 2000 * attempt;
            continue;
          }

          if (errMsg.includes("forbidden") || errMsg.includes("not-authorized") || errMsg.includes("403")) {
            notAdminGroups.set(groupJid, Date.now());
            console.log("📝 Not admin in this group - caching for 1 hour");
          }

          break;
        }
      }
      return false;
    }

    async function safeRemove(groupJid, userJid) {
      try {
        // SAFEGUARD: never remove owner/self/bot (even if a JID is @lid or device variant)
        if (!userJid) return false;

        if (BOT_SELF_JID && String(userJid) === String(BOT_SELF_JID)) {
          console.log("🛡️ Refused to remove bot self");
          return false;
        }

        // If userJid contains a phone-like identity, protect owner/self
        if (jidMatchesNumber(userJid, ADMIN_NUMBER) || (BOT_SELF_PHONE && jidMatchesNumber(userJid, BOT_SELF_PHONE))) {
          console.log("🛡️ Refused to remove owner/self");
          return false;
        }

        await sock.groupParticipantsUpdate(groupJid, [userJid], "remove");
        console.log("✅ User removed from group");
        return true;
      } catch (e) {
        console.log("⚠️ Could not remove user:", e?.message);
        return false;
      }
    }

    function _uniqueDeleteKeys(msgKeys) {
  const seen = new Set();
  const out = [];
  for (const k of (msgKeys || [])) {
    const id = k?.id || (k?.remoteJid ? (k.remoteJid + ':' + (k.participant || '') + ':' + (k.id || '')) : '');
    const dedupeKey = id || JSON.stringify(k);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(k);
  }
  return out;
}

function enqueueBulkViolation(groupJid, senderJid, senderId, msgKey, reasons, strikeCount, options = {}) {
  const key = groupJid + '-' + senderId;
  const now = Date.now();

  let rec = pendingActions.get(key);
  if (!rec) {
    rec = { groupJid, senderJid, senderId, msgKeys: [], reasons: new Map(), strikeCount: 0, forceRemove: false, timer: null, lastTs: now };
    pendingActions.set(key, rec);
  }

  rec.groupJid = groupJid;
  rec.senderJid = senderJid;
  rec.senderId = senderId;
  rec.lastTs = now;

  if (msgKey) rec.msgKeys.push(msgKey);
  for (const r of (reasons || [])) {
    rec.reasons.set(r, (rec.reasons.get(r) || 0) + 1);
  }

  if (typeof strikeCount === 'number') rec.strikeCount = Math.max(rec.strikeCount, strikeCount);
  if (options.forceRemove) rec.forceRemove = true;

  const delay = (typeof options.delayMs === 'number') ? options.delayMs : BULK_DELAY_MS;
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => flushBulkViolation(key).catch(() => {}), delay);
}

async function flushBulkViolation(key) {
  const rec = pendingActions.get(key);
  if (!rec) return;
  pendingActions.delete(key);
  if (rec.timer) clearTimeout(rec.timer);

  const keys = _uniqueDeleteKeys(rec.msgKeys);
  if (DEBUG_MODE) {
    const reasonsObj = {};
    for (const [r, c] of rec.reasons.entries()) reasonsObj[r] = c;
    console.log('🧹 Bulk action:', { key, deleteCount: keys.length, strikeCount: rec.strikeCount, forceRemove: rec.forceRemove, reasons: reasonsObj });
  }

  for (let i = 0; i < keys.length; i += DELETE_PARALLEL) {
    const slice = keys.slice(i, i + DELETE_PARALLEL);
    await Promise.allSettled(slice.map((k) => safeDelete(rec.groupJid, k)));
  }

  if (rec.forceRemove || rec.strikeCount >= 3) {
    await new Promise(r => setTimeout(r, 200));
    const removed = await safeRemove(rec.groupJid, rec.senderJid);
    if (removed) {
      const userKey = rec.groupJid + '-' + rec.senderId;
      userViolations.delete(userKey);
    }
  }
}
async function handleMessage(msg) {
      try {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) return;
        if (!msg.message) return;

        const groupJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command (keep your preferred format, no version)
        if (textLower === "!bot") {
          console.log("📨 !bot command from:", senderJid);

          // Learn owner's LID if present (fixes cases where your messages come as @lid with fromMe:false)
          // If OWNER_LID is already set/hardcoded, we keep it.
          if (isLidJid(senderJid) && (!OWNER_LID || OWNER_LID === "")) {
            OWNER_LID = String(senderJid);
            console.log("🔐 Learned OWNER_LID:", OWNER_LID);
            console.log("ℹ️ Save this in Render env var OWNER_LID to persist across restarts.");
          }

          try {
            let responseText = "✅ ANTI-LINK BOT ACTIVE\n";
            responseText += "👑 Owner: " + ADMIN_NUMBER + "\n";
          
            responseText += "💃 We R 🆗 Baby!! 🤫\n";
            await sock.sendMessage(groupJid, { text: responseText });
            console.log("✅ Sent !bot response");
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e?.message);
          }
          return;
        }

        // ===== OWNER/SELF EXEMPTION (single source of truth) =====
        const senderPhone = extractPhoneNumber(senderJid);
        const owner = isOwner(senderJid);
        const self = isSelfMessage(msg);
        const exempt = isExempt(msg);

        // HARD OWNER FIREWALL
        // 1) Phone-based match (normal JIDs)
        // 2) OWNER_LID match (for @lid senders where fromMe can be false)
        const hardOwner = (
          (senderPhone && (
            normalizeNumber(senderPhone) === normalizeNumber(ADMIN_NUMBER) ||
            (BOT_SELF_PHONE && normalizeNumber(senderPhone) === normalizeNumber(BOT_SELF_PHONE))
          )) ||
          isOwnerLid(senderJid)
        );

        if (DEBUG_MODE) {
          console.log("🧾 owner-check:", {
            senderJid,
            senderPhone,
            fromMe: !!msg.key.fromMe,
            admin: ADMIN_NUMBER,
            botSelfJid: BOT_SELF_JID,
            botSelfPhone: BOT_SELF_PHONE,
            owner,
            ownerLid: isOwnerLid(senderJid),
            ownerLidValue: OWNER_LID,
            self,
            exempt,
            hardOwner,
            senderIsLid: isLidJid(senderJid)
          });
        }

        // Absolute exemption: if fromMe OR owner/self, do nothing (no violations, no strikes).
        if (exempt || hardOwner) {
          if (DEBUG_MODE) console.log("👑 Exempt message - skipping checks");
          return;
        }

        // ===== NOT OWNER - CHECK FOR VIOLATIONS =====


        // ===== PRIORITY: SENDER-BASED FLOOD BAN (anti-spam) =====
        // If a sender exceeds FLOOD_MAX_MSG in FLOOD_WINDOW_MS, schedule immediate remove and bulk-delete their spam.
        const senderId = senderPhone || senderJid;
        const rateKey = groupJid + '-' + senderId;
        const now = Date.now();


        const bannedAt = floodBanned.get(rateKey);
        if (bannedAt && (now - bannedAt) < FLOOD_BAN_TTL_MS) {
          enqueueBulkViolation(groupJid, senderJid, senderId, msg.key, ['flood-ban'], 3, { forceRemove: true, delayMs: 0 });
          return;
        }


        const arr = senderRate.get(rateKey) || [];
        const pruned = arr.filter((ts) => (now - ts) < FLOOD_WINDOW_MS);
        pruned.push(now);
        senderRate.set(rateKey, pruned);


        if (pruned.length > FLOOD_MAX_MSG) {
          floodBanned.set(rateKey, now);
          userViolations.set(rateKey, 3);
          console.log('🚨 FLOOD-BAN: ' + senderJid + ' -> ' + pruned.length + ' msgs/' + FLOOD_WINDOW_MS + 'ms');
          enqueueBulkViolation(groupJid, senderJid, senderId, msg.key, ['flood(' + pruned.length + '/' + FLOOD_WINDOW_MS + 'ms)'], 3, { forceRemove: true, delayMs: 0 });
          return;
        }


        const dup = checkDuplicate(groupJid, senderJid, visibleText);
        const hasLink = detectLinks(visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg);
        const apk = isAPKFile(msg);
        const zip = isZipFile(msg);
        const audio = isAudioFile(msg);
        const keyword = detectKeyword(visibleText);
        const buttons = hasButtons(msg);
        const contact = isContactMessage(msg);

        const violated = dup.isDuplicate || hasLink || hasPhone || business || apk || zip || audio || keyword || buttons || contact;
        if (!violated) return;

        const reasons = [];
        if (dup.isDuplicate) reasons.push("duplicate(x" + dup.count + ")");
        if (hasLink) reasons.push("link");
        if (hasPhone) reasons.push("phone");
        if (business) reasons.push("business");
        if (apk) reasons.push("apk");
        if (zip) reasons.push("zip");
        if (audio) reasons.push("audio");
        if (keyword) reasons.push("keyword");
        if (buttons) reasons.push("buttons");
        if (contact) reasons.push("contact");

        // Use normalized phone for strike key to avoid device JID variations.
        // If no phone (e.g. @lid), fall back to senderJid.
        const strikeId = senderId;
        const userKey = groupJid + "-" + strikeId;
        const current = userViolations.get(userKey) || 0;
        const updated = current + 1;
        userViolations.set(userKey, updated);

        console.log("");
        console.log("🚫 VIOLATION DETECTED");
        console.log("User: " + senderJid);
        console.log("Group: " + groupJid);
        console.log("Reason: " + reasons.join(", "));
        console.log("Strike: " + updated + "/3");
        console.log("Text: " + visibleText.substring(0, 100));
        // Bulk delete + single removal flush (reduces API calls during coordinated spam)
        enqueueBulkViolation(groupJid, senderJid, strikeId, msg.key, reasons, updated, { forceRemove: updated >= 3 });
        console.log("");
      } catch (e) {
        console.log("⚠️ Error:", e?.message);
      }
    }

    function enqueueIncomingMessages(msgs) {
  for (const msg of (msgs || [])) {
    if (!msg?.key?.remoteJid?.endsWith('@g.us')) continue;
    if (!msg.message) continue;
    incomingQueue.push(msg);
  }
  if (!drainingQueue) {
    drainingQueue = true;
    const sched = (typeof setImmediate === 'function') ? setImmediate : (fn) => setTimeout(fn, 0);
    sched(drainIncomingQueue);
  }
}

async function drainIncomingQueue() {
  try {
    while (incomingQueue.length) {
      const batch = incomingQueue.splice(0, QUEUE_BATCH_SIZE);
      for (let i = 0; i < batch.length; i += QUEUE_PARALLEL) {
        const slice = batch.slice(i, i + QUEUE_PARALLEL);
        await Promise.allSettled(slice.map((msg) => handleMessage(msg)));
      }
    }
  } finally {
    drainingQueue = false;
    if (incomingQueue.length) {
      drainingQueue = true;
      setTimeout(drainIncomingQueue, 0);
    }
  }
}

sock.ev.on('messages.upsert', (m) => {
  enqueueIncomingMessages(m.messages || []);
});

    setInterval(cleanupCaches, 30000);
    console.log("🚀 Bot initialized - waiting for connection...");

  } catch (e) {
    console.log("❌ Start error:", e.message);
    console.log("🔄 Retrying in 30 seconds...");
    setTimeout(() => startBot().catch(() => {}), 30000);
  }
}

startBot();
