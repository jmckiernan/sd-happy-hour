/**
 * The text about a venue that a search should look inside.
 *
 * The happy-hour menu is the largest and most specific body of text we hold
 * about a venue — "pork belly bites", "harissa meatballs", "blistered green
 * beans" appear nowhere else in the record. It only became searchable once the
 * menu was stored as text rather than as a photo of a menu, which is the whole
 * reason for keeping it that way.
 *
 * Its own module, and free of any dataset import, so the homepage's client
 * bundle can use the same rule the server does.
 */

export interface SearchableVenue {
  name?: string | null;
  neighborhood?: string | null;
  address?: string | null;
  vibe?: string | null;
  deals?: readonly string[] | null;
  dealTypes?: readonly string[] | null;
  hhMenu?: {
    note?: string | null;
    sections?: readonly {
      title?: string | null;
      items?: readonly { name?: string | null; price?: string | null }[] | null;
    }[] | null;
  } | null;
}

/** Every menu section title, item name and price, in reading order. */
export function venueMenuText(venue: SearchableVenue): string[] {
  const parts: string[] = [];
  if (venue.hhMenu?.note) parts.push(venue.hhMenu.note);
  for (const section of venue.hhMenu?.sections || []) {
    if (section?.title) parts.push(section.title);
    for (const item of section?.items || []) {
      if (item?.name) parts.push(item.name);
      if (item?.price) parts.push(item.price);
    }
  }
  return parts;
}

export function venueSearchText(venue: SearchableVenue): string[] {
  return [
    venue.name,
    venue.neighborhood,
    venue.address,
    venue.vibe,
    ...(venue.deals || []),
    ...(venue.dealTypes || []),
    ...venueMenuText(venue),
  ].filter((part): part is string => Boolean(part));
}
