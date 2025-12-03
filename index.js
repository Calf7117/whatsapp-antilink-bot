// index.js - Performance-optimized Anti-Link Bot with message queue
// FIXES IN THIS VERSION:
// - Only monitors groups where ADMIN_NUMBER is an admin (reduces load significantly)
// - Detects & blocks duplicate/spam messages
// - Rate limiting protection with delays
// - Caches group admin status to reduce API calls

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
const ADMIN_NUMBER = "254106090661"; // Only this number is fully exempt
const AUTH_DEBUG_LOG_ADMIN_JID = false;
// ----------------------------

const userViolations = new Map();
const messageQueue = [];
let isProcessing = false;

// Cache for groups where owner is admin (reduces API calls)
// Key: groupJid, Value: { isOwnerAdmin: boolean, lastChecked: timestamp }
const groupAdminCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Track removed users
const removedUsers = new Map();

// Track recent messages for spam/duplicate detection
// Key: `${groupJid}-${senderJid}`, Value: { lastMessage: string, count: number, timestamp: number }
const recentMessages = new Map();
const SPAM_WINDOW_MS = 30000; // 30 seconds window for duplicate detection
const MAX_DUPLICATE_COUNT = 2; // After 2 same messages, it's spam

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

// ------------------ Detection Helpers ------------------

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
const KEYWORDS_REGEX = new RegExp("\\b(?:" + KEYWORDS.map(w => w.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")).join("|") + ")\\b", "i");

function detectKeyword(text) {
  if (!text) return false;
  return KEYWORDS_REGEX.test(text);
}

function isOwnerJidMatch(senderJid) {
  if (!senderJid) return false;
  const adminNum = ADMIN_NUMBER.replace(/\D/g, "");
  const senderNum = senderJid.replace(/\D/g, "");
  return senderNum === adminNum || senderJid.includes(adminNum);
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
    push(tmpl.hydratedContentText); push(tmpl.hydratedFooterText); push(tmpl.hydratedTitleText);
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
  if (im) { push(im.body?.text); push(im.footer?.text); push(im.header?.title); }

  const ext = content.extendedTextMessage?.contextInfo?.externalAdReply;
  if (ext) { push(ext.title); push(ext.body); push(ext.mediaUrl); push(ext.sourceUrl); }

  const quoted = content.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quoted && typeof quoted === "object") push(extractTextFromContent(quoted));

  const vo = content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content.viewOnceMessageV2Extension?.message;
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

function wasRecentlyRemoved(groupJid, userJid) {
  const key = `${groupJid}-${userJid}`;
  const removedData = removedUsers.get(key);
  if (!removedData) return false;
  const maxAge = 24 * 60 * 60 * 1000;
  if (Date.now() - removedData.timestamp > maxAge) {
    removedUsers.delete(key);
    return false;
  }
  return true;
}

function trackRemovedUser(groupJid, removedUserJid) {
  const key = `${groupJid}-${removedUserJid}`;
  removedUsers.set(key, { timestamp: Date.now() });
}

// Check if message is spam/duplicate
function checkAndTrackSpam(groupJid, senderJid, messageText) {
  const key = `${groupJid}-${senderJid}`;
  const now = Date.now();
  const normalizedText = messageText.trim().toLowerCase();
  
  // Skip empty messages
  if (!normalizedText) return { isSpam: false, count: 0 };
  
  const existing = recentMessages.get(key);
  
  // Clean up old entries
  if (existing && (now - existing.timestamp) > SPAM_WINDOW_MS) {
    recentMessages.delete(key);
    recentMessages.set(key, { lastMessage: normalizedText, count: 1, timestamp: now });
    return { isSpam: false, count: 1 };
  }
  
  if (existing && existing.lastMessage === normalizedText) {
    // Same message sent again
    existing.count++;
    existing.timestamp = now;
    return { isSpam: existing.count > MAX_DUPLICATE_COUNT, count: existing.count };
  } else {
    // Different message, reset
    recentMessages.set(key, { lastMessage: normalizedText, count: 1, timestamp: now });
    return { isSpam: false, count: 1 };
  }
}

// Clean up old spam tracking entries periodically
function cleanupSpamTracker() {
  const now = Date.now();
  for (const [key, value] of recentMessages.entries()) {
    if (now - value.timestamp > SPAM_WINDOW_MS * 2) {
      recentMessages.delete(key);
    }
  }
}

// ------------------ Bot startup ------------------
async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const keyStore = makeCacheableSignalKeyStore(state.keys, createSilentLogger());
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 WA v${version.join(".")}  latest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: keyStore },
      printQRInTerminal: false,
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

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (connection === "open") {
        console.log("✅ BOT ONLINE - Stable");
        console.log(`👑 Owner (exempt): ${ADMIN_NUMBER}`);
        console.log("📋 Only monitoring groups where owner is admin");
      } else if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log("🔌 Connection closed:", lastDisconnect?.error?.message || "unknown");
        if (shouldReconnect) {
          setTimeout(() => startBot().catch(() => {}), 5000);
        } else {
          console.log("❌ Logged out from WhatsApp. Manual re-scan required.");
        }
      }
      if (qr) console.log("⚠️ QR generated (unexpected if auth_info present).");
    });

    // Check if owner is admin in group (with caching)
    async function isOwnerAdminInGroup(groupJid) {
      const cached = groupAdminCache.get(groupJid);
      const now = Date.now();
      
      if (cached && (now - cached.lastChecked) < GROUP_CACHE_TTL) {
        return cached.isOwnerAdmin;
      }
      
      try {
        const meta = await sock.groupMetadata(groupJid);
        if (!meta?.participants) {
          groupAdminCache.set(groupJid, { isOwnerAdmin: false, lastChecked: now });
          return false;
        }
        
        const adminNum = ADMIN_NUMBER.replace(/\D/g, "");
        const isOwnerAdmin = meta.participants.some(p => {
          const pNum = p.id.replace(/\D/g, "");
          return (pNum === adminNum || p.id.includes(adminNum)) && 
                 (p.admin === "admin" || p.admin === "superadmin");
        });
        
        groupAdminCache.set(groupJid, { isOwnerAdmin, lastChecked: now });
        return isOwnerAdmin;
      } catch (e) {
        // On error, assume not admin to avoid processing
        return false;
      }
    }

    // Process message queue with rate limiting
    async function processMessageQueue() {
      if (isProcessing || messageQueue.length === 0) return;
      
      isProcessing = true;
      let processedCount = 0;
      const maxPerBatch = 10; // Process max 10 messages per batch to prevent rate limiting
      
      while (messageQueue.length > 0 && processedCount < maxPerBatch) {
        const { msg, sock } = messageQueue.shift();
        try {
          await handleMessage(msg, sock);
          processedCount++;
        } catch (error) {
          console.log("⚠️ Error processing queued message:", error.message);
        }
        // Delay between messages to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
      isProcessing = false;
      
      // If more messages in queue, schedule next batch
      if (messageQueue.length > 0) {
        setTimeout(() => processMessageQueue(), 1000);
      }
    }

    // Main message handler
    async function handleMessage(msg, sock) {
      try {
        if (!msg.key?.remoteJid || !msg.key.remoteJid.includes("@g.us") || msg.key.fromMe) return;
        if (!msg.message) return;

        const groupJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;

        // CRITICAL: Only process groups where owner is admin
        const ownerIsAdmin = await isOwnerAdminInGroup(groupJid);
        if (!ownerIsAdmin) {
          return; // Skip this group entirely
        }

        const ownerIsSender = isOwnerJidMatch(senderJid);
        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command handling
        if (textLower === "!bot") {
          try {
            if (ownerIsSender) {
              await sock.sendMessage(groupJid, {
                text: `✅ ANTI-LINK BOT ACTIVE\nOwner (exempt): ${ADMIN_NUMBER}\nStatus: Online (owner privileges)\nMonitoring: Groups where owner is admin only`,
              });
            } else {
              await sock.sendMessage(groupJid, { text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Monitoring for violations` });
            }
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e.message);
          }
          return;
        }

        // Owner exemption
        if (ownerIsSender) return;

        // Check for spam/duplicate messages
        const spamCheck = checkAndTrackSpam(groupJid, senderJid, visibleText);
        
        // Violation checks
        const hasLink = detectLinks(visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg);
        const apk = isAPKFile(msg);
        const keyword = detectKeyword(visibleText);
        const buttons = hasButtons(msg);
        const contact = isContactMessage(msg);

        if (hasLink || hasPhone || business || apk || keyword || buttons || contact || spamCheck.isSpam) {
          const reasonParts = [];
          if (hasLink) reasonParts.push("link");
          if (hasPhone) reasonParts.push("phone");
          if (business) reasonParts.push("business");
          if (apk) reasonParts.push("apk");
          if (keyword) reasonParts.push("keyword");
          if (buttons) reasonParts.push("buttons");
          if (contact) reasonParts.push("contact");
          if (spamCheck.isSpam) reasonParts.push(`spam(x${spamCheck.count})`);

          const userKey = `${groupJid}-${senderJid}`;
          const current = userViolations.get(userKey) || 0;
          // Spam counts as extra violations
          const violationIncrease = spamCheck.isSpam ? Math.min(spamCheck.count - 1, 2) : 1;
          const updated = current + violationIncrease;
          userViolations.set(userKey, updated);

          console.log(`🚫 Violation #${updated} → ${senderJid} | group:${groupJid} | reason:${reasonParts.join(", ")}`);

          // Delete message with retry
          try {
            await sock.sendMessage(groupJid, { delete: msg.key });
          } catch (delErr) {
            if (delErr.message?.includes("rate-overlimit")) {
              // Wait and retry once
              await new Promise(r => setTimeout(r, 2000));
              try {
                await sock.sendMessage(groupJid, { delete: msg.key });
              } catch (e) {
                console.log("⚠️ Delete failed after retry:", e.message);
              }
            } else {
              console.log("⚠️ Delete failed:", delErr.message);
            }
          }

          // Remove on 3rd strike
          if (updated >= 3) {
            try {
              await new Promise(r => setTimeout(r, 500)); // Small delay before remove
              await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
              trackRemovedUser(groupJid, senderJid);
              userViolations.delete(userKey);
              recentMessages.delete(`${groupJid}-${senderJid}`);
              console.log(`❌ Removed ${senderJid} from ${groupJid} after ${updated} violations`);
            } catch (remErr) {
              console.log("⚠️ Could not remove user:", remErr.message);
            }
          }
        }
      } catch (procErr) {
        console.log("⚠️ Error processing message:", procErr.message);
      }
    }

    // Message handler - adds to queue
    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];
      
      for (const msg of messages) {
        if (!msg) continue;
        
        // Quick filter: only queue group messages
        if (msg.key?.remoteJid?.includes("@g.us") && !msg.key.fromMe && msg.message) {
          messageQueue.push({ msg, sock });
        }
      }
      
      processMessageQueue();
    });
    
    // Process queue and cleanup periodically (less frequently)
    setInterval(() => {
      if (messageQueue.length > 0) {
        console.log(`📬 Processing ${messageQueue.length} queued messages...`);
        processMessageQueue();
      }
      cleanupSpamTracker();
    }, 15000); // Every 15 seconds instead of 5
    
    // Clear group cache periodically
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of groupAdminCache.entries()) {
        if (now - value.lastChecked > GROUP_CACHE_TTL * 2) {
          groupAdminCache.delete(key);
        }
      }
    }, 60000); // Every minute

    // Monitor group updates for re-add prevention
    sock.ev.on("group-participants.update", async (update) => {
      try {
        const { id: groupJid, participants, action } = update;
        
        // Only care about groups where owner is admin
        const ownerIsAdmin = await isOwnerAdminInGroup(groupJid);
        if (!ownerIsAdmin) return;
        
        if (action === "add") {
          for (const participant of participants) {
            if (wasRecentlyRemoved(groupJid, participant)) {
              console.log(`🚫 Blocking re-add of ${participant} to ${groupJid}`);
              await new Promise(r => setTimeout(r, 1000));
              try {
                await sock.groupParticipantsUpdate(groupJid, [participant], "remove");
                console.log(`❌ Re-removed ${participant}`);
                await sock.sendMessage(groupJid, {
                  text: `⚠️ This user was recently removed and cannot be added back yet.`
                });
              } catch (e) {
                console.log("⚠️ Could not block re-add:", e.message);
              }
            }
          }
        }
      } catch (e) {
        console.log("⚠️ Error in group update handler:", e.message);
      }
    });

    console.log("🚀 Bot initialized successfully");

  } catch (startError) {
    console.log("❌ Start error:", startError.message);
    setTimeout(() => startBot().catch(() => {}), 10000);
  }
}

startBot();
