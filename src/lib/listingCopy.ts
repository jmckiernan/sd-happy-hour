// Shared user-facing listing strings.
//
// Kept apart from lib/venues.ts for the same reason as lib/vibeImages.ts: that
// module imports public/data/happy-hours.json, so anything the browser bundles
// would drag the entire venue dataset along with it.

/**
 * Venue-page copy when we know the window but the source never listed offers.
 * Browse cards use {@link cardSpecials} instead, which says "Happy hour".
 */
export const DEALS_UNKNOWN_LABEL = 'Deals not listed — check with venue';

/** Homepage / map chip when times are verified but no offer lines exist. */
export const CARD_DEAL_FALLBACK = 'Happy hour';

const LEADING_FLUFF = /^(?:try|order|relax with|indulge with|enjoy|savor|sip(?: on)?|grab|get)\s+/i;
const LEADING_DET = /^(?:our|a couple(?: of)?|some|the|these)\s+/i;
const SPELLED_PRICE = /\b(?:a |an )?(?:five|six|seven|eight|nine|ten|eleven|twelve)\s+dollars?\b/gi;
const FOR_BUCKS = /\s+for (?:five|six|seven|eight|nine|ten) bucks\b/gi;
const LEADING_PROPER = /^(?:[A-Z][\w'’]*(?:['’]s)?(?:\s+[A-Z][\w'’]*(?:['’]s)?){0,3})\s+/;

function peelFluff(rest: string) {
  let value = rest.replace(/\s+/g, ' ').trim();
  const question = value.lastIndexOf('?');
  if (question !== -1) value = value.slice(question + 1).trim();
  value = value.replace(LEADING_FLUFF, '');
  value = value.replace(LEADING_DET, '');
  value = value.replace(SPELLED_PRICE, '').replace(FOR_BUCKS, '');
  value = value.replace(LEADING_PROPER, '');
  return value.replace(/\s+/g, ' ').trim().replace(/[!.]+$/g, '');
}

/**
 * Pull a price+item chip out of "$5: marketing sentence" copy when we can
 * do it cleanly. Never truncate mid-phrase — leftover long copy is rewritten
 * by Haiku into stored deals, not clipped in the UI.
 */
export function shortDealLabel(raw: string): string {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const priced = text.match(/^(\$\s?\d+(?:\.\d{2})?)\s*:\s*(.+)$/);
  if (priced) {
    const price = priced[1].replace(/\s/g, '');
    const rest = peelFluff(priced[2]);
    const next = rest ? `${price} ${rest}` : price;
    if (next.length <= 42 && !next.includes('?')) return next;
  }

  return text;
}

function expandDealLines(deals: string[], max = 3): string[] {
  const chips: string[] = [];
  for (const deal of deals) {
    const parts = String(deal).includes('|') ? String(deal).split('|') : [deal];
    for (const part of parts) {
      const label = shortDealLabel(part);
      if (label && !chips.includes(label)) chips.push(label);
      if (chips.length >= max) return chips;
    }
  }
  return chips;
}

export type WeeklySpecialKind =
  | 'named_night'
  | 'exchange'
  | 'fixed_price'
  | 'food'
  | 'venue_note'
  | 'event';

export interface WeeklySpecial {
  id: string;
  label: string;
  days: string[];
  occasion?: 'game_day' | null;
  kind: WeeklySpecialKind;
  summary: string;
  details: string[];
  startTime?: string | null;
  endTime?: string | null;
  allDay?: boolean;
  untilClose?: boolean;
  pricing?: 'fixed' | 'dynamic';
  sourceUrl?: string;
  sourceImages?: string[];
}

export interface SpecialsVenue {
  deals?: string[];
  weeklySpecials?: WeeklySpecial[];
  startTime?: string;
  endTime?: string;
}

function formatClock(value?: string | null) {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return '';
  const [h, m] = value.split(':').map(Number);
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function specialsOnDay(specials: WeeklySpecial[], weekday?: string) {
  if (!weekday) return [];
  return specials.filter((row) => (row.days || []).includes(weekday));
}

/**
 * Three chips max for homepage / map cards. Prefer today's named night and
 * exchange; otherwise the weekly headlines. Full day-by-day copy belongs on
 * the venue page. Verified hours with no offer lines show "Happy hour".
 */
export function cardSpecials(venue: SpecialsVenue, weekday?: string): string[] {
  const specials = venue.weeklySpecials || [];
  if (specials.length) {
    const today = specialsOnDay(specials, weekday).filter((row) => row.kind !== 'event');
    const chips: string[] = [];
    const take = (row?: WeeklySpecial) => {
      const label = shortDealLabel(row?.summary || row?.label || '');
      if (label && !chips.includes(label)) chips.push(label);
    };

    take(today.find((row) => row.kind === 'named_night' || row.kind === 'food' || row.kind === 'fixed_price'));
    take(today.find((row) => row.kind === 'exchange'));
    take(today.find((row) => row.kind === 'venue_note'));

    if (!chips.length) {
      for (const row of specials) {
        if (row.kind === 'exchange' || row.kind === 'event') continue;
        take(row);
        if (chips.length >= 2) break;
      }
      if (specials.some((row) => row.kind === 'exchange')) {
        chips.push('Drink Exchange most days');
      }
    }

    if (chips.length) return chips.slice(0, 3);
  }

  const fromDeals = expandDealLines(venue.deals || [], 3);
  return fromDeals.length ? fromDeals : [CARD_DEAL_FALLBACK];
}

/** Venue page uses the same chips as the card, just more of them (up to 6). */
export function venueDealLines(venue: SpecialsVenue): string[] {
  const fromDeals = expandDealLines(venue.deals || [], 6);
  return fromDeals.length ? fromDeals : [CARD_DEAL_FALLBACK];
}

/** Time badge on a card: today's special window when we have one. */
export function cardTimeLabel(venue: SpecialsVenue, weekday?: string): string {
  const today = specialsOnDay(venue.weeklySpecials || [], weekday);
  const timed = today.find((row) => row.kind === 'exchange' && (row.allDay || row.startTime))
    || today.find((row) => row.startTime || row.allDay);
  if (timed?.allDay) return 'All day';
  if (timed?.startTime) {
    const start = formatClock(timed.startTime);
    const end = timed.untilClose ? 'close' : formatClock(timed.endTime);
    return end ? `${start} – ${end}` : start;
  }
  if (venue.startTime && venue.endTime) {
    return `${formatClock(venue.startTime)} – ${formatClock(venue.endTime)}`;
  }
  return '';
}

export function specialsByDay(specials: WeeklySpecial[] = [], dayNames: string[]) {
  return dayNames.map((day) => ({
    day,
    items: specials.filter((row) => (row.days || []).includes(day)),
  })).filter((group) => group.items.length);
}

export function occasionSpecials(specials: WeeklySpecial[] = []) {
  return specials.filter((row) => row.occasion && !(row.days || []).length);
}
