export const DIRECTORY_FILTERS_STORAGE_KEY = 'sdhh_directory_filters_v1';

export type DirectoryViewMode = 'list' | 'map';

export interface DirectoryNearMe {
  lat: number;
  lng: number;
}

export interface DirectoryFiltersState {
  search?: string;
  day?: string;
  neighborhood?: string;
  dealType?: string;
  feature?: string;
  status?: string;
  trust?: string;
  nearMe?: DirectoryNearMe | null;
  view?: DirectoryViewMode;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseDirectoryFilters(raw: string | null): DirectoryFiltersState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DirectoryFiltersState;
    if (!parsed || typeof parsed !== 'object') return null;

    const state: DirectoryFiltersState = {};
    const search = cleanString(parsed.search);
    const day = cleanString(parsed.day);
    const neighborhood = cleanString(parsed.neighborhood);
    const dealType = cleanString(parsed.dealType);
    const feature = cleanString(parsed.feature);
    const status = cleanString(parsed.status);
    const trust = cleanString(parsed.trust);

    if (search !== undefined) state.search = search;
    if (day !== undefined) state.day = day;
    if (neighborhood !== undefined) state.neighborhood = neighborhood;
    if (dealType !== undefined) state.dealType = dealType;
    if (feature !== undefined) state.feature = feature;
    if (status !== undefined) state.status = status;
    if (trust !== undefined) state.trust = trust;

    if (parsed.nearMe === null) {
      state.nearMe = null;
    } else if (
      parsed.nearMe
      && isFiniteNumber(parsed.nearMe.lat)
      && isFiniteNumber(parsed.nearMe.lng)
    ) {
      state.nearMe = { lat: parsed.nearMe.lat, lng: parsed.nearMe.lng };
    }

    if (parsed.view === 'list' || parsed.view === 'map') {
      state.view = parsed.view;
    }

    return state;
  } catch {
    return null;
  }
}

export function serializeDirectoryFilters(state: DirectoryFiltersState): string {
  return JSON.stringify(state);
}

export function readStoredDirectoryFilters(
  storage: Pick<Storage, 'getItem'> = globalThis.localStorage,
): DirectoryFiltersState | null {
  return parseDirectoryFilters(storage.getItem(DIRECTORY_FILTERS_STORAGE_KEY));
}

export function writeStoredDirectoryFilters(
  state: DirectoryFiltersState,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): void {
  storage.setItem(DIRECTORY_FILTERS_STORAGE_KEY, serializeDirectoryFilters(state));
}

export function mergeDirectoryFilters(
  current: DirectoryFiltersState | null,
  patch: DirectoryFiltersState,
): DirectoryFiltersState {
  return { ...(current || {}), ...patch };
}
