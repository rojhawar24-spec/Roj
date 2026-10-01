# Security hardening notes

## Built in

- Helmet security headers and restrictive CSP
- Server-side CSRF verification for state-changing requests, including the AI endpoint
- Opaque random server-side sessions in SQLite
- HttpOnly + SameSite cookies and Secure cookies in production
- Session rotation on login/logout
- Login and AI rate limits
- Server-side manager authorization
- Server-side validation of prices, discounts, quantities and inventory
- Stock reservation during external payment and automatic release on expiry/failure
- Stripe webhook HMAC verification with timestamp tolerance
- No card data stored by the application
- Safe same-origin redirects
- Upload size and signature checks
- Safe external image/link handling (HTTPS only)
- Audit trail for important manager actions
- Generic customer-facing errors
- No secret values in frontend bundles

## Still required before launch

- HTTPS and secure reverse-proxy configuration
- Unique production admin credentials
- Secret rotation procedure
- Persistent database storage and tested backups
- Durable object storage for media where required
- Transactional email and account recovery flow
- VAT, tax, invoice and consumer-law configuration for your jurisdiction
- Privacy/cookie consent implementation where legally required
- Monitoring, alerting and restore drills
- External security review / DAST / dependency scanning
- Staging payment + webhook tests for every supported payment state


## Added hardening in this revision

- Protocol-relative URLs (`//host`) and backslash-based URL tricks are rejected.
- Login redirect targets are limited to safe local paths.
- Customer checkout email is taken from the authenticated account rather than trusted form input.
- Checkout requires a country code and explicit acceptance of the configured terms.
- Orders store the shipping country and terms acceptance timestamp.
- Storefront and admin product listings are bounded instead of rendering unbounded catalog sizes.
- Dashboard metrics use aggregate SQL queries rather than loading the entire order/customer tables into memory.
- Coupon attempts use a dedicated, stricter rate limit.
- Node HTTP server request/header/keep-alive timeouts are configured and graceful shutdown closes the SQLite connection.
- Static security and local load-test scripts are included.


## Production hardening notes
- Checkout reservation time is configurable with `CHECKOUT_RESERVATION_MINUTES` and is passed to Stripe Checkout as the Session `expires_at`, keeping stock reservation lifetime aligned with the hosted payment session.
- The login verifier uses a bounded scrypt work factor and a dummy hash for unknown users to reduce credential-enumeration timing differences.
- The optional AI integration is server-side only and can be disabled without making the core webshop depend on an AI provider.
- Rate limiting uses the package's in-memory store; multi-instance deployments should use a shared rate-limit store appropriate for the hosting architecture.

## Release 2.5.0 hardening
- Fixed the database bootstrap schema so the legacy `customer_phone` migration is executed as JavaScript after the schema transaction, not accidentally embedded inside the SQLite SQL block.
- Store-manager date/time inputs are converted using `STORE_TIMEZONE` (default `Europe/Brussels`) instead of silently depending on the Node host timezone.
- Non-positive product prices and sale prices are rejected to prevent zero-total products from reaching checkout.
- Stale/missing manager edit IDs now fail instead of being reported as successful updates.
- A leaked idempotency token can no longer cancel another customer's pending reservation.
- Unsupported uploaded image MIME types return a clear validation error.
- Production session cookies use the `__Host-` prefix with Secure/HttpOnly/SameSite protections.
- Optional AI is disabled by default until explicitly enabled by the manager.
- Customer-cancelled pending checkout reservations are released immediately rather than waiting for expiry.
- Storefront story expiry displays use the configured store timezone.

The launch gate also checks the business phone and enterprise/registration number before live checkout is allowed.
