const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys")

const fs = require("fs")
const path = require("path")

// Protected admin number
const ADMIN_NUMBER = "254106090661"

// Track violations
const userViolations = new Map()

// Clean signal cache
const signalDir = path.join(__dirname, "auth_info", "signal")
if (fs.existsSync(signalDir)) {
  fs.rmSync(signalDir, { recursive: true, force: true })
  console.log("🧹 Cleared expired signal keys")
}

// ---------------------------------------------
//               DETECTION RULES
// ---------------------------------------------

// Detect real URLs only
function detectLinks(text) {
  if (!text) return false

  const patterns = [
    /https?:\/\/[^\s]+/gi,
    /www\.[^\s]+/gi,
    /\b([a-zA-Z0-9-]+\.)+[a-z]{2,}\b/gi,
  ]

  return patterns.some((reg) => reg.test(text))
}

// Detect phone numbers 9+ digits
function detectPhoneNumbers(text) {
  if (!text) return false
  return /\d{9,}/.test(text)
}

// Detect real business messages
function isBusinessPost(msg) {
  return (
    msg.message?.productMessage !== undefined ||
    msg.message?.catalogMessage !== undefined
  )
}

// Detect real APK files ONLY
function isAPKFile(msg) {
  return (
    msg.message?.documentMessage?.mimetype ===
    "application/vnd.android.package-archive"
  )
}

// Protected admin check
function isAdmin(senderJid) {
  const senderNum = senderJid.replace(/\D/g, "")
  const adminNum = ADMIN_NUMBER.replace(/\D/g, "")
  return senderNum.endsWith(adminNum)
}

// ---------------------------------------------
//              START BOT
// ---------------------------------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    version,
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log("✅ BOT ONLINE")
      console.log(`👑 Protected Admin: ${ADMIN_NUMBER}`)
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    }
  })

  // ---------------------------------------------
  //              MESSAGE HANDLING
  // ---------------------------------------------
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || !msg.key.remoteJid) return

    const groupJid = msg.key.remoteJid
    const sender = msg.key.participant || msg.key.remoteJid

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      ""

    const admin = isAdmin(sender)

    // --- BOT STATUS COMMAND ---
    if (text.trim().toLowerCase() === "!bot") {
      const reply = admin
        ? `✅ Anti-Link Bot Active\nProtected Admin: ${ADMIN_NUMBER}\nStatus: Full privileges enabled.`
        : `✅ Anti-Link Bot Active\nProtected Admin: ${ADMIN_NUMBER}\nStatus: Monitoring messages.`

      await sock.sendMessage(groupJid, { text: reply })
      return
    }

    // Skip ALL protection rules for YOU
    if (admin) return

    // --- DETECT VIOLATIONS ---
    const hasLink = detectLinks(text)
    const hasPhone = detectPhoneNumbers(text)
    const business = isBusinessPost(msg)
    const hasAPK = isAPKFile(msg)

    if (hasLink || hasPhone || business || hasAPK) {
      const key = `${groupJid}-${sender}`
      const count = userViolations.get(key) || 0
      const newCount = count + 1
      userViolations.set(key, newCount)

      console.log(`🚫 Violation #${newCount} by ${sender}`)
      console.log(
        `🔍 Reason: ${
          hasLink
            ? "Link"
            : hasPhone
            ? "Phone Number"
            : hasAPK
            ? "APK File"
            : "Business Post"
        }`
      )
      console.log(`📨 Text: ${text}`)

      // Delete message
      try {
        await sock.sendMessage(groupJid, {
          delete: {
            remoteJid: groupJid,
            id: msg.key.id,
            participant: sender,
            fromMe: false,
          },
        })
      } catch (err) {
        console.log("⚠️ Delete error:", err.message)
      }

      // Kick after 3 violations
      if (newCount >= 3) {
        try {
          await sock.groupParticipantsUpdate(groupJid, [sender], "remove")
          console.log(`❌ Removed ${sender} from group`)
          userViolations.delete(key)
        } catch (err) {
          console.log("⚠️ Kick error:", err.message)
        }
      }
    }
  })
}

console.log("🚀 Starting bot using saved session...")
startBot().catch((err) => {
  console.log("❌ Startup Error:", err.message)
  setTimeout(startBot, 5000)
})
