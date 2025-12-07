// index.js - Anti-Link Bot v2.6
// FIXED: !bot command works for owner, Delete for EVERYONE
// Key fix: !bot check is BEFORE fromMe filter so owner can use it

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
const ADMIN_NUMBER = "254106090661"; // Owner - fully exempt from all rules
const DEBUG_MODE = true;             // Set true for verbose logging
// ----------------------------

const userViolations = new Map();
const messageQueue = [];
let isProcessing = false;

// Duplicate/spam tracking
const recentMessages = new Map();
const DUP_WINDOW_MS = 30000;
const DUP_BLOCK_FROM = 2;

// Track groups where bot is not admin
const notAdminGroups = new Map();
const NOT_ADMIN_CACHE_TTL = 10 * 60 * 1000;

if (!fs.existsSync(path.join(__dirname, "auth_info"))) {
  console.log("⚠️ auth_info not found — ensure your session files are in ./auth_info");
}

const createSilentLogger = () => {
  const noOp = () => {};
  return {
    level: "silent",
    trace: noOp, debug: noOp, info: noOp, warn: noOp, error: noOp, fatal: noOp,
    child: () => createSilentLogger(),
  };
};

// Extract phone number from JID
function extractPhoneNumber(jid) {
  if (!jid) return "";
  let clean = String(jid).split("@")[0];
  clean = clean.split(":")[0];
  return clean.replace(/\D/g, "");
}

// Check if sender is the owner
function isOwner(senderJid) {
  if (!senderJid) return false;
  const phone = extractPhoneNumber(senderJid);
  if (phone === ADMIN_NUMBER) return true;
  if (senderJid.includes(ADMIN_NUMBER)) return true;
  return false;
}

// Detection functions
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

// Bot startup
async function startBot() {
  try {
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
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 15000,
      getMessage: async () => undefined,
      msgRetryCounterCache: new Map(),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === "open") {
        console.log("");
        console.log("╔══════════════════════════════════════════╗");
        console.log("║     ✅ ANTI-LINK BOT v2.5 ONLINE        ║");
        console.log("╠══════════════════════════════════════════╣");
        console.log("║  🤖 Bot: " + (sock.user?.id || "unknown").substring(0,30).padEnd(31) + "║");
        console.log("║  👑 Owner: " + ADMIN_NUMBER.padEnd(29) + "║");
        console.log("║  📋 Mode: All groups (try & catch)       ║");
        console.log("║  🔧 !bot now works for owner            ║");
        console.log("╚══════════════════════════════════════════╝");
        console.log("");
        console.log("✅ Bot will process ALL groups.");
        console.log("✅ Messages deleted for EVERYONE (not just sender).");
        console.log("✅ Owner can use !bot command.");
        console.log("");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = String(lastDisconnect?.error?.message || "").toLowerCase();

        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isConflict =
          statusCode === DisconnectReason.connectionReplaced ||
          errorMessage.includes("conflict") ||
          errorMessage.includes("replaced");

        console.log("🔌 Connection closed:", lastDisconnect?.error?.message || "unknown");

        if (isLoggedOut) {
          console.log("❌ Logged out. Delete auth_info folder and re-scan QR.");
        } else if (isConflict) {
          console.log("⚠️ Session conflict detected (account opened somewhere else).");
          console.log("ℹ️ Bot will NOT auto-reconnect to avoid conflict loop.");
          console.log("➡️ Close WhatsApp Web / other devices, then restart this bot manually.");
        } else {
          console.log("🔄 Reconnecting in 5 seconds...");
          setTimeout(() => startBot().catch(() => {}), 5000);
        }
      }

      if (qr) {
        console.log("📱 QR Code received - scan with WhatsApp to login");
      }
    });

    // Delete message for EVERYONE with retry
    async function safeDelete(groupJid, msgKey) {
      const notAdmin = notAdminGroups.get(groupJid);
      if (notAdmin && (Date.now() - notAdmin) < NOT_ADMIN_CACHE_TTL) {
        if (DEBUG_MODE) console.log("⏭️ Skipping delete - cached as not admin");
        return false;
      }

      try {
        await sock.sendMessage(groupJid, { delete: msgKey });
        return true;
      } catch (e) {
        const errMsg = String(e?.message || e || "");
        console.log("⚠️ Delete error:", errMsg);
        
        if (errMsg.includes("rate-overlimit")) {
          console.log("⏳ Rate limited, waiting 3 seconds...");
          await new Promise(r => setTimeout(r, 3000));
          try {
            await sock.sendMessage(groupJid, { delete: msgKey });
            return true;
          } catch (e2) {
            console.log("⚠️ Retry failed:", e2?.message);
            return false;
          }
        }
        
        if (errMsg.includes("forbidden") || errMsg.includes("not-authorized") || errMsg.includes("403")) {
          notAdminGroups.set(groupJid, Date.now());
          console.log("📝 Bot is not admin in this group - caching for 10 min");
        }
        
        return false;
      }
    }

    // Remove user from group
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

    // Main message handler
    async function handleMessage(msg) {
      try {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) return;
        if (!msg.message) return;

        const groupJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;

        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // ✅ CHECK FOR !bot COMMAND FIRST (BEFORE fromMe FILTER)
        if (textLower === "!bot") {
          console.log("📨 !bot command from:", senderJid);
          const ownerCheck = isOwner(senderJid);
          try {
            let responseText = "✅ ANTI-LINK BOT v2.5 ACTIVE\n";
            responseText += "👑 Owner: " + ADMIN_NUMBER + "\n";
            responseText += "📋 Monitoring this group, Baby!\n";
            if (ownerCheck) {
              responseText += "🔑 You are the owner - you are exempt from all rules";
            }
            await sock.sendMessage(groupJid, { text: responseText });
            console.log("✅ Sent !bot response");
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e?.message);
          }
          return;
        }

        // ✅ NOW SKIP IF MESSAGE IS FROM BOT ITSELF (AFTER !bot check)
        if (msg.key.fromMe) return;

        // Owner is ALWAYS exempt from violations
        if (isOwner(senderJid)) {
          if (DEBUG_MODE) console.log("👑 Owner message - exempt from rules");
          return;
        }

        // Check for violations
        const dup = checkDuplicate(groupJid, senderJid, visibleText);
        const hasLink = detectLinks(visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg);
        const apk = isAPKFile(msg);
        const keyword = detectKeyword(visibleText);
        const buttons = hasButtons(msg);
        const contact = isContactMessage(msg);

        const violated = dup.isDuplicate || hasLink || hasPhone || business || apk || keyword || buttons || contact;
        if (!violated) return;

        // Build reason string
        const reasons = [];
        if (dup.isDuplicate) reasons.push("duplicate(x" + dup.count + ")");
        if (hasLink) reasons.push("link");
        if (hasPhone) reasons.push("phone");
        if (business) reasons.push("business");
        if (apk) reasons.push("apk");
        if (keyword) reasons.push("keyword");
        if (buttons) reasons.push("buttons");
        if (contact) reasons.push("contact");

        // Track violations
        const userKey = groupJid + "-" + senderJid;
        const current = userViolations.get(userKey) || 0;
        const updated = current + 1;
        userViolations.set(userKey, updated);

        console.log("");
        console.log("🚫 VIOLATION DETECTED");
        console.log("   User: " + senderJid);
        console.log("   Group: " + groupJid);
        console.log("   Reason: " + reasons.join(", "));
        console.log("   Strike: " + updated + "/3");
        console.log("   Text: " + visibleText.substring(0, 100));

        // Try to delete message for EVERYONE
        const deleted = await safeDelete(groupJid, msg.key);
        
        if (deleted) {
          console.log("✅ Message deleted for EVERYONE");
          
          // Remove on 3rd strike
          if (updated >= 3) {
            console.log("⚠️ User reached 3 strikes - removing from group...");
            await new Promise(r => setTimeout(r, 500));
            const removed = await safeRemove(groupJid, senderJid);
            if (removed) {
              userViolations.delete(userKey);
              recentMessages.delete(userKey);
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

    // Process queue
    async function processQueue() {
      if (isProcessing || messageQueue.length === 0) return;
      isProcessing = true;

      const batchSize = 8;
      let processed = 0;

      while (messageQueue.length > 0 && processed < batchSize) {
        const msg = messageQueue.shift();
        await handleMessage(msg);
        processed++;
        await new Promise(r => setTimeout(r, 300));
      }

      isProcessing = false;
      
      if (messageQueue.length > 0) {
        setTimeout(processQueue, 500);
      }
    }

    // Message event
    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];
      
      for (const msg of messages) {
        if (!msg?.key?.remoteJid?.endsWith("@g.us")) continue;
        if (!msg.message) continue;
        
        if (DEBUG_MODE && !msg.key.fromMe) {
          console.log("📩 New message in:", msg.key.remoteJid.substring(0, 20) + "...");
        }
        
        messageQueue.push(msg);
      }
      
      processQueue();
    });

    // Periodic cleanup
    setInterval(() => {
      cleanupCaches();
      if (messageQueue.length > 0) processQueue();
    }, 30000);

    console.log("🚀 Bot initialized - connecting to WhatsApp...");

  } catch (e) {
    console.log("❌ Start error:", e.message);
    setTimeout(() => startBot().catch(() => {}), 10000);
  }
}

startBot();
