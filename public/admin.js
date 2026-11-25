// HackLearn Press — admin dashboard logic.
// Plain JS, no build step, no framework: this is a tool for one person
// (the store owner) to review manual-UPI proofs and approve orders.
'use strict';

const KEY_STORAGE = 'hlp_admin_key';
let ADMIN_KEY = localStorage.getItem(KEY_STORAGE) || '';
let currentTab = 'awaiting_review';
let orders = [];

const $ = (sel) => document.querySelector(sel);

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
$('#refreshBtn').addEventListener('click', load);

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
            <div><b>${o.email}</b></div>
            <div>${books.length} book${books.length > 1 ? 's' : ''} · ${fmtMethod(o.method)}</div>
            <div>Ordered ${fmtTime(o.created_at)}${o.paid_at ? ' · Paid ' + fmtTime(o.paid_at) : ''}</div>
            ${o.utr ? `<div>UTR: <span class="copy" title="click to copy" data-copy="${o.utr}">${o.utr}</span></div>` : ''}
            ${o.tx_hash ? `<div>Tx hash: <span class="copy" title="click to copy" data-copy="${o.tx_hash}">${o.tx_hash.slice(0, 18)}…</span></div>` : ''}
            <div style="opacity:.6">Order ${o.id}</div>
            ${o.reject_reason ? `<div style="color:var(--danger)">Previously rejected: ${o.reject_reason}</div>` : ''}
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

if (ADMIN_KEY) openApp(); else openGate();
