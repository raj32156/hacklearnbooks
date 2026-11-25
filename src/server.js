'use strict';
require('dotenv').config();

// Default USDT (TRC20) receiving address, supplied by the store owner.
// Overridable: set TRON_USDT_ADDRESS in the environment to use a different
// wallet (e.g. if this one is ever rotated) without touching code.
if (!process.env.TRON_USDT_ADDRESS) process.env.TRON_USDT_ADDRESS = 'TMf2iM2QqPd57N7XsXVoZuaFKYKMQvrFbz';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { v4: uuid } = require('uuid');

const catalog = require('./catalog');
const db = require('./db');
const razorpay = require('./razorpay');
const tron = require('./tron');
const mailer = require('./mailer');
const { newDownloadToken, isExpired } = require('./tokens');

const app = express();
const PORT = process.env.PORT || 8787;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

app.use(helmet());
app.use(cors({ origin: FRONTEND_ORIGIN }));

// Capture the raw body for every request (cheap) so the Razorpay webhook
// route can verify the HMAC signature against the exact bytes Razorpay sent.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

const USDT_INR_RATE = Number(process.env.USDT_INR_RATE || 90); // update as the rate moves; see README
const CRYPTO_TOLERANCE = 0.01; // allow the customer to send 1% less (rounding/price-move) before rejecting

function toUsdt(amountInr) {
  return Math.round((amountInr / USDT_INR_RATE) * 100) / 100;
}

// ---------------------------------------------------------------- catalog
app.get('/api/books', (_req, res) => {
  res.json({ books: catalog.BOOKS, tiers: catalog.TIERS });
});

app.post('/api/price', (req, res) => {
  try {
    const price = catalog.priceBasket(req.body.bookIds || []);
    res.json({
      ids: price.ids, sumInr: price.sumInr, discountPercent: price.discountPercent,
      totalInr: price.totalInr, totalUsdt: toUsdt(price.totalInr),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------- new order
app.post('/api/orders', async (req, res) => {
  const { bookIds, email, method } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'a valid email address is required' });
  }
  if (!['razorpay', 'crypto'].includes(method)) {
    return res.status(400).json({ error: "method must be 'razorpay' or 'crypto'" });
  }
  let price;
  try {
    price = catalog.priceBasket(bookIds || []);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = uuid();

  if (method === 'razorpay') {
    if (!razorpay.isConfigured()) {
      return res.status(503).json({ error: 'UPI/card payment is not set up yet on this store — try again soon, or use crypto.' });
    }
    db.createOrder({
      id, bookIds: price.ids, email, sumInr: price.sumInr,
      discountPercent: price.discountPercent, amountInr: price.totalInr, method,
    });
    try {
      const rzpOrder = await razorpay.createOrder(price.totalInr, id);
      db.attachRazorpayOrderId(id, rzpOrder.id);
      return res.json({
        orderId: id,
        razorpayOrderId: rzpOrder.id,
        amountInr: price.totalInr,
        currency: 'INR',
        keyId: process.env.RAZORPAY_KEY_ID,
      });
    } catch (err) {
      console.error('[razorpay] order create failed', err.response?.data || err.message);
      return res.status(502).json({ error: 'could not start the payment — please try again' });
    }
  }

  // method === 'crypto'
  if (!tron.isConfigured()) {
    return res.status(503).json({ error: 'crypto payment is not set up yet on this store — try UPI/card, or check back soon.' });
  }
  const usdtAmount = toUsdt(price.totalInr);
  db.createOrder({
    id, bookIds: price.ids, email, sumInr: price.sumInr,
    discountPercent: price.discountPercent, amountInr: price.totalInr, method, usdtAmount,
  });
  return res.json({
    orderId: id,
    usdtAddress: process.env.TRON_USDT_ADDRESS,
    usdtAmount,
    network: 'TRC20 (Tron)',
    note: 'Send exactly this amount of USDT on the TRC20 network, then submit the transaction hash below.',
  });
});

app.get('/api/orders/:id', (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json({
    id: order.id, status: order.status, method: order.method,
    amountInr: order.amount_inr, usdtAmount: order.usdt_amount,
    downloadUrl: order.download_token ? `/download/${order.download_token}` : null,
  });
});

// ---------------------------------------------------------- crypto submit
app.post('/api/orders/:id/crypto-submit', async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.method !== 'crypto') return res.status(400).json({ error: 'this order is not a crypto order' });
  if (order.status !== 'pending') return res.json({ status: order.status, downloadUrl: order.download_token ? `/download/${order.download_token}` : null });

  const txHash = String(req.body?.txHash || '').trim().replace(/^0x/, '');
  if (!txHash) return res.status(400).json({ error: 'txHash is required' });
  if (db.txHashAlreadyUsed(txHash)) {
    return res.status(409).json({ error: 'this transaction hash has already been used on another order' });
  }

  const result = await tron.verifyUsdtTrc20Transfer(txHash, {
    toAddress: process.env.TRON_USDT_ADDRESS,
    minAmountUsdt: Number(order.usdt_amount) * (1 - CRYPTO_TOLERANCE),
  });
  if (!result.ok) {
    return res.status(400).json({ status: 'pending', error: result.reason });
  }

  const downloadToken = newDownloadToken();
  const changed = db.markPaid(order.id, { txHash: result.txHash, downloadToken });
  if (changed) {
    const fresh = db.getOrder(order.id);
    mailer.sendOrderDelivery(fresh).catch(err => console.error('[mailer] failed', err));
  }
  const fresh = db.getOrder(order.id);
  res.json({ status: fresh.status, downloadUrl: `/download/${fresh.download_token}` });
});

// -------------------------------------------------------- razorpay webhook
// Configure this exact path as the webhook URL in the Razorpay dashboard,
// subscribed to the "payment.captured" event (Settings -> Webhooks).
app.post('/api/webhooks/razorpay', async (req, res) => {
  const signature = req.header('X-Razorpay-Signature');
  if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
    console.warn('[webhook] bad signature, rejecting');
    return res.status(400).send('bad signature');
  }
  const event = req.body;
  res.status(200).send('ok'); // ack immediately; Razorpay retries on non-2xx

  try {
    if (event.event !== 'payment.captured' && event.event !== 'order.paid') return;
    const payment = event.payload?.payment?.entity;
    if (!payment) return;
    const order = db.getOrderByRazorpayOrderId(payment.order_id);
    if (!order) {
      console.warn(`[webhook] no local order for razorpay order ${payment.order_id}`);
      return;
    }
    if (order.status !== 'pending') return; // already handled (idempotent)
    if (payment.amount !== order.amount_inr * 100) {
      console.error(`[webhook] amount mismatch for order ${order.id}: paid ${payment.amount}, expected ${order.amount_inr * 100}`);
      return; // do not fulfil on a mismatch — needs manual review
    }
    const downloadToken = newDownloadToken();
    const changed = db.markPaid(order.id, { razorpayPaymentId: payment.id, downloadToken });
    if (changed) {
      const fresh = db.getOrder(order.id);
      await mailer.sendOrderDelivery(fresh);
    }
  } catch (err) {
    console.error('[webhook] handling error', err);
  }
});

// --------------------------------------------------------------- download
const PDF_DIR = process.env.PDF_DIR || path.join(__dirname, '..', 'pdfs');

app.get('/download/:token', (req, res) => {
  const order = db.getOrderByDownloadToken(req.params.token);
  if (!order) return res.status(404).send('Link not found.');
  if (!['paid', 'delivered'].includes(order.status)) return res.status(403).send('Payment not confirmed yet.');
  if (isExpired(order.paid_at)) return res.status(410).send('This download link has expired — contact support with your order id: ' + order.id);

  const bookId = req.query.book;
  if (!bookId) {
    // No specific book requested: show a simple listing of everything in this order.
    const items = order.book_ids.map(id => catalog.BY_ID[id]).filter(Boolean);
    const links = items.map(b => `<li><a href="/download/${req.params.token}?book=${b.id}">${b.title}</a></li>`).join('');
    return res.send(`<!doctype html><meta charset="utf-8"><title>Your downloads</title>
      <body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto">
      <h2>Your HackLearn Press downloads</h2><ul>${links}</ul></body>`);
  }
  if (!order.book_ids.includes(bookId)) return res.status(403).send('That book is not part of this order.');
  const book = catalog.BY_ID[bookId];
  const filePath = path.join(PDF_DIR, book.file);
  if (!fs.existsSync(filePath)) return res.status(500).send('File missing on server — contact support.');
  db.markDelivered(order.id);
  res.download(filePath, `${book.title}.pdf`);
});

// ----------------------------------------------------------------- admin
// Minimal manual-override endpoints, protected by a single shared secret.
// Use these if a crypto verification needs a human look, or a Razorpay
// webhook was missed for any reason — nothing ever has to be re-built by
// hand, just confirmed.
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_API_KEY || req.header('X-Admin-Key') !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/api/admin/orders', requireAdmin, (_req, res) => {
  const rows = db.db.prepare('SELECT id, email, book_ids, method, status, amount_inr, usdt_amount, tx_hash, created_at, paid_at FROM orders ORDER BY created_at DESC LIMIT 200').all();
  res.json({ orders: rows });
});

app.post('/api/admin/orders/:id/confirm', requireAdmin, async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status !== 'pending') return res.json({ status: order.status });
  const downloadToken = newDownloadToken();
  db.markPaid(order.id, { downloadToken });
  const fresh = db.getOrder(order.id);
  await mailer.sendOrderDelivery(fresh);
  res.json({ status: fresh.status });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8">
    <title>HackLearn Press — Payments API</title>
    <body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;line-height:1.6">
    <h2>HackLearn Press — payments backend</h2>
    <p>This is an API server, not a website — it's called by the store's checkout page, not meant to be browsed directly.</p>
    <p>If you're checking it's alive: <a href="/healthz">/healthz</a></p>
    </body>`);
});

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  razorpayConfigured: razorpay.isConfigured(),
  cryptoConfigured: tron.isConfigured(),
  mailerConfigured: mailer.isConfigured(),
}));

if (tron.isConfigured() && !tron.isValidAddressFormat(process.env.TRON_USDT_ADDRESS)) {
  console.error(`[startup] TRON_USDT_ADDRESS "${process.env.TRON_USDT_ADDRESS}" does not look like a valid Tron address — crypto payments would fail. Fix it before accepting orders.`);
}

app.listen(PORT, () => console.log(`HackLearn payments backend listening on :${PORT}`));
