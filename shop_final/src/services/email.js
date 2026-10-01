function validMailbox(value) {
  const s=String(value||'').trim();
  if(/[\r\n]/.test(s)) return false;
  return /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(s) || /^[^<>]{1,120}<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(s);
}

function enabled() {
  const key=String(process.env.RESEND_API_KEY||'').trim();
  const from=String(process.env.EMAIL_FROM||'').trim();
  return Boolean(key && validMailbox(from));
}

function esc(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function money(cents,currency='EUR') {
  try { return new Intl.NumberFormat('en-GB',{style:'currency',currency}).format(Number(cents||0)/100); }
  catch { return `${Number(cents||0)/100} ${currency}`; }
}

export function emailEnabled() { return enabled(); }

export async function sendOrderConfirmationEmail({order,store}) {
  if (!enabled()) return {sent:false,skipped:true};
  if (!order?.id || !order?.email) throw new Error('EMAIL_INVALID_ORDER');
  const currency=String(order.currency||'EUR').toUpperCase();
  const itemRows=(order.items||[]).map(item=>`
    <tr><td style="padding:10px 0;border-bottom:1px solid #e6eaf0">${esc(item.product_name)} × ${esc(item.quantity)}</td><td style="padding:10px 0;border-bottom:1px solid #e6eaf0;text-align:right"><strong>${esc(money(item.total_cents,currency))}</strong></td></tr>
  `).join('');
  const address=[order.shipping_name,order.shipping_address,`${order.shipping_postal_code} ${order.shipping_city}`,order.shipping_country].filter(Boolean).map(esc).join('<br>');
  const subject=`Order #${order.id} · ${store.name}`;
  const html=`<!doctype html><html><body style="margin:0;background:#f6f8fb;font-family:Arial,Helvetica,sans-serif;color:#0b1220"><div style="max-width:680px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border:1px solid #e6eaf0;border-radius:18px;padding:26px"><p style="margin:0 0 8px;color:#16785b;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em">Order confirmation</p><h1 style="margin:0 0 10px;font-size:30px">Thank you for your order.</h1><p style="color:#667085">Order #${esc(order.id)} · ${esc(store.name)}</p><table style="width:100%;border-collapse:collapse;margin:22px 0">${itemRows}</table><div style="border-top:1px solid #e6eaf0;padding-top:14px"><p><strong>Items subtotal:</strong> ${esc(money(order.subtotal_cents,currency))}</p>${Number(order.automatic_discount_cents||0)>0?`<p><strong>Product discounts:</strong> -${esc(money(order.automatic_discount_cents,currency))}</p>`:''}${Number(order.discount_cents||0)>0?`<p><strong>Coupon:</strong> -${esc(money(order.discount_cents,currency))}</p>`:''}<p><strong>Shipping:</strong> ${Number(order.shipping_cents||0)===0?'Free':esc(money(order.shipping_cents,currency))}</p><p style="font-size:20px"><strong>Total:</strong> ${esc(money(order.total_cents,currency))}</p></div><div style="border-top:1px solid #e6eaf0;margin-top:22px;padding-top:18px"><h2 style="font-size:16px">Delivery</h2><p style="line-height:1.6">${address}</p><p>Phone: ${esc(order.customer_phone)}</p><p>Payment: ${esc(order.payment_provider)}</p></div><div style="border-top:1px solid #e6eaf0;margin-top:22px;padding-top:18px"><h2 style="font-size:16px">Store information</h2><p style="line-height:1.6">${esc(store.legalName)}<br>${esc(store.businessAddress)}<br>${esc(store.supportEmail)} · ${esc(store.businessPhone)}<br>Registration: ${esc(store.enterpriseNumber)}${store.vatNumber?`<br>VAT: ${esc(store.vatNumber)}`:''}</p><p style="font-size:12px;color:#667085">Terms: ${esc(store.baseUrl)}/terms · Shipping & returns: ${esc(store.baseUrl)}/shipping-returns · Privacy: ${esc(store.baseUrl)}/privacy</p></div></div></div></body></html>`;
  const text=[
    `Order confirmation #${order.id}`,
    `Store: ${store.name}`,
    '',
    ...(order.items||[]).map(item=>`${item.product_name} x ${item.quantity}: ${money(item.total_cents,currency)}`),
    '',
    `Items subtotal: ${money(order.subtotal_cents,currency)}`,
    Number(order.automatic_discount_cents||0)>0?`Product discounts: -${money(order.automatic_discount_cents,currency)}`:'',
    Number(order.discount_cents||0)>0?`Coupon: -${money(order.discount_cents,currency)}`:'',
    `Shipping: ${Number(order.shipping_cents||0)===0?'Free':money(order.shipping_cents,currency)}`,
    `Total: ${money(order.total_cents,currency)}`,
    '',
    'Delivery:',
    order.shipping_name, order.shipping_address, `${order.shipping_postal_code} ${order.shipping_city}`, order.shipping_country,
    `Phone: ${order.customer_phone}`,
    `Payment: ${order.payment_provider}`,
    '',
    `Business: ${store.legalName}`,
    `Address: ${store.businessAddress}`,
    `Email: ${store.supportEmail}`,
    `Phone: ${store.businessPhone}`,
    `Registration: ${store.enterpriseNumber}`,
    ...(store.vatNumber?[`VAT: ${store.vatNumber}`]:[]),
    `Terms: ${store.baseUrl}/terms`,
    `Shipping & returns: ${store.baseUrl}/shipping-returns`,
    `Privacy: ${store.baseUrl}/privacy`,
  ].filter(Boolean).join('\n');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`order-confirmation-${order.id}`},
      body:JSON.stringify({from:String(process.env.EMAIL_FROM).trim(),to:[String(order.email).trim()],subject,html,text}),
      signal:controller.signal
    });
    if(!response.ok) throw new Error(`EMAIL_PROVIDER_${response.status}`);
    const data=await response.json();
    return {sent:true,id:data?.id?String(data.id):null};
  } finally { clearTimeout(timer); }
}
