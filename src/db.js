// SQLite order store. File-based (data/orders.db) so it needs zero external
// services to start with. For real production traffic on a host with an
// ephemeral disk (some free tiers wipe local files on redeploy), mount a
// persistent disk at DATA_DIR or swap this for a hosted Postgres — the
// queries below are simple enough to port in an afternoon.
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'orders.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  book_ids         TEXT NOT NULL,       -- JSON array of book ids
  email            TEXT NOT NULL,
  sum_inr          INTEGER NOT NULL,
  discount_percent INTEGER NOT NULL,
  amount_inr       INTEGER NOT NULL,    -- final amount after discount
  method           TEXT NOT NULL,       -- 'razorpay' | 'crypto'
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|paid|delivered|failed|expired
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  usdt_amount      TEXT,                -- decimal string, crypto orders only
  tx_hash          TEXT,                -- customer-submitted TRC20 tx hash
  download_token   TEXT,
  created_at       TEXT NOT NULL,
  paid_at          TEXT,
  delivered_at     TEXT
);
-- A given tx hash may only ever be attached to one order (anti-replay).
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tx_hash ON orders(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_razorpay_order_id ON orders(razorpay_order_id);
`);

// Migration-safe column additions for manual-UPI-with-screenshot orders.
// Wrapped individually so this never breaks on a database that already has
// one of these columns (e.g. a redeploy after this feature already ran once).
function addColumnIfMissing(name, ddl) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${ddl}`);
}
addColumnIfMissing('utr', 'utr TEXT');
addColumnIfMissing('screenshot_path', 'screenshot_path TEXT');
addColumnIfMissing('reject_reason', 'reject_reason TEXT');
// A given UTR may only ever be attached to one order (anti-replay), same idea
// as the tx_hash index above. Created after the column exists.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_utr ON orders(utr) WHERE utr IS NOT NULL;`);

function createOrder({ id, bookIds, email, sumInr, discountPercent, amountInr, method, usdtAmount }) {
  db.prepare(`
    INSERT INTO orders (id, book_ids, email, sum_inr, discount_percent, amount_inr, method, usdt_amount, created_at)
    VALUES (@id, @book_ids, @email, @sumInr, @discountPercent, @amountInr, @method, @usdtAmount, @createdAt)
  `).run({
    id, book_ids: JSON.stringify(bookIds), email, sumInr, discountPercent, amountInr,
    method, usdtAmount: usdtAmount || null, createdAt: new Date().toISOString(),
  });
  return getOrder(id);
}

function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (row) row.book_ids = JSON.parse(row.book_ids);
  return row;
}

function getOrderByRazorpayOrderId(rzpOrderId) {
  const row = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(rzpOrderId);
  if (row) row.book_ids = JSON.parse(row.book_ids);
  return row;
}

function getOrderByDownloadToken(token) {
  const row = db.prepare('SELECT * FROM orders WHERE download_token = ?').get(token);
  if (row) row.book_ids = JSON.parse(row.book_ids);
  return row;
}

function attachRazorpayOrderId(id, rzpOrderId) {
  db.prepare('UPDATE orders SET razorpay_order_id = ? WHERE id = ?').run(rzpOrderId, id);
}

// Returns true if this call is the one that actually transitioned the order
// (so the caller knows whether to send the fulfilment email) — guards
// against a webhook firing twice for the same payment.
function markPaid(id, { razorpayPaymentId, txHash, downloadToken } = {}) {
  // 'pending' covers razorpay/crypto orders still waiting on payment;
  // 'awaiting_review' covers manual-UPI orders where a screenshot+UTR has
  // been submitted and the owner is about to click Approve. Either is a
  // valid starting point for this transition — anything else (already
  // paid/delivered/failed) is left alone, which is what keeps this idempotent.
  const info = db.prepare(`
    UPDATE orders SET status = 'paid', paid_at = ?, razorpay_payment_id = COALESCE(?, razorpay_payment_id),
      tx_hash = COALESCE(?, tx_hash), download_token = COALESCE(?, download_token)
    WHERE id = ? AND status IN ('pending', 'awaiting_review')
  `).run(new Date().toISOString(), razorpayPaymentId || null, txHash || null, downloadToken, id);
  return info.changes === 1;
}

function markDelivered(id) {
  db.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

function txHashAlreadyUsed(txHash) {
  return !!db.prepare('SELECT 1 FROM orders WHERE tx_hash = ?').get(txHash);
}

function utrAlreadyUsed(utr) {
  return !!db.prepare('SELECT 1 FROM orders WHERE utr = ?').get(utr);
}

// Customer has paid via personal UPI and is submitting their proof. This
// moves the order from 'pending' to 'awaiting_review' — it is NOT marked
// paid here. Only an admin clicking Approve (markPaid) releases the books;
// see upi.js for why this can't be done automatically.
function submitUpiProof(id, { utr, screenshotPath }) {
  const info = db.prepare(`
    UPDATE orders SET status = 'awaiting_review', utr = ?, screenshot_path = ?
    WHERE id = ? AND status = 'pending'
  `).run(utr, screenshotPath, id);
  return info.changes === 1;
}

// Owner looked at the screenshot and it doesn't check out (wrong amount,
// doesn't match, looks edited, etc). Clears the proof so the customer can
// submit again rather than being permanently stuck — also frees up the UTR
// in case it was a genuine typo.
function rejectManualUpi(id, reason) {
  const info = db.prepare(`
    UPDATE orders SET status = 'pending', utr = NULL, screenshot_path = NULL, reject_reason = ?
    WHERE id = ? AND status = 'awaiting_review'
  `).run(reason || null, id);
  return info.changes === 1;
}

module.exports = {
  db, createOrder, getOrder, getOrderByRazorpayOrderId, getOrderByDownloadToken,
  attachRazorpayOrderId, markPaid, markDelivered, txHashAlreadyUsed,
  utrAlreadyUsed, submitUpiProof, rejectManualUpi,
};
