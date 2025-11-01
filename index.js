const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

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

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: createSilentLogger(),
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            // Add these to help with decryption issues
            retryRequestDelayMs: 1000,
            maxRetries: 5,
            connectTimeoutMs: 30000,
            keepAliveIntervalMs: 15000
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
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
            
            if (qr) {
                console.log('📱 QR Code received - please scan');
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            try {
                const message = m.messages[0];
                
                // Skip if no message content or not from group
                if (!message.message || !message.key?.remoteJid?.includes('@g.us')) {
                    return;
                }

                const sender = message.key.participant || message.key.remoteJid;
                const groupJid = message.key.remoteJid;

                // Try multiple ways to extract text - handle decryption issues gracefully
                let text = '';
                try {
                    text = (
                        message.message.conversation ||
                        message.message.extendedTextMessage?.text ||
                        message.message.imageMessage?.caption ||
                        message.message.videoMessage?.caption ||
                        message.message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
                        ''
                    );
                } catch (extractError) {
                    console.log('⚠️ Could not extract message text (decryption issue)');
                    return;
                }

                // Log ALL messages to see what's coming through
                console.log(`📨 Message from ${sender}: "${text}"`);

                // BOT STATUS COMMAND - SIMPLIFIED DETECTION
                if (text && text.trim().toLowerCase() === '!bot') {
                    console.log('🤖 Bot command detected');
                    try {
                        await sock.sendMessage(groupJid, {
                            text: `✅ ANTI-LINK BOT ACTIVE\nAdmin: ${ADMIN_NUMBER}\nStatus: Online and monitoring for links`
                        });
                        console.log('✅ Bot status sent');
                        return;
                    } catch (error) {
                        console.log('❌ Error sending bot status:', error.message);
                    }
                }

                // If we can't get text due to decryption, skip further processing
                if (!text || text.trim() === '') {
                    return;
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

                if (isAdmin) {
                    console.log('👑 Admin message - skipping check');
                    return;
                }

                // SIMPLIFIED LINK DETECTION
                const hasLink = 
                    /https?:\/\//.test(text) || 
                    /www\./.test(text) ||
                    /\.(com|org|net|ke|co|uk|info|biz|io|app|dev)\b/.test(text) ||
                    text.includes('.com') || 
                    text.includes('.org') || 
                    text.includes('.net') ||
                    text.includes('.ke');

                const isBusinessPost = 
                    message.message.productMessage !== undefined ||
                    message.message.catalogMessage !== undefined;

                // ENFORCE RULES
                if (hasLink || isBusinessPost) {
                    const userKey = `${groupJid}-${sender}`;
                    const violations = userViolations.get(userKey) || 0;
                    const newViolations = violations + 1;
                    
                    userViolations.set(userKey, newViolations);
                    
                    console.log(`🚫 VIOLATION #${newViolations} from ${sender}`);
                    console.log(`🔗 Link detected: ${text}`);

                    try {
                        // DELETE MESSAGE
                        await sock.sendMessage(groupJid, {
                            delete: message.key
                        });
                        console.log('✅ Message deleted');

                        // REMOVE USER AFTER 3 VIOLATIONS
                        if (newViolations >= 3) {
                            try {
                                await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                                console.log('❌ User removed from group');
                                userViolations.delete(userKey);
                                
                                // Notify admin
                                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', {
                                    text: `🚨 User removed\nUser: ${sender}\nGroup: ${groupJid}\nViolations: ${newViolations}`
                                });
                            } catch (removeError) {
                                console.log('❌ Could not remove user:', removeError.message);
                            }
                        }
                    } catch (error) {
                        console.log('❌ Error during enforcement:', error.message);
                    }
                }
            } catch (error) {
                console.log('❌ Error processing message:', error.message);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Handle other events that might help with decryption
        sock.ev.on('chats.set', () => console.log('💬 Chats loaded'));
        sock.ev.on('contacts.set', () => console.log('👥 Contacts loaded'));
        
    } catch (error) {
        console.log('❌ Connection error:', error);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Start bot
console.log('🚀 Starting Anti-Link Bot...');
connectToWhatsApp();
