import assert from 'node:assert/strict';
import test from 'node:test';
import {
  absoluteAmountOf,
  classifyOffer,
  isDiscountOffer,
} from '../scripts/import-google-venues/lib/menu-price.mjs';
import { normalizeMenuBoard } from '../scripts/import-google-venues/lib/ai-extract.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();

test('an absolute price is recorded as a cost', () => {
  assert.deepEqual(classifyOffer('$8'), { kind: 'absolute', amount: 8 });
  assert.deepEqual(classifyOffer('$8.50'), { kind: 'absolute', amount: 8.5 });
  // A bare number on a menu line is a price, which is how printed menus set it.
  assert.deepEqual(classifyOffer('18'), { kind: 'absolute', amount: 18 });
});

test('a discount is recorded as a saving, not as a price', () => {
  assert.deepEqual(classifyOffer('$2 off'), { kind: 'amount_off', amountOff: 2 });
  assert.deepEqual(classifyOffer('20% off'), { kind: 'percent_off', percentOff: 20 });
  // Half off is the same statement as 50% off, so it is not a conversion.
  assert.deepEqual(classifyOffer('½ off'), { kind: 'percent_off', percentOff: 50 });
  assert.deepEqual(classifyOffer('half price'), { kind: 'percent_off', percentOff: 50 });
});

test('a discount never yields an absolute price', () => {
  // The regular price was never recorded, so "$2 off" supports no figure for
  // what the item costs. Anything that sorts or filters on price must get
  // nothing here rather than 2.
  for (const text of ['$2 off', '20% off', '½ off', 'BOGO']) {
    assert.equal(absoluteAmountOf(classifyOffer(text)), null, text);
  }
  assert.equal(absoluteAmountOf(classifyOffer('$8')), 8);
  // A range's lower bound is a price the venue actually published.
  assert.equal(absoluteAmountOf(classifyOffer('$5-$7')), 5);
});

test('an absolute price is never reported as a discount', () => {
  assert.equal(isDiscountOffer(classifyOffer('$8')), false);
  assert.equal(isDiscountOffer(classifyOffer('$5-$7')), false);
  assert.equal(isDiscountOffer(classifyOffer('$2 off')), true);
  assert.equal(isDiscountOffer(classifyOffer('20% off')), true);
});

test('spans, multiple prices and bundles keep their shape', () => {
  assert.deepEqual(classifyOffer('$5-$7'), { kind: 'range', min: 5, max: 7 });
  assert.deepEqual(classifyOffer('$8 | $6'), { kind: 'multi', amounts: [8, 6] });
  assert.deepEqual(classifyOffer('2 for $10'), { kind: 'bundle', quantity: 2, amount: 10 });
  assert.deepEqual(classifyOffer('Buy 5 Get 5 Free'), {
    kind: 'bundle',
    quantity: 5,
    freeQuantity: 5,
  });
});

test('text that fits no kind is left unclassified rather than guessed', () => {
  // Guessing a kind here is worse than leaving it: the board would typeset an
  // ingredient list as a confident price. These are for a human to look at.
  for (const text of ['$6/5 Wings', 'avocado, red onion, toma', 'priced fair', '', null]) {
    assert.equal(classifyOffer(text), null, JSON.stringify(text));
  }
});

test('transcription stores the offer alongside the printed text', () => {
  const board = normalizeMenuBoard({
    sections: [
      {
        title: 'Drinks',
        items: [
          { name: 'Draft pints', price: '$2 off' },
          { name: 'House wine', price: '$7' },
        ],
      },
    ],
  });
  const [discount, absolute] = board.sections[0].items;
  // The venue's own wording survives; the meaning is recorded beside it.
  assert.equal(discount.price, '$2 off');
  assert.deepEqual(discount.offer, { kind: 'amount_off', amountOff: 2 });
  assert.equal(absolute.price, '$7');
  assert.deepEqual(absolute.offer, { kind: 'absolute', amount: 7 });
});

test('a model kind that contradicts the printed text is not stored', () => {
  // The text is the evidence. If the model calls "$7" a discount, one of the
  // two is wrong and we cannot tell which, so neither reading is recorded.
  const board = normalizeMenuBoard({
    sections: [
      {
        title: 'Drinks',
        items: [
          { name: 'Mystery', price: '$7', priceKind: 'amount_off' },
          { name: 'Agreed', price: '$7', priceKind: 'absolute' },
        ],
      },
    ],
  });
  const [contradicted, agreed] = board.sections[0].items;
  assert.equal(contradicted.offer, undefined);
  assert.deepEqual(agreed.offer, { kind: 'absolute', amount: 7 });
});

test('the board sets a discount apart from a price', async () => {
  const source = await readFile(
    path.join(ROOT, 'scripts/import-google-venues/lib/menu-board-image.mjs'),
    'utf8'
  );
  // Someone reading a zoomed board must not take "$2 off" for a $2 item, so the
  // two carry different classes and the stylesheet distinguishes them.
  assert.match(source, /item-discount/);
  assert.match(source, /amount_off|percent_off/);
});

test('every stored menu price agrees with its recorded offer', async () => {
  const venues = JSON.parse(
    await readFile(path.join(ROOT, 'public/data/happy-hours.json'), 'utf8')
  );
  const mismatches = [];
  let discounts = 0;
  for (const venue of venues) {
    for (const section of venue.hhMenu?.sections || []) {
      for (const item of section.items || []) {
        const expected = classifyOffer(item.price);
        if (JSON.stringify(expected || undefined) !== JSON.stringify(item.offer)) {
          mismatches.push(`${venue.id} ${venue.name}: "${item.price}"`);
        }
        if (isDiscountOffer(item.offer)) discounts += 1;
      }
    }
  }
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} price(s) disagree with their offer`);
  // The catalog really does publish happy hours as discounts, so the discount
  // path is not dead code guarded by a test that would pass on an empty set.
  assert.ok(discounts > 100, `expected many discount items, found ${discounts}`);
});

test('schema.org only claims a price for an absolute offer', async () => {
  const source = await readFile(path.join(ROOT, 'src/lib/seo.ts'), 'utf8');
  // Publishing a discount's figure as an Offer price tells Google the item
  // costs $2 when it costs $2 less than usual.
  assert.match(source, /offer\?\.kind === 'absolute'/);
});
