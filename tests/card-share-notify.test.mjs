import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CARD_FOLLOW_DEFAULTS,
  renderCardShareNotifyIcons,
  venuePublicUrl,
} from '../src/lib/cardShareNotify.ts';

test('venuePublicUrl builds the public venue path', () => {
  assert.equal(venuePublicUrl('sunset-patio', 'https://example.com'), 'https://example.com/venues/sunset-patio/');
  assert.equal(venuePublicUrl('foo'), '/venues/foo/');
});

test('CARD_FOLLOW_DEFAULTS match venue-page follow create payload', () => {
  assert.deepEqual(CARD_FOLLOW_DEFAULTS, {
    promotionAlertsEnabled: true,
    channels: { email: true },
  });
});

test('renderCardShareNotifyIcons includes share + notify controls', () => {
  const html = renderCardShareNotifyIcons({
    venueId: 12,
    venueName: 'Sunset Patio',
    slug: 'sunset-patio',
    following: false,
  });
  assert.match(html, /data-card-notify/);
  assert.match(html, /data-card-share/);
  assert.match(html, /data-venue-slug="sunset-patio"/);
  assert.match(html, /data-share-action="copy"/);
  assert.match(html, /data-share-action="facebook"/);
  assert.match(html, /share-fb-mark/);
  assert.match(html, /Share on Facebook/);
  assert.match(html, /data-notify-pref="live-deals"/);
  assert.match(html, /Coming soon/);
  assert.doesNotMatch(html, /is-following/);
});

test('renderCardShareNotifyIcons marks following state', () => {
  const html = renderCardShareNotifyIcons({
    venueId: 12,
    venueName: 'Sunset Patio',
    slug: 'sunset-patio',
    following: true,
    promotionAlertsEnabled: false,
  });
  assert.match(html, /is-following/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /data-notify-pref="live-deals" checked/);
});

test('home save panel keeps share/notify beside Save, not in the footer', async () => {
  const source = await readFile(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(source, /renderCardShareNotifyIcons/);
  assert.match(source, /save-panel-trailing/);
  assert.match(source, /hydrateCardFollows/);
  assert.doesNotMatch(source, /card-footer[\s\S]{0,400}data-card-share/);
  assert.doesNotMatch(source, /card-footer[\s\S]{0,400}data-card-notify/);
});

test('home saved panel puts share/notify beside manage-list dropdown', async () => {
  const source = await readFile(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  const savedPanelStart = source.indexOf('data-saved-spot="${h.id}"');
  assert.ok(savedPanelStart > 0, 'expected saved save-panel markup');
  const savedPanelEnd = source.indexOf('</div>\n      `;', savedPanelStart);
  assert.ok(savedPanelEnd > savedPanelStart, 'expected saved panel closing markup');
  const savedPanel = source.slice(savedPanelStart, savedPanelEnd);
  assert.doesNotMatch(savedPanel, /save-list-chip/);
  assert.doesNotMatch(savedPanel, /Ratings, comments/);
  assert.match(savedPanel, /save-panel-row[\s\S]*data-manage-list-combobox[\s\S]*save-panel-trailing[\s\S]*\$\{actionIcons\}/);
});

test('notify prefs markup uses a labeled row structure', () => {
  const html = renderCardShareNotifyIcons({
    venueId: 12,
    venueName: 'Sunset Patio',
    slug: 'sunset-patio',
  });
  assert.match(html, /card-notify-pref-label/);
  assert.match(html, /Events <em>Coming soon<\/em>/);
});

test('neighborhood cards include the shared action icons', async () => {
  const source = await readFile(new URL('../src/pages/neighborhoods/[slug].astro', import.meta.url), 'utf8');
  assert.match(source, /renderCardShareNotifyIcons/);
  assert.match(source, /card-actions-row/);
  assert.match(source, /hydrateCardFollows/);
  assert.match(source, /bindCardShareNotify/);
});
