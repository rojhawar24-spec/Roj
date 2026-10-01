import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emailEnabled } from '../src/services/email.js';

const root = path.resolve(process.cwd());
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('checkout collects contact and delivery location and manager can see it', () => {
  const checkout = read('views/checkout.ejs');
  const order = read('views/admin/order.ejs');
  assert.match(checkout, /name="customerPhone"/);
  assert.match(checkout, /type="email"/);
  assert.match(checkout, /name="shippingAddress"/);
  assert.match(checkout, /name="shippingCity"/);
  assert.match(checkout, /name="shippingCountry"/);
  assert.match(order, /order\.customer_phone/);
  assert.match(order, /order\.shipping_address/);
  assert.match(order, /order\.shipping_city/);
  assert.match(order, /order\.shipping_country/);
});

test('AI is independently switchable from the manager UI', () => {
  const settings = read('views/admin/settings.ejs');
  const server = read('src/server.js');
  assert.match(settings, /name="aiEnabled"/);
  assert.match(server, /getSetting\('ai_enabled','0'\)/);
  assert.match(server, /setSetting\(key,value\)/);
  assert.match(server, /services\/ai\.js/);
});

test('layout has one main region and no inline styles under the strict CSP', () => {
  const allViews = [];
  const walk = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full); else if (item.name.endsWith('.ejs')) allViews.push(read(path.relative(root, full)));
    }
  };
  walk(path.join(root, 'views'));
  const joined = allViews.join('\n');
  assert.equal((joined.match(/<main\b[^>]*>/g)||[]).length, (joined.match(/<\/main>/g)||[]).length);
  assert.equal((joined.match(/\sstyle\s*=/g)||[]).length, 0);
});

test('database schema block contains only SQL and customer_phone migration runs outside it', () => {
  const source = read('src/db.js');
  const start = source.indexOf('db.exec(`');
  const end = source.indexOf('`);', start);
  assert.ok(start >= 0 && end > start);
  const schema = source.slice(start + 9, end);
  assert.equal(/(^|\n)\s*(const|if)\s+orderColumns\b/.test(schema), false);
  assert.equal(schema.includes('// Backward-compatible migration'), false);
  assert.match(source.slice(end), /const orderColumns = db\.prepare\("PRAGMA table_info\(orders\)"\)/);
});

test('preview page uses a self-contained relative stylesheet path', () => {
  const preview = read('PREVIEW.html');
  assert.doesNotMatch(preview, /file:\/\/\/mnt\/data\//);
  assert.match(preview, /href="\.\/public\/css\/style\.css\?v=2\.5\.0"/);
});

test('order status page does not render HTML through escaped text', () => {
  const success = read('views/success.ejs');
  for (const m of success.matchAll(/<%=([\s\S]*?)%>/g)) assert.doesNotMatch(m[1], /<strong>/);
  assert.match(success, /<strong><%= order\.status %><\/strong>/);
});

test('manager account has a direct manager and security entry point', () => {
  const account = read('views/account.ejs');
  assert.match(account, /user\.role==='admin'\|\|user\.role==='manager'/);
  assert.match(account, /href="\/admin"/);
  assert.match(account, /href="\/account\/security"/);
});


test('coupon expiry uses the configured store timezone instead of the Node host timezone', () => {
  const server = read('src/server.js');
  assert.match(server, /expiresAt=dateTimeLocalToISOString\(req\.body\.expiresAt,storeTimeZone\)/);
  assert.doesNotMatch(server, /expiresAt=safeDateOrNull\(req\.body\.expiresAt\)/);
});

test('mobile navigation has both the JS toggle and the CSS open-state', () => {
  const js = read('public/js/app.js');
  const css = read('public/css/style.css');
  assert.match(js, /nav\.classList\.toggle\('open'/);
  assert.match(css, /\.nav-links\.open\s*\{[\s\S]*display:\s*flex/);
});

test('checkout cancellation only immediately releases a pending reservation when no external payment session exists', () => {
  const server = read('src/server.js');
  assert.match(server, /if\(order\.status==='pending' && !order\.payment_reference\) cancelPendingOrder\(order\.id\)/);
});

test('dynamic mobile bottom navigation is excluded from checkout', () => {
  const footer = read('views/partials/footer.ejs');
  assert.match(footer, /!isAdminRoute && !isCheckoutRoute/);
});

test('frontend asset versions are consistent across the main shell and preview', () => {
  const header = read('views/partials/header.ejs');
  const footer = read('views/partials/footer.ejs');
  const preview = read('PREVIEW.html');
  assert.match(header, /style\.css\?v=2\.5\.0/);
  assert.match(footer, /app\.js\?v=2\.5\.0/);
  assert.match(preview, /style\.css\?v=2\.5\.0/);
});

test('all storefront date displays use the configured store timezone helper', () => {
  const stories = read('views/stories.ejs');
  assert.match(stories, /formatDateTimeDisplay\(s\.expires_at,storeTimeZone\)/);
  assert.doesNotMatch(stories, /toLocaleDateString/);
});

test('main shell provides a keyboard skip link and a stable main content target', () => {
  const header = read('views/partials/header.ejs');
  assert.match(header, /class="skip-link" href="#main-content"/);
  assert.match(header, /<main id="main-content">/);
});

test('manager navigation is semantic and marks the current section', () => {
  const pages = ['dashboard','products','product-form','categories','orders','order','stories','story-form','coupons','customers','audit','settings'];
  for (const page of pages) {
    const text = read(`views/admin/${page}.ejs`);
    assert.match(text, /aria-label="Store manager navigation"/);
    assert.match(text, /aria-current="page"/);
  }
});

test('product pages expose a breadcrumb trail for navigation context', () => {
  const product = read('views/product.ejs');
  assert.match(product, /class="breadcrumbs" aria-label="Breadcrumb"/);
  assert.match(product, /aria-current="page"/);
});

test('production audit uses store timezone-aware date helpers and positive product pricing', () => {
  const server = read('src/server.js');
  const security = read('src/security.js');
  const form = read('views/admin/product-form.ejs');
  assert.match(server, /dateTimeLocalToISOString\(req\.body\.saleStart,storeTimeZone\)/);
  assert.match(server, /price<=0/);
  assert.match(security, /export function dateTimeLocalToISOString/);
  assert.match(form, /min="0\.01"/);
});


test('automatic discount is persisted and controlled per product', () => {
  const db = read('src/db.js');
  const server = read('src/server.js');
  const form = read('views/admin/product-form.ejs');
  assert.match(db, /automatic_discount_percent INTEGER NOT NULL DEFAULT 0 CHECK\(automatic_discount_percent >= 0 AND automatic_discount_percent <= 90\)/);
  assert.match(db, /normalizeProductDiscountPercent/);
  assert.match(db, /applyPercentDiscountCents/);
  assert.match(server, /automaticDiscountPercent=Number\(req\.body\.automaticDiscountPercent\)/);
  assert.match(server, /automaticDiscountPercent:data\.automaticDiscountPercent/);
  assert.match(form, /name="automaticDiscountPercent"/);
  assert.match(form, /min="0" max="90" step="1" required/);
});

test('automatic item discounts are recorded separately and coupons never discount above the already reduced item subtotal', () => {
  const db = read('src/db.js');
  const payment = read('src/services/payment.js');
  const order = read('views/admin/order.ejs');
  assert.match(db, /automatic_discount_cents/);
  assert.match(db, /const discount = couponDiscount/);
  assert.match(db, /const total = subtotal - automaticDiscount - couponDiscount \+ safeShippingCents/);
  assert.match(payment, /discountCents/);
  assert.match(order, /order\.automatic_discount_cents/);
  assert.match(order, /order\.discount_cents/);
  assert.match(order, /Automatic product discounts/);
});

test('cart and checkout expose per-product automatic discounts transparently', () => {
  const cart = read('views/cart.ejs');
  const checkout = read('views/checkout.ejs');
  assert.match(cart, /automaticDiscountPercent/);
  assert.match(cart, /Automatic item discounts/);
  assert.match(checkout, /automaticDiscountPercent/);
  assert.match(checkout, /Automatic item discounts/);
});

test('automatic discount keeps product price ordering monotonic and uses the same server helper', () => {
  const db = read('src/db.js');
  assert.match(db, /available_price/);
  assert.match(db, /ORDER BY \$?\{order\}/);
  assert.match(db, /export function effectivePrice/);
  assert.match(db, /baseEffectivePrice\(product\)/);
});


test('canonical orders schema contains the automatic discount column and products contain the per-item discount control', () => {
  const db = read('src/db.js');
  const form = read('views/admin/product-form.ejs');
  assert.match(db, /automatic_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK\(automatic_discount_cents >= 0\)/);
  assert.match(db, /ALTER TABLE orders ADD COLUMN automatic_discount_cents INTEGER NOT NULL DEFAULT 0/);
  assert.match(db, /automatic_discount_percent INTEGER NOT NULL DEFAULT 0/);
  assert.match(form, /This setting applies only to this product/);
});


test('store settings no longer expose a storewide discount and product prices sort using the final per-item price', () => {
  const settings = read('views/admin/settings.ejs');
  const db = read('src/db.js');
  const header = read('views/partials/header.ejs');
  assert.doesNotMatch(settings, /STOREWIDE DISCOUNT|automaticDiscountPercent/);
  assert.doesNotMatch(header, /off every product/);
  assert.match(db, /availablePriceSql/);
  assert.match(db, /p\.automatic_discount_percent/);
});

test('product discount migration preserves the old storewide setting only once while moving future control to products', () => {
  const db = read('src/db.js');
  assert.match(db, /legacy_storewide_discount_migrated/);
  assert.match(db, /UPDATE products SET automatic_discount_percent/);
});

test('per-product discount is isolated: setting one product never creates a store-wide control', () => {
  const form = read('views/admin/product-form.ejs');
  const db = read('src/db.js');
  const server = read('src/server.js');
  const settings = read('views/admin/settings.ejs');
  assert.match(form, /name="automaticDiscountPercent"/);
  assert.match(db, /automatic_discount_percent/);
  assert.match(server, /automaticDiscountPercent:data\.automaticDiscountPercent/);
  assert.doesNotMatch(settings, /name="automaticDiscountPercent"/);
  assert.doesNotMatch(server, /getAutomaticDiscountPercent/);
});

test('live checkout is blocked until payment and required business identity/policies are configured', () => {
  const server = read('src/server.js');
  const settings = read('views/admin/settings.ejs');
  const checkout = read('views/checkout.ejs');
  assert.match(server, /supportEmail/);
  assert.match(server, /businessPhone/);
  assert.match(server, /enterpriseNumber/);
  assert.match(server, /privacy_policy/);
  assert.match(server, /terms_policy/);
  assert.match(server, /shipping_policy/);
  assert.match(server, /returns_policy/);
  assert.match(server, /stripeEnabled\(\)/);
  assert.match(settings, /name="businessPhone"/);
  assert.match(settings, /name="enterpriseNumber"/);
  assert.match(checkout, /Place order — payment required/);
});



test('production launch gate requires transactional email, tax-inclusive prices and a sellable product', () => {
  const server = read('src/server.js');
  const email = read('src/services/email.js');
  assert.match(server, /emailEnabled\(\)/);
  assert.match(server, /pricesIncludeTax/);
  assert.match(server, /sellableProductCount/);
  assert.match(server, /confirmation_email_sent_at/);
  assert.match(email, /api\.resend\.com\/emails/);
});

test('checkout cancellation never immediately cancels an order that already has an external payment session', () => {
  const server = read('src/server.js');
  assert.match(server, /order\.status==='pending' && !order\.payment_reference/);
  assert.match(server, /prior\.payment_reference/);
});

test('expired checkout idempotency orders are cancelled before the same token can create a fresh order', () => {
  const server = read('src/server.js');
  assert.match(server, /const reservationExpired=prior\.status==='pending' && prior\.reservation_expires_at/);
  assert.match(server, /if\(reservationExpired\)\{\s*cancelPendingOrder\(prior\.id\);\s*prior=null;/);
});

test('retrying an existing pending checkout cannot redirect to an unlinked newly-created payment session', () => {
  const server = read('src/server.js');
  assert.match(server, /if\(!saveCheckoutSession\(existing\.id,checkout\.id,checkout\.url\)\)/);
  assert.match(server, /fresh\?\.status==='pending' && fresh\.payment_url/);
});

test('paid webhook only sends confirmations for paid-like order states', () => {
  const server = read('src/server.js');
  assert.match(server, /\['paid','processing','shipped','completed'\]\.includes\(paidOrder\.status\)/);
});

test('admin audit navigation marks Audit instead of Stories', () => {
  const audit = read('views/admin/audit.ejs');
  assert.match(audit, /<a class="active" aria-current="page" href="\/admin\/audit">Audit<\/a>/);
  assert.doesNotMatch(audit, /class="active"[^>]*href="\/admin\/stories"/);
});

test('product preview currency is not hard-coded to euro', () => {
  const form = read('views/admin/product-form.ejs');
  const js = read('public/js/app.js');
  assert.match(form, /data-shop-currency="<%= currency %>"/);
  assert.doesNotMatch(js, /Final customer price preview: €/);
  assert.match(js, /Intl\.NumberFormat\('en-GB', \{ style:'currency', currency \}\)/);
});

test('product and story images reserve layout space for lower CLS', () => {
  const product = read('views/product.ejs');
  const stories = read('views/stories.ejs');
  const home = read('views/home.ejs');
  assert.match(product, /width="800" height="1000"/);
  assert.match(stories, /width="800" height="600"/);
  assert.match(home, /fetchpriority="high"/);
});

test('order detail names automatic product discounts explicitly', () => {
  const order = read('views/order.ejs');
  assert.match(order, /Automatic product discounts/);
  assert.doesNotMatch(order, /Automatic store discount/);
});

test('database startup declares the settings upsert before any migration can use it', () => {
  const db = read('src/db.js');
  const declaration = db.indexOf("const upsertSetting = db.prepare('INSERT INTO settings");
  assert.ok(declaration > 0);
  assert.ok(db.indexOf('upsertSetting.run', declaration + 1) > declaration);
  const migrationUse = db.indexOf("upsertSetting.run('prices_include_tax'", 0);
  assert.ok(migrationUse > declaration);
});

test('homepage hero uses real catalog data instead of a fixed demo product', () => {
  const home = read('views/home.ejs');
  assert.match(home, /const heroProduct = products\?\.\[0\]/);
  assert.match(home, /safeImageUrl\(heroProduct\.image_url\)/);
  assert.match(home, /href="\/product\/<%= heroProduct\.slug %>"/);
  assert.doesNotMatch(home, /src="\/assets\/product-1\.svg" alt="Featured product"/);
});

test('manager currency is selected from the server allow-list', () => {
  const settings = read('views/admin/settings.ejs');
  const server = read('src/server.js');
  assert.match(settings, /name="currency"/);
  assert.match(settings, /availableCurrencies/);
  assert.match(server, /availableCurrencies:STRIPE_TWO_DECIMAL_CURRENCIES/);
  assert.doesNotMatch(settings, /pattern="\[A-Za-z\]\{3\}"/);
});

test('product forms always receive the configured display currency', () => {
  const server = read('src/server.js');
  assert.match(server, /admin\/product-form'.*currency:getSetting\('currency','EUR'\)/);
});

test('email sender validation rejects malformed mailbox syntax', async () => {
  const prev={key:process.env.RESEND_API_KEY,from:process.env.EMAIL_FROM};
  process.env.RESEND_API_KEY='re_test';
  process.env.EMAIL_FROM='Shop <bad>';
  assert.equal(emailEnabled(),false);
  process.env.EMAIL_FROM='Shop <orders@example.com>';
  assert.equal(emailEnabled(),true);
  if(prev.key===undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY=prev.key;
  if(prev.from===undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM=prev.from;
});

test('configured currency allow-list excludes zero-decimal HUF and has explicit Stripe minimum checks', () => {
  const security = read('src/security.js');
  const payment = read('src/services/payment.js');
  assert.doesNotMatch(security, /'HUF'/);
  assert.doesNotMatch(payment, /HUF:/);
  assert.match(payment, /STRIPE_MINIMUM_CENTS/);
  assert.match(payment, /amountCents < minimumCents/);
});

test('homepage always has a catalog fallback when no product is marked featured', () => {
  const server = read('src/server.js');
  assert.match(server, /const featuredProducts=listProducts/);
  assert.match(server, /const products=featuredProducts\.length \? featuredProducts : listProducts/);
});
