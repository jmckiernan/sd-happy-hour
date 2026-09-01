import { expect, test, type Page } from '@playwright/test';
import {
  SERVER_NOW,
  livePromotion,
  mockConsumerApis,
  venueFixture,
} from './helpers/promotion-fixtures';

const recurringNowOne = venueFixture(801, 'Recurring Now Oyster Bar', {
  neighborhood: 'Little Italy',
  days: ['Friday'],
  startTime: '16:00',
  endTime: '19:00',
  dealTypes: ['oysters'],
});
const recurringNowTwo = venueFixture(802, 'Recurring Now Taproom', {
  neighborhood: 'North Park',
  days: ['Friday'],
  startTime: '15:00',
  endTime: '18:00',
  dealTypes: ['beer'],
});
const liveDealOnly = venueFixture(803, 'Promotion Only Cantina', {
  neighborhood: 'South Park',
  days: ['Friday'],
  startTime: '10:00',
  endTime: '11:00',
  dealTypes: ['cocktails'],
});
const laterToday = venueFixture(804, 'Later Today Wine Bar', {
  neighborhood: 'South Park',
  days: ['Friday'],
  startTime: '20:00',
  endTime: '22:00',
  dealTypes: ['wine'],
});

function directoryNames(page: Page) {
  return page.locator('#grid .venue-name');
}

test('hero count clears directory filters and shows only recurring happy hours happening now', async ({
  page,
}) => {
  await mockConsumerApis(page, {
    venues: [laterToday, liveDealOnly, recurringNowTwo, recurringNowOne],
    livePayload: {
      serverNow: SERVER_NOW,
      promotions: [livePromotion(liveDealOnly)],
    },
  });
  await page.goto('/');

  const liveNowButton = page.locator('#live-counter-button');
  await expect(liveNowButton).toBeEnabled();
  await expect(page.locator('#live-count-big')).toHaveText('2');

  await page.locator('#search-input').fill('no matching venue');
  await page.locator('#day-filter').selectOption('Monday');
  await page.locator('#neighborhood-filter').selectOption('South Park');
  await page.locator('#deal-filter').selectOption('cocktails');
  await page.locator('#trust-filter').selectOption('unverified');
  await expect(directoryNames(page)).toHaveCount(0);

  await liveNowButton.click();

  await expect(page.locator('#search-input')).toHaveValue('');
  await expect(page.locator('#day-filter')).toHaveValue('');
  await expect(page.locator('#neighborhood-filter')).toHaveValue('');
  await expect(page.locator('#deal-filter')).toHaveValue('');
  await expect(page.locator('#trust-filter')).toHaveValue('');
  await expect(page.locator('#status-filter')).toHaveValue('happy-hour-now');
  await expect(directoryNames(page)).toHaveText([
    recurringNowTwo.name,
    recurringNowOne.name,
  ]);
  await expect(page.getByText(liveDealOnly.name, { exact: true })).toHaveCount(0);
  await expect(page.getByText(laterToday.name, { exact: true })).toHaveCount(0);
  await expect(page.locator('#status-filter')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('zero recurring happy hours leaves the directory and scroll position unchanged', async ({ page }) => {
  await mockConsumerApis(page, {
    venues: [liveDealOnly, laterToday],
    livePayload: {
      serverNow: SERVER_NOW,
      promotions: [livePromotion(liveDealOnly)],
    },
  });
  await page.goto('/');

  const liveNowButton = page.locator('#live-counter-button');
  await expect(page.locator('#live-count-big')).toHaveText('0');
  await expect(liveNowButton).toBeDisabled();
  await page.locator('#search-input').fill(laterToday.name);

  await liveNowButton.evaluate((button: HTMLButtonElement) => button.click());

  await expect(page.locator('#search-input')).toHaveValue(laterToday.name);
  await expect(page.locator('#status-filter')).toHaveValue('');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
