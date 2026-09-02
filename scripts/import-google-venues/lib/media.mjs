const MEDIA_EXT_RE = /\.(?:pdf|jpe?g|png|webp|gif)(?:\?|$)/i;
const PDF_RE = /\.pdf(?:\?|$)/i;
const IMAGE_RE = /\.(?:jpe?g|png|webp|gif)(?:\?|$)/i;
const SOCIAL_HOSTS = {
  instagram: /(?:^|\.)instagram\.com$/i,
  facebook: /(?:^|\.)(?:facebook\.com|fb\.com)$/i,
  twitter: /(?:^|\.)(?:twitter\.com|x\.com)$/i,
};

export function classifyUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (PDF_RE.test(path)) return 'pdf';
    if (IMAGE_RE.test(path)) return 'image';
    return 'html';
  } catch {
    return 'html';
  }
}

export function isMediaUrl(url) {
  const kind = classifyUrl(url);
  return kind === 'pdf' || kind === 'image';
}

export function mediaKindFromContentType(contentType = '', url = '') {
  if (/pdf/i.test(contentType) || classifyUrl(url) === 'pdf') return 'pdf';
  if (/image\/(jpeg|jpg|png|webp|gif)/i.test(contentType) || classifyUrl(url) === 'image') {
    return 'image';
  }
  return null;
}

export function looksLikeBinaryResponse(url, contentType) {
  return Boolean(mediaKindFromContentType(contentType, url) || MEDIA_EXT_RE.test(String(url || '')));
}

/**
 * Anthropic checks magic bytes against the declared media_type. Popmenu/Jetpack
 * often serve JPEG (or PDF) behind a .png / .webp URL, so sniff the payload.
 */
export function sniffMediaFromBytes(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { kind: 'pdf', mediaType: 'application/pdf' };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { kind: 'image', mediaType: 'image/jpeg' };
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { kind: 'image', mediaType: 'image/png' };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { kind: 'image', mediaType: 'image/gif' };
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return { kind: 'image', mediaType: 'image/webp' };
  }
  return null;
}

export function applySniffedMedia(entry) {
  const sniffed = sniffMediaFromBytes(entry?.bytes);
  if (!sniffed) return entry;
  return {
    ...entry,
    kind: sniffed.kind,
    contentType: sniffed.mediaType,
  };
}

export function anthropicMediaType(kind, contentType = '', url = '', bytes = null) {
  const sniffed = sniffMediaFromBytes(bytes);
  if (sniffed) return sniffed.mediaType;
  if (kind === 'pdf') return 'application/pdf';
  const haystack = `${contentType} ${url}`;
  if (/image\/webp|\.webp(?:\?|$)/i.test(haystack)) return 'image/webp';
  if (/image\/png|\.png(?:\?|$)/i.test(haystack)) return 'image/png';
  if (/image\/gif|\.gif(?:\?|$)/i.test(haystack)) return 'image/gif';
  return 'image/jpeg';
}

const FLYER_NAME_RE = /mule|taco|whiskey|exch|specials?|happy[-_ ]?hour|happyhour|padres|tequila|beer|vodka|levels-|menu|\bhh\b/i;
const DECORATIVE_MEDIA_RE = /(?:footer|banner|hero|background|og-image|social[-_]?share|location-address|[-_/]bg[-_.]|[-_]bg(?:-|\.|$))/i;

export function isDecorativeMediaUrl(url) {
  return DECORATIVE_MEDIA_RE.test(String(url || ''));
}

/** Score a PDF/image URL the same way we score HTML specials pages. */
export function scoreMediaUrl(url) {
  const lower = String(url || '').toLowerCase();
  if (/privacy|terms|career|gift|logo|icon|sprite|placeholder|featured[-_]?image/i.test(lower)) return 0;
  if (/-\d{2,4}x\d{2,4}\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(lower)) return 0;
  if (isDecorativeMediaUrl(lower)) return 0;
  let score = 0;
  if (/happy[-_ ]?hour|happyhour/i.test(lower)) score += 45;
  // Brand flyers often name the file WebMenuHH… / MenuHH… without separators.
  if (/(?:^|[/_-])hh(?:[._-]|\.pdf)/i.test(lower) || /(?:^|[/_-]|menu)hh[a-z0-9_-]*\.pdf/i.test(lower)) {
    score += 40;
  }
  if (/specials?/i.test(lower)) score += 30;
  if (/menu/i.test(lower)) score += 18;
  if (PDF_RE.test(lower) && score > 0) score += 8;
  return score;
}

function pageLooksLikeSpecials(pageUrl) {
  return /happy[-_/ ]?hour|happyhour|specials|(?:\/)menus?(?:\/|$)/i.test(String(pageUrl || ''));
}

export function discoverSpecialsImages(html, pageUrl, max = 8) {
  if (!html) return [];
  let origin = 'https://example.com';
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    // relative URLs still parse against a dummy origin
  }

  const onSpecialsPage = pageLooksLikeSpecials(pageUrl);
  const ranked = [];
  const seen = new Set();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = tag.match(/\s(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i)?.[1];
    const alt = tag.match(/\salt=["']([^"']*)["']/i)?.[1] || '';
    if (!src || src.startsWith('data:')) continue;
    const hay = `${src} ${alt}`;
    if (/logo|icon|emoji|instagram|sprite|placeholder/i.test(hay)) continue;
    const keyword = FLYER_NAME_RE.test(hay);
    const popmenu = /popmenucloud\.com/i.test(src);
    if (!keyword && !(onSpecialsPage && popmenu)) continue;
    let url;
    try {
      url = new URL(src, origin).href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const urlScore = scoreMediaUrl(url);
    const bonus = (/exch|mule|taco|whiskey|padres/i.test(hay) ? 25 : keyword ? 8 : 0)
      + (popmenu && onSpecialsPage ? 20 : 0);
    const score = urlScore + bonus;
    if (score <= 0) continue;
    ranked.push({
      url,
      alt,
      kind: classifyUrl(url) === 'html' ? 'image' : classifyUrl(url),
      score,
    });
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, max);
}

/** Images plus PDF/menu hrefs from a fetched page. */
export function discoverSpecialsMedia(html, pageUrl, max = 8) {
  const ranked = discoverSpecialsImages(html, pageUrl, max);
  const seen = new Set(ranked.map((row) => row.url));
  let origin = 'https://example.com';
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    // dummy origin
  }

  for (const match of html.matchAll(/<a[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].trim();
    const anchor = String(match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let url;
    try {
      url = new URL(href, origin).href;
    } catch {
      continue;
    }
    if (seen.has(url) || classifyUrl(url) !== 'pdf') continue;
    let score = scoreMediaUrl(url);
    if (/happy\s*hour|specials?|menu|\bhh\b/i.test(`${href} ${anchor}`)) score += 40;
    if (score <= 0) continue;
    seen.add(url);
    ranked.push({ url, alt: anchor, kind: 'pdf', score });
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, max);
}

export function discoverSocialLinks(html, pageUrl) {
  if (!html) return [];
  const found = new Map();
  let origin = null;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    origin = null;
  }

  for (const match of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = match[1].trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }
    try {
      const url = new URL(href, origin || 'https://example.com');
      const host = url.hostname.replace(/^www\./i, '');
      for (const [network, pattern] of Object.entries(SOCIAL_HOSTS)) {
        if (!pattern.test(host)) continue;
        if (/\/share|\/sharer|\/intent/i.test(url.pathname)) continue;
        const key = `${network}:${url.origin}${url.pathname.replace(/\/$/, '')}`;
        if (!found.has(key)) found.set(key, { network, url: url.href });
      }
    } catch {
      // skip
    }
  }

  return [...found.values()].slice(0, 6);
}

export function socialSnippetFromHtml(html) {
  if (!html) return '';
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const parts = [title?.[1], og?.[1]].filter(Boolean);
  if (parts.length) return parts.join('\n');
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

function flyerKind(page) {
  return sniffMediaFromBytes(page?.bytes)?.kind || page?.kind || null;
}

export function isHappyHourFlyerUrl(url, kind = 'image') {
  const href = String(url || '');
  if (isDecorativeMediaUrl(href)) return false;
  let pathBlob = href;
  try {
    const parsed = new URL(href);
    pathBlob = `${parsed.pathname} ${parsed.search}`;
  } catch {
    // keep the raw href
  }
  if (kind === 'pdf') {
    return scoreMediaUrl(href) >= 40 || /happy[-_ ]?hour|(?:^|[/_-])hh(?:[._-]|\.pdf)/i.test(pathBlob);
  }
  if (/popmenucloud\.com/i.test(href)) {
    return /menu|happy|specials?|flyer|(?:^|[/_-])hh(?:[/_.-]|$)/i.test(pathBlob);
  }
  return /happy[-_ ]?hour|hh-menu|(?:^|[/_-])hh[-_.]?(?:menu|flyer|specials?)(?:[._-]|$)/i.test(pathBlob);
}

/** Image or happy-hour PDF flyers worth saving to the venue gallery. */
export function selectMenuFlyerPages(candidates = [], max = 2) {
  return (candidates || [])
    .filter((page) => page?.ok !== false && page.bytes?.length)
    .filter((page) => {
      const kind = flyerKind(page);
      if (kind !== 'image' && kind !== 'pdf') return false;
      return isHappyHourFlyerUrl(page.url, kind);
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, max);
}
