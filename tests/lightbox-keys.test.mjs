// Tests for src/lib/lightboxKeys.ts — what a keypress means to the photo
// lightbox on a venue page. Worth real tests because the failure mode is
// silent and hostile: a key the viewer misreads can throw someone out of a
// menu they were in the middle of reading.
//
// Run with `npm run test:lightbox-keys`, which bundles through esbuild first
// since this imports TypeScript directly.
import { lightboxKeyAction } from '../src/lib/lightboxKeys.ts';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (!condition) {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  } else {
    console.log(`ok   ${name} ${detail}`);
  }
};

const action = (key, code) => lightboxKeyAction({ key, code });

// --- the shortcuts the overlay documents ----------------------------------
check('escape closes', action('Escape') === 'close');
check('tab traps focus', action('Tab') === 'focus-trap');
check('left goes back', action('ArrowLeft') === 'previous');
check('right goes forward', action('ArrowRight') === 'next');
check('plus zooms in', action('+', 'Equal') === 'zoom-in');
check('minus zooms out', action('-', 'Minus') === 'zoom-out');
check('zero refits', action('0', 'Digit0') === 'zoom-reset');

// --- the same intent from a different keyboard ----------------------------
// `+` is Shift+= on a US layout and lives elsewhere on others, so the
// unshifted key and the numeric keypad have to mean the same thing.
check('unshifted equals zooms in', action('=', 'Equal') === 'zoom-in');
check('underscore zooms out', action('_', 'Minus') === 'zoom-out');
check('keypad plus zooms in', action('+', 'NumpadAdd') === 'zoom-in');
check('keypad minus zooms out', action('-', 'NumpadSubtract') === 'zoom-out');
check('keypad zero refits', action('0', 'Numpad0') === 'zoom-reset');
// Layouts where the keypad reports a legacy key name rather than a character.
check('legacy Add zooms in', action('Add', 'NumpadAdd') === 'zoom-in');
check('legacy Subtract zooms out', action('Subtract', 'NumpadSubtract') === 'zoom-out');
// Physical key alone, for layouts that produce some other character there.
check('keypad code alone zooms in', action('Unidentified', 'NumpadAdd') === 'zoom-in');

// --- everything else has to do nothing ------------------------------------
// This is the actual guarantee: an unrecognised key must not resolve to any
// action, least of all 'close'.
const strays = [
  ['a', 'KeyA'], ['Z', 'KeyZ'], ['1', 'Digit1'], ['9', 'Digit9'],
  ['Enter', 'Enter'], [' ', 'Space'], ['Backspace', 'Backspace'],
  ['Shift', 'ShiftLeft'], ['Control', 'ControlLeft'], ['Meta', 'MetaLeft'],
  ['ArrowUp', 'ArrowUp'], ['ArrowDown', 'ArrowDown'],
  ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
  ['F5', 'F5'], ['/', 'Slash'], ['*', 'NumpadMultiply'], ['é', 'KeyE'], ['', ''],
];
for (const [key, code] of strays) {
  check(`stray key does nothing: ${JSON.stringify(key)}`, action(key, code) === null);
}
check('no key and no code does nothing', lightboxKeyAction({ key: 'q' }) === null);
check('unknown key with unknown code does nothing', action('q', 'KeyQ') === null);

// Nothing outside the documented set may ever mean 'close'.
const closers = strays.filter(([key, code]) => action(key, code) === 'close');
check('only escape closes', closers.length === 0, closers.map(([k]) => k).join(','));

console.log(failures ? `\n${failures} failing check(s)` : '\nAll lightbox key checks passed');
process.exit(failures ? 1 : 0);
