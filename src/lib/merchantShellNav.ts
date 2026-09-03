/**
 * Client-side merchant workspace chrome: instant Listing/Photos/Menu tabs,
 * active-tab sync across ClientRouter swaps, one-shot switcher wiring, and
 * idle prefetch of sibling tab URLs.
 */

export type MerchantInstantTab = 'listing' | 'photos' | 'menu';

export const MERCHANT_TAB_EVENT = 'merchant:tab';
export const MERCHANT_VENUE_CHANGE_EVENT = 'merchant:venue-change';

const INSTANT_TABS = new Set<string>(['listing', 'photos', 'menu']);
const PREFETCHED = new Set<string>();

let documentWired = false;

function managePathname(pathname: string): boolean {
  return /^\/restaurant\/manage\/[^/]+\/?$/.test(pathname);
}

export function readManageTabFromUrl(url: URL | Location = window.location): MerchantInstantTab {
  const tab = new URLSearchParams(url.search).get('tab');
  if (tab === 'photos' || tab === 'menu' || tab === 'listing') return tab;
  return 'listing';
}

export function syncMerchantShellActiveTab(activeTab: string): void {
  const shell = document.querySelector<HTMLElement>('[data-merchant-shell]');
  if (!shell) return;
  shell.dataset.activeTab = activeTab;
  for (const tabEl of shell.querySelectorAll<HTMLAnchorElement>('[data-merchant-shell-tab]')) {
    const id = tabEl.dataset.merchantShellTab || '';
    const isActive = id === activeTab;
    tabEl.classList.toggle('is-active', isActive);
    if (isActive) tabEl.setAttribute('aria-current', 'page');
    else tabEl.removeAttribute('aria-current');
  }
}

/** Venue hero/featured thumbnail in the persisted shell identity mark. */
export function setMerchantShellVenueImage(url: string | null | undefined): void {
  const shell = document.querySelector<HTMLElement>('[data-merchant-shell]');
  if (!shell) return;
  const img = shell.querySelector<HTMLImageElement>('[data-merchant-shell-thumb]');
  const fallback = shell.querySelector<HTMLElement>('[data-merchant-shell-thumb-fallback]');
  if (!img) return;
  const src = typeof url === 'string' ? url.trim() : '';
  if (src) {
    if (img.getAttribute('src') !== src) img.src = src;
    img.hidden = false;
    if (fallback) fallback.hidden = true;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    if (fallback) fallback.hidden = false;
  }
}

/**
 * Create Promotion lives in persisted chrome. Visibility = promotions route
 * AND the promotions page marked the current venue as ready (`data-create-promotion-available`).
 */
export function setMerchantShellCreatePromotionAvailable(available: boolean): void {
  const shell = document.querySelector<HTMLElement>('[data-merchant-shell]');
  if (shell) shell.dataset.createPromotionAvailable = available ? 'true' : 'false';
  syncCreatePromotionCta();
}

function syncCreatePromotionCta(): void {
  const btn = document.querySelector<HTMLButtonElement>('[data-merchant-shell-create-promotion]');
  if (!btn) return;
  const shell = document.querySelector<HTMLElement>('[data-merchant-shell]');
  const onPromotions = activeTabFromLocation() === 'promotions';
  const available = shell?.dataset.createPromotionAvailable === 'true';
  btn.hidden = !(onPromotions && available);
}

function activeTabFromLocation(): string {
  const { pathname, search } = window.location;
  if (managePathname(pathname)) return readManageTabFromUrl();
  if (/\/restaurant\/manage\/[^/]+\/users\/?$/.test(pathname)) return 'team';
  if (pathname.startsWith('/restaurant/audience')) return 'audience';
  if (pathname.startsWith('/restaurant/reports')) return 'reports';
  if (pathname.startsWith('/restaurant/billing')) return 'billing';
  if (pathname === '/restaurant' || pathname === '/restaurant/') return 'promotions';
  const params = new URLSearchParams(search);
  if (params.has('venueId') && (pathname === '/restaurant' || pathname === '/restaurant/')) {
    return 'promotions';
  }
  return document.querySelector<HTMLElement>('[data-merchant-shell]')?.dataset.activeTab || 'promotions';
}

function dispatchTab(tab: MerchantInstantTab): void {
  window.dispatchEvent(
    new CustomEvent(MERCHANT_TAB_EVENT, { detail: { tab } }),
  );
}

function applyInstantTab(tab: MerchantInstantTab, push: boolean): void {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  const next = `${url.pathname}?tab=${tab}`;
  if (push) {
    const state = {
      ...(typeof history.state === 'object' && history.state ? history.state : {}),
      merchantInstantTab: tab,
    };
    history.pushState(state, '', next);
  } else {
    history.replaceState(
      {
        ...(typeof history.state === 'object' && history.state ? history.state : {}),
        merchantInstantTab: tab,
      },
      '',
      next,
    );
  }
  syncMerchantShellActiveTab(tab);
  dispatchTab(tab);
}

function onTabClick(event: MouseEvent): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  const tabEl = target.closest<HTMLAnchorElement>('[data-merchant-shell-tab]');
  if (!tabEl) return;

  const tabId = tabEl.dataset.merchantShellTab || '';
  if (!INSTANT_TABS.has(tabId)) return;
  if (tabEl.getAttribute('aria-disabled') === 'true') return;

  let url: URL;
  try {
    url = new URL(tabEl.href, window.location.href);
  } catch {
    return;
  }

  if (!managePathname(window.location.pathname)) return;
  if (url.pathname !== window.location.pathname) return;

  event.preventDefault();
  event.stopPropagation();

  const tab = tabId as MerchantInstantTab;
  if (readManageTabFromUrl() === tab) {
    syncMerchantShellActiveTab(tab);
    dispatchTab(tab);
    return;
  }
  applyInstantTab(tab, true);
}

function onPopState(): void {
  if (!managePathname(window.location.pathname)) return;
  const tab = readManageTabFromUrl();
  syncMerchantShellActiveTab(tab);
  dispatchTab(tab);
}

function onlyManageTabChanged(from: URL, to: URL): boolean {
  if (!managePathname(from.pathname) || !managePathname(to.pathname)) return false;
  if (from.pathname !== to.pathname) return false;
  const fromParams = new URLSearchParams(from.search);
  const toParams = new URLSearchParams(to.search);
  fromParams.delete('tab');
  toParams.delete('tab');
  return fromParams.toString() === toParams.toString();
}

function onBeforePreparation(event: Event): void {
  const prep = event as Event & {
    from?: URL;
    to?: URL;
    preventDefault: () => void;
  };
  if (!prep.from || !prep.to) return;
  if (!onlyManageTabChanged(prep.from, prep.to)) return;
  prep.preventDefault();
  const tab = readManageTabFromUrl(prep.to);
  syncMerchantShellActiveTab(tab);
  dispatchTab(tab);
}

function onSwitcherChange(event: Event): void {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  if (!select.matches('[data-merchant-shell-switcher]')) return;

  const option = select.selectedOptions[0];
  const raw = select.value;
  const asNumber = Number(raw);
  const venueId = Number.isSafeInteger(asNumber) && asNumber > 0
    ? asNumber
    : Number(option?.dataset.venueId || '') || null;
  const venueSlug = option?.dataset.slug
    || (venueId == null && raw ? raw : null);

  window.dispatchEvent(
    new CustomEvent(MERCHANT_VENUE_CHANGE_EVENT, {
      detail: {
        value: raw,
        venueId,
        venueSlug,
        select,
        option,
      },
    }),
  );
}

function insertPrefetch(href: string): void {
  if (!href || href === '#' || href.startsWith('#')) return;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) return;
  // Same manage document — panel switch is local; no HTML prefetch needed.
  if (managePathname(url.pathname) && managePathname(window.location.pathname)
    && url.pathname === window.location.pathname) {
    return;
  }
  const key = `${url.pathname}${url.search}`;
  if (PREFETCHED.has(key)) return;
  if (url.pathname === window.location.pathname && url.search === window.location.search) return;
  PREFETCHED.add(key);

  const existing = document.head.querySelectorAll('link[rel="prefetch"]');
  for (const node of existing) {
    if (node instanceof HTMLLinkElement && node.href === url.href) return;
  }

  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = url.href;
  link.as = 'document';
  document.head.appendChild(link);
}

export function prefetchVisibleMerchantTabs(): void {
  const tabs = document.querySelectorAll<HTMLAnchorElement>(
    '[data-merchant-shell-tab]:not([hidden])',
  );
  for (const tab of tabs) {
    if (tab.getAttribute('aria-disabled') === 'true') continue;
    if (tab.classList.contains('is-active')) continue;
    insertPrefetch(tab.href);
  }
}

/**
 * Update the URL without wiping ClientRouter history state.
 * `history.replaceState(null, …)` breaks soft-nav / back-forward after boot.
 */
export function replaceMerchantUrl(pathWithQuery: string): void {
  const prev =
    typeof history.state === 'object' && history.state !== null
      ? (history.state as Record<string, unknown>)
      : {};
  history.replaceState({ ...prev }, '', pathWithQuery);
}

/**
 * Re-run page bootstrap after every ClientRouter navigation.
 * Astro skips already-executed module scripts on soft-nav revisit, so
 * SSR tabs that paint a loader then fetch must listen for `astro:page-load`.
 */
export function onMerchantPageLoad(boot: () => void): void {
  document.addEventListener('astro:page-load', boot);
}

function scheduleIdlePrefetch(): void {
  const run = () => prefetchVisibleMerchantTabs();
  const idle = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof idle === 'function') {
    idle(() => run(), { timeout: 2000 });
  } else {
    setTimeout(run, 400);
  }
  // Claims sync often rewrites hrefs shortly after paint.
  setTimeout(run, 1600);
}

function syncFromLocation(): void {
  const shell = document.querySelector('[data-merchant-shell]');
  if (!shell) return;
  syncMerchantShellActiveTab(activeTabFromLocation());
  syncCreatePromotionCta();
  scheduleIdlePrefetch();
}

/**
 * Wire document-level listeners once. Safe to call on every MerchantShell mount
 * and after ClientRouter swaps (persisted chrome must not stack handlers).
 */
export function initMerchantShellNav(): void {
  if (documentWired) {
    syncFromLocation();
    return;
  }
  documentWired = true;

  document.addEventListener('click', onTabClick, true);
  document.addEventListener('change', onSwitcherChange);
  window.addEventListener('popstate', onPopState);
  document.addEventListener('astro:before-preparation', onBeforePreparation);
  document.addEventListener('astro:page-load', syncFromLocation);
  document.addEventListener('astro:after-swap', syncFromLocation);

  syncFromLocation();
}
