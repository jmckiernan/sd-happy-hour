#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { createCachedFetch, mapPool } from './lib/fetch-page.mjs';
import { createBrowserFetch } from './lib/playwright-browser.mjs';
import { discoverSocialLinks } from './lib/media.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { recordAiUsage, formatAiUsage } from './lib/ai-usage.mjs';
import {
  discoverVenueImageCandidates,
  fetchVenueImageCandidate,
  venueImageFilename,
  relativeVenueImagePath,
} from './lib/venue-images.mjs';
import {
  discoverBranchLocationLinksFromHtml,
  pickLocationPage,
  scoreLocationUrl,
} from './lib/location-page.mjs';

const IMAGE_DIR = path.join(ROOT_DIR, 'public', 'images', 'venues');
const RUN_PATH = path.join(ROOT_DIR, '.data', 'import', 'venue-images.json');
const MODEL = process.env.VENUE_IMAGE_AI_MODEL?.trim() || 'claude-haiku-4-5';
const REVIEW_LIMIT = 5;

function parseOptions(argv) {
  const options = {
    apply: false,
    browser: false,
    refresh: false,
    includeUnlisted: false,
    noAi: false,
    force: false,
    limit: 0,
    concurrency: 4,
    ids: new Set(),
    approvals: new Map(),
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--browser') options.browser = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--include-unlisted') options.includeUnlisted = true;
    else if (arg === '--no-ai') options.noAi = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--limit=')) options.limit = Math.max(0, Number(arg.slice(8)) || 0);
    else if (arg.startsWith('--concurrency=')) options.concurrency = Math.max(1, Number(arg.slice(14)) || 1);
    else if (arg.startsWith('--ids=')) {
      for (const id of arg.slice(6).split(',')) if (Number(id)) options.ids.add(Number(id));
    } else if (arg.startsWith('--approve=')) {
      for (const pair of arg.slice(10).split(',')) {
        const [id, index] = pair.split(':').map(Number);
        if (Number.isInteger(id) && Number.isInteger(index) && index >= 0) options.approvals.set(id, index);
      }
    } else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return `Venue hero image backfill (website-first)

Usage:
  npm run images:backfill -- [--apply] [--limit=25] [--ids=4,6] [--browser]

Default: published venues without image, preview only. Images are attached only
when the visual review model calls a venue-owned candidate suitable with high
confidence. Everything else is written to .data/import/venue-images.json.

Options:
  --apply              write approved bytes and update happy-hours.json
  --browser            use Playwright when plain HTML is unreadable
  --refresh            bypass the shared website page cache
  --no-ai              discovery only; place every candidate in review
  --include-unlisted   include claim-only/unlisted rows (normally wasteful)
  --force              retry venues already present in the run manifest
  --limit=N            process at most N venues
  --ids=1,2,3          process only these venue ids
  --approve=13:0       manually attach candidate index 0 from the review sheet
  --concurrency=N      website worker count (default 4)`;
}

function isPublished(venue) {
  return venue.listingStatus !== 'unlisted' && venue.startTime && venue.endTime && venue.days?.length;
}

function sameSite(a, b) {
  try {
    const host = (value) => new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
    return host(a) === host(b);
  } catch {
    return false;
  }
}

function photoPageLinks(html, pageUrl, venue = null, max = 3) {
  const ranked = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(match[1], pageUrl).href; } catch { continue; }
    if (!sameSite(url, pageUrl) || seen.has(url)) continue;
    const text = `${match[1]} ${match[2].replace(/<[^>]+>/g, ' ')}`.toLowerCase();
    let score = 0;
    if (/gallery|photos?|our space|interior|about us|visit us/.test(text)) score += 30;
    if (/location|restaurant|dining/.test(text)) score += 12;
    if (venue) {
      const locationScore = scoreLocationUrl(url, venue);
      if (locationScore > 0) score += 40 + locationScore;
    }
    if (/privacy|terms|career|blog|press|events?|menu|order|reserv/.test(text) && score < 40) score -= 30;
    if (score <= 0) continue;
    seen.add(url);
    ranked.push({ url, score });
  }

  if (venue) {
    for (const link of discoverBranchLocationLinksFromHtml(html, pageUrl, venue)) {
      let url;
      try { url = new URL(link.path, pageUrl).href; } catch { continue; }
      if (seen.has(url)) continue;
      const locationScore = scoreLocationUrl(url, venue);
      if (locationScore <= 0) continue;
      seen.add(url);
      ranked.push({ url, score: 50 + locationScore });
    }
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, max).map((row) => row.url);
}

async function fetchHtml(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
      sdhhWaitMode: 'discovery',
    });
    if (!response?.ok) return { ok: false, url, status: response?.status || 0, html: '' };
    return { ok: true, url, status: response.status || 200, html: String(await response.text()).slice(0, 1_000_000) };
  } catch (error) {
    return { ok: false, url, status: 0, html: '', reason: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function reviewWithAi(venue, candidates) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || !candidates.length) return null;
  const usable = candidates.filter((row) => row.image.bytes.length <= 5_000_000).slice(0, REVIEW_LIMIT);
  if (!usable.length) return null;

  const content = [{
    type: 'text',
    text: `Choose a hero photograph for this exact venue: ${venue.name}, ${venue.address}, ${venue.neighborhood}.

The image must visibly depict the venue, its interior/exterior/patio, or its food/drinks in a photographic scene. Reject logos, wordmarks, flyers, menus, collages dominated by text, generic stock photography, people-only photos, and images clearly belonging to a different branch. A wide crop is preferred. When identity cannot be established from the image and source context, reject it.

Return only compact JSON: {"suitable":boolean,"index":number|null,"confidence":"high"|"medium"|"low","reason":string}. Indexes are zero-based.`
  }];
  usable.forEach((row, index) => {
    content.push({ type: 'text', text: `Candidate ${index}: ${row.candidate.source}; page ${row.candidate.pageUrl}; asset ${row.candidate.url}; ${row.image.width}x${row.image.height}` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: row.image.contentType, data: row.image.bytes.toString('base64') },
    });
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 260, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`image review API ${response.status}: ${(await response.text()).slice(0, 240)}`);
  const data = await response.json();
  recordAiUsage('venue-image', data.usage, {
    model: MODEL,
    imageBlocks: usable.length,
    imageBytes: usable.reduce((sum, row) => sum + row.image.bytes.length, 0),
  });
  const text = data.content?.find((block) => block.type === 'text')?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('image review returned no JSON');
  const result = JSON.parse(match[0]);
  const chosen = Number.isInteger(result.index) ? usable[result.index] : null;
  return { ...result, chosen };
}

function compactCandidate(row) {
  return {
    provider: 'venue_website',
    source: row.candidate.source,
    pageUrl: row.candidate.pageUrl,
    assetUrl: row.candidate.url,
    width: row.image.width,
    height: row.image.height,
    score: row.image.score,
  };
}

async function inspectVenue(venue, fetchImpl, options) {
  const startedAt = new Date().toISOString();
  const first = await fetchHtml(venue.website, fetchImpl);
  if (!first.ok) {
    return { venueId: venue.id, name: venue.name, outcome: 'website_unreadable', startedAt, website: venue.website, status: first.status, reason: first.reason || null };
  }

  const pages = [first];
  const followUrls = photoPageLinks(first.html, first.url, venue);
  // Prefer this venue's branch page over brand-home gallery noise.
  const pickedBranch = pickLocationPage([first.url, ...followUrls], venue);
  if (pickedBranch?.url && pickedBranch.url !== first.url && !followUrls.includes(pickedBranch.url)) {
    followUrls.unshift(pickedBranch.url);
  }
  for (const url of followUrls) {
    if (pages.some((page) => page.url === url)) continue;
    const page = await fetchHtml(url, fetchImpl);
    if (page.ok) pages.push(page);
  }
  // Rank pages so branch-location HTML is mined first.
  pages.sort((a, b) => scoreLocationUrl(b.url, venue) - scoreLocationUrl(a.url, venue));
  const socials = pages.flatMap((page) => discoverSocialLinks(page.html, page.url));
  const raw = pages.flatMap((page) => discoverVenueImageCandidates(page.html, page.url, venue));
  const deduped = [...new Map(raw.map((row) => [row.url, row])).values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const checked = (await mapPool(deduped, 3, async (candidate) => {
    const image = await fetchVenueImageCandidate(candidate);
    return image.ok ? { candidate, image } : null;
  })).filter(Boolean).sort((a, b) => b.image.score - a.image.score);

  if (!checked.length) {
    return {
      venueId: venue.id,
      name: venue.name,
      outcome: 'no_usable_website_candidate',
      startedAt,
      website: venue.website,
      instagram: socials.find((row) => row.network === 'instagram')?.url || null,
      candidatesFound: deduped.length,
    };
  }

  let review = null;
  if (!options.noAi) {
    try { review = await reviewWithAi(venue, checked); }
    catch (error) {
      return {
        venueId: venue.id,
        name: venue.name,
        outcome: 'review_error',
        startedAt,
        website: venue.website,
        reason: error.message,
        candidates: checked.slice(0, REVIEW_LIMIT).map(compactCandidate),
      };
    }
  }

  const approved = review?.suitable === true && review?.confidence === 'high' && review.chosen;
  if (!approved) {
    return {
      venueId: venue.id,
      name: venue.name,
      outcome: 'review_needed',
      startedAt,
      website: venue.website,
      instagram: socials.find((row) => row.network === 'instagram')?.url || null,
      review: review ? { suitable: Boolean(review.suitable), index: review.index ?? null, confidence: review.confidence || 'low', reason: String(review.reason || '') } : null,
      candidates: checked.slice(0, REVIEW_LIMIT).map(compactCandidate),
    };
  }

  return {
    venueId: venue.id,
    name: venue.name,
    outcome: options.apply ? 'attached' : 'would_attach',
    startedAt,
    website: venue.website,
    review: { confidence: 'high', reason: String(review.reason || '') },
    selected: compactCandidate(review.chosen),
    selectedBytes: review.chosen.image.bytes,
    selectedContentType: review.chosen.image.contentType,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const prior = readJson(RUN_PATH, { version: 1, venues: {} });
  if (options.approvals.size && !options.apply) throw new Error('--approve requires --apply.');
  await fs.mkdir(IMAGE_DIR, { recursive: true });

  let catalogMaintenance = 0;
  if (options.apply) {
    const assets = new Map();
    for (const venue of venues.filter((row) => row.imageSource?.provider === 'venue_website').sort((a, b) => a.id - b.id)) {
      const assetUrl = venue.imageSource.assetUrl || '';
      if (assetUrl && assets.has(assetUrl)) {
        const original = assets.get(assetUrl);
        const oldPath = venue.image?.startsWith('/images/venues/') ? path.join(ROOT_DIR, 'public', venue.image) : null;
        prior.venues[venue.id] = {
          ...(prior.venues[venue.id] || {}),
          venueId: venue.id,
          name: venue.name,
          outcome: 'review_needed_duplicate',
          reason: `Same official-site asset as ${original.id} ${original.name}; a branch-specific image is required.`,
        };
        delete venue.image;
        delete venue.imageSource;
        delete venue.imageCrop;
        if (oldPath && path.basename(oldPath).includes('-website.')) {
          try { await fs.unlink(oldPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        catalogMaintenance += 1;
        continue;
      }
      if (assetUrl) assets.set(assetUrl, venue);
      const imagePath = venue.image?.startsWith('/images/venues/') ? path.join(ROOT_DIR, 'public', venue.image) : null;
      if (imagePath) {
        const bytes = await fs.readFile(imagePath);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        if (venue.imageSource.sha256 !== sha256 || !venue.imageSource.rightsBasis) {
          venue.imageSource.sha256 = sha256;
          venue.imageSource.rightsBasis = 'published_on_official_venue_website';
          catalogMaintenance += 1;
        }
      }
    }
  }

  let manuallyAttached = 0;
  if (options.approvals.size) {
    const assets = new Map(
      venues.filter((row) => row.imageSource?.assetUrl).map((row) => [row.imageSource.assetUrl, row])
    );
    for (const [venueId, candidateIndex] of options.approvals) {
      const venue = venues.find((row) => row.id === venueId);
      const record = prior.venues?.[venueId];
      const candidate = record?.candidates?.[candidateIndex];
      if (!venue || !candidate) throw new Error(`No review candidate ${candidateIndex} for venue ${venueId}.`);
      if (venue.image) throw new Error(`${venueId} ${venue.name} already has an image.`);
      const duplicate = assets.get(candidate.assetUrl);
      if (duplicate) throw new Error(`${venueId} candidate is already used by ${duplicate.id} ${duplicate.name}.`);
      const image = await fetchVenueImageCandidate({
        url: candidate.assetUrl,
        pageUrl: candidate.pageUrl,
        source: candidate.source,
        score: candidate.score || 0,
      });
      if (!image.ok) throw new Error(`${venueId} approved candidate could not be re-fetched: ${image.reason}.`);
      const filename = venueImageFilename(venue, image.contentType);
      await fs.writeFile(path.join(IMAGE_DIR, filename), image.bytes);
      venue.image = relativeVenueImagePath(filename);
      venue.imageSource = {
        provider: 'venue_website',
        pageUrl: candidate.pageUrl,
        assetUrl: candidate.assetUrl,
        retrievedAt: new Date().toISOString(),
        review: 'manual',
        rightsBasis: 'published_on_official_venue_website',
        sha256: crypto.createHash('sha256').update(image.bytes).digest('hex'),
      };
      assets.set(candidate.assetUrl, venue);
      prior.venues[venueId] = { ...record, outcome: 'attached', manualApproval: { candidateIndex, approvedAt: new Date().toISOString() } };
      manuallyAttached += 1;
    }
  }
  let targets = venues.filter((venue) => !venue.image && (options.includeUnlisted || isPublished(venue)));
  if (options.ids.size) targets = targets.filter((venue) => options.ids.has(Number(venue.id)));
  if (!options.force) targets = targets.filter((venue) => !prior.venues?.[venue.id] || prior.venues[venue.id].outcome === 'review_error');
  if (options.limit) targets = targets.slice(0, options.limit);

  console.log(`${options.apply ? 'Applying' : 'Previewing'} website images for ${targets.length} venue(s).`);
  if (!options.noAi && !process.env.ANTHROPIC_API_KEY?.trim()) {
    console.warn('ANTHROPIC_API_KEY is absent; candidates will be queued for review and never auto-attached.');
    options.noAi = true;
  }

  let browser = null;
  if (options.browser) browser = await createBrowserFetch();
  const fetchImpl = createCachedFetch({ browserFetch: browser?.fetch || null, refresh: options.refresh });
  const results = await mapPool(targets, options.concurrency, async (venue) => {
    const result = await inspectVenue(venue, fetchImpl, options);
    console.log(`  ${String(venue.id).padStart(4)}  ${result.outcome.padEnd(29)} ${venue.name}`);
    return result;
  });

  if (browser) await browser.close();
  let attached = 0;
  const assignedAssets = new Map(
    venues.filter((row) => row.imageSource?.assetUrl).map((row) => [row.imageSource.assetUrl, row])
  );
  for (const result of results) {
    if (result.outcome === 'attached' && result.selectedBytes) {
      const venue = venues.find((row) => row.id === result.venueId);
      const duplicate = assignedAssets.get(result.selected.assetUrl);
      if (duplicate && duplicate.id !== venue.id) {
        result.outcome = 'review_needed_duplicate';
        result.reason = `Same official-site asset as ${duplicate.id} ${duplicate.name}; a branch-specific image is required.`;
        delete result.selectedBytes;
        delete result.selectedContentType;
        prior.venues[result.venueId] = result;
        continue;
      }
      const filename = venueImageFilename(venue, result.selectedContentType);
      await fs.writeFile(path.join(IMAGE_DIR, filename), result.selectedBytes);
      venue.image = relativeVenueImagePath(filename);
      venue.imageSource = {
        provider: 'venue_website',
        pageUrl: result.selected.pageUrl,
        assetUrl: result.selected.assetUrl,
        retrievedAt: new Date().toISOString(),
        review: 'ai_high_confidence',
        rightsBasis: 'published_on_official_venue_website',
        sha256: crypto.createHash('sha256').update(result.selectedBytes).digest('hex'),
      };
      assignedAssets.set(result.selected.assetUrl, venue);
      attached += 1;
    }
    delete result.selectedBytes;
    delete result.selectedContentType;
    prior.venues[result.venueId] = result;
  }
  prior.version = 1;
  prior.updatedAt = new Date().toISOString();
  prior.sourceOrder = ['venue_website', 'instagram_owner_authorized', 'licensed_web_search', 'owner_upload', 'stock_fallback'];
  writeJson(RUN_PATH, prior);
  if (options.apply && (attached || manuallyAttached || catalogMaintenance)) writeJson(HAPPY_HOURS_PATH, venues);

  const counts = results.reduce((map, row) => ({ ...map, [row.outcome]: (map[row.outcome] || 0) + 1 }), {});
  console.log(`\nResults: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'nothing to do'}`);
  console.log(`Attached: ${attached + manuallyAttached} (${manuallyAttached} manual). Catalog maintenance: ${catalogMaintenance}. Review manifest: ${path.relative(ROOT_DIR, RUN_PATH)}`);
  console.log(formatAiUsage({ venues: results.length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
