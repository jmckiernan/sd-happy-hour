export const BLOG_LINK_TYPES = [
  'post_card',
  'article_link',
  'mentioned_venue',
  'previous_post',
  'next_post',
  'site_navigation',
  'footer',
  'internal',
  'external',
  'contact',
] as const;

export type BlogLinkType = (typeof BLOG_LINK_TYPES)[number];

export interface BlogDestination {
  linkType: BlogLinkType;
  destinationPath?: string;
  destinationUrl?: string;
}

function explicitLinkType(value: string | undefined): BlogLinkType | null {
  return BLOG_LINK_TYPES.includes(value as BlogLinkType) ? value as BlogLinkType : null;
}

export function cleanAnalyticsPath(value: string): string {
  try {
    const url = new URL(value, 'https://happyhoursd.com');
    return `${url.pathname}${url.hash && url.hash.length <= 80 ? url.hash : ''}`.slice(0, 240);
  } catch {
    return '/';
  }
}

export function classifyBlogDestination(
  href: string,
  siteOrigin: string,
  explicitType?: string
): BlogDestination | null {
  const configured = explicitLinkType(explicitType);
  if (/^(mailto|tel):/i.test(href)) return { linkType: configured || 'contact' };

  let destination: URL;
  try {
    destination = new URL(href, siteOrigin);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(destination.protocol)) return null;

  if (destination.origin === siteOrigin) {
    return {
      linkType: configured || 'internal',
      destinationPath: cleanAnalyticsPath(destination.href),
    };
  }

  return {
    linkType: configured || 'external',
    // Deliberately omit query strings: campaign or login parameters can carry
    // identifiers, and the page path is sufficient to distinguish links.
    destinationUrl: `${destination.origin}${destination.pathname}`.slice(0, 240),
  };
}

export function scrollPercent(input: {
  scrollY: number;
  viewportHeight: number;
  documentHeight: number;
}): number {
  if (input.documentHeight <= input.viewportHeight) return 100;
  const progress = (input.scrollY + input.viewportHeight) / input.documentHeight;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}
