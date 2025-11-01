const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

const ADMIN_NUMBER = "254106090661";
const userViolations = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        // ALTERNATIVE LOGGER CONFIGURATION
        logger: {
            level: 'fatal',
            child: () => ({
                level: 'fatal',
                trace: () => {},
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {},
                fatal: () => {}
            })
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        
        if (connection === 'open') {
            console.log('✅ BOT ONLINE - Anti-link protection ACTIVE');
        }
        
        if (connection === 'close') {
            console.log('🔄 Restarting...');
            setTimeout(connectToWhatsApp, 5000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || !message.key.remoteJid.includes('@g.us')) return;

        const text = message.message.conversation || 
                    message.message.extendedTextMessage?.text || 
                    message.message.imageMessage?.caption ||
                    '';
        const sender = message.key.participant || message.key.remoteJid;
        const groupJid = message.key.remoteJid;

        console.log(`📨 Message from ${sender}: ${text}`);

        // BOT STATUS COMMAND
        const cleanText = text.trim().toLowerCase();
        if (cleanText === '!bot') {
            try {
                await sock.sendMessage(groupJid, {
                    text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}`
                });
                return;
            } catch (error) {
                console.log('Error sending status:', error.message);
            }
        }

        // ADMIN DETECTION
        const cleanNumber = (num) => num.replace(/\D/g, '').replace(/^0+/, '');
        const senderClean = cleanNumber(sender);
        const adminClean = cleanNumber(ADMIN_NUMBER);
        
        const isAdmin = 
            senderClean === adminClean ||
            senderClean === adminClean.replace('254', '0') ||
            sender.includes(ADMIN_NUMBER) ||
            sender.includes(adminClean);

        // ANTI-LINK PROTECTION
        const hasLink = /https?:\/\//.test(text) || 
                       /\.(com|org|net|ke|co|uk|info|biz)\//.test(text) ||
                       text.includes('.com') || text.includes('.org') || 
                       text.includes('.net') || text.includes('.ke/');
        
        const isBusinessPost = message.message.productMessage !== undefined ||
                              message.message.catalogMessage !== undefined;

        // ENFORCE RULES - SILENT MODE
        if ((hasLink || isBusinessPost) && !isAdmin) {
            const userKey = `${groupJid}-${sender}`;
            const violations = userViolations.get(userKey) || 0;
            const newViolations = violations + 1;
            
            userViolations.set(userKey, newViolations);
            
            console.log(`🚫 Violation #${newViolations} from ${sender}`);

            try {
                // SILENT DELETE - NO WARNING
                await sock.sendMessage(groupJid, {
                    delete: message.key
                });
                console.log('✅ Message deleted silently');

                // SILENT REMOVAL ON 3RD VIOLATION
                if (newViolations >= 3) {
                    await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                    console.log('❌ User removed silently');
                    userViolations.delete(userKey);
                }
            } catch (error) {
                console.log('❌ Error:', error.message);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Start bot
console.log('🚀 Starting Anti-Link Bot...');
connectToWhatsApp();
