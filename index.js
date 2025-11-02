import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys"
import fs from "fs"

const ADMIN_NUMBER = "254106090661" // your number without + sign

const linkRegex = /(https?:\/\/[^\s]+)/gi

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    version,
  })

  sock.ev.on("creds.update", saveCreds)

  const linkCount = {}

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || !msg.key.remoteJid || msg.key.fromMe) return

    const jid = msg.key.remoteJid
    const sender = msg.key.participant || msg.key.remoteJid
    const senderNumber = sender.replace(/\D/g, "")

    const isAdmin = senderNumber === ADMIN_NUMBER
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    // Admin check command
    if (text.trim().toLowerCase() === "!bot" && isAdmin) {
      await sock.sendMessage(jid, { text: "✅ Anti-Link Bot is active and watching quietly." })
      return
    }

    // Ignore messages from admin
    if (isAdmin) return

    // Check for link
    if (linkRegex.test(text)) {
      if (!linkCount[senderNumber]) linkCount[senderNumber] = 0
      linkCount[senderNumber]++

      try {
        // Delete message
        await sock.sendMessage(jid, {
          delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender },
        })

        if (linkCount[senderNumber] >= 3) {
          await sock.groupParticipantsUpdate(jid, [sender], "remove")
          linkCount[senderNumber] = 0
        }
      } catch (err) {
        console.log("Deletion/Removal Error:", err)
      }
    }
  })

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    } else if (connection === "open") {
      console.log("🟢 Bot connected and running.")
    }
  })
}

startBot()
