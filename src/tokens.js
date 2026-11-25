// Random, unguessable download tokens. Not JWTs — a single random token per
// order, stored in the DB and looked up directly, which is simpler to reason
// about and just as secure for this use case (no client-side state to trust).
'use strict';
const crypto = require('crypto');

function newDownloadToken() {
  return crypto.randomBytes(24).toString('base64url'); // 32 chars, URL-safe
}

const DOWNLOAD_LINK_VALID_DAYS = Number(process.env.DOWNLOAD_LINK_VALID_DAYS || 30);

function isExpired(paidAtIso) {
  if (!paidAtIso) return true;
  const paidAt = new Date(paidAtIso).getTime();
  const maxAge = DOWNLOAD_LINK_VALID_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - paidAt > maxAge;
}

module.exports = { newDownloadToken, isExpired, DOWNLOAD_LINK_VALID_DAYS };
