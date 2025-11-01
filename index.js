const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

const ADMIN_NUMBER = "254106090661"; // Your number

// Track violations per user
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

        const text = message.message.conversation || 
                    message.message.extendedTextMessage?.text || '';
        const sender = message.key.participant || message.key.remoteJid;
        const groupJid = message.key.remoteJid;

        console.log(`📨 Message from ${sender}: ${text}`);

        // 🟢 BOT STATUS COMMAND - FIXED
        if (text.trim().toLowerCase() === '!bot') {
            try {
                await sock.sendMessage(groupJid, {
                    text: `✅ ANTI-LINK BOT IS ONLINE\n🔒 Protecting this group from spam links & business posts\n👑 Admin: ${ADMIN_NUMBER}`
                });
                console.log('✅ Bot status responded');
            } catch (error) {
                console.log('Error sending status:', error.message);
            }
            return;
        }

        // 🔴 ANTI-LINK PROTECTION - FIXED ADMIN DETECTION
        // Extract just the numbers from the sender JID for comparison
        const senderNumber = sender.replace(/@.*$/, '').replace(/\D/g, '');
        const isAdmin = senderNumber === ADMIN_NUMBER.replace(/\D/g, '');

        console.log(`👤 Sender: ${senderNumber}, Admin: ${isAdmin}`);

        const hasLink = text.includes('http://') || text.includes('https://') || 
                       text.includes('.com') || text.includes('.org') || 
                       text.includes('.net') || text.includes('.ke/');
        
        const isBusinessPost = message.message.productMessage !== undefined ||
                              message.message.catalogMessage !== undefined;

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

                // 🚨 PROGRESSIVE PUNISHMENT
                if (newViolations >= 3) {
                    await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                    console.log('❌ User removed from group');
                    userViolations.delete(userKey);
                }
            } catch (error) {
                console.log('❌ Error:', error.message);
            }
        } else if ((hasLink || isBusinessPost) && isAdmin) {
            console.log('✅ Admin link allowed');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Start bot
console.log('🚀 Starting Anti-Link Bot...');
connectToWhatsApp();
