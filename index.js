const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const fs = require('fs')
const path = require('path')

// ✅ Your admin number (don’t change unless your main WhatsApp number changes)
const ADMIN_NUMBER = "254106090661"
const userViolations = new Map()

// 🧹 Clean up broken key cache but keep credentials
const keyDir = path.join(__dirname, 'auth_info', 'signal')
if (fs.existsSync(keyDir)) {
  fs.rmSync(keyDir, { recursive: true, force: true })
  console.log('🧹 Cleared stale signal key cache')
}

// silent logger
const createSilentLogger = () => {
  const noOp = () => {}
  return {
    level: 'silent',
    trace: noOp,
    debug: noOp,
    info: noOp,
    warn: noOp,
    error: noOp,
    fatal: noOp,
    child: () => createSilentLogger()
  }
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`📱 Using WA v${version.join('.')}, latest: ${isLatest}`)

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, createSilentLogger())
      },
      printQRInTerminal: false,
      logger: createSilentLogger(),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 1000,
      maxRetries: 3,
      connectTimeoutMs: 20000,
      keepAliveIntervalMs: 10000,
      msgRetryCounterCache: new Map(),
      getMessage: async () => undefined
    })

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (connection === 'open') {
        console.log('✅ BOT ONLINE - Anti-link protection ACTIVE')
        console.log(`👑 Admin: ${ADMIN_NUMBER}`)
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401
        console.log(`🔌 Connection closed: ${lastDisconnect?.error?.message || 'Unknown reason'}`)
        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 5 seconds...')
          setTimeout(connectToWhatsApp, 5000)
        }
      }

      if (qr) console.log('⚠️ QR received but using existing auth...')
    })

    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0]
        if (!message?.message || !message.key?.remoteJid?.includes('@g.us')) return

        const sender = message.key.participant || message.key.remoteJid
        const groupJid = message.key.remoteJid

        let text = ''
        try {
          text = (
            message.message.conversation ||
            message.message.extendedTextMessage?.text ||
            message.message.imageMessage?.caption ||
            message.message.videoMessage?.caption ||
            message.message.documentMessage?.caption ||
            ''
          ).trim()
        } catch {
          console.log('🔒 Could not extract message text (decryption issue)')
          return
        }

        const isAdmin = checkAdmin(sender, ADMIN_NUMBER)
        console.log(`📨 ${sender}: "${text}" | Admin: ${isAdmin}`)

        if (isAdmin) {
          if (text.toLowerCase().trim() === '!bot') {
            await sock.sendMessage(groupJid, {
              text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Online with admin privileges`
            })
          }
          return
        }

        if (text.toLowerCase().trim() === '!bot') {
          await sock.sendMessage(groupJid, {
            text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Monitoring for links`
          })
          return
        }

        if (!text) return

        const hasLink = detectActualLinks(text)
        const isBusinessPost =
          message.message.productMessage !== undefined ||
          message.message.catalogMessage !== undefined

        if (hasLink || isBusinessPost) {
          const userKey = `${groupJid}-${sender}`
          const violations = userViolations.get(userKey) || 0
          const newViolations = violations + 1
          userViolations.set(userKey, newViolations)

          await sock.sendMessage(groupJid, { delete: message.key })
          console.log(`🚫 Deleted message from ${sender}`)

          if (newViolations >= 3) {
            try {
              await sock.groupParticipantsUpdate(groupJid, [sender], 'remove')
              userViolations.delete(userKey)
              console.log(`❌ Removed ${sender} from group`)
            } catch (err) {
              console.log('❌ Could not remove user:', err.message)
            }
          }
        }
      } catch (err) {
        console.log('⚠️ Error processing message:', err.message)
      }
    })

    sock.ev.on('creds.update', saveCreds)
  } catch (err) {
    console.log('❌ Connection setup error:', err.message)
    setTimeout(connectToWhatsApp, 10000)
  }
}

function checkAdmin(senderJid, adminNumber) {
  const adminNum = adminNumber.replace(/\D/g, '')
  const fullAdmin = adminNum + '@s.whatsapp.net'
  const senderClean = senderJid.replace(/\D/g, '')

  const isAdmin =
    senderJid === fullAdmin ||
    senderClean === adminNum ||
    senderJid.includes(adminNum)

  console.log(`🔍 Admin check → Sender: ${senderJid}, Expected: ${fullAdmin}, Result: ${isAdmin}`)
  return isAdmin
}

function detectActualLinks(text) {
  const linkPatterns = [
    /https?:\/\/[^\s]+/g,
    /www\.[^\s]+/g,
    /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?/g
  ]
  return linkPatterns.some(pattern => text.match(pattern))
}

console.log('🚀 Starting Anti-Link Bot with stored auth...')
connectToWhatsApp().catch(err => {
  console.log('❌ Failed to start:', err)
  setTimeout(connectToWhatsApp, 15000)
})
