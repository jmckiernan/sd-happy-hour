import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { normalizeSourceItem } from '../src/lib/contentEngine/normalize.ts';
import { duplicateScore, findDuplicate, mergeContentItems } from '../src/lib/contentEngine/dedupe.ts';
import { buildEditorialClusters } from '../src/lib/contentEngine/cluster.ts';
import { collectDateTags, linkAndEmphasizeDates } from '../src/lib/contentEngine/dateLinks.ts';
import { canAutoPublish } from '../src/lib/contentEngine/quality.ts';
import { isSafePublicSourceUrl, sourceAdapterInternals } from '../src/lib/contentEngine/sourceAdapters.ts';
import { generateDraftBundle } from '../src/lib/contentEngine/ai.ts';
import { resolveDraftImage } from '../src/lib/contentEngine/images.ts';
import { buildPublishedMarkdown } from '../src/lib/contentEngine/publish.ts';

const source = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'First-party calendar',
  kind: 'rss',
  url: 'https://example.com/events.rss',
  enabled: true,
  trustScore: 0.9,
  countyScoped: false,
  imagePolicy: 'none',
  config: {},
  ...overrides,
});

function provenance(id, overrides = {}) {
  return {
    sourceId: id,
    sourceName: `Source ${id.slice(0, 4)}`,
    sourceKind: 'rss',
    sourceUrl: `https://example.com/events/${id}`,
    sourceTitle: 'Source event title',
    sourceDescription: 'A source-grounded description of this San Diego event.',
    sourcePublishedAt: '2026-08-20T17:00:00.000Z',
    fetchedAt: '2026-08-25T16:00:00.000Z',
    imageUrls: [],
    attribution: 'Example Events',
    trustScore: 0.9,
    imagePolicy: 'none',
    raw: {},
    ...overrides,
  };
}

function item(index, overrides = {}) {
  const sourceId = `${index}`.padStart(8, '0') + '-1111-4111-8111-111111111111';
  return {
    id: `${index}`.padStart(8, '0') + '-2222-4222-8222-222222222222',
    canonicalKey: `key-${index}`,
    venueName: `Venue ${index}`,
    title: `Live Music Pick ${index}`,
    description: 'A detailed source-grounded description with enough useful information for editorial review and planning in San Diego County.',
    eventStartAt: `2026-08-28T${String(17 + index).padStart(2, '0')}:00:00.000Z`,
    eventEndAt: `2026-08-28T${String(18 + index).padStart(2, '0')}:00:00.000Z`,
    allDay: false,
    neighborhood: 'North Park',
    area: 'San Diego',
    address: `${3000 + index} University Ave, San Diego, CA`,
    county: 'San Diego',
    confidenceScore: 0.86,
    status: 'accepted',
    eventTypes: ['live-music'],
    tags: ['live-music', 'north-park'],
    imageUrls: [],
    qualityFlags: [],
    provenance: [provenance(sourceId)],
    ...overrides,
  };
}

test('RSS ingestion extracts labeled event date, venue, address, cost, and image', () => {
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title>Fri 8/28: Sunset Sessions</title>
    <link>https://example.com/sunset-sessions</link>
    <description>&lt;img src="https://example.com/hero.jpg"&gt;
      &lt;p&gt;&lt;strong&gt;When:&lt;/strong&gt; Friday, Aug. 28, 2026, 6 p.m. to 9:30 p.m.&lt;/p&gt;
      &lt;p&gt;&lt;strong&gt;Where:&lt;/strong&gt; The Local Room, 3000 University Ave, San Diego&lt;/p&gt;
      &lt;p&gt;&lt;strong&gt;Cost:&lt;/strong&gt; $12&lt;/p&gt;
      &lt;p&gt;&lt;strong&gt;Description:&lt;/strong&gt; Three local bands play an outdoor set.&lt;/p&gt;
    </description><guid>sunset-1</guid></item></channel></rss>`;
  const [raw] = sourceAdapterInternals.parseFeed(xml);
  assert.equal(raw.title, 'Sunset Sessions');
  assert.equal(raw.venueName, 'The Local Room');
  assert.equal(raw.startAt, '2026-08-29T01:00:00.000Z');
  assert.equal(raw.endAt, '2026-08-29T04:30:00.000Z');
  assert.match(raw.description, /Cost: \$12/);
  assert.deepEqual(raw.imageUrls, ['https://example.com/hero.jpg']);
});

test('source URLs reject local, private, credentialed, and cloud-metadata destinations', () => {
  assert.equal(isSafePublicSourceUrl('https://www.sandiegoreader.com/rss/events/'), true);
  assert.equal(isSafePublicSourceUrl('http://127.0.0.1:3000/private'), false);
  assert.equal(isSafePublicSourceUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isSafePublicSourceUrl('http://192.168.1.5/feed'), false);
  assert.equal(isSafePublicSourceUrl('https://user:pass@example.com/feed'), false);
  assert.equal(isSafePublicSourceUrl('file:///etc/passwd'), false);
});

test('JSON-LD ingestion supports venues outside the existing site directory', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'ComedyEvent', name: 'Late Night Laughs',
    url: 'https://newclub.example/shows/laughs', startDate: '2026-08-29T20:00:00-07:00',
    description: 'A one-night stand-up showcase.',
    location: { '@type': 'Place', name: 'Brand New Comedy Club', address: {
      streetAddress: '101 Market St', addressLocality: 'San Diego', addressRegion: 'CA', postalCode: '92101',
    } },
  })}</script>`;
  const [raw] = sourceAdapterInternals.parseJsonLd(html, 'https://newclub.example/events');
  const normalized = normalizeSourceItem(source({ kind: 'json_ld' }), raw);
  assert.equal(normalized.accepted, true);
  assert.equal(normalized.item.venueName, 'Brand New Comedy Club');
  assert.equal(normalized.item.eventStartAt, '2026-08-30T03:00:00.000Z');
  assert.ok(normalized.item.eventTypes.includes('comedyevent'));
});

test('normalization rejects out-of-county items and caps county-scoped ambiguity for review', () => {
  const outside = normalizeSourceItem(source(), {
    url: 'https://example.com/orange-county', title: 'Irvine Food Festival',
    description: 'A weekend event in Orange County.', area: 'Irvine, Orange County',
    startAt: '2026-08-30T18:00:00-07:00',
  });
  assert.equal(outside.accepted, false);
  assert.equal(outside.reason, 'outside_san_diego_county');

  const ambiguous = normalizeSourceItem(source({ countyScoped: true, trustScore: 0.95 }), {
    url: 'https://example.com/show', title: 'Saturday Night Showcase',
    description: 'A lineup announcement with no location in the entry.', startAt: '2026-08-30T20:00:00-07:00',
  });
  assert.equal(ambiguous.accepted, true);
  assert.ok(ambiguous.item.qualityFlags.includes('location_unverified'));
  assert.ok(ambiguous.item.confidenceScore <= 0.65);
  assert.equal(ambiguous.item.status, 'review');
});

test('dedupe merges corroborating provenance without collapsing different dates', () => {
  const first = item(1, { title: 'North Park Sunset Sessions', venueName: 'The Local Room' });
  const second = item(2, {
    canonicalKey: 'other-key', title: 'Sunset Sessions at The Local Room', venueName: 'Local Room',
    eventStartAt: first.eventStartAt, eventEndAt: first.eventEndAt,
  });
  assert.ok(duplicateScore(first, second) >= 0.78);
  assert.equal(findDuplicate(second, [first]).item.id, first.id);
  const merged = mergeContentItems(first, second);
  assert.equal(merged.provenance.length, 2);
  assert.ok(merged.confidenceScore > first.confidenceScore);

  const nextWeek = { ...second, eventStartAt: '2026-09-04T18:00:00.000Z' };
  assert.equal(duplicateScore(first, nextWeek), 0);
});

test('clustering creates a useful date roundup from independent county-wide venues', () => {
  const clusters = buildEditorialClusters([item(1), item(2), item(3)], {
    minItemConfidence: 0.5, minClusterScore: 0.5,
  });
  assert.ok(clusters.length >= 1);
  assert.equal(clusters[0].clusterType, 'date_roundup');
  assert.equal(clusters[0].items.length, 3);
  assert.match(clusters[0].workingTitle, /Things to Do in San Diego/);
});

test('AI draft generation produces full blog SEO and separately written newsletter content', async () => {
  const filler = Array.from({ length: 95 }, (_, index) => `Useful planning detail ${index + 1} stays tied to the supplied source and helps readers compare the options.`).join(' ');
  const responses = [
    `TITLE: San Diego Live Music Picks for Friday Night
DESCRIPTION: Compare three current North Park live-music options with exact dates, locations, and source links for a smarter Friday plan.
META_DESCRIPTION: Find three current San Diego live-music picks for Friday, with source-backed dates, locations, and practical planning details.
OG_TITLE: Three San Diego Live Music Picks This Friday
OG_DESCRIPTION: A source-backed guide to three Friday live-music choices around North Park.
TAGS: ["live music", "north park", "friday night"]
HASHTAGS: ["#SanDiego", "#LiveMusic", "#NorthPark"]
---BODY---
San Diego has three useful options on August 28, 2026. ${filler}

## Compare the three options

[Check the first source](https://example.com/events/one) before making plans.`,
    `SUBJECT: Three source-backed Friday picks
PREHEADER: Live music choices with the practical details up front.
---BODY---
Friday has range. ${Array.from({ length: 35 }, (_, index) => `Newsletter note ${index + 1} gives readers a brisk, distinct reason to compare the current picks.`).join(' ')}

## Before you go

[Confirm the lineup](https://example.com/events/one).`,
  ];
  const model = { complete: async () => responses.shift() };
  const cluster = buildEditorialClusters([item(1), item(2), item(3)], { minClusterScore: 0.5 })[0];
  const { blog, newsletter } = await generateDraftBundle(cluster, model);
  assert.equal(blog.contentType, 'blog');
  assert.match(blog.seoMetadata.metaDescription, /source-backed dates/);
  assert.deepEqual(blog.seoMetadata.hashtags, ['#SanDiego', '#LiveMusic', '#NorthPark']);
  assert.match(blog.bodyMarkdown, /\*\*\[August 28, 2026\]\(\/blog\/date\/2026-08-28\/\)\*\*/);
  assert.match(blog.bodyMarkdown, /## Sources and verification/);
  assert.ok(blog.bodyMarkdown.split(/\s+/).length > 500);
  assert.equal(newsletter.contentType, 'newsletter');
  assert.notEqual(newsletter.bodyMarkdown.slice(0, 120), blog.bodyMarkdown.slice(0, 120));
  assert.ok(newsletter.structuredBlocks.length >= 2);
});

test('image workflow only attaches permitted images and otherwise falls back safely', async () => {
  const baseCluster = buildEditorialClusters([item(1), item(2), item(3)], { minClusterScore: 0.5 })[0];
  const draft = {
    contentType: 'blog', title: 'A useful San Diego guide', slug: 'useful-guide', description: 'Description',
    bodyMarkdown: 'Body', seoMetadata: { metaDescription: 'Description', ogTitle: 'Title', ogDescription: 'Description', hashtags: [] },
    tags: [], dates: [], locations: ['North Park'], brands: [], eventTypes: [], qualityScore: 0, qualityFlags: [],
  };
  const unavailable = await resolveDraftImage({ cluster: baseCluster, draft, allowGeneration: false });
  assert.equal(unavailable.outcome, 'unavailable');
  assert.equal(unavailable.url, null);

  const permittedCluster = structuredClone(baseCluster);
  permittedCluster.items[0].provenance[0].imagePolicy = 'first_party';
  permittedCluster.items[0].provenance[0].imageUrls = ['https://venue.example/press/hero.jpg'];
  const attached = await resolveDraftImage({ cluster: permittedCluster, draft, allowGeneration: false });
  assert.equal(attached.outcome, 'attached');
  assert.equal(attached.url, 'https://venue.example/press/hero.jpg');
  assert.equal(attached.metadata.attribution, 'Example Events');
});

test('date tagging is idempotent and archive links are bold', () => {
  const dates = collectDateTags(['2026-08-28T18:00:00-07:00', '2026-08-28T23:00:00-07:00']);
  assert.deepEqual(dates, ['2026-08-28']);
  const once = linkAndEmphasizeDates('Come by August 28, 2026. Keep [this date](https://example.com) unchanged.', dates);
  const twice = linkAndEmphasizeDates(once, dates);
  assert.equal(once, twice);
  assert.match(once, /\*\*\[August 28, 2026\]\(\/blog\/date\/2026-08-28\/\)\*\*/);
  assert.match(once, /\[this date\]\(https:\/\/example.com\)/);
});

test('auto-publish requires the toggle, high quality, complete logistics, and corroboration', () => {
  const cluster = buildEditorialClusters([item(1), item(2), item(3)], { minClusterScore: 0.5 })[0];
  const draft = {
    contentType: 'blog', title: 'Qualified San Diego Friday Guide', description: 'A complete description', bodyMarkdown: 'Complete body',
    seoMetadata: { metaDescription: 'Meta', ogTitle: 'OG', ogDescription: 'OG description', hashtags: [] },
    tags: ['san-diego'], dates: ['2026-08-28'], locations: ['North Park'], brands: [], eventTypes: ['live-music'],
    qualityScore: 0.96, qualityFlags: [],
  };
  const settings = {
    autoPublishEnabled: false, autoPublishMinQuality: 0.9, minItemConfidence: 0.55,
    minClusterScore: 0.62, requireMultipleSources: true, generateImages: true, runSchedule: 'twice_daily',
  };
  assert.equal(canAutoPublish(draft, cluster, settings).allowed, false);
  assert.equal(canAutoPublish(draft, cluster, { ...settings, autoPublishEnabled: true }).allowed, true);
  const oneSourceCluster = structuredClone(cluster);
  oneSourceCluster.items.forEach((entry) => { entry.provenance = [provenance('same-source')]; });
  assert.ok(canAutoPublish(draft, oneSourceCluster, { ...settings, autoPublishEnabled: true }).reasons.includes('needs_corroboration'));
});

test('publisher preserves SEO, taxonomy, provenance, image, and review decision', () => {
  const cluster = buildEditorialClusters([item(1), item(2), item(3)], { minClusterScore: 0.5 })[0];
  const markdown = buildPublishedMarkdown({
    cluster,
    draft: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', contentType: 'blog', title: 'San Diego Friday Guide',
      description: 'A useful Friday guide.', bodyMarkdown: 'Published body.',
      seoMetadata: { metaDescription: 'Search description.', ogTitle: 'Social title', ogDescription: 'Social description.', hashtags: ['#SanDiego'] },
      tags: ['live-music'], dates: ['2026-08-28'], locations: ['North Park'], brands: ['Venue 1'],
      eventTypes: ['live-music'], heroImageUrl: '/api/images/generated.png', qualityScore: 0.95, qualityFlags: [],
    },
    publishDate: '2026-08-25',
  });
  assert.match(markdown, /draft: false/);
  assert.match(markdown, /metaDescription: "Search description\."/);
  assert.match(markdown, /dates: \["2026-08-28"\]/);
  assert.match(markdown, /sourceUrls: \[/);
  assert.match(markdown, /contentEngineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"/);
  assert.match(markdown, /heroImage: "\/api\/images\/generated\.png"/);
});

test('migration and archive routes cover review, provenance, analytics, and expired visibility', async () => {
  const migration = await readFile(resolve(process.cwd(), 'migrations/0016_content_engine.sql'), 'utf8');
  for (const table of ['content_sources','content_ingestion_runs','content_items','content_item_sources','content_clusters','content_cluster_items','content_drafts','content_engine_settings','content_engine_events']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /auto_publish_enabled\s+boolean NOT NULL DEFAULT false/);
  assert.match(migration, /UNIQUE \(item_id, source_url\)/);
  const dateArchive = await readFile(resolve(process.cwd(), 'src/pages/blog/date/[date].astro'), 'utf8');
  assert.match(dateArchive, /!data\.draft/);
  assert.doesNotMatch(dateArchive, /eventEnd|event_end|new Date\(\)\s*[<>]/);
  assert.match(dateArchive, /posts\.filter\(\(post\) => post\.data\.dates\.includes\(date\)\)/);
});
