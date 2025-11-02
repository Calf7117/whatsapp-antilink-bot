const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion, 
  makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const path = require('path');

const ADMIN_NUMBER = "254106090661";
const userViolations = new Map();

// Silent logger
const createSilentLogger = () => {
  const noOp = () => {};
  return { level: 'silent', trace: noOp, debug: noOp, info: noOp, warn: noOp, error: noOp, fatal: noOp, child: () => createSilentLogger() };
};

// 🧹 Purge broken cached signal keys but keep creds intact
const keyDir = path.join(__dirname, 'auth_info', 'signal');
if (fs.existsSync(keyDir)) {
  fs.rmSync(keyDir, { recursive: true, force: true });
  console.log('🧹 Cleared stale signal key cache');
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`📱 Using WA v${version.join('.')}, latest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, createSilentLogger()),
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
      getMessage: async () => undefined,
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'open') {
        console.log('✅ BOT ONLINE - Anti-link protection ACTIVE');
        console.log(`👑 Admin: ${ADMIN_NUMBER}`);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log(`🔌 Connection closed: ${lastDisconnect?.error?.message || 'Unknown reason'}`);
        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 5 seconds...');
          setTimeout(connectToWhatsApp, 5000);
        }
      }

      if (qr) {
        console.log('⚠️ QR received but using existing auth...');
      }
    });

    // Message handling
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        if (!message?.message || !message.key?.remoteJid?.includes('@g.us')) return;

        const sender = message.key.participant || message.key.remoteJid;
        const groupJid = message.key.remoteJid;

        let text = '';
        try {
          text = (
            message.message.conversation ||
            message.message.extendedTextMessage?.text ||
            message.message.imageMessage?.caption ||
            message.message.videoMessage?.caption ||
            message.message.documentMessage?.caption ||
            ''
          ).trim();
        } catch {
          console.log('🔒 Could not extract message text (decryption issue)');
          return;
        }

        console.log(`📨 Message from ${sender}: "${text}"`);

        const isAdmin = checkAdmin(sender, ADMIN_NUMBER);
        if (isAdmin) {
          console.log('👑 ADMIN MESSAGE - IGNORING CHECKS');

          if (text && text.toLowerCase().trim() === '!bot') {
            console.log('🤖 Bot status command from admin');
            try {
              await sock.sendMessage(groupJid, {
                text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Online with admin privileges`
              });
            } catch (error) {
              console.log('❌ Error sending bot status:', error.message);
            }
          }
          return;
        }

        if (text && text.toLowerCase().trim() === '!bot') {
          console.log('🤖 Bot status command from user');
          try {
            await sock.sendMessage(groupJid, {
              text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Monitoring for links`
            });
            return;
          } catch (error) {
            console.log('❌ Error sending status:', error.message);
          }
        }

        if (!text) return;

        const hasLink = detectActualLinks(text);
        const isBusinessPost = message.message.productMessage !== undefined || message.message.catalogMessage !== undefined;

        if (hasLink || isBusinessPost) {
          const userKey = `${groupJid}-${sender}`;
          const violations = userViolations.get(userKey) || 0;
          const newViolations = violations + 1;

          userViolations.set(userKey, newViolations);

          console.log(`🚫 Violation #${newViolations} from ${sender}`);
          console.log(`🔗 Content: ${text}`);

          try {
            await sock.sendMessage(groupJid, { delete: message.key });
            console.log('✅ Message deleted');

            if (newViolations >= 3) {
              try {
                await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                console.log('❌ User removed from group');
                userViolations.delete(userKey);
              } catch (removeError) {
                console.log('❌ Could not remove user:', removeError.message);
              }
            }
          } catch (error) {
            console.log('❌ Error during enforcement:', error.message);
          }
        }
      } catch (error) {
        console.log('⚠️ Error processing message (will continue):', error.message);
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.update', () => {});
    sock.ev.on('message-receipt.update', () => {});

  } catch (error) {
    console.log('❌ Connection setup error:', error.message);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// Admin check
function checkAdmin(senderJid, adminNumber) {
  const senderNum = senderJid.replace(/\D/g, '');
  const adminNum = adminNumber.replace(/\D/g, '');
  const isAdmin =
    senderNum === adminNum ||
    senderNum === adminNum.replace('254', '') ||
    senderJid.includes(adminNumber) ||
    senderJid.includes(adminNum);
  console.log(`🔍 Admin check - Sender: ${senderNum}, Admin: ${adminNum}, Result: ${isAdmin}`);
  return isAdmin;
}

// Link detection
function detectActualLinks(text) {
  const linkPatterns = [
    /https?:\/\/[^\s]+/g,
    /www\.[^\s]+/g,
    /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?/g
  ];
  const hasLink = linkPatterns.some(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      console.log(`🔗 Found links:`, matches);
      return true;
    }
    return false;
  });
  return hasLink;
}

// Start bot
console.log('🚀 Starting Anti-Link Bot with existing auth...');
connectToWhatsApp().catch(error => {
  console.log('❌ Failed to start:', error);
  setTimeout(connectToWhatsApp, 15000);
});
