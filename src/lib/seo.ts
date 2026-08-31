import type { Venue } from './venues';
import { formatTime, venuePath } from './venues';

export const SITE_URL = 'https://happyhoursd.com';
export const SITE_NAME = 'SD Happy Hours';
export const SITE_DESCRIPTION =
  'Find current happy hour times, food and drink deals, and local guides for restaurants and bars across San Diego.';

export type JsonLd = Record<string, unknown>;

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

export function withSiteName(title: string, maxLength = 65): string {
  const branded = `${title} | ${SITE_NAME}`;
  return branded.length <= maxLength ? branded : title;
}

export const organizationSchema: JsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE_URL}/#organization`,
  name: SITE_NAME,
  alternateName: 'San Diego Happy Hours',
  url: SITE_URL,
  logo: {
    '@type': 'ImageObject',
    url: absoluteUrl('/logo.svg'),
    width: 512,
    height: 512,
  },
  description: SITE_DESCRIPTION,
  areaServed: {
    '@type': 'AdministrativeArea',
    name: 'San Diego County, California',
  },
};

export const websiteSchema: JsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE_URL}/#website`,
  url: SITE_URL,
  name: SITE_NAME,
  alternateName: 'San Diego Happy Hours',
  description: SITE_DESCRIPTION,
  inLanguage: 'en-US',
  publisher: { '@id': `${SITE_URL}/#organization` },
};

export function breadcrumbSchema(items: BreadcrumbItem[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function itemListSchema(
  name: string,
  items: Array<{ name: string; path: string }>
): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      url: absoluteUrl(item.path),
    })),
  };
}

export function venueSchema(venue: Venue, image: string, description: string): JsonLd {
  const pageUrl = absoluteUrl(venuePath(venue));
  const schema: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    '@id': `${pageUrl}#venue`,
    name: venue.name,
    url: pageUrl,
    image: absoluteUrl(image),
    description,
    address: {
      '@type': 'PostalAddress',
      streetAddress: venue.address,
      addressLocality: 'San Diego',
      addressRegion: 'CA',
      addressCountry: 'US',
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: venue.lat,
      longitude: venue.lng,
    },
    areaServed: venue.neighborhood,
    sameAs: [venue.website],
  };

  // Only claim offers we can actually name — an empty makesOffer array is
  // noise, and inventing one was the placeholder bug.
  if (venue.deals.length) {
    schema.makesOffer = venue.deals.map((deal) => ({
      '@type': 'Offer',
      name: deal,
      description: `${deal} during ${venue.name}'s happy hour, ${formatTime(venue.startTime)}–${formatTime(venue.endTime)} on ${venue.days.join(', ')}.`,
      url: pageUrl,
    }));
  }

  // The itemized menu, for the crawlers and answer engines that read structured
  // data rather than pixels. This is only expressible because the menu is
  // stored as text; when it was a photo there was nothing to publish here.
  const menuSections = (venue.hhMenu?.sections || []).filter((section) => section.items?.length);
  if (menuSections.length) {
    schema.hasMenu = {
      '@type': 'Menu',
      name: `${venue.name} happy hour menu`,
      ...(venue.hhMenu?.note ? { description: venue.hhMenu.note } : {}),
      hasMenuSection: menuSections.map((section) => ({
        '@type': 'MenuSection',
        name: section.title,
        hasMenuItem: section.items.map((item) => {
          const amount = /^\$\s*(\d+(?:\.\d{1,2})?)$/.exec(String(item.price || '').trim());
          return {
            '@type': 'MenuItem',
            name: item.name,
            ...(amount
              ? { offers: { '@type': 'Offer', price: amount[1], priceCurrency: 'USD' } }
              : {}),
          };
        }),
      })),
    };
  }

  if (venue.phone) schema.telephone = venue.phone;
  return schema;
}

export interface ArticleSchemaInput {
  title: string;
  description: string;
  slug: string;
  image: string;
  author: string;
  pubDate: Date;
  updatedDate?: Date;
  wordCount: number;
  keywords?: string[];
}

export function articleSchema(input: ArticleSchemaInput): JsonLd {
  const pageUrl = absoluteUrl(`/blog/${input.slug}/`);
  const author = input.author === SITE_NAME
    ? { '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: SITE_NAME }
    : input.author.split(/\s*&\s*/).map((name) => ({
      '@type': 'Person',
      name,
      url: `${SITE_URL}/about/#authors`,
    }));
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': `${pageUrl}#article`,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': pageUrl,
    },
    headline: input.title,
    description: input.description,
    image: absoluteUrl(input.image),
    datePublished: input.pubDate.toISOString(),
    dateModified: (input.updatedDate || input.pubDate).toISOString(),
    author,
    publisher: { '@id': `${SITE_URL}/#organization` },
    isPartOf: { '@id': `${SITE_URL}/#website` },
    inLanguage: 'en-US',
    wordCount: input.wordCount,
    keywords: input.keywords?.join(', '),
  };
}

/** Prevent a closing script tag in CMS-controlled copy from breaking out of JSON-LD. */
export function serializeJsonLd(value: JsonLd): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
