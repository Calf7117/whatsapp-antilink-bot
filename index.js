const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys")
const fs = require("fs")
const path = require("path")

// ✅ your admin number
const ADMIN_NUMBER = "254106090661"
const userViolations = new Map()

// 🧹 clear signal cache but keep creds
const keyDir = path.join(__dirname, "auth_info", "signal")
if (fs.existsSync(keyDir)) {
  fs.rmSync(keyDir, { recursive: true, force: true })
  console.log("🧹 Cleared stale signal key cache")
}

// detect actual links
function detectLinks(text) {
  const linkPatterns = [
    /https?:\/\/[^\s]+/g,
    /www\.[^\s]+/g,
    /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?/g,
  ]
  return linkPatterns.some((pattern) => text.match(pattern))
}

// check admin
function checkAdmin(senderJid) {
  const adminNum = ADMIN_NUMBER.replace(/\D/g, "")
  const senderNum = senderJid.replace(/\D/g, "")
  const isAdmin =
    senderJid.includes(adminNum) ||
    senderNum === adminNum ||
    senderJid === `${adminNum}@s.whatsapp.net`

  console.log(`🔍 Admin check: ${senderJid} | Admin: ${adminNum} | isAdmin=${isAdmin}`)
  return isAdmin
}

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
    } else if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || !msg.key.remoteJid || msg.key.fromMe) return

    const jid = msg.key.remoteJid
    const sender = msg.key.participant || msg.key.remoteJid
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      ""

    const isAdmin = checkAdmin(sender)

    // allow admin full control
    if (isAdmin) {
      if (text.trim().toLowerCase() === "!bot") {
        await sock.sendMessage(jid, {
          text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Online with admin privileges`,
        })
      }
      return
    }

    // for regular members only
    if (text.trim().toLowerCase() === "!bot") {
      await sock.sendMessage(jid, {
        text: `✅ Anti-Link Bot Active\nAdmin: ${ADMIN_NUMBER}\nStatus: Monitoring for links.`,
      })
      return
    }

    const hasLink = detectLinks(text)
    if (hasLink) {
      const userKey = `${jid}-${sender}`
      const count = userViolations.get(userKey) || 0
      const newCount = count + 1
      userViolations.set(userKey, newCount)

      console.log(`🚫 ${sender} link violation #${newCount}`)

      try {
        await sock.sendMessage(jid, {
          delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender },
        })
        if (newCount >= 3) {
          await sock.groupParticipantsUpdate(jid, [sender], "remove")
          userViolations.delete(userKey)
          console.log(`❌ ${sender} removed from group.`)
        }
      } catch (err) {
        console.log("⚠️ Error deleting/removing:", err.message)
      }
    }
  })
}

console.log("🚀 Starting Anti-Link Bot using stored session...")
startBot().catch((err) => {
  console.log("❌ Startup error:", err.message)
  setTimeout(startBot, 10000)
})
