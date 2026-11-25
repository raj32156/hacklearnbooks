// Product catalog + pricing. This MIRRORS the discount logic in the public
// site's JS (const TIERS / const PACKS in site/index.html) so that a basket
// total computed here always matches what the customer was shown. NEVER
// trust a total sent from the browser — always recompute it here.
'use strict';
const fs = require('fs');
const path = require('path');

const BOOKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'books.json'), 'utf8'));
const BY_ID = Object.fromEntries(BOOKS.map(b => [b.id, b]));

// Same basket-discount tiers as the storefront: [minBooks, percentOff], checked largest-first.
const TIERS = [[18, 40], [5, 25], [3, 15], [2, 10]];

function discountPercent(n) {
  for (const [t, p] of TIERS) if (n >= t) return p;
  return 0;
}

// Validate and price a basket of book ids. Throws on an unknown id.
function priceBasket(ids) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) throw new Error('empty basket');
  const items = uniqueIds.map(id => {
    const b = BY_ID[id];
    if (!b) throw new Error(`unknown book id: ${id}`);
    return b;
  });
  const sumInr = items.reduce((a, b) => a + b.priceInr, 0);
  const pct = discountPercent(items.length);
  const totalInr = Math.round(sumInr * (100 - pct) / 100);
  return { ids: uniqueIds, items, sumInr, discountPercent: pct, totalInr };
}

module.exports = { BOOKS, BY_ID, TIERS, discountPercent, priceBasket };
