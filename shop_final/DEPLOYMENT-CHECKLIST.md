# Real-Sale Launch Checklist

Use this checklist before accepting your first real customer payment.

## 1. Hosting

- Use a trusted HTTPS deployment.
- Set `BASE_URL` to the exact public HTTPS origin, without a trailing slash.
- If a trusted reverse proxy is in front of Node, set `TRUST_PROXY=1`; otherwise keep `0`.
- Keep `data/` and `public/uploads/` on durable storage.
- Keep application logs and backups outside the public web root.

## 2. Secrets

- Set a unique production `ADMIN_EMAIL`.
- Set a unique production `ADMIN_PASSWORD` (12–200 characters; never use the example value).
- Keep `.env` outside source control.
- Never put Stripe or AI API keys into browser JavaScript.

## 3. Payments

- Configure Stripe live keys only in the server environment.
- Configure and verify the Stripe webhook signature secret.
- Point the Stripe webhook to `/webhooks/stripe`.
- Test the complete lifecycle in Stripe test mode first.
- Verify successful payment, failed payment, expired checkout, refresh/retry, and duplicate-submit behavior.
- Only then switch to live keys.

## 4. Store settings

In `/admin/settings`, complete:

- Store name
- Legal/business name
- Business address
- Support email
- Business phone
- Enterprise/registration number
- VAT number (if applicable)
- Currency
- Shipping fee
- Privacy policy
- Terms & conditions
- Shipping policy
- Returns/refunds policy

Then verify that the dashboard reports the store as launch-ready.

## 5. Business/legal configuration

Configure the actual rules for the business and sales markets, including VAT/tax handling, invoicing, delivery, returns/refunds and customer-rights wording. Do not copy generic legal text blindly.

## 6. Products

Create real products through the manager dashboard and verify:

- Name and SKU
- Images
- Price
- Optional sale price and sale dates
- Stock
- Category
- Visibility
- Product page
- Search result
- Cart total
- Checkout total

Test at least one sale-price product and one out-of-stock product.

## 7. Coupons

Create a real coupon and test:

- Valid code
- Invalid code
- Minimum subtotal
- Expired code
- Percent discount
- Fixed discount
- Checkout total after discount

Confirm the discount survives the cart redirect and reaches checkout correctly.

## 8. AI (optional)

Leave AI disabled unless it is needed.

To enable it, set:

- `AI_ENABLED=true`
- `AI_BASE_URL=https://...`
- `AI_API_KEY=...`
- `AI_MODEL=...`

The adapter expects an OpenAI-compatible `/chat/completions` endpoint.

To remove AI, unset the AI environment values and remove `src/services/ai.js`. The core shop does not depend on the AI module.

## 9. Final security checks

After installing dependencies in the deployment environment, run:

```bash
npm run audit
npm audit
```

Then run the real app and the included load test against the installed deployment:

```bash
BASE_URL=https://your-store.example LOAD_CLIENTS=50 LOAD_ROUNDS=10 npm run load:local
```

Inspect the returned status/error counts and latency before launch.

## 10. Operational readiness

Set up monitoring, backups and a way to rotate secrets. For multiple application instances or significantly larger traffic, move rate limiting/session state to a shared store and use a managed database instead of depending on one local SQLite file.

## 11. Release 2.5.0 checks
- Confirm `STORE_TIMEZONE` matches the business operating timezone.
- Open `PREVIEW.html` from a local HTTP server or the deployed site and confirm the stylesheet/images load without editing paths.
- Sign in with the manager account, open Account → Account security, then open Manager.
- Test the mobile menu at narrow widths and confirm it opens, closes with Escape, and closes after navigation.
- Cancel a Stripe Checkout session and confirm the pending reservation is released immediately.
- Verify coupon expiry and story expiry display/use the configured `STORE_TIMEZONE`.
- Confirm the optional AI switch is off by default and only activates after explicit manager enablement.
- Verify an existing product with a sale window shows the expected local date/time in the manager form.

## 12. Per-product automatic discount
- Open Manager → Products → Edit.
- Set **Automatic discount %** to a whole number from 0 to 90.
- `0%` means disabled; 1–90% applies only to that product, for every customer.
- Verify cart and checkout show the correct product-level discount and the correct final total.
- Verify a second product without a discount keeps its normal price.
- Verify the automatic discount and coupon discount remain separate in the manager order detail.

The launch gate also checks the business phone and enterprise/registration number before live checkout is allowed.


## 13. Final technical verification
- `npm run audit` completed with 57/57 automated tests passing in the source environment.
- Do not interpret that as proof of live Stripe/email/browser delivery: those integrations still need a real deployment test after dependencies are installed.
- The included `final-audit-output.txt` records the exact source-environment audit output.
