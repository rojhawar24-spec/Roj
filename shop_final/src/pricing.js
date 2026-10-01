const MAX_PRODUCT_DISCOUNT_PERCENT = 90;

export function normalizeProductDiscountPercent(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_PRODUCT_DISCOUNT_PERCENT ? n : 0;
}

export function applyPercentDiscountCents(baseCents, percent) {
  const base = Number(baseCents);
  const pct = normalizeProductDiscountPercent(percent);
  if (!Number.isSafeInteger(base) || base < 0 || pct <= 0 || base === 0) return base;
  return Math.max(1, Math.floor(base * (100 - pct) / 100));
}
