// Pings the store owner on WhatsApp when something needs their attention
// (right now: a manual-UPI payment proof was submitted and is awaiting
// approval on /admin.html).
//
// HONEST LIMITATION: there's no Meta WhatsApp Business API account set up
// here (that needs a verified Facebook Business account + phone number
// registration + template approval — a manual setup only you can do, not
// something this backend can provision). Instead this uses CallMeBot
// (callmebot.com), a free third-party relay that many people use for
// exactly this — "send my own phone a WhatsApp message from a script" — by
// registering your own number with their bot once. It's unofficial and can
// occasionally be rate-limited or go down; if it ever stops working, nothing
// else breaks — the order still shows up on /admin.html, you just won't get
// a ping about it.
//
// One-time setup to turn this on (do this yourself, takes under a minute):
//   1. Save +34 623 78 64 49 as a contact on the phone that owns OWNER_WHATSAPP_NUMBER.
//   2. WhatsApp that number the message: I allow callmebot to send me messages
//   3. It replies with your API key.
//   4. Set CALLMEBOT_APIKEY to that key in this backend's environment variables.
'use strict';
const axios = require('axios');

function isConfigured() {
  return !!(process.env.OWNER_WHATSAPP_NUMBER && process.env.CALLMEBOT_APIKEY);
}

async function notifyOwner(message) {
  if (!isConfigured()) {
    console.warn('[notify] CallMeBot not configured — skipping WhatsApp ping:', message);
    return { sent: false, reason: 'not configured' };
  }
  try {
    await axios.get('https://api.callmebot.com/whatsapp.php', {
      params: {
        phone: process.env.OWNER_WHATSAPP_NUMBER,
        text: message,
        apikey: process.env.CALLMEBOT_APIKEY,
      },
      timeout: 10000,
    });
    return { sent: true };
  } catch (err) {
    // Never let a notification failure break the actual order flow.
    console.error('[notify] WhatsApp ping failed', err.response?.data || err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { isConfigured, notifyOwner };
