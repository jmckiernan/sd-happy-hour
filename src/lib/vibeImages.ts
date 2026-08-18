// The stock photo per "vibe", split out of venues.ts so the admin listing
// form can use it too.
//
// venues.ts imports public/data/happy-hours.json, which makes it unsuitable
// for anything bundled into the browser that only needs this lookup — the
// listing form (lib/listingForm.ts) shows the stock photo a venue would fall
// back to, and pulling the whole venue dataset into the admin bundle to do it
// would be silly. venues.ts re-exports these, so existing importers are
// unaffected.

// Stock photo per "vibe" — used as a thumbnail on the homepage cards and,
// at a higher resolution, as the hero banner on individual venue pages.
//
// These used to be hotlinks to images.unsplash.com, which meant every page
// load depended on Unsplash staying up and keeping those photo IDs alive
// (and rendered as broken images anywhere Unsplash is network-blocked).
// They're now our own copies under public/images/vibes/, downloaded once by
// scripts/fetch-vibe-images.js — which is also where the original Unsplash
// photo IDs are recorded, if one ever needs re-fetching.
//
// Each file is a single 1600px-wide master (the largest size the site asks
// for). The card/hero sizing that Unsplash's `?w=` params used to do now
// happens in getVenueImage() below.
export const vibeImages: Record<string, string> = {
  'Upscale casual': '/images/vibes/upscale-casual.jpg',
  'Speakeasy': '/images/vibes/speakeasy.jpg',
  'Trendy gastropub': '/images/vibes/trendy-gastropub.jpg',
  'Seafood spot': '/images/vibes/seafood-spot.jpg',
  'Rooftop vibes': '/images/vibes/rooftop-vibes.jpg',
  'Modern Mexican': '/images/vibes/modern-mexican.jpg',
  'Tiki bar': '/images/vibes/tiki-bar.jpg',
  'Chef-driven': '/images/vibes/chef-driven.jpg',
  'Wine bar': '/images/vibes/wine-bar.jpg',
  'Upscale Mediterranean': '/images/vibes/upscale-mediterranean.jpg',
  'Neighborhood gastropub': '/images/vibes/neighborhood-gastropub.jpg',
  'Craft cocktails': '/images/vibes/craft-cocktails.jpg',
  'Dog-friendly patio': '/images/vibes/dog-friendly-patio.jpg',
  'Casual chicken joint': '/images/vibes/casual-chicken-joint.jpg',
  'Waterfront Mexican': '/images/vibes/waterfront-mexican.jpg',
  'Arcade bar': '/images/vibes/arcade-bar.jpg',
  'All-day cafe': '/images/vibes/all-day-cafe.jpg',
  'Italian gastropub': '/images/vibes/italian-gastropub.jpg',
  'Vegan metal bar': '/images/vibes/vegan-metal-bar.jpg',
  'Beach brewery': '/images/vibes/beach-brewery.jpg',
  // Intentionally the same photo as 'Speakeasy' — that's what the previous
  // Unsplash map did too (both pointed at photo-1470337458703).
  'default': '/images/vibes/speakeasy.jpg',
};

/** The stock photo path for a vibe, falling back to the default when the vibe
 * isn't one of the known ones (submitters type these freely). Not routed
 * through the Image CDN — callers size it themselves. */
export function vibeImageFor(vibe: string | undefined): string {
  return vibeImages[vibe || ''] || vibeImages['default'];
}
