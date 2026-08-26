# SD Happy Hours SEO audit

Audit date: August 24, 2026  
Primary market: San Diego, California  
Production domain: `https://happyhoursd.com`

## Executive finding

The most urgent issue is outside the Astro application: unauthenticated requests to the production domain currently receive a Netlify `401` Team Login page. That response also replaces `robots.txt`, the sitemap, venue pages, and blog posts. Search engines and third-party audit tools cannot crawl or index the site until production visibility is public.

In Netlify, open **Project configuration → General → Visitor access → Project visibility**, make production public, and leave preview/branch deploys private if desired. Afterward, verify all four of these return `200` without a Netlify session:

- `https://happyhoursd.com/`
- `https://happyhoursd.com/robots.txt`
- `https://happyhoursd.com/sitemap-index.xml`
- One venue and one blog URL

Do this before any sitemap submission, rich-results test, PageSpeed test, or external crawler run.

## Implemented in this audit

### Crawlability and indexation

- Kept canonical URLs query-free and self-referencing.
- Added explicit `index,follow` directives with large-image previews to public pages.
- Added `noindex,follow` to admin, account, shared-list, alert, restaurant-management, and submission utilities.
- Filtered non-public utilities out of the generated XML sitemap.
- Disallowed API endpoints in `robots.txt` without blocking pages that need their `noindex` directive crawled.
- Preserved the existing synthetic QA listing for tests, but marked it `noindex` and removed it from the sitemap and neighborhood discovery.
- Added an RSS feed for published blog posts at `/rss.xml`.

### Metadata and entity understanding

- Added complete Open Graph and Twitter card metadata, image alt text, article publication/update timestamps, locale, and site name.
- Replaced the missing default social image reference with an existing crawlable image.
- Added a crawlable site logo and favicon.
- Added JSON-LD for `Organization`, `WebSite`, `BlogPosting`, `Restaurant`, `BreadcrumbList`, `ItemList`, and `AboutPage` where each type matches visible page content.
- Added venue address, coordinates, telephone, official-site reference, and happy-hour offers without inventing ratings, prices, opening hours, or reviews.

### Local landing pages and internal links

- Added an indexable San Diego neighborhood hub.
- Added unique landing pages for Little Italy, North Park, South Park, Pacific Beach, Gaslamp, UTC, Harbor Island, and Middletown.
- Each neighborhood page includes local planning context, a complete list of matching venues, schedules, deals, useful anchor text, nearby-area links, breadcrumbs, and collection schema.
- Linked neighborhood discovery from global navigation and the footer.
- Linked venue pages back to their neighborhood hubs.

### Blog SEO and editorial trust

- Added article schema, publication/update dates, word counts, authorship, breadcrumbs, and venue/neighborhood keywords.
- Added visible authorship links and an explicit disclosure on AI-assisted articles.
- Added an About and editorial-policy page explaining sourcing, review, verification, corrections, authorship, and AI use.
- Rewrote the four thin local roundups into structured, answer-first guides with descriptive headings, comparisons, planning details, and relevant internal links.
- Fixed a title/content mismatch where a page promised five view-oriented venues but contained three.
- Clarified an ambiguous “apps” article title so it targets appetizers rather than mobile applications.
- Connected the remaining topical articles to relevant venue pages through their content metadata.
- Strengthened the AI draft prompt: clear search intent, title/description targets, descriptive headings, useful comparisons, no keyword stuffing, no invented firsthand experience, and no unsupported venue facts.
- Automatically writes `updatedDate` when an editor changes a draft or published post.
- Added `npm run audit:seo`, which checks published blog metadata, structure, duplicate descriptions, linked venue slugs, sitemap configuration, and core SEO assets.

## Verification completed

- `npm run validate:data`: passes for all venue records.
- `npm run audit:seo`: zero errors and zero warnings.
- `npm run build`: succeeds.
- Parsed every JSON-LD block on representative home, venue, blog, and neighborhood output as valid JSON.
- Confirmed public pages render `index,follow`; private utilities and the synthetic QA listing render `noindex,follow`.
- Confirmed the generated sitemap contains public content and excludes private utilities and the QA listing.

External validation is blocked until Netlify production access is public.

## Account-level actions after launch

1. In Google Search Console, inspect the homepage, one neighborhood, one venue, and one blog post. Submit `https://happyhoursd.com/sitemap-index.xml` and request indexing for the main hub pages.
2. Run Google Rich Results Test on the same representative page set. Fix only issues that reflect visible content; do not add fabricated review or rating fields to silence optional warnings.
3. Run PageSpeed Insights on the homepage, a venue, a neighborhood page, and a long blog post. Prioritize field-data failures for LCP, INP, and CLS over a single lab score.
4. Import the verified Google property into Bing Webmaster Tools, submit the sitemap, and run Site Scan.
5. Verify the domain in Ahrefs Free and schedule a monthly crawl. The site is small enough to fit comfortably within its free crawl allowance.
6. Keep Search Console and PostHog as the source of truth for results. Review queries and landing pages monthly, not daily.

## Local authority work that code cannot manufacture

- Do **not** create a Google Business Profile for an online-only directory. Google requires in-person customer contact. Only create one if SD Happy Hours operates a genuine staffed location customers can visit or an eligible service-area business.
- Build legitimate local citations and links through San Diego neighborhood associations, chambers, tourism resources, event partners, restaurant partners, and local publications. Avoid bulk directory packages and paid-link schemes.
- Ask verified restaurant partners to link to their SD Happy Hours venue page from a press, specials, or local-partners page when it is genuinely useful.
- Publish original assets competitors cannot reproduce: dated menu photos with permission, venue-owner confirmations, neighborhood maps, interviews, and transparent “last checked” notes.
- Add real author biographies and profile links when John and Shane are ready to publish them. Do not invent credentials or first-person visits.

## Content operating plan

Every search-focused guide should have a distinct reader job, such as “find a Saturday deal,” “compare dog-friendly patios,” or “plan a walkable Little Italy crawl.” It should answer that job early and then support it with current first-party directory data.

Before publishing:

- Use one clear H1 and descriptive H2 sections.
- Keep the title accurate and generally within 45–60 characters; keep the description specific and generally within 120–155 characters.
- Select every venue discussed in the editor so the article links to the matching venue pages.
- Add only details supported by the selected venue record or a trustworthy source retained by the editor.
- Include a practical comparison, decision summary, or plan that adds value beyond restating deal data.
- Use original images where possible, descriptive alt text, and a materially accurate update date.
- Read the finished page as a person planning a real outing. If they still need another generic article to make a decision, the guide is not finished.

## Measurement framework

Track these monthly by landing-page group (home, neighborhood, venue, blog):

- Valid indexed pages and excluded-page reasons
- Non-brand impressions and clicks
- Click-through rate by query and page
- Queries in positions 4–15, which are the best candidates for content improvements
- Organic visits that continue to a venue, directions, official website, save, or alert action
- Referring domains and new partner links
- Core Web Vitals pass rate
- Stale listings and the percentage of public venues with a meaningful `lastVerifiedAt` value

The strongest local-search moat will be accuracy and original San Diego evidence, not publishing volume.
