// Manual UPI payment support — a stopgap until Razorpay is approved.
//
// IMPORTANT HONESTY NOTE: unlike Razorpay (signed webhook) or crypto
// (on-chain lookup via tron.js), there is no API that lets this server check
// a personal UPI ID's incoming payments automatically. This module only
// builds the UPI deep link / QR payload and the eligibility check — the
// actual confirmation that money arrived is a human (the store owner)
// looking at the uploaded screenshot + UTR on the admin dashboard and
// clicking Approve. Screenshots are not cryptographic proof; this exists to
// make that manual review fast and safe (anti-replay on UTR), not to claim
// automatic verification.
'use strict';

function isConfigured() {
  return !!process.env.UPI_VPA;
}

// Standard UPI deep-link format. Any UPI app (GPay/PhonePe/Paytm/etc.) that
// scans this QR will prefill the amount and a note — it does not grant any
// server-side confirmation by itself.
function buildUpiLink({ amountInr, orderId }) {
  const vpa = process.env.UPI_VPA;
  const payeeName = process.env.UPI_PAYEE_NAME || 'HackLearn Press';
  const params = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: String(amountInr),
    cu: 'INR',
    tn: `HackLearn ${orderId.slice(0, 8)}`,
  });
  return `upi://pay?${params.toString()}`;
}

module.exports = { isConfigured, buildUpiLink };
