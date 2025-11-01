const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

const ADMIN_NUMBER = "254106090661";
const userViolations = new Map();

// Create a proper no-op logger
const createSilentLogger = () => {
    const noOp = () => {};
    return {
        level: 'silent',
        trace: noOp,
        debug: noOp,
        info: noOp,
        warn: noOp,
        error: noOp,
        fatal: noOp,
        child: () => createSilentLogger()
    };
};

// Rate limiting to avoid "rate-overlimit" errors
const actionCooldown = new Map();
const canPerformAction = (key) => {
    const now = Date.now();
    const lastAction = actionCooldown.get(key);
    if (!lastAction || (now - lastAction) > 2000) { // 2 second cooldown
        actionCooldown.set(key, now);
        return true;
    }
    return false;
};

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: createSilentLogger(),
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log('✅ BOT ONLINE - Anti-link protection ACTIVE');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            console.log(`🔄 Connection closed. ${shouldReconnect ? 'Reconnecting...' : 'Authentication failed, please restart.'}`);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const message = m.messages[0];
            if (!message.message || !message.key.remoteJid.includes('@g.us')) return;

            // Extract text from different message types
            const text = (
                message.message.conversation ||
                message.message.extendedTextMessage?.text ||
                message.message.imageMessage?.caption ||
                message.message.videoMessage?.caption ||
                ''
            ).trim();

            const sender = message.key.participant || message.key.remoteJid;
            const groupJid = message.key.remoteJid;

            console.log(`📨 Message from ${sender}: ${text || '[Media/No text]'}`);

            // BOT STATUS COMMAND - FIXED
            if (text && text.toLowerCase() === '!bot') {
                console.log('🤖 Bot status command received');
                try {
                    await sock.sendMessage(groupJid, {
                        text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Protecting group from links and spam`
                    });
                    console.log('✅ Bot status sent');
                    return;
                } catch (error) {
                    console.log('❌ Error sending status:', error.message);
                }
            }

            // Skip empty messages and media without text
            if (!text) return;

            // ADMIN DETECTION
            const cleanNumber = (num) => num.replace(/\D/g, '').replace(/^0+/, '');
            const senderClean = cleanNumber(sender);
            const adminClean = cleanNumber(ADMIN_NUMBER);
            
            const isAdmin = 
                senderClean === adminClean ||
                senderClean === adminClean.replace('254', '0') ||
                sender.includes(ADMIN_NUMBER) ||
                sender.includes(adminClean);

            if (isAdmin) {
                console.log('👑 Admin message - skipping check');
                return;
            }

            // IMPROVED ANTI-LINK PROTECTION
            const linkPatterns = [
                /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/,
                /www\.[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/,
                /\.[a-z]{2,6}(\/|$)/,
                /(bit\.ly|tinyurl|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|adf\.ly|bitly|shorte|bc\.vc|cli\.gs|cutt\.us|u\.bb|yourls|qr\.net|v\.gd|tr\.im|link\.zip)/
            ];

            const hasLink = linkPatterns.some(pattern => pattern.test(text.toLowerCase()));
            
            const isBusinessPost = 
                message.message.productMessage !== undefined ||
                message.message.catalogMessage !== undefined ||
                message.message.orderMessage !== undefined;

            // ENFORCE RULES - WITH RATE LIMITING
            if ((hasLink || isBusinessPost)) {
                const userKey = `${groupJid}-${sender}`;
                const violations = userViolations.get(userKey) || 0;
                const newViolations = violations + 1;
                
                userViolations.set(userKey, newViolations);
                
                console.log(`🚫 Violation #${newViolations} from ${sender}`);
                console.log(`📝 Content: ${text}`);

                try {
                    // SILENT DELETE with rate limiting
                    const deleteKey = `delete-${groupJid}`;
                    if (canPerformAction(deleteKey)) {
                        await sock.sendMessage(groupJid, {
                            delete: message.key
                        });
                        console.log('✅ Message deleted silently');
                    } else {
                        console.log('⏳ Rate limited - skip delete');
                    }

                    // SILENT REMOVAL ON 3RD VIOLATION with rate limiting
                    if (newViolations >= 3) {
                        const removeKey = `remove-${groupJid}`;
                        if (canPerformAction(removeKey)) {
                            await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                            console.log('❌ User removed silently');
                            userViolations.delete(userKey);
                            
                            // Notify admin
                            try {
                                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', {
                                    text: `🚨 User removed from group\nUser: ${sender}\nGroup: ${groupJid}\nViolations: ${newViolations}`
                                });
                            } catch (notifyError) {
                                console.log('Note: Could not notify admin');
                            }
                        } else {
                            console.log('⏳ Rate limited - skip removal');
                        }
                    }
                } catch (error) {
                    console.log('❌ Error:', error.message);
                    if (error.message.includes('rate-overlimit')) {
                        console.log('💤 Rate limit hit, waiting...');
                        // Wait 5 seconds before next action
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }
        } catch (error) {
            console.log('❌ General error in message handler:', error.message);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Start bot with error handling
console.log('🚀 Starting Anti-Link Bot...');
connectToWhatsApp().catch(error => {
    console.log('❌ Failed to start bot:', error);
    setTimeout(connectToWhatsApp, 10000); // Restart after 10 seconds
});
