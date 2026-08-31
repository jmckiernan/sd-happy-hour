/**
 * What a keypress means to the photo lightbox.
 *
 * Kept apart from the overlay itself so the mapping can be tested without a
 * browser, and so it is one list rather than a chain of conditions where a key
 * can accidentally pick up another key's branch. A key this file does not
 * recognise returns null, and the overlay does nothing with it: the one thing a
 * viewer must never do is dismiss itself because someone pressed a key it had
 * no opinion about.
 */
export type LightboxKeyAction =
  | 'close'
  | 'focus-trap'
  | 'previous'
  | 'next'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

/** Only `key` and `code` are read, so tests can pass a plain object. */
export type LightboxKeyEvent = { key: string; code?: string };

/* Zoom is the one shortcut whose key depends on the keyboard. `+` needs Shift
 * on a US layout and lives elsewhere entirely on others, so the unshifted `=`
 * and the numeric keypad are accepted as the same request, by physical key
 * where the character would differ. */
const BY_KEY: Record<string, LightboxKeyAction> = {
  Escape: 'close',
  Tab: 'focus-trap',
  ArrowLeft: 'previous',
  ArrowRight: 'next',
  '+': 'zoom-in',
  '=': 'zoom-in',
  Add: 'zoom-in',
  '-': 'zoom-out',
  _: 'zoom-out',
  Subtract: 'zoom-out',
  '0': 'zoom-reset',
};

const BY_CODE: Record<string, LightboxKeyAction> = {
  NumpadAdd: 'zoom-in',
  NumpadSubtract: 'zoom-out',
  Numpad0: 'zoom-reset',
};

export function lightboxKeyAction(event: LightboxKeyEvent): LightboxKeyAction | null {
  return BY_KEY[event.key] ?? (event.code ? BY_CODE[event.code] ?? null : null);
}
