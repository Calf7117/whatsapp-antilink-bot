// Anti-Link Bot v2.9.4 - Flood Resistant + Priority Queue

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

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || "254106090661";
const DEBUG_MODE = true;
const AUTH_FOLDER = "./auth_info";

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Anti-Link Bot Running");
}).listen(PORT, () => console.log("Health server on port " + PORT));

console.log("🔧 Build: 2025-12-31 (link-probe-fallback + stable exemption logs)");

const userViolations = new Map();
const notAdminGroups = new Map();
const NOT_ADMIN_CACHE_TTL = 60 * 60 * 1000;

const recentMessages = new Map();
const DUP_WINDOW_MS = 30000;
const DUP_BLOCK_FROM = 2;

let hasConnectedBefore = false;
let BOT_SELF_JID = "";
let BOT_SELF_PHONE = "";
let OWNER_LID = process.env.OWNER_LID || "22793995452644@lid";

// === PRIORITY QUEUE SYSTEM ===
const queueHigh = []; // Links get priority
const queueLow = [];  // Other messages
let isProcessing = false;

// Track recent message keys per sender so when a spammer is removed/re-added or floods,
// we can still back-delete anything that slipped through.
const senderRecentKeys = new Map();
const RECENT_KEY_TTL_MS = 30 * 1000;
const RECENT_KEY_MAX = 120;

// Best-effort delete retry queue (rate limits / transient failures)
let deleteRetryQueue = [];
let deleteRetryTimer = null;
const DELETE_RETRY_MAX_ATTEMPTS = 8;
const DELETE_RETRY_MAX_AGE_MS = 5 * 60 * 1000;
const DELETE_PARALLEL = 6;

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
    const pruned = arr.filter((x) => x && x.ts && (now - x.ts) < RECENT_KEY_TTL_MS);
    if (pruned.length) senderRecentKeys.set(rateKey, pruned.slice(-RECENT_KEY_MAX));
    else senderRecentKeys.delete(rateKey);
    return pruned.map((x) => x.key);
  } catch { return []; }
}

function uniqueDeleteKeys(keys) {
  const seen = new Set();
  const out = [];
  for (const k of (keys || [])) {
    if (!k) continue;
    const id = (k.remoteJid || '') + ':' + (k.participant || '') + ':' + (k.id || '');
    const dedupe = id || JSON.stringify(k);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(k);
  }
  return out;
}

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
    // Render sometimes stores env vars with accidental whitespace/newlines or surrounding quotes.
    // Strip them so we don't end up passing invalid hex into Buffer/crypto.
    let raw = String(text || "");
    raw = raw.trim();
    raw = raw.replace(/^['"]|['"]$/g, "");
    raw = raw.replace(/s+/g, "");
    // Extra hardening: strip any accidental characters (e.g. "VARIABLE VALUE:" prefix) so Buffer/crypto never sees non-hex
    raw = raw.replace(/[^0-9a-fA-F:]/g, "");

    if (!raw || !raw.includes(":")) {
      if (raw) console.log("Decryption error: WHATSAPP_SESSION missing ':' separator");
      return null;
    }

    const parts = raw.split(":");
    const ivHex = String(parts.shift() || "");
    const encryptedHex = String(parts.join(":") || "");

    // Validate hex strictly to avoid Node throwing:
    // "The argument 'encoding' is invalid for data of length ... Received 'hex'"
    // This happens when WHATSAPP_SESSION is truncated (odd-length hex) or corrupted.
    if (ivHex.length !== 32 || !/^[0-9a-fA-F]+$/.test(ivHex)) {
      console.log("Decryption error: invalid IV hex (expected 32 hex chars). Got length=" + ivHex.length);
      return null;
    }
    if (!encryptedHex) {
      console.log("Decryption error: missing ciphertext");
      return null;
    }
    if ((encryptedHex.length % 2) !== 0) {
      console.log("Decryption error: ciphertext hex length is odd (truncated env var). Length=" + encryptedHex.length);
      return null;
    }
    if (!/^[0-9a-fA-F]+$/.test(encryptedHex)) {
      console.log("Decryption error: ciphertext contains non-hex characters");
      return null;
    }

    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", getEncryptionKey(), iv);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
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
      console.log("🧩 Likely causes: (1) WHATSAPP_SESSION is truncated/corrupted in Render, or (2) SESSION_KEY changed since this session was generated.");
      console.log("✅ Fix: keep SESSION_KEY exactly the same as when you paired; then re-paste the full WHATSAPP_SESSION and click Save + Deploy.");
      console.log("✅ If unsure: delete WHATSAPP_SESSION env var and redeploy to force a fresh pairing, then copy the new WHATSAPP_SESSION once.");
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
    // Encryption uses a fresh IV each time, so the printed string changes even though the session is equivalent.
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
  return String(s || "").replace(/D/g, "");
}

function extractPhoneNumber(jid) {
  if (!jid) return "";
  let clean = String(jid).split("@")[0];
  clean = clean.split(":")[0];
  return normalizeNumber(clean);
}

function jidMatchesNumber(senderJid, phoneDigits) {
  // STRICT match to prevent false exemptions/removals.
  // We only compare normalized digit identities extracted from the JID.
  // This still supports device-variant JIDs because extractPhoneNumber() drops ':device' parts.
  if (!senderJid || !phoneDigits) return false;
  const digits = extractPhoneNumber(senderJid);
  const target = normalizeNumber(phoneDigits);
  if (!digits || !target) return false;
  return digits === target;
}

function isOwner(senderJid) {
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
    // In groups, ONLY participant identifies sender. Never fall back to the group JID.
    if (remote.endsWith("@g.us")) return String(msg.key.participant || "");
    return remote;
  } catch { return ""; }
}

function isSelfMessage(msg) {
  if (!msg?.key) return false;
  if (msg.key.fromMe) return true;

  const sender = getSenderJidForMsg(msg);
  if (BOT_SELF_JID && sender === BOT_SELF_JID) return true;
  if (BOT_SELF_PHONE && jidMatchesNumber(sender, BOT_SELF_PHONE)) return true;

  return false;
}

function isExempt(msg) {
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

// Faster + more resilient link detector (handles abr.ge and common obfuscations)
// Includes .vip and .link
const FAST_LINK_TLDS = "com|net|org|io|co|me|app|tech|info|biz|store|online|ly|ge|ke|uk|us|tv|gg|site|blog|news|vip|link";
const FAST_LINK_REGEX = new RegExp(
  "(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|whatsapp\.com)\/\S+|\b[A-Za-z0-9-]{1,63}\.(?:" + FAST_LINK_TLDS + ")(?::\d{1,5})?(?:\/\S*)?\b",
  "i"
);

// Remove invisible/control chars used to break URLs
const LINK_INVIS_REGEX = /[­͏؜᠎​-‏‪-‮⁠-⁯﻿︀-️⁦-⁩]/g;
// Dot-lookalikes used in obfuscation
const LINK_DOTLIKE_REGEX = /[。．｡․∙﹒‧··・•]/g;
const LINK_SLASHLIKE_REGEX = /[∕⁄／]/g;
const LINK_COLONLIKE_REGEX = /[：]/g;
// abr[.]ge / abr(dot)ge / https[:]// etc
// IMPORTANT: build these via RegExp constructor so even if copy/paste strips backslashes,
// the bot won't crash with a *syntax* error at startup.
const LINK_BRACKET_DOT_REGEX = (() => {
  try { return new RegExp("[\[\(\{]\s*(?:\.|dot)\s*[\]\)\}]", "gi"); }
  catch { return new RegExp("\\[\\s*(?:\\.|dot)\\s*\\]", "gi"); }
})();
const LINK_BRACKET_SLASH_REGEX = (() => {
  try { return new RegExp("[\[\(\{]\s*(?:\/|slash)\s*[\]\)\}]", "gi"); }
  catch { return new RegExp("\\[\\s*(?:\/|slash)\\s*\\]", "gi"); }
})();
const LINK_BRACKET_COLON_REGEX = (() => {
  try { return new RegExp("[\[\(\{]\s*(?::|colon)\s*[\]\)\}]", "gi"); }
  catch { return new RegExp("\\[\\s*(?::|colon)\\s*\\]", "gi"); }
})();

function normalizeForLinkDetect(text) {
  let s = String(text || "");
  try { s = s.normalize("NFKC"); } catch {}
  return s
    .replace(LINK_INVIS_REGEX, "")
    .replace(/[   -     　]/g, " ")
    .replace(LINK_DOTLIKE_REGEX, ".")
    .replace(LINK_BRACKET_DOT_REGEX, ".")
    .replace(LINK_SLASHLIKE_REGEX, "/")
    .replace(LINK_BRACKET_SLASH_REGEX, "/")
    .replace(LINK_COLONLIKE_REGEX, ":")
    .replace(LINK_BRACKET_COLON_REGEX, ":");
}

function _compactForLinkDetect(s) {
  return String(s || "").replace(/s+/g, "");
}

function _stripBrackets(s) {
  // Use RegExp constructor to avoid any chance of a malformed regex literal after copy/paste.
  return String(s || "").replace(new RegExp("[\[\]\(\)\{\}<>]", "g"), "");
}

function _dehxxp(s) {
  return String(s || "").replace(/hxxps?:/ig, (m) => m.replace(/xx/ig, "tt"));
}

function detectLinks(text) {
  if (!text) return false;

  const t0 = normalizeForLinkDetect(text);
  if (FAST_LINK_REGEX.test(t0)) return true;

  // spaced/line-broken links
  const t1 = _compactForLinkDetect(t0);
  if (t1 !== t0 && FAST_LINK_REGEX.test(t1)) return true;

  // remove surrounding brackets
  const t2 = _stripBrackets(t1);
  if (t2 !== t1 && FAST_LINK_REGEX.test(t2)) return true;

  // hxxp(s) obfuscation
  const t3 = _dehxxp(t2);
  if (t3 !== t2 && FAST_LINK_REGEX.test(t3)) return true;

  // final aggressive compact
  const t4 = _compactForLinkDetect(t3);
  if (t4 !== t3 && FAST_LINK_REGEX.test(t4)) return true;

  return false;
}

// Quick check for queue priority (faster, less thorough)
function hasLinkQuick(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes("http") || t.includes("www.") || t.includes(".com") || 
         t.includes(".net") || t.includes(".org") || t.includes(".me") ||
         t.includes(".ge") || t.includes(".vip") || t.includes(".link") ||
         t.includes("wa.me");
}

function detectPhoneNumbers(text) {
  if (!text) return false;
  return /d{9,}/.test(text);
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
    if (/(?:wa.me|whatsapp.com)/(?:catalog|c)/?/i.test(src)) return true;
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

const KEYWORDS_REGEX = new RegExp("\b(?:" + KEYWORDS.join("|") + ")\b", "i");

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
  // Link-preview payloads sometimes put the URL here (even when visible text is minimal)
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

  // Backcheck housekeeping
  for (const [k, arr] of senderRecentKeys.entries()) {
    const pruned = (arr || []).filter((x) => x && x.ts && (now - x.ts) < RECENT_KEY_TTL_MS);
    if (pruned.length) senderRecentKeys.set(k, pruned.slice(-RECENT_KEY_MAX));
    else senderRecentKeys.delete(k);
  }

  // Retry queue housekeeping
  if (Array.isArray(deleteRetryQueue) && deleteRetryQueue.length) {
    deleteRetryQueue = deleteRetryQueue.filter((x) => x && (now - (x.firstTs || now)) < DELETE_RETRY_MAX_AGE_MS && (x.attempt || 0) <= DELETE_RETRY_MAX_ATTEMPTS);
    if (deleteRetryQueue.length && !deleteRetryTimer) {
      deleteRetryTimer = setTimeout(() => drainDeleteRetryQueue().catch(() => {}), 800);
    }
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
        console.log("║ 🚀 Priority queue: Links first           ║");
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
      // NOTE: We keep a "not admin" cache to avoid hammering WhatsApp APIs.
      // However, some transient failures can look like auth errors. To prevent a false-positive cache
      // from permanently disabling moderation, we periodically re-probe.
      const cachedAt = notAdminGroups.get(groupJid);
      if (cachedAt) {
        const now = Date.now();
        const age = now - cachedAt;
        // IMPORTANT: never let a stale/false "not admin" cache disable deletes for long during floods.
        // We only skip briefly, then re-probe periodically to recover automatically.
        const PROBE_EVERY_MS = 30 * 1000; // re-probe at least every 30s

        safeDelete._lastProbeAt = safeDelete._lastProbeAt || new Map();
        const lastProbe = safeDelete._lastProbeAt.get(groupJid) || 0;

        if (age < NOT_ADMIN_CACHE_TTL && (now - lastProbe) < PROBE_EVERY_MS) {
          if (DEBUG_MODE) console.log("⏭️ Skipping - cached as not admin (age " + age + "ms)");
          return false;
        }

        safeDelete._lastProbeAt.set(groupJid, now);
        if (DEBUG_MODE) console.log("🔁 Re-probing delete despite notAdmin cache (age " + age + "ms)");
      }

      const maxAttempts = 3;
      let delay = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (delay) await new Promise(r => setTimeout(r, delay));
        try {
          await sock.sendMessage(groupJid, { delete: msgKey });
          // If a delete succeeds, we are definitely allowed here → clear false caches.
          if (notAdminGroups.has(groupJid)) notAdminGroups.delete(groupJid);
          return true;
        } catch (e) {
          const errMsg = String(e?.message || e || "");
          const statusCode = e?.output?.statusCode || e?.statusCode || e?.status;

          if (errMsg.includes("rate-overlimit")) {
            delay = 2000 * attempt;
            continue;
          }

          // Cache only on strong signals (avoid generic "403" substring which can appear in other contexts)
          if (statusCode === 403 || errMsg.includes("forbidden") || errMsg.includes("not-authorized")) {
            notAdminGroups.set(groupJid, Date.now());
            console.log("📝 Not admin in this group (or delete not permitted) - caching for 1 hour");
          }

          break;
        }
      }
      return false;
    }

    async function safeRemove(groupJid, userJid) {
      try {
        if (!userJid) return false;

        if (BOT_SELF_JID && String(userJid) === String(BOT_SELF_JID)) {
          console.log("🛡️ Refused to remove bot self");
          return false;
        }

        if (jidMatchesNumber(userJid, ADMIN_NUMBER) || (BOT_SELF_PHONE && jidMatchesNumber(userJid, BOT_SELF_PHONE))) {
          console.log("🛡️ Refused to remove owner/self");
          return false;
        }

        await sock.groupParticipantsUpdate(groupJid, [userJid], "remove");
        console.log("✅ User removed from group");
        // If we can remove members, we're not "permission blocked" → clear any stale not-admin cache.
        if (notAdminGroups.has(groupJid)) notAdminGroups.delete(groupJid);
        return true;
      } catch (e) {
        console.log("⚠️ Could not remove user:", e?.message);
        return false;
      }
    }

    function enqueueDeleteRetry(groupJid, msgKey, attempt = 1) {
      try {
        if (!groupJid || !msgKey) return;
        if (attempt > DELETE_RETRY_MAX_ATTEMPTS) return;
        const now = Date.now();
        const id = groupJid + ':' + (msgKey.participant || '') + ':' + (msgKey.id || '');
        if (deleteRetryQueue.some((x) => x && x.id === id)) return;
        deleteRetryQueue.push({ id, groupJid, msgKey, attempt, firstTs: now, nextTs: now + Math.min(20000, 1200 * attempt) });
        if (!deleteRetryTimer) deleteRetryTimer = setTimeout(() => drainDeleteRetryQueue().catch(() => {}), 800);
      } catch {}
    }

    async function drainDeleteRetryQueue() {
      const now = Date.now();
      deleteRetryTimer = null;

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

    async function deleteRecentForSender(rateKey, groupJid) {
      try {
        const keys = uniqueDeleteKeys(getRecentSenderKeys(rateKey));
        if (!keys.length) return;
        for (let i = 0; i < keys.length; i += DELETE_PARALLEL) {
          const slice = keys.slice(i, i + DELETE_PARALLEL);
          const results = await Promise.allSettled(slice.map((k) => safeDelete(groupJid, k)));
          results.forEach((r, idx) => {
            const ok = (r.status === 'fulfilled') && r.value === true;
            if (!ok) enqueueDeleteRetry(groupJid, slice[idx], 1);
          });
        }
        if (deleteRetryQueue.length && !deleteRetryTimer) deleteRetryTimer = setTimeout(() => drainDeleteRetryQueue().catch(() => {}), 800);
      } catch {}
    }

    async function handleMessage(msg) {
      try {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) return;
        if (!msg.message) return;

        const groupJid = msg.key.remoteJid;
        // For group messages, NEVER use the group JID as sender identity.
        // If participant is missing, we can still delete by msg.key, but removal attribution may be skipped.
        const senderJid = getSenderJidForMsg(msg);

        // Unwrap wrappers so text/link checks work even under ephemeral/viewOnce/documentWithCaption floods
        const __unwrapped = unwrapMessageContent(msg.message);
        const msg0 = (__unwrapped === msg.message) ? msg : { ...msg, message: __unwrapped };

        const visibleText = extractVisibleText(msg0).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command
        if (textLower === "!bot") {
          console.log("📨 !bot command from:", senderJid);

          if (isLidJid(senderJid) && (!OWNER_LID || OWNER_LID === "")) {
            OWNER_LID = String(senderJid);
            console.log("🔐 Learned OWNER_LID:", OWNER_LID);
            console.log("ℹ️ Save this in Render env var OWNER_LID to persist across restarts.");
          }

          try {
            let responseText = "✅ ANTI-LINK BOT ACTIVE
";
            responseText += "👑 Owner: " + ADMIN_NUMBER + "
";
            responseText += "🚀 Priority queue enabled
";
            responseText += "💃 We R 🆗 Baby!! 🤫
";
            await sock.sendMessage(groupJid, { text: responseText });
            console.log("✅ Sent !bot response");
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e?.message);
          }
          return;
        }

        // ===== OWNER/SELF EXEMPTION =====
        // If sender is missing (rare edge case), do NOT treat as exempt.
        const senderPhone = senderJid ? extractPhoneNumber(senderJid) : "";
        const owner = senderJid ? isOwner(senderJid) : false;
        const self = isSelfMessage(msg);
        const exempt = isExempt(msg);

        // Backcheck tracking: remember message keys per sender so we can delete any that slip under flood/rate limits.
        const senderId = senderPhone || senderJid || ("unknown-" + (msg.key?.id || Date.now()));
        const rateKey = groupJid + "-" + senderId;
        rememberSenderKey(rateKey, msg.key);

        const hardOwner = (
          (senderPhone && (
            normalizeNumber(senderPhone) === normalizeNumber(ADMIN_NUMBER) ||
            (BOT_SELF_PHONE && normalizeNumber(senderPhone) === normalizeNumber(BOT_SELF_PHONE))
          )) ||
          (senderJid ? isOwnerLid(senderJid) : false)
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

        if (exempt || hardOwner) {
          if (DEBUG_MODE) console.log("👑 Exempt message - skipping checks");
          return;
        }

        // ===== IMMEDIATE LINK CHECK (RIGHT AFTER OWNER EXEMPTION) =====
        const hasLink = detectLinks(visibleText);
        if (hasLink) {
          console.log("");
          console.log("🔗 LINK DETECTED - IMMEDIATE ACTION");
          console.log("User: " + (senderJid || "(unknown sender)"));
          console.log("Group: " + groupJid);
          console.log("Text: " + visibleText.substring(0, 100));

          // Use the shared senderId/rateKey so backchecking stays consistent.
          const strikeId = senderId;
          const userKey = groupJid + "-" + strikeId;
          const current = userViolations.get(userKey) || 0;
          const updated = current + 1;
          userViolations.set(userKey, updated);
          console.log("Strike: " + updated + "/3");

          const deleted = await safeDelete(groupJid, msg.key);
          if (!deleted) {
            enqueueDeleteRetry(groupJid, msg.key, 1);
            if (DEBUG_MODE) {
              const cachedAt = notAdminGroups.get(groupJid);
              console.log("⚠️ Link delete failed (queued retry). notAdminCached=" + (!!cachedAt) + (cachedAt ? (" ageMs=" + (Date.now() - cachedAt)) : ""));
            }
          } else {
            console.log("✅ Link message deleted");
          }

          // Backcheck: delete any other recent messages from this sender that may have slipped through.
          deleteRecentForSender(rateKey, groupJid).catch(() => {});

          if (updated >= 3) {
            if (senderJid) {
              console.log("⚠️ 3 strikes - removing user...");
              await new Promise(r => setTimeout(r, 300));
              const removed = await safeRemove(groupJid, senderJid);
              if (removed) userViolations.delete(userKey);
            } else {
              console.log("⚠️ 3 strikes reached, but senderJid is missing; cannot remove user. (Deletes still applied.)");
            }
          }

          console.log("");
          return; // Done - link handled immediately
        }

        // ===== OTHER VIOLATIONS =====
        const dup = checkDuplicate(groupJid, senderJid, visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg0);
        const apk = isAPKFile(msg0);
        const zip = isZipFile(msg0);
        const audio = isAudioFile(msg0);
        const keyword = detectKeyword(visibleText);
        const buttons = hasButtons(msg0);
        const contact = isContactMessage(msg0);

        const violated = dup.isDuplicate || hasPhone || business || apk || zip || audio || keyword || buttons || contact;
        if (!violated) return;

        const reasons = [];
        if (dup.isDuplicate) reasons.push("duplicate(x" + dup.count + ")");
        if (hasPhone) reasons.push("phone");
        if (business) reasons.push("business");
        if (apk) reasons.push("apk");
        if (zip) reasons.push("zip");
        if (audio) reasons.push("audio");
        if (keyword) reasons.push("keyword");
        if (buttons) reasons.push("buttons");
        if (contact) reasons.push("contact");

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

        const deleted = await safeDelete(groupJid, msg.key);
        if (!deleted) {
          enqueueDeleteRetry(groupJid, msg.key, 1);
          if (DEBUG_MODE) {
            const cachedAt = notAdminGroups.get(groupJid);
            console.log("⚠️ Delete failed for violation (queued retry). notAdminCached=" + (!!cachedAt) + (cachedAt ? (" ageMs=" + (Date.now() - cachedAt)) : ""));
          }
        } else {
          console.log("✅ Message deleted");
        }

        // Backcheck: delete any other recent messages from this sender that may have slipped through.
        deleteRecentForSender(rateKey, groupJid).catch(() => {});

        if (updated >= 3) {
          if (senderJid) {
            console.log("⚠️ 3 strikes - removing user...");
            await new Promise(r => setTimeout(r, 500));
            const removed = await safeRemove(groupJid, senderJid);
            if (removed) {
              userViolations.delete(userKey);
            }
          } else if (DEBUG_MODE) {
            console.log("⚠️ 3 strikes reached but senderJid missing; cannot remove. (Deletes still applied.)");
          }
        }

        console.log("");
      } catch (e) {
        console.log("⚠️ Error:", e?.message);
      }
    }

    // ===== PRIORITY QUEUE PROCESSOR =====
    async function processQueue() {
      if (isProcessing) return;
      isProcessing = true;

      try {
        while (queueHigh.length > 0 || queueLow.length > 0) {
          // Process high priority (links) first, then low priority
          const batch = [];
          const BATCH_SIZE = 10;

          // Take up to BATCH_SIZE from high priority
          while (batch.length < BATCH_SIZE && queueHigh.length > 0) {
            batch.push(queueHigh.shift());
          }

          // Fill remaining with low priority
          while (batch.length < BATCH_SIZE && queueLow.length > 0) {
            batch.push(queueLow.shift());
          }

          // Process batch in parallel
          await Promise.all(batch.map(msg => handleMessage(msg).catch(() => {})));

          // Keep delete retries moving under load (rate limits/transient failures)
          if (deleteRetryQueue.length && !deleteRetryTimer) {
            deleteRetryTimer = setTimeout(() => drainDeleteRetryQueue().catch(() => {}), 800);
          }

          // Adaptive delay: 0ms if queue is large (flooding), 10ms otherwise
          const queueSize = queueHigh.length + queueLow.length;
          const delay = queueSize > 10 ? 0 : 10;
          if (delay > 0) await new Promise(r => setTimeout(r, delay));
        }
      } finally {
        isProcessing = false;
      }
    }

    // ===== MESSAGE INTAKE - SORT BY PRIORITY =====
    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) continue;
        if (!msg.message) continue;

        // Quick check to prioritize link messages (unwrap wrappers first)
        let text = "";
        try {
          const u = unwrapMessageContent(msg.message);
          const msg0 = (u === msg.message) ? msg : { ...msg, message: u };
          text = extractVisibleText(msg0);
        } catch {
          text = extractVisibleText(msg);
        }

        if (hasLinkQuick(text)) {
          queueHigh.push(msg); // High priority
        } else {
          queueLow.push(msg);  // Normal priority
        }
      }

      // Start processing
      processQueue();
    });

    setInterval(cleanupCaches, 30000);
    console.log("🚀 Bot initialized with priority queue - waiting for connection...");

  } catch (e) {
    console.log("❌ Start error:", e.message);
    console.log("🔄 Retrying in 30 seconds...");
    setTimeout(() => startBot().catch(() => {}), 30000);
  }
}

startBot();
