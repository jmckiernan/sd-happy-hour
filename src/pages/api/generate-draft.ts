import type { APIRoute } from 'astro';
import { describeGitHubError, getGitHubTarget, getOctokit } from '../../lib/github';
import happyHours from '../../../public/data/happy-hours.json';
import { getAdminUser } from '../../lib/admins';
import { venueSlug } from '../../lib/venues';

export const prerender = false;

const CONTENT_BRIEF = `You write for the Happy Hour SD blog, a real-time San Diego happy hour discovery site.

Voice: clear, useful San Diego editor — specific and conversational, never a generic listicle, never overly salesy, and never pretending to have visited a place unless the editor's source material says so.
Search intent: answer the exact question implied by the angle. Put the useful answer early, use natural San Diego and neighborhood language, and never repeat a phrase just to target a keyword.
Format: Markdown. Use a short answer-first intro, descriptive H2 sections, H3s only when needed, short paragraphs, and lists or comparison criteria when they make scanning easier.
Length: roughly 650-1,000 words for a search-focused guide. Every paragraph must add a fact, comparison, decision aid, or practical local tip.

SEO and editorial requirements:
- Keep the title clear, accurate, and ideally 45-60 characters. Put the core topic before clever wording.
- Write a unique description of roughly 120-155 characters that explains what the reader will be able to compare, find, or decide.
- Mention San Diego naturally in the introduction and use specific neighborhood names only where relevant.
- When verified venues are supplied, give each important venue a descriptive section and include its exact name. The site automatically adds links from the post to selected venue pages.
- Include practical planning context when supported: which option suits a date, group, view, food-first visit, early start, or later window; transit/parking guidance may be general but must not be invented as a venue fact.
- End with a concise decision summary or before-you-go checklist, not filler.
- Do not write vague padding about the site's database, SEO, keywords, or the fact that you are an AI.

Hard rules, never break these:
- Only state a venue's hours, days, or deals if they are given to you explicitly in the "VERIFIED VENUE DATA" block below. Quote them exactly.
- Never invent, estimate, or guess at a specific venue's hours, prices, or deals. If you don't have verified data for a venue mentioned in the source material, describe it in general terms only (vibe, neighborhood, food type) and do not state specific numbers.
- Do not fabricate quotes, reviews, or claims about a venue you have no data for.
- If the source material conflicts with the verified venue data, trust the verified venue data.
- Do not call unverified directory data "verified" in the article. Use phrases like "our current listing" and remind readers that offers can change.

Output in exactly this format, with nothing before or after it — no JSON, no markdown fences, no commentary:

TITLE: <the post title, one line, no quotes>
DESCRIPTION: <a one-sentence summary for the post preview/SEO description, one line>
---BODY---
<the full markdown body of the post, starting on the next line>`;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function findVenueData(venueSlugs: string[]) {
  return (happyHours as any[])
    .filter((v) => venueSlugs.includes(slugify(v.name)) || venueSlugs.includes(venueSlug(v)))
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

export const POST: APIRoute = async ({ request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) {
    return new Response(JSON.stringify({ error: 'Sign in at /account/ with an authorized admin email first.' }), { status: 401 });
  }

  const { sourceMaterial, angle, venues = [], heroImage } = await request.json();

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

Write the blog post now, following all rules in your instructions. Respond in the exact TITLE/DESCRIPTION/---BODY--- format only.`;

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': import.meta.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: import.meta.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
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

  // Don't assume the text is at content[0] — if the model emits any other
  // block first (e.g. a "thinking" block), content[0] has no .text field
  // and this would silently end up as an empty string. Find the first
  // actual text block instead.
  const textBlock = Array.isArray(anthropicData.content)
    ? anthropicData.content.find((block: any) => block?.type === 'text')
    : null;
  const raw = textBlock?.text ?? '';

  if (!raw) {
    return new Response(
      JSON.stringify({
        error: 'Claude returned no text content',
        detail: JSON.stringify(anthropicData, null, 2),
      }),
      { status: 502 }
    );
  }

  // Deliberately NOT asking the model for JSON here. A long markdown body
  // embedded as a JSON string value means the model has to correctly
  // escape every quote and newline in hundreds of words of prose — and in
  // practice it drifts partway through (falls back to real line breaks
  // instead of \n), which produces invalid JSON that no amount of
  // fence-stripping/substring-extraction can recover, since the string
  // itself is broken, not just wrapped in extra text. A plain delimiter
  // the model never has to escape avoids the whole failure mode.
  function extractDraft(text: string): { title: string; description: string; body: string } {
    let cleaned = text.trim();
    const fenced = cleaned.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
    if (fenced) cleaned = fenced[1].trim();

    const marker = '---BODY---';
    const markerIdx = cleaned.indexOf(marker);
    if (markerIdx === -1) throw new Error('missing ---BODY--- marker');

    const header = cleaned.slice(0, markerIdx);
    const body = cleaned.slice(markerIdx + marker.length).replace(/^\r?\n/, '').trimEnd();

    const titleMatch = header.match(/^\s*TITLE:\s*(.+)$/m);
    const descMatch = header.match(/^\s*DESCRIPTION:\s*(.+)$/m);
    if (!titleMatch || !descMatch || !body) throw new Error('missing TITLE/DESCRIPTION/body');

    return { title: titleMatch[1].trim(), description: descMatch[1].trim(), body };
  }

  let parsed: { title: string; description: string; body: string };
  try {
    parsed = extractDraft(raw);
  } catch {
    return new Response(JSON.stringify({ error: 'Could not parse AI response', raw }), { status: 502 });
  }

  const slug = slugify(parsed.title) || `draft-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(parsed.title)}`,
    `description: ${JSON.stringify(parsed.description)}`,
    `pubDate: ${today}`,
    `author: "Happy Hour SD"`,
    `draft: true`,
    `aiGenerated: true`,
    `venues: [${venues.map((v: string) => JSON.stringify(v)).join(', ')}]`,
    // Optional — set when the admin generated/uploaded/edited a hero image
    // on the "Add Blog Post" page before submitting. Omitted entirely (not
    // written as an empty string) when there isn't one, so getPostImage()
    // falls back to auto-picking one based on the linked venue's vibe, same
    // as a draft that's never had heroImage touched via the editor.
    ...(typeof heroImage === 'string' && heroImage.trim() ? [`heroImage: ${JSON.stringify(heroImage.trim())}`] : []),
    '---',
    '',
  ].join('\n');

  const fileContent = frontmatter + parsed.body + '\n';
  const filePath = `src/content/blog/${slug}.md`;

  let owner: string;
  let repo: string;
  let branch: string;
  let octokit: ReturnType<typeof getOctokit>;
  try {
    const target = getGitHubTarget();
    ({ owner, repo, branch } = target);
    octokit = getOctokit(target);
  } catch (err: any) {
    // Only ever a GitHubConfigError: this deployment has no credentials set,
    // which is ours to fix, not the caller's.
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  // Everything from here on talks to the GitHub API and can fail for
  // reasons worth actually seeing (bad/expired token, wrong owner/repo,
  // no write access, wrong branch name, etc). Wrapped in one try/catch so
  // that real reason reaches the browser as `detail` instead of being
  // swallowed into a generic "Something went wrong" by the app-wide
  // error-handling middleware (src/middleware.ts), which only sees that
  // an error was thrown, not what it actually said.
  try {
    let sha: string | undefined;
    try {
      const existing = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch });
      if (!Array.isArray(existing.data)) sha = existing.data.sha;
    } catch (err: any) {
      // A real 404 (file doesn't exist yet) is expected and fine. Anything
      // else (403 no access, 401 bad token, etc.) should stop here and be
      // reported, not silently treated as "the file doesn't exist yet."
      if (err.status && err.status !== 404) throw err;
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
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: `Could not commit to ${owner}/${repo} (branch: ${branch})`,
        detail: describeGitHubError(err, 'commit the draft'),
      }),
      { status: 502 }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      slug,
      path: filePath,
      // No visual CMS — review/tweak the draft directly in GitHub's own
      // web editor, then flip `draft: true` to `false` and commit to
      // publish (same "git is the database" pattern as everything else
      // that writes content in this app).
      editUrl: `https://github.com/${owner}/${repo}/edit/${branch}/${filePath}`,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};
