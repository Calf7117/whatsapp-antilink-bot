// index.js - Stability-patched Anti-Link Bot (CommonJS)
// - Reduced Bad MACs by using cached key store, backoff, and safer reconnects
// - Keeps enforcement: links, phone numbers (9+), APK files (real MIME), real business posts
// - Admin bypass for your ADMIN_NUMBER; other admins can use !bot
// - Uses getMessage fallback to avoid crashes on missing messages

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
const AUTH_DEBUG_LOG_ADMIN_JID = false; // if true, prints owner's exact JID once
// ----------------------------

const userViolations = new Map();

// NOTE: Do NOT delete auth_info/signal here. Preserving it reduces Bad MACs.
// If you previously had code that removed it, remove that behavior.
// The file is intentionally left alone in this stable version.
const keyDir = path.join(__dirname, "auth_info", "signal");
if (!fs.existsSync(path.join(__dirname, "auth_info"))) {
  console.log("⚠️ auth_info not found — make sure your stored session is in ./auth_info");
}

// Silent logger helper to keep logs tidy
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

// Real link detection (aggressive but avoids "word.word" false positives)
function detectLinks(text) {
  if (!text) return false;
  // require either http(s) or www or a validated domain token (TLD-like)
  const patterns = [
    /https?:\/\/[^\s]+/gi,       // http(s)://...
    /www\.[^\s]+/gi,             // www.example
    /\b[A-Za-z0-9-]+\.(com|net|org|io|co|me|app|tech|info|biz|store|online|ly|ge|ke|uk|us|tv|gg|site|blog|news)(\/\S*)?\b/gi,
  ];
  return patterns.some((r) => r.test(text));
}

// Phone number detection: any 9 or more digits in visible text
function detectPhoneNumbers(text) {
  if (!text) return false;
  return /\d{9,}/.test(text);
}

// Business detection - safe: only real product/catalog metadata (no empty containers)
function isBusinessPost(msg) {
  const p = msg.message?.productMessage;
  const c = msg.message?.catalogMessage;

  if (!p && !c) return false;

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

// APK check: ONLY by MIME type (real APK files)
function isAPKFile(msg) {
  return msg.message?.documentMessage?.mimetype === "application/vnd.android.package-archive";
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

// Extract visible text safely
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

    // Cache the keys rather than using raw state.keys directly
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

      // Prevent failures when message is missing
      msgRetryCounterCache: new Map(),
      // When getMessage is called by Baileys for fetching older messages, return undefined so it does not crash
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    // Connection lifecycle
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (connection === "open") {
        console.log("✅ BOT ONLINE - Stable mode");
        console.log(`👑 Owner (exempt): ${ADMIN_NUMBER}`);
      } else if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log("🔌 Connection closed:", lastDisconnect?.error?.message || "unknown");
        if (shouldReconnect) {
          // backoff a bit more if failures repeat
          setTimeout(() => startBot().catch(() => {}), 5000);
        } else {
          console.log("❌ Logged out from WhatsApp. Re-scan required.");
        }
      }
      if (qr) {
        console.log("⚠️ QR generated (shouldn't be needed if auth_info exists).");
      }
    });

    // One-time debug printing of owner JID if requested
    let ownerJidLogged = false;

    // Message handler (groups only)
    sock.ev.on("messages.upsert", async (m) => {
      const msg = m.messages?.[0];
      if (!msg) return;

      try {
        // Skip if not a group message or from the bot itself
        if (!msg.key?.remoteJid || !msg.key.remoteJid.includes("@g.us") || msg.key.fromMe) return;

        // Some messages cannot be decrypted (Bad MAC) — they are logged by Baileys internally.
        // Here, only handle messages that are readable.
        if (!msg.message) {
          // nothing to inspect
          return;
        }

        const groupJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;

        // Optional debug: print exact JID as seen for owner (once)
        if (AUTH_DEBUG_LOG_ADMIN_JID && !ownerJidLogged && isOwnerJidMatch(senderJid)) {
          console.log("🔎 Seen owner JID as:", senderJid);
          ownerJidLogged = true;
        }

        // fetch group admins (safer to get metadata here)
        let groupAdmins = [];
        try {
          const meta = await sock.groupMetadata(groupJid);
          if (meta?.participants) {
            groupAdmins = meta.participants.filter((p) => p.admin === "admin" || p.admin === "superadmin").map((p) => p.id);
          }
        } catch (e) {
          // metadata fetch failed — safe to continue (we'll rely on OWNER check)
        }

        const ownerIsSender = isOwnerJidMatch(senderJid);
        const senderIsAdmin = groupAdmins.includes(senderJid);

        // extract visible text for checks and !bot handling
        const visibleText = extractVisibleText(msg).trim();
        const textLower = visibleText.toLowerCase();

        // !bot command handling: owner, other admins, or normal users get tailored responses
        if (textLower === "!bot") {
          try {
            if (ownerIsSender) {
              await sock.sendMessage(groupJid, {
                text: `✅ ANTI-LINK BOT ACTIVE\nOwner (exempt): ${ADMIN_NUMBER}\nStatus: Online (owner privileges)`,
              });
            } else if (senderIsAdmin) {
              await sock.sendMessage(groupJid, { text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Online (group admin)` });
            } else {
              await sock.sendMessage(groupJid, { text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Monitoring for links` });
            }
          } catch (e) {
            console.log("⚠️ Could not send !bot reply:", e.message);
          }
          return; // do not treat the !bot message as a violation
        }

        // Owner is fully exempt from enforcement
        if (ownerIsSender) return;

        // analyze for violations (only visible text for phone/link detection)
        const hasLink = detectLinks(visibleText);
        const hasPhone = detectPhoneNumbers(visibleText);
        const business = isBusinessPost(msg);
        const apk = isAPKFile(msg);

        if (hasLink || hasPhone || business || apk) {
          const userKey = `${groupJid}-${senderJid}`;
          const current = userViolations.get(userKey) || 0;
          const updated = current + 1;
          userViolations.set(userKey, updated);

          console.log(
            `🚫 Violation #${updated} → ${senderJid} | group:${groupJid} | reason:${hasLink ? "link" : hasPhone ? "phone" : apk ? "apk" : "business"}`
          );
          console.log(`📨 VisibleText: "${visibleText}"`);

          // Attempt silent delete
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
        // Catch any unexpected processing errors to avoid crashing message loop
        console.log("⚠️ Error processing message:", procErr.message);
      }
    });
  } catch (startupErr) {
    console.log("❌ Startup error:", startupErr.message);
    setTimeout(() => startBot().catch(() => {}), 10000);
  }
}

// Kick it off
console.log("🚀 Starting Anti-Link Bot (stable) using stored session...");
startBot().catch((e) => {
  console.log("❌ Fatal start error:", e.message);
});
