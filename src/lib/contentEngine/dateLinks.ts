const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateKey(value: string): string | null {
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00-07:00` : value);
  if (!Number.isFinite(parsed.valueOf())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(parsed);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function variants(key: string): string[] {
  const [year, month, day] = key.split('-').map(Number);
  const long = MONTHS[month - 1];
  const short = SHORT_MONTHS[month - 1];
  const ordinal = `${day}${day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'}`;
  return [
    `${long} ${day}, ${year}`, `${short} ${day}, ${year}`, `${short}. ${day}, ${year}`,
    `${long} ${ordinal}, ${year}`, `${long} ${day}`, `${short} ${day}`,
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Makes known event dates bold and links them to durable date archives.
 * Existing Markdown links and code are preserved verbatim, which keeps this
 * safe to run repeatedly during regeneration or manual editing.
 */
export function linkAndEmphasizeDates(markdown: string, dates: string[]): string {
  const keys = [...new Set(dates.map(dateKey).filter((value): value is string => Boolean(value)))];
  if (!keys.length) return markdown;
  const replacements = keys.flatMap((key) => variants(key).map((label) => ({ key, label })))
    .sort((a, b) => b.label.length - a.label.length);
  const pattern = new RegExp(`\\b(${replacements.map((item) => escapeRegExp(item.label)).join('|')})\\b`, 'g');
  const byLabel = new Map(replacements.map((item) => [item.label.toLowerCase(), item.key]));

  const protectedParts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g);
  return protectedParts.map((part) => {
    if (part.startsWith('```') || part.startsWith('`') || /^\[[^\]]+\]\([^)]+\)$/.test(part)) return part;
    return part.replace(pattern, (label) => {
      const key = byLabel.get(label.toLowerCase());
      return key ? `**[${label}](/blog/date/${key}/)**` : label;
    });
  }).join('');
}

export function collectDateTags(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value ? dateKey(value) : null).filter((value): value is string => Boolean(value)))].sort();
}
