# Optional AI integration

The webshop core does not depend on AI. The integration is isolated in `src/services/ai.js`.

## Enable
1. Set `AI_ENABLED=true`.
2. Set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` on the server.
3. In Manager → Settings, turn on **AI shopping assistant**.

## Disable
Turn off the manager switch. The core storefront, search, cart, checkout, orders, products and admin continue to work without AI.

## Remove completely
Delete `src/services/ai.js`. The server treats the missing module as an optional integration and the rest of the webshop continues to run. Also remove unused `AI_*` environment variables from the deployment platform.

## Security
- API credentials never go to the browser.
- Requests are rate-limited.
- Input and output lengths are capped.
- Provider calls have a timeout.
- The AI receives catalog data as data, not executable instructions.
- AI output is never trusted for price, stock, payment, authorization, discounts or order state.
