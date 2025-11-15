const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys")

const fs = require("fs")
const path = require("path")

// Your admin number only
const ADMIN_NUMBER = "254106090661"

// Track violations
const userViolations = new Map()

// Clean signal cache (not creds)
const keyDir = path.join(__dirname, "auth_info", "signal")
if (fs.existsSync(keyDir)) {
  fs.rmSync(keyDir, { recursive: true, force: true })
  console.log("🧹 Cleared stale signal key cache")
}

// Detect URLs
function detectLinks(text) {
  const patterns = [
    /https?:\/\/[^\s]+/gi,
    /www\.[^\s]+/gi,
    /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?/gi,
  ]
  return patterns.some((p) => text.match(p))
}

// Phone numbers: strings of 9 digits or more
function detectPhoneNumbers(text) {
  return /\d{9,}/.test(text)
}

// Real APK file check by MIME type
function isAPKFile(msg) {
  return (
    msg.message?.documentMessage?.mimetype ===
    "application/vnd.android.package-archive"
  )
}

// **Correct Business Detection (No false positives)**
function isBusinessPost(msg) {
  const p = msg.message?.productMessage
  const c = msg.message?.catalogMessage

  if (!p && !c) return false

  if (p) {
    const prod = p.product || {}
    if (
      prod.productImage ||
      prod.title ||
      prod.description ||
      prod.currency ||
      prod.priceAmount1000
    ) {
      return true
    }
  }

  if (c) {
    const cat = c.catalog || {}
    if (cat.title || (cat.products && cat.products.length > 0)) {
      return true
    }
  }

  return false
}

// Check specific admin number + all group admins
function checkAdmin(senderJid, groupAdmins) {
  const pureSender = senderJid.replace(/\D/g, "")
  const pureAdmin = ADMIN_NUMBER.replace(/\D/g, "")

  if (pureSender === pureAdmin) return true
  if (groupAdmins.includes(senderJid)) return true

  return false
}

// Start bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    version,
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update

    if (connection === "open") {
      console.log("✅ BOT ONLINE - Anti-Link Protection Active")
      console.log(`👑 Admin: ${ADMIN_NUMBER}`)
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    }
  })

  // Core message handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || !msg.key.remoteJid || msg.key.fromMe) return

    const jid = msg.key.remoteJid
    const sender = msg.key.participant || msg.key.remoteJid

    // Extract text safely
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      ""

    // Fetch group metadata so we know admins
    let groupAdmins = []
    try {
      const meta = await sock.groupMetadata(jid)
      groupAdmins = meta.participants
        .filter((p) => p.admin === "admin" || p.admin === "superadmin")
        .map((p) => p.id)
    } catch (e) {}

    const isAdmin = checkAdmin(sender, groupAdmins)

    // Allow admin full control
    if (isAdmin) {
      if (text.trim().toLowerCase() === "!bot") {
        await sock.sendMessage(jid, {
          text: `✅ Anti-Link Bot Active\nAdmin: ${ADMIN_NUMBER}\nStatus: Running normally.`,
        })
      }
      return
    }

    // Normal users checking status
    if (text.trim().toLowerCase() === "!bot") {
      await sock.sendMessage(jid, {
        text: `🛡 Anti-Link Bot Active\nAdmin: ${ADMIN_NUMBER}\nMonitoring for violations.`,
      })
      return
    }

    // Final violation detection
    const hasLink = detectLinks(text)
    const hasPhone = detectPhoneNumbers(text)
    const business = isBusinessPost(msg)
    const apk = isAPKFile(msg)

    if (hasLink || hasPhone || business || apk) {
      const key = `${jid}-${sender}`
      const count = userViolations.get(key) || 0
      const newCount = count + 1
      userViolations.set(key, newCount)

      console.log(`🚫 Violation #${newCount} from ${sender}`)
      console.log(`Reason: ${hasLink ? "Link " : ""}${hasPhone ? "Phone " : ""}${business ? "Business " : ""}${apk ? "APK " : ""}`)
      console.log(`Text: "${text}"`)

      try {
        // Delete violating message
        await sock.sendMessage(jid, {
          delete: {
            remoteJid: jid,
            fromMe: false,
            id: msg.key.id,
            participant: sender,
          },
        })

        // Kick on 3rd violation
        if (newCount >= 3) {
          await sock.groupParticipantsUpdate(jid, [sender], "remove")
          userViolations.delete(key)
          console.log(`❌ ${sender} removed from group.`)
        }
      } catch (err) {
        console.log("⚠️ Enforcement error:", err.message)
      }
    }
  })
}

console.log("🚀 Starting Anti-Link Bot using stored session...")
startBot().catch((err) => {
  console.log("❌ Startup error:", err.message)
  setTimeout(startBot, 10000)
})
