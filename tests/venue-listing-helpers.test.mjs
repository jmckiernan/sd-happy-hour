import assert from 'node:assert/strict';
import {
  alertMatchesVenue,
  getListingImage,
  venueListingPath,
  venueMatchesTimeRange,
  venueVerificationType,
} from '../src/lib/venueListingHelpers.ts';
import { buildVenueSlugMap } from '../src/lib/venueSlug.ts';

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`fail ${name}`);
    throw error;
  }
}

test('getListingImage prefers featured photo over vibe stock', () => {
  assert.match(getListingImage({ image: '/images/venues/foo.jpg', vibe: 'Brewery' }), /foo\.jpg/);
  assert.match(getListingImage({ vibe: 'Brewery' }), /^\/images\/vibes\//);
});

test('venueMatchesTimeRange respects a clock window', () => {
  const venue = { startTime: '16:00', endTime: '18:00', windows: [] };
  assert.equal(venueMatchesTimeRange(venue, '15:00', '19:00'), true);
  assert.equal(venueMatchesTimeRange(venue, '18:30', '20:00'), false);
});

test('venueVerificationType prefers owner over web evidence', () => {
  assert.equal(venueVerificationType({ verified: true, hhSources: {} }, true), 'owner');
  assert.equal(venueVerificationType({ verified: false, hhSources: { x: { source: 'venue website' } } }), 'web');
  assert.equal(venueVerificationType({ verified: false }), 'none');
});

test('alertMatchesVenue mirrors homepage filter semantics', () => {
  const venue = {
    id: 1,
    name: 'Oyster Bar',
    neighborhood: 'Pacific Beach',
    address: '123 Ocean',
    days: ['Friday'],
    dealTypes: ['seafood'],
    startTime: '16:00',
    endTime: '18:00',
  };
  assert.equal(alertMatchesVenue({ neighborhood: 'Pacific Beach' }, venue), true);
  assert.equal(alertMatchesVenue({ neighborhood: 'North Park' }, venue), false);
});

test('venueListingPath uses slug map for duplicate names', () => {
  const venues = [
    { id: 1, name: 'The Local', neighborhood: 'North Park' },
    { id: 2, name: 'The Local', neighborhood: 'Pacific Beach' },
  ];
  const slugs = buildVenueSlugMap(venues);
  assert.equal(venueListingPath(venues[0], slugs), '/venues/the-local-north-park/');
  assert.equal(venueListingPath(venues[1], slugs), '/venues/the-local-pacific-beach/');
});
