// =========================
// ANTI-LINK WHATSAPP BOT
// =========================

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const ADMIN_NUMBER = '254106090661';
const userViolations = new Map();

// --- ultra-quiet logger ---
const createSilentLogger = () => {
  const noop = () => {};
  return {
    level: 'silent',
    trace: noop, debug: noop, info: noop,
    warn: noop, error: noop, fatal: noop,
    child: () => createSilentLogger()
  };
};

// --- start connection ---
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`📱 WA v${version.join('.')}  Latest: ${isLatest}`);
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
    });

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open')
        console.log(`✅ BOT ONLINE – Admin ${ADMIN_NUMBER}`);
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log(`🔌 Closed: ${lastDisconnect?.error?.message || 'unknown'}`);
        if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
      }
    });

    // --- message handling ---
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        if (!message?.message || !message.key?.remoteJid?.includes('@g.us')) return;

        const groupJid = message.key.remoteJid;
        const sender = message.key.participant || message.key.remoteJid;

        // extract text safely
        const text = (
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          message.message.imageMessage?.caption ||
          message.message.videoMessage?.caption ||
          message.message.documentMessage?.caption ||
          ''
        ).trim();

        if (!text) return;

        const isAdmin = checkAdmin(sender, ADMIN_NUMBER);
        if (isAdmin) {
          if (text.toLowerCase() === '!bot')
            await sock.sendMessage(groupJid, {
              text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Online`
            });
          return;
        }

        if (text.toLowerCase() === '!bot') {
          await sock.sendMessage(groupJid, {
            text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Monitoring links`
          });
          return;
        }

        const hasLink = detectActualLinks(text);
        const isBusinessPost =
          message.message.productMessage !== undefined ||
          message.message.catalogMessage !== undefined;

        if (hasLink || isBusinessPost) {
          const key = `${groupJid}-${sender}`;
          const strikes = (userViolations.get(key) || 0) + 1;
          userViolations.set(key, strikes);

          await sock.sendMessage(groupJid, { delete: message.key });
          console.log(`🚫 ${sender} link violation #${strikes}`);

          if (strikes >= 3) {
            await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
            console.log(`❌ Removed ${sender}`);
            userViolations.delete(key);
          }
        }
      } catch (err) {
        console.log('⚠️ Message processing error:', err.message);
      }
    });

    sock.ev.on('creds.update', saveCreds);
  } catch (err) {
    console.log('❌ Setup error:', err.message);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// --- helpers ---

function checkAdmin(senderJid, adminNumber) {
  const s = senderJid.replace(/\D/g, '');
  const a = adminNumber.replace(/\D/g, '');
  return s === a || s.endsWith(a) || senderJid.includes(a);
}

// safer link detection – real URLs only
function detectActualLinks(text) {
  const regex = /\b((https?:\/\/|www\.)[^\s]+|[a-zA-Z0-9-]+\.(com|net|org|co|io|me|xyz|info|biz|in|us|uk)(\/[^\s]*)?)\b/i;
  return regex.test(text);
}

// --- boot ---
console.log('🚀 Starting Anti-Link Bot...');
connectToWhatsApp().catch((e) => {
  console.log('❌ Start failed:', e);
  setTimeout(connectToWhatsApp, 15000);
});
