const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

const ADMIN_NUMBER = "254106090661"; // Your number confirmed from previous code
const userViolations = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: { level: 'error' }
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

        // Extract message text from all possible sources
        const text = message.message.conversation || 
                    message.message.extendedTextMessage?.text || 
                    message.message.imageMessage?.caption ||
                    '';
        const sender = message.key.participant || message.key.remoteJid;
        const groupJid = message.key.remoteJid;

        console.log(`📨 Message from ${sender}: ${text}`);

        // 🔧 IMPROVED ADMIN DETECTION
        const cleanNumber = (num) => num.replace(/\D/g, '').replace(/^0+/, '');
        const senderClean = cleanNumber(sender);
        const adminClean = cleanNumber(ADMIN_NUMBER);
        
        // Multiple format support for admin detection
        const isAdmin = 
            senderClean === adminClean ||
            senderClean === adminClean.replace('254', '0') || // Kenyan local format
            sender.includes(ADMIN_NUMBER) ||
            sender.includes(adminClean);

        console.log(`👑 Admin check: ${senderClean} vs ${adminClean} = ${isAdmin}`);

        // 🟢 BOT STATUS COMMAND - IMPROVED
        const cleanText = text.trim().toLowerCase();
        if (cleanText === '!bot') {
            try {
                await sock.sendMessage(groupJid, {
                    text: `🤖 ANTI-LINK BOT STATUS:\n✅ ONLINE & PROTECTING\n👑 Admin: ${ADMIN_NUMBER}\n🔒 Blocking: Links & Business Posts\n🚫 Rules: 3 violations = removal`
                });
                console.log('✅ Bot status responded');
                return; // Important: stop processing after command
            } catch (error) {
                console.log('Error sending status:', error.message);
            }
        }

        // 🔴 ANTI-LINK PROTECTION - PRESERVED ALL FUNCTIONS
        const hasLink = /https?:\/\//.test(text) || 
                       /\.(com|org|net|ke|co|uk|info|biz)\//.test(text) ||
                       text.includes('.com') || text.includes('.org') || 
                       text.includes('.net') || text.includes('.ke/');
        
        const isBusinessPost = message.message.productMessage !== undefined ||
                              message.message.catalogMessage !== undefined;

        console.log(`🔍 Link check: ${hasLink}, Business: ${isBusinessPost}, Admin: ${isAdmin}`);

        // 🚨 ENFORCE RULES (skip if admin)
        if ((hasLink || isBusinessPost) && !isAdmin) {
            const userKey = `${groupJid}-${sender}`;
            const violations = userViolations.get(userKey) || 0;
            const newViolations = violations + 1;
            
            userViolations.set(userKey, newViolations);
            
            console.log(`🚫 ${isBusinessPost ? 'BUSINESS POST' : 'LINK'} violation #${newViolations} from ${sender}`);

            try {
                // 🗑️ DELETE MESSAGE FOR EVERYONE
                await sock.sendMessage(groupJid, {
                    delete: message.key
                });
                console.log('✅ Message deleted');

                // ⚠️ WARN USER ON FIRST VIOLATION
                if (newViolations === 1) {
                    await sock.sendMessage(groupJid, {
                        text: `⚠️ @${sender.split('@')[0]} - Links/business posts are not allowed! (Warning ${newViolations}/3)`,
                        mentions: [sender]
                    });
                }

                // 🚨 PROGRESSIVE PUNISHMENT
                if (newViolations >= 3) {
                    await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                    await sock.sendMessage(groupJid, {
                        text: `❌ @${sender.split('@')[0]} removed from group due to repeated violations.`,
                        mentions: [sender]
                    });
                    console.log('❌ User removed from group');
                    userViolations.delete(userKey);
                }
            } catch (error) {
                console.log('❌ Error:', error.message);
            }
        } else if ((hasLink || isBusinessPost) && isAdmin) {
            console.log('✅ Admin link allowed - no action taken');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Start bot
console.log('🚀 Starting Anti-Link Bot...');
console.log(`👑 Admin Number: ${ADMIN_NUMBER}`);
connectToWhatsApp();
