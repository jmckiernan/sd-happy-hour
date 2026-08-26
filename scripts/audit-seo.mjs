import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const blogDir = path.join(root, 'src/content/blog');
const venues = JSON.parse(fs.readFileSync(path.join(root, 'public/data/happy-hours.json'), 'utf8'));
const venueSlugs = new Set(venues.map((venue) => slugify(venue.name)));
const errors = [];
const warnings = [];
const descriptions = new Map();

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function decodeFrontmatterValue(block, key) {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return match[1].trim(); }
}

for (const filename of fs.readdirSync(blogDir).filter((file) => file.endsWith('.md')).sort()) {
  const raw = fs.readFileSync(path.join(blogDir, filename), 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    errors.push(`${filename}: missing valid frontmatter.`);
    continue;
  }

  const [, frontmatter, body] = match;
  const title = decodeFrontmatterValue(frontmatter, 'title');
  const description = decodeFrontmatterValue(frontmatter, 'description');
  const draft = decodeFrontmatterValue(frontmatter, 'draft');
  const linkedVenues = decodeFrontmatterValue(frontmatter, 'venues') || [];
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const h2Count = (body.match(/^##\s+/gm) || []).length;

  if (draft === true) continue;
  if (typeof title !== 'string' || !title.trim()) errors.push(`${filename}: missing title.`);
  else {
    if (title.length > 65) warnings.push(`${filename}: title is ${title.length} characters; aim for 45-60.`);
    if (title.length < 25) warnings.push(`${filename}: title is only ${title.length} characters; make the search intent explicit.`);
  }
  if (typeof description !== 'string' || !description.trim()) errors.push(`${filename}: missing description.`);
  else {
    if (description.length < 90 || description.length > 160) warnings.push(`${filename}: description is ${description.length} characters; aim for 120-155.`);
    const previous = descriptions.get(description);
    if (previous) errors.push(`${filename}: duplicates the description used by ${previous}.`);
    descriptions.set(description, filename);
  }
  if (filename !== 'welcome-to-sd-happy-hours.md' && words < 450) warnings.push(`${filename}: ${words} words; confirm the post fully satisfies its query.`);
  if (filename !== 'welcome-to-sd-happy-hours.md' && h2Count < 2) warnings.push(`${filename}: fewer than two descriptive H2 sections.`);
  if (!Array.isArray(linkedVenues)) errors.push(`${filename}: venues must be an array.`);
  else for (const slug of linkedVenues) {
    if (!venueSlugs.has(slug)) errors.push(`${filename}: linked venue slug does not exist: ${slug}.`);
  }
}

const astroConfig = fs.readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');
const robots = fs.readFileSync(path.join(root, 'public/robots.txt'), 'utf8');
if (!astroConfig.includes("site: 'https://happyhoursd.com'")) errors.push('astro.config.mjs: production site URL is missing.');
if (!astroConfig.includes('sitemap(')) errors.push('astro.config.mjs: sitemap integration is missing.');
if (!robots.includes('Sitemap: https://happyhoursd.com/sitemap-index.xml')) errors.push('robots.txt: sitemap declaration is missing.');
if (!fs.existsSync(path.join(root, 'public/logo.svg'))) errors.push('public/logo.svg: organization logo is missing.');

console.log(`SEO audit: ${fs.readdirSync(blogDir).filter((file) => file.endsWith('.md')).length} blog posts, ${venues.length} venue records.`);
for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);
console.log(`${errors.length} errors, ${warnings.length} warnings.`);
if (errors.length) process.exit(1);
