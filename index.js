const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');

const ADMIN_NUMBER = "254106090661";

// Track violations per user
const userViolations = new Map();
let sock = null;
let isConnected = false;
let qrGenerated = false;

async function connectToWhatsApp() {
    try {
        // Check if auth_info exists
        const authDir = './auth_info';
        let hasExistingSession = false;
        
        try {
            const files = await fs.readdir(authDir);
            hasExistingSession = files.some(file => file.includes('creds') || file.includes('app-state'));
            console.log(hasExistingSession ? '✅ Existing session found' : '❌ No session found - will require QR');
        } catch (error) {
            console.log('❌ Auth directory not accessible - will require QR');
        }

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: true,
            // Add connection stability settings
            connectTimeoutMs: 30000,
            keepAliveIntervalMs: 15000,
            // Remove problematic logger
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            if (qr && !qrGenerated) {
                qrGenerated = true;
                console.log('\n📱 ONE-TIME QR CODE SCAN REQUIRED:');
                console.log('1. Open WhatsApp → Linked Devices → Link a Device');
                console.log('2. Scan this code ONCE:\n');
                qrcode.generate(qr, { small: true });
                console.log('\n✅ After scanning, bot will save session and auto-connect');
                isConnected = false;
            }
            
            if (connection === 'open') {
                isConnected = true;
                qrGenerated = false; // Reset for future use
                console.log('\n✅ BOT ONLINE - Anti-link & Business Post protection ACTIVE');
                console.log('📱 Check WhatsApp Linked Devices - should show "Active now"');
            }
            
            if (connection === 'close') {
                isConnected = false;
                const reason = lastDisconnect?.error?.output?.statusCode;
                
                if (reason === DisconnectReason.loggedOut) {
                    console.log('\n🚫 Session logged out - deleting old session files...');
                    // Delete old session and restart
                    setTimeout(() => {
                        connectToWhatsApp();
                    }, 5000);
                } else {
                    console.log('\n❌ Connection closed - Restarting in 10 seconds...');
                    setTimeout(connectToWhatsApp, 10000);
                }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (!isConnected) {
                console.log('❌ Bot not connected, ignoring message');
                return;
            }
            
            const message = m.messages[0];
            if (!message.message || !message.key.remoteJid.includes('@g.us')) return;

            const text = message.message.conversation || 
                        message.message.extendedTextMessage?.text || '';
            const sender = message.key.participant || message.key.remoteJid;
            const groupJid = message.key.remoteJid;

            // 🟢 CHECK BOT STATUS COMMAND
            if (text.toLowerCase() === '!bot') {
                try {
                    await sock.sendMessage(groupJid, {
                        text: `✅ ANTI-LINK BOT IS ONLINE\n🔒 Protecting this group from spam links & business posts\n📊 Stats: ${userViolations.size} users tracked`
                    });
                    console.log('✅ Bot status checked and responded');
                } catch (error) {
                    console.log('❌ Error sending status:', error.message);
                }
                return;
            }

            // 🔴 DETECT LINKS & BUSINESS POSTS
            const isAdmin = sender.includes(ADMIN_NUMBER);
            
            // Check for regular links
            const hasLink = text.includes('http://') || text.includes('https://') || 
                           text.includes('.com') || text.includes('.org') || 
                           text.includes('.net') || text.includes('.ke/');
            
            // Check for business/catalog messages
            const isBusinessPost = message.message.productMessage !== undefined ||
                                  message.message.catalogMessage !== undefined ||
                                  (message.message.buttonsMessage && 
                                   message.message.buttonsMessage.contentText && 
                                   message.message.buttonsMessage.buttons.length > 0);

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
                    console.log('✅ Message deleted for all group members');

                    // 🚨 TAKE ACTION BASED ON VIOLATION COUNT
                    if (newViolations === 1) {
                        console.log('⚠️ First violation - message deleted');
                    } 
                    else if (newViolations === 2) {
                        console.log('⚠️ Second violation - message deleted');
                    } 
                    else if (newViolations >= 3) {
                        // 🚫 SILENTLY REMOVE USER FROM GROUP
                        await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                        console.log('❌ User silently removed from group for 3+ violations');
                        
                        // Reset violations after removal
                        userViolations.delete(userKey);
                    }
                } catch (error) {
                    console.log('❌ Error handling violation:', error.message);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.log('❌ Connection error:', error.message);
        console.log('🔄 Restarting in 10 seconds...');
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Enhanced error handling
process.on('uncaughtException', (error) => {
    console.log('❌ Uncaught Exception:', error.message);
    console.log('🔄 Restarting bot in 10 seconds...');
    setTimeout(connectToWhatsApp, 10000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.log('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    console.log('🔄 Restarting bot in 10 seconds...');
    setTimeout(connectToWhatsApp, 10000);
});

// Start bot
console.log('🚀 Starting Anti-Link Bot with Session Recovery...');
connectToWhatsApp();
