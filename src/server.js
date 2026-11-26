'use strict';
require('dotenv').config();

// Default USDT (TRC20) receiving address, supplied by the store owner.
// Overridable: set TRON_USDT_ADDRESS in the environment to use a different
// wallet (e.g. if this one is ever rotated) without touching code.
if (!process.env.TRON_USDT_ADDRESS) process.env.TRON_USDT_ADDRESS = 'TMf2iM2QqPd57N7XsXVoZuaFKYKMQvrFbz';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');

const catalog = require('./catalog');
const db = require('./db');
const razorpay = require('./razorpay');
const tron = require('./tron');
const upi = require('./upi');
const mailer = require('./mailer');
const notify = require('./notify');
const watermark = require('./watermark');
const { newDownloadToken, isExpired } = require('./tokens');

const app = express();
const PORT = process.env.PORT || 8787;

// CORS allowlist. This API isn't cookie-authenticated (auth is a bearer key
// in a header/query param), so a wildcard here was never the thing standing
// between an attacker and the admin key — tightening it is good hygiene,
// not a critical fix, and it must never be the thing that silently breaks
// checkout in production. So: tighten ONLY when FRONTEND_ORIGIN is actually
// set (set it on Render to your real storefront domain(s), comma-separated,
// e.g. "https://hacklearnraj.in,https://www.hacklearnraj.in"). Until then,
// fall back to allowing any origin, same as before the security pass, with
// a startup warning so it isn't silently forgotten.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : null;
if (!FRONTEND_ORIGIN) {
  console.warn('[cors] FRONTEND_ORIGIN not set — allowing requests from any origin. ' +
    'Set FRONTEND_ORIGIN on Render to your real storefront URL(s) to lock this down.');
}

// The storefront (site/) is served from this same server, so the CSP has to
// allow what those pages actually use: their inline <script> blocks, Google
// Fonts, and the QR-code library from cdnjs. Helmet's default CSP blocks all
// of that, which is why the store would render blank/broken if served as-is.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'connect-src': ["'self'", 'https://hacklearnbooks.onrender.com'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      'upgrade-insecure-requests': null,
    },
  },
}));
app.set('trust proxy', 1); // Render sits behind a proxy; needed for rate-limit to key on the real client IP
app.use(cors({
  origin(origin, cb) {
    // No Origin header (curl, server-to-server, the Razorpay webhook) is
    // always allowed through — CORS only ever governs browser requests.
    if (!FRONTEND_ORIGIN || !origin || FRONTEND_ORIGIN.includes(origin)) return cb(null, true);
    cb(new Error('not allowed by CORS'));
  },
}));

// Rate limiting — every route here is either public-facing (so open to
// anyone on the internet) or protects the single admin secret, and neither
// had any throttling before. Limits are generous for a real customer but
// cut off scripted abuse (order-creation spam, UTR/screenshot-submission
// spam, and — most importantly — brute-forcing ADMIN_API_KEY).
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many requests — please slow down and try again shortly' },
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many admin requests — please slow down and try again shortly' },
});

// Capture the raw body for every request (cheap) so the Razorpay webhook
// route can verify the HMAC signature against the exact bytes Razorpay sent.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Screenshots the customer uploads as proof of a manual UPI payment. Kept
// under DATA_DIR so they live on the same persistent disk as the SQLite file
// (see db.js) and survive a redeploy on hosts with an ephemeral filesystem.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Only real raster image types — never SVG. An SVG can carry an inline
// <script>, and this file later gets served back out (to the admin, via
// GET /api/admin/screenshot/:orderId) with a Content-Type derived from its
// extension; letting one through would be a stored-XSS vector against the
// admin dashboard, whose session is just a key sitting in localStorage, i.e.
// a full compromise of the store. mimetype is attacker-supplied (whatever
// the client claims) so it's paired with an extension allowlist below as a
// second check, not trusted alone.
const ALLOWED_SCREENSHOT_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const ALLOWED_SCREENSHOT_MIME = /^image\/(jpeg|png|webp|heic|heif)$/;

// Order ids are always server-generated UUIDs (see uuid() in POST
// /api/orders). Rejecting anything that doesn't look like one before it
// ever reaches multer closes off a path-traversal bug: Express decodes
// %2f/%2e sequences in a route param *after* matching the route, so
// req.params.id can otherwise contain "../" and multer's diskStorage does
// no sanitization of the filename callback's output — a crafted order id in
// the URL could have written the uploaded file anywhere on disk.
const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SCREENSHOT_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '');
      const safeExt = ALLOWED_SCREENSHOT_EXT.has(ext) ? ext : '.jpg';
      // req.params.id is re-validated against ORDER_ID_RE below before this
      // middleware ever runs, but a plain alnum/hyphen strip stays here too
      // as a second, independent layer against any future route change.
      const safeId = String(req.params.id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'unknown';
      cb(null, `${safeId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB is plenty for a payment-app screenshot
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = ALLOWED_SCREENSHOT_MIME.test(file.mimetype) && (ext === '' || ALLOWED_SCREENSHOT_EXT.has(ext));
    cb(null, ok);
  },
});

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
app.post('/api/orders', orderLimiter, async (req, res) => {
  const { bookIds, email, method } = req.body || {};
  // Excludes <, >, ", ' and backtick on top of the original shape check —
  // a valid-looking email like <script>...</script>@x.com otherwise passes
  // a bare "has an @ and a dot" regex, gets stored, and is later rendered on
  // the admin dashboard. admin.js now HTML-escapes this field too (belt and
  // suspenders), but there's no reason to accept those characters in an
  // email address in the first place.
  if (!email || typeof email !== 'string' || email.length > 254 ||
      !/^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/.test(email)) {
    return res.status(400).json({ error: 'a valid email address is required' });
  }
  if (!['razorpay', 'crypto', 'upi_manual'].includes(method)) {
    return res.status(400).json({ error: "method must be 'razorpay', 'crypto' or 'upi_manual'" });
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

  if (method === 'crypto') {
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
  }

  // method === 'upi_manual' — a stopgap until Razorpay is approved. See
  // upi.js for exactly what is and isn't verified automatically here.
  if (!upi.isConfigured()) {
    return res.status(503).json({ error: 'UPI (manual) payment is not set up yet on this store.' });
  }
  db.createOrder({
    id, bookIds: price.ids, email, sumInr: price.sumInr,
    discountPercent: price.discountPercent, amountInr: price.totalInr, method,
  });
  return res.json({
    orderId: id,
    upiId: process.env.UPI_VPA,
    payeeName: process.env.UPI_PAYEE_NAME || 'HackLearn Press',
    upiLink: upi.buildUpiLink({ amountInr: price.totalInr, orderId: id }),
    amountInr: price.totalInr,
    note: 'Pay to this UPI ID, then upload your payment screenshot and UTR below. A real person reviews and approves it — please allow up to 20-30 minutes.',
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
app.post('/api/orders/:id/crypto-submit', orderLimiter, async (req, res) => {
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

// ------------------------------------------------------------ upi-submit
// Customer has paid the owner's personal UPI ID directly (outside any
// gateway) and is now submitting their proof. This does NOT mark the order
// paid — it moves it to 'awaiting_review' for the owner to approve on the
// admin dashboard. See upi.js for why this step can't be fully automatic.
app.post('/api/orders/:id/upi-submit', orderLimiter, (req, res, next) => {
  // Validated here, before multer runs — see the ORDER_ID_RE comment above
  // for why this specifically has to happen before the upload middleware,
  // not just inside the handler below.
  if (!ORDER_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'order not found' });
  next();
}, (req, res, next) => {
  upload.single('screenshot')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'could not read that upload' });
    next();
  });
}, (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.method !== 'upi_manual') return res.status(400).json({ error: 'this order is not a manual UPI order' });
  if (order.status === 'paid' || order.status === 'delivered') {
    return res.json({ status: order.status, downloadUrl: order.download_token ? `/download/${order.download_token}` : null });
  }
  if (order.status !== 'pending') {
    // already awaiting_review — don't let a second submit silently overwrite it
    return res.status(409).json({ status: order.status, error: 'this order already has a submission awaiting review' });
  }

  // Some payment apps display the reference with spaces or hyphens if a
  // customer copies it with formatting intact — strip those before
  // validating rather than rejecting a perfectly real UTR over it.
  const utr = String(req.body?.utr || '').trim().replace(/[\s-]+/g, '');
  if (!utr) return res.status(400).json({ error: 'UTR / transaction reference number is required' });
  // Real UPI/bank reference numbers are alphanumeric, typically 10-22
  // characters. Enforcing that shape here (rather than only escaping on
  // display) closes off the same stored-XSS angle as the email check above —
  // this field is rendered on the admin dashboard too.
  if (!/^[a-zA-Z0-9]{4,40}$/.test(utr)) {
    return res.status(400).json({ error: 'that doesn\'t look like a valid UTR / reference number (letters and numbers only)' });
  }
  if (!req.file) return res.status(400).json({ error: 'a payment screenshot is required' });
  if (db.utrAlreadyUsed(utr)) {
    fs.unlink(req.file.path, () => {});
    return res.status(409).json({ error: 'this UTR has already been submitted on another order' });
  }

  const changed = db.submitUpiProof(order.id, { utr, screenshotPath: req.file.filename });
  if (!changed) {
    fs.unlink(req.file.path, () => {});
    return res.status(409).json({ error: 'this order is no longer waiting for a submission' });
  }
  res.json({ status: 'awaiting_review', note: 'Submitted — your payment will be verified within 20-30 minutes. You\'ll get an email once it\'s approved, or you can check back here.' });

  // Fire-and-forget — never let a notification hiccup affect the response above.
  const adminLink = `${process.env.PUBLIC_BASE_URL || ''}/admin.html`;
  notify.notifyOwner(
    `New UPI payment to review: ₹${order.amount_inr} from ${order.email}\nUTR: ${utr}\n${adminLink}`
  ).catch(() => {});
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

app.get('/download/:token', async (req, res) => {
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

  // Stamp a traceable "Licensed to <email> · Order <id>" footer on every page
  // before handing it over — see watermark.js for exactly what this does and
  // doesn't protect against. Done on the fly so the 18 source PDFs on disk
  // never need touching.
  try {
    const original = fs.readFileSync(filePath);
    const stamped = await watermark.watermarkPdf(original, { email: order.email, orderId: order.id });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${book.title}.pdf"`);
    return res.send(stamped);
  } catch (err) {
    console.error(`[watermark] failed for order ${order.id}, book ${book.id} — sending unwatermarked file instead`, err.message);
    return res.download(filePath, `${book.title}.pdf`);
  }
});

// ----------------------------------------------------------------- admin
// Minimal manual-override endpoints, protected by a single shared secret.
// Use these if a crypto verification needs a human look, or a Razorpay
// webhook was missed for any reason — nothing ever has to be re-built by
// hand, just confirmed.
function requireAdmin(req, res, next) {
  // Accepts the key either as a header (used by admin.html's fetch calls) or
  // a ?key= query param (needed for the <img src> screenshot route, which
  // can't send custom headers). Constant-time compare to avoid timing leaks.
  const key = req.header('X-Admin-Key') || req.query.key || '';
  const expected = process.env.ADMIN_API_KEY || '';
  const ok = expected && key.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/api/admin/orders', adminLimiter, requireAdmin, (_req, res) => {
  const rows = db.db.prepare('SELECT id, email, book_ids, method, status, amount_inr, usdt_amount, tx_hash, utr, screenshot_path, reject_reason, created_at, paid_at FROM orders ORDER BY created_at DESC LIMIT 200').all();
  res.json({ orders: rows });
});

app.post('/api/admin/orders/:id/confirm', adminLimiter, requireAdmin, async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (!['pending', 'awaiting_review'].includes(order.status)) return res.json({ status: order.status });
  const downloadToken = newDownloadToken();
  db.markPaid(order.id, { downloadToken });
  const fresh = db.getOrder(order.id);
  await mailer.sendOrderDelivery(fresh);
  res.json({ status: fresh.status });
});

// Screenshot didn't check out (wrong amount, doesn't match, looks edited).
// Sends the order back to 'pending' so the customer can submit again, and
// frees the UTR in case it was a genuine typo.
app.post('/api/admin/orders/:id/reject', adminLimiter, requireAdmin, (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  const changed = db.rejectManualUpi(order.id, req.body?.reason || null);
  if (!changed) return res.status(409).json({ error: 'this order is not currently awaiting review' });
  res.json({ status: 'pending' });
});

// Serves an uploaded payment screenshot for the admin dashboard to display.
// Key-in-query (not just header) because a plain <img src> can't set
// custom headers — same timingSafeEqual check as every other admin route.
app.get('/api/admin/screenshot/:orderId', adminLimiter, requireAdmin, (req, res) => {
  const order = db.getOrder(req.params.orderId);
  if (!order || !order.screenshot_path) return res.status(404).send('not found');
  const filePath = path.join(SCREENSHOT_DIR, order.screenshot_path);
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  res.sendFile(filePath);
});

// --------------------------------------------------------- sales analytics
// Revenue, order breakdown and best-selling books — computed fresh on every
// call from the orders table. Cheap enough at this store's volume to not
// need caching; revisit only if the order count grows into the tens of
// thousands.
app.get('/api/admin/stats', adminLimiter, requireAdmin, (_req, res) => {
  const rows = db.db.prepare("SELECT book_ids, email, sum_inr, amount_inr, discount_percent, method, status, created_at FROM orders").all();

  const paidRows = rows.filter(r => r.status === 'paid' || r.status === 'delivered');
  const totalRevenue = paidRows.reduce((sum, r) => sum + r.amount_inr, 0);

  const byStatus = {};
  const byMethod = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byMethod[r.method] = (byMethod[r.method] || 0) + 1;
  }

  const bookCounts = {};
  for (const r of paidRows) {
    for (const id of JSON.parse(r.book_ids || '[]')) bookCounts[id] = (bookCounts[id] || 0) + 1;
  }
  const topBooks = Object.entries(bookCounts)
    .map(([id, count]) => ({ id, title: catalog.BY_ID[id]?.title || id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const uniqueCustomers = new Set(paidRows.map(r => r.email.toLowerCase())).size;

  res.json({
    totalOrders: rows.length,
    paidOrders: paidRows.length,
    totalRevenueInr: totalRevenue,
    uniqueCustomers,
    byStatus,
    byMethod,
    topBooks,
  });
});

// ------------------------------------------------------------------ backup
// On-demand zip of the SQLite order database + every uploaded payment
// screenshot — click-to-download from /admin.html. This protects against an
// application-level mistake (a bad migration, an accidental delete) but NOT
// against the underlying disk itself failing, since the zip is built from
// the same disk it's backing up. For real off-disk durability, download
// this periodically (weekly is reasonable at this volume) and keep a copy
// somewhere else — or wire DATA_DIR's contents up to an S3-compatible bucket
// once you have one; this endpoint is the manual stopgap until then.
app.get('/api/admin/backup', adminLimiter, requireAdmin, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="hacklearn-backup-${stamp}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[backup] archive error', err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);
  if (fs.existsSync(path.join(DATA_DIR, 'orders.db'))) {
    archive.file(path.join(DATA_DIR, 'orders.db'), { name: 'orders.db' });
  }
  if (fs.existsSync(SCREENSHOT_DIR)) {
    archive.directory(SCREENSHOT_DIR, 'screenshots');
  }
  archive.finalize();
});

// The dashboard page itself (public/admin.html + admin.js). Protected by
// nothing at the HTTP level (it's just static HTML/JS) — every data call it
// makes requires the admin key, entered once and kept in that browser.
app.use(express.static(path.join(__dirname, '..', 'public')));

// The storefront itself: home page, book previews (prev/), covers, checkout
// and policy pages. Served from this same server so the whole store is live
// at the Render URL — previously only the API was deployed, so visiting the
// site showed a bare "this is an API server" page and nothing else. The paid
// PDFs in pdfs/ are deliberately NOT in here: they're only ever served through
// a paid order's /download/:token link.
app.use(express.static(path.join(__dirname, '..', 'site'), { extensions: ['html'], maxAge: '1h' }));

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  razorpayConfigured: razorpay.isConfigured(),
  cryptoConfigured: tron.isConfigured(),
  upiManualConfigured: upi.isConfigured(),
  mailerConfigured: mailer.isConfigured(),
  adminConfigured: !!process.env.ADMIN_API_KEY,
  whatsappNotifyConfigured: notify.isConfigured(),
}));

if (tron.isConfigured() && !tron.isValidAddressFormat(process.env.TRON_USDT_ADDRESS)) {
  console.error(`[startup] TRON_USDT_ADDRESS "${process.env.TRON_USDT_ADDRESS}" does not look like a valid Tron address — crypto payments would fail. Fix it before accepting orders.`);
}

// Catch-all error handler — must be last. Without this, an uncaught error
// anywhere (a CORS rejection, a bad-JSON body, anything) falls through to
// Express's default handler, which renders a full stack trace to the client
// whenever NODE_ENV isn't exactly "production". That's an information leak
// (file paths, dependency versions, internal logic) that doesn't depend on
// setting NODE_ENV correctly on every host — this makes it true regardless.
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err.message);
  if (res.headersSent) return;
  const status = err.message === 'not allowed by CORS' ? 403 : (err.status || 500);
  res.status(status).json({ error: status === 500 ? 'something went wrong' : err.message });
});

app.listen(PORT, () => console.log(`HackLearn payments backend listening on :${PORT}`));
