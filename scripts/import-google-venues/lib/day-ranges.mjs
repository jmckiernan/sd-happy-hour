/**
 * Read a weekday list out of the words a venue actually used.
 *
 * Lives on its own (rather than in happy-hour.mjs) so the schedule repairs in
 * schedule-windows.mjs can reconcile a model's day list against the evidence
 * quote without the two modules importing each other.
 */

import { DAY_ABBR, DAY_NAMES } from './constants.mjs';

/** @returns {string[]|null} day names in week order, or null when the text names none. */
export function daysFromRangeText(text) {
  const lower = String(text || '').toLowerCase();
  if (/daily|every\s*day|7\s*days|all\s*week/i.test(lower)) {
    return [...DAY_NAMES.slice(1), DAY_NAMES[0]];
  }
  if (
    /mon(?:day)?\s*(?:[-–—]|to|through)\s*(?:fri|friday)/i.test(lower)
    || /weekdays?/i.test(lower)
  ) {
    return DAY_NAMES.slice(1, 6);
  }
  if (/mon(?:day)?\s*[-–—to]+\s*(?:sun|sunday)/i.test(lower)) {
    return DAY_NAMES.slice(1).concat(DAY_NAMES[0]);
  }

  const dayRangeMatch = lower.match(
    /\b(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\s*[-–—to]+\s*(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/i
  );
  if (dayRangeMatch) {
    const startKey = dayRangeMatch[1].slice(0, 3).toLowerCase();
    const endKey = dayRangeMatch[2].slice(0, 3).toLowerCase();
    const startIdx = DAY_ABBR[startKey];
    const endIdx = DAY_ABBR[endKey];
    if (startIdx !== undefined && endIdx !== undefined) {
      const days = [];
      for (let i = startIdx; ; i = (i + 1) % 7) {
        days.push(DAY_NAMES[i]);
        if (i === endIdx) break;
      }
      return days;
    }
  }

  const days = new Set();
  for (const [abbr, index] of Object.entries(DAY_ABBR)) {
    const re = new RegExp(`\\b${abbr}\\b`, 'i');
    if (re.test(lower)) days.add(DAY_NAMES[index]);
  }
  if (days.size) return DAY_NAMES.filter((day) => days.has(day));
  return null;
}

/**
 * True when `days` is a contiguous run of `range` that reaches both ends —
 * i.e. the same range with interior days missing, not a different schedule.
 */
export function isGappedSubrange(days = [], range = []) {
  if (!Array.isArray(days) || !Array.isArray(range)) return false;
  if (days.length < 2 || days.length >= range.length) return false;
  if (!days.every((day) => range.includes(day))) return false;
  return days.includes(range[0]) && days.includes(range[range.length - 1]);
}
