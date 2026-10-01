# Universal Shop — Deep Release Audit 2.5.0

## Scope
Deep source, template, UI and configuration review of the supplied webshop ZIP: customer storefront, search, cart, checkout, account flows, manager/admin CRUD, stories, coupons, uploads, payments, sessions, CSRF, pricing, inventory reservations, time zones, copy, responsive layout, accessibility, frontend performance and regression coverage.

## Verification completed
- JavaScript syntax checks: PASS
- Automated tests: **57/57 PASS**
- Static audit: PASS
- EJS template audit: PASS
- SQLite schema execution checks from the existing audit suite: PASS
- Date/time conversion checks for Europe/Brussels winter/summer cases: PASS
- Preview relative-path checks: PASS
- No inline styles or inline scripts in the EJS views under the strict CSP checks: PASS
- POST form CSRF field scan: PASS
- Runtime date-display scan: all storefront/admin date displays audited; story expiry was corrected to use the store timezone helper.
- Color-contrast review was performed on primary text/secondary UI colors; low-contrast text tokens used for meaningful content were darkened.

## Bugs found and fixed in 2.5.0
- **Mobile navigation:** JS opened `.open`, but the previous mobile CSS did not expose the open state. The menu now has a real responsive open/close state, Escape support, outside-click close and correct `aria-expanded`/label updates.
- **Coupon expiry timezone:** the manager coupon form previously relied on the Node host timezone. Coupon expiry now converts through the configured `STORE_TIMEZONE`, matching product/story scheduling.
- **Customer checkout cancellation:** cancelling a pending checkout now immediately releases the order reservation after ownership is verified.
- **Misleading cancellation copy:** the cancellation page no longer says stock will only be released at expiry when it has already been released.
- **Story expiry display:** the public stories page previously used the Node runtime timezone; it now uses the store timezone helper.
- **Optional AI safety:** AI defaults to disabled (`ai_enabled=0`) and requires explicit manager enablement.
- **Production sessions:** session cookies now use the `__Host-` naming convention in production while retaining Secure, HttpOnly and SameSite protections.
- **Accessibility:** added a keyboard skip link, stronger visible focus treatment, better mobile target sizing and reduced-motion handling.
- **Color accessibility:** darkened meaningful secondary text colors that were too faint on white surfaces. Decorative/status dots remain color accents rather than the sole semantic indicator.
- **Mobile checkout:** removed the persistent mobile bottom navigation from checkout, added one-step copy, autocomplete/input hints and stronger single-submit protection.
- **Frontend cache busting:** CSS/JS/preview asset versions are aligned at 2.5.0.
- **Media loading:** product/story images use async decoding and lazy loading where appropriate.
- **Per-product automatic discount:** Manager → Products → Edit supports a server-side 0–90% automatic discount on that product only; 0% disables it. Each line in cart/checkout shows its own item discount, orders store the automatic discount separately from coupon discounts, and the final price is recalculated server-side before payment so discounts cannot be applied twice.

## Per-product automatic discount
Manager → Products → Edit controls a server-side 0–90% discount for the selected product and every customer who buys that product. The discount is recalculated in the cart and order, stored separately from coupon discounts, and the Stripe checkout receives only the coupon discount so the per-product discount is not duplicated.

## Security review
The application already contains strong server-side controls including Helmet/CSP, CSRF verification, same-origin redirect restrictions, server-side price/stock calculation, atomic checkout reservation, idempotency protection, Stripe signature verification, rate limiting, server-side manager authorization, upload signature checks, generated upload filenames and audit logs. The deep pass preserved these controls and added the production session-cookie hardening above.

File uploads still have the usual deployment requirement for malware/antivirus scanning and durable storage strategy before accepting arbitrary public uploads at scale.

## UX/design review
The storefront was visually consolidated into a single restrained design system: dark navy text, mint action accent, blue navigation/accent color, white surfaces, soft borders, consistent radii and shadows, responsive two-column/one-column layouts, compact cards and a dedicated mobile navigation pattern. The intent is to reduce visual noise and keep product discovery, prices, stock and checkout actions obvious.

The checkout keeps the final order summary visible beside the form on larger screens and stacks it cleanly on mobile. Error messages remain server-generated and user-readable.

## Sales-readiness limitations

The code is technically hardened but a live shop still needs real business/legal/payment configuration. In Belgium, online sellers must provide business identity, phone/email, product information, price/tax/extra-cost information, delivery/payment information and applicable consumer-rights information before purchase. A payment-obligation button must be clearly identified. citeturn863635search0turn863635search4

Price-reduction claims also need the legally correct reference price. In Belgium, a promoted reduction normally uses the lowest price applied through that sales channel during the previous 30 days. The application does not independently verify the legal 30-day reference-price history, so a manager must not publish a percentage/strikethrough promotion without validating the reference price. citeturn863635search1

After an online sale, the customer must receive the contract confirmation on a durable medium, typically by email, with the required information. The current build implements a durable-medium order confirmation email through Resend with idempotency protection; actual provider delivery still needs verification in the deployment environment. citeturn863635search2turn863635search3

## Additional fixes verified after the previous audit

- **Database startup TDZ:** moved the settings upsert statement before every startup migration that uses it, preventing a production startup crash.
- **Expired checkout retry:** an expired pending idempotency order is now cancelled before the same token can create a fresh order.
- **Payment-session race:** retrying an existing pending order now refuses to redirect to a newly-created Stripe session unless that session was successfully linked to the order.
- **Homepage demo removal:** the hero now uses real catalog data and falls back to active products when no product is marked featured.
- **Currency guard:** manager currency selection uses a server allow-list and checkout enforces a configured minimum amount.
- **Email sender validation:** malformed sender addresses no longer make the transactional email integration appear ready.
- **Product-form currency:** manager product price previews always receive the configured store currency.

## Production verification still required
A local dependency-backed Express/browser/Stripe end-to-end run could not be completed because `npm install` timed out in this environment before dependencies were available. Therefore the following are **not** claimed as completed:
- live browser testing against the running Express/EJS app
- Stripe test-mode payment + webhook lifecycle in a real Stripe account
- `npm audit` against a fully installed dependency tree
- transactional email/account-recovery delivery tests
- production reverse-proxy/HTTPS behavior
- multi-instance session/rate-limit behavior
- legal/tax/VAT configuration for a specific selling jurisdiction

These are deployment-stage checks, not reasons to ignore the source-level fixes above.

The launch gate also checks the business phone and enterprise/registration number before live checkout is allowed.
