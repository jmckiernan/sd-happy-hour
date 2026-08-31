// Venue id allocation, kept in one place so every script that mints an id mints
// it from the same reserved band. See VENUE_ID_BAND in constants.mjs for why the
// band exists.

import { VENUE_ID_BAND } from './constants.mjs';

/** Highest id already used inside the band, or null if the catalog has none. */
export function highestIdInBand(venues, band = VENUE_ID_BAND) {
  let highest = null;
  for (const venue of venues || []) {
    const id = Number(venue?.id);
    if (!Number.isInteger(id)) continue;
    if (id < band.start || id > band.end) continue;
    if (highest === null || id > highest) highest = id;
  }
  return highest;
}

/**
 * Hand out ids one at a time, starting after the highest id this city already
 * uses. Throws rather than crossing the end of the band: a run that stops with
 * an error can be resumed after the band is widened, whereas one that quietly
 * mints another city's ids is only noticed once the two catalogs are merged.
 *
 * `peek` reads the id a record would get and `take` consumes it, so a record
 * that fails normalization after being numbered does not burn an id.
 */
export function createVenueIdAllocator(venues, band = VENUE_ID_BAND) {
  const highest = highestIdInBand(venues, band);
  let next = highest === null ? band.start : highest + 1;

  function peek() {
    if (next > band.end) {
      throw new Error(
        `Venue id ${next} is outside this city's reserved band ${band.start}–${band.end}. ` +
        'Widen VENUE_ID_BAND in lib/constants.mjs (and make sure no other city owns the ' +
        'range you widen into) before allocating more ids.'
      );
    }
    return next;
  }

  return {
    peek,
    take() {
      const id = peek();
      next += 1;
      return id;
    },
  };
}
