import type { APIRoute } from 'astro';
import { Octokit } from '@octokit/rest';
import happyHours from '../../../public/data/happy-hours.json';

export const prerender = false;

const CONTENT_BRIEF = `You write for the SD Happy Hours blog, a real-time San Diego happy hour discovery site.

Voice: friendly, knowledgeable local friend giving you the inside scoop — not a generic listicle, not overly salesy.
Format: Markdown. Use a short intro, then organized sections (headings, occasional lists), and a short closing line.
Length: roughly 400-700 words unless the angle calls for more.

Hard rules, never break these:
- Only state a venue's hours, days, or deals if they are given to you explicitly in the "VERIFIED VENUE DATA" block below. Quote them exactly.
- Never invent, estimate, or guess at a specific venue's hours, prices, or deals. If you don't have verified data for a venue mentioned in the source material, describe it in general terms only (vibe, neighborhood, food type) and do not state specific numbers.
- Do not fabricate quotes, reviews, or claims about a venue you have no data for.
- If the source material conflicts with the verified venue data, trust the verified venue data.

Output strict JSON only, no markdown fences, no commentary, matching this shape:
{"title": "...", "description": "...", "body": "... full markdown body ..."}`;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function findVenueData(venueSlugs: string[]) {
  return (happyHours as any[])
    .filter((v) => venueSlugs.includes(slugify(v.name)))
    .map((v) => ({
      name: v.name,
      neighborhood: v.neighborhood,
      days: v.days,
      startTime: v.startTime,
      endTime: v.endTime,
      deals: v.deals,
      vibe: v.vibe,
    }));
}

export const POST: APIRoute = async ({ request }) => {
  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.DRAFT_API_TOKEN || token !== process.env.DRAFT_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const { sourceMaterial, angle, venues = [] } = await request.json();

  if (!angle || typeof angle !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing "angle" (your idea/notes for the post).' }), { status: 400 });
  }

  const verifiedVenues = findVenueData(venues);

  const userPrompt = `ANGLE / IDEAS FROM THE EDITOR:
${angle}

SOURCE MATERIAL (from web research, a scraper, or a Google Alert — treat as inspiration and fact-check candidates, not verified fact):
${sourceMaterial || '(none provided)'}

VERIFIED VENUE DATA (the only source of truth for any specific venue facts):
${JSON.stringify(verifiedVenues, null, 2)}

Write the blog post now, following all rules in your instructions. Respond with the JSON object only.`;

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: 4000,
      system: CONTENT_BRIEF,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: 'Claude API error', detail: errText }), { status: 502 });
  }

  const anthropicData = await anthropicRes.json();
  const raw = anthropicData.content?.[0]?.text ?? '';

  let parsed: { title: string; description: string; body: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: 'Could not parse AI response as JSON', raw }), { status: 502 });
  }

  const slug = slugify(parsed.title) || `draft-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(parsed.title)}`,
    `description: ${JSON.stringify(parsed.description)}`,
    `pubDate: ${today}`,
    `author: "SD Happy Hours"`,
    `draft: true`,
    `aiGenerated: true`,
    `venues: [${venues.map((v: string) => JSON.stringify(v)).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const fileContent = frontmatter + parsed.body + '\n';
  const filePath = `src/content/blog/${slug}.md`;

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    return new Response(
      JSON.stringify({ error: 'Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN env vars.' }),
      { status: 500 }
    );
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  let sha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch });
    if (!Array.isArray(existing.data)) sha = existing.data.sha;
  } catch {
    // file doesn't exist yet - that's fine, we're creating it
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    branch,
    message: `AI draft: ${parsed.title}`,
    content: Buffer.from(fileContent, 'utf-8').toString('base64'),
    sha,
  });

  return new Response(
    JSON.stringify({
      success: true,
      slug,
      path: filePath,
      editUrl: `/admin/#/collections/blog/entries/${slug}`,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};
