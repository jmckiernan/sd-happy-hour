/**
 * EXPLORATORY — not part of the import pipeline. See docs/proprietary-venue-attributes.md §5.
 *
 * Grounding check for character labels. Every non-none vibe must carry a quote
 * that appears in the frozen evidence packet (pages, social, catalog deals/menu/gallery).
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.data', 'experiments', 'venue-character');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function overlap(quote, haystack) {
  const words = normalize(quote).split(' ').filter(Boolean);
  if (!words.length) return 0;
  if (words.length < 3) return haystack.includes(words.join(' ')) ? 1 : 0;
  for (let size = words.length; size >= 3; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      if (haystack.includes(words.slice(start, start + size).join(' '))) return size / words.length;
    }
  }
  return 0;
}

function packetHaystacks(record, evidence) {
  const byId = new Map();
  const chunks = [];

  const deals = evidence.deals || record.venue?.deals || [];
  if (deals.length) {
    const text = normalize(deals.join(' '));
    byId.set('catalog:deals', text);
    chunks.push(text);
  }

  if (evidence.hhMenu) {
    const lines = [evidence.hhMenu.note || ''];
    for (const section of evidence.hhMenu.sections || []) {
      lines.push(section.title || '');
      for (const item of section.items || []) lines.push(`${item.name || ''} ${item.price || ''}`);
    }
    const text = normalize(lines.join(' '));
    byId.set('catalog:hhMenu', text);
    chunks.push(text);
  }

  if (evidence.weeklySpecials) {
    const text = normalize(JSON.stringify(evidence.weeklySpecials));
    byId.set('catalog:weeklySpecials', text);
    chunks.push(text);
  }

  const gallery = evidence.galleryImages || [];
  if (gallery.length) {
    const text = normalize(gallery.map((g) => `${g.caption || ''} ${g.filename || ''}`).join(' '));
    byId.set('catalog:gallery', text);
    chunks.push(text);
  }

  for (const page of record.pages || []) {
    const text = normalize(page.text);
    byId.set(page.url, text);
    chunks.push(text);
  }
  for (const account of record.social || []) {
    const text = normalize(account.text);
    byId.set(account.url, text);
    chunks.push(text);
  }

  return { byId, everything: chunks.join('\n') };
}

function main() {
  const sample = JSON.parse(fs.readFileSync(path.join(DIR, 'sample.json'), 'utf8'));
  const evidenceById = sample.evidence || {};
  const payload = JSON.parse(fs.readFileSync(path.join(DIR, 'closed-vocabulary.json'), 'utf8'));
  const rows = payload.venues || payload;
  const audited = [];

  for (const row of rows) {
    if (!row.vibe) {
      audited.push({
        id: row.id,
        name: row.name,
        vibe: null,
        grounding: 'absent',
        sourceOk: true,
      });
      continue;
    }

    const record = JSON.parse(fs.readFileSync(path.join(DIR, 'pages', `${row.id}.json`), 'utf8'));
    const evidence = evidenceById[row.id] || {};
    const { byId, everything } = packetHaystacks(record, evidence);

    const claimed =
      byId.get(row.sourceId)
      ?? [...byId.entries()].find(([id]) => id.replace(/\/$/, '') === String(row.sourceId || '').replace(/\/$/, ''))?.[1];

    const onClaimed = claimed ? overlap(row.quote, claimed) : 0;
    const anywhere = overlap(row.quote, everything);
    audited.push({
      id: row.id,
      name: row.name,
      vibe: row.vibe,
      quote: row.quote,
      sourceId: row.sourceId,
      confidence: row.confidence,
      grounding: anywhere >= 0.8 ? 'verbatim' : anywhere >= 0.5 ? 'partial' : 'not found',
      sourceOk: onClaimed >= 0.5 || (!row.sourceId && anywhere >= 0.8),
    });
  }

  fs.writeFileSync(path.join(DIR, 'quote-audit.json'), `${JSON.stringify(audited, null, 2)}\n`);

  const labelled = audited.filter((row) => row.vibe);
  const tally = {};
  for (const row of labelled) tally[row.grounding] = (tally[row.grounding] || 0) + 1;
  console.log(`${labelled.length} labelled vibes; ${audited.length - labelled.length} absent`);
  console.log('grounding:', tally);
  console.log(`source id matches quote page: ${labelled.filter((r) => r.sourceOk).length}/${labelled.length}`);
  console.log('\nUngrounded or mis-sourced:');
  for (const row of labelled.filter((r) => r.grounding !== 'verbatim' || !r.sourceOk)) {
    console.log(`  ${row.name} — ${row.vibe} [${row.grounding}${row.sourceOk ? '' : ', bad source'}]\n      "${row.quote}"\n      ${row.sourceId}`);
  }
}

main();
