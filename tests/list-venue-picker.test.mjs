import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isListPickerCandidate,
  preferListPickerVenue,
  venuesForListPicker,
} from '../src/lib/listVenuePicker.ts';

test('list picker hides seo-hidden stubs and unscheduled rows', () => {
  assert.equal(isListPickerCandidate({
    id: 5,
    name: 'Rustic Root',
    neighborhood: 'Gaslamp',
    days: ['Monday'],
    startTime: '15:00',
    endTime: '18:00',
  }), true);
  assert.equal(isListPickerCandidate({
    id: 778,
    name: 'Rustic Root',
    neighborhood: 'Gaslamp',
    seoHidden: true,
    deals: [],
  }), false);
  assert.equal(isListPickerCandidate({
    id: 9,
    name: 'Claim Stub',
    neighborhood: 'North Park',
    listingStatus: 'unlisted',
    days: ['Friday'],
    startTime: '16:00',
    endTime: '18:00',
  }), false);
});

test('list picker keeps one venue per name + neighborhood label', () => {
  const venues = venuesForListPicker([
    {
      id: 778,
      name: 'Rustic Root',
      neighborhood: 'Gaslamp',
      seoHidden: true,
    },
    {
      id: 5,
      name: 'Rustic Root',
      neighborhood: 'Gaslamp',
      days: ['Monday'],
      startTime: '15:00',
      endTime: '18:00',
      deals: ['$6 wells'],
    },
    {
      id: 900,
      name: 'Rustic Root',
      neighborhood: 'Gaslamp',
      days: ['Monday'],
      startTime: '15:00',
      endTime: '18:00',
      deals: [],
    },
    {
      id: 2176,
      name: 'Rustic Root',
      neighborhood: 'Solana Beach',
      days: ['Monday'],
      startTime: '16:00',
      endTime: '18:00',
      deals: ['$6 draft beers'],
    },
  ]);

  assert.deepEqual(
    venues.map((venue) => ({ id: venue.id, neighborhood: venue.neighborhood })),
    [
      { id: 5, neighborhood: 'Gaslamp' },
      { id: 2176, neighborhood: 'Solana Beach' },
    ],
  );
});

test('preferListPickerVenue favors owner-verified and deal-rich rows', () => {
  const sparse = {
    id: 1,
    name: 'Example',
    neighborhood: 'North Park',
    days: ['Friday'],
    startTime: '16:00',
    endTime: '18:00',
    deals: [],
  };
  const rich = {
    ...sparse,
    id: 99,
    deals: ['$8 spritzes', '$6 beer'],
    ownerVerified: true,
  };
  assert.equal(preferListPickerVenue(sparse, rich).id, 99);
  assert.equal(preferListPickerVenue(sparse, { ...sparse, id: 40 }).id, 1);
});
