import assert from 'node:assert/strict';
import { normalizeUsPhone } from '../src/lib/phone.ts';

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`fail ${name}`);
    throw error;
  }
}

test('normalizeUsPhone accepts common US formats', () => {
  assert.equal(normalizeUsPhone('(619) 555-0100'), '+16195550100');
  assert.equal(normalizeUsPhone('619-555-0100'), '+16195550100');
  assert.equal(normalizeUsPhone('+1 619 555 0100'), '+16195550100');
  assert.equal(normalizeUsPhone('16195550100'), '+16195550100');
});

test('normalizeUsPhone returns empty string for blank input', () => {
  assert.equal(normalizeUsPhone(''), '');
  assert.equal(normalizeUsPhone('   '), '');
});

test('normalizeUsPhone rejects invalid numbers', () => {
  assert.equal(normalizeUsPhone('12345'), null);
  assert.equal(normalizeUsPhone('not-a-phone'), null);
});

console.log('sms-preferences tests passed');
