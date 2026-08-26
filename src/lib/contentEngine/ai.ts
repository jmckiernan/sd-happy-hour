import happyHours from '../../../public/data/happy-hours.json';
import { getEnv } from '../env';
import { collectDateTags, linkAndEmphasizeDates } from './dateLinks';
import { evaluateDraftQuality } from './quality';
import { normalizeText, slugifyContent } from './normalize';
import type { EditorialCluster, GeneratedDraft, NormalizedContentItem } from './types';

export interface TextModel {
  complete(input: { system: string; user: string; maxTokens: number }): Promise<string>;
}

export class AnthropicTextModel implements TextModel {
  async complete(input: { system: string; user: string; maxTokens: number }): Promise<string> {
    const apiKey = getEnv('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY env var.');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: getEnv('ANTHROPIC_MODEL') || 'claude-sonnet-5',
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: 'user', content: input.user }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API error (${response.status}): ${(await response.text()).slice(0, 800)}`);
    const data = await response.json();
    const block = Array.isArray(data.content) ? data.content.find((item: any) => item?.type === 'text') : null;
    if (!block?.text) throw new Error('Anthropic returned no text content.');
    return block.text;
  }
}

const BLOG_SYSTEM = `You are the senior local editor for SD Happy Hours, an independent San Diego County going-out guide.

Write a complete, genuinely useful local article—not an outline and not generic AI copy. The voice is specific, observant, concise, lightly playful when it fits, and never pretends the writer attended an event. Put the practical answer early. Help readers choose and plan.

FACT SAFETY:
- The supplied source bundle is the complete factual universe. Never invent a venue, date, time, price, offer, address, quote, review, parking fact, or ticket detail.
- Attribute uncertain or user-generated claims. If sources conflict, explain the conflict briefly or omit the disputed detail.
- Every event/deal section must contain a Markdown link to its supporting source.
- Venues need not be in the SD Happy Hours directory. Use an internal venue link only when INTERNAL VENUE URL is supplied.
- Preserve exact dates/times from the bundle. Offers can change, so include a concise verification reminder.
- Keep everything within San Diego County.

EDITORIAL/SEO:
- Aim for 650–1,050 words, but usefulness beats length.
- Title: accurate, local, approximately 45–65 characters.
- Description/meta description: approximately 120–155 characters.
- Use descriptive H2s, short paragraphs, and a compact planning summary.
- Link readers naturally to /live-deals/ or / as the final CTA.
- Avoid keyword stuffing, throat-clearing, fake enthusiasm, and repeated conclusions.

Return exactly:
TITLE: one line
DESCRIPTION: one line
META_DESCRIPTION: one line
OG_TITLE: one line
OG_DESCRIPTION: one line
TAGS: a JSON array of lowercase reusable tags
HASHTAGS: a JSON array of social hashtags beginning with #
---BODY---
Markdown article body`;

const NEWSLETTER_SYSTEM = `You write the SD Happy Hours newsletter from a verified source bundle.

Create a newsletter edition that is editorialized separately from the blog. It should feel like a smart local note: quick opener, scannable picks, why each is worth considering, exact supported logistics, source links, and a short CTA. Do not copy the blog wording. Do not invent details. Attribute weak or user-generated sources and tell readers to verify changing offers.

Return exactly:
SUBJECT: one line
PREHEADER: one line
---BODY---
Markdown newsletter body, roughly 250–500 words`;

function directoryVenueUrl(name?: string | null): string | null {
  if (!name) return null;
  const target = slugifyContent(name);
  const match = (happyHours as any[]).find((venue) => slugifyContent(venue.name) === target);
  return match ? `/venues/${target}/` : null;
}

function itemForPrompt(item: NormalizedContentItem, index: number) {
  return {
    item: index + 1,
    title: item.title,
    venue: item.venueName || null,
    internalVenueUrl: directoryVenueUrl(item.venueName),
    description: item.description,
    eventStart: item.eventStartAt || null,
    eventEnd: item.eventEndAt || null,
    neighborhood: item.neighborhood || null,
    area: item.area || null,
    address: item.address || null,
    confidence: item.confidenceScore,
    qualityFlags: item.qualityFlags,
    eventTypes: item.eventTypes,
    sources: item.provenance.map((source) => ({
      publisher: source.sourceName,
      url: source.sourceUrl,
      title: source.sourceTitle,
      publishedAt: source.sourcePublishedAt || null,
      trust: source.trustScore,
      userGenerated: source.sourceKind === 'reddit_rss',
    })),
  };
}

function promptBundle(cluster: EditorialCluster): string {
  return JSON.stringify({
    editorialAngle: cluster.angle,
    workingTitle: cluster.workingTitle,
    clusterType: cluster.clusterType,
    clusterConfidence: cluster.confidenceScore,
    items: cluster.items.map(itemForPrompt),
  }, null, 2);
}

function header(raw: string, key: string): string {
  return normalizeText(raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'))?.[1] || '');
}

function jsonArrayHeader(raw: string, key: string): string[] {
  const value = raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'))?.[1] || '[]';
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => normalizeText(item)).filter(Boolean) : [];
  } catch {
    return value.split(',').map((item) => normalizeText(item.replace(/^\[|\]$/g, ''))).filter(Boolean);
  }
}

function bodyAfter(raw: string, marker: string): string {
  const index = raw.indexOf(marker);
  if (index < 0) throw new Error(`AI response was missing ${marker}.`);
  const body = raw.slice(index + marker.length).replace(/^\s*\r?\n/, '').trim();
  if (!body) throw new Error('AI response contained an empty body.');
  return body;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function sourceAppendix(cluster: EditorialCluster): string {
  const sources = new Map<string, { name: string; title: string }>();
  for (const item of cluster.items) {
    for (const source of item.provenance) {
      sources.set(source.sourceUrl, { name: source.sourceName, title: source.sourceTitle || item.title });
    }
  }
  if (!sources.size) return '';
  return [
    '## Sources and verification',
    '',
    ...[...sources.entries()].map(([url, source]) => `- [${source.name}: ${source.title}](${url})`),
    '',
    'Dates, lineups, prices, and promotions can change. Confirm the current details with the organizer or venue before heading out.',
  ].join('\n');
}

function newsletterBlocks(markdown: string): Array<Record<string, unknown>> {
  const sections = markdown.split(/^##\s+/m);
  const blocks: Array<Record<string, unknown>> = [];
  if (sections[0].trim()) blocks.push({ type: 'intro', markdown: sections[0].trim() });
  for (const section of sections.slice(1)) {
    const [heading, ...lines] = section.split('\n');
    blocks.push({ type: 'section', heading: heading.trim(), markdown: lines.join('\n').trim() });
  }
  return blocks;
}

export async function generateDraftBundle(
  cluster: EditorialCluster,
  model: TextModel = new AnthropicTextModel()
): Promise<{ blog: GeneratedDraft; newsletter: GeneratedDraft }> {
  const sourceBundle = promptBundle(cluster);
  const blogRaw = await model.complete({
    system: BLOG_SYSTEM,
    user: `Write the article from this source bundle.\n\n${sourceBundle}`,
    maxTokens: 5000,
  });
  const dates = collectDateTags(cluster.items.flatMap((item) => [item.eventStartAt, item.eventEndAt]));
  let blogBody = bodyAfter(blogRaw, '---BODY---');
  blogBody = linkAndEmphasizeDates(blogBody, dates);
  if (!/^## Sources and verification$/m.test(blogBody)) blogBody = `${blogBody}\n\n${sourceAppendix(cluster)}`.trim();

  const title = header(blogRaw, 'TITLE') || cluster.workingTitle;
  const description = header(blogRaw, 'DESCRIPTION') || cluster.summary.slice(0, 155);
  const tags = unique([
    ...jsonArrayHeader(blogRaw, 'TAGS').map(slugifyContent), ...cluster.tags,
    ...cluster.items.flatMap((item) => item.tags),
  ]).map(slugifyContent);
  const blog: GeneratedDraft = {
    contentType: 'blog',
    status: 'review',
    title,
    slug: slugifyContent(title),
    description,
    bodyMarkdown: blogBody,
    seoMetadata: {
      metaDescription: header(blogRaw, 'META_DESCRIPTION') || description,
      ogTitle: header(blogRaw, 'OG_TITLE') || title,
      ogDescription: header(blogRaw, 'OG_DESCRIPTION') || description,
      hashtags: jsonArrayHeader(blogRaw, 'HASHTAGS')
        .map((tag) => tag.startsWith('#') ? tag : `#${slugifyContent(tag).replace(/-/g, '')}`),
    },
    tags,
    dates,
    locations: unique(cluster.items.flatMap((item) => [item.neighborhood, item.area])).filter(Boolean),
    brands: unique(cluster.items.map((item) => item.venueName)).filter(Boolean),
    eventTypes: unique(cluster.items.flatMap((item) => item.eventTypes)),
    qualityScore: 0,
    qualityFlags: [],
  };
  const blogQuality = evaluateDraftQuality(blog, cluster);
  blog.qualityScore = blogQuality.score;
  blog.qualityFlags = blogQuality.flags;

  const newsletterRaw = await model.complete({
    system: NEWSLETTER_SYSTEM,
    user: `Create a newsletter from this source bundle. Do not reuse wording from the blog excerpt that follows.\n\nSOURCE BUNDLE:\n${sourceBundle}\n\nBLOG EXCERPT FOR DIFFERENTIATION ONLY:\n${blogBody.slice(0, 1800)}`,
    maxTokens: 2600,
  });
  let newsletterBody = bodyAfter(newsletterRaw, '---BODY---');
  newsletterBody = linkAndEmphasizeDates(newsletterBody, dates);
  if (!/^## Sources and verification$/m.test(newsletterBody)) newsletterBody = `${newsletterBody}\n\n${sourceAppendix(cluster)}`.trim();
  const subject = header(newsletterRaw, 'SUBJECT') || title;
  const preheader = header(newsletterRaw, 'PREHEADER') || description;
  const newsletter: GeneratedDraft = {
    contentType: 'newsletter',
    status: 'review',
    title: subject,
    description: preheader,
    bodyMarkdown: newsletterBody,
    seoMetadata: {
      metaDescription: preheader,
      ogTitle: subject,
      ogDescription: preheader,
      hashtags: blog.seoMetadata.hashtags,
    },
    structuredBlocks: newsletterBlocks(newsletterBody),
    tags: blog.tags,
    dates,
    locations: blog.locations,
    brands: blog.brands,
    eventTypes: blog.eventTypes,
    qualityScore: 0,
    qualityFlags: [],
  };
  const newsletterQuality = evaluateDraftQuality(newsletter, cluster);
  newsletter.qualityScore = newsletterQuality.score;
  newsletter.qualityFlags = newsletterQuality.flags;
  return { blog, newsletter };
}

/** AI-assisted ranking/editing is deliberately bounded to existing clusters:
 * the model can improve the angle and ordering, but cannot add an item or fact. */
export async function refineClusterEditorialJudgment(
  clusters: EditorialCluster[],
  model: TextModel = new AnthropicTextModel()
): Promise<EditorialCluster[]> {
  if (clusters.length < 2 || !getEnv('ANTHROPIC_API_KEY')) return clusters;
  const raw = await model.complete({
    system: 'You are a San Diego local editor. Rank proposed source-grounded story bundles for usefulness, timeliness, specificity, and non-duplication. You may rewrite only the working title and angle. Return JSON only.',
    user: JSON.stringify(clusters.map((cluster) => ({
      signature: cluster.signature,
      workingTitle: cluster.workingTitle,
      angle: cluster.angle,
      score: cluster.editorialScore,
      itemTitles: cluster.items.map((item) => item.title),
    }))),
    maxTokens: 1600,
  });
  let parsed: any[];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(match?.[0] || '[]');
  } catch {
    return clusters;
  }
  const bySignature = new Map(clusters.map((cluster) => [cluster.signature, cluster]));
  const refined: EditorialCluster[] = [];
  for (const suggestion of parsed) {
    const cluster = bySignature.get(String(suggestion.signature));
    if (!cluster) continue;
    refined.push({
      ...cluster,
      workingTitle: normalizeText(suggestion.workingTitle).slice(0, 140) || cluster.workingTitle,
      angle: normalizeText(suggestion.angle).slice(0, 500) || cluster.angle,
    });
    bySignature.delete(cluster.signature);
  }
  return [...refined, ...bySignature.values()];
}
