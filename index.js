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

// Backcheck: keep a short rolling window of msg keys per sender so we can delete everything when flood-ban triggers
const senderRecentKeys = new Map();
const RECENT_KEY_TTL_MS = Math.max(10000, FLOOD_WINDOW_MS * 2);
const RECENT_KEY_MAX = 80;

// Retry deletes that fail under rate limiting (best-effort backchecking)
let deleteRetryQueue = [];
let deleteRetryTimer = null;
const DELETE_RETRY_MAX_ATTEMPTS = 6;
const DELETE_RETRY_MAX_AGE_MS = 5 * 60 * 1000;

// 3) Bulk moderation: buffer deletes/removal per sender to reduce API churn under flood
const pendingActions = new Map();
const BULK_DELAY_MS = 600;
const DELETE_PARALLEL = 6;

// 2) Optimized queue processing: drain in parallel batches with a hard concurrency limit
// Priority queues: link-like messages are processed first to reduce 'slip-through' during floods
const incomingQueueHi = [];
const incomingQueueLo = [];
let drainingQueue = false;
const QUEUE_BATCH_SIZE = 25;
const QUEUE_PARALLEL = 8;
// Yielding: keep event-loop responsive; go to 0ms under big backlog
const QUEUE_YIELD_IDLE_MS = 10;
const QUEUE_YIELD_BUSY_MS = 0;

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
      console.log("🧩 Likely causes: (1) WHATSAPP_SESSION value is truncated/corrupted, or (2) SESSION_KEY changed since session was generated.");
      console.log("✅ Fix: restore the original SESSION_KEY, OR delete WHATSAPP_SESSION env var to force a fresh pairing, then redeploy.");
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
    // If you already set WHATSAPP_SESSION in Render env, do NOT keep printing new values.
    // The session content is equivalent (new IV each time) and repeated printing causes confusion.
    if (process.env.WHATSAPP_SESSION && String(process.env.WHATSAPP_SESSION).trim().length > 40) return;
    if (saveSessionToEnv._shown) return;
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
    saveSessionToEnv._shown = true;
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

function getSenderJidForMsg(msg) {
  try {
    if (!msg?.key) return "";
    const remote = String(msg.key.remoteJid || "");
    // For group messages, ONLY participant identifies the sender. Never fall back to the group JID.
    if (remote.endsWith("@g.us")) return String(msg.key.participant || msg.participant || "");
    return remote;
  } catch { return ""; }
}
function isSelfMessage(msg) {
  // Multi-device reality:
  // - fromMe is the strongest signal (even if participant is @lid)
  // - participant/remoteJid can be group, or @lid, or phone@s.whatsapp.net
  if (!msg?.key) return false;
  if (msg.key.fromMe) return true;

  const sender = getSenderJidForMsg(msg) || msg.key.participant || msg.key.remoteJid;
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

  const senderJid = getSenderJidForMsg(msg);
  // In groups, if participant is missing, treat as NOT exempt (never use group JID as sender identity).
  if (!senderJid) return false;
  if (isOwnerLid(senderJid)) return true;
  if (isOwner(senderJid)) return true;
  if (BOT_SELF_JID && senderJid === BOT_SELF_JID) return true;
  if (BOT_SELF_PHONE && jidMatchesNumber(senderJid, BOT_SELF_PHONE)) return true;

  return false;
}

// Fast path: single precompiled regex for speed during heavy load
// NOTE: We normalize common obfuscation characters (zero-width + unicode dot/slash/colon) before testing.
const FAST_LINK_REGEX = /(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|whatsapp\.com)\/\S+|\b[A-Za-z0-9-]{1,63}\.(?:com|net|org|io|co|me|app|tech|info|biz|store|online|ly|ge|ke|uk|us|tv|gg|site|blog|news|vip|link)(?:\/\S*)?\b/i;
// Remove invisible/control chars often used to break URLs (zero-width, soft hyphen, direction marks)
// Expanded set includes: word-joiner, variation selectors, combining grapheme joiner, bidi isolates, etc.
const LINK_INVIS_REGEX = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFE00-\uFE0F\uE0000-\uE007F\u2066-\u2069]/g;
// Includes common dot-lookalikes used by spammers: fullwidth dot, ideographic dot, middle dot, bullet, etc.
const LINK_DOTLIKE_REGEX = /[\u3002\uFF0E\uFF61\u2024\u2219\uFE52\u2027\u00B7\u0387\u30FB\u2022]/g;
const LINK_SLASHLIKE_REGEX = /[\u2215\u2044\uFF0F]/g;
const LINK_COLONLIKE_REGEX = /[\uFF1A]/g;
// Handle common textual obfuscations like: abr[.]ge  abr(dot)ge  https[:]//
const LINK_BRACKET_DOT_REGEX = /[\[\(\{]\s*(?:\.|dot)\s*[\]\)\}]/gi;
const LINK_BRACKET_SLASH_REGEX = /[\[\(\{]\s*(?:\/|slash)\s*[\]\)\}]/gi;
const LINK_BRACKET_COLON_REGEX = /[\[\(\{]\s*(?::|colon)\s*[\]\)\}]/gi;

function normalizeForLinkDetect(text) {
  let s = String(text || '');
  // NFKC reduces lookalike forms (fullwidth chars, compatibility chars) used in obfuscation
  try { s = s.normalize('NFKC'); } catch {}
  return s
    .replace(LINK_INVIS_REGEX, '')
    // Normalize exotic whitespace to regular spaces, then let callers optionally compact
    .replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, ' ')
    .replace(LINK_DOTLIKE_REGEX, '.')
    .replace(LINK_BRACKET_DOT_REGEX, '.')
    .replace(LINK_SLASHLIKE_REGEX, '/')
    .replace(LINK_BRACKET_SLASH_REGEX, '/')
    .replace(LINK_COLONLIKE_REGEX, ':')
    .replace(LINK_BRACKET_COLON_REGEX, ':');
}

// Extra safety: catch cases where the protocol separators are split (e.g. h t t p : / /)
function _compactForLinkDetect(s) {
  return String(s || '').replace(/\s+/g, '');
}

function _stripBrackets(s) {
  return String(s || '').replace(/[\[\]\(\)\{\}<>]/g, '');
}

function _dehxxp(s) {
  return String(s || '').replace(/\bhxxps?:/ig, (m) => m.replace(/xx/ig, 'tt'));
}


function detectLinks(text) {
  if (!text) return false;
  const t0 = normalizeForLinkDetect(text);
  if (FAST_LINK_REGEX.test(t0)) return true;

  // Fallback 1: spaced/line-broken links
  const t1 = _compactForLinkDetect(t0);
  if (t1 !== t0 && FAST_LINK_REGEX.test(t1)) return true;

  // Fallback 2: remove surrounding brackets frequently used with [.] or (dot)
  const t2 = _stripBrackets(t1);
  if (t2 !== t1 && FAST_LINK_REGEX.test(t2)) return true;

  // Fallback 3: common scheme obfuscation hxxp(s) => http(s)
  const t3 = _dehxxp(t2);
  if (t3 !== t2 && FAST_LINK_REGEX.test(t3)) return true;

  // Fallback 4: extra aggressive compact after dehxxp
  const t4 = _compactForLinkDetect(t3);
  if (t4 !== t3 && FAST_LINK_REGEX.test(t4)) return true;

  return false;
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
  push(content.extendedTextMessage?.canonicalUrl);
  push(content.extendedTextMessage?.matchedText);
  push(content.extendedTextMessage?.description);
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

function unwrapMessageContent(message) {
  let m = message;
  // Unwrap common Baileys wrappers so downstream checks see the real payload.
  for (let i = 0; i < 8; i++) {
    if (!m || typeof m !== 'object') break;
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue; }
    if (m.viewOnceMessageV2Extension?.message) { m = m.viewOnceMessageV2Extension.message; continue; }
    if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue; }
    if (m.deviceSentMessage?.message) { m = m.deviceSentMessage.message; continue; }
    if (m.editedMessage?.message) { m = m.editedMessage.message; continue; }
    break;
  }
  return m || {};
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
  // Also drop flood-ban state once TTL expires (handled below)
  for (const [k, ts] of floodBanned.entries()) {
    if ((now - ts) > FLOOD_BAN_TTL_MS) floodBanned.delete(k);
  }
  for (const [k, arr] of senderRecentKeys.entries()) {
    const pruned = (arr || []).filter((x) => x && x.ts && (now - x.ts) < RECENT_KEY_TTL_MS);
    if (pruned.length) senderRecentKeys.set(k, pruned.slice(-RECENT_KEY_MAX));
    else senderRecentKeys.delete(k);
  }
  for (const [k, rec] of pendingActions.entries()) {
    if (!rec || !rec.lastTs) { pendingActions.delete(k); continue; }
    if ((now - rec.lastTs) > 5 * 60 * 1000) pendingActions.delete(k);
  }
  if (Array.isArray(deleteRetryQueue) && deleteRetryQueue.length) {
    deleteRetryQueue = deleteRetryQueue.filter((x) => x && (now - (x.firstTs || now)) < DELETE_RETRY_MAX_AGE_MS && (x.attempt || 0) <= DELETE_RETRY_MAX_ATTEMPTS);
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

    async function requestPairingWithRetry() {
      try {
        console.log("");
        console.log("📱 Requesting pairing code for: " + ADMIN_NUMBER);
        console.log("⏳ Please wait...");
        await new Promise(r => setTimeout(r, 3000));
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
        return true;
      } catch (e) {
        console.log("⚠️ Pairing code error:", e?.message);
        return false;
      }
    }    if (!state.creds.registered) {
      // If session restore failed or this is a fresh deploy, request pairing code.
      // Retry a few times in case Render/network is flaky on first boot.
      (async () => {
        for (let i = 0; i < 5; i++) {
          const ok = await requestPairingWithRetry();
          if (ok) break;
          console.log('🔄 Will retry pairing code in 10 seconds...');
          await new Promise(r => setTimeout(r, 10000));
        }
      })().catch(() => {});
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

    function rememberSenderKey(rateKey, msgKey) {
  try {
    if (!rateKey || !msgKey) return;
    const now = Date.now();
    const arr = senderRecentKeys.get(rateKey) || [];
    arr.push({ ts: now, key: msgKey });
    if (arr.length > RECENT_KEY_MAX) arr.splice(0, arr.length - RECENT_KEY_MAX);
    senderRecentKeys.set(rateKey, arr);
  } catch {}
}

function getRecentSenderKeys(rateKey) {
  try {
    const now = Date.now();
    const arr = senderRecentKeys.get(rateKey) || [];
    const pruned = (arr || []).filter((x) => x && x.ts && (now - x.ts) < RECENT_KEY_TTL_MS);
    if (pruned.length) senderRecentKeys.set(rateKey, pruned.slice(-RECENT_KEY_MAX));
    else senderRecentKeys.delete(rateKey);
    return pruned.map((x) => x.key);
  } catch { return []; }
}

function _uniqueDeleteKeys(msgKeys) {
  const seen = new Set();
  const out = [];
  for (const k of (msgKeys || [])) {
    const id = k?.remoteJid ? (k.remoteJid + ':' + (k.participant || '') + ':' + (k.id || '')) : (k?.id || '');
    const dedupeKey = id || JSON.stringify(k);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(k);
  }
  return out;
}

function enqueueDeleteRetry(groupJid, msgKey, attempt = 1) {
  try {
    if (!groupJid || !msgKey) return;
    if (attempt > DELETE_RETRY_MAX_ATTEMPTS) return;
    const now = Date.now();
    const id = groupJid + ':' + (msgKey.participant || '') + ':' + (msgKey.id || '');
    if (deleteRetryQueue.some((x) => x && x.id === id)) return;
    deleteRetryQueue.push({ id, groupJid, msgKey, attempt, firstTs: now, nextTs: now + Math.min(15000, 1200 * attempt) });
    if (!deleteRetryTimer) deleteRetryTimer = setTimeout(() => drainDeleteRetryQueue().catch(() => {}), 800);
  } catch {}
}

async function drainDeleteRetryQueue() {
  const now = Date.now();
  deleteRetryTimer = null;

  // drop old/over-attempt items
  deleteRetryQueue = (deleteRetryQueue || []).filter((x) => x && (now - (x.firstTs || now)) < DELETE_RETRY_MAX_AGE_MS && (x.attempt || 0) <= DELETE_RETRY_MAX_ATTEMPTS);
  if (!deleteRetryQueue.length) return;

  deleteRetryQueue.sort((a, b) => (a.nextTs || 0) - (b.nextTs || 0));
  const ready = deleteRetryQueue.filter((x) => (x.nextTs || 0) <= now);
  const pending = deleteRetryQueue.filter((x) => (x.nextTs || 0) > now);
  deleteRetryQueue = pending;

  const PAR = Math.max(1, Math.floor(DELETE_PARALLEL / 2));
  for (let i = 0; i < ready.length; i += PAR) {
    const slice = ready.slice(i, i + PAR);
    const results = await Promise.allSettled(slice.map((it) => safeDelete(it.groupJid, it.msgKey)));
    results.forEach((r, idx) => {
      const it = slice[idx];
      const ok = (r.status === 'fulfilled') && r.value === true;
      if (!ok) enqueueDeleteRetry(it.groupJid, it.msgKey, (it.attempt || 1) + 1);
    });
    await new Promise(r => setTimeout(r, 120));
  }

  if (deleteRetryQueue.length) {
    const nextIn = Math.max(400, Math.min(...deleteRetryQueue.map((x) => Math.max(0, (x.nextTs || 0) - Date.now()))));
    deleteRetryTimer = setTimeout(() => drainDeleteRetryQueue().catch(() => {}), nextIn);
  }
}

function enqueueBulkViolation(groupJid, senderJid, senderId, msgKeyOrKeys, reasons, strikeCount, options = {}) {
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

  const keys = Array.isArray(msgKeyOrKeys) ? msgKeyOrKeys : (msgKeyOrKeys ? [msgKeyOrKeys] : []);
  if (keys.length) rec.msgKeys.push(...keys);
  for (const r of (reasons || [])) {
    rec.reasons.set(r, (rec.reasons.get(r) || 0) + 1);
  }

  if (typeof strikeCount === 'number') rec.strikeCount = Math.max(rec.strikeCount, strikeCount);
  if (options.forceRemove) rec.forceRemove = true;

  // IMPORTANT: do NOT keep postponing the flush under continuous spam.
  // We schedule the first flush and keep it (only pulling it earlier if delayMs is smaller).
  const delay = Math.max(0, (typeof options.delayMs === 'number') ? options.delayMs : BULK_DELAY_MS);
  const due = now + delay;

  if (!rec.timer) {
    rec.dueTs = due;
    rec.timer = setTimeout(() => flushBulkViolation(key).catch(() => {}), Math.max(0, rec.dueTs - Date.now()));
  } else {
    if (!rec.dueTs) rec.dueTs = due;
    if (due < rec.dueTs) {
      clearTimeout(rec.timer);
      rec.dueTs = due;
      rec.timer = setTimeout(() => flushBulkViolation(key).catch(() => {}), Math.max(0, rec.dueTs - Date.now()));
    }
  }
}

async function flushBulkViolation(key) {
  const rec = pendingActions.get(key);
  if (!rec) return;
  pendingActions.delete(key);
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = null;
  rec.dueTs = 0;

  const keys = _uniqueDeleteKeys(rec.msgKeys);
  if (DEBUG_MODE) {
    const reasonsObj = {};
    for (const [r, c] of rec.reasons.entries()) reasonsObj[r] = c;
    console.log('🧹 Bulk action:', { key, deleteCount: keys.length, strikeCount: rec.strikeCount, forceRemove: rec.forceRemove, reasons: reasonsObj });
  }

  for (let i = 0; i < keys.length; i += DELETE_PARALLEL) {
    const slice = keys.slice(i, i + DELETE_PARALLEL);
    const results = await Promise.allSettled(slice.map((k) => safeDelete(rec.groupJid, k)));
    results.forEach((r, idx) => {
      const ok = (r.status === 'fulfilled') && r.value === true;
      if (!ok) enqueueDeleteRetry(rec.groupJid, slice[idx], 1);
    });
  }

  // kick retry sweeper (if needed)
  if (deleteRetryQueue.length && !deleteRetryTimer) deleteRetryTimer = setTimeout(() => drainDeleteRetryQueue().catch(() => {}), 800);

  if (rec.forceRemove || rec.strikeCount >= 3) {
    await new Promise(r => setTimeout(r, 200));
    const removed = await safeRemove(rec.groupJid, rec.senderJid);
    if (removed) {
      const userKey = rec.groupJid + '-' + rec.senderId;
      userViolations.delete(userKey);
      senderRate.delete(userKey);
      senderRecentKeys.delete(userKey);
    }
  }
}
async function handleMessage(msg) {
      try {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) return;
        if (!msg.message) return;

        const groupJid = msg.key.remoteJid;
        const senderJid = getSenderJidForMsg(msg) || msg.key.participant || msg.participant || "";
        if (!senderJid) {
          if (DEBUG_MODE) console.log("⚠️ Missing participant (senderJid) in group message; skipping moderation for safety");
          return;
        }
        const __unwrappedMsg = unwrapMessageContent(msg.message);
        const msg0 = (__unwrappedMsg === msg.message) ? msg : { ...msg, message: __unwrappedMsg };
        const visibleText = extractVisibleText(msg0).trim();
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


        // ===== PRIORITY: EARLY LINK CHECK (fast path during floods) =====
        // If a message contains a link, act immediately (bulk-delete/remove) and skip heavier checks.
        // This reduces the chance that link spam slips through while the bot is under load.
        try {
          const earlyLink = detectLinks(visibleText);
          if (earlyLink) {
            const senderId0 = senderPhone || senderJid;
            const rateKey0 = groupJid + '-' + senderId0;
            rememberSenderKey(rateKey0, msg.key);
            const userKey0 = rateKey0;
            const current0 = userViolations.get(userKey0) || 0;
            const updated0 = current0 + 1;
            userViolations.set(userKey0, updated0);
            enqueueBulkViolation(groupJid, senderJid, senderId0, msg.key, ['link'], updated0, { forceRemove: updated0 >= 3 });
            return;
          }
        } catch {}


        // ===== PRIORITY: SENDER-BASED FLOOD BAN (anti-spam + backcheck) =====
        // Backcheck idea: once threshold trips, we delete ALL recent keys for that sender (even if some messages were still waiting in the queue).
        const senderId = senderPhone || senderJid;
        const rateKey = groupJid + '-' + senderId;
        const now = Date.now();

        // Ensure current key is in the backcheck window (even if enqueue hook missed it)
        rememberSenderKey(rateKey, msg.key);

        const bannedAt = floodBanned.get(rateKey);
        if (bannedAt && (now - bannedAt) < FLOOD_BAN_TTL_MS) {
          const backKeys = getRecentSenderKeys(rateKey);
          enqueueBulkViolation(groupJid, senderJid, senderId, backKeys, ['flood-ban'], 3, { forceRemove: true, delayMs: 0 });
          return;
        }

        const arr = senderRate.get(rateKey) || [];
        const pruned = arr.filter((ts) => (now - ts) < FLOOD_WINDOW_MS);
        // NOTE: we increment senderRate at message ingest time (messages.upsert) to catch floods even if processing lags.
        senderRate.set(rateKey, pruned);

        if (pruned.length > FLOOD_MAX_MSG) {
          floodBanned.set(rateKey, now);
          userViolations.set(rateKey, 3);
          console.log('🚨 FLOOD-BAN: ' + senderJid + ' -> ' + pruned.length + ' msgs/' + FLOOD_WINDOW_MS + 'ms');
          const backKeys = getRecentSenderKeys(rateKey);
          enqueueBulkViolation(groupJid, senderJid, senderId, backKeys, ['flood(' + pruned.length + '/' + FLOOD_WINDOW_MS + 'ms)'], 3, { forceRemove: true, delayMs: 0 });
          return;
        }


        const dup = checkDuplicate(groupJid, senderJid, visibleText);
        const hasLink = detectLinks(visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg0);
        const apk = isAPKFile(msg0);
        const zip = isZipFile(msg0);
        const audio = isAudioFile(msg0);
        const keyword = detectKeyword(visibleText);
        const buttons = hasButtons(msg0);
        const contact = isContactMessage(msg0);

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

    // Backcheck + PRIORITY flood-ban at ingest time (before queueing) to prevent queue blowups/hangs
    let groupJid = null;
    let senderJid = null;
    let senderPhone = null;
    let senderId = null;
    let rateKey = null;
    let now = null;
    try {
      groupJid = msg.key.remoteJid;
      senderJid = getSenderJidForMsg(msg) || msg.key.participant || msg.participant || '';
      if (!senderJid) continue;
      senderPhone = extractPhoneNumber(senderJid);
      senderId = senderPhone || senderJid;
      rateKey = groupJid + '-' + senderId;
      now = Date.now();

      rememberSenderKey(rateKey, msg.key);

      // Never rate-limit/remove exempt messages (owner/self/fromMe)
      if (!isExempt(msg)) {
        const bannedAt = floodBanned.get(rateKey);
        if (bannedAt && (now - bannedAt) < FLOOD_BAN_TTL_MS) {
          const backKeys = getRecentSenderKeys(rateKey);
          enqueueBulkViolation(groupJid, senderJid, senderId, backKeys, ['flood-ban'], 3, { forceRemove: true, delayMs: 0 });
          continue;
        }

        const arr = senderRate.get(rateKey) || [];
        const pruned = arr.filter((ts) => (now - ts) < FLOOD_WINDOW_MS);
        pruned.push(now);
        senderRate.set(rateKey, pruned);

        if (pruned.length > FLOOD_MAX_MSG) {
          floodBanned.set(rateKey, now);
          userViolations.set(rateKey, 3);
          console.log('🚨 FLOOD-BAN(ingest): ' + senderJid + ' -> ' + pruned.length + ' msgs/' + FLOOD_WINDOW_MS + 'ms');
          const backKeys = getRecentSenderKeys(rateKey);
          enqueueBulkViolation(groupJid, senderJid, senderId, backKeys, ['flood(' + pruned.length + '/' + FLOOD_WINDOW_MS + 'ms)'], 3, { forceRemove: true, delayMs: 0 });
          continue;
        }
      }
    } catch {}

    // Link-priority enqueue: attempt a lightweight link signal from extracted visible text
    // (unwrap wrappers + use the patched detectLinks). If anything fails, default to low queue.
    let hi = false;
    try {
      const __unwrapped = (typeof unwrapMessageContent === 'function') ? unwrapMessageContent(msg.message) : msg.message;
      const msg0 = (__unwrapped === msg.message) ? msg : { ...msg, message: __unwrapped };
      const t = extractVisibleText(msg0);
      hi = !!(t && detectLinks(t));
    } catch { hi = false; }

    if (hi) incomingQueueHi.push(msg);
    else incomingQueueLo.push(msg);
  }
  if (!drainingQueue) {
    drainingQueue = true;
    const sched = (typeof setImmediate === 'function') ? setImmediate : (fn) => setTimeout(fn, 0);
    sched(drainIncomingQueue);
  }
}

function _queueLen() { return (incomingQueueHi.length + incomingQueueLo.length); }

async function drainIncomingQueue() {
  try {
    while (_queueLen()) {
      // Always consume from high-priority first
      const batch = [];
      while (batch.length < QUEUE_BATCH_SIZE && incomingQueueHi.length) batch.push(incomingQueueHi.shift());
      while (batch.length < QUEUE_BATCH_SIZE && incomingQueueLo.length) batch.push(incomingQueueLo.shift());
      if (!batch.length) break;

      for (let i = 0; i < batch.length; i += QUEUE_PARALLEL) {
        const slice = batch.slice(i, i + QUEUE_PARALLEL);
        await Promise.allSettled(slice.map(async (msg) => {
          // Fast path: if already flood-banned, don't waste CPU; bulk-delete via backcheck and skip handleMessage()
          try {
            const groupJid = msg.key.remoteJid;
            const senderJid = getSenderJidForMsg(msg) || msg.key.participant || msg.participant || '';
            if (!senderJid) return;
            const senderPhone = extractPhoneNumber(senderJid);
            const senderId = senderPhone || senderJid;
            const rateKey = groupJid + '-' + senderId;
            const bannedAt = floodBanned.get(rateKey);
            if (bannedAt && (Date.now() - bannedAt) < FLOOD_BAN_TTL_MS) {
              rememberSenderKey(rateKey, msg.key);
              const backKeys = getRecentSenderKeys(rateKey);
              enqueueBulkViolation(groupJid, senderJid, senderId, backKeys, ['flood-ban'], 3, { forceRemove: true, delayMs: 0 });
              return;
            }
          } catch {}
          return handleMessage(msg);
        }));

        // Adaptive yield: 0ms when backlog high, 10ms otherwise
        const backlog = _queueLen();
        const yieldMs = backlog >= (QUEUE_BATCH_SIZE * 4) ? QUEUE_YIELD_BUSY_MS : QUEUE_YIELD_IDLE_MS;
        if (yieldMs > 0) await new Promise(r => setTimeout(r, yieldMs));
      }
    }
  } finally {
    drainingQueue = false;
    if (_queueLen()) {
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
