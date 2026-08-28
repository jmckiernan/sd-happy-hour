function cleanString(value: unknown): string {
  return String(value ?? '').trim();
}

/** Normalizes a US phone number to E.164 (+1XXXXXXXXXX) for Twilio.
 * Returns '' for blank input, or null when the value can't be parsed. */
export function normalizeUsPhone(input: string): string | null {
  const raw = cleanString(input);
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}
