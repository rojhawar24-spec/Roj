import test from 'node:test';
import assert from 'node:assert/strict';
import { emailEnabled, sendOrderConfirmationEmail } from '../src/services/email.js';

test('email integration stays disabled until key and sender are configured', () => {
  const prev={key:process.env.RESEND_API_KEY,from:process.env.EMAIL_FROM};
  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
  assert.equal(emailEnabled(),false);
  process.env.RESEND_API_KEY='re_test'; process.env.EMAIL_FROM='Shop <orders@example.com>';
  assert.equal(emailEnabled(),true);
  if(prev.key===undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY=prev.key;
  if(prev.from===undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM=prev.from;
});

test('order confirmation uses a stable idempotency key and escapes customer content', async () => {
  const prev={key:process.env.RESEND_API_KEY,from:process.env.EMAIL_FROM,fetch:global.fetch};
  process.env.RESEND_API_KEY='re_test'; process.env.EMAIL_FROM='Shop <orders@example.com>';
  let captured;
  global.fetch=async (_url,options)=>{captured=options; return {ok:true,json:async()=>({id:'email_123'})};};
  const result=await sendOrderConfirmationEmail({
    order:{id:12,email:'buyer@example.com',currency:'EUR',items:[{product_name:'<script>alert(1)</script>',quantity:1,total_cents:1000}],subtotal_cents:1000,automatic_discount_cents:0,discount_cents:0,shipping_cents:0,total_cents:1000,shipping_name:'Buyer <x>',shipping_address:'Main 1',shipping_postal_code:'1000',shipping_city:'Brussels',shipping_country:'Belgium',customer_phone:'+32 400 00 00',payment_provider:'stripe'},
    store:{name:'Test Store',legalName:'Test Legal',businessAddress:'Street 1',supportEmail:'support@example.com',businessPhone:'+32 400 00 00',enterpriseNumber:'0123456789',vatNumber:'BE0123456789',baseUrl:'https://shop.example'}
  });
  assert.equal(result.sent,true);
  assert.equal(captured.headers['Idempotency-Key'],'order-confirmation-12');
  const body=JSON.parse(captured.body);
  assert.doesNotMatch(body.html,/<script>alert\(1\)<\/script>/);
  assert.match(body.html,/&lt;script&gt;/);
  global.fetch=prev.fetch;
  if(prev.key===undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY=prev.key;
  if(prev.from===undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM=prev.from;
});
