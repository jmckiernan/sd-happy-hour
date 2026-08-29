import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ROOT_DIR } from './constants.mjs';
import { writeJson } from './io.mjs';

const execFileAsync = promisify(execFile);
export const REFRESH_STATUS_PATH = path.join(ROOT_DIR, '.data', 'import', 'refresh-status.json');

/**
 * Fail loudly when a long import cannot continue. Writes a status file,
 * rings the terminal bell, and shows a macOS notification when possible.
 */
export async function alertOperator({ title, body, extra = {} }) {
  const message = String(body || title || 'Import stopped');
  console.error(`\n${'='.repeat(72)}`);
  console.error(`STOPPED: ${title}`);
  console.error(message);
  console.error('='.repeat(72));
  try {
    process.stderr.write('\u0007');
  } catch {
    // ignore
  }

  writeJson(REFRESH_STATUS_PATH, {
    stoppedAt: new Date().toISOString(),
    title,
    body: message,
    ...extra,
  });

  try {
    await execFileAsync('osascript', [
      '-e',
      `display notification ${JSON.stringify(message.slice(0, 200))} with title ${JSON.stringify(title)} sound name "Basso"`,
    ], { timeout: 5000 });
  } catch {
    // Linux/CI, or notification permission denied
  }
}
