// index.js - Anti-Link Bot (CommonJS)
// Aggressive mode: delete all links/business/apk/phone numbers except AUTHORIZED admin number
// Allows !bot for the AUTHORIZED admin and for other group admins

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
const ADMIN_NUMBER = "254106090661"; // only this number is exempt from deletion (owner)
const AUTH_DEBUG_LOG_ADMIN_JID = false; // set true to print the owner's exact seen JID once for debugging
// ----------------------------

const userViolations = new Map();

// clear stale signal cache but keep creds
const keyDir = path.join(__dirname, "auth_info", "signal");
if (fs.existsSync(keyDir)) {
  try {
    fs.rmSync(keyDir, { recursive: true, force: true });
    console.log("🧹 Cleared stale signal key cache");
  } catch (e) {
    console.log("⚠️ Could not clear signal cache:", e.message);
  }
}

// Aggressive link regex (covers http(s), www, short domains, domain.tld/path, etc.)
const LINK_REGEX = /\b(?:https?:\/\/|www\.)\S+|\b[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/\S*)?\b/i;

// Phone number regex: any sequence of 9 or more digits (word boundary)
const PHONE_REGEX = /\b\d{9,}\b/;

// APK detection regex (in text/links)
const APK_REGEX = /\.apk\b/i;

// Helper: strictly check whether a sender matches the configured ADMIN_NUMBER in common JID formats
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
  const match =
    senderNum === adminNum ||
    possibleForms.includes(senderJid) ||
    senderJid.includes(adminNum);
  return match;
}

// Helper: check if sender is a group admin (super admin or admin) by fetching metadata
async function isGroupAdmin(sock, groupJid, senderJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    if (!meta || !Array.isArray(meta.participants)) return false;
    const part = meta.participants.find((p) => {
      // participant id might be '254701234567@s.whatsapp.net'
      return p.id === senderJid || p.id === senderJid.replace(/\D/g, "") + "@s.whatsapp.net";
    });
    if (!part) return false;
    return Boolean(part.isAdmin || part.isSuperAdmin);
  } catch (e) {
    // on error, assume false (safe default)
    return false;
  }
}

// Unified violation checker: checks message object for any violating content
function analyzeMessageForViolation(msg) {
  // msg is the raw message object from Baileys
  let text = "";
  try {
    text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      "";
  } catch {
    text = "";
  }

  // business/catalog messages
  if (msg.message.productMessage !== undefined || msg.message.catalogMessage !== undefined) {
    return { reason: "business_message", detail: "product/catalog message" };
  }

  // documents: check filename or mimetype for APK
  if (msg.message.documentMessage) {
    const doc = msg.message.documentMessage;
    const fileName = doc.fileName || "";
    const mime = doc.mimetype || "";
    // APK by name or by Android package mimetype
    if (APK_REGEX.test(fileName) || /application\/vnd\.android\.package-archive/i.test(mime)) {
      return { reason: "apk", detail: "document.apk" };
    }
  }

  // check text for APK (link or caption)
  if (APK_REGEX.test(text)) {
    return { reason: "apk", detail: ".apk in text/link" };
  }

  // check phone numbers (9+ digits)
  if (PHONE_REGEX.test(text)) {
    return { reason: "phone", detail: "9+ digit sequence" };
  }

  // check links aggressively
  if (LINK_REGEX.test(text)) {
    return { reason: "link", detail: "detected link pattern" };
  }

  // also check if a message contains a document/url field with externalUrl / url in some message types
  // e.g., sticker with url? Not all libs populate the same fields; check common ones defensively
  try {
    // documentMessage?.fileName already checked; also check any 'url' or 'externalAdReply' preview
    const ext = msg.message.extendedTextMessage?.contextInfo?.externalAdReply;
    if (ext && (ext.title || ext.mediaUrl || ext.sourceUrl)) {
      // treat as link/business
      return { reason: "link", detail: "externalAdReply" };
    }
  } catch {}

  return null; // no violation detected
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    version,
  });

  sock.ev.on("creds.update", saveCreds);

  // log online/offline
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      console.log("✅ BOT ONLINE - Anti-Link Protection Active");
      console.log(`👑 Owner (exempt): ${ADMIN_NUMBER}`);
    } else if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("🔌 Connection closed:", lastDisconnect?.error?.message || "unknown");
      if (shouldReconnect) {
        setTimeout(() => startBot().catch(() => {}), 5000);
      }
    }
  });

  // one-time debug print: exact JID as seen for owner (helps tune matching). Controlled by flag.
  let ownerJidLogged = false;

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg) return;
      if (!msg.message || !msg.key?.remoteJid) return;
      if (msg.key.fromMe) return; // ignore messages from the bot itself
      if (!msg.key.remoteJid.includes("@g.us")) return; // only handle group messages

      const groupJid = msg.key.remoteJid;
      const senderJid = msg.key.participant || msg.key.remoteJid; // participant present in groups

      // optional debug: log exact sender JID once if it's owner
      if (AUTH_DEBUG_LOG_ADMIN_JID && !ownerJidLogged && isOwnerJidMatch(senderJid)) {
        console.log("🔎 Seen owner JID as:", senderJid);
        ownerJidLogged = true;
      }

      // Determine roles for !bot handling
      const ownerIsSender = isOwnerJidMatch(senderJid);
      const senderIsGroupAdmin = await isGroupAdmin(sock, groupJid, senderJid).catch(() => false);

      // Extract text safely for command check
      let text = "";
      try {
        text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption ||
          "";
      } catch {
        text = "";
      }
      const textTrim = (text || "").trim();

      // !bot handling:
      // Owner (ADMIN_NUMBER) gets admin-style response.
      // Other group admins get admin-ish response.
      // Regular users get monitoring message.
      if (textTrim.toLowerCase() === "!bot") {
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
              text: `✅ ANTI-LINK BOT ACTIVE\nStatus: Monitoring for links`,
            });
          }
        } catch (e) {
          console.log("⚠️ Could not send !bot reply:", e.message);
        }
        return; // don't enforce deletion on the !bot message itself
      }

      // Now check for violations (links, phone numbers, apk, business/catalog)
      const violation = analyzeMessageForViolation(msg);
      if (!violation) return; // nothing to do

      // If sender is the owner (ADMIN_NUMBER), exempt them fully (no delete, no strike)
      if (ownerIsSender) {
        // Owner is exempt from enforcement. No action.
        return;
      }

      // Otherwise enforce: delete message silently, increment strike, remove on 3rd strike
      const userKey = `${groupJid}-${senderJid}`;
      const current = userViolations.get(userKey) || 0;
      const updated = current + 1;
      userViolations.set(userKey, updated);

      console.log(
        `🚫 Violation #${updated} → ${senderJid} | group:${groupJid} | reason:${violation.reason} (${violation.detail})`
      );

      try {
        // Silent delete
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
