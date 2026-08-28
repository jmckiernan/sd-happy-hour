import assert from 'node:assert/strict';
import {
  DIRECTORY_FILTERS_STORAGE_KEY,
  mergeDirectoryFilters,
  parseDirectoryFilters,
  readStoredDirectoryFilters,
  writeStoredDirectoryFilters,
} from '../src/lib/directoryFilters.ts';

const storage = new Map();

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`fail ${name}`);
    throw error;
  }
}

test('parseDirectoryFilters validates nearMe coordinates', () => {
  const parsed = parseDirectoryFilters(JSON.stringify({
    search: 'oysters',
    nearMe: { lat: 32.7, lng: -117.1 },
    view: 'map',
  }));
  assert.equal(parsed?.search, 'oysters');
  assert.deepEqual(parsed?.nearMe, { lat: 32.7, lng: -117.1 });
  assert.equal(parsed?.view, 'map');
});

test('parseDirectoryFilters rejects invalid payloads', () => {
  assert.equal(parseDirectoryFilters('{not-json'), null);
  assert.equal(parseDirectoryFilters(JSON.stringify({ nearMe: { lat: 'bad', lng: 1 } }))?.nearMe, undefined);
});

test('read and write round-trip through storage', () => {
  storage.clear();
  const fakeStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };

  writeStoredDirectoryFilters({
    day: 'Friday',
    neighborhood: 'North Park',
    nearMe: null,
    view: 'list',
  }, fakeStorage);

  assert.equal(fakeStorage.getItem(DIRECTORY_FILTERS_STORAGE_KEY)?.includes('North Park'), true);
  assert.deepEqual(readStoredDirectoryFilters(fakeStorage), {
    day: 'Friday',
    neighborhood: 'North Park',
    nearMe: null,
    view: 'list',
  });
});

test('mergeDirectoryFilters keeps prior keys', () => {
  assert.deepEqual(
    mergeDirectoryFilters({ search: 'beer', day: 'Monday' }, { neighborhood: 'PB' }),
    { search: 'beer', day: 'Monday', neighborhood: 'PB' },
  );
});

console.log('directoryFilters tests passed');
