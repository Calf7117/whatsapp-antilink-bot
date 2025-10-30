const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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
        try {
            const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
            
            // FIXED: Remove logger to avoid the "logger.child" error
            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: true
                // Removed the logger that was causing the error
            });

            this.sock.ev.on('connection.update', (update) => {
                const { connection, qr } = update;
                
                if (qr) {
                    console.log('\n📱 ===== WHATSAPP QR CODE =====');
                    console.log('📱 SCAN WITH YOUR WHATSAPP APP:');
                    
                    qrcode.generate(qr, { small: false });
                    
                    console.log(`\n🔗 QR Code Data (for manual generators):`);
                    console.log(qr);
                    console.log('📱 ===== END QR CODE =====\n');
                }
                
                if (connection === 'open') {
                    console.log('✅ Connected! Anti-link protection active.');
                    console.log('👑 You are the admin:', this.admin);
                }
                
                if (connection === 'close') {
                    console.log('❌ Connection closed. Restarting...');
                    setTimeout(() => this.init(), 5000);
                }
            });

            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('messages.upsert', this.handleMessage.bind(this));

        } catch (error) {
            console.error('❌ Init Error:', error.message);
            setTimeout(() => this.init(), 10000);
        }
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

            let messageText = '';
            if (message.message.conversation) {
                messageText = message.message.conversation;
            } else if (message.message.extendedTextMessage?.text) {
                messageText = message.message.extendedTextMessage.text;
            }

            if (this.containsLink(messageText) && !this.isAdmin(userJid)) {
                await this.handleLinkViolation(jid, userJid, message);
            }

        } catch (error) {
            // Silent error handling
        }
    }

    containsLink(text) {
        if (!text) return false;
        return /https?:\/\/[^\s]+/g.test(text);
    }

    async handleLinkViolation(chatJid, userJid, message) {
        try {
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

        } catch (error) {
            // Silent error handling
        }
    }
}

new AntiLinkBot();
