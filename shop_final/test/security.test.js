import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { moneyCents, isSafeUrl, isSafeLocalPath, assertUploadSignature, isStrongEnoughPassword, isValidCurrency, dateTimeLocalToISOString, formatDateTimeLocal } from '../src/security.js';
import { verifyStripeSignature, stripeEnabled, createStripeCheckout, StripeProviderError } from '../src/services/payment.js';
let aiModule = null;
try { aiModule = await import('../src/services/ai.js'); }
catch (error) {
  if (!(error?.code === 'ERR_MODULE_NOT_FOUND' && String(error?.message || '').includes('src/services/ai.js'))) throw error;
}


test('moneyCents handles euro-style input safely', () => {
  assert.equal(moneyCents('12.50'), 1250);
  assert.equal(moneyCents('12,50'), 1250);
  assert.equal(moneyCents('12.999'), null);
  assert.equal(moneyCents('-5'), null);
});

test('URL validation blocks protocol-relative, javascript and insecure URLs', () => {
  assert.equal(isSafeUrl('/shop'), true);
  assert.equal(isSafeUrl('/product/item?x=1'), true);
  assert.equal(isSafeUrl('//evil.example'), false);
  assert.equal(isSafeUrl('/\\\\evil.example'), false);
  assert.equal(isSafeUrl('https://example.com'), true);
  assert.equal(isSafeUrl('https://'), false);
  assert.equal(isSafeUrl('https://user:pass@example.com'), false);
  assert.equal(isSafeUrl('http://example.com'), false);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeLocalPath('/account?x=1'), true);
  assert.equal(isSafeLocalPath('//evil.example'), false);
  assert.equal(isSafeLocalPath('https://evil.example'), false);
});

test('upload signatures match their declared MIME type', () => {
  assert.equal(assertUploadSignature(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), 'image/png'), true);
  assert.equal(assertUploadSignature(Buffer.from('<script>alert(1)</script>'), 'image/png'), false);
});

test('password and checkout country policy helpers are explicit', () => {
  assert.equal(isStrongEnoughPassword('short'), false);
  assert.equal(isStrongEnoughPassword('A-secure-password-1234'), true);
});

test('Stripe signatures reject tampering and stale timestamps', () => {
  const secret='whsec_test_secret';
  const payload='{}';
  const timestamp=Math.floor(Date.now()/1000);
  const signature=crypto.createHmac('sha256',secret).update(`${timestamp}.${payload}`).digest('hex');
  assert.equal(verifyStripeSignature(payload,`t=${timestamp},v1=${signature}`,secret),true);
  assert.equal(verifyStripeSignature('{"tampered":true}',`t=${timestamp},v1=${signature}`,secret),false);
  const stale=timestamp-301;
  const staleSig=crypto.createHmac('sha256',secret).update(`${stale}.${payload}`).digest('hex');
  assert.equal(verifyStripeSignature(payload,`t=${stale},v1=${staleSig}`,secret),false);
});


test('AI feature stays optional and disabled without provider configuration', () => {
  if (!aiModule) { assert.equal(aiModule, null); return; }
  const previous={node:process.env.NODE_ENV,enabled:process.env.AI_ENABLED,base:process.env.AI_BASE_URL,key:process.env.AI_API_KEY,model:process.env.AI_MODEL};
  delete process.env.AI_ENABLED; delete process.env.AI_BASE_URL; delete process.env.AI_API_KEY; delete process.env.AI_MODEL;
  assert.equal(aiModule?.aiEnabled?.() ?? false,false);
  process.env.AI_ENABLED='true';
  assert.equal(aiModule?.aiEnabled?.() ?? false,false);
  process.env.AI_BASE_URL='https://ai.example.com'; process.env.AI_API_KEY='test'; process.env.AI_MODEL='model';
  assert.equal(aiModule?.aiEnabled?.() ?? false,true);
  process.env.NODE_ENV='production'; process.env.AI_BASE_URL='http://ai.example.com';
  assert.equal(aiModule?.aiEnabled?.() ?? false,false);
  if(previous.enabled===undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED=previous.enabled;
  if(previous.base===undefined) delete process.env.AI_BASE_URL; else process.env.AI_BASE_URL=previous.base;
  if(previous.key===undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY=previous.key;
  if(previous.model===undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL=previous.model;
  if(previous.node===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous.node;
});

test('Stripe is never enabled with a non-HTTPS production base URL', () => {
  const previous={node:process.env.NODE_ENV,base:process.env.BASE_URL,key:process.env.STRIPE_SECRET_KEY,webhook:process.env.STRIPE_WEBHOOK_SECRET};
  process.env.NODE_ENV='production'; process.env.BASE_URL='http://shop.example'; process.env.STRIPE_SECRET_KEY='sk_test'; process.env.STRIPE_WEBHOOK_SECRET='whsec';
  assert.equal(stripeEnabled(),false);
  process.env.BASE_URL='https://shop.example'; process.env.STRIPE_SECRET_KEY='sk_live_test';
  assert.equal(stripeEnabled(),true);
  if(previous.node===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous.node;
  if(previous.base===undefined) delete process.env.BASE_URL; else process.env.BASE_URL=previous.base;
  if(previous.key===undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY=previous.key;
  if(previous.webhook===undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET=previous.webhook;
});


test('currency validation rejects malformed or unsupported display currencies', () => {
  assert.equal(isValidCurrency('EUR'), true);
  assert.equal(isValidCurrency('USD'), true);
  assert.equal(isValidCurrency('EURO'), false);
  assert.equal(isValidCurrency('ZZZ'), false);
});


test('Stripe checkout uses deterministic idempotency and preserves ambiguous network errors', async () => {
  const previous={node:process.env.NODE_ENV,base:process.env.BASE_URL,key:process.env.STRIPE_SECRET_KEY,webhook:process.env.STRIPE_WEBHOOK_SECRET,fetch:global.fetch};
  process.env.NODE_ENV='production'; process.env.BASE_URL='https://shop.example'; process.env.STRIPE_SECRET_KEY='sk_live_test'; process.env.STRIPE_WEBHOOK_SECRET='whsec';
  const headers=[];
  global.fetch=async (url,options={})=>{ headers.push(options.headers); return {ok:true,json:async()=>({id:'cs_test_123',url:'https://checkout.stripe.com/c/pay/test'})}; };
  const result=await createStripeCheckout({orderId:42,amountCents:1000,currency:'EUR',email:'buyer@example.com',items:[{product:{name:'Test'},quantity:1,unit:1000}],reservationExpires:new Date(Date.now()+45*60*1000).toISOString()});
  assert.equal(result.id,'cs_test_123');
  assert.equal(result.url,'https://checkout.stripe.com/c/pay/test');
  assert.ok(headers.some(h=>h['Idempotency-Key']==='checkout-42'));
  global.fetch=async()=>({ok:true,json:async()=>({id:'cs_test_bad',url:'https://evil.example/c/pay/test'})});
  await assert.rejects(()=>createStripeCheckout({orderId:43,amountCents:1000,currency:'EUR',email:'buyer@example.com',items:[{product:{name:'Test'},quantity:1,unit:1000}],reservationExpires:new Date(Date.now()+45*60*1000).toISOString()}),e=>e instanceof StripeProviderError && e.ambiguous===false && e.message==='STRIPE_INVALID_CHECKOUT_URL');
  global.fetch=async()=>({ok:false,status:503,json:async()=>({error:{message:'temporary provider outage'}})});
  await assert.rejects(()=>createStripeCheckout({orderId:42,amountCents:1000,currency:'EUR',email:'buyer@example.com',items:[{product:{name:'Test'},quantity:1,unit:1000}],reservationExpires:new Date(Date.now()+45*60*1000).toISOString()}),e=>e instanceof StripeProviderError && e.ambiguous===true);
  global.fetch=async()=>{ throw new TypeError('network'); };
  await assert.rejects(()=>createStripeCheckout({orderId:42,amountCents:1000,currency:'EUR',email:'buyer@example.com',items:[{product:{name:'Test'},quantity:1,unit:1000}],reservationExpires:new Date(Date.now()+45*60*1000).toISOString()}),e=>e instanceof StripeProviderError && e.ambiguous===true);
  global.fetch=previous.fetch;
  if(previous.node===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous.node;
  if(previous.base===undefined) delete process.env.BASE_URL; else process.env.BASE_URL=previous.base;
  if(previous.key===undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY=previous.key;
  if(previous.webhook===undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET=previous.webhook;
});


test('store timezone conversion round-trips across standard and daylight time', () => {
  for (const value of ['2026-01-15T12:30','2026-07-15T12:30']) {
    const iso = dateTimeLocalToISOString(value, 'Europe/Brussels');
    assert.ok(iso);
    assert.equal(formatDateTimeLocal(iso, 'Europe/Brussels'), value);
  }
});
