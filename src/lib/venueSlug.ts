/** URL slug helpers. Kept free of the venue JSON so astro.config can import them. */

export function slugify(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export type SlugVenue = {
  id: number;
  name: string;
  neighborhood?: string;
  address?: string;
};

/**
 * One slug per listing. Unique names stay `/venues/the-cork-and-craft/`.
 * Chains share a name, so the neighborhood is appended:
 * `/venues/karl-strauss-brewing-company-sorrento-valley/`.
 *
 * Always build this map from the full venue catalog. Unlisted claim stubs still
 * occupy a name and must be counted when disambiguating published locations.
 */
export function buildVenueSlugMap(venues: SlugVenue[]): Map<number, string> {
  const byName = new Map<string, SlugVenue[]>();
  for (const venue of venues) {
    const key = slugify(venue.name);
    const list = byName.get(key) || [];
    list.push(venue);
    byName.set(key, list);
  }

  const slugs = new Map<number, string>();
  const used = new Set<string>();
  for (const venue of venues) {
    const base = slugify(venue.name);
    const group = byName.get(base) || [venue];
    let slug = base;
    if (group.length > 1) {
      const hood = slugify(venue.neighborhood || '');
      slug = hood ? `${base}-${hood}` : base;
      const hoodPeers = group.filter((row) => slugify(row.neighborhood || '') === hood);
      if (hoodPeers.length > 1) {
        const street = slugify(String(venue.address || '').split(',')[0] || '');
        slug = street ? `${slug}-${street}` : `${slug}-${venue.id}`;
      }
    }
    if (used.has(slug)) slug = `${slug}-${venue.id}`;
    used.add(slug);
    slugs.set(venue.id, slug);
  }
  return slugs;
}

export function slugFromMap(venue: SlugVenue, slugs: Map<number, string>): string {
  return slugs.get(venue.id) || slugify(venue.name);
}
