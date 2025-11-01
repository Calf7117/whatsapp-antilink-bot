const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');

const ADMIN_NUMBER = "254106090661";
const userViolations = new Map();

// Enhanced silent logger
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
            // Critical: Add these to handle decryption issues
            retryRequestDelayMs: 1000,
            maxRetries: 3,
            connectTimeoutMs: 20000,
            keepAliveIntervalMs: 10000,
            // Handle message decryption more gracefully
            msgRetryCounterCache: new Map(),
            getMessage: async () => undefined, // Return undefined if message can't be found
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

        // Handle message processing with better error handling
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const message = m.messages[0];
                
                // Skip if no message or not from group
                if (!message?.message || !message.key?.remoteJid?.includes('@g.us')) {
                    return;
                }

                const sender = message.key.participant || message.key.remoteJid;
                const groupJid = message.key.remoteJid;

                // Enhanced text extraction with fallbacks
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
                } catch (extractError) {
                    console.log('🔒 Could not extract message text (decryption issue)');
                    return; // Skip this message if we can't read it
                }

                console.log(`📨 Message from ${sender}: "${text}"`);

                // ADMIN DETECTION - Multiple format checks
                const isAdmin = checkAdmin(sender, ADMIN_NUMBER);
                
                if (isAdmin) {
                    console.log('👑 ADMIN MESSAGE - IGNORING CHECKS');
                    
                    // Handle !bot command for admin
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
                    return; // Skip all checks for admin
                }

                // Handle !bot command for regular users
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

                // Skip empty messages
                if (!text) return;

                // IMPROVED LINK DETECTION - Only real URLs
                const hasLink = detectActualLinks(text);
                
                const isBusinessPost = 
                    message.message.productMessage !== undefined ||
                    message.message.catalogMessage !== undefined;

                // ENFORCE RULES
                if (hasLink || isBusinessPost) {
                    const userKey = `${groupJid}-${sender}`;
                    const violations = userViolations.get(userKey) || 0;
                    const newViolations = violations + 1;
                    
                    userViolations.set(userKey, newViolations);
                    
                    console.log(`🚫 Violation #${newViolations} from ${sender}`);
                    console.log(`🔗 Content: ${text}`);

                    try {
                        // Delete message
                        await sock.sendMessage(groupJid, {
                            delete: message.key
                        });
                        console.log('✅ Message deleted');

                        // Remove user after 3 violations
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
                // Don't throw, continue processing other messages
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Handle other events that might help
        sock.ev.on('messages.update', () => {});
        sock.ev.on('message-receipt.update', () => {});
        
    } catch (error) {
        console.log('❌ Connection setup error:', error.message);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// IMPROVED ADMIN DETECTION
function checkAdmin(senderJid, adminNumber) {
    // Extract pure numbers from both
    const senderNum = senderJid.replace(/\D/g, '');
    const adminNum = adminNumber.replace(/\D/g, '');
    
    // Check multiple possible formats
    const isAdmin = 
        senderNum === adminNum ||
        senderNum === adminNum.replace('254', '') ||
        senderJid.includes(adminNumber) ||
        senderJid.includes(adminNum);
    
    console.log(`🔍 Admin check - Sender: ${senderNum}, Admin: ${adminNum}, Result: ${isAdmin}`);
    return isAdmin;
}

// IMPROVED LINK DETECTION - Only real URLs
function detectActualLinks(text) {
    // Only match actual URLs and domains, not random text
    const linkPatterns = [
        /https?:\/\/[^\s]+/g,  // http:// or https:// URLs
        /www\.[^\s]+/g,        // www. domains
        /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?/g, // domain.com/path
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

// Start with error handling
console.log('🚀 Starting Anti-Link Bot with existing auth...');
connectToWhatsApp().catch(error => {
    console.log('❌ Failed to start:', error);
    setTimeout(connectToWhatsApp, 15000);
});
