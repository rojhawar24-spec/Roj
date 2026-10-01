# Sales readiness — Universal Shop 2.5.0

## Technical status
The source-level release is hardened for deployment and the per-product discount feature is implemented. Each product has its own 0–90% automatic discount. A discount set on Product A does not change Product B. Cart, checkout, order storage and Stripe line items use the server-calculated product price.

Automated verification in this environment: 57/57 tests PASS, JavaScript syntax PASS, static audit PASS, and 28 EJS templates PASS.

## Not yet a claim of live-sale readiness
A real production launch still requires installed dependencies and real runtime/browser tests, Stripe test-mode and webhook tests, production HTTPS/reverse-proxy verification, backups/monitoring, transactional order confirmation on a durable medium, and the final VAT/tax/invoicing, shipping, returns, privacy/cookie and consumer-law configuration for the markets being served.

For Belgium, online sellers must provide required business identity, contact, product, total-price, delivery/payment and consumer-rights information before purchase. A price-reduction announcement also needs the legally correct reference price; the Belgian rule normally uses the lowest price applied through that sales channel during the previous 30 days.

The current build implements a durable order-confirmation email through the configured transactional provider. Delivery still needs to be verified in the real deployment before relying on it for real orders.


## Release 2.5.0 deep-fix status
The latest source audit added checkout retry/race protections, fixed the startup settings-upsert ordering bug, replaced the fixed demo hero with real catalog data, tightened currency and email configuration validation, and expanded automated coverage to 57 tests.
