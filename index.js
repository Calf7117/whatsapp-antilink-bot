// index.js - Anti-Link Bot (CommonJS)
// Deletes links / APKs / phone numbers / business messages in groups
// 3-strike rule: delete 1st & 2nd, delete + remove user on 3rd (silent).
// Only ADMIN_NUMBER is exempt. Admins (including owner) can use !bot.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
const ADMIN_NUMBER = "254106090661"; // ONLY this number is exempt from enforcement
const AUTH_DEBUG_LOG_ADMIN_JID = false; // set true once to log the exact JID seen for owner
// ----------------------------

const userViolations = new Map();

// clear stale signal cache but keep creds (helps avoid Bad MAC / decryption errors)
const keyDir = path.join(__dirname, "auth_info", "signal");
if (fs.existsSync(keyDir)) {
  try {
    fs.rmSync(keyDir, { recursive: true, force: true });
    console.log("🧹 Cleared stale signal key cache");
  } catch (e) {
    console.log("⚠️ Could not clear signal cache:", e.message);
  }
}

// Aggressive link regex: http(s), www, short domains, bare domain.tld/path
const LINK_REGEX = /\b(?:https?:\/\/|www\.)\S+|\b[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/\S*)?\b/i;

// Phone number regex to detect sequences of 9+ digits inside visible text
const PHONE_DIGIT_SEQUENCE = /\d{9,}/g;

// APK detection
const APK_REGEX = /\.apk\b/i;

// Helper: match owner/admin number robustly across JID formats
function isOwnerJidMatch(senderJid) {
  if (!senderJid) return false;
  const adminNum = ADMIN_NUMBER.replace(/\D/g, "");
  const senderNum = senderJid.replace(/\D/g, "");
  const possibleForms = [
    `${adminNum}@s.whatsapp.net`,
    `${adminNum}@whatsapp.net`,
    `${adminNum}@c.us`,
    `${adminNum}@g.us`,
    adminNum,
    `+${adminNum}`,
  ];
  return senderNum === adminNum || possibleForms.includes(senderJid) || senderJid.includes(adminNum);
}

// Helper: check if a sender is admin of the group (to let other admins use !bot)
async function isGroupAdmin(sock, groupJid, senderJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    if (!meta || !Array.isArray(meta.participants)) return false;
    const part = meta.participants.find(
      (p) => p.id === senderJid || p.id === senderJid.replace(/\D/g, "") + "@s.whatsapp.net"
    );
    if (!part) return false;
    return Boolean(part.isAdmin || part.isSuperAdmin);
  } catch {
    return false;
  }
}

// Extract visible user text safely (only from conversation/extendedText/caption fields)
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

// Analyze a message for violation based on visible text and specific message types
function analyzeMessageForViolation(msg) {
  if (!msg.message) return null;

  // Business/catalog payloads (productMessage/catalogMessage)
  if (msg.message.productMessage !== undefined || msg.message.catalogMessage !== undefined) {
    return { reason: "business_message", detail: "product/catalog message" };
  }

  // Documents: check filename and mimetype for APK
  if (msg.message.documentMessage) {
    const doc = msg.message.documentMessage;
    const fileName = doc.fileName || "";
    const mime = doc.mimetype || "";
    if (APK_REGEX.test(fileName) || /application\/vnd\.android\.package-archive/i.test(mime)) {
      return { reason: "apk", detail: "document.apk" };
    }
  }

  // Visible text checks (phone numbers, text-based APK, links)
  const visibleText = extractVisibleText(msg);

  if (!visibleText) {
    // without visible text, and no product/doc-apk above, nothing to enforce
    return null;
  }

  // Detect .apk in visible text or links
  if (APK_REGEX.test(visibleText)) {
    return { reason: "apk", detail: ".apk in text/link" };
  }

  // Detect phone numbers only in visible text (9+ digits)
  const phoneMatches = visibleText.match(PHONE_DIGIT_SEQUENCE);
  if (phoneMatches && phoneMatches.length > 0) {
    return { reason: "phone", detail: "9+ digit sequence in visible text" };
  }

  // Aggressive link detection on visible text
  if (LINK_REGEX.test(visibleText)) {
    return { reason: "link", detail: "detected link pattern in visible text" };
  }

  // Also check contextInfo.externalAdReply (preview-like external links)
  try {
    const ext = msg.message.extendedTextMessage?.contextInfo?.externalAdReply;
    if (ext && (ext.title || ext.mediaUrl || ext.sourceUrl)) {
      return { reason: "link", detail: "externalAdReply preview" };
    }
  } catch {
    // ignore
  }

  return null;
}

async function startBot() {
  // This preserves session reuse in the "auth_info" directory:
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    printQRInTerminal: true, // you only scan once; afterward "auth_info" is reused
    auth: state,
    version,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Scan this QR code with WhatsApp to log in.");
    }

    if (connection === "open") {
      console.log("✅ BOT ONLINE - Anti-Link Protection Active");
      console.log(`👑 Owner (exempt): ${ADMIN_NUMBER}`);
    } else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("🔌 Connection closed:", lastDisconnect?.error?.message || "unknown");

      if (shouldReconnect) {
        console.log("♻️ Reconnecting in 5 seconds...");
        setTimeout(() => startBot().catch(() => {}), 5000);
      } else {
        console.log("🚪 Logged out. Delete auth_info folder if you want a fresh login.");
      }
    }
  });

  let ownerJidLogged = false;

  sock.ev.on("messages.upsert", async (m) => {
    try {
      if (!m.messages || !m.messages[0]) return;

      const msg = m.messages[0];

      // Basic guards
      if (!msg.message || !msg.key || !msg.key.remoteJid) return;
      if (msg.key.fromMe) return; // ignore bot's own messages

      const groupJid = msg.key.remoteJid;
      if (!groupJid.endsWith("@g.us")) return; // only groups

      const senderJid = msg.key.participant || msg.key.remoteJid;

      // Optional debug: log exact owner JID once
      if (AUTH_DEBUG_LOG_ADMIN_JID && !ownerJidLogged && isOwnerJidMatch(senderJid)) {
        console.log("🔎 Seen owner JID as:", senderJid);
        ownerJidLogged = true;
      }

      const ownerIsSender = isOwnerJidMatch(senderJid);
      const senderIsGroupAdmin = await isGroupAdmin(sock, groupJid, senderJid).catch(() => false);

      // Visible text for commands and content checks
      const visibleText = extractVisibleText(msg).trim();
      const textLower = visibleText.toLowerCase();

      // Handle !bot command first, and never delete that message
      if (textLower === "!bot") {
        try {
          if (ownerIsSender) {
            await sock.sendMessage(groupJid, {
              text: `✅ ANTI-LINK BOT ACTIVE\nOwner (exempt): ${ADMIN_NUMBER}\nStatus: Online (owner privileges)`,
            });
          } else if (senderIsGroupAdmin) {
            await sock.sendMessage(groupJid, {
              text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Online (group admin)`,
            });
          } else {
            await sock.sendMessage(groupJid, {
              text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Monitoring for links, APKs, phone numbers & business messages`,
            });
          }
        } catch (e) {
          console.log("⚠️ Could not send !bot reply:", e.message);
        }
        return; // IMPORTANT: don't process this further (no deletion)
      }

      // Now analyze for violations
      const violation = analyzeMessageForViolation(msg);
      if (!violation) {
        // No link/apk/phone/business found -> do nothing
        return;
      }

      // Owner is always exempt from enforcement
      if (ownerIsSender) {
        return;
      }

      // Strike tracking per user per group
      const userKey = `${groupJid}-${senderJid}`;
      const current = userViolations.get(userKey) || 0;
      const updated = current + 1;
      userViolations.set(userKey, updated);

      console.log(
        `🚫 Violation #${updated} → ${senderJid} | group:${groupJid} | reason:${violation.reason} (${violation.detail})`
      );

      // Silent delete of THIS exact message
      try {
        await sock.sendMessage(groupJid, {
          delete: {
            remoteJid: groupJid,
            id: msg.key.id,
            fromMe: false,
            // participant is required when deleting messages from groups that are not sent by the bot
            participant: senderJid,
          },
        });
      } catch (delErr) {
        console.log("⚠️ Delete failed:", delErr.message);
      }

      // Remove user on 3rd strike
      if (updated >= 3) {
        try {
          await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
          userViolations.delete(userKey);
          console.log(`❌ Removed ${senderJid} from ${groupJid} after ${updated} violations`);
        } catch (remErr) {
          console.log("⚠️ Could not remove user:", remErr.message);
        }
      }
    } catch (err) {
      console.log("⚠️ Error processing message:", err.message);
    }
  });
}

// start
console.log("🚀 Starting Anti-Link Bot (aggressive mode) using stored session...");
startBot().catch((e) => {
  console.log("❌ Startup error:", e.message);
  setTimeout(() => startBot().catch(() => {}), 10000);
});
