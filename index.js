// Anti-Link Bot v3.0 - Extreme Anti-Spam with Backchecking

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

// EXTREME MEASURES: Track EVERYTHING
const userViolations = new Map();
const notAdminGroups = new Map();
const NOT_ADMIN_CACHE_TTL = 60 * 60 * 1000;

const recentMessages = new Map();
const messageHistory = new Map(); // NEW: Store last N messages per group for backchecking
const DUP_WINDOW_MS = 120000; // 2 minutes window (extended)
const DUP_BLOCK_FROM = 1; // Block after 1 duplicate (extreme!)
const MAX_HISTORY_PER_GROUP = 50; // Keep last 50 messages per group

let hasConnectedBefore = false;

// Deterministic: we learn the bot's own JID once connected
let BOT_SELF_JID = "";
let BOT_SELF_PHONE = "";

let OWNER_LID = process.env.OWNER_LID || "22793995452644@lid";

// NEW: Queue system to handle rapid messages without hanging
const messageQueue = [];
let isProcessingQueue = false;
const MAX_QUEUE_SIZE = 100;

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
  if (!msg?.key) return false;
  if (msg.key.fromMe) return true;

  const sender = msg.key.participant || msg.key.remoteJid;
  if (BOT_SELF_JID && sender === BOT_SELF_JID) return true;

  if (BOT_SELF_PHONE && jidMatchesNumber(sender, BOT_SELF_PHONE)) return true;

  return false;
}

function isExempt(msg) {
  if (!msg?.key) return false;
  if (msg.key.fromMe) return true;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (isOwnerLid(senderJid)) return true;
  if (isOwner(senderJid)) return true;
  if (BOT_SELF_JID && senderJid === BOT_SELF_JID) return true;
  if (BOT_SELF_PHONE && jidMatchesNumber(senderJid, BOT_SELF_PHONE)) return true;

  return false;
}

// EXTREME: Enhanced link detection for short URLs like abr.ge
function detectLinks(text) {
  if (!text) return false;
  
  // STRONG patterns for common URL formats
  const patterns = [
    /https?:\/\/[^\s]+/i,  // http/https links
    /www\.[^\s]+/i,        // www links
    /\b(?:wa\.me|whatsapp\.com)\/\S+/i,  // WhatsApp links
    /\b[A-Za-z0-9-]{2,20}\.(?:com|net|org|io|co|me|app|tech|info|biz|store|online|ly|ge|ke|uk|us|tv|gg|site|blog|news|xyz|club|top|fun|shop|click|link|live)(?:\/[^\s]*)?\b/i,  // Domain detection
    /\b[a-z0-9]{2,12}\.[a-z]{2,6}\/[a-z0-9]+\b/i,  // Short URLs like abr.ge/fa8zc73
  ];
  
  return patterns.some((r) => r.test(text));
}

// NEW: Extract and normalize URLs for better duplicate detection
function extractAndNormalizeUrls(text) {
  if (!text) return [];
  
  const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|(\b[a-z0-9-]{2,20}\.[a-z]{2,6}(?:\/[^\s]*)?\b)/gi;
  const matches = text.match(urlPattern) || [];
  
  return matches.map(url => {
    // Normalize URLs: remove protocol, www, trailing slashes
    let normalized = url.toLowerCase()
      .replace(/^(https?:\/\/)?(www\.)?/, '')
      .replace(/\/+$/, '');
    
    // For short domains, keep path as part of identifier
    if (normalized.includes('.ge/') || 
        normalized.includes('.ly/') || 
        normalized.includes('.me/') ||
        normalized.split('/')[0].length <= 6) { // Very short domains
      return normalized;
    }
    
    // For regular domains, just use domain for matching
    return normalized.split('/')[0];
  });
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

// NEW: Enhanced duplicate detection with URL normalization
function checkDuplicate(groupJid, senderJid, visibleText) {
  const text = (visibleText || "").trim().toLowerCase();
  
  // Extract and normalize URLs
  const urls = extractAndNormalizeUrls(visibleText);
  const urlKey = urls.length > 0 ? urls.sort().join('|') : '';
  
  const key = groupJid + "-" + senderJid;
  const now = Date.now();
  const prev = recentMessages.get(key);

  // If no previous message or window expired
  if (!prev || (now - prev.ts) > DUP_WINDOW_MS) {
    recentMessages.set(key, { 
      last: text, 
      urls: urlKey,
      count: 1, 
      ts: now 
    });
    return { isDuplicate: false, count: 1, isUrlDuplicate: false };
  }

  // Check for exact text match
  if (prev.last === text) {
    prev.count += 1;
    prev.ts = now;
    return { 
      isDuplicate: prev.count >= DUP_BLOCK_FROM, 
      count: prev.count,
      isUrlDuplicate: false 
    };
  }
  
  // Check for URL match (even if text is different)
  if (urlKey && prev.urls === urlKey) {
    prev.count += 1;
    prev.ts = now;
    prev.last = text; // Update last text
    return { 
      isDuplicate: prev.count >= DUP_BLOCK_FROM, 
      count: prev.count,
      isUrlDuplicate: true 
    };
  }

  // New message
  recentMessages.set(key, { 
    last: text, 
    urls: urlKey,
    count: 1, 
    ts: now 
  });
  return { isDuplicate: false, count: 1, isUrlDuplicate: false };
}

// NEW: Add message to history for backchecking
function addToHistory(groupJid, msg) {
  if (!messageHistory.has(groupJid)) {
    messageHistory.set(groupJid, []);
  }
  
  const history = messageHistory.get(groupJid);
  history.push({
    msg,
    timestamp: Date.now(),
    processed: false
  });
  
  // Keep only last N messages
  if (history.length > MAX_HISTORY_PER_GROUP) {
    history.shift();
  }
}

// NEW: Check recent messages for violations (backchecking)
function checkRecentViolations(groupJid, senderJid, sock) {
  if (!messageHistory.has(groupJid)) return;
  
  const history = messageHistory.get(groupJid);
  const now = Date.now();
  const checkWindow = 10000; // 10 seconds
  
  let violationsFound = 0;
  
  // Check last 15 messages from this sender
  const recentFromSender = history
    .filter(item => {
      const itemSender = item.msg.key.participant || item.msg.key.remoteJid;
      return itemSender === senderJid && 
             !item.processed && 
             (now - item.timestamp) <= checkWindow;
    })
    .slice(-15); // Last 15 messages
  
  console.log(`🔍 Backchecking ${recentFromSender.length} recent messages from ${senderJid}`);
  
  // Process each unprocessed message
  recentFromSender.forEach(item => {
    if (!item.processed) {
      // Mark as processed to avoid infinite loops
      item.processed = true;
      
      const visibleText = extractVisibleText(item.msg).trim();
      const hasLink = detectLinks(visibleText);
      
      if (hasLink) {
        violationsFound++;
        console.log(`⚠️ Found missed violation in backcheck: ${visibleText.substring(0, 50)}...`);
        
        // Queue for deletion (but don't wait)
        setTimeout(() => {
          safeDelete(groupJid, item.msg.key, sock).catch(() => {});
        }, 100);
      }
    }
  });
  
  return violationsFound;
}

function cleanupCaches() {
  const now = Date.now();
  
  // Clean recentMessages
  for (const [k, v] of recentMessages.entries()) {
    if ((now - v.ts) > DUP_WINDOW_MS * 3) recentMessages.delete(k);
  }
  
  // Clean notAdminGroups
  for (const [k, v] of notAdminGroups.entries()) {
    if ((now - v) > NOT_ADMIN_CACHE_TTL) notAdminGroups.delete(k);
  }
  
  // Clean messageHistory (keep only last 5 minutes)
  for (const [groupJid, history] of messageHistory.entries()) {
    const filtered = history.filter(item => (now - item.timestamp) <= 300000);
    if (filtered.length === 0) {
      messageHistory.delete(groupJid);
    } else {
      messageHistory.set(groupJid, filtered);
    }
  }
}

// NEW: Queue processing system
async function processMessageQueue(sock) {
  if (isProcessingQueue || messageQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    try {
      await handleMessage(msg, sock);
    } catch (error) {
      console.log("⚠️ Queue processing error:", error.message);
      // Continue with next message
    }
    
    // Small delay to prevent rate limiting
    if (messageQueue.length > 0) {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  
  isProcessingQueue = false;
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
        console.log("║ ✅ ANTI-LINK BOT ONLINE (EXTREME MODE)   ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log("║ 🤖 Bot: " + (BOT_SELF_JID || "unknown").substring(0,30).padEnd(31) + "║");
        console.log("║ 👑 Owner: " + String(ADMIN_NUMBER).padEnd(30) + "║");
        console.log("║ 📋 Mode: Extreme Anti-Spam              ║");
        console.log("║ 🚨 Backchecking: Enabled                ║");
        console.log("║ 💃 We R 🆗 Baby!! 🤫                   ║");
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

    async function safeDelete(groupJid, msgKey, sock) {
      const notAdmin = notAdminGroups.get(groupJid);
      if (notAdmin && (Date.now() - notAdmin) < NOT_ADMIN_CACHE_TTL) {
        if (DEBUG_MODE) console.log("⏭️ Skipping - cached as not admin");
        return false;
      }

      const maxAttempts = 2; // Reduced attempts for speed
      let delay = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (delay) await new Promise(r => setTimeout(r, delay));
        try {
          await sock.sendMessage(groupJid, { delete: msgKey });
          return true;
        } catch (e) {
          const errMsg = String(e?.message || e || "");

          if (errMsg.includes("rate-overlimit")) {
            delay = 1000 * attempt; // Shorter delay
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

    async function safeRemove(groupJid, userJid, sock) {
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
        return true;
      } catch (e) {
        console.log("⚠️ Could not remove user:", e?.message);
        return false;
      }
    }

    async function handleMessage(msg, sock) {
      try {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) return;
        if (!msg.message) return;

        const groupJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // Add to history for backchecking
        addToHistory(groupJid, msg);

        // !bot command
        if (textLower === "!bot") {
          console.log("📨 !bot command from:", senderJid);

          if (isLidJid(senderJid) && (!OWNER_LID || OWNER_LID === "")) {
            OWNER_LID = String(senderJid);
            console.log("🔐 Learned OWNER_LID:", OWNER_LID);
          }

          try {
            let responseText = "✅ ANTI-LINK BOT ACTIVE\n";
            responseText += "👑 Owner: " + ADMIN_NUMBER + "\n";
            responseText += "🚨 Mode: Extreme Anti-Spam with Backchecking\n";
            responseText += "💃 We R 🆗 Baby!! 🤫\n";
            await sock.sendMessage(groupJid, { text: responseText });
            console.log("✅ Sent !bot response");
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e?.message);
          }
          return;
        }

        // ===== OWNER/SELF EXEMPTION =====
        const senderPhone = extractPhoneNumber(senderJid);
        const hardOwner = (
          (senderPhone && (
            normalizeNumber(senderPhone) === normalizeNumber(ADMIN_NUMBER) ||
            (BOT_SELF_PHONE && normalizeNumber(senderPhone) === normalizeNumber(BOT_SELF_PHONE))
          )) ||
          isOwnerLid(senderJid) ||
          msg.key.fromMe
        );

        if (hardOwner) {
          if (DEBUG_MODE) console.log("👑 Owner/self message - skipping checks");
          return;
        }

        // ===== NOT OWNER - CHECK FOR VIOLATIONS =====
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

        // EXTREME: Any link is a violation, duplicates are blocked after 1
        const violated = dup.isDuplicate || hasLink || hasPhone || business || apk || zip || audio || keyword || buttons || contact;
        
        if (violated) {
          const reasons = [];
          if (dup.isDuplicate) reasons.push("duplicate(x" + dup.count + ")");
          if (dup.isUrlDuplicate) reasons.push("duplicate-url");
          if (hasLink) reasons.push("link");
          if (hasPhone) reasons.push("phone");
          if (business) reasons.push("business");
          if (apk) reasons.push("apk");
          if (zip) reasons.push("zip");
          if (audio) reasons.push("audio");
          if (keyword) reasons.push("keyword");
          if (buttons) reasons.push("buttons");
          if (contact) reasons.push("contact");

          const strikeId = senderPhone || senderJid;
          const userKey = groupJid + "-" + strikeId;
          const current = userViolations.get(userKey) || 0;
          const updated = current + 1;
          userViolations.set(userKey, updated);

          console.log("");
          console.log("🚫 EXTREME VIOLATION DETECTED");
          console.log("User: " + senderJid);
          console.log("Group: " + groupJid);
          console.log("Reason: " + reasons.join(", "));
          console.log("Strike: " + updated + "/2"); // Reduced to 2 strikes
          console.log("Text: " + visibleText.substring(0, 100));

          const deleted = await safeDelete(groupJid, msg.key, sock);
          if (deleted) {
            console.log("✅ Message deleted");

            // EXTREME: Remove after 2 strikes instead of 3
            if (updated >= 2) {
              console.log("⚠️ 2 strikes - removing user immediately!");
              
              // Backcheck for more violations before removing
              const missedViolations = checkRecentViolations(groupJid, senderJid, sock);
              if (missedViolations > 0) {
                console.log(`🔍 Found ${missedViolations} additional violations in backcheck`);
              }
              
              await new Promise(r => setTimeout(r, 300));
              const removed = await safeRemove(groupJid, senderJid, sock);
              if (removed) {
                userViolations.delete(userKey);
                console.log("✅ User removed from group");
              }
            }
          }
          console.log("");
        } else if (hasLink) {
          // Even if not a duplicate, track link senders
          const strikeId = senderPhone || senderJid;
          const userKey = groupJid + "-" + strikeId;
          const current = userViolations.get(userKey) || 0;
          
          if (current > 0) {
            console.log(`⚠️ User ${senderJid} sent a link (strike ${current})`);
          }
        }
      } catch (e) {
        console.log("⚠️ Error in handleMessage:", e?.message);
      }
    }

    // Main message handler with queue
    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];
      
      if (messages.length > 5) {
        console.log(`🚨 Rapid-fire detected: ${messages.length} messages at once`);
      }
      
      // Add all messages to queue
      for (const msg of messages) {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) continue;
        if (!msg.message) continue;
        
        // Limit queue size
        if (messageQueue.length < MAX_QUEUE_SIZE) {
          messageQueue.push(msg);
        } else {
          console.log("⚠️ Queue full, dropping message");
        }
      }
      
      // Start processing queue
      processMessageQueue(sock).catch(() => {});
    });

    // Periodic cleanup
    setInterval(cleanupCaches, 30000);
    
    // Also trigger backchecking periodically for busy groups
    setInterval(() => {
      if (DEBUG_MODE) {
        console.log(`📊 Stats: Queue=${messageQueue.length}, History groups=${messageHistory.size}`);
      }
    }, 60000);

    console.log("🚀 Bot initialized (Extreme Mode) - waiting for connection...");

  } catch (e) {
    console.log("❌ Start error:", e.message);
    console.log("🔄 Retrying in 30 seconds...");
    setTimeout(() => startBot().catch(() => {}), 30000);
  }
}

startBot();
