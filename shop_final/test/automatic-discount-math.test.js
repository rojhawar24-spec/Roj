import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductDiscountPercent, applyPercentDiscountCents } from '../src/pricing.js';

test('per-product automatic discount examples are correct', () => {
  assert.equal(applyPercentDiscountCents(10000, 20), 8000);
  assert.equal(applyPercentDiscountCents(999, 10), 899);
  assert.equal(applyPercentDiscountCents(1, 90), 1);
  assert.equal(applyPercentDiscountCents(10000, 0), 10000);
});

test('invalid product discount values are safely normalized', () => {
  assert.equal(normalizeProductDiscountPercent(-1), 0);
  assert.equal(normalizeProductDiscountPercent(91), 0);
  assert.equal(normalizeProductDiscountPercent(10.5), 0);
  assert.equal(normalizeProductDiscountPercent('20.5'), 0);
  assert.equal(normalizeProductDiscountPercent(20), 20);
});

 test('product discount never produces a zero or negative price', () => {
  assert.equal(applyPercentDiscountCents(0, 90), 0);
  assert.equal(applyPercentDiscountCents(1, 90), 1);
  assert.equal(applyPercentDiscountCents(999, 90), 99);
});
