import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import db, { cleanupSessions, releaseExpiredReservations, getSetting, setSetting, baseEffectivePrice, effectivePrice as dbEffectivePrice, listCategories, createCategory, updateCategory, deleteCategory, listProducts, countProducts, getProductBySlug, getProductById, getActiveStories, listStories, getStory, listCoupons, getCoupon, getCouponById, createAudit, listAuditLogs, listOrders, countOrders, getOrder, listUserOrders, getOrderByClientToken, createOrderAtomic, markOrderPaid, cancelPendingOrder, saveCheckoutSession, saveSessionCart, saveSessionCoupon, createUser, setOrderStatus, saveSessionWishlist, markConfirmationEmailSent, adminCreateOrUpdateProduct, deleteProduct, adminCreateOrUpdateStory, deleteStory, adminCreateOrUpdateCoupon, deleteCoupon, listCustomers, countCustomers, getDashboardStats, getUserAuthByEmail, updateUserPassword, destroyUserSessionsExcept } from './db.js';
import { getRow } from './database.js';
import { attachAuth, authenticate, hashPassword, verifyPassword, login, logout, requireAuth, requireManager } from './auth.js';
import { csrfToken, verifyCsrf, cleanText, validId, moneyCents, formatDateTimeLocal, formatDateTimeDisplay, dateTimeLocalToISOString, isSafeUrl, isSafeLocalPath, assertUploadSignature, isValidCurrency, STRIPE_TWO_DECIMAL_CURRENCIES, isStrongEnoughPassword } from './security.js';
let aiService = null;
try { aiService = await import('./services/ai.js'); } catch (error) {
  if (!(error?.code === 'ERR_MODULE_NOT_FOUND' && String(error?.message || '').includes('services/ai.js'))) throw error;
}
import { stripeEnabled, createStripeCheckout, verifyStripeSignature } from './services/payment.js';
import { emailEnabled, sendOrderConfirmationEmail } from './services/email.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname,'..');
const app = express();
app.set('view engine','ejs');
app.set('views',path.join(root,'views'));
app.disable('x-powered-by');

const isProd = process.env.NODE_ENV === 'production';
const trustProxy = Number(process.env.TRUST_PROXY ?? (process.env.VERCEL === '1' ? '1' : '0'));
app.set('trust proxy', Number.isInteger(trustProxy) && trustProxy >= 0 ? trustProxy : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:["'self'"],
      scriptSrc:["'self'"],
      styleSrc:["'self'"],
      imgSrc:["'self'","data:","https:"],
      fontSrc:["'self'"],
      connectSrc:["'self'"],
      objectSrc:["'none'"],
      frameAncestors:["'none'"],
      baseUri:["'self'"],
      formAction:["'self'",'https://checkout.stripe.com'],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));
app.use(cookieParser());

// Stripe webhooks must receive the untouched request body.
app.post('/webhooks/stripe',express.raw({type:'application/json'}),async(req,res)=>{
  const signature = req.get('stripe-signature');
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifyStripeSignature(raw,signature,process.env.STRIPE_WEBHOOK_SECRET)) return res.status(400).send('Invalid signature');
  try {
    const event = JSON.parse(raw);
    const session = event.data?.object;
    const orderId = Number(session?.metadata?.order_id);
    if (validId(orderId)) {
      const order = await getOrder(orderId);
      if (!order || session?.mode !== 'payment' || session?.metadata?.order_id !== String(orderId) || String(session?.client_reference_id || '') !== String(orderId)) return res.status(400).send('Invalid order');
      if (order.payment_reference && String(order.payment_reference) !== String(session?.id || '')) return res.status(400).send('Invalid checkout session');
      const expectsPaymentVerification = ['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'].includes(event.type);
      if (expectsPaymentVerification) {
        const amountMatches = Number(session?.amount_total) === order.total_cents;
        const currencyMatches = String(session?.currency || '').toLowerCase() === String(order.currency).toLowerCase();
        if (!amountMatches || !currencyMatches) return res.status(400).send('Invalid payment amount');
      }
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        if (session?.payment_status === 'paid' || event.type === 'checkout.session.async_payment_succeeded') {
          await markOrderPaid(orderId,session.id);
          const paidOrder=await getOrder(orderId);
          if (paidOrder && ['paid','processing','shipped','completed'].includes(paidOrder.status) && !paidOrder.confirmation_email_sent_at) {
            let sent;
            try {
              const [name,legalName,businessAddress,supportEmail,businessPhone,enterpriseNumber,vatNumber]=await Promise.all([
                getSetting('store_name','ShopEasy'),getSetting('legal_name',''),getSetting('business_address',''),getSetting('support_email',''),getSetting('business_phone',''),getSetting('enterprise_number',''),getSetting('vat_number','')
              ]);
              sent=await sendOrderConfirmationEmail({
                order:paidOrder,
                store:{
                  name,legalName,businessAddress,supportEmail,businessPhone,enterpriseNumber,vatNumber,
                  baseUrl:String(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'')
                }
              });
            } catch {
              return res.status(503).send('Confirmation email unavailable');
            }
            if (sent?.sent) await markConfirmationEmailSent(orderId);
            else if (!sent?.skipped) return res.status(503).send('Confirmation email unavailable');
          }
        }
      }
      if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') await cancelPendingOrder(orderId);
    }
    return res.json({received:true});
  } catch { return res.status(400).send('Invalid webhook'); }
});

const generalLimiter=rateLimit({windowMs:60*1000,max:300,standardHeaders:true,legacyHeaders:false,message:'Too many requests. Please slow down.'});
const loginLimiter=rateLimit({windowMs:15*60*1000,max:10,standardHeaders:true,legacyHeaders:false,message:'Too many authentication attempts. Please try again later.'});
const aiLimiter=rateLimit({windowMs:60*1000,max:6,standardHeaders:true,legacyHeaders:false,message:'AI usage limit reached. Please try again shortly.'});
const cartLimiter=rateLimit({windowMs:60*1000,max:90,standardHeaders:true,legacyHeaders:false,message:'Too many cart requests. Please slow down.'});
const couponLimiter=rateLimit({windowMs:60*1000,max:10,standardHeaders:true,legacyHeaders:false,message:'Too many coupon attempts. Please try again later.'});
const checkoutLimiter=rateLimit({windowMs:10*60*1000,max:20,standardHeaders:true,legacyHeaders:false,message:'Too many checkout attempts. Please try again later.'});
const adminLimiter=rateLimit({windowMs:60*1000,max:120,standardHeaders:true,legacyHeaders:false,message:'Too many admin requests. Please slow down.'});
const searchLimiter=rateLimit({windowMs:60*1000,max:60,standardHeaders:true,legacyHeaders:false,message:'Too many searches. Please slow down.'});
const checkoutReservationMinutes=Math.max(35,Math.min(1440,Number(process.env.CHECKOUT_RESERVATION_MINUTES||60)||60));
const storeTimeZone=String(process.env.STORE_TIMEZONE||'Europe/Brussels').trim() || 'Europe/Brussels';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1},fileFilter:(req,file,cb)=>{ if(!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) return cb(new Error('INVALID_IMAGE_TYPE')); return cb(null,true); }});

app.use(express.urlencoded({extended:false,limit:'24kb'}));
app.use(express.json({limit:'24kb'}));
app.use(express.static(path.join(root,'public'),{index:false,maxAge:isProd?'7d':0}));

app.get('/uploads/:filename',async(req,res,next)=>{
  if(process.env.VERCEL!=='1') return res.sendStatus(404);
  const filename=String(req.params.filename||'');
  if(!/^[a-f0-9]{32}\.(?:png|jpg|webp)$/i.test(filename)) return res.sendStatus(404);
  try {
    const result=await db.execute({sql:'SELECT content_type,data FROM uploaded_assets WHERE path=?',args:[`/uploads/${filename}`]});
    const asset=result.rows[0];
    if(!asset) return res.sendStatus(404);
    return res.type(asset.content_type).set('Cache-Control','public, max-age=31536000, immutable').set('X-Content-Type-Options','nosniff').send(Buffer.from(asset.data));
  } catch(error) { return next(error); }
});
app.get('/health',async(req,res)=>{ try { await db.execute('SELECT 1'); return res.status(200).json({ok:true}); } catch { return res.status(503).json({ok:false}); } });
app.use(generalLimiter);
app.use(attachAuth);
app.use(csrfToken);
app.locals.formatDateTimeLocal = formatDateTimeLocal;
app.locals.formatDateTimeDisplay = formatDateTimeDisplay;
app.locals.storeTimeZone = storeTimeZone;
app.locals.formatPrice = (cents,currency='EUR') => { const code=isValidCurrency(currency)?String(currency).toUpperCase():'EUR'; return new Intl.NumberFormat('en-GB',{style:'currency',currency:code}).format(Number(cents||0)/100); };
app.locals.baseEffectivePrice = (p) => baseEffectivePrice(p);
app.locals.effectivePrice = (p) => dbEffectivePrice(p);
app.locals.discountPercent = (p) => {
  const current=app.locals.effectivePrice(p);
  return p.price_cents>0 && current<p.price_cents ? Math.min(99,Math.max(1,Math.round((1-current/p.price_cents)*100))) : 0;
};
app.locals.safeImageUrl = (value,fallback='/assets/product-placeholder.svg') => isSafeUrl(value) ? (value || fallback) : fallback;
app.locals.safeStoryHref = (value) => isSafeUrl(value) ? (value || '/stories') : '/stories';
app.use(async(req,res,next)=>{
  // Dynamic pages contain cookie/session-aware navigation, wishlist counts and cart state.
  // Never let a shared cache replay one customer's personalized HTML to another visitor.
  if (req.method === 'GET' || req.method === 'HEAD') res.set('Cache-Control','private, no-store');
  try {
  const [storeName,currency,aiEnabled,launch,supportEmail,legalName,businessAddress,businessPhone,enterpriseNumber]=await Promise.all([
    getSetting('store_name','ShopEasy'),getSetting('currency','EUR'),aiIsEnabled(),storeLaunchConfig(),getSetting('support_email',''),getSetting('legal_name',''),getSetting('business_address',''),getSetting('business_phone',''),getSetting('enterprise_number','')
  ]);
  res.locals.storeName=storeName;
  res.locals.currency=currency;
  res.locals.aiEnabled=aiEnabled;
  res.locals.stripeEnabled=stripeEnabled();
  res.locals.storeReady=launch.ready;
  res.locals.supportEmail=supportEmail;
  res.locals.legalName=legalName;
  res.locals.businessAddress=businessAddress;
  res.locals.businessPhone=businessPhone;
  res.locals.enterpriseNumber=enterpriseNumber;
  res.locals.cartCount=req.session.cart.reduce((s,i)=>s+Number(i.quantity||0),0);
  res.locals.wishlistCount=Array.isArray(req.session.wishlist)?req.session.wishlist.length:0;
  res.locals.wishlistIds=new Set(Array.isArray(req.session.wishlist)?req.session.wishlist:[]);
  res.locals.path=req.path;
  res.locals.isAdminRoute=req.path.startsWith('/admin');
  res.locals.isCheckoutRoute=req.path.startsWith('/checkout');
  res.locals.app={locals:app.locals};
  next();
  } catch(error) { next(error); }
});
app.use((req,res,next)=>req.is('multipart/form-data')?next():verifyCsrf(req,res,next));

function render(res,view,data={}) { return res.render(view,{error:null,...data}); }
function localRedirect(req,res,fallback='/') {
  const ref=req.get('referer');
  try { const u=ref ? new URL(ref) : null; if (u && u.protocol===req.protocol && u.host===req.get('host') && u.pathname.startsWith('/') && !u.pathname.startsWith('//')) return res.redirect(303,u.pathname + u.search); } catch {}
  return res.redirect(303,fallback);
}
function safeNavigationTarget(value, fallback='/account') { const target=cleanText(value,200); return isSafeLocalPath(target) ? target : fallback; }
async function aiIsEnabled() {
  return Boolean((await getSetting('ai_enabled','0')) === '1' && aiService?.aiEnabled?.());
}
async function storeLaunchConfig() {
  const [supportEmail,businessPhone,enterpriseNumber,legalName,businessAddress,privacyPolicy,termsPolicy,shippingPolicy,returnsPolicy,pricesSetting,sellableProducts,shippingFee]=await Promise.all([
    getSetting('support_email',''),getSetting('business_phone',''),getSetting('enterprise_number',''),getSetting('legal_name',''),getSetting('business_address',''),getSetting('privacy_policy',''),getSetting('terms_policy',''),getSetting('shipping_policy',''),getSetting('returns_policy',''),getSetting('prices_include_tax','0'),getRow('SELECT COUNT(*) AS c FROM products WHERE active=1 AND stock-reserved_stock>0 AND price_cents>0'),getSetting('shipping_fee_cents','0')
  ]);
  const policies=[privacyPolicy,termsPolicy,shippingPolicy,returnsPolicy].every(value=>value.trim().length>=40);
  const pricesIncludeTax=pricesSetting==='1';
  const sellableProductCount=Number(sellableProducts?.c||0);
  const shippingConfigured=Math.max(0,Number(shippingFee)||0)<=100000;
  return {supportEmail,businessPhone,enterpriseNumber,legalName,businessAddress,policies,pricesIncludeTax,sellableProductCount,shippingConfigured,emailEnabled:emailEnabled(),ready:Boolean(supportEmail&&businessPhone&&enterpriseNumber&&legalName&&businessAddress&&policies&&pricesIncludeTax&&shippingConfigured&&sellableProductCount>0&&stripeEnabled()&&emailEnabled())};
}
async function uniqueSlug(base,id=null) {
  const cleaned=base.toLowerCase().trim().replace(/[^a-z0-9\s-]/g,'').replace(/[\s-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70);
  const rootSlug=cleaned || `item-${Date.now()}`;
  let slug=rootSlug, n=2;
  while(await getRow('SELECT 1 FROM products WHERE slug=? AND id<>?',[slug,id||0])) slug=`${rootSlug.slice(0,60)}-${n++}`;
  return slug;
}
async function uniqueSku(name,id=null) {
  const base=name.toUpperCase().trim().replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,50) || 'ITEM';
  let sku=base,n=2;
  while(await getRow('SELECT 1 FROM products WHERE LOWER(sku)=LOWER(?) AND id<>?',[sku,id||0])) {
    const suffix=`-${n++}`;
    sku=`${base.slice(0,60-suffix.length)}${suffix}`;
  }
  return sku;
}
async function uniqueCategorySlug(base,id=null) {
  const cleaned=base.toLowerCase().trim().replace(/[^a-z0-9\s-]/g,'').replace(/[\s-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70);
  const rootSlug=cleaned || `category-${Date.now()}`;
  let slug=rootSlug,n=2;
  while(await getRow('SELECT 1 FROM categories WHERE slug=? AND id<>?',[slug,id||0])) slug=`${rootSlug.slice(0,60)}-${n++}`;
  return slug;
}
async function safeImagePath(buffer,mime) {
  if(!assertUploadSignature(buffer,mime)) return null;
  const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
  const name=`${crypto.randomBytes(16).toString('hex')}.${ext}`;
  if(process.env.VERCEL==='1'){
    const assetPath=`/uploads/${name}`;
    await db.execute({sql:'INSERT INTO uploaded_assets(path,content_type,data) VALUES(?,?,?)',args:[assetPath,mime,new Uint8Array(buffer)]});
    return assetPath;
  }
  const dir=path.join(root,'public/uploads'); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,name),buffer,{flag:'wx'}); return `/uploads/${name}`;
}
async function deleteUploadedAsset(url) {
  const value=String(url||'');
  const match=value.match(/^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|webp))$/i);
  if(!match) return;
  if(process.env.VERCEL==='1'){
    await db.execute({sql:'DELETE FROM uploaded_assets WHERE path=?',args:[value]});
    return;
  }
  try { fs.unlinkSync(path.join(root,'public/uploads',match[1])); } catch {}
}
async function safeProductImage(req) {
  if (req.file) return safeImagePath(req.file.buffer,req.file.mimetype);
  const url=cleanText(req.body.imageUrl,500);
  if (url && !isSafeUrl(url)) throw new Error('URL');
  return url || '';
}
async function cartItems(req) {
  const raw=Array.isArray(req.session.cart)?req.session.cart:[];
  const items=[];
  for(const row of raw){
    const id=Number(row?.productId), qty=Number(row?.quantity);
    if(!Number.isInteger(id)||id<1||!Number.isInteger(qty)||qty<1||qty>99) continue;
    const p=await getProductById(id);
    if(!p || !p.active || p.available_stock<=0) continue;
    const quantity=Math.min(qty,p.available_stock);
    const basePrice=app.locals.baseEffectivePrice(p);
    const price=app.locals.effectivePrice(p);
    items.push({productId:id,quantity,product:p,basePrice,price,total:price*quantity,automaticDiscountPercent:Number(p.automatic_discount_percent)||0,automaticDiscount:Math.max(0,(basePrice-price)*quantity)});
  }
  return items;
}
async function cartSummary(req) {
  const items=await cartItems(req);
  const normalized=items.map(i=>({productId:i.productId,quantity:i.quantity,product:i.product,price:i.price,basePrice:i.basePrice}));
  const subtotalBeforeAutomaticDiscount=items.reduce((s,i)=>s+i.basePrice*i.quantity,0);
  const automaticDiscount=items.reduce((s,i)=>s+i.automaticDiscount,0);
  const subtotal=subtotalBeforeAutomaticDiscount-automaticDiscount;
  const rawCoupon=req.session.coupon?await getCoupon(req.session.coupon):null;
  const coupon=rawCoupon && subtotal>=rawCoupon.min_subtotal_cents ? rawCoupon : null;
  let discount=0;
  if(coupon) discount=coupon.type==='percent'?Math.min(subtotal,Math.floor(subtotal*coupon.value/100)):Math.min(subtotal,coupon.value);
  const shipping=Math.max(0,Math.min(100000,Number(await getSetting('shipping_fee_cents','0'))||0));
  return {items:normalized,subtotalBeforeAutomaticDiscount,automaticDiscount,subtotal,discount,totalDiscount:automaticDiscount+discount,shipping,total:subtotal-discount+shipping,coupon,couponIneligible:Boolean(rawCoupon && !coupon)};
}

app.get('/',async(req,res)=>{
  const featuredProducts=await listProducts({onlyActive:true,featured:true,sort:'featured',limit:4,offset:0});
  const products=featuredProducts.length ? featuredProducts : await listProducts({onlyActive:true,sort:'featured',limit:4,offset:0});
  const [stories,categories]=await Promise.all([getActiveStories(),listCategories()]);
  render(res,'home',{products,stories,categories});
});
app.get('/shop',async(req,res)=>{
  const search=cleanText(req.query.search,80),category=cleanText(req.query.category,80),sort=cleanText(req.query.sort,30);
  const page=Math.max(1,Math.min(Number(req.query.page)||1,200));
  const pageSize=24, offset=(page-1)*pageSize;
  const [products,categories,nextProbe,resultCount]=await Promise.all([
    listProducts({search,category,sort,onlyActive:true,limit:pageSize,offset}),listCategories(),
    listProducts({search,category,sort,onlyActive:true,limit:1,offset:offset+pageSize}),countProducts({search,category,onlyActive:true})
  ]);
  render(res,'shop',{products,categories,search,category,sort,page,pageSize,hasNext:Boolean(nextProbe.length),hasPrev:page>1,resultCount});
});
app.get('/api/search',searchLimiter,async(req,res)=>{
  const q=cleanText(req.query.q,80);
  if(!q) return res.json({results:[]});
  const [results,currency]=await Promise.all([listProducts({search:q,onlyActive:true,limit:6,offset:0}),getSetting('currency','EUR')]);
  return res.json({results:results.map(p=>({id:p.id,name:p.name,slug:p.slug,image:app.locals.safeImageUrl(p.image_url),price:app.locals.formatPrice(app.locals.effectivePrice(p),currency),discount:app.locals.discountPercent(p)}))});
});

app.get('/product/:slug',async(req,res)=>{
  const product=await getProductBySlug(cleanText(req.params.slug,100));
  if(!product||!product.active) return res.status(404).render('error',{title:'Product not found',message:'This product is not available.'});
  render(res,'product',{product});
});

app.get('/wishlist',requireAuth,async(req,res)=>{
  const ids=[...new Set((Array.isArray(req.session.wishlist)?req.session.wishlist:[]).filter(Number.isInteger))].slice(0,50);
  const products=(await Promise.all(ids.map(id=>getProductById(id)))).filter(p=>p&&p.active);
  req.session.wishlist=products.map(p=>p.id);
  await saveSessionWishlist(req.sessionId,req.session.wishlist);
  render(res,'wishlist',{products});
});
app.post('/wishlist/toggle',cartLimiter,requireAuth,async(req,res)=>{
  const id=Number(req.body.productId), product=await getProductById(id);
  if(!validId(id)||!product||!product.active) return res.status(404).render('error',{title:'Product not found',message:'This product is not available.'});
  const wishlist=Array.isArray(req.session.wishlist)?req.session.wishlist.filter(Number.isInteger):[];
  const index=wishlist.indexOf(id);
  if(index>=0) wishlist.splice(index,1); else if(wishlist.length<50) wishlist.push(id);
  req.session.wishlist=wishlist;
  await saveSessionWishlist(req.sessionId,wishlist);
  return res.json({saved:index<0,count:wishlist.length});
});

app.post('/cart/add',cartLimiter,async(req,res)=>{
  const id=Number(req.body.productId),qty=Number(req.body.quantity);
  const p=await getProductById(id);
  if(!validId(id)||!p||!p.active||!Number.isInteger(qty)||qty<1||qty>99||qty>p.available_stock) return res.status(400).render('error',{title:'Could not add item',message:'That product is unavailable or the requested quantity is not in stock.'});
  const cart=Array.isArray(req.session.cart)?req.session.cart:[];
  const existing=cart.find(x=>x.productId===id);
  const nextQty=(existing?existing.quantity:0)+qty;
  if(nextQty>p.available_stock) return res.status(400).render('error',{title:'Stock limit reached',message:'There is not enough stock for that quantity.'});
  if(existing) existing.quantity=nextQty; else cart.push({productId:id,quantity:qty});
  await saveSessionCart(req.sessionId,cart); return localRedirect(req,res,'/shop');
});
app.post('/cart/update',cartLimiter,async(req,res)=>{
  const id=Number(req.body.productId),qty=Number(req.body.quantity),p=await getProductById(id),item=req.session.cart.find(x=>x.productId===id);
  if(!p||!item||!Number.isInteger(qty)||qty<0||qty>99) return localRedirect(req,res,'/cart');
  if(qty===0) req.session.cart=req.session.cart.filter(x=>x.productId!==id);
  else if(qty<=p.available_stock) item.quantity=qty;
  else return res.status(400).render('error',{title:'Stock limit reached',message:'There is not enough stock for that quantity.'});
  await saveSessionCart(req.sessionId,req.session.cart); return localRedirect(req,res,'/cart');
});
app.post('/cart/remove',cartLimiter,async(req,res)=>{const id=Number(req.body.productId);req.session.cart=req.session.cart.filter(x=>x.productId!==id);await saveSessionCart(req.sessionId,req.session.cart);return localRedirect(req,res,'/cart');});
app.get('/cart',async(req,res)=>{
  const summary=await cartSummary(req);
  const cleanCart=summary.items.map(i=>({productId:i.productId,quantity:i.quantity}));
  await saveSessionCart(req.sessionId,cleanCart);
  if(req.session.coupon && !summary.coupon){ req.session.coupon=null; await saveSessionCoupon(req.sessionId,null); }
  const couponMessage=cleanText(req.query.couponMessage,40);
  render(res,'cart',{...summary,couponMessage});
});
app.post('/cart/coupon',couponLimiter,async(req,res)=>{
  const code=cleanText(req.body.code,40).toUpperCase();
  if(!code){ req.session.coupon=null; await saveSessionCoupon(req.sessionId,null); return res.redirect(303,'/cart?couponMessage=cleared'); }
  const coupon=await getCoupon(code);
  if(!coupon) { req.session.coupon=null; await saveSessionCoupon(req.sessionId,null); return res.redirect(303,'/cart?couponMessage=invalid'); }
  const subtotal=(await cartSummary(req)).subtotal;
  if(subtotal<coupon.min_subtotal_cents) { req.session.coupon=null; await saveSessionCoupon(req.sessionId,null); return res.redirect(303,'/cart?couponMessage=minimum'); }
  req.session.coupon=code;
  await saveSessionCoupon(req.sessionId,code);
  return res.redirect(303,'/cart?couponMessage=applied');
});

app.get('/login',(req,res)=>render(res,'login',{error:null,next:cleanText(req.query.next,200),mode:req.query.mode==='register'?'register':'login',email:cleanText(req.query.email,120)}));
app.get('/register',(req,res)=>render(res,'login',{error:null,next:'',mode:'register',email:cleanText(req.query.email,120)}));
app.post('/login',loginLimiter,async(req,res)=>{
  const email=cleanText(req.body.email,120).toLowerCase(),password=String(req.body.password||'');
  const next=cleanText(req.body.next,200);
  let user;
  try { user=await authenticate(email,password); }
  catch(error) { console.error('Sign-in failed',error); return res.status(503).render('login',{error:'Sign in is temporarily unavailable. Please try again shortly.',next,mode:'login',email}); }
  if(!user) return render(res,'login',{error:'Email or password does not match. New here? Create an account.',next,mode:'login',email});
  try { await login(req,res,user.id); }
  catch(error) { console.error('Sign-in session could not be created',error); return res.status(503).render('login',{error:'Your account was found, but sign-in could not be completed. Please try again.',next,mode:'login',email}); }
  const requested=safeNavigationTarget(cleanText(req.body.next,200));
  const adminPath=requested==='/admin'||requested.startsWith('/admin/');
  const manager=['admin','manager'].includes(user.role);
  return res.redirect(303,manager?(adminPath?requested:'/admin'):(adminPath?'/account':requested));
});
app.post('/register',loginLimiter,async(req,res)=>{
  const email=cleanText(req.body.email,120).toLowerCase(),password=String(req.body.password||'');
  const registrationLocals={mode:'register',next:'',email};
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!isStrongEnoughPassword(password)) return render(res,'login',{...registrationLocals,error:'Use a valid email and a password with at least 12 characters.'});
  let userId;
  try {
    if(await getUserAuthByEmail(email)) return render(res,'login',{...registrationLocals,error:'An account with this email already exists. Sign in instead.'});
    userId=await createUser(email,hashPassword(password),'customer');
  } catch(error) {
    if(error?.code==='SQLITE_CONSTRAINT_UNIQUE'||/unique constraint/i.test(String(error?.message||''))) return render(res,'login',{...registrationLocals,error:'An account with this email already exists. Sign in instead.'});
    console.error('Customer account creation failed',error);
    return res.status(503).render('login',{...registrationLocals,error:'We could not create your account right now. Please try again shortly.'});
  }
  try { await login(req,res,userId); }
  catch(error) {
    console.error('Customer account was created but sign-in failed',error);
    return res.status(503).render('login',{...registrationLocals,error:'Your account was created, but automatic sign-in failed. Please use Sign in with this email.'});
  }
  return res.redirect(303,'/account');
});
app.post('/logout',async(req,res)=>{await logout(req,res);res.redirect(303,'/')});
app.get('/account',requireAuth,async(req,res)=>render(res,'account',{orders:await listUserOrders(req.user.id)}));
app.get('/account/security',requireAuth,async(req,res)=>render(res,'account-security',{error:null,changed:req.query.changed==='1'}));
app.post('/account/security',loginLimiter,requireAuth,async(req,res)=>{
  const current=String(req.body.currentPassword||''),nextPassword=String(req.body.newPassword||''),confirm=String(req.body.confirmPassword||'');
  const auth=await getUserAuthByEmail(req.user.email);
  if(!auth || !verifyPassword(current,auth.password_hash) || !isStrongEnoughPassword(nextPassword) || nextPassword!==confirm) return res.status(400).render('account-security',{error:'Check your current password and use a new password of at least 12 characters.',changed:false});
  if(!await updateUserPassword(req.user.id,hashPassword(nextPassword))) return res.status(500).render('account-security',{error:'The password could not be changed. Please try again.',changed:false});
  await destroyUserSessionsExcept(req.user.id,req.sessionId);
  await createAudit(req.user.id,'password_changed','user',req.user.id);
  return res.redirect(303,'/account/security?changed=1');
});

app.get('/account/order/:id',requireAuth,async(req,res)=>{const order=await getOrder(Number(req.params.id));if(!order||order.user_id!==req.user.id)return res.status(404).render('error',{title:'Order not found',message:'This order is not available.'});render(res,'order',{order});});

app.get('/checkout',requireAuth,async(req,res)=>{
  const summary=await cartSummary(req);
  if(!summary.items.length) return res.redirect('/cart');
  const launch=await storeLaunchConfig();
  render(res,'checkout',{summary,error:launch.ready?null:'The store is not ready to accept live orders yet. The manager must finish payment and business-policy setup first.',idempotencyKey:crypto.randomBytes(24).toString('base64url')});
});
app.post('/checkout',checkoutLimiter,requireAuth,async(req,res)=>{
  const summary=await cartSummary(req);
  if(!summary.items.length) return res.redirect(303,'/cart');
  const launch=await storeLaunchConfig();
  if(!launch.ready) return render(res,'checkout',{summary,error:'The store is not ready to accept live orders yet. Complete Stripe, business details and store policies in the manager settings.',idempotencyKey:crypto.randomBytes(24).toString('base64url')});
  if(!stripeEnabled()) return render(res,'checkout',{summary,error:'Online payments are not configured yet. Add Stripe server credentials before accepting real orders.',idempotencyKey:crypto.randomBytes(24).toString('base64url')});
  const email=req.user.email.toLowerCase();
  const customerPhone=cleanText(req.body.customerPhone,32);
  const country=cleanText(req.body.shippingCountry,80);
  const shipping={name:cleanText(req.body.shippingName,120),address:cleanText(req.body.shippingAddress,200),city:cleanText(req.body.shippingCity,100),postalCode:cleanText(req.body.shippingPostalCode,20),country};
  const termsAccepted=req.body.termsAccepted==='on';
  const customerNote=cleanText(req.body.customerNote,500);
  if(!/^\+?[0-9 ()-]{7,32}$/.test(customerPhone)||country.length<2||country.length>80||Object.values(shipping).some(v=>!v)||!termsAccepted) return render(res,'checkout',{summary,error:'Enter a valid phone number, complete every required delivery field and accept the store terms before continuing.',idempotencyKey:crypto.randomBytes(24).toString('base64url')});
  let idem=cleanText(req.body.idempotencyKey,100);
  if(!/^[A-Za-z0-9_-]{24,100}$/.test(idem)) return render(res,'checkout',{summary,error:'Please retry the checkout.',idempotencyKey:crypto.randomBytes(24).toString('base64url')});
  let prior=await getOrderByClientToken(idem);
  if(prior && prior.user_id===req.user.id){
    if(['paid','processing','shipped','completed'].includes(prior.status)) return res.redirect(303,`/checkout/success?order=${prior.id}`);
    const reservationExpired=prior.status==='pending' && prior.reservation_expires_at && new Date(prior.reservation_expires_at)<=new Date();
    if(reservationExpired){
      await cancelPendingOrder(prior.id);
      prior=null;
    }
    if(prior?.status==='pending' && prior.reservation_expires_at && new Date(prior.reservation_expires_at)>new Date()){
      const existing=await getOrder(prior.id);
      const sameItems=Boolean(existing) && existing.items.length===summary.items.length && existing.items.every((item,index)=>{
        const current=summary.items.find(line=>line.productId===item.product_id);
        return Boolean(current) && current.quantity===item.quantity;
      });
      if(sameItems){
        if(prior.payment_url) return res.redirect(303,prior.payment_url);
        try {
          const checkoutItems=existing.items.map(item=>({product:{name:item.product_name},quantity:item.quantity,unit:item.unit_price_cents}));
          const checkout=await createStripeCheckout({orderId:existing.id,amountCents:existing.total_cents,discountCents:existing.discount_cents,shippingCents:existing.shipping_cents,currency:existing.currency,email:existing.email,items:checkoutItems,reservationExpires:existing.reservation_expires_at});
          if(!await saveCheckoutSession(existing.id,checkout.id,checkout.url)){
            const fresh=await getOrder(existing.id);
            if(fresh && ['paid','processing','shipped','completed'].includes(fresh.status)) return res.redirect(303,`/checkout/success?order=${fresh.id}`);
            if(fresh?.status==='pending' && fresh.payment_url) return res.redirect(303,fresh.payment_url);
            throw new Error('CHECKOUT_SESSION_SAVE_FAILED');
          }
          return res.redirect(303,checkout.url);
        } catch(err) {
          const messages={STRIPE_DISABLED:'Online payments are not configured yet.',INVALID_CHECKOUT_EXPIRY:'Checkout configuration is invalid.'};
          return render(res,'checkout',{summary,error:messages[err.message]||'The payment provider is temporarily unavailable. Your stock reservation is still protected; please retry this checkout.',idempotencyKey:idem});
        }
      }
      // The customer changed the cart after this idempotency token was created.
      // Never silently charge the previous cart: create a fresh token/order and leave the old pending order to expire normally.
      idem=crypto.randomBytes(24).toString('base64url');
      prior=null;
    }
    if(prior?.status==='pending' && prior.user_id===req.user.id && !prior.payment_reference) await cancelPendingOrder(prior.id);
    prior=null;
  }
  let created;
  try {
    const currency=await getSetting('currency','EUR');
    created=await createOrderAtomic({userId:req.user.id,email,customerPhone,items:summary.items,coupon:summary.coupon?.code||null,currency,shipping,shippingCents:summary.shipping,customerNote,paymentProvider:'stripe',clientToken:idem,termsAcceptedAt:new Date().toISOString(),reservationMinutes:checkoutReservationMinutes});
    await createAudit(req.user.id,'order_created','order',created.orderId,{total:created.total,paymentProvider:'stripe'});
    const checkout=await createStripeCheckout({orderId:created.orderId,amountCents:created.total,discountCents:created.discount,shippingCents:created.shipping,currency,email,items:created.items,reservationExpires:created.reservationExpires});
    if (!await saveCheckoutSession(created.orderId,checkout.id,checkout.url)) {
      const fresh=await getOrder(created.orderId);
      if (fresh && ['paid','processing','shipped','completed'].includes(fresh.status)) return res.redirect(303,`/checkout/success?order=${fresh.id}`);
      throw new Error('CHECKOUT_SESSION_SAVE_FAILED');
    }
    return res.redirect(303,checkout.url);
  } catch(err) {
    // Network/timeout failures are ambiguous: Stripe may have created a session already.
    // Keep the pending reservation so the deterministic order idempotency key can safely recover on retry.
    if(created?.orderId && !(err?.name==='StripeProviderError' && err.ambiguous)) await cancelPendingOrder(created.orderId);
    const messages={CHECKOUT_SESSION_SAVE_FAILED:'The payment session could not be linked to the order. Please retry.',PRODUCT_UNAVAILABLE:'One of the products is no longer available.',INSUFFICIENT_STOCK:'One of the selected quantities is no longer in stock.',INVALID_COUPON:'The coupon is no longer valid.',COUPON_MINIMUM:'The coupon minimum has not been reached.',INVALID_QUANTITY:'Please check your quantities.',ZERO_TOTAL:'The final order total must be greater than zero.',PAYMENT_MINIMUM:'The final order total is below the minimum supported by the payment provider for this currency.',INVALID_RESERVATION:'Checkout configuration is invalid.',INVALID_CHECKOUT_EXPIRY:'Checkout configuration is invalid.',STRIPE_DISABLED:'Online payments are not configured yet.',INVALID_ORDER:'Checkout data is invalid.',STOCK_INTEGRITY:'Stock changed while payment was being confirmed. Contact support if you were charged.'};
    return render(res,'checkout',{summary,error:messages[err.message]||'Checkout could not be completed. Please try again.',idempotencyKey:created?idem:crypto.randomBytes(24).toString('base64url')});
  }
});
app.get('/checkout/success',requireAuth,async(req,res)=>{
  const order=await getOrder(Number(req.query.order));
  if(!order||order.user_id!==req.user.id)return res.status(404).render('error',{title:'Order not found',message:'This order could not be found.'});
  if(order.status==='paid'||order.status==='processing'||order.status==='shipped'||order.status==='completed'){req.session.cart=[];req.session.coupon=null;await saveSessionCart(req.sessionId,[]);await saveSessionCoupon(req.sessionId,null);}
  render(res,'success',{order});
});
app.get('/checkout/cancel',requireAuth,async(req,res)=>{
  const order=await getOrder(Number(req.query.order));
  if(!order||order.user_id!==req.user.id)return res.status(404).render('error',{title:'Order not found',message:'This order could not be found.'});
  if(order.status==='pending' && !order.payment_reference) await cancelPendingOrder(order.id);
  const fresh=await getOrder(order.id) || order;
  const stillProviderPending=Boolean(fresh.status==='pending' && fresh.payment_reference);
  const actuallyCancelled=fresh.status==='cancelled';
  render(res,'success',{order:fresh,cancelled:actuallyCancelled,waitingForProviderExpiry:stillProviderPending});
});

app.post('/api/ai/search-assistant',aiLimiter,async(req,res)=>{
  if(!await aiIsEnabled())return res.status(404).json({error:'AI is disabled'});
  const message=cleanText(req.body.message,500);
  if(!message)return res.status(400).json({error:'Message is required'});
  try { const answer=await aiService.shoppingAssistant(message,await listProducts({onlyActive:true,limit:12,offset:0})); return res.json({answer}); }
  catch { return res.status(503).json({error:'AI service unavailable'}); }
});

app.get('/robots.txt',(req,res)=>{res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /checkout\nSitemap: ${(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'')}/sitemap.xml\n`);});
app.get('/sitemap.xml',async(req,res)=>{
  const base=String(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');
  const [categories,products]=await Promise.all([listCategories(),listProducts({onlyActive:true,limit:500,offset:0})]);
  const urls=['/','/shop','/stories','/privacy','/terms','/shipping-returns',...categories.map(c=>`/shop?category=${encodeURIComponent(c.slug)}`),...products.map(p=>`/product/${encodeURIComponent(p.slug)}`)];
  const esc=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const xml=`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u=>`<url><loc>${esc(base+u)}</loc></url>`).join('')}</urlset>`;
  res.type('application/xml').send(xml);
});
app.get('/stories',async(req,res)=>render(res,'stories',{stories:await getActiveStories()}));
app.get('/privacy',async(req,res)=>render(res,'policy',{title:'Privacy',heading:'Privacy & data',body:await getSetting('privacy_policy','This store has not published its privacy policy yet.')}));
app.get('/terms',async(req,res)=>render(res,'policy',{title:'Terms',heading:'Terms & conditions',body:await getSetting('terms_policy','This store has not published its terms yet.')}));
app.get('/shipping-returns',async(req,res)=>{const [shipping,returns]=await Promise.all([getSetting('shipping_policy','This store has not published its shipping policy yet.'),getSetting('returns_policy','This store has not published its returns policy yet.')]);render(res,'policy',{title:'Shipping & returns',heading:'Shipping & returns',body:`${shipping}\n\n${returns}`});});

// Admin / manager area
app.use('/admin',adminLimiter);
app.get('/admin',requireManager,async(req,res)=>{
  const [stats,recentOrders]=await Promise.all([getDashboardStats(),listOrders({limit:6,offset:0})]);
  render(res,'admin/dashboard',{productCount:Number(stats.products.total||0),activeProducts:Number(stats.products.active||0),soldOutProducts:Number(stats.products.sold_out||0),orderCount:Number(stats.orders.total||0),storyCount:Number(stats.stories.total||0),liveStories:Number(stats.stories.live||0),customerCount:Number(stats.customers.total||0),pendingOrders:Number(stats.orders.pending||0),paidRevenue:Number(stats.orders.revenue||0),recentOrders});
});
app.get('/admin/categories',requireManager,async(req,res)=>{const editId=validId(req.query.edit)?Number(req.query.edit):null;const [categories,editCategory]=await Promise.all([listCategories(),editId?getRow('SELECT * FROM categories WHERE id=?',[editId]):null]);render(res,'admin/categories',{categories,editCategory,error:null});});
app.post('/admin/categories/save',requireManager,async(req,res)=>{
  try {
    const id=validId(req.body.id)?Number(req.body.id):null,name=cleanText(req.body.name,80);
    if(!name) throw new Error('VALIDATION');
    const slug=await uniqueCategorySlug(name,id);
    const savedId=id?await updateCategory(id,name,slug):await createCategory(name,slug);
    await createAudit(req.user.id,id?'category_updated':'category_created','category',savedId,{name});
    return res.redirect(303,'/admin/categories');
  } catch {
    return res.status(400).render('admin/categories',{categories:await listCategories(),editCategory:{...req.body,id:req.body.id||null},error:'Could not save category. Use a valid unique name.'});
  }
});
app.post('/admin/categories/delete',requireManager,async(req,res)=>{
  const id=Number(req.body.id);
  if(validId(id)){await deleteCategory(id);await createAudit(req.user.id,'category_deleted','category',id);}
  res.redirect(303,'/admin/categories');
});
app.get('/admin/products',requireManager,async(req,res)=>{const search=cleanText(req.query.search,80),category=cleanText(req.query.category,80),page=Math.max(1,Math.min(Number(req.query.page)||1,1000)),pageSize=50,offset=(page-1)*pageSize;const [total,products,categories]=await Promise.all([countProducts({search,category,onlyActive:false}),listProducts({search,category,onlyActive:false,limit:pageSize,offset}),listCategories()]);render(res,'admin/products',{products,categories,search,category,page,total,hasNext:offset+products.length<total,hasPrev:page>1});});
app.get('/admin/products/new',requireManager,async(req,res)=>render(res,'admin/product-form',{product:null,categories:await listCategories(),currency:await getSetting('currency','EUR'),error:null}));
app.post('/admin/products/save',requireManager,upload.single('image'),verifyCsrf,async(req,res)=>{
  let savedImage=null;
  let previousImage=null;
  try {
    const id=validId(req.body.id)?Number(req.body.id):null;
    previousImage=id?(await getProductById(id))?.image_url||null:null;
    const name=cleanText(req.body.name,120),price=moneyCents(req.body.price),saleText=String(req.body.salePrice||'').trim(),sale=saleText?moneyCents(saleText):null,automaticDiscountPercent=Number(req.body.automaticDiscountPercent);
    const stock=Number(req.body.stock),saleStart=dateTimeLocalToISOString(req.body.saleStart,storeTimeZone),saleEnd=dateTimeLocalToISOString(req.body.saleEnd,storeTimeZone);
    let sku=cleanText(req.body.sku,60).toUpperCase();
    if(!name) throw new Error('NAME');
    if(price===null||price<=0) throw new Error('PRICE');
    if(saleText&&(sale===null||sale<=0||sale>=price)) throw new Error('SALE_PRICE');
    if(!Number.isInteger(automaticDiscountPercent)||automaticDiscountPercent<0||automaticDiscountPercent>90) throw new Error('DISCOUNT');
    if(!Number.isInteger(stock)||stock<0||stock>100000000) throw new Error('STOCK');
    if(saleStart&&saleEnd&&new Date(saleEnd)<=new Date(saleStart)) throw new Error('SALE_WINDOW');
    if(!sku) sku=await uniqueSku(name,id);
    else if(await getRow('SELECT 1 FROM products WHERE LOWER(sku)=LOWER(?) AND id<>?',[sku,id||0])) throw new Error('SKU_TAKEN');
    const image=await safeProductImage(req); savedImage=image; if(req.file&&!image)throw new Error('IMAGE');
    const categoryId=validId(req.body.categoryId)?Number(req.body.categoryId):null;
    if(categoryId && !await getRow('SELECT 1 FROM categories WHERE id=?',[categoryId]))throw new Error('CATEGORY');
    const data={id,name,slug:await uniqueSlug(name,id),shortDescription:cleanText(req.body.shortDescription,300),description:cleanText(req.body.description,5000),imageUrl:image,priceCents:price,salePriceCents:sale,saleStart,saleEnd,sku,stock,categoryId,tags:cleanText(req.body.tags,300),featured:req.body.featured==='on',active:req.body.active==='on',automaticDiscountPercent};
    const savedId=await adminCreateOrUpdateProduct(data);
    await createAudit(req.user.id,id?'product_updated':'product_created','product',savedId,{name:data.name,automaticDiscountPercent:data.automaticDiscountPercent});
    if(req.file && previousImage && previousImage!==savedImage) await deleteUploadedAsset(previousImage);
    return res.redirect(303,'/admin/products');
  } catch(err) {
    if(req.file && savedImage) await deleteUploadedAsset(savedImage);
    const errors={NAME:'Enter a product name.',PRICE:'Enter a regular price greater than zero.',SALE_PRICE:'Sale price must be greater than zero and lower than the regular price.',DISCOUNT:'Automatic discount must be a whole number from 0 to 90.',STOCK:'Enter a whole stock quantity from 0 to 100,000,000.',SALE_WINDOW:'Sale end must be later than sale start.',SKU_TAKEN:'This SKU is already used by another product. Change it or leave it blank for an automatic SKU.',CATEGORY:'Choose an existing category or select No category.',IMAGE:'Use a valid JPG, PNG or WebP image up to 5 MB.',URL:'Image URL must use a trusted HTTPS address.',RESERVED_STOCK:'Stock cannot be lower than stock currently reserved in checkout.'};
    return res.status(400).render('admin/product-form',{product:req.body,categories:await listCategories(),currency:await getSetting('currency','EUR'),error:errors[err.message]||'Could not save the product. Your entries are still here; check the highlighted details and try again.'});
  }
});
app.get('/admin/products/:id/edit',requireManager,async(req,res)=>{const product=await getProductById(Number(req.params.id));if(!product)return res.status(404).render('error',{title:'Product not found',message:'Product does not exist.'});render(res,'admin/product-form',{product,categories:await listCategories(),currency:await getSetting('currency','EUR'),error:null});});
app.post('/admin/products/delete',requireManager,async(req,res)=>{const id=Number(req.body.id);if(validId(id)){const p=await getProductById(id);if(p?.reserved_stock>0)return res.status(400).render('error',{title:'Product is reserved',message:'This product cannot be deleted while checkout stock is reserved.'});await deleteProduct(id);await deleteUploadedAsset(p?.image_url);await createAudit(req.user.id,'product_deleted','product',id);}res.redirect(303,'/admin/products');});

app.get('/admin/stories',requireManager,async(req,res)=>render(res,'admin/stories',{stories:await listStories()}));
app.get('/admin/stories/new',requireManager,async(req,res)=>render(res,'admin/story-form',{story:null,products:await listProducts({onlyActive:true}),error:null}));
app.post('/admin/stories/save',requireManager,upload.single('image'),verifyCsrf,async(req,res)=>{
  let savedImage=null;
  let previousImage=null;
  try {
    const id=validId(req.body.id)?Number(req.body.id):null;
    previousImage=id?(await getStory(id))?.image_url||null:null;
    const title=cleanText(req.body.title,120),published=dateTimeLocalToISOString(req.body.publishedAt,storeTimeZone),expires=dateTimeLocalToISOString(req.body.expiresAt,storeTimeZone),link=cleanText(req.body.linkUrl,500);
    if(!title||!published||!expires||new Date(expires)<=new Date(published))throw new Error('VALIDATION');
    if(!isSafeUrl(link))throw new Error('URL');
    const productId=validId(req.body.productId)?Number(req.body.productId):null;
    if(productId && !await getProductById(productId))throw new Error('PRODUCT');
    const image=req.file?await safeImagePath(req.file.buffer,req.file.mimetype):cleanText(req.body.imageUrl,500); savedImage=image;
    if(req.file&&!image)throw new Error('IMAGE'); if(!isSafeUrl(image))throw new Error('URL');
    const savedId=await adminCreateOrUpdateStory({id,title,body:cleanText(req.body.body,1000),imageUrl:image,linkUrl:link,productId,publishedAt:published,expiresAt:expires,active:req.body.active==='on'});
    await createAudit(req.user.id,'story_saved','story',savedId,{title}); if(req.file && previousImage && previousImage!==savedImage) await deleteUploadedAsset(previousImage); return res.redirect(303,'/admin/stories');
  } catch { if(req.file && savedImage) await deleteUploadedAsset(savedImage); return res.status(400).render('admin/story-form',{story:req.body,products:await listProducts({onlyActive:true}),error:'Could not save story. Check dates, URL, product and image.'}); }
});
app.get('/admin/stories/:id/edit',requireManager,async(req,res)=>{const story=await getStory(Number(req.params.id));if(!story)return res.status(404).render('error',{title:'Story not found',message:'Story does not exist.'});render(res,'admin/story-form',{story,products:await listProducts({onlyActive:true}),error:null});});
app.post('/admin/stories/delete',requireManager,async(req,res)=>{const id=Number(req.body.id);if(validId(id)){const story=await getStory(id);await deleteStory(id);await deleteUploadedAsset(story?.image_url);await createAudit(req.user.id,'story_deleted','story',id);}res.redirect(303,'/admin/stories');});

app.get('/admin/orders',requireManager,async(req,res)=>{
  const search=cleanText(req.query.search,80),status=cleanText(req.query.status,30);
  const page=Math.max(1,Math.min(Number(req.query.page)||1,1000)),pageSize=50,offset=(page-1)*pageSize;
  const [orders,total]=await Promise.all([listOrders({search,status,limit:pageSize,offset}),countOrders({search,status})]);
  render(res,'admin/orders',{orders,search,status,page,pageSize,total,hasNext:offset+orders.length<total,hasPrev:page>1});
});
app.get('/admin/orders/:id',requireManager,async(req,res)=>{const order=await getOrder(Number(req.params.id));if(!order)return res.status(404).render('error',{title:'Order not found',message:'Order does not exist.'});render(res,'admin/order',{order});});
app.post('/admin/orders/status',requireManager,async(req,res)=>{const id=Number(req.body.id),status=cleanText(req.body.status,30);if(validId(id)&&['processing','shipped','completed','cancelled'].includes(status)&&await setOrderStatus(id,status))await createAudit(req.user.id,'order_status_changed','order',id,{status});res.redirect(303,`/admin/orders/${id}`);});

app.get('/admin/coupons',requireManager,async(req,res)=>{const editId=validId(req.query.edit)?Number(req.query.edit):null;const [coupons,editCoupon]=await Promise.all([listCoupons(),editId?getCouponById(editId):null]);render(res,'admin/coupons',{coupons,editCoupon,error:null});});
app.post('/admin/coupons/save',requireManager,async(req,res)=>{
  try {
    const id=validId(req.body.id)?Number(req.body.id):null,code=cleanText(req.body.code,40).toUpperCase(),type=req.body.type==='fixed'?'fixed':'percent';
    const value=type==='fixed'?moneyCents(req.body.value):Number(req.body.value),minSubtotalCents=moneyCents(req.body.minSubtotal||'0'),expiresAt=dateTimeLocalToISOString(req.body.expiresAt,storeTimeZone);
    if(!/^[A-Z0-9_-]{3,40}$/.test(code)||!Number.isInteger(value)||value<=0||(type==='percent'&&value>100)||minSubtotalCents===null||!Number.isInteger(minSubtotalCents)||minSubtotalCents<0)throw new Error('VALIDATION');
    const savedId=await adminCreateOrUpdateCoupon({id,code,type,value,minSubtotalCents,expiresAt,active:req.body.active==='on'});
    await createAudit(req.user.id,id?'coupon_updated':'coupon_created','coupon',savedId,{code,type});return res.redirect(303,'/admin/coupons');
  } catch { return res.status(400).render('admin/coupons',{coupons:await listCoupons(),editCoupon:{...req.body,id:req.body.id||null},error:'Could not save coupon. Check the code, value, minimum and expiry date.'}); }
});
app.post('/admin/coupons/delete',requireManager,async(req,res)=>{const id=Number(req.body.id);if(validId(id)){await deleteCoupon(id);await createAudit(req.user.id,'coupon_deleted','coupon',id);}res.redirect(303,'/admin/coupons');});

app.get('/admin/customers',requireManager,async(req,res)=>{const search=cleanText(req.query.search,120),page=Math.max(1,Math.min(Number(req.query.page)||1,1000)),pageSize=50,offset=(page-1)*pageSize;const [total,customers]=await Promise.all([countCustomers(search),listCustomers({limit:pageSize,offset,search})]);render(res,'admin/customers',{customers,search,page,total,hasNext:offset+Math.min(pageSize,total-offset)<total,hasPrev:page>1});});
app.get('/admin/audit',requireManager,async(req,res)=>render(res,'admin/audit',{logs:await listAuditLogs()}));
app.get('/admin/settings',requireManager,async(req,res)=>{const launch=await storeLaunchConfig();const [storeName,currency,legalName,businessAddress,supportEmail,businessPhone,enterpriseNumber,vatNumber,shippingFeeCents,privacyPolicy,termsPolicy,shippingPolicy,returnsPolicy,pricesIncludeTax,aiEnabled]=await Promise.all([getSetting('store_name','ShopEasy'),getSetting('currency','EUR'),getSetting('legal_name',''),getSetting('business_address',''),getSetting('support_email',''),getSetting('business_phone',''),getSetting('enterprise_number',''),getSetting('vat_number',''),getSetting('shipping_fee_cents','0'),getSetting('privacy_policy',''),getSetting('terms_policy',''),getSetting('shipping_policy',''),getSetting('returns_policy',''),getSetting('prices_include_tax','0'),aiIsEnabled()]);render(res,'admin/settings',{storeName,currency,availableCurrencies:STRIPE_TWO_DECIMAL_CURRENCIES,legalName,businessAddress,supportEmail,businessPhone,enterpriseNumber,vatNumber,shippingFeeCents:Math.max(0,Number(shippingFeeCents)||0),privacyPolicy,termsPolicy,shippingPolicy,returnsPolicy,pricesIncludeTax:pricesIncludeTax==='1',aiEnabled,stripeEnabled:stripeEnabled(),emailEnabled:emailEnabled(),sellableProductCount:launch.sellableProductCount,storeReady:launch.ready});});
app.post('/admin/settings',requireManager,async(req,res)=>{
  const storeName=cleanText(req.body.storeName,100),aiToggle=req.body.aiEnabled==='on',pricesIncludeTax=req.body.pricesIncludeTax==='on',currency=cleanText(req.body.currency,3).toUpperCase(),legalName=cleanText(req.body.legalName,160),businessAddress=cleanText(req.body.businessAddress,500),supportEmail=cleanText(req.body.supportEmail,160).toLowerCase(),businessPhone=cleanText(req.body.businessPhone,40),enterpriseNumber=cleanText(req.body.enterpriseNumber,40),vatNumber=cleanText(req.body.vatNumber,40),shippingFeeCents=moneyCents(req.body.shippingFee||'0'),privacyPolicy=cleanText(req.body.privacyPolicy,12000),termsPolicy=cleanText(req.body.termsPolicy,12000),shippingPolicy=cleanText(req.body.shippingPolicy,8000),returnsPolicy=cleanText(req.body.returnsPolicy,8000);
  if(!storeName||!isValidCurrency(currency)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)||businessPhone.length<7||enterpriseNumber.length<6||shippingFeeCents===null||shippingFeeCents>100000||!legalName||!businessAddress||privacyPolicy.length<40||termsPolicy.length<40||shippingPolicy.length<40||returnsPolicy.length<40||!pricesIncludeTax) return res.status(400).render('admin/settings',{storeName,currency,availableCurrencies:STRIPE_TWO_DECIMAL_CURRENCIES,legalName,businessAddress,supportEmail,businessPhone,enterpriseNumber,vatNumber,shippingFeeCents,privacyPolicy,termsPolicy,shippingPolicy,returnsPolicy,pricesIncludeTax,aiEnabled:await aiIsEnabled(),stripeEnabled:stripeEnabled(),emailEnabled:emailEnabled(),sellableProductCount:(await storeLaunchConfig()).sellableProductCount,storeReady:false,error:'Check the store identity, policies and tax-inclusive consumer pricing setting. Business phone and registration number are required; all four customer policies must contain at least 40 characters.'});
  for(const [key,value] of Object.entries({store_name:storeName,ai_enabled:aiToggle?'1':'0',currency,legal_name:legalName,business_address:businessAddress,support_email:supportEmail,business_phone:businessPhone,enterprise_number:enterpriseNumber,vat_number:vatNumber,shipping_fee_cents:String(shippingFeeCents),privacy_policy:privacyPolicy,terms_policy:termsPolicy,shipping_policy:shippingPolicy,returns_policy:returnsPolicy,prices_include_tax:pricesIncludeTax?'1':'0'})) await setSetting(key,value);
  await createAudit(req.user.id,'settings_updated','store',null,{storeName,currency,aiEnabled:aiToggle});res.redirect(303,'/admin/settings');
});

app.use((req,res)=>res.status(404).render('error',{title:'Page not found',message:'The page you requested does not exist.'}));
app.use((err,req,res,next)=>{
  if(err?.code==='LIMIT_FILE_SIZE')return res.status(400).render('error',{title:'File too large',message:'Images must be 5 MB or smaller.'});
  if(err?.code==='LIMIT_UNEXPECTED_FILE')return res.status(400).render('error',{title:'Upload rejected',message:'Only one image may be uploaded.'});
  if(err?.message==='INVALID_IMAGE_TYPE')return res.status(400).render('error',{title:'Upload rejected',message:'Only JPG, PNG or WebP images are supported.'});
  if(err?.code==='LIMIT_FILE_COUNT')return res.status(400).render('error',{title:'Upload rejected',message:'Only one image may be uploaded.'});
  console.error(err);
  for(const [key,value] of Object.entries({storeName:'ShopEasy',csrf:'',isLoggedIn:Boolean(req.user),user:req.user||null,wishlistCount:0,cartCount:0,supportEmail:'',businessPhone:'',enterpriseNumber:'',legalName:'',businessAddress:'',path:req.path||'/',isAdminRoute:req.path?.startsWith('/admin')||false,isCheckoutRoute:req.path?.startsWith('/checkout')||false})) if(res.locals[key]===undefined) res.locals[key]=value;
  return res.status(500).render('error',{title:'Something went wrong',message:'The request could not be completed.'});
});

async function bootstrapAdmin(){
  const email=process.env.ADMIN_EMAIL?.trim().toLowerCase(),password=process.env.ADMIN_PASSWORD;
  if(isProd && (!process.env.BASE_URL?.startsWith('https://') || !email || !password || !isStrongEnoughPassword(password) || email==='admin@example.com' || password==='ChangeThisImmediately-Long-Password!')) {
    console.error('Production configuration is incomplete: public pages are available, but admin setup requires an HTTPS BASE_URL, a real ADMIN_EMAIL, and a unique strong ADMIN_PASSWORD.');
    return;
  }
  if(!email||!password||!isStrongEnoughPassword(password))return;
  const configured=await getRow('SELECT id,role,password_hash FROM users WHERE email=?',[email]);
  if(configured){
    if(!['admin','manager'].includes(configured.role)) await db.execute({sql:"UPDATE users SET role='admin' WHERE id=?",args:[configured.id]});
    if(!verifyPassword(password,configured.password_hash)) await updateUserPassword(configured.id,hashPassword(password));
    return;
  }
  const exists=await getRow("SELECT id FROM users WHERE role IN ('admin','manager') LIMIT 1");
  if(!exists){await createUser(email,hashPassword(password),'admin');console.log(`Initial admin created: ${email}`);}
}
await Promise.all([releaseExpiredReservations(),cleanupSessions()]);
await bootstrapAdmin();
const port=Number(process.env.PORT||3000);
if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'test') {
  const server=app.listen(port,()=>console.log(`ShopEasy running on http://localhost:${port}`));
  server.keepAliveTimeout=5000;
  server.headersTimeout=10000;
  server.requestTimeout=30000;
  const shutdown=()=>{ server.close(async()=>{ try{ await db.close(); } finally { process.exit(0); } }); };
  setInterval(()=>{ cleanupSessions().catch(console.error); releaseExpiredReservations().catch(console.error); },5*60*1000).unref();
  process.once('SIGTERM',shutdown);
  process.once('SIGINT',shutdown);
}

export default app;
