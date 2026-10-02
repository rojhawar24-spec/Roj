# ShopEasy — Universal Webshop 2.5.0

A professional English-first webshop foundation with a mobile-focused storefront and a simple manager control room.

## Customer side

- Search, categories and product pages
- Product sale prices with sale windows
- Cart and wishlist
- Secure account
- Checkout requiring account email, phone number, delivery name, street, postal code, city and country
- Clear phone-use explanation and required-field validation
- Server-side price, discount, shipping and stock verification
- Stripe-ready payment flow with idempotency and webhook verification
- Orders and protected order history
- Timed stories
- English UI
- Optional short AI shopping assistant

## Manager side

Open `/admin` after creating the admin account. The manager can:

1. Add categories.
2. Add/edit products, images, SKU, stock, regular price and sale price.
3. Set sale start/end dates; the percentage discount is calculated automatically.
4. Create percentage or fixed coupons with minimum order and expiry.
5. Create, schedule, attach and delete stories.
6. Open orders and see customer email, phone number and full delivery location.
7. Move paid orders through processing → shipped → completed.
8. Search customers and see latest contact/location summary.
9. Use the audit log for sensitive manager actions.
10. Open Settings for store identity/payment/policies and enable/disable optional AI; product discounts are configured on each product.

## AI: keep, disable or remove

The AI integration is isolated in `src/services/ai.js`. The core shop never needs it.

- Keep it: configure the server `AI_*` variables and turn on AI in Manager → Settings.
- Disable it: turn off the AI switch; the storefront, search, cart, checkout, orders and admin still work.
- Remove it completely: delete `src/services/ai.js` and remove the unused `AI_*` environment variables. The server handles the missing optional module safely.

API credentials never appear in the browser and are not stored in the manager database.

## Preview

Open `PREVIEW.html` locally for a static visual sample of the redesigned storefront. Manager scheduling uses `STORE_TIMEZONE` (default `Europe/Brussels`). It is sample content, not a live shop.

## Before real sales

Use HTTPS hosting, a real admin password, durable database/upload storage, real Stripe credentials and webhook verification, correct VAT/tax/invoicing setup, accurate shipping/returns/privacy/terms wording, monitoring and backups. Test the full payment lifecycle in Stripe test mode before switching to live mode.

## Checks

Install dependencies first (this also provides the `@libsql/client` native binding used by the database integration tests):

```bash
npm install
```

Then run the checks:

```bash
npm run check
npm test
npm run audit:static
node scripts/template-audit.mjs
```

Or run everything, including dependency-based database integration tests, with a single command:

```bash
npm run audit
```

CI runs the same `npm ci && npm run audit` sequence on every push and pull request (see `.github/workflows/ci.yml`).

Install dependencies in your deployment environment before starting the real application. The included load test is intended to run against a live local deployment.


## Release 2.5.0
This release adds a deep UI/UX refresh, fixes mobile navigation state, makes coupon and storefront date displays timezone-safe, releases pending checkout stock immediately on customer cancellation, disables optional AI by default, tightens production session cookies, adds accessibility skip navigation, improves mobile checkout ergonomics, aligns frontend asset versions, and expands the regression suite to 57 automated tests. It also hardens expired-checkout retries, payment-session linkage, currency selection, sender validation and the homepage hero data source.

The previous 2.1.1 hardening remains part of this release. See `AUDIT-REPORT.md` and `DEPLOYMENT-CHECKLIST.md`.


## Per-product automatic discounts

Managers set **Automatic discount %** on each product under **Manager → Products → Edit**. The value is 0–90%. A discount is applied only to that product, for every customer, and is recalculated by the server during cart/checkout. Product discounts and coupon discounts are tracked separately to prevent double-discounting.


### Live launch gate
The checkout stays blocked until Stripe, transactional order email, business identity/policies, tax-inclusive consumer pricing, and at least one active in-stock product are configured.
