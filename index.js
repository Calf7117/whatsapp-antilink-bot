// index.js - Final stable Anti-Link Bot (CommonJS)
// - All requested rules: links, phone numbers, APK (MIME), real business posts, keyword blocking (whole words)
// - Owner exempt (ADMIN_NUMBER). Other admins can use !bot but are not exempt.
// - Stability: cached key store, no auth_info/signal wipe, getMessage fallback, backoff

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
const AUTH_DEBUG_LOG_ADMIN_JID = false; // set true once to log exact owner JID as seen by the bot
// ----------------------------

const userViolations = new Map();

// NOTE: Do NOT delete auth_info/signal here. Preserving signal keys reduces Bad MACs.
if (!fs.existsSync(path.join(__dirname, "auth_info"))) {
  console.log("⚠️ auth_info not found — ensure your session files are in ./auth_info");
}

// Minimal silent logger for Baileys internals
const createSilentLogger = () => {
  const noOp = () => {};
  return {
    level: "silent",
    trace: noOp,
    debug: noOp,
    info: noOp,
    warn: noOp,
    error: noOp,
    fatal: noOp,
    child: () => createSilentLogger(),
  };
};

// ------------------ Detection Helpers ------------------

// Link detection rules: http(s), www, whatsapp catalog/wa.me, plus vetted TLD list
function detectLinks(text) {
  if (!text) return false;
  const patterns = [
    /https?:\/\/[^\s]+/i,        // explicit http(s)
    /www\.[^\s]+/i,              // www.*
    // whatsapp catalog / wa.me direct patterns (buttons often resolve to these)
    /\b(?:wa\.me|whatsapp\.com)\/\S+/i,
    // domain + common real TLDs (avoid matching "word.word" nonsense)
    /\b[A-Za-z0-9-]+\.(?:com|net|org|io|co|me|app|tech|info|biz|store|online|ly|ge|ke|uk|us|tv|gg|site|blog|news)(?:\/\S*)?\b/i,
  ];
  return patterns.some((r) => r.test(text));
}

// Phone numbers: any 9 or more digits inside visible text
function detectPhoneNumbers(text) {
  if (!text) return false;
  return /\d{9,}/.test(text);
}

// APK check: ONLY by MIME type (real APK file)
function isAPKFile(msg) {
  return msg.message?.documentMessage?.mimetype === "application/vnd.android.package-archive";
}

// Business detection: robust check for real product/catalog OR externalAdReply pointing to whatsapp catalog/wa.me
function isBusinessPost(msg) {
  const p = msg.message?.productMessage;
  const c = msg.message?.catalogMessage;

  // If neither present, still check external previews (buttons) that resolve to catalogs
  const ext = msg.message?.extendedTextMessage?.contextInfo?.externalAdReply;
  if ((!p && !c) && ext && (ext.sourceUrl || ext.mediaUrl || ext.title)) {
    const src = String(ext.sourceUrl || "");
    if (/\b(?:wa\.me|whatsapp\.com)\/(?:catalog|c)\/?/i.test(src)) return true;
    // if externalAdReply has obvious catalog URL, treat as business-like link
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

// Keyword blocking: whole-word matches only (case-insensitive)
const KEYWORDS = [
  "child","rape","free","price","payment","rupees","rupee","rs",
  "offer","discount","deal","promo","promotion","sell","selling",
  "buy","order","wholesale","cheap","delivery","inbox","mpesa",
  "ksh","kes","usd"
];
// prepare regex: \b(?:word1|word2|...)\b
const KEYWORDS_REGEX = new RegExp("\\b(?:" + KEYWORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");

function detectKeyword(text) {
  if (!text) return false;
  return KEYWORDS_REGEX.test(text);
}

// Owner matching across JID formats
function isOwnerJidMatch(senderJid) {
  if (!senderJid) return false;
  const adminNum = ADMIN_NUMBER.replace(/\D/g, "");
  const senderNum = senderJid.replace(/\D/g, "");
  const possibleForms = [
    `${adminNum}@s.whatsapp.net`,
    `${adminNum}@whatsapp.net`,
    `${adminNum}@c.us`,
    adminNum,
    `+${adminNum}`,
  ];
  return senderNum === adminNum || possibleForms.includes(senderJid) || senderJid.includes(adminNum);
}

// Extract visible text safely (only from user-facing fields)
function extractVisibleText(msg) {
  try {
    return (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      ""
    ) || "";
  } catch {
    return "";
  }
}

// ------------------ Bot startup ------------------
async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    // Cache the keys rather than using raw state.keys directly (reduces Bad MACs)
    const keyStore = makeCacheableSignalKeyStore(state.keys, createSilentLogger());

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 WA v${version.join(".")}  latest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: keyStore,
      },
      printQRInTerminal: false,
      logger: createSilentLogger(),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,

      // Stability improvements
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
      } else if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log("🔌 Connection closed:", lastDisconnect?.error?.message || "unknown");
        if (shouldReconnect) {
          setTimeout(() => startBot().catch(() => {}), 5000);
        } else {
          console.log("❌ Logged out from WhatsApp. Manual re-scan required.");
        }
      }
      if (qr) {
        console.log("⚠️ QR generated (unexpected if auth_info present).");
      }
    });

    // One-time debug printing of owner JID if requested
    let ownerJidLogged = false;

    // Message handler
    sock.ev.on("messages.upsert", async (m) => {
      const msg = m.messages?.[0];
      if (!msg) return;

      try {
        // Only handle decrypted, group messages not from the bot itself
        if (!msg.key?.remoteJid || !msg.key.remoteJid.includes("@g.us") || msg.key.fromMe) return;
        if (!msg.message) return; // unreadable or undecrypted (Bad MAC etc) — skip gracefully

        const groupJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;

        // optional debug of owner JID as seen
        if (AUTH_DEBUG_LOG_ADMIN_JID && !ownerJidLogged && isOwnerJidMatch(senderJid)) {
          console.log("🔎 Seen owner JID as:", senderJid);
          ownerJidLogged = true;
        }

        // Fetch group admins (used so group admins can use !bot)
        let groupAdmins = [];
        try {
          const meta = await sock.groupMetadata(groupJid);
          if (meta?.participants) {
            groupAdmins = meta.participants
              .filter((p) => p.admin === "admin" || p.admin === "superadmin")
              .map((p) => p.id);
          }
        } catch (e) {
          // ignore metadata fetch error — still safe
        }

        const ownerIsSender = isOwnerJidMatch(senderJid);
        const senderIsAdmin = groupAdmins.includes(senderJid);

        // Extract visible text
        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command handling
        if (textLower === "!bot") {
          try {
            if (ownerIsSender) {
              await sock.sendMessage(groupJid, {
                text: `✅ ANTI-LINK BOT ACTIVE\nOwner (exempt): ${ADMIN_NUMBER}\nStatus: Online (owner privileges)`,
              });
            } else if (senderIsAdmin) {
              await sock.sendMessage(groupJid, { text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Online (group admin)` });
            } else {
              await sock.sendMessage(groupJid, { text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Monitoring for violations` });
            }
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e.message);
          }
          return; // !bot is not considered a violation
        }

        // Owner exemption: owner never deleted
        if (ownerIsSender) return;

        // Violation checks:
        const hasLink = detectLinks(visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg);
        const apk = isAPKFile(msg);
        const keyword = detectKeyword(visibleText);

        if (hasLink || hasPhone || business || apk || keyword) {
          const reasonParts = [];
          if (hasLink) reasonParts.push("link");
          if (hasPhone) reasonParts.push("phone");
          if (business) reasonParts.push("business");
          if (apk) reasonParts.push("apk");
          if (keyword) reasonParts.push("keyword");

          const userKey = `${groupJid}-${senderJid}`;
          const current = userViolations.get(userKey) || 0;
          const updated = current + 1;
          userViolations.set(userKey, updated);

          console.log(
            `🚫 Violation #${updated} → ${senderJid} | group:${groupJid} | reason:${reasonParts.join(", ")}`
          );
          console.log(`📨 VisibleText: "${visibleText}"`);

          // Silent delete
          try {
            await sock.sendMessage(groupJid, {
              delete: { remoteJid: groupJid, fromMe: false, id: msg.key.id, participant: senderJid },
            });
          } catch (delErr) {
            console.log("⚠️ Delete failed:", delErr.message);
          }

          // Remove on 3rd strike
          if (updated >= 3) {
            try {
              await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
              userViolations.delete(userKey);
              console.log(`❌ Removed ${senderJid} from ${groupJid} after ${updated} violations`);
            } catch (remErr) {
              console.log("⚠️ Could not remove user:", remErr.message);
            }
          }
        }
      } catch (procErr) {
        // catch-all to avoid crashing message loop
        console.log("⚠️ Error processing message:", procErr.message);
      }
    });
  } catch (startupErr) {
    console.log("❌ Startup error:", startupErr.message);
    setTimeout(() => startBot().catch(() => {}), 10000);
  }
}

// Start
console.log("🚀 Starting Anti-Link Bot (stable/final) using stored session...");
startBot().catch((e) => {
  console.log("❌ Fatal start error:", e.message);
});
