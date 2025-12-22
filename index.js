// index.js - Anti-Link Bot v3.0
// ✅ FIXED: Session persistence now actually works!
// ✅ FIXED: Encryption key length (32 bytes)
// ✅ ADDED: Audio file detection
// ✅ Works with Render Free Web Service

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

const ADMIN_NUMBER = "254106090661";
const DEBUG_MODE = true;
const AUTH_FOLDER = "./auth_info";

const userViolations = new Map();
const notAdminGroups = new Map();
const NOT_ADMIN_CACHE_TTL = 60 * 60 * 1000;

const recentMessages = new Map();
const DUP_WINDOW_MS = 30000;
const DUP_BLOCK_FROM = 2;

let hasConnectedBefore = false;

const createSilentLogger = () => {
  const noOp = () => {};
  return {
    level: "silent",
    trace: noOp, debug: noOp, info: noOp, warn: noOp, error: noOp, fatal: noOp,
    child: () => createSilentLogger(),
  };
};

// ✅ FIX 1: Get encryption key - MUST be exactly 32 bytes for AES-256-CBC
function getEncryptionKey() {
  const key = process.env.SESSION_KEY || 'AntiLinkBotSecretKey2024!';
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(text) {
  try {
    const iv = crypto.randomBytes(16);
    const key = getEncryptionKey();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.log("❌ Encryption error:", error.message);
    return null;
  }
}

function decrypt(text) {
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.log("❌ Decryption error:", error.message);
    return null;
  }
}

// ✅ FIX 2: RESTORE session from env var - THIS WAS MISSING IN v2.8!
function restoreSessionFromEnv() {
  try {
    const encrypted = process.env.WHATSAPP_SESSION;
    if (!encrypted) {
      console.log("ℹ️ No saved session in WHATSAPP_SESSION env var");
      return false;
    }

    console.log("📂 Found saved session, restoring...");
    
    const decrypted = decrypt(encrypted);
    if (!decrypted) {
      console.log("❌ Failed to decrypt session");
      return false;
    }

    const sessionFiles = JSON.parse(decrypted);
    
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    let fileCount = 0;
    for (const [filename, content] of Object.entries(sessionFiles)) {
      const filePath = path.join(AUTH_FOLDER, filename);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
      fileCount++;
    }

    console.log("✅ Restored " + fileCount + " session files from env var");
    return true;
  } catch (error) {
    console.log("❌ Error restoring session:", error.message);
    return false;
  }
}

function saveSessionToEnv() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) {
      console.log("⚠️ No auth folder exists yet");
      return null;
    }

    const files = fs.readdirSync(AUTH_FOLDER);
    const sessionFiles = {};

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(AUTH_FOLDER, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          sessionFiles[file] = content;
        } catch (e) {}
      }
    }

    if (Object.keys(sessionFiles).length === 0) {
      console.log("⚠️ No session files to save");
      return null;
    }

    const sessionString = JSON.stringify(sessionFiles);
    const encrypted = encrypt(sessionString);

    if (!encrypted) {
      console.log("❌ Failed to encrypt session");
      return null;
    }

    console.log("\n" + "=".repeat(70));
    console.log("📁 SAVE THIS TO RENDER ENVIRONMENT VARIABLE:");
    console.log("=".repeat(70));
    console.log("Variable Name: WHATSAPP_SESSION");
    console.log("Variable Value (copy everything below between the lines):");
    console.log("-".repeat(70));
    console.log(encrypted);
    console.log("-".repeat(70));
    console.log("\n📋 STEPS:");
    console.log("1. Copy the value above (the long encrypted string)");
    console.log("2. Go to Render Dashboard → Your Service → Environment");
    console.log("3. Add/Update: WHATSAPP_SESSION = (paste the value)");
    console.log("4. Click 'Save Changes'");
    console.log("5. Bot will auto-reconnect on next restart!");
    console.log("=".repeat(70) + "\n");

    return encrypted;
  } catch (error) {
    console.log("❌ Error saving session:", error.message);
    return null;
  }
}

function extractPhoneNumber(jid) {
  if (!jid) return "";
  let clean = String(jid).split("@")[0];
  clean = clean.split(":")[0];
  return clean.replace(/\D/g, "");
}

function isOwner(senderJid) {
  if (!senderJid) return false;
  const phone = extractPhoneNumber(senderJid);
  if (phone === ADMIN_NUMBER) return true;
  if (String(senderJid).includes(ADMIN_NUMBER)) return true;
  return false;
}

function detectLinks(text) {
  if (!text) return false;
  const patterns = [
    /https?:\/\/[^\s]+/i,
    /www\.[^\s]+/i,
    /\b(?:wa\.me|whatsapp\.com)\/\S+/i,
    /\b[A-Za-z0-9-]+\.(?:com|net|org|io|co|me|app|tech|info|biz|store|online|ly|ge|ke|uk|us|tv|gg|site|blog|news)(?:\/\S*)?\b/i,
  ];
  return patterns.some((r) => r.test(text));
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

// ✅ FIX 3: Audio file detection (voice notes & audio documents, NOT video/calls)
function isAudioFile(msg) {
  const m = msg.message || {};
  
  if (m.audioMessage) return true;
  
  const vo = m.viewOnceMessage?.message || 
             m.viewOnceMessageV2?.message || 
             m.viewOnceMessageV2Extension?.message;
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
}

async function startBot() {
  try {
    // ✅ CRITICAL: Restore session from env var BEFORE loading auth state!
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
      console.log("📱 New device - requesting pairing code for: " + ADMIN_NUMBER);
      console.log("⏳ Please wait...");

      await new Promise(r => setTimeout(r, 3000));

      try {
        const code = await sock.requestPairingCode(ADMIN_NUMBER);
        console.log("");
        console.log("╔════════════════════════════════════════╗");
        console.log("║ 📱 PAIRING CODE (Valid for 60 seconds) ║");
        console.log("╠════════════════════════════════════════╣");
        console.log("║                                        ║");
        console.log("║           " + code + "                   ║");
        console.log("║                                        ║");
        console.log("╠════════════════════════════════════════╣");
        console.log("║ 1. Open WhatsApp → Settings            ║");
        console.log("║ 2. Tap 'Linked Devices'                ║");
        console.log("║ 3. Tap 'Link a Device'                 ║");
        console.log("║ 4. Enter the 8-digit code above        ║");
        console.log("╚════════════════════════════════════════╝");
        console.log("");
      } catch (e) {
        console.log("⚠️ Pairing code error:", e?.message);
        console.log("🔄 Will retry in 10 seconds...");
      }
    } else {
      console.log("✅ Found existing session, connecting...");
    }

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      setTimeout(() => saveSessionToEnv(), 2000);
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "open") {
        hasConnectedBefore = true;
        console.log("");
        console.log("╔══════════════════════════════════════════╗");
        console.log("║ ✅ ANTI-LINK BOT v3.0 ONLINE             ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log("║ 🤖 Bot: " + (sock.user?.id || "unknown").substring(0,30).padEnd(32) + "║");
        console.log("║ 👑 Owner: " + ADMIN_NUMBER.padEnd(30) + "║");
        console.log("║ 📋 Mode: All groups                      ║");
        console.log("║ 💾 Session: ENV variable                 ║");
        console.log("║ 🎵 Audio files: BLOCKED                  ║");
        console.log("╚══════════════════════════════════════════╝");
        console.log("");

        setTimeout(() => {
          console.log("💾 Saving session for future restarts...");
          saveSessionToEnv();
        }, 5000);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "unknown";

        console.log("🔌 Connection closed: " + reason + " (code: " + statusCode + ")");

        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          console.log("❌ Logged out! Clear WHATSAPP_SESSION env var and restart.");
          if (fs.existsSync(AUTH_FOLDER)) {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            console.log("🗑️ Cleared local auth files");
          }
        } else {
          const delay = hasConnectedBefore ? 5000 : 10000;
          console.log("🔄 Reconnecting in " + (delay/1000) + " seconds...");
          setTimeout(() => startBot().catch(console.error), delay);
        }
      }

      if (qr) {
        console.log("📱 QR received - using pairing code instead");
      }
    });

    async function safeDelete(groupJid, msgKey) {
      const notAdmin = notAdminGroups.get(groupJid);
      if (notAdmin && (Date.now() - notAdmin) < NOT_ADMIN_CACHE_TTL) {
        if (DEBUG_MODE) console.log("⏭️ Skip - not admin (cached)");
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
          console.log("⚠️ Delete error (attempt " + attempt + "):", errMsg);

          if (errMsg.includes("rate-overlimit")) {
            delay = 2000 * attempt;
            continue;
          }

          if (errMsg.includes("forbidden") || errMsg.includes("not-authorized") || errMsg.includes("403")) {
            notAdminGroups.set(groupJid, Date.now());
            console.log("📝 Not admin - cached for 1 hour");
          }

          break;
        }
      }
      return false;
    }

    async function safeRemove(groupJid, userJid) {
      try {
        await sock.groupParticipantsUpdate(groupJid, [userJid], "remove");
        console.log("✅ User removed");
        return true;
      } catch (e) {
        console.log("⚠️ Remove failed:", e?.message);
        return false;
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

        if (textLower === "!bot") {
          console.log("📨 !bot from:", senderJid);
          try {
            let resp = "✅ ANTI-LINK BOT v3.0 ACTIVE\n";
            resp += "👑 Owner: " + ADMIN_NUMBER + "\n";
            resp += "📋 Mode: All groups\n";
            resp += "💃 We R Gud Baby!!\n";
            if (isOwner(senderJid)) resp += "🔑 You are the owner";
            await sock.sendMessage(groupJid, { text: resp });
          } catch (e) {}
          return;
        }

        if (msg.key.fromMe) return;
        if (isOwner(senderJid)) return;

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

        const userKey = groupJid + "-" + senderJid;
        const current = userViolations.get(userKey) || 0;
        const updated = current + 1;
        userViolations.set(userKey, updated);

        console.log("");
        console.log("🚫 VIOLATION: " + reasons.join(", "));
        console.log("👤 User: " + senderJid.substring(0, 20));
        console.log("📊 Strike: " + updated + "/3");

        const deleted = await safeDelete(groupJid, msg.key);
        if (deleted) {
          console.log("✅ Deleted");
          if (updated >= 3) {
            await new Promise(r => setTimeout(r, 500));
            const removed = await safeRemove(groupJid, senderJid);
            if (removed) userViolations.delete(userKey);
          }
        }
        console.log("");
      } catch (e) {
        console.log("⚠️ Handle error:", e?.message);
      }
    }

    sock.ev.on("messages.upsert", async (m) => {
      for (const msg of (m.messages || [])) {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) continue;
        if (!msg.message) continue;
        handleMessage(msg).catch(() => {});
      }
    });

    setInterval(cleanupCaches, 30000);
    console.log("🚀 Bot initialized...");

  } catch (e) {
    console.log("❌ Start error:", e.message);
    setTimeout(() => startBot().catch(() => {}), 30000);
  }
}

// Simple HTTP server for Render health checks
const http = require("http");
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Anti-Link Bot v3.0 Running");
}).listen(PORT, () => {
  console.log("🌐 Health check server on port " + PORT);
});

startBot();
