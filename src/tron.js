// Verifies a USDT (TRC20) payment by looking up the transaction hash the
// customer submits on the public Tron blockchain via TronGrid's free API.
// No private key, wallet software or paid API tier is needed for this —
// TronGrid just lets anyone read confirmed on-chain data.
//
// IMPORTANT: this was written against TronGrid's documented response shapes
// (https://developers.tron.network/reference/tron-grid-api) but could not be
// exercised against a real transaction from this sandbox (outbound network
// here is restricted). Before relying on it for real orders, send yourself
// one small real USDT-TRC20 payment and confirm /api/orders/:id/crypto-submit
// marks it paid. If TronGrid ever changes its response shape, every crypto
// order can still be confirmed by hand via POST /api/admin/orders/:id/confirm
// (see README) — nothing is ever silently lost, it just needs a manual look.
'use strict';
const axios = require('axios');

// The official USDT TRC20 contract address (same on every TRC20 wallet/explorer).
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_DECIMALS = 6;

function client() {
  const headers = {};
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  return axios.create({ baseURL: 'https://api.trongrid.io', timeout: 15000, headers });
}

function isConfigured() {
  return !!process.env.TRON_USDT_ADDRESS;
}

// Shape-only check (base58, starts with T, 34 chars) — catches a typo'd or
// truncated address before it ever gets shown to a paying customer. It
// cannot confirm the address exists or is actually yours; that only matters
// once, the first time you set it, by checking it on tronscan.org yourself.
function isValidAddressFormat(addr) {
  return typeof addr === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr);
}

// txHash: 64-char hex string the customer pastes in.
// toAddress: your TRC20 wallet address (TRON_USDT_ADDRESS).
// minAmountUsdt: the order's expected USDT amount (a small negative
//   tolerance is applied by the caller, not here).
// Returns { ok, reason, amount, from, to }.
async function verifyUsdtTrc20Transfer(txHash, { toAddress, minAmountUsdt }) {
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'that does not look like a valid transaction hash (expected 64 hex characters)' };
  }
  const api = client();

  // 1) Confirm the transaction actually succeeded on-chain (not reverted/pending).
  let info;
  try {
    const { data } = await api.post('/wallet/gettransactioninfobyid', { value: txHash });
    info = data;
  } catch (err) {
    return { ok: false, reason: `could not reach TronGrid: ${err.message}` };
  }
  if (!info || !info.id) {
    return { ok: false, reason: 'transaction not found yet — it may still be confirming, try again in a minute' };
  }
  const receiptResult = info.receipt && info.receipt.result;
  if (receiptResult && receiptResult !== 'SUCCESS') {
    return { ok: false, reason: `transaction did not succeed on-chain (status: ${receiptResult})` };
  }

  // 2) Pull the decoded TRC20 Transfer event(s) for this transaction and find
  //    one that is a USDT transfer to our address.
  let events;
  try {
    const { data } = await api.get(`/v1/transactions/${txHash}/events`);
    events = data && data.data;
  } catch (err) {
    return { ok: false, reason: `could not reach TronGrid events API: ${err.message}` };
  }
  if (!Array.isArray(events) || !events.length) {
    return { ok: false, reason: 'no transfer events found on this transaction' };
  }

  const transfer = events.find(ev => {
    const contractOk = (ev.contract_address || '').toLowerCase() === USDT_CONTRACT.toLowerCase();
    const nameOk = ev.event_name === 'Transfer';
    return contractOk && nameOk;
  });
  if (!transfer) {
    return { ok: false, reason: 'this transaction is not a USDT (TRC20) transfer' };
  }

  const result = transfer.result || {};
  // TronGrid decodes recognized-ABI events into named fields when it can;
  // fall back to positional 0/1/2 just in case.
  const toRaw = result.to || result['1'];
  const valueRaw = result.value || result['2'];
  const fromRaw = result.from || result['0'];

  if (!toRaw || !valueRaw) {
    return { ok: false, reason: 'could not read the transfer amount/destination from this transaction' };
  }
  // Addresses from the events endpoint are usually already base58 (T...);
  // normalize case for comparison either way.
  if (String(toRaw).trim().toLowerCase() !== toAddress.trim().toLowerCase()) {
    return { ok: false, reason: 'this payment was not sent to our wallet address' };
  }

  const amount = Number(valueRaw) / 10 ** USDT_DECIMALS;
  if (amount + 0.01 < minAmountUsdt) { // tiny epsilon for float rounding only
    return { ok: false, reason: `amount too low: received ${amount} USDT, expected at least ${minAmountUsdt} USDT` };
  }

  return { ok: true, amount, from: fromRaw, to: toRaw, txHash };
}

module.exports = { isConfigured, isValidAddressFormat, verifyUsdtTrc20Transfer, USDT_CONTRACT };
