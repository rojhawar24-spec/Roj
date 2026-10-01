import crypto from 'node:crypto';

export class StripeProviderError extends Error {
  constructor(message, { ambiguous = false } = {}) {
    super(message);
    this.name = 'StripeProviderError';
    this.ambiguous = ambiguous;
  }
}

export function stripeEnabled() {
  const base=String(process.env.BASE_URL||'');
  const key=String(process.env.STRIPE_SECRET_KEY||'');
  const protocolOk=process.env.NODE_ENV!=='production' ? /^https?:\/\//i.test(base) : /^https:\/\//i.test(base);
  const liveKeyOk=process.env.NODE_ENV!=='production' || /^(sk|rk)_live_/i.test(key);
  return Boolean(key && protocolOk && liveKeyOk && process.env.STRIPE_WEBHOOK_SECRET);
}

const STRIPE_MINIMUM_CENTS = Object.freeze({EUR:50,USD:50,GBP:30,CHF:50,CAD:50,AUD:50,NZD:50,SEK:300,NOK:300,DKK:250,PLN:200,CZK:1500,RON:200});
export function stripeMinimumCents(currency) { return STRIPE_MINIMUM_CENTS[String(currency||'').toUpperCase()] || null; }

async function stripeRequest(path, params, idempotencyKey='') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    let response;
    try {
      response = await fetch(`https://api.stripe.com/v1/${path}`, {
        method:'POST',
        headers:{
          Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type':'application/x-www-form-urlencoded',
          ...(idempotencyKey ? {'Idempotency-Key':idempotencyKey} : {})
        },
        body:params,
        signal:controller.signal
      });
    } catch (error) {
      throw new StripeProviderError(error?.name === 'AbortError' ? 'STRIPE_TIMEOUT' : 'STRIPE_NETWORK', {ambiguous:true});
    }
    let data;
    try { data = await response.json(); } catch { throw new StripeProviderError('STRIPE_INVALID_RESPONSE', {ambiguous:true}); }
    if (!response.ok) throw new StripeProviderError(data?.error?.message || 'STRIPE_ERROR', {ambiguous:response.status >= 500});
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function createStripeCheckout({orderId, amountCents, discountCents=0, shippingCents=0, currency, email, items, reservationExpires}) {
  if (!stripeEnabled()) throw new Error('STRIPE_DISABLED');
  if (!Number.isInteger(orderId) || orderId < 1) throw new Error('INVALID_ORDER');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('INVALID_TOTAL');
  const minimumCents = stripeMinimumCents(currency);
  if (!minimumCents || amountCents < minimumCents) throw new Error('PAYMENT_MINIMUM');
  const params = new URLSearchParams();
  params.set('mode','payment');
  params.set('success_url',`${process.env.BASE_URL}/checkout/success?order=${encodeURIComponent(orderId)}`);
  params.set('cancel_url',`${process.env.BASE_URL}/checkout/cancel?order=${encodeURIComponent(orderId)}`);
  params.set('customer_email',email);
  params.set('metadata[order_id]',String(orderId));
  params.set('client_reference_id',String(orderId));
  params.set('payment_intent_data[metadata][order_id]',String(orderId));
  params.set('locale','en-GB');
  params.set('billing_address_collection','required');
  if(reservationExpires){
    const expiresAt=Math.floor(new Date(reservationExpires).getTime()/1000);
    const now=Math.floor(Date.now()/1000);
    if(Number.isInteger(expiresAt) && expiresAt>=now+30*60 && expiresAt<=now+24*60*60) params.set('expires_at',String(expiresAt));
    else throw new Error('INVALID_CHECKOUT_EXPIRY');
  }
  params.set('allow_promotion_codes','false');
  items.forEach((item,index)=>{
    params.set(`line_items[${index}][price_data][currency]`,currency.toLowerCase());
    params.set(`line_items[${index}][price_data][product_data][name]`,item.product.name);
    params.set(`line_items[${index}][price_data][unit_amount]`,String(item.unit));
    params.set(`line_items[${index}][quantity]`,String(item.quantity));
  });
  if(shippingCents>0){
    const index=items.length;
    params.set(`line_items[${index}][price_data][currency]`,currency.toLowerCase());
    params.set(`line_items[${index}][price_data][product_data][name]`,'Shipping');
    params.set(`line_items[${index}][price_data][unit_amount]`,String(shippingCents));
    params.set(`line_items[${index}][quantity]`,'1');
  }
  if (discountCents > 0) {
    const couponParams = new URLSearchParams();
    couponParams.set('duration','once');
    couponParams.set('amount_off',String(discountCents));
    couponParams.set('currency',currency.toLowerCase());
    couponParams.set('max_redemptions','1');
    couponParams.set('name',`Order #${orderId} discount`);
    const coupon = await stripeRequest('coupons',couponParams,`coupon-${orderId}`);
    params.set('discounts[0][coupon]',coupon.id);
  }
  const session = await stripeRequest('checkout/sessions',params,`checkout-${orderId}`);
  if(!session?.url || !session?.id) throw new StripeProviderError('STRIPE_MISSING_SESSION_DATA', {ambiguous:false});
  let checkoutUrl;
  try {
    const u = new URL(String(session.url));
    if (u.protocol !== 'https:' || u.hostname !== 'checkout.stripe.com' || u.username || u.password) throw new Error('bad checkout host');
    checkoutUrl = u.toString();
  } catch {
    throw new StripeProviderError('STRIPE_INVALID_CHECKOUT_URL', {ambiguous:false});
  }
  return {id:String(session.id),url:checkoutUrl};
}

export function verifyStripeSignature(payload, signature, secret, toleranceSeconds=300) {
  if (!payload || !signature || !secret) return false;
  const timestamp = signature.split(',').find(x=>x.startsWith('t='))?.slice(2);
  const signatures = signature.split(',').filter(x=>x.startsWith('v1=')).map(x=>x.slice(3));
  if (!timestamp || signatures.length===0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now()/1000-ts)>toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256',secret).update(`${timestamp}.${payload}`,'utf8').digest('hex');
  return signatures.some(sig=>sig.length===expected.length && crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)));
}
