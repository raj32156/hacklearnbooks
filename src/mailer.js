// Sends the "your books are ready" email after a confirmed payment. Uses
// plain SMTP via nodemailer so it works with Gmail, Zoho Mail, SendGrid,
// Resend's SMTP endpoint, or anything else — whatever you already have.
'use strict';
const nodemailer = require('nodemailer');
const { BY_ID } = require('./catalog');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

const SITE_NAME = process.env.SITE_NAME || 'HackLearn Press';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // e.g. https://pay.hacklearnraj.in

async function sendOrderDelivery(order) {
  if (!isConfigured()) {
    console.warn(`[mailer] SMTP not configured — skipping delivery email for order ${order.id}`);
    return { sent: false, reason: 'smtp not configured' };
  }
  const books = order.book_ids.map(id => BY_ID[id]).filter(Boolean);
  const listingUrl = `${PUBLIC_BASE_URL}/download/${order.download_token}`;
  const rows = books
    .map(b => `<li>${b.title} — <a href="${PUBLIC_BASE_URL}/download/${order.download_token}?book=${b.id}">download PDF</a></li>`)
    .join('');

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto">
      <h2>Thanks for your order, ${SITE_NAME}</h2>
      <p>Your payment is confirmed. Here ${books.length > 1 ? 'are your books' : 'is your book'}:</p>
      <ul>${rows}</ul>
      <p>Or see everything in one place: <a href="${listingUrl}">${listingUrl}</a></p>
      <p style="color:#666;font-size:13px">These links stay valid for a while — save the files once downloaded.
      If a link stops working, reply to this email with your order id (${order.id}) and we'll resend it.</p>
    </div>`;

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: order.email,
    subject: `Your ${SITE_NAME} order is ready (${books.length} book${books.length > 1 ? 's' : ''})`,
    html,
  });
  return { sent: true };
}

module.exports = { isConfigured, sendOrderDelivery };
