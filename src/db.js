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
  const info = db.prepare(`
    UPDATE orders SET status = 'paid', paid_at = ?, razorpay_payment_id = COALESCE(?, razorpay_payment_id),
      tx_hash = COALESCE(?, tx_hash), download_token = COALESCE(?, download_token)
    WHERE id = ? AND status = 'pending'
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

module.exports = {
  db, createOrder, getOrder, getOrderByRazorpayOrderId, getOrderByDownloadToken,
  attachRazorpayOrderId, markPaid, markDelivered, txHashAlreadyUsed,
};
