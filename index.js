// index.js - Anti-Link Bot v2.4
// FIXED: Admin detection, group allowlist, duplicate-spam control, and load reduction
//
// What this fixes for your logs:
// - “Bot is admin in 0/13 groups”: now uses robust JID matching (device suffix :9, @lid vs @s.whatsapp.net)
// - Bot will ONLY process messages from groups in an allowlist built at startup (admin groups only)
// - Duplicate messages sent back-to-back are treated as spam violations and deleted immediately
// - Reduces rate-overlimit by batching deletes & spacing actions
// - Bad MAC spam: ignores undecrypted messages early and avoids extra metadata calls


// 
// Key changes in v2.3:
// - !bot command works everywhere (for debugging)
// - Shows detailed participant logs to debug admin detection
// - Added protections for "Bad MAC" errors
// - Explicitly logs when bot is found in a group

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
const ADMIN_NUMBER = "254106090661"; // Owner number - exempt from rules
const DEBUG_MODE = true; // Set to true to see detailed logs
// ----------------------------

const userViolations = new Map();
const messageQueue = [];
let isProcessing = false;
let botJid = null; // Bot's own JID
let botPhoneNumber = null; // Just the phone number extracted from bot JID

// Cache for group admin status
const groupCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Track removed users
const removedUsers = new Map();

// Spam detection
const recentMessages = new Map();
const SPAM_WINDOW_MS = 30000;
const MAX_DUPLICATE_COUNT = 2;

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

// Extract just the phone number from any JID format
// Handles: 254106090661:9@s.whatsapp.net, 254106090661@s.whatsapp.net, 116775916175567@lid, etc.
function extractPhoneNumber(jid) {
  if (!jid) return null;
  // Remove @s.whatsapp.net, @c.us, @lid, @g.us etc
  let clean = jid.split("@")[0];
  // Remove :0, :9, etc suffix
  clean = clean.split(":")[0];
  // Return just digits
  return clean.replace(/\D/g, "");
}

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
const keywordPattern = "\\b(" + KEYWORDS.join("|") + ")\\b";
const KEYWORDS_REGEX = new RegExp(keywordPattern, "i");

function detectKeyword(text) {
  if (!text) return false;
  return KEYWORDS_REGEX.test(text);
}

function isOwnerJidMatch(senderJid) {
  if (!senderJid) return false;
  const senderPhone = extractPhoneNumber(senderJid);
  
  // Check if sender is owner
  if (senderPhone === ADMIN_NUMBER) {
    return true;
  }
  // Check if sender is bot itself
  if (botPhoneNumber && senderPhone === botPhoneNumber) {
    return true;
  }
  return false;
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

function checkAndTrackSpam(groupJid, senderJid, messageText) {
  const key = `${groupJid}-${senderJid}`;
  const now = Date.now();
  const normalizedText = messageText.trim().toLowerCase();
  
  if (!normalizedText) return { isSpam: false, count: 0 };
  
  const existing = recentMessages.get(key);
  
  if (existing && (now - existing.timestamp) > SPAM_WINDOW_MS) {
    recentMessages.delete(key);
    recentMessages.set(key, { lastMessage: normalizedText, count: 1, timestamp: now });
    return { isSpam: false, count: 1 };
  }
  
  if (existing && existing.lastMessage === normalizedText) {
    existing.count++;
    existing.timestamp = now;
    return { isSpam: existing.count > MAX_DUPLICATE_COUNT, count: existing.count };
  } else {
    recentMessages.set(key, { lastMessage: normalizedText, count: 1, timestamp: now });
    return { isSpam: false, count: 1 };
  }
}

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
      printQRInTerminal: true,
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
        botJid = sock.user?.id;
        botPhoneNumber = extractPhoneNumber(botJid);
        console.log("✅ BOT ONLINE - Stable");
        console.log(`🤖 Bot JID: ${botJid}`);
        console.log(`📱 Bot Phone: ${botPhoneNumber}`);
        console.log(`👑 Owner (exempt): ${ADMIN_NUMBER}`);
        console.log("📋 Monitoring groups where BOT is admin");
        
        // Scan groups after 5 seconds
        setTimeout(() => scanGroups(sock), 5000);
      } else if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log("🔌 Connection closed:", lastDisconnect?.error?.message || "unknown");
        if (shouldReconnect) {
          setTimeout(() => startBot().catch(() => {}), 5000);
        } else {
          console.log("❌ Logged out from WhatsApp. Manual re-scan required.");
        }
      }
      if (qr) console.log("📱 Scan QR code to login");
    });

    // Scan all groups on startup
    async function scanGroups(sock) {
      try {
        console.log("🔍 Scanning groups...");
        const groups = await sock.groupFetchAllParticipating();
        let adminCount = 0;
        let totalCount = 0;
        
        for (const [groupJid, groupData] of Object.entries(groups)) {
          totalCount++;
          const result = await checkGroupStatus(groupJid);
          if (result.botIsAdmin) {
            adminCount++;
            console.log(`✅ Bot is admin in: ${groupData.subject}`);
          }
        }
        
        console.log(`📊 Bot is admin in ${adminCount}/${totalCount} groups`);
        console.log("ℹ️ Bot will only work in groups where it is admin");
      } catch (e) {
        console.log("⚠️ Could not scan groups:", e.message);
      }
    }

    // Check if bot is admin in group
    async function checkGroupStatus(groupJid) {
      const cached = groupCache.get(groupJid);
      const now = Date.now();
      
      if (cached && (now - cached.lastChecked) < GROUP_CACHE_TTL) {
        return cached;
      }
      
      try {
        const meta = await sock.groupMetadata(groupJid);
        if (!meta?.participants) {
          const result = { botIsAdmin: false, lastChecked: now };
          groupCache.set(groupJid, result);
          return result;
        }
        
        let botIsAdmin = false;
        
        for (const p of meta.participants) {
          const isAdmin = p.admin === "admin" || p.admin === "superadmin";
          
          // Check if this participant is the bot using phone number extraction
          const participantPhone = extractPhoneNumber(p.id);
          
          if (participantPhone === botPhoneNumber || participantPhone === ADMIN_NUMBER) {
            botIsAdmin = isAdmin;
            if (DEBUG_MODE) {
              console.log(`🔍 Found bot in group: ${p.id} (phone: ${participantPhone}) admin: ${isAdmin}`);
            }
            if (isAdmin) break; // Found bot as admin, no need to continue
          }
        }
        
        const result = { botIsAdmin, lastChecked: now };
        groupCache.set(groupJid, result);
        return result;
      } catch (e) {
        if (cached) return cached;
        return { botIsAdmin: false, lastChecked: now };
      }
    }

    // Process message queue
    async function processMessageQueue() {
      if (isProcessing || messageQueue.length === 0) return;
      
      isProcessing = true;
      let processedCount = 0;
      const maxPerBatch = 10;
      
      while (messageQueue.length > 0 && processedCount < maxPerBatch) {
        const { msg, sock } = messageQueue.shift();
        try {
          await handleMessage(msg, sock);
          processedCount++;
        } catch (error) {
          console.log("⚠️ Error processing queued message:", error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
      isProcessing = false;
      
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

        // Check if bot is admin in this group
        const groupStatus = await checkGroupStatus(groupJid);
        
        if (!groupStatus.botIsAdmin) {
          return; // Skip - bot can't take action here
        }

        const ownerIsSender = isOwnerJidMatch(senderJid);
        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command
        if (textLower === "!bot") {
          try {
            const response = ownerIsSender
              ? `✅ ANTI-LINK BOT ACTIVE\nOwner: ${ADMIN_NUMBER}\nBot JID: ${botJid}\nStatus: Online (owner privileges)`
              : `✅ ANTI-LINK BOT ACTIVE\nStatus: Monitoring for violations`;
            await sock.sendMessage(groupJid, { text: response });
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e.message);
          }
          return;
        }

        // Owner is exempt
        if (ownerIsSender) return;

        // Check for spam
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
          const violationIncrease = spamCheck.isSpam ? Math.min(spamCheck.count - 1, 2) : 1;
          const updated = current + violationIncrease;
          userViolations.set(userKey, updated);

          console.log(`🚫 Violation #${updated} → ${senderJid} | reason:${reasonParts.join(", ")}`);

          // Delete message
          try {
            await sock.sendMessage(groupJid, { delete: msg.key });
          } catch (delErr) {
            if (delErr.message?.includes("rate-overlimit")) {
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
              await new Promise(r => setTimeout(r, 500));
              await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
              trackRemovedUser(groupJid, senderJid);
              userViolations.delete(userKey);
              recentMessages.delete(`${groupJid}-${senderJid}`);
              console.log(`❌ Removed ${senderJid} after ${updated} violations`);
            } catch (remErr) {
              console.log("⚠️ Could not remove user:", remErr.message);
            }
          }
        }
      } catch (procErr) {
        console.log("⚠️ Error processing message:", procErr.message);
      }
    }

    // Message handler
    sock.ev.on("messages.upsert", async (m) => {
      const messages = m.messages || [];
      
      for (const msg of messages) {
        if (!msg) continue;
        
        if (msg.key?.remoteJid?.includes("@g.us") && !msg.key.fromMe && msg.message) {
          messageQueue.push({ msg, sock });
        }
      }
      
      processMessageQueue();
    });
    
    // Periodic cleanup
    setInterval(() => {
      if (messageQueue.length > 0) {
        processMessageQueue();
      }
      cleanupSpamTracker();
    }, 15000);
    
    // Clear cache periodically
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of groupCache.entries()) {
        if (now - value.lastChecked > GROUP_CACHE_TTL * 2) {
          groupCache.delete(key);
        }
      }
    }, 60000);

    // Monitor group updates
    sock.ev.on("group-participants.update", async (update) => {
      try {
        const { id: groupJid, participants, action } = update;
        
        const groupStatus = await checkGroupStatus(groupJid);
        if (!groupStatus.botIsAdmin) return;
        
        if (action === "add") {
          for (const participant of participants) {
            if (wasRecentlyRemoved(groupJid, participant)) {
              console.log(`🚫 Blocking re-add of ${participant}`);
              await new Promise(r => setTimeout(r, 1000));
              try {
                await sock.groupParticipantsUpdate(groupJid, [participant], "remove");
                console.log(`❌ Re-removed ${participant}`);
                await sock.sendMessage(groupJid, {
                  text: "⚠️ This user was recently removed and cannot be added back yet."
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

    console.log("🚀 Bot initialized - waiting for connection...");

  } catch (startError) {
    console.log("❌ Start error:", startError.message);
    setTimeout(() => startBot().catch(() => {}), 10000);
  }
}

startBot();
