# HackLearn Press — Payments & Delivery Backend

Accepts payment two ways and auto-delivers the right PDF(s) the moment payment is confirmed — no manual checking required:

1. **UPI / card / netbanking via Razorpay** — customer pays, Razorpay sends a signed webhook the instant it succeeds, backend verifies it and emails the book(s).
2. **USDT (TRC20) crypto** — customer sends USDT to your Tron wallet, pastes the transaction hash, backend verifies it on-chain via TronGrid (free, public) and emails the book(s).

Both paths end the same way: a one-time download link is generated and emailed, and the order is marked `paid` → `delivered` in a local SQLite database.

Pricing is computed **server-side** from `src/books.json` + the same basket-discount tiers as the storefront (2 books → 10% off, 3 → 15%, 5 → 25%, all 18 → 40%), so nothing can be under-paid by tampering with the browser.

## What's already done

- All 18 book PDFs are bundled in `pdfs/` (current builds, matching the live page counts).
- Order creation, pricing, Razorpay order+webhook flow, TRC20 verification, anti-replay (a tx hash can never be reused on a second order), email delivery, and signed one-time download links are all written and tested (see "What was tested" below).
- **Both payment methods run in "not configured yet" mode until you add the matching environment variables** — the server starts fine and the storefront can show "coming soon" instead of crashing.

## What you still need to supply

| Variable | Where to get it | Needed for |
|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → Settings → API Keys, once your account is approved | UPI/card |
| `RAZORPAY_WEBHOOK_SECRET` | You invent this when adding `https://<your-backend>/api/webhooks/razorpay` as a webhook in Razorpay Dashboard → Settings → Webhooks, subscribed to `payment.captured` | UPI/card |
| `TRON_USDT_ADDRESS` | Your own USDT-TRC20 wallet address (starts with `T...`) | Crypto |
| `TRONGRID_API_KEY` (optional) | Free at tron grid.io — raises the free rate limit | Crypto |
| `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` | Any mailbox or email-sending service (Gmail App Password, Zoho, SendGrid, Resend, Brevo) | Delivery email |
| `ADMIN_API_KEY` | Any long random string you make up | Manual order confirm/list |

Drop these into a `.env` file locally, or your host's "Environment Variables" page when you deploy. `.env.example` lists every variable with comments.

## Deploying it (so Razorpay's webhook can actually reach it)

This has to run on a real server with a public HTTPS address 24/7 — it can't live only in a chat session, because Razorpay must be able to call it at any moment.

**Render.com (free tier, easiest):**
1. Push this folder to a GitHub repo (private is fine).
2. Render Dashboard → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add every variable from `.env.example` under Environment.
5. Add a free persistent disk mounted at `/data`, set `DATA_DIR=/data` — otherwise your order database resets on every redeploy (free-tier disks are ephemeral by default).
6. Once deployed you get a URL like `https://hacklearn-payments.onrender.com`. Set `PUBLIC_BASE_URL` to that, and use `https://hacklearn-payments.onrender.com/api/webhooks/razorpay` as the Razorpay webhook URL.

Railway.app works the same way and is just as easy; either is fine.

## Wiring it into the storefront

The static site (the one already published) needs to call this backend. Point the checkout page (`site/checkout.html`, included) at your deployed backend by setting one constant near the top of that file:

```js
const API_BASE = "https://hacklearn-payments.onrender.com"; // <- set this once deployed
```

Until you deploy a backend, leave `API_BASE` pointing at nothing real — the checkout page will show "payment is being set up, order on WhatsApp for now" and fall back to the existing WhatsApp flow automatically.

## Running it locally to test

```bash
cd payments
npm install
cp .env.example .env     # fill in whatever keys you already have
npm start                # listens on :8787
curl localhost:8787/healthz
```

`/healthz` tells you at a glance which of the three (`razorpayConfigured`, `cryptoConfigured`, `mailerConfigured`) are live.

## What was tested in this sandbox

Since this sandbox's network is restricted, I could not hit the real Razorpay or TronGrid APIs with real credentials. What I did verify end-to-end, with a running instance of this exact code:

- Pricing matches the storefront's discount tiers exactly for 1, 2, and all-18-book baskets.
- Unknown book id, bad email, and "payment method not configured yet" are all rejected with clear errors.
- A full **simulated** Razorpay webhook (correct HMAC signature) correctly marks a real pending order paid and attempts the delivery email.
- A **bad** webhook signature is rejected (400), and an **unknown** order is logged and ignored rather than crashing.
- A **duplicate** webhook delivery for an already-paid order does not re-trigger fulfilment (idempotent).
- A webhook whose paid amount doesn't match the order amount is refused and the order is left `pending` for manual review, rather than being fulfilled on partial/wrong payment.
- The crypto anti-replay check correctly refuses a transaction hash that's already attached to a different order.
- Download links correctly serve the right PDF, refuse a book not in that order, and refuse an unknown token.
- The `/api/admin/orders/:id/confirm` manual-override path (for when a webhook is missed or a crypto payment needs a human look) works and triggers the same delivery email path.

**Not yet verified against the real internet:** an actual Razorpay payment end-to-end, and an actual TronGrid lookup of a real transaction hash. The TronGrid response-parsing in `src/tron.js` is written against TronGrid's documented API shape, with comments at the top of that file explaining exactly what to check first if a real lookup ever behaves unexpectedly — and the admin manual-confirm endpoint means no order is ever stuck unpaid-looking if that happens, it just needs a 10-second manual look instead of being fully automatic. **Before go-live, send one real small UPI test payment and one real small USDT transfer and confirm both unlock the download link.**

## File map

```
payments/
  src/
    server.js     - all routes
    catalog.js     - 18-book price list + basket discount math (mirrors the storefront)
    db.js          - SQLite order store
    razorpay.js    - Razorpay order creation + webhook signature check
    tron.js        - USDT TRC20 transaction verification via TronGrid
    mailer.js      - delivery email via SMTP
    tokens.js      - one-time download token generation/expiry
    books.json     - the 18-book catalog (id, title, price, page count, pdf filename)
  pdfs/            - the 18 book PDFs themselves (served, never exposed directly)
  data/            - SQLite database file (created on first run; put on a persistent disk)
  .env.example     - every environment variable, with comments
```
