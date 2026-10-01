# Manager Guide

## Add a product
Manager → Products → Add product. Fill in name, SKU, category, regular price and stock. Add an image.

### Add a product discount
Inside the same product form, use **Sale price** for a scheduled sale and **Automatic discount %** for an additional per-product discount. Optionally set **Sale starts** and **Sale ends**. Save. The storefront shows the final lower price when the rules are active.

### Add a coupon
Manager → Discounts → Create coupon. Choose Percentage or Fixed amount, set the value, optional minimum order and optional expiry, then activate it.

### Add a story
Manager → Stories → Create story. Add title, text, image, publication date, expiry date and optionally attach a product.

### Manage an order
Manager → Orders → open an order. The manager can see:
- customer email
- customer phone
- customer name
- full delivery address
- city/postal code/country
- customer note
- purchased items
- verified server-side total
- payment reference when available
Then move the order through the allowed fulfilment states.

### AI
Manager → Settings → Optional AI.
The switch controls the feature only when the server-side AI provider is configured. The API key is never shown in the browser. To remove AI completely, delete `src/services/ai.js` and remove the `AI_*` environment variables.


## Per-product automatic discount
In **Products → Edit**, set **Automatic discount %** from 0–90%. This percentage applies **only to that product**, for every customer. Set it to **0%** to disable it. The server recalculates it at checkout and records the automatic discount separately from any coupon discount.

The launch gate also checks the business phone and enterprise/registration number before live checkout is allowed.
