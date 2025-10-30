const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

console.log('🚀 Starting WhatsApp Anti-Link Bot...');

class AntiLinkBot {
    constructor() {
        this.userWarnings = new Map();
        this.admin = '254106090661@s.whatsapp.net';
        console.log('👑 Admin pre-set to:', this.admin);
        this.init();
    }

    async init() {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: true
        });

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n📱 ===== WHATSAPP QR CODE =====');
                qrcode.generate(qr, { small: false });
                console.log('\n📱 Scan QR Code in your WhatsApp app\n');
            }

            if (connection === 'open') {
                console.log('✅ Connected successfully!');
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Disconnected. Reason:', reason);

                // Only restart if not logged out or bad auth
                if (reason !== DisconnectReason.loggedOut) {
                    console.log('🔄 Reconnecting in 10s...');
                    setTimeout(() => this.init(), 10000);
                } else {
                    console.log('🧹 Logged out. Delete ./auth_info folder and restart to rescan QR.');
                }
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', this.handleMessage.bind(this));
    }

    isAdmin(userJid) {
        const cleanUser = userJid.replace(/[^0-9]/g, '');
        const cleanAdmin = this.admin.replace(/[^0-9]/g, '');
        return cleanUser.includes(cleanAdmin);
    }

    async handleMessage(m) {
        try {
            const message = m.messages[0];
            if (!message.message || message.key.fromMe) return;

            const jid = message.key.remoteJid;
            const userJid = message.key.participant || message.key.remoteJid;
            if (!jid.endsWith('@g.us')) return;

            let text = message.message.conversation || message.message?.extendedTextMessage?.text || '';

            if (this.containsLink(text) && !this.isAdmin(userJid)) {
                await this.handleLinkViolation(jid, userJid, message);
            }
        } catch { /* ignore */ }
    }

    containsLink(text) {
        return /https?:\/\/[^\s]+/i.test(text);
    }

    async handleLinkViolation(chatJid, userJid, message) {
        const warnings = this.userWarnings.get(userJid) || 0;
        const newWarnings = warnings + 1;
        this.userWarnings.set(userJid, newWarnings);

        await this.sock.sendMessage(chatJid, { delete: message.key });
        await this.sock.sendMessage(chatJid, {
            text: `⚠️ LINK BLOCKED\nUser: @${userJid.split('@')[0]}\nWarning: ${newWarnings}/3\nOnly admin can send links.`,
            mentions: [userJid]
        });

        if (newWarnings >= 3) {
            await this.sock.groupParticipantsUpdate(chatJid, [userJid], 'remove');
            this.userWarnings.delete(userJid);
        }
    }
}

new AntiLinkBot();
