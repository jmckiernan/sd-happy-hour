import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '..', '..', '.data', 'cache', 'pages');
const TTL_OK_DAYS = 14;
const TTL_FAIL_DAYS = 3;

function key(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

function fileFor(url) {
  return path.join(CACHE_DIR, `${key(url)}.json`);
}

function binaryFileFor(url) {
  return path.join(CACHE_DIR, `${key(url)}.bin`);
}

export function readPageCache(url, { maxAgeDays } = {}) {
  try {
    const entry = JSON.parse(fs.readFileSync(fileFor(url), 'utf8'));
    const ttl = maxAgeDays ?? (entry.ok ? TTL_OK_DAYS : TTL_FAIL_DAYS);
    const ageDays = (Date.now() - Date.parse(entry.fetchedAt)) / 86_400_000;
    if (ageDays > ttl) return null;
    if (entry.hasBinary) {
      try {
        entry.bytes = fs.readFileSync(binaryFileFor(url));
      } catch {
        return null;
      }
    }
    return entry;
  } catch {
    return null;
  }
}

export function writePageCache(url, entry) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const bytes = entry.bytes;
  const serializable = { ...entry, url, fetchedAt: new Date().toISOString() };
  delete serializable.bytes;
  if (bytes && bytes.length) {
    fs.writeFileSync(binaryFileFor(url), bytes);
    serializable.hasBinary = true;
    serializable.byteLength = bytes.length;
  }
  fs.writeFileSync(fileFor(url), JSON.stringify(serializable));
}
