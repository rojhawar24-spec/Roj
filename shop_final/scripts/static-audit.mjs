import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets=[];
const roots=['src','views','public'];
function walk(dir){
  for(const name of fs.readdirSync(dir)){
    const p=path.join(dir,name); const st=fs.statSync(p);
    if(st.isDirectory()) walk(p);
    else if(/\.(js|mjs|ejs|json|css)$/.test(name)) targets.push(p);
  }
}
for(const dir of roots) walk(path.join(root,dir));
const source=targets.map(p=>fs.readFileSync(p,'utf8')).join('\n');
const banned=[
  /\beval\s*\(/i,
  /new Function\s*\(/i,
  /innerHTML\s*=/i,
  /document\.cookie/i,
  /javascript:/i
];
for(const rx of banned) assert.equal(rx.test(source),false,`Static security pattern found: ${rx}`);
assert.equal(fs.existsSync(path.join(root,'.env')),false,'A real .env must never be shipped in the ZIP');
assert.equal(fs.existsSync(path.join(root,'data','shop.db')),false,'A local database must never be shipped in the ZIP');
assert.ok(source.includes('isSafeLocalPath'),'Local redirect validation must exist');
assert.ok(source.includes('Cache-Control'),'Sensitive routes must disable caching');
assert.ok(source.includes('verifyStripeSignature'),'Stripe webhook verification must exist');
assert.ok(source.includes('AI_ENABLED'),'AI must have an explicit feature toggle');
assert.ok(source.includes("error?.code === 'ERR_MODULE_NOT_FOUND'"),'Optional AI must fail loudly on real module errors and only tolerate the missing optional file');
assert.ok(source.includes('safeNavigationTarget'),'Login redirect target must be constrained');
assert.ok(source.includes('shipping_cents'),'Server-side shipping totals must exist');
assert.ok(source.includes('saveCheckoutSession'),'Stripe checkout sessions must be persisted for safe retries');
assert.ok(source.includes('Idempotency-Key'),'Stripe requests must use idempotency keys');
assert.ok(source.includes('liveKeyOk'),'Production Stripe must reject test-mode keys');
assert.match(source,/u\.hostname\s*!==\s*'checkout\.stripe\.com'/,'Persisted payment redirects must remain on the expected Stripe Checkout host');
assert.ok(source.includes("session?.client_reference_id"),'Stripe webhooks must bind to the expected order reference');
assert.ok(source.includes('reserved_stock'),'Stock reservation logic must exist');
assert.ok(source.includes("app.get('/health'"),'Health endpoint must exist');
assert.ok(source.includes('TRUST_PROXY'),'Trusted-proxy configuration must be explicit');
assert.ok(source.includes("ESCAPE '!'"),'Search inputs must escape SQL LIKE wildcards');
assert.ok(source.includes('wishlist'),'Wishlist support must exist');
assert.ok(source.includes('saveSessionCoupon'),'Session coupon persistence must exist');
assert.ok(source.includes('coupon_code'),'Session coupon storage must exist');
const schema=fs.readFileSync(path.join(root,'src','db.js'),'utf8');
assert.ok(schema.indexOf('payment_url') !== -1,'Orders must persist the provider checkout URL for safe retries');
assert.ok(schema.indexOf('CREATE TABLE IF NOT EXISTS order_items') < schema.indexOf('idx_order_items_order'),'order_items index must be created after the table');
assert.ok(schema.indexOf('CREATE TABLE IF NOT EXISTS audit_logs') < schema.indexOf('idx_audit_created'),'audit index must be created after the table');
assert.equal(schema.includes('CREATE TABLE IF NOT EXISTS product_variants'),false,'Unused partial variant feature should not be shipped');
console.log(`Static audit passed: ${targets.length} source/config files inspected.`);
