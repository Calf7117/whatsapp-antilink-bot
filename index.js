// Anti-Link Bot - Owner Exempt + Audio Detection + Session Persistence

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

const ADMIN_NUMBER = "254106090661";
const DEBUG_MODE = true;
const AUTH_FOLDER = "./auth_info";

// Health check server for Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Anti-Link Bot Running");
}).listen(PORT, () => console.log("Health server on port " + PORT));

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

// Encryption key - exactly 32 bytes using SHA-256 hash
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

// Restore session from environment variable - CALLED AT STARTUP
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
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }
    
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
      if (file.endsWith(".json")) {
        try {
          const content = fs.readFileSync(path.join(AUTH_FOLDER, file), "utf8");
          sessionData[file] = JSON.parse(content);
        } catch (e) {}
      }
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
    console.log("2. Add Environment Variable: WHATSAPP_SESSION");
    console.log("3. Paste the value above");
    console.log("4. Redeploy (optional)");
    console.log("=".repeat(60));
    console.log("");
  } catch (error) {
    console.log("❌ Error saving session:", error.message);
  }
}

function extractPhoneNumber(jid) {
  if (!jid) return "";
  let clean = String(jid).split("@")[0];
  clean = clean.split(":")[0];
  return clean.replace(/\D/g, "");
}

// Owner check - multiple methods to ensure it works
function isOwner(senderJid) {
  if (!senderJid) return false;
  const jidString = String(senderJid);
  
  // Method 1: Direct include check
  if (jidString.includes(ADMIN_NUMBER)) {
    return true;
  }
  
  // Method 2: Extract and compare phone number
  const phone = extractPhoneNumber(senderJid);
  if (phone === ADMIN_NUMBER) {
    return true;
  }
  
  // Method 3: Ends with check
  if (phone.endsWith(ADMIN_NUMBER) || ADMIN_NUMBER.endsWith(phone)) {
    if (phone.length >= 9) return true;
  }
  
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

// Audio file detection (not voice calls or video)
function isAudioFile(msg) {
  const m = msg.message || {};
  
  // Direct audio message (voice notes, audio files)
  if (m.audioMessage) return true;
  
  // View-once audio
  const vo = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
  if (vo?.audioMessage) return true;
  
  // Audio sent as document
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
    // RESTORE SESSION FIRST - This is what makes "pair once, connect forever" work
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

    // Request pairing code if not registered
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
      const { connection, lastDisconnect, qr } = update;

      if (connection === "open") {
        hasConnectedBefore = true;
        console.log("");
        console.log("╔══════════════════════════════════════════╗");
        console.log("║ ✅ ANTI-LINK BOT ONLINE                  ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log("║ 🤖 Bot: " + (sock.user?.id || "unknown").substring(0,30).padEnd(31) + "║");
        console.log("║ 👑 Owner: " + ADMIN_NUMBER.padEnd(30) + "║");
        console.log("║ 📋 Mode: All groups                      ║");
        console.log("║ 💃 We R 🆗 Baby!! 🤫                     ║");
        console.log("╚══════════════════════════════════════════╝");
        console.log("");
        saveSessionToEnv();
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "unknown";
        
        console.log("🔌 Connection closed: " + reason);
        
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("❌ Logged out. Delete WHATSAPP_SESSION env var and redeploy.");
          if (fs.existsSync(AUTH_FOLDER)) {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          }
        } else {
          const delay = hasConnectedBefore ? 5000 : 10000;
          console.log("🔄 Reconnecting in " + (delay/1000) + " seconds...");
          setTimeout(() => startBot().catch(console.error), delay);
        }
      }

      if (qr) {
        console.log("📱 QR Code received - but we're using pairing code instead");
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
        await sock.groupParticipantsUpdate(groupJid, [userJid], "remove");
        console.log("✅ User removed from group");
        return true;
      } catch (e) {
        console.log("⚠️ Could not remove user:", e?.message);
        return false;
      }
    }

    async function handleMessage(msg) {
      try {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) return;
        if (!msg.message) return;

        const groupJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;

        // OWNER EXEMPT: If message is fromMe (sent by linked account = YOU), skip all checks
        if (msg.key.fromMe) {
          // But still respond to !bot command
          const visibleText = extractVisibleText(msg).trim();
          if (visibleText.toLowerCase() === "!bot") {
            try {
              let responseText = "✅ ANTI-LINK BOT ACTIVE\n";
              responseText += "👑 Owner: " + ADMIN_NUMBER + "\n";
              responseText += "📋 Mode: All groups\n";
              responseText += "💃 We R 🆗 Baby!! 🤫\n";
              responseText += "🔑 You are the owner - exempt from all rules";
              await sock.sendMessage(groupJid, { text: responseText });
            } catch (e) {}
          }
          return; // Owner is exempt - don't check violations
        }

        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command from others
        if (textLower === "!bot") {
          console.log("📨 !bot command from:", senderJid);
          try {
            let responseText = "✅ ANTI-LINK BOT ACTIVE\n";
            responseText += "👑 Owner: " + ADMIN_NUMBER + "\n";
            responseText += "📋 Mode: All groups\n";
            responseText += "💃 We R 🆗 Baby!! 🤫";
            await sock.sendMessage(groupJid, { text: responseText });
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e?.message);
          }
          return;
        }

        // Double-check owner by JID (for messages from other devices)
        if (isOwner(senderJid)) {
          return; // Owner exempt
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

        const userKey = groupJid + "-" + senderJid;
        const current = userViolations.get(userKey) || 0;
        const updated = current + 1;
        userViolations.set(userKey, updated);

        console.log("");
        console.log("🚫 VIOLATION DETECTED");
        console.log("User: " + senderJid);
        console.log("Reason: " + reasons.join(", "));
        console.log("Strike: " + updated + "/3");

        const deleted = await safeDelete(groupJid, msg.key);
        if (deleted) {
          console.log("✅ Message deleted");

          if (updated >= 3) {
            console.log("⚠️ 3 strikes - removing user...");
            await new Promise(r => setTimeout(r, 500));
            const removed = await safeRemove(groupJid, senderJid);
            if (removed) {
              userViolations.delete(userKey);
            }
          }
        }
      } catch (e) {
        console.log("⚠️ Error:", e?.message);
      }
    }

    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];
      for (const msg of messages) {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) continue;
        if (!msg.message) continue;
        handleMessage(msg).catch(() => {});
      }
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
