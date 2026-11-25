// Thin wrapper around the Razorpay Orders API + webhook signature check.
// Docs: https://razorpay.com/docs/api/orders/ and
//       https://razorpay.com/docs/webhooks/validate-test/
'use strict';
const axios = require('axios');
const crypto = require('crypto');

function isConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function client() {
  return axios.create({
    baseURL: 'https://api.razorpay.com/v1',
    auth: { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET },
    timeout: 15000,
  });
}

// amountInr: integer rupees (not paise). receipt: our own order id, shown in
// the Razorpay dashboard so a payment can be traced back to a local order.
async function createOrder(amountInr, receipt) {
  const { data } = await client().post('/orders', {
    amount: Math.round(amountInr * 100), // paise
    currency: 'INR',
    receipt,
    payment_capture: 1, // auto-capture — funds settle without a separate capture call
  });
  return data; // { id: 'order_xxx', amount, currency, status, ... }
}

// Razorpay signs every webhook body with HMAC-SHA256 using the webhook
// secret you set when you create the webhook in the dashboard. Compare with
// a constant-time check to avoid timing attacks.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET || !signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, createOrder, verifyWebhookSignature };
