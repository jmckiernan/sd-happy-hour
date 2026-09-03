import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSignInHref,
  postAuthReturnPath,
  safeReturnPath,
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

console.log('auth redirect helpers passed');
