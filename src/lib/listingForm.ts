// Shared markup builder + reader for the venue listing form, used by the
// admin submission queue (src/pages/admin.astro) and the venue editor
// (src/pages/admin/venues/[slug].astro) so the two look and behave the same.
//
// It's a string builder rather than an Astro component because both callers
// paint it from client script: admin.astro renders one form per submission
// from fetched JSON, and the editor re-renders after a save. Pair it with
// ListingFormStyles.astro for the CSS.
//
// Client-only by design — keep this free of server imports (store.ts, db.ts)
// so it stays cheap to bundle. The shape below is structurally the same as
// `Listing` in store.ts; it's redeclared rather than imported so nothing can
// accidentally drag the database layer into a browser bundle.

import { vibeImageFor } from './vibeImages';
import {
  DEFAULT_IMAGE_CROP,
  IMAGE_FRAMES,
  MAX_IMAGE_CROP_SCALE,
  imageCropStyle,
  normalizeImageCrop,
  normalizeImageFraming,
  type ImageFrame,
  type ImageFraming,
} from './imageCrop';

export interface ListingFormValues {
  name?: string;
  neighborhood?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  days?: string[];
  openTime?: string;
  closeTime?: string;
  startTime?: string;
  endTime?: string;
  deals?: string[];
  vibe?: string;
  website?: string;
  verified?: boolean;
  lastVerifiedAt?: string | null;
  sourceUrl?: string;
  dealTypes?: string[];
  phone?: string;
  /** Featured photo URL — normally `/api/images/<key>`. Empty means the
   * public pages fall back to the vibe stock photo. */
  image?: string;
  /** Which part of that photo each of the site's fixed frames shows. */
  imageCrop?: ImageFraming | null;
}

// Sunday last, matching the public submit form (src/pages/submit.astro).
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DEAL_TYPES = ['beer', 'cocktails', 'wine', 'food', 'oysters', 'entertainment'];

function escapeHTML(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[char]);
}

function labelize(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** A small-rendition URL for an admin preview/thumbnail.
 *
 * Featured photos are full-size originals (an 8MB upload is within the limit),
 * and the submission queue can show a dozen at once, so these go through
 * Netlify's Image CDN the same way the public pages' photos do —
 * lib/venues.ts's throughImageCdn(), reimplemented here rather than imported
 * because that module pulls in happy-hours.json and this one is bundled for
 * the browser. Skipped outside production and for remote URLs, for the same
 * reasons it is there.
 */
export function previewSrc(url: string, width = 320): string {
  if (!url) return '';
  if (!import.meta.env.PROD) return url;
  if (!url.startsWith('/') || url.startsWith('/.netlify/images')) return url;
  if (url.startsWith('/api/images/')) return url;
  return `/.netlify/images?url=${encodeURIComponent(url)}&w=${width}&q=75`;
}

/** Built-in options first, then anything already on the listing that isn't
 * among them. Without this, editing a venue tagged with a deal type that
 * predates this list would silently strip it on save. */
function optionSet(builtIn: string[], current: string[]) {
  return [...builtIn, ...current.filter((value) => !builtIn.includes(value))];
}

/** The grid carries the listing's own ordering so readListingForm() can
 * restore it — see checkedValues(). Options themselves stay in a fixed
 * order so the control doesn't visually reshuffle from one record to the
 * next. */
function checkboxGrid(field: string, options: string[], selected: string[]) {
  return `<div class="lf-checks" data-lf-group="${field}" data-lf-initial="${escapeHTML(JSON.stringify(selected))}">${options.map((option) => `
    <label>
      <input type="checkbox" data-lf="${field}" value="${escapeHTML(option)}" ${selected.includes(option) ? 'checked' : ''}>
      ${escapeHTML(labelize(option))}
    </label>
  `).join('')}</div>`;
}

function textField(field: string, label: string, value: unknown, opts: { type?: string; placeholder?: string; full?: boolean } = {}) {
  return `
    <div class="lf-field${opts.full ? ' full' : ''}">
      <label>${escapeHTML(label)}</label>
      <input data-lf="${field}" type="${opts.type || 'text'}" value="${escapeHTML(value ?? '')}" placeholder="${escapeHTML(opts.placeholder || '')}">
    </div>
  `;
}

export interface OwnerPhotoOption {
  id: string;
  url: string;
  caption: string;
}

export interface ListingFormOptions {
  /** Show the "Verified" toggle and its date. On for the venue editor, where
   * those drive the badge on the public page; off in the submission queue,
   * where approving is what sets them. */
  includeVerification?: boolean;
  /**
   * Render the restricted form a restaurant owner sees
   * (src/pages/restaurant/manage/[slug].astro):
   *
   * - The fields only an admin may change are left out entirely rather than
   *   disabled — name, neighborhood, coordinates and the source URL. See
   *   OWNER_EDITABLE_FIELDS in lib/venueContent.ts for why each one.
   * - The featured image becomes a picker over the venue's own approved
   *   photos instead of an uploader, so the headline image on a public page
   *   can only ever be something screening has cleared.
   */
  ownerMode?: boolean;
  /** Uploaded album photos to choose a featured image from, in ownerMode. */
  photoOptions?: OwnerPhotoOption[];
}

/**
 * The owner's featured-image control. The first tile always represents what
 * is already visible on the site, even when an admin supplied that image and
 * it is not part of the owner's uploaded album. Uploading happens below in the
 * Photos panel.
 *
 * The chosen URL lives in a hidden `data-lf="image"` input so readListingForm()
 * picks it up with no special casing. A stock fallback keeps an empty value in
 * that input—the visual tile is the current site image, not a new owner image.
 */
function featuredPhotoPicker(photos: OwnerPhotoOption[], current: string, stockFallback: string) {
  const currentIsAlbumPhoto = photos.some((photo) => photo.url === current);
  const choices = [
    ...(!currentIsAlbumPhoto
      ? [{ id: 'current-site-image', url: current || stockFallback, caption: 'Current featured image', value: current }]
      : []),
    ...photos.map((photo) => ({ ...photo, value: photo.url })),
  ].filter((photo, index, all) =>
    Boolean(photo.url) && all.findIndex((candidate) => candidate.url === photo.url) === index
  );

  const tile = (value: string, url: string, caption: string) => `
    <button type="button" class="lf-pick${value === current ? ' selected' : ''}" data-lf-pick="${escapeHTML(value)}" title="${escapeHTML(caption)}" aria-pressed="${value === current ? 'true' : 'false'}">
      <img src="${escapeHTML(previewSrc(url))}" alt="${escapeHTML(caption || 'Featured photo')}" loading="lazy">
    </button>`;

  return `
    <div class="lf-field full lf-picker" data-lf-picker>
      <label>Featured photo</label>
      <input type="hidden" data-lf="image" value="${escapeHTML(current)}">
      ${choices.length
        ? `<div class="lf-pick-grid">
             ${choices.map((photo) => tile(photo.value, photo.url, photo.caption)).join('')}
           </div>
           <p class="lf-image-hint">This is the photo shown on the homepage card and at the top of your venue page.</p>`
        : `<p class="lf-image-hint">Upload photos in the Photos section below to feature one here.</p>`}
    </div>
  `;
}

/**
 * Framing control for the featured photo.
 *
 * That photo is shown in a fixed frame everywhere the venue appears, and a
 * `cover` fit decides on its own what to keep — often the sky rather than the
 * storefront. So the admin drags the photo to say what matters, once, and
 * every surface honours it.
 *
 * Each shape the site renders is drawn and adjusted separately, because a crop
 * that flatters the 5:2 hero routinely loses the whole sign at 1:1. Every
 * preview uses imageCropStyle(), the same function the public pages render
 * with, so this is a preview only in the sense that it is smaller. Nothing is
 * written to the file; the framing rides along on the listing and is read back
 * by readListingForm(), so it saves through the existing Save button.
 */
function imageCropEditor(listing: ListingFormValues) {
  const image = listing.image || '';
  const framing = normalizeImageFraming(listing.imageCrop) || {};

  // Rendered even with no photo, hidden, so uploading one reveals the control
  // straight away instead of after the next save. There is nothing to frame
  // until then: the stock vibe image is shared by every venue with that vibe,
  // so it isn't anyone's to crop.
  return `
    <div class="lf-field full lf-crop" data-lf-crop data-lf-crop-src="${escapeHTML(image)}"
         ${image ? '' : 'hidden'}>
      <label>Featured image framing</label>
      <p class="lf-image-hint">
        Each frame is adjusted on its own — drag the photo inside one to choose what that
        surface shows. Stored alongside the image rather than applied to it, so it can be
        changed again later and the original is never re-cropped.
      </p>
      <div class="lf-crop-frames">
        ${IMAGE_FRAMES.map((frame) => {
          const crop = framing[frame.key] || DEFAULT_IMAGE_CROP;
          const scale = crop.scale ?? 1;
          const label = `${frame.label} · ${frame.ratio.replace(/\s/g, '')}`;
          return `
          <figure class="lf-crop-frame" data-lf-crop-frame="${frame.key}"
                  data-lf-crop-x="${crop.x}" data-lf-crop-y="${crop.y}" data-lf-crop-scale="${scale}">
            <figcaption>
              <strong>${escapeHTML(label)}</strong>
              <span>${escapeHTML(frame.hint)}</span>
            </figcaption>
            <div class="lf-crop-window" data-lf-crop-window style="aspect-ratio: ${frame.ratio};"
                 role="application" tabindex="0"
                 aria-label="Drag to reposition the featured photo in the ${escapeHTML(frame.label.toLowerCase())} frame">
              <img src="${escapeHTML(image ? previewSrc(image, 640) : '')}" alt="" draggable="false" loading="lazy"
                   style="${imageCropStyle(framing[frame.key])}">
            </div>
            <div class="lf-crop-controls">
              <label>
                Zoom
                <input type="range" data-lf-crop-zoom min="1" max="${MAX_IMAGE_CROP_SCALE}" step="0.05" value="${scale}"
                       aria-label="Zoom the ${escapeHTML(frame.label.toLowerCase())} frame">
              </label>
              <output data-lf-crop-readout>${scale.toFixed(2)}×</output>
              <button type="button" class="lf-image-btn" data-lf-crop-reset
                      aria-label="Reset the ${escapeHTML(frame.label.toLowerCase())} frame">Reset</button>
              <button type="button" class="lf-image-btn" data-lf-crop-apply-all
                      aria-label="Copy the ${escapeHTML(frame.label.toLowerCase())} framing to the other frames">Copy to all</button>
            </div>
          </figure>
        `;
        }).join('')}
      </div>
    </div>
  `;
}

export function listingFormHTML(listing: ListingFormValues, options: ListingFormOptions = {}) {
  const days = listing.days || [];
  const dealTypes = listing.dealTypes || [];

  const owner = options.ownerMode === true;

  return `
    <div class="lf-form">
      ${owner ? '' : textField('name', 'Restaurant', listing.name)}
      ${owner ? '' : textField('neighborhood', 'Neighborhood', listing.neighborhood, { placeholder: 'Little Italy' })}
      ${textField('address', 'Address', listing.address, { full: true, placeholder: '123 Main St, San Diego, CA' })}
      ${textField('website', 'Website', listing.website, { type: 'url', placeholder: 'https://...' })}
      ${owner ? '' : textField('sourceUrl', 'Source URL (menu, press, etc.)', listing.sourceUrl, { type: 'url', placeholder: 'https://...' })}
      ${textField('phone', 'Phone (optional)', listing.phone, { type: 'tel', placeholder: '(619) 555-0100' })}
      ${textField('vibe', 'Vibe (optional)', listing.vibe, { placeholder: 'Rooftop, wine bar, patio...' })}
      ${textField('openTime', 'Open Time', listing.openTime, { type: 'time' })}
      ${textField('closeTime', 'Close Time', listing.closeTime, { type: 'time' })}
      ${textField('startTime', 'Happy Hour Start Time', listing.startTime, { type: 'time' })}
      ${textField('endTime', 'Happy Hour End Time', listing.endTime, { type: 'time' })}
      ${owner ? '' : textField('lat', 'Latitude', listing.lat, { placeholder: '32.7157' })}
      ${owner ? '' : textField('lng', 'Longitude', listing.lng, { placeholder: '-117.1611' })}

      <div class="lf-field full">
        <label>Days</label>
        ${checkboxGrid('days', DAY_NAMES, days)}
      </div>

      <div class="lf-field full">
        <label>Deals (one per line, optional)</label>
        <textarea data-lf="deals" placeholder="$8 margaritas&#10;$5 tacos">${escapeHTML((listing.deals || []).join('\n'))}</textarea>
        <p class="lf-image-hint">
          Leave this blank if the happy hour times are published but the offers are not — the page
          says so plainly rather than guessing at a price.
        </p>
      </div>

      <div class="lf-field full">
        <label>Deal types (only with deals)</label>
        ${checkboxGrid('dealTypes', optionSet(DEAL_TYPES, dealTypes), dealTypes)}
      </div>

      ${owner
        ? featuredPhotoPicker(
            options.photoOptions || [],
            listing.image || '',
            vibeImageFor(listing.vibe)
          )
        : ''}

      ${owner ? '' : `<div class="lf-field full lf-image" data-lf-image>
        <label>Featured image</label>
        <div class="lf-image-body">
          <div class="lf-image-preview">
            <!-- The preview always shows what the public pages actually render:
                 the listing's own photo if it has one, otherwise the vibe
                 stock photo it falls back to. Showing "no photo" for a venue
                 that visibly has one on the site was just confusing — the
                 caption below is what distinguishes the two cases. -->
            <img data-lf-image-preview alt="" loading="lazy"
                 src="${escapeHTML(previewSrc(listing.image || vibeImageFor(listing.vibe)))}"
                 data-lf-image-fallback="${escapeHTML(previewSrc(vibeImageFor(listing.vibe)))}">
            <span class="lf-image-empty" data-lf-image-empty ${listing.image ? 'hidden' : ''}>Stock photo for this vibe</span>
          </div>

          <div class="lf-image-controls">
            <!-- This field is the single source of truth: every control below
                 just writes its resulting URL into it, and saving sends
                 whatever it holds. Same arrangement as the blog draft
                 editor's "Featured image" field. -->
            <input data-lf="image" type="text" value="${escapeHTML(listing.image || '')}" placeholder="/api/images/... or https://...">

            <div class="lf-image-row">
              <label class="lf-image-btn">
                Upload a photo…
                <input type="file" data-lf-image-file accept="image/jpeg,image/png,image/webp,image/gif,image/avif" hidden>
              </label>
              <button type="button" class="lf-image-btn" data-lf-image-action="clear">Remove photo</button>
            </div>

            <div class="lf-image-row">
              <input type="url" data-lf-image-url placeholder="Paste an image URL to store a copy">
              <button type="button" class="lf-image-btn" data-lf-image-action="fetch">Fetch &amp; store</button>
            </div>

            <!-- Touch-up only, no generate-from-scratch: it edits the photo
                 that's already there rather than inventing one, so a venue's
                 photo stays a photo of the actual venue. The placeholder
                 steers toward end-state wording because purely tonal asks
                 ("brighter") come back visually unchanged — see
                 buildEditPrompt() in api/admin/edit-image.ts. -->
            <div class="lf-image-row">
              <input type="text" data-lf-image-prompt placeholder="AI touch-up, e.g. warm golden-hour light on the patio">
              <button type="button" class="lf-image-btn" data-lf-image-action="touchup">Touch up</button>
            </div>

            <p class="lf-image-hint" data-lf-image-status aria-live="polite">
              Uploads and pasted URLs are stored as our own copy. Touch-up keeps the same photo, framing and crop — describe the finished look, not a nudge.
            </p>
          </div>
        </div>
      </div>`}

      ${owner ? '' : imageCropEditor(listing)}

      ${options.includeVerification ? `
        <div class="lf-field">
          <label>Verification</label>
          <label class="lf-inline">
            <input type="checkbox" data-lf="verified" ${listing.verified ? 'checked' : ''}>
            Verified listing
          </label>
        </div>
        ${textField('lastVerifiedAt', 'Last verified', listing.lastVerifiedAt, { type: 'date' })}
      ` : ''}
    </div>
  `;
}

function fieldValue(root: HTMLElement, field: string) {
  const el = root.querySelector(`[data-lf="${field}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  return el ? el.value.trim() : '';
}

/** Ticked values, in the order the listing already had them, with anything
 * newly ticked appended in grid order.
 *
 * Returning plain DOM order instead would rewrite every listing's tag order
 * to match this form's option list on the first save — a spurious diff in
 * happy-hours.json for no edit anyone made. */
function checkedValues(root: HTMLElement, field: string) {
  const checked = [...root.querySelectorAll<HTMLInputElement>(`input[data-lf="${field}"]:checked`)].map((el) => el.value);

  const grid = root.querySelector(`[data-lf-group="${field}"]`) as HTMLElement | null;
  let initial: string[] = [];
  try {
    initial = JSON.parse(grid?.dataset.lfInitial || '[]');
  } catch {
    // Malformed attribute — fall back to plain DOM order.
  }

  return [
    ...initial.filter((value) => checked.includes(value)),
    ...checked.filter((value) => !initial.includes(value)),
  ];
}

/** Reads a rendered form back into the shape validateListing() expects.
 * Lists go out as arrays rather than joined strings — cleanList() splits
 * strings on commas, which would chop a deal like "$5 tacos, all day" in
 * half. */
export function readListingForm(root: HTMLElement): Record<string, any> {
  const website = fieldValue(root, 'website');
  const verifiedBox = root.querySelector('[data-lf="verified"]') as HTMLInputElement | null;
  const lastVerified = root.querySelector('[data-lf="lastVerifiedAt"]') as HTMLInputElement | null;

  const listing: Record<string, any> = {
    name: fieldValue(root, 'name'),
    neighborhood: fieldValue(root, 'neighborhood'),
    address: fieldValue(root, 'address'),
    lat: fieldValue(root, 'lat'),
    lng: fieldValue(root, 'lng'),
    days: checkedValues(root, 'days'),
    openTime: fieldValue(root, 'openTime'),
    closeTime: fieldValue(root, 'closeTime'),
    startTime: fieldValue(root, 'startTime'),
    endTime: fieldValue(root, 'endTime'),
    deals: fieldValue(root, 'deals').split('\n').map((line) => line.trim()).filter(Boolean),
    vibe: fieldValue(root, 'vibe'),
    website,
    sourceUrl: fieldValue(root, 'sourceUrl') || website,
    dealTypes: checkedValues(root, 'dealTypes'),
    phone: fieldValue(root, 'phone'),
    image: fieldValue(root, 'image'),
  };

  // Only sent when the form actually rendered these — otherwise the caller's
  // existing values would be overwritten with false/null.
  if (verifiedBox) listing.verified = verifiedBox.checked;
  if (lastVerified) listing.lastVerifiedAt = lastVerified.value || null;
  // Null rather than absent when nothing is framed or the control isn't on
  // this form: the venue editor saves the difference from the record it
  // loaded, so clearing framing has to be a value it can see.
  listing.imageCrop = readImageFraming(root);

  return listing;
}

/** Every frame the admin has moved, or null when none of them is framed, when
 * the form has no crop control, or when the photo they were framing has since
 * been replaced — framing belongs to the image it was dragged against, not to
 * the venue. */
function readImageFraming(root: HTMLElement): ImageFraming | null {
  const el = root.querySelector('[data-lf-crop]') as HTMLElement | null;
  const image = fieldValue(root, 'image');
  if (!el || !image || el.dataset.lfCropSrc !== image) return null;

  const framing: Record<string, unknown> = {};
  el.querySelectorAll<HTMLElement>('[data-lf-crop-frame]').forEach((frame) => {
    framing[frame.dataset.lfCropFrame!] = {
      x: Number(frame.dataset.lfCropX),
      y: Number(frame.dataset.lfCropY),
      scale: Number(frame.dataset.lfCropScale),
    };
  });
  return normalizeImageFraming(framing);
}

// ---------------------------------------------------------------------------
// Featured-image controls
//
// Wired by delegation on a container rather than by binding each block, so
// the submission queue — which repaints every card after each save — doesn't
// have to re-attach anything, and one call covers however many forms are on
// the page. Safe to call once per container on load.
//
// All three paths reuse the endpoints the blog draft editor already uses:
// upload-image.ts for a file or a pasted URL (which it fetches and stores as
// our own copy rather than leaving as a hotlink), and edit-image.ts for the
// AI touch-up. Each returns a fresh /api/images/<key> URL, which lands in the
// hidden-in-plain-sight `image` field; nothing is committed to the venue file
// until the form itself is saved.
// ---------------------------------------------------------------------------

interface ImageBlock {
  block: HTMLElement;
  field: HTMLInputElement;
  preview: HTMLImageElement;
  empty: HTMLElement;
  status: HTMLElement;
}

export const LISTING_IMAGE_BUSY_EVENT = 'sdhh:listing-image-busy';

function imageBlockFor(el: HTMLElement): ImageBlock | null {
  const block = el.closest('[data-lf-image]') as HTMLElement | null;
  if (!block) return null;
  const field = block.querySelector('[data-lf="image"]') as HTMLInputElement | null;
  if (!field) return null;
  return {
    block,
    field,
    preview: block.querySelector('[data-lf-image-preview]') as HTMLImageElement,
    empty: block.querySelector('[data-lf-image-empty]') as HTMLElement,
    status: block.querySelector('[data-lf-image-status]') as HTMLElement,
  };
}

function setImageStatus(ui: ImageBlock, message: string, kind: '' | 'busy' | 'ok' | 'err' = '') {
  ui.status.className = `lf-image-hint${kind ? ` ${kind}` : ''}`;
  ui.status.textContent = message;
}

/** Points the field and the preview at a URL (or clears both when empty). */
function setImageValue(ui: ImageBlock, url: string) {
  ui.field.value = url;
  showPreview(ui, url);
}

/** The field keeps the real URL; the preview shows a scaled rendition of it,
 * dropping back to the vibe stock photo (stashed on the img when the form was
 * built) whenever the field is empty — so clearing a photo previews exactly
 * what the public page will show, with the caption saying which it is. */
function showPreview(ui: ImageBlock, url: string) {
  const fallback = ui.preview.dataset.lfImageFallback || '';
  ui.preview.src = url ? previewSrc(url) : fallback;
  ui.preview.hidden = !ui.preview.getAttribute('src');
  ui.empty.hidden = Boolean(url);
  syncCropSource(ui.block.closest('.lf-form') as HTMLElement | null, url);
}

/** Points the framing control at whatever photo the form now holds. A new
 * photo starts every frame centered rather than inheriting the last one's
 * framing, which was dragged against a different picture. */
function syncCropSource(form: HTMLElement | null, url: string) {
  const el = form?.querySelector('[data-lf-crop]') as HTMLElement | null;
  if (!el || el.dataset.lfCropSrc === url) return;
  el.dataset.lfCropSrc = url;
  el.hidden = !url;
  el.querySelectorAll<HTMLImageElement>('[data-lf-crop-window] img').forEach((img) => {
    img.src = url ? previewSrc(url, 640) : '';
  });
  el.querySelectorAll<HTMLElement>('[data-lf-crop-frame]').forEach(resetCropFrame);
}

/** Disables every control in the block while a request is in flight, so an
 * impatient second click can't race the first and leave the field pointing at
 * whichever response happened to land last. */
function setImageBusy(ui: ImageBlock, busy: boolean) {
  ui.block.querySelectorAll('button, input').forEach((el) => {
    (el as HTMLButtonElement | HTMLInputElement).disabled = busy;
  });
  ui.block.classList.toggle('busy', busy);
  ui.block.dispatchEvent(
    new CustomEvent(LISTING_IMAGE_BUSY_EVENT, { bubbles: true, detail: { busy } })
  );
}

/** A filename-safe hint for the stored image key, taken from the listing's own
 * name field so stored files are recognizable in the Blobs store. */
function slugHintFor(ui: ImageBlock): string {
  const form = ui.block.closest('.lf-form') as HTMLElement | null;
  const name = form ? fieldValue(form, 'name') : '';
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'venue'
  );
}

async function runImageRequest(ui: ImageBlock, url: string, init: RequestInit, busyText: string) {
  setImageBusy(ui, true);
  setImageStatus(ui, busyText, 'busy');
  try {
    const res = await fetch(url, init);
    const data = await res.json();
    if (!res.ok) throw new Error((data.errors || ['Request failed.']).join('\n'));
    setImageValue(ui, data.url);
    setImageStatus(ui, 'Image stored — save the listing to publish it.', 'ok');
  } catch (err: any) {
    setImageStatus(ui, err.message || 'Something went wrong.', 'err');
  } finally {
    setImageBusy(ui, false);
  }
}

export function wireListingImageControls(container: HTMLElement) {
  container.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('[data-lf-image-action]') as HTMLButtonElement | null;
    if (!button || !container.contains(button)) return;
    const ui = imageBlockFor(button);
    if (!ui) return;

    const action = button.dataset.lfImageAction;

    if (action === 'clear') {
      setImageValue(ui, '');
      setImageStatus(ui, 'Photo removed — save the listing to fall back to the vibe stock photo.', 'ok');
      return;
    }

    if (action === 'fetch') {
      const input = ui.block.querySelector('[data-lf-image-url]') as HTMLInputElement;
      const url = input.value.trim();
      if (!url) {
        setImageStatus(ui, 'Paste an image URL first.', 'err');
        return;
      }
      runImageRequest(
        ui,
        '/api/admin/upload-image',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, slug: slugHintFor(ui) }),
        },
        'Fetching and storing that image…'
      ).then(() => {
        input.value = '';
      });
      return;
    }

    if (action === 'touchup') {
      const promptInput = ui.block.querySelector('[data-lf-image-prompt]') as HTMLInputElement;
      const prompt = promptInput.value.trim();
      if (!ui.field.value.trim()) {
        setImageStatus(ui, 'Add a photo first — touch-up edits the photo that’s already there.', 'err');
        return;
      }
      if (!prompt) {
        setImageStatus(ui, 'Describe the change you want.', 'err');
        return;
      }
      // The result is saved under a new key, so the pre-touch-up photo is
      // still there — undo is re-pasting the old URL into the field.
      runImageRequest(
        ui,
        '/api/admin/edit-image',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, sourceUrl: ui.field.value.trim(), slug: slugHintFor(ui) }),
        },
        'Applying your touch-up — this takes a few seconds…'
      );
    }
  });

  container.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    console.log('[Image Upload] Change event fired', input);
    if (!input.matches?.('[data-lf-image-file]')) {
      console.log('[Image Upload] Input does not match selector');
      return;
    }
    console.log('[Image Upload] Input matched file selector');
    const ui = imageBlockFor(input);
    const file = input.files?.[0];
    console.log('[Image Upload] UI block:', ui, 'File:', file);
    if (!ui || !file) {
      console.log('[Image Upload] Missing UI block or file, aborting');
      return;
    }

    console.log('[Image Upload] Starting upload for:', file.name);
    const form = new FormData();
    form.append('file', file);
    form.append('slug', slugHintFor(ui));
    runImageRequest(ui, '/api/admin/upload-image', { method: 'POST', body: form }, `Uploading ${file.name}…`).then(() => {
      // Cleared so re-picking the same file fires `change` again.
      input.value = '';
    });
  });

  // Typing or pasting straight into the field is a legitimate way to set the
  // image too (that's how an edit gets undone), so the preview tracks it.
  container.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.matches?.('[data-lf="image"]')) return;
    const ui = imageBlockFor(input);
    if (!ui) return;
    showPreview(ui, input.value.trim());
  });
}

// ---------------------------------------------------------------------------
// Featured-image framing controls
//
// Direct manipulation: the admin drags the photo inside a frame the way they
// would in an image editor. Each frame is its own control with its own state,
// because the shapes want different crops — the whole reason framing is stored
// per frame. "Copy to all" is there for the common case where one crop does
// suit every shape, which is what this used to do automatically.
//
// State lives on each frame's dataset — the same place readListingForm() reads
// it from — so there is no parallel model to keep in sync, and a repaint after
// Save starts from the saved values. Delegated on a container for the same
// reason the image controls are.
// ---------------------------------------------------------------------------

function cropFrameFor(el: HTMLElement): HTMLElement | null {
  return el.closest('[data-lf-crop-frame]');
}

function paintCropFrame(frame: HTMLElement) {
  const x = Number(frame.dataset.lfCropX);
  const y = Number(frame.dataset.lfCropY);
  const scale = Number(frame.dataset.lfCropScale);
  const image = frame.querySelector('[data-lf-crop-window] img') as HTMLImageElement | null;
  // An untouched frame is left with no inline framing at all, so the preview
  // shows exactly what a visitor sees for a frame with no crop.
  if (image) image.setAttribute('style', imageCropStyle({ x, y, scale }));
  const readout = frame.querySelector('[data-lf-crop-readout]');
  if (readout) readout.textContent = `${(Number.isFinite(scale) ? scale : 1).toFixed(2)}×`;
}

function setCropFrame(frame: HTMLElement, x: number, y: number, scale: number) {
  frame.dataset.lfCropX = String(Math.min(100, Math.max(0, x)));
  frame.dataset.lfCropY = String(Math.min(100, Math.max(0, y)));
  frame.dataset.lfCropScale = String(Math.min(MAX_IMAGE_CROP_SCALE, Math.max(1, scale)));
  paintCropFrame(frame);
}

/** Puts one frame back to the framing an unframed image already has, slider
 * included — the slider is the one piece of state the dataset doesn't own. */
function resetCropFrame(frame: HTMLElement) {
  setCropFrame(frame, DEFAULT_IMAGE_CROP.x, DEFAULT_IMAGE_CROP.y, DEFAULT_IMAGE_CROP.scale);
  const slider = frame.querySelector('[data-lf-crop-zoom]') as HTMLInputElement | null;
  if (slider) slider.value = String(DEFAULT_IMAGE_CROP.scale);
}

export function wireImageCropControls(container: HTMLElement) {
  let dragging: { frame: HTMLElement; window: HTMLElement; pointerId: number; lastX: number; lastY: number } | null = null;

  container.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const frameWindow = target.closest('[data-lf-crop-window]') as HTMLElement | null;
    const frame = frameWindow && cropFrameFor(frameWindow);
    if (!frameWindow || !frame || !container.contains(frame)) return;
    event.preventDefault();
    frameWindow.setPointerCapture(event.pointerId);
    frameWindow.classList.add('dragging');
    dragging = { frame, window: frameWindow, pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
  });

  container.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const box = dragging.window.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Dragging right reveals what is further left, so the focal point moves
    // the opposite way — the grab-and-move feel of an image editor.
    const scale = Number(dragging.frame.dataset.lfCropScale) || 1;
    const x = Number(dragging.frame.dataset.lfCropX) - ((event.clientX - dragging.lastX) / box.width) * 100 / scale;
    const y = Number(dragging.frame.dataset.lfCropY) - ((event.clientY - dragging.lastY) / box.height) * 100 / scale;
    dragging.lastX = event.clientX;
    dragging.lastY = event.clientY;
    setCropFrame(dragging.frame, x, y, scale);
  });

  function endDrag(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    dragging.window.classList.remove('dragging');
    if (dragging.window.hasPointerCapture(event.pointerId)) {
      dragging.window.releasePointerCapture(event.pointerId);
    }
    dragging = null;
  }
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);

  // Dragging is the point of the control, but it can't be the only way to use
  // it: a focused frame nudges with the arrow keys.
  const NUDGE = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] } as Record<string, number[]>;
  container.addEventListener('keydown', (event) => {
    const step = NUDGE[event.key];
    const frameWindow = (event.target as HTMLElement).closest?.('[data-lf-crop-window]') as HTMLElement | null;
    const frame = step && frameWindow && cropFrameFor(frameWindow);
    if (!frame) return;
    event.preventDefault();
    setCropFrame(
      frame,
      Number(frame.dataset.lfCropX) + step[0],
      Number(frame.dataset.lfCropY) + step[1],
      Number(frame.dataset.lfCropScale) || 1
    );
  });

  container.addEventListener('input', (event) => {
    const slider = event.target as HTMLInputElement;
    if (!slider.matches?.('[data-lf-crop-zoom]')) return;
    const frame = cropFrameFor(slider);
    if (!frame) return;
    setCropFrame(frame, Number(frame.dataset.lfCropX), Number(frame.dataset.lfCropY), Number(slider.value));
  });

  container.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const frame = cropFrameFor(target);
    if (!frame || !container.contains(frame)) return;

    if (target.closest('[data-lf-crop-reset]')) {
      resetCropFrame(frame);
      return;
    }

    if (!target.closest('[data-lf-crop-apply-all]')) return;
    const x = Number(frame.dataset.lfCropX);
    const y = Number(frame.dataset.lfCropY);
    const scale = Number(frame.dataset.lfCropScale) || 1;
    const block = frame.closest('[data-lf-crop]');
    block?.querySelectorAll<HTMLElement>('[data-lf-crop-frame]').forEach((other) => {
      if (other === frame) return;
      setCropFrame(other, x, y, scale);
      const slider = other.querySelector('[data-lf-crop-zoom]') as HTMLInputElement | null;
      if (slider) slider.value = String(scale);
    });
  });
}

/** Click-to-select behaviour for the owner's featured-photo picker. Delegated
 * on a container so it survives the form being repainted after a save. */
export function wireListingPhotoPicker(container: HTMLElement) {
  container.addEventListener('click', (event) => {
    const tile = (event.target as HTMLElement).closest('[data-lf-pick]') as HTMLElement | null;
    if (!tile || !container.contains(tile)) return;

    const picker = tile.closest('[data-lf-picker]') as HTMLElement | null;
    if (!picker) return;

    const field = picker.querySelector('[data-lf="image"]') as HTMLInputElement;
    field.value = tile.dataset.lfPick || '';
    picker.querySelectorAll('[data-lf-pick]').forEach((el) => el.classList.remove('selected'));
    picker.querySelectorAll('[data-lf-pick]').forEach((el) => el.setAttribute('aria-pressed', 'false'));
    tile.classList.add('selected');
    tile.setAttribute('aria-pressed', 'true');
  });
}
