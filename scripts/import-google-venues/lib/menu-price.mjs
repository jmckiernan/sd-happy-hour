/**
 * What a happy-hour menu line is actually offering.
 *
 * `price` was typed and named as though every item costs a dollar figure, but a
 * discount off the regular price is just as normal a way to publish a happy
 * hour — "$2 off all pints" is the whole offer, not a half-recorded one — and
 * 547 stored items are of that shape. Flattening the two into one string means
 * the board typesets "$2 off" in the slot built for "$8", and anything that
 * ever sorts or filters on price sees "$2" where the item may cost $10.
 *
 * So the printed text stays exactly as the venue wrote it, in `price`, and this
 * says what that text *means* alongside it. The rule throughout: never convert
 * between the two. We do not know the regular price, so a discount can never
 * yield an absolute figure, and an absolute figure can never yield a saving.
 *
 * Kinds:
 *   absolute    the item costs this during happy hour        "$8"
 *   amount_off  this much off the regular price              "$2 off"
 *   percent_off this share off the regular price             "20% off", "½ off"
 *   range       the venue published a span                   "$5–$7"
 *   multi       several prices, undistinguished by the page  "$8 | $6"
 *   bundle      a quantity deal                              "2 for $10", "2 for 1"
 *
 * `null` means the text is not confidently any of these. That is deliberate and
 * must stay: an unrecognized price is left unclassified for a human rather than
 * guessed into a kind, because a wrong kind renders as a confident lie.
 */

const MONEY = String.raw`\$\s?(\d+(?:\.\d{1,2})?)`;

const RULES = [
  // "$8", "8.50" — a bare number on a menu line is a price.
  [new RegExp(`^${MONEY}$`), (m) => ({ kind: 'absolute', amount: Number(m[1]) })],
  [/^(\d+(?:\.\d{2})?)$/, (m) => ({ kind: 'absolute', amount: Number(m[1]) })],

  // "$2 off", "$2.50 off"
  [new RegExp(`^${MONEY}\\s*off$`, 'i'), (m) => ({ kind: 'amount_off', amountOff: Number(m[1]) })],

  // "20% off". Half off is 50% off — the same statement, not a conversion.
  [/^(\d{1,2})\s*%\s*off$/i, (m) => ({ kind: 'percent_off', percentOff: Number(m[1]) })],
  [/^(?:½|1\/2|half)[\s-]*(?:off|price)$/i, () => ({ kind: 'percent_off', percentOff: 50 })],
  [/^(?:½|1\/2|half)[\s-]*off\s+.*$/i, () => ({ kind: 'percent_off', percentOff: 50 })],

  // "$5-$7", "$10–35"
  [
    new RegExp(`^${MONEY}\\s*[-–—]\\s*\\$?(\\d+(?:\\.\\d{1,2})?)$`),
    (m) => ({ kind: 'range', min: Number(m[1]), max: Number(m[2]) }),
  ],

  // "$8 | $6" — two prices whose distinction (glass/bottle, size) the page did
  // not carry into the transcription, so neither is singled out as *the* price.
  [
    new RegExp(`^${MONEY}(?:\\s*\\|\\s*\\$?(\\d+(?:\\.\\d{1,2})?))+$`),
    (m, raw) => ({
      kind: 'multi',
      amounts: [...raw.matchAll(/\d+(?:\.\d{1,2})?/g)].map((x) => Number(x[0])),
    }),
  ],

  // "2 for $10"
  [
    new RegExp(`^(\\d+)\\s*for\\s*${MONEY}$`, 'i'),
    (m) => ({ kind: 'bundle', quantity: Number(m[1]), amount: Number(m[2]) }),
  ],
  // "2 for 1", "BOGO" — a quantity deal with no figure to record.
  [/^(?:bogo|buy\s*one\s*get\s*one(?:\s*free)?)$/i, () => ({ kind: 'bundle' })],
  [/^(\d+)\s*for\s*(\d+)$/i, (m) => ({ kind: 'bundle', quantity: Number(m[1]), forQuantity: Number(m[2]) })],
  // "Buy 5 Get 5 Free"
  [
    /^buy\s*(\d+)\s*get\s*(\d+)\s*free$/i,
    (m) => ({ kind: 'bundle', quantity: Number(m[1]), freeQuantity: Number(m[2]) }),
  ],
];

/**
 * Classify a printed price string. Returns null when nothing matches
 * confidently, which the caller must treat as "unknown", never as absolute.
 */
export function classifyOffer(priceText) {
  const raw = String(priceText ?? '').trim();
  if (!raw) return null;
  for (const [pattern, build] of RULES) {
    const match = pattern.exec(raw);
    if (match) return build(match, raw);
  }
  return null;
}

/** Does this offer state a figure the item costs, fit for numeric comparison? */
export function absoluteAmountOf(offer) {
  if (!offer) return null;
  if (offer.kind === 'absolute') return offer.amount ?? null;
  // A range's lower bound is a real price the venue published, so it is the
  // honest value to sort by. A discount has none: we never learned the regular
  // price, so there is no figure to compare and callers must not invent one.
  if (offer.kind === 'range') return offer.min ?? null;
  if (offer.kind === 'multi') return Math.min(...(offer.amounts || [])) || null;
  return null;
}

/** True when the offer is a reduction off a price we never recorded. */
export function isDiscountOffer(offer) {
  return offer?.kind === 'amount_off' || offer?.kind === 'percent_off';
}
