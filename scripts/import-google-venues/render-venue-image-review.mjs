#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './lib/constants.mjs';
import { readJson } from './lib/io.mjs';

const manifestPath = path.join(ROOT_DIR, '.data', 'import', 'venue-images.json');
const outputPath = path.join(ROOT_DIR, '.data', 'import', 'venue-image-review.html');
const manifest = readJson(manifestPath, { venues: {} });
const reviewable = Object.values(manifest.venues || {}).filter((row) =>
  ['review_needed', 'review_needed_duplicate', 'review_error', 'website_unreadable', 'no_usable_website_candidate'].includes(row.outcome)
);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const cards = reviewable.map((row) => `
  <article>
    <header><strong>${esc(row.venueId)} · ${esc(row.name)}</strong><span>${esc(row.outcome)}</span></header>
    <p>${esc(row.review?.reason || row.reason || '')}</p>
    <nav><a href="${esc(row.website)}">website</a>${row.instagram ? ` · <a href="${esc(row.instagram)}">Instagram</a>` : ''}</nav>
    <div class="candidates">${(row.candidates || []).map((candidate, index) => `
      <figure>
        <a href="${esc(candidate.assetUrl)}"><img loading="lazy" src="${esc(candidate.assetUrl)}" alt="Candidate ${index} for ${esc(row.name)}"></a>
        <figcaption>#${index} · ${esc(candidate.width)}×${esc(candidate.height)} · score ${esc(candidate.score)}<br><a href="${esc(candidate.pageUrl)}">source page</a></figcaption>
      </figure>`).join('') || '<em>No usable website candidate.</em>'}</div>
  </article>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Venue image review</title>
<style>body{font:15px system-ui;margin:0;background:#f4f0e8;color:#201b16}main{max-width:1500px;margin:auto;padding:24px}h1{margin:0 0 8px}article{background:white;border:1px solid #d8d0c5;border-radius:12px;padding:16px;margin:18px 0}header{display:flex;justify-content:space-between;gap:16px;font-size:18px}header span{font-size:13px;background:#eee7dc;padding:5px 9px;border-radius:99px}.candidates{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:14px}figure{margin:0}img{width:100%;aspect-ratio:5/3;object-fit:cover;background:#ddd;border-radius:8px}figcaption{font-size:13px;margin-top:5px}a{color:#8f3b19}</style></head><body><main><h1>Venue image review</h1><p>${reviewable.length} unresolved venues · generated ${esc(new Date().toISOString())}</p>${cards}</main></body></html>`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html);
console.log(path.relative(ROOT_DIR, outputPath));

