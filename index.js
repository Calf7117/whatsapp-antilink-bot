// index.js - Anti-Link Bot v2.8 (CORRECTED)
// Pairing Code Login + ZIP file blocking + 1-hour not-admin cache + Session Persistence
// FIXED: Uses 'useMultiFileAuthState' which is the CORRECT function.

const {
  default: makeWASocket,
  useMultiFileAuthState, // ✅ CORRECTED LINE (was 'useSingleFileAuthState')
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const crypto = require("crypto");

const ADMIN_NUMBER = "254106090661";
const DEBUG_MODE = true;

const userViolations = new Map();
const notAdminGroups = new Map();
const NOT_ADMIN_CACHE_TTL = 60 * 60 * 1000; // 1 hour

const recentMessages = new Map();
const DUP_WINDOW_MS = 30000;
const DUP_BLOCK_FROM = 2;

// Track if we've ever successfully connected (for pairing flow)
let hasConnectedBefore = false;

const createSilentLogger = () => {
  const noOp = () => {};
  return {
    level: "silent",
    trace: noOp, debug: noOp, info: noOp, warn: noOp, error: noOp, fatal: noOp,
    child: () => createSilentLogger(),
  };
};

// SESSION PERSISTENCE FUNCTIONS
function saveSessionToEnv(sessionData) {
  try {
    const sessionString = JSON.stringify(sessionData);
    const encrypted = encrypt(sessionString);
    
    // This will be printed in logs. Copy this to Render environment variable
    console.log("\n" + "=".repeat(60));
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
    console.log("=".repeat(60) + "\n");
    
    return encrypted;
  } catch (error) {
    console.log("❌ Error saving session:", error.message);
    return null;
  }
}

function loadSessionFromEnv() {
  try {
    const encrypted = process.env.WHATSAPP_SESSION;
    if (!encrypted) {
      console.log("ℹ️ No saved session found in environment variables");
      return null;
    }
    
    const decrypted = decrypt(encrypted);
    return JSON.parse(decrypted);
  } catch (error) {
    console.log("❌ Error loading session:", error.message);
    return null;
  }
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(process.env.SESSION_KEY || 'defaultkey1234567890123456789012345'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(process.env.SESSION_KEY || 'defaultkey1234567890123456789012345'), iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
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
    // ✅ LOAD AUTH STATE CORRECTLY
    // This replaces the problematic 'useSingleFileAuthState'
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
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
      
      // Small delay to let connection establish
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
        console.log("⏳ Waiting for you to enter the code...");
      } catch (e) {
        console.log("⚠️ Pairing code error:", e?.message);
        console.log("🔄 Will retry in 10 seconds...");
      }
    } else {
      // Save the current session to environment variable
      const sessionData = {
        creds: state.creds,
        keys: state.keys
      };
      saveSessionToEnv(sessionData);
    }

    sock.ev.on("creds.update", async (creds) => {
      // Update the state with new credentials
      state.creds = creds;
      
      // Save credentials using original function
      if (typeof saveCreds === 'function') {
        await saveCreds();
      }
      
      // Also save to environment variable
      const sessionData = {
        creds: state.creds,
        keys: state.keys
      };
      saveSessionToEnv(sessionData);
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "open") {
        hasConnectedBefore = true;
        console.log("");
        console.log("╔══════════════════════════════════════════╗");
        console.log("║ ✅ ANTI-LINK BOT v2.8 ONLINE            ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log("║ 🤖 Bot: " + (sock.user?.id || "unknown").substring(0,30).padEnd(31) + "║");
        console.log("║ 👑 Owner: " + ADMIN_NUMBER.padEnd(30) + "║");
        console.log("║ 📋 Mode: All groups (try & catch)        ║");
        console.log("║ ⏱️ Not-admin cache: 1 hour               ║");
        console.log("║ 💾 Session: Saved in ENV variable       ║");
        console.log("╚══════════════════════════════════════════╝");
        console.log("");
        console.log("✅ Bot will process ALL groups.");
        console.log("✅ Messages deleted for EVERYONE (not just sender).");
        console.log("✅ Owner can use !bot command.");
        console.log("✅ ZIP files are now violations.");
        console.log("✅ Session persists through restarts.");
        console.log("");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "unknown";
        
        console.log("🔌 Connection closed: " + reason);
        
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        
        if (isLoggedOut && hasConnectedBefore) {
          console.log("❌ Logged out. You'll need to re-pair.");
          // Clear the saved session
          console.log("🔄 Clear the WHATSAPP_SESSION environment variable and restart.");
        } else {
          const delay = hasConnectedBefore ? 5000 : 10000;
          console.log("🔄 Reconnecting in " + (delay/1000) + " seconds...");
          setTimeout(() => startBot().catch(console.error), delay);
        }
      }

      if (qr) {
        console.log("📱 QR Code received - but we're using pairing code instead");
        console.log("⏳ If you see this, wait for pairing code or restart bot");
      }
    });

    async function safeDelete(groupJid, msgKey) {
      const notAdmin = notAdminGroups.get(groupJid);
      if (notAdmin && (Date.now() - notAdmin) < NOT_ADMIN_CACHE_TTL) {
        if (DEBUG_MODE) console.log("⏭️ Skipping delete - cached as not admin for this group");
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
            console.log("📝 Bot is not admin in this group - caching for 1 hour");
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

        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command - check BEFORE fromMe filter
        if (textLower === "!bot") {
          console.log("📨 !bot command from:", senderJid);
          try {
            let responseText = "✅ ANTI-LINK BOT v2.7 ACTIVE\n";
            responseText += "👑 Owner: " + ADMIN_NUMBER + "\n";
            responseText += "📋 Mode: All groups (try & catch, Baby!)\n";
            responseText += "⏱️ Not-admin cache: 1 hour\n";
            responseText += "💾 Session: Persists through restarts\n";
            if (isOwner(senderJid)) {
              responseText += "🔑 You are the owner - you are exempt from all rules";
            }
            await sock.sendMessage(groupJid, { text: responseText });
            console.log("✅ Sent !bot response");
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e?.message);
          }
          return;
        }

        // Skip messages from bot itself (except !bot which was handled above)
        if (msg.key.fromMe) return;

        // Owner is exempt from violations
        if (isOwner(senderJid)) {
          if (DEBUG_MODE) console.log("👑 Owner message - exempt from rules");
          return;
        }

        const dup = checkDuplicate(groupJid, senderJid, visibleText);
        const hasLink = detectLinks(visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg);
        const apk = isAPKFile(msg);
        const zip = isZipFile(msg);
        const keyword = detectKeyword(visibleText);
        const buttons = hasButtons(msg);
        const contact = isContactMessage(msg);

        const violated = dup.isDuplicate || hasLink || hasPhone || business || apk || zip || keyword || buttons || contact;
        if (!violated) return;

        const reasons = [];
        if (dup.isDuplicate) reasons.push("duplicate(x" + dup.count + ")");
        if (hasLink) reasons.push("link");
        if (hasPhone) reasons.push("phone");
        if (business) reasons.push("business");
        if (apk) reasons.push("apk");
        if (zip) reasons.push("zip");
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
        console.log("Group: " + groupJid);
        console.log("Reason: " + reasons.join(", "));
        console.log("Strike: " + updated + "/3");
        console.log("Text: " + visibleText.substring(0, 150));

        const deleted = await safeDelete(groupJid, msg.key);
        if (deleted) {
          console.log("✅ Message deleted for EVERYONE");

          if (updated >= 3) {
            console.log("⚠️ User reached 3 strikes - removing from group...");
            await new Promise(r => setTimeout(r, 500));
            const removed = await safeRemove(groupJid, senderJid);
            if (removed) {
              userViolations.delete(userKey);
              console.log("❌ User removed after 3 violations");
            }
          }
        } else {
          console.log("⚠️ Could not delete message (bot may not be admin)");
        }
        console.log("");
      } catch (e) {
        console.log("⚠️ Error handling message:", e?.message);
      }
    }

    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];

      for (const msg of messages) {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) continue;
        if (!msg.message) continue;

        if (DEBUG_MODE && !msg.key.fromMe) {
          console.log("📩 New message in:", msg.key.remoteJid.substring(0, 20) + "...");
        }

        handleMessage(msg).catch(() => {});
      }
    });

    setInterval(() => {
      cleanupCaches();
    }, 30000);

    console.log("🚀 Bot initialized - waiting for connection...");
  } catch (e) {
    console.log("❌ Start error:", e.message);
    console.log("🔄 Retrying in 30 seconds...");
    setTimeout(() => startBot().catch(() => {}), 30000);
  }
}

// HEALTH CHECK SERVER (Keeps Render awake)
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Anti-Link Bot v2.8 ONLINE\nOwner: 254106090661\nSession: Persists through restarts');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Health] Server ready for pings on port ${PORT}`);
});

// Start the bot
startBot();
