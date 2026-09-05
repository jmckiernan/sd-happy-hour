#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY = path.join(ROOT, '.data', 'newsletters', 'inventory.json');
const PROFILE = path.join(ROOT, '.data', 'newsletters', 'browser-profile');
const APPLY = process.argv.includes('--apply');
const HEADED = process.argv.includes('--headed');
const RETRY = process.argv.includes('--retry');

function option(name, fallback) {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return value === undefined ? fallback : value;
}

const receivingAddress = String(option('email', process.env.RESEND_RECEIVING_ADDRESS || '')).trim().toLowerCase();
const limit = Math.max(1, Number(option('limit', 25)) || 25);
if (!/^\S+@\S+\.\S+$/.test(receivingAddress)) {
  throw new Error('Pass --email=address@example.com or set RESEND_RECEIVING_ADDRESS to the dedicated Resend inbound address.');
}

function targetEmail(target) {
  const domain = receivingAddress.split('@')[1];
  const slug = target.host.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 38);
  const suffix = createHash('sha256').update(target.host).digest('hex').slice(0, 8);
  return `venue-${slug || 'newsletter'}-${suffix}@${domain}`;
}

const inventory = JSON.parse(await readFile(INVENTORY, 'utf8'));
const complete = new Set(['submitted', 'confirmed', 'no_newsletter', 'manual_required']);
const targets = inventory.targets
  .filter((target) => RETRY ? target.status !== 'confirmed' : !complete.has(target.status))
  .slice(0, limit);

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: !HEADED,
  viewport: { width: 1365, height: 900 },
});
context.setDefaultTimeout(8_000);

const SIGNUP_LINK = /newsletter|email[- ]?(?:list|updates)|subscribe|sign[- ]?up|stay (?:in|connected|updated|the know)/i;
const FORM_SIGNAL = /newsletter|subscribe|email (?:list|updates)|updates and offers|special offers|join (?:our|the) list|stay (?:in|connected|updated|the know)/i;
const KNOWN_ESP = /mailchimp\.com|list-manage\.com|klaviyo\.com|constantcontact\.com|mailerlite\.com|toasttab\.com|popmenu\.com|spoton\.com|bentobox\.com/i;

function sameOrEsp(candidate, home) {
  try {
    const left = new URL(candidate, home);
    const right = new URL(home);
    return left.hostname === right.hostname || KNOWN_ESP.test(left.hostname);
  } catch { return false }
}

async function candidateForms(page) {
  return page.locator('form').evaluateAll((forms) => forms.map((form, index) => {
    const text = (form.innerText || form.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const email = form.querySelector('input[type="email"], input[name*="email" i], input[autocomplete="email"]');
    const password = form.querySelector('input[type="password"]');
    const textarea = form.querySelector('textarea');
    const requiredOther = [...form.querySelectorAll('input[required]')].filter((input) => {
      const type = input.getAttribute('type') || 'text';
      return !['email', 'hidden', 'submit', 'checkbox'].includes(type.toLowerCase());
    }).length;
    return { index, text, hasEmail: Boolean(email), unsafe: Boolean(password || textarea), requiredOther };
  }));
}

async function locateForm(page, home) {
  let forms = await candidateForms(page);
  let candidate = forms.find((form) => form.hasEmail && !form.unsafe && !form.requiredOther && FORM_SIGNAL.test(form.text));
  if (candidate) return candidate;

  const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({
    href: node.href,
    text: `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim(),
  })).filter((link) => link.href));
  const link = links.find((item) => SIGNUP_LINK.test(`${item.text} ${item.href}`) && sameOrEsp(item.href, home));
  if (!link) return null;
  await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.waitForTimeout(1_000);
  forms = await candidateForms(page);
  candidate = forms.find((form) => form.hasEmail && !form.unsafe && !form.requiredOther && FORM_SIGNAL.test(form.text));
  return candidate || null;
}

async function processTarget(target) {
  const page = await context.newPage();
  const attemptedAt = new Date().toISOString();
  const email = target.subscriberEmail || targetEmail(target);
  try {
    await page.goto(target.website, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForTimeout(1_000);
    const candidate = await locateForm(page, target.website);
    if (!candidate) return { status: 'no_newsletter', subscriberEmail: email, attemptedAt, detail: 'No conservative newsletter form match found.' };
    const form = page.locator('form').nth(candidate.index);
    const newsletterUrl = page.url();
    if (!APPLY) return { status: 'discovered', subscriberEmail: email, newsletterUrl, attemptedAt, detail: candidate.text.slice(0, 300) };

    const emailInput = form.locator('input[type="email"], input[name*="email" i], input[autocomplete="email"]').first();
    await emailInput.fill(email);
    for (const checkbox of await form.locator('input[type="checkbox"][required]').all()) {
      if (!await checkbox.isChecked()) await checkbox.check();
    }
    const submit = form.locator('button[type="submit"], input[type="submit"], button').filter({ hasText: /subscribe|sign[- ]?up|join|submit/i }).first();
    if (await submit.count()) await submit.click();
    else await emailInput.press('Enter');
    await page.waitForTimeout(2_000);
    const resultText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(-1400);
    const challenged = /captcha|verify you are human|cloudflare|security check/i.test(resultText);
    if (challenged) return { status: 'manual_required', subscriberEmail: email, newsletterUrl, attemptedAt, detail: 'CAPTCHA or bot check encountered.' };
    return {
      status: 'submitted', subscriberEmail: email, newsletterUrl, attemptedAt,
      detail: /thank|check your (?:email|inbox)|confirm|subscribed|success/i.test(resultText)
        ? 'Site displayed a signup/confirmation success signal.'
        : 'Form submitted; confirmation state was not explicit.',
    };
  } catch (error) {
    return { status: 'error', subscriberEmail: email, attemptedAt, detail: String(error?.message || error).slice(0, 500) };
  } finally {
    await page.close();
  }
}

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: checking ${targets.length} newsletter targets with isolated Resend aliases on ${receivingAddress.split('@')[1]}`);
for (const target of targets) {
  const result = await processTarget(target);
  Object.assign(target, result);
  console.log(`${target.host}: ${result.status}${result.detail ? ` — ${result.detail}` : ''}`);
  inventory.updatedAt = new Date().toISOString();
  await writeFile(INVENTORY, `${JSON.stringify(inventory, null, 2)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

await context.close();
console.log(`Saved resumable state to ${INVENTORY}`);
