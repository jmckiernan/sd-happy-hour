/**
 * Shared Share + Notify controls for browse cards (home + neighborhoods).
 * Option C: circular bell/share icons beside Save in the save-panel row.
 */

export type CardFollowState = {
  promotionAlertsEnabled: boolean;
};

export const CARD_FOLLOW_DEFAULTS = {
  promotionAlertsEnabled: true,
  channels: { email: true },
} as const;

const SHARE_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.6 10.5 6.8-4"></path><path d="m8.6 13.5 6.8 4"></path></svg>`;

/** Lightweight Facebook "f" mark for share menus (no external asset). */
const FACEBOOK_MARK = `<svg class="share-fb-mark" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><rect width="16" height="16" rx="3" fill="#1877F2"/><path fill="#fff" d="M11.05 8.35H9.25v5.9H6.95v-5.9H5.85V6.55h1.1V5.4c0-1.55.72-2.45 2.5-2.45h1.45v1.85H9.7c-.52 0-.65.24-.65.72v1.03h1.95l-.25 1.8z"/></svg>`;

const BELL_ICON = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

const BELL_ICON_FILLED = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

function escapeHTML(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[char] || char
  );
}

export function venuePublicUrl(slug: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string {
  const path = `/venues/${slug}/`;
  return origin ? `${origin}${path}` : path;
}

/** Trailing Notify + Share icon pair for save-panel / actions rows. */
export function renderCardShareNotifyIcons(opts: {
  venueId: number | string;
  venueName: string;
  slug: string;
  following?: boolean;
  promotionAlertsEnabled?: boolean;
}): string {
  const following = Boolean(opts.following);
  const liveDealsOn = following
    ? opts.promotionAlertsEnabled !== false
    : true;
  const name = escapeHTML(opts.venueName);
  const slug = escapeHTML(opts.slug);
  const venueId = escapeHTML(opts.venueId);
  const notifyLabel = following ? `Notification prefs for ${name}` : `Notify about ${name}`;
  const shareLabel = `Share ${name}`;

  return `
    <div class="card-action-icons" data-card-actions data-venue-id="${venueId}" data-venue-slug="${slug}" data-venue-name="${name}">
      <button
        type="button"
        class="card-icon-btn card-notify-btn${following ? ' is-following' : ''}"
        data-card-notify
        aria-label="${notifyLabel}"
        title="Notify"
        aria-pressed="${following}"
        aria-haspopup="dialog"
        aria-expanded="false"
      >${following ? BELL_ICON_FILLED : BELL_ICON}</button>
      <div class="card-popover card-notify-menu" data-card-notify-menu role="dialog" aria-label="Notification preferences" hidden>
        <strong class="card-popover-title">Get notified</strong>
        <label class="card-notify-pref">
          <input type="checkbox" data-notify-pref="live-deals" ${liveDealsOn ? 'checked' : ''} />
          <span class="card-notify-pref-label">Live deals</span>
        </label>
        <label class="card-notify-pref is-disabled" title="Coming soon">
          <input type="checkbox" data-notify-pref="events" disabled />
          <span class="card-notify-pref-label">Events <em>Coming soon</em></span>
        </label>
        <span class="card-popover-status" data-card-notify-status aria-live="polite"></span>
      </div>
      <button
        type="button"
        class="card-icon-btn card-share-btn"
        data-card-share
        aria-label="${shareLabel}"
        title="Share"
        aria-haspopup="dialog"
        aria-expanded="false"
      >${SHARE_ICON}</button>
      <div class="card-popover card-share-menu" data-card-share-menu role="dialog" aria-label="Share this happy hour" hidden>
        <strong class="card-popover-title">Share this happy hour</strong>
        <button type="button" data-share-action="native" hidden>↗ Share…</button>
        <button type="button" data-share-action="copy">🔗 Copy link</button>
        <a data-share-action="email" href="#">✉️ Email</a>
        <a data-share-action="text" href="#">💬 Text message</a>
        <a data-share-action="facebook" href="#" target="_blank" rel="noopener">${FACEBOOK_MARK}Share on Facebook</a>
        <span class="card-popover-status" data-card-share-status aria-live="polite"></span>
      </div>
    </div>
  `;
}

export type CardShareNotifyControllerOptions = {
  root: ParentNode;
  follows: Map<number, CardFollowState>;
  isSignedIn: () => boolean;
  onSignInRequired: () => void;
  onFollowsChanged?: () => void;
};

function closeAllPopovers(root: ParentNode, except?: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-card-share-menu], [data-card-notify-menu]').forEach((menu) => {
    if (menu === except) return;
    menu.hidden = true;
    const actions = menu.closest('[data-card-actions]');
    const btn = menu.matches('[data-card-share-menu]')
      ? actions?.querySelector('[data-card-share]')
      : actions?.querySelector('[data-card-notify]');
    btn?.setAttribute('aria-expanded', 'false');
  });
}

function paintNotifyButton(actions: HTMLElement, following: boolean) {
  const btn = actions.querySelector<HTMLButtonElement>('[data-card-notify]');
  if (!btn) return;
  btn.classList.toggle('is-following', following);
  btn.setAttribute('aria-pressed', String(following));
  const name = actions.dataset.venueName || 'venue';
  btn.setAttribute('aria-label', following ? `Notification prefs for ${name}` : `Notify about ${name}`);
  btn.innerHTML = following ? BELL_ICON_FILLED : BELL_ICON;
  const liveDeals = actions.querySelector<HTMLInputElement>('[data-notify-pref="live-deals"]');
  if (liveDeals && !following) liveDeals.checked = true;
}

export function applyFollowStateToRoot(root: ParentNode, follows: Map<number, CardFollowState>) {
  root.querySelectorAll<HTMLElement>('[data-card-actions]').forEach((actions) => {
    const venueId = Number(actions.dataset.venueId);
    if (!venueId) return;
    const follow = follows.get(venueId);
    const following = Boolean(follow);
    paintNotifyButton(actions, following);
    const liveDeals = actions.querySelector<HTMLInputElement>('[data-notify-pref="live-deals"]');
    if (liveDeals && follow) liveDeals.checked = follow.promotionAlertsEnabled;
  });
}

export async function hydrateCardFollows(follows: Map<number, CardFollowState>): Promise<boolean> {
  try {
    const response = await fetch('/api/account/follows', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      follows.clear();
      return false;
    }
    const data = await response.json();
    follows.clear();
    for (const follow of data.follows || []) {
      follows.set(Number(follow.venueId), {
        promotionAlertsEnabled: Boolean(follow.promotionAlertsEnabled),
      });
    }
    return true;
  } catch {
    follows.clear();
    return false;
  }
}

export function bindCardShareNotify(opts: CardShareNotifyControllerOptions): () => void {
  const { root, follows, isSignedIn, onSignInRequired, onFollowsChanged } = opts;

  function openShareMenu(actions: HTMLElement) {
    const menu = actions.querySelector<HTMLElement>('[data-card-share-menu]');
    const btn = actions.querySelector<HTMLButtonElement>('[data-card-share]');
    if (!menu || !btn) return;
    closeAllPopovers(root, menu);
    const slug = actions.dataset.venueSlug || '';
    const name = actions.dataset.venueName || 'this happy hour';
    const url = venuePublicUrl(slug);
    const shareText = `Check out ${name}`;
    const email = menu.querySelector<HTMLAnchorElement>('[data-share-action="email"]');
    const text = menu.querySelector<HTMLAnchorElement>('[data-share-action="text"]');
    const facebook = menu.querySelector<HTMLAnchorElement>('[data-share-action="facebook"]');
    const native = menu.querySelector<HTMLButtonElement>('[data-share-action="native"]');
    if (email) {
      email.href = `mailto:?subject=${encodeURIComponent(`${name} happy hour`)}&body=${encodeURIComponent(`${shareText}\n\n${url}`)}`;
    }
    if (text) text.href = `sms:?&body=${encodeURIComponent(`${shareText} ${url}`)}`;
    if (facebook) facebook.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
    if (native) {
      const canNative = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
      native.hidden = !canNative;
    }
    const status = menu.querySelector<HTMLElement>('[data-card-share-status]');
    if (status) status.textContent = '';
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function openNotifyMenu(actions: HTMLElement) {
    const menu = actions.querySelector<HTMLElement>('[data-card-notify-menu]');
    const btn = actions.querySelector<HTMLButtonElement>('[data-card-notify]');
    if (!menu || !btn) return;
    closeAllPopovers(root, menu);
    const follow = follows.get(Number(actions.dataset.venueId));
    const liveDeals = menu.querySelector<HTMLInputElement>('[data-notify-pref="live-deals"]');
    if (liveDeals) liveDeals.checked = follow ? follow.promotionAlertsEnabled : true;
    const status = menu.querySelector<HTMLElement>('[data-card-notify-status]');
    if (status) {
      status.textContent = '';
      status.classList.remove('is-error');
    }
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  async function ensureFollowing(actions: HTMLElement): Promise<boolean> {
    const venueId = Number(actions.dataset.venueId);
    if (!venueId) return false;
    if (follows.has(venueId)) return true;
    const response = await fetch(`/api/account/follows/${venueId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CARD_FOLLOW_DEFAULTS),
      credentials: 'same-origin',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data.errors || ['Could not turn on notifications.']).join(' '));
    follows.set(venueId, {
      promotionAlertsEnabled: data.follow?.promotionAlertsEnabled !== false,
    });
    paintNotifyButton(actions, true);
    onFollowsChanged?.();
    return true;
  }

  async function patchLiveDeals(actions: HTMLElement, enabled: boolean) {
    const venueId = Number(actions.dataset.venueId);
    if (!venueId) return;
    const response = await fetch(`/api/account/follows/${venueId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promotionAlertsEnabled: enabled }),
      credentials: 'same-origin',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data.errors || ['Could not update notifications.']).join(' '));
    follows.set(venueId, {
      promotionAlertsEnabled: Boolean(data.follow?.promotionAlertsEnabled ?? enabled),
    });
    paintNotifyButton(actions, true);
    onFollowsChanged?.();
  }

  const onClick = async (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const shareAction = target.closest<HTMLElement>('[data-share-action]');
    if (shareAction && root.contains(shareAction)) {
      const actions = shareAction.closest<HTMLElement>('[data-card-actions]');
      const menu = actions?.querySelector<HTMLElement>('[data-card-share-menu]');
      const status = menu?.querySelector<HTMLElement>('[data-card-share-status]');
      const slug = actions?.dataset.venueSlug || '';
      const name = actions?.dataset.venueName || 'this happy hour';
      const url = venuePublicUrl(slug);
      const kind = shareAction.dataset.shareAction;
      if (kind === 'copy') {
        event.preventDefault();
        try {
          await navigator.clipboard.writeText(url);
          if (status) status.textContent = 'Link copied';
        } catch {
          if (status) status.textContent = 'Copy failed — select the address from your browser.';
        }
        return;
      }
      if (kind === 'native') {
        event.preventDefault();
        try {
          await navigator.share({ title: `${name} happy hour`, text: `Check out ${name}`, url });
        } catch {
          // user cancel or unsupported — leave menu open
          return;
        }
      }
      if (menu && actions) {
        menu.hidden = true;
        actions.querySelector('[data-card-share]')?.setAttribute('aria-expanded', 'false');
      }
      return;
    }

    const shareBtn = target.closest<HTMLElement>('[data-card-share]');
    if (shareBtn && root.contains(shareBtn)) {
      event.preventDefault();
      const actions = shareBtn.closest<HTMLElement>('[data-card-actions]');
      if (!actions) return;
      const menu = actions.querySelector<HTMLElement>('[data-card-share-menu]');
      if (!menu) return;
      if (!menu.hidden) {
        menu.hidden = true;
        shareBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      openShareMenu(actions);
      return;
    }

    const notifyBtn = target.closest<HTMLElement>('[data-card-notify]');
    if (notifyBtn && root.contains(notifyBtn)) {
      event.preventDefault();
      if (!isSignedIn()) {
        onSignInRequired();
        return;
      }
      const actions = notifyBtn.closest<HTMLElement>('[data-card-actions]');
      if (!actions) return;
      const menu = actions.querySelector<HTMLElement>('[data-card-notify-menu]');
      const status = menu?.querySelector<HTMLElement>('[data-card-notify-status]');
      if (menu && !menu.hidden) {
        menu.hidden = true;
        notifyBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      try {
        notifyBtn.setAttribute('aria-busy', 'true');
        await ensureFollowing(actions);
        openNotifyMenu(actions);
      } catch (error: any) {
        if (status) {
          status.textContent = error?.message || 'Could not turn on notifications.';
          status.classList.add('is-error');
        }
        openNotifyMenu(actions);
      } finally {
        notifyBtn.removeAttribute('aria-busy');
      }
      return;
    }

    if (!target.closest('[data-card-actions]')) {
      closeAllPopovers(root);
    }
  };

  const onChange = async (event: Event) => {
    const target = event.target as HTMLElement | null;
    const input = target?.closest?.('[data-notify-pref="live-deals"]') as HTMLInputElement | null;
    if (!input || !root.contains(input)) return;
    const actions = input.closest<HTMLElement>('[data-card-actions]');
    const status = actions?.querySelector<HTMLElement>('[data-card-notify-status]');
    if (!actions) return;
    if (!isSignedIn()) {
      input.checked = !input.checked;
      onSignInRequired();
      return;
    }
    try {
      if (status) {
        status.textContent = 'Saving…';
        status.classList.remove('is-error');
      }
      await ensureFollowing(actions);
      await patchLiveDeals(actions, input.checked);
      if (status) status.textContent = 'Saved';
    } catch (error: any) {
      input.checked = !input.checked;
      if (status) {
        status.textContent = error?.message || 'Could not update notifications.';
        status.classList.add('is-error');
      }
    }
  };

  const onDocumentClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // Ignore the same gesture that opened a menu (async follow can resume after bubble).
    const actions = target.closest?.('[data-card-actions]');
    if (actions && root.contains(actions)) return;
    closeAllPopovers(root);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeAllPopovers(root);
  };

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  // Capture so we close even when another handler stops propagation.
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeyDown);
  };
}
