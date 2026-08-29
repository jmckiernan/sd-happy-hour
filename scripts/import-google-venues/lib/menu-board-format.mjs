/**
 * Presentation helpers shared by the menu-board renderer and its tests.
 *
 * Boards are the images we generate ourselves when a venue publishes its
 * happy hour as HTML instead of a flyer, so every string here is customer
 * facing: 12-hour clock only, day spans collapsed, no pipeline jargon.
 */

import { DAY_NAMES } from './constants.mjs';

const DAY_SHORT = {
  Sunday: 'Sun',
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
};

/** "17:30" → "5:30 PM". Whole hours drop the ":00" ("15:00" → "3 PM"). */
export function formatClock(time) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time || '').trim());
  if (!match) return '';
  const hour24 = Number(match[1]);
  const minute = match[2];
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === '00' ? `${hour12} ${suffix}` : `${hour12}:${minute} ${suffix}`;
}

/**
 * Collapse a day list into the shortest honest label: "Daily",
 * "Mon–Fri", "Sun–Thu", or "Mon, Wed, Fri" when the days aren't adjacent.
 * Weeks wrap, so Friday–Monday reads as one span rather than two.
 */
export function formatDays(days = []) {
  const present = DAY_NAMES.filter((day) => (days || []).includes(day));
  if (!present.length) return '';
  if (present.length === 7) return 'Daily';

  const indexes = present.map((day) => DAY_NAMES.indexOf(day)).sort((a, b) => a - b);
  const spans = [];
  for (const index of indexes) {
    const last = spans[spans.length - 1];
    if (last && index === last[last.length - 1] + 1) last.push(index);
    else spans.push([index]);
  }
  // Sun and Sat in separate spans are really one weekend span across the wrap.
  if (spans.length > 1 && spans[0][0] === 0 && spans[spans.length - 1].at(-1) === 6) {
    const first = spans.shift();
    spans[spans.length - 1].push(...first);
  }

  return spans
    .map((span) => {
      const names = span.map((index) => DAY_SHORT[DAY_NAMES[index]]);
      if (span.length === 1) return names[0];
      if (span.length === 2) return names.join(', ');
      return `${names[0]}–${names[names.length - 1]}`;
    })
    .join(', ');
}

/** One window as a customer-facing line: "Mon–Fri 3–6 PM", "Sun–Thu Open until 7 PM". */
export function formatWindow(window) {
  if (!window) return '';
  const days = formatDays(window.days);
  if (window.allDay) return [days, 'all day'].filter(Boolean).join(' ');

  const end = formatClock(window.endTime);
  if (window.startsAtOpen) {
    const line = end ? `Open until ${end}` : 'Open until close';
    return [days, line].filter(Boolean).join(' ');
  }

  const start = formatClock(window.startTime);
  if (!start) return days;
  // 23:59 is how the pipeline stores "runs until we close"; printing the clock
  // time promises a minute of service no bar actually keeps.
  if (window.endTime === '23:59') return [days, `${start}–Close`].filter(Boolean).join(' ');
  if (!end) return days;
  // "3 PM–6 PM" reads better as "3–6 PM" when both sides share a meridiem.
  const suffix = start.slice(-2);
  const range = suffix === end.slice(-2)
    ? `${start.slice(0, -3)}–${end}`
    : `${start}–${end}`;
  return [days, range].filter(Boolean).join(' ');
}

/** Every window on one board, most important first. */
export function formatWindows(windows = [], maxWindows = 3) {
  return (windows || [])
    .slice(0, maxWindows)
    .map((window) => formatWindow(window))
    .filter(Boolean);
}

/**
 * Last-resort board built from the directory chips. Chips are a summary, so
 * this is much thinner than a transcribed menu — only used when neither a
 * flyer nor a menu transcription is available.
 */
export function menuBoardFromDealLines(deals = []) {
  const items = (deals || [])
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((name) => ({ name, price: '' }));
  if (items.length < 2) return null;
  return { note: '', sections: [{ title: 'Specials', items }], fromDealChips: true };
}
