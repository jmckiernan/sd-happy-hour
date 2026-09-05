import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSignInHref,
  postLoginDestination,
  postAuthReturnPath,
  safeReturnPath,
  verifiedOwnerDashboardPath,
} from '../src/lib/authRedirect.ts';

test('safeReturnPath accepts same-origin relative paths with query and hash', () => {
  assert.equal(safeReturnPath('/restaurant/'), '/restaurant/');
  assert.equal(safeReturnPath('/lists/abc/?invite=1#top'), '/lists/abc/?invite=1#top');
  assert.equal(safeReturnPath('/live-deals/'), '/live-deals/');
});

test('safeReturnPath rejects open redirects', () => {
  assert.equal(safeReturnPath('https://evil.example/'), null);
  assert.equal(safeReturnPath('//evil.example'), null);
  assert.equal(safeReturnPath('/\\evil.example'), null);
  assert.equal(safeReturnPath('\\\\evil.example'), null);
  assert.equal(safeReturnPath('javascript:alert(1)'), null);
  assert.equal(safeReturnPath(''), null);
  assert.equal(safeReturnPath(null), null);
});

test('postAuthReturnPath rejects account/sign-in self-loops and unwraps nested next', () => {
  assert.equal(postAuthReturnPath('/account/'), null);
  assert.equal(postAuthReturnPath('/account'), null);
  assert.equal(postAuthReturnPath('/account/#section-lists'), null);
  assert.equal(postAuthReturnPath('/account/?next=/restaurant/'), '/restaurant/');
  assert.equal(
    postAuthReturnPath('/account/?next=/account/?next=/live-deals/'),
    '/live-deals/',
  );
  assert.equal(postAuthReturnPath('/account/?next=/account/'), null);
  assert.equal(postAuthReturnPath('/restaurant/reports/'), '/restaurant/reports/');
  assert.equal(postAuthReturnPath('/restaurant/audience/'), '/restaurant/audience/');
  assert.equal(postAuthReturnPath('/restaurant/billing/?venueId=42'), '/restaurant/billing/?venueId=42');
});

test('accountSignInHref encodes a safe next destination', () => {
  assert.equal(accountSignInHref(null), '/account/');
  assert.equal(accountSignInHref('/account/'), '/account/');
  assert.equal(accountSignInHref('/account/?next=/restaurant/'), '/account/?next=%2Frestaurant%2F');
  assert.equal(accountSignInHref('https://evil.example/'), '/account/');
  assert.equal(
    accountSignInHref('/restaurant/reports/'),
    '/account/?next=%2Frestaurant%2Freports%2F',
  );
  assert.equal(
    accountSignInHref('/restaurant/audience/?venueId=42'),
    '/account/?next=%2Frestaurant%2Faudience%2F%3FvenueId%3D42',
  );
  assert.equal(
    accountSignInHref('/restaurant/billing/'),
    '/account/?next=%2Frestaurant%2Fbilling%2F',
  );
});

test('verified restaurant owners land on their verified venue dashboard', () => {
  assert.equal(verifiedOwnerDashboardPath(null), null);
  assert.equal(verifiedOwnerDashboardPath([]), null);
  assert.equal(verifiedOwnerDashboardPath([
    { status: 'pending', venueId: 9 },
    { status: 'denied', venueId: 10 },
  ]), null);
  assert.equal(verifiedOwnerDashboardPath([
    { status: 'pending', venueId: 9 },
    { status: 'verified', venueId: 42 },
    { status: 'verified', venueId: 43 },
  ]), '/restaurant/?venueId=42');
  assert.equal(verifiedOwnerDashboardPath([
    { status: 'verified', venueId: 0 },
    { status: 'verified', venueId: Number.NaN },
  ]), null);
});

test('an explicit post-login return wins over the verified-owner default', () => {
  assert.equal(
    postLoginDestination('/lists/invited/', '/restaurant/?venueId=42'),
    '/lists/invited/',
  );
  assert.equal(
    postLoginDestination(null, '/restaurant/?venueId=42'),
    '/restaurant/?venueId=42',
  );
  assert.equal(
    postLoginDestination('https://evil.example/', '/restaurant/?venueId=42'),
    '/restaurant/?venueId=42',
  );
  assert.equal(postLoginDestination(null, '//evil.example/'), null);
});

console.log('auth redirect helpers passed');
