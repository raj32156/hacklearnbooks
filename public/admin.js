// HackLearn Press — admin dashboard logic.
// Plain JS, no build step, no framework: this is a tool for one person
// (the store owner) to review manual-UPI proofs and approve orders.
'use strict';

const KEY_STORAGE = 'hlp_admin_key';
let ADMIN_KEY = localStorage.getItem(KEY_STORAGE) || '';
let currentTab = 'awaiting_review';
let orders = [];

const $ = (sel) => document.querySelector(sel);

// Every field below that comes from a customer (email at checkout, UTR typed
// in at UPI submission, a rejection reason typed by you) gets rendered with
// this before it ever goes into innerHTML. Server-side validation on these
// fields is loose by design (an email just needs an @ and a dot; a UTR is
// free text) — it was never meant to stop someone writing a <script> tag
// into their own order's email or UTR, and without this escaping that script
// would run here, in this dashboard, with your admin key sitting right next
// to it in localStorage.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtAmount(order) {
  if (order.method === 'crypto') return `₹${order.amount_inr} (${order.usdt_amount} USDT)`;
  return `₹${order.amount_inr}`;
}
function fmtMethod(m) {
  return { razorpay: 'Razorpay (UPI/card)', crypto: 'Crypto (USDT TRC20)', upi_manual: 'UPI (manual)' }[m] || m;
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Admin-Key': ADMIN_KEY, ...(opts.headers || {}) },
  });
  if (res.status === 401) { signOut('That key was rejected — check it matches ADMIN_API_KEY on the server.'); throw new Error('unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function screenshotUrl(order) {
  return `/api/admin/screenshot/${order.id}?key=${encodeURIComponent(ADMIN_KEY)}`;
}

function openGate() {
  $('#gate').hidden = false;
  $('#appHeader').hidden = true;
  $('#appMain').hidden = true;
}
function openApp() {
  $('#gate').hidden = true;
  $('#appHeader').hidden = false;
  $('#appMain').hidden = false;
  $('#backupLink').href = `/api/admin/backup?key=${encodeURIComponent(ADMIN_KEY)}`;
  load();
}
function signOut(message) {
  localStorage.removeItem(KEY_STORAGE);
  ADMIN_KEY = '';
  openGate();
  if (message) $('#status').textContent = message;
}

$('#gateGo').addEventListener('click', () => {
  const k = $('#gateKey').value.trim();
  if (!k) return;
  ADMIN_KEY = k;
  localStorage.setItem(KEY_STORAGE, k);
  openApp();
});
$('#gateKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gateGo').click(); });
$('#logoutBtn').addEventListener('click', () => signOut());
$('#refreshBtn').addEventListener('click', () => currentView === 'stats' ? loadStats() : load());

let currentView = 'orders';
document.querySelectorAll('#viewTabs .tab').forEach(el => el.addEventListener('click', () => {
  currentView = el.dataset.view;
  document.querySelectorAll('#viewTabs .tab').forEach(t => t.classList.toggle('active', t === el));
  $('#ordersView').hidden = currentView !== 'orders';
  $('#statsView').hidden = currentView !== 'stats';
  if (currentView === 'stats') loadStats(); else load();
}));

const TABS = [
  { id: 'awaiting_review', label: 'Awaiting review' },
  { id: 'pending', label: 'Pending payment' },
  { id: 'paid', label: 'Paid / delivered' },
  { id: 'all', label: 'All' },
];

function renderTabs() {
  const counts = { awaiting_review: 0, pending: 0, paid: 0, all: orders.length };
  for (const o of orders) {
    if (o.status === 'awaiting_review') counts.awaiting_review++;
    else if (o.status === 'pending') counts.pending++;
    else if (o.status === 'paid' || o.status === 'delivered') counts.paid++;
  }
  $('#tabs').innerHTML = TABS.map(t =>
    `<div class="tab ${t.id === currentTab ? 'active' : ''}" data-tab="${t.id}">${t.label} <span class="count">${counts[t.id]}</span></div>`
  ).join('');
  document.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => {
    currentTab = el.dataset.tab;
    renderTabs();
    renderList();
  }));
}

function matchesTab(o) {
  if (currentTab === 'all') return true;
  if (currentTab === 'paid') return o.status === 'paid' || o.status === 'delivered';
  return o.status === currentTab;
}

function renderList() {
  const rows = orders.filter(matchesTab);
  if (!rows.length) {
    $('#list').innerHTML = `<div class="empty">Nothing here right now.</div>`;
    return;
  }
  $('#list').innerHTML = rows.map(o => {
    const books = JSON.parse(o.book_ids || '[]');
    const isReview = o.status === 'awaiting_review';
    const shot = o.screenshot_path
      ? `<div class="shot"><div class="label">Payment screenshot</div><img src="${screenshotUrl(o)}" data-full="${screenshotUrl(o)}"></div>`
      : '';
    return `
    <div class="card ${isReview ? 'review' : ''}" data-id="${o.id}">
      <div class="row">
        <div class="meta">
          <div class="top">
            <span class="amount">${fmtAmount(o)}</span>
            <span class="badge ${o.status}">${o.status.replace('_', ' ')}</span>
          </div>
          <div class="kv">
            <div><b>${escapeHtml(o.email)}</b></div>
            <div>${books.length} book${books.length > 1 ? 's' : ''} · ${fmtMethod(o.method)}</div>
            <div>Ordered ${fmtTime(o.created_at)}${o.paid_at ? ' · Paid ' + fmtTime(o.paid_at) : ''}</div>
            ${o.utr ? `<div>UTR: <span class="copy" title="click to copy" data-copy="${escapeHtml(o.utr)}">${escapeHtml(o.utr)}</span></div>` : ''}
            ${o.tx_hash ? `<div>Tx hash: <span class="copy" title="click to copy" data-copy="${escapeHtml(o.tx_hash)}">${escapeHtml(o.tx_hash.slice(0, 18))}…</span></div>` : ''}
            <div style="opacity:.6">Order ${escapeHtml(o.id)}</div>
            ${o.reject_reason ? `<div style="color:var(--danger)">Previously rejected: ${escapeHtml(o.reject_reason)}</div>` : ''}
          </div>
          ${isReview ? `
          <div class="actions">
            <button class="btn approve" data-action="approve" data-id="${o.id}">Approve &amp; release books</button>
            <button class="btn reject" data-action="reject" data-id="${o.id}">Reject</button>
          </div>` : (o.status === 'pending' && (o.method === 'razorpay' || o.method === 'crypto') ? `
          <div class="actions">
            <button class="btn approve" data-action="approve" data-id="${o.id}">Confirm manually</button>
          </div>` : '')}
        </div>
        ${shot}
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-copy]').forEach(el => el.addEventListener('click', () => {
    navigator.clipboard?.writeText(el.dataset.copy).catch(() => {});
  }));
  document.querySelectorAll('.shot img').forEach(img => img.addEventListener('click', () => {
    $('#lightboxImg').src = img.dataset.full;
    $('#lightbox').style.display = 'flex';
  }));
  document.querySelectorAll('[data-action="approve"]').forEach(btn => btn.addEventListener('click', () => approve(btn.dataset.id)));
  document.querySelectorAll('[data-action="reject"]').forEach(btn => btn.addEventListener('click', () => reject(btn.dataset.id)));
}

$('#lightbox').addEventListener('click', () => { $('#lightbox').style.display = 'none'; });

async function approve(id) {
  $('#status').textContent = 'Approving…';
  try {
    await api(`/api/admin/orders/${id}/confirm`, { method: 'POST' });
    $('#status').textContent = 'Approved — books released and email sent (if SMTP is configured).';
    await load();
  } catch (err) {
    $('#status').textContent = 'Error: ' + err.message;
  }
}
async function reject(id) {
  const reason = prompt('Optional: why is this being rejected? (shown to you next time, not to the customer)') || '';
  $('#status').textContent = 'Rejecting…';
  try {
    await api(`/api/admin/orders/${id}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    });
    $('#status').textContent = 'Rejected — order is back to pending so the customer can resubmit.';
    await load();
  } catch (err) {
    $('#status').textContent = 'Error: ' + err.message;
  }
}

async function load() {
  $('#status').textContent = 'Loading…';
  try {
    const body = await api('/api/admin/orders');
    orders = body.orders;
    $('#status').textContent = `${orders.length} order${orders.length === 1 ? '' : 's'} loaded, newest first.`;
    renderTabs();
    renderList();
  } catch (err) {
    if (err.message !== 'unauthorized') $('#status').textContent = 'Error: ' + err.message;
  }
}

async function loadStats() {
  $('#status').textContent = 'Loading stats…';
  try {
    const s = await api('/api/admin/stats');
    const statusLine = Object.entries(s.byStatus).map(([k, v]) => `${k.replace('_', ' ')}: ${v}`).join(' · ');
    const methodLine = Object.entries(s.byMethod).map(([k, v]) => `${fmtMethod(k)}: ${v}`).join(' · ');
    $('#statsCards').innerHTML = `
      <div class="card"><div class="label">Total revenue (paid)</div><div class="value">₹${s.totalRevenueInr.toLocaleString('en-IN')}</div></div>
      <div class="card"><div class="label">Paid orders</div><div class="value">${s.paidOrders}</div></div>
      <div class="card"><div class="label">Total orders</div><div class="value">${s.totalOrders}</div></div>
      <div class="card"><div class="label">Unique customers</div><div class="value">${s.uniqueCustomers}</div></div>
      <div class="card" style="grid-column:1/-1"><div class="label">By status</div><div style="font-size:14px">${statusLine || '—'}</div></div>
      <div class="card" style="grid-column:1/-1"><div class="label">By payment method</div><div style="font-size:14px">${methodLine || '—'}</div></div>
    `;
    $('#topBooksList').innerHTML = s.topBooks.length
      ? s.topBooks.map(b => `<div class="book-row"><span>${b.title}</span><span class="count">${b.count}</span></div>`).join('')
      : '<div class="empty">No paid orders yet.</div>';
    $('#status').textContent = 'Stats refreshed.';
  } catch (err) {
    if (err.message !== 'unauthorized') $('#status').textContent = 'Error: ' + err.message;
  }
}

if (ADMIN_KEY) openApp(); else openGate();
