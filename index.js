const { default: makeWASocket, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

const ADMIN_NUMBER = "254106090661";

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        
        if (qr) {
            console.log('\n\n📱 SCAN THIS QR CODE WITH WHATSAPP:');
            console.log('1. Open WhatsApp → Settings → Linked Devices');
            console.log('2. Tap "Link a Device"');
            console.log('3. Scan this code:\n');
            qrcode.generate(qr, { small: true });
            console.log('\n⏰ Scan quickly - QR expires in 20 seconds!\n');
        }
        
        if (connection === 'open') {
            console.log('\n✅ SUCCESS! Connected to WhatsApp!');
            console.log('🔒 Anti-link protection activated.');
        }
        
        if (connection === 'close') {
            console.log('\n❌ Connection closed. Restarting in 5 seconds...');
            setTimeout(connectToWhatsApp, 5000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || !message.key.remoteJid.includes('@g.us')) return;

        const text = message.message.conversation || 
                    message.message.extendedTextMessage?.text || '';

        // Check for links
        if (text.includes('http://') || text.includes('https://') || text.includes('.com') || text.includes('.org') || text.includes('.net')) {
            const sender = message.key.participant || message.key.remoteJid;
            const isAdmin = sender.includes(ADMIN_NUMBER);
            
            if (!isAdmin) {
                console.log(`🚫 Link detected from: ${sender}`);
                
                try {
                    await sock.sendMessage(message.key.remoteJid, {
                        delete: message.key
                    });
                    
                    await sock.sendMessage(message.key.remoteJid, {
                        text: `⚠️ Links are not allowed! Only admins can post links.`
                    });
                } catch (error) {
                    console.log('Error deleting message:', error);
                }
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Start the bot
connectToWhatsApp();
