import crypto from 'node:crypto';
import { createSession, destroySession, getSession, getUserAuthByEmail, getUserById, saveSessionCart, saveSessionWishlist, saveSessionCoupon, setSessionCsrf, setSessionUser } from './db.js';
function scryptHash(password) { const salt=crypto.randomBytes(16); const derived=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1}); return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`; }
function scryptVerify(password,stored) { try { const [algo,n,r,p,saltB64,hashB64]=String(stored||'').split('$'); const N=Number(n), R=Number(r), P=Number(p); if(algo!=='scrypt'||!Number.isInteger(N)||N<16384||N>32768||R!==8||P!==1||!saltB64||!hashB64) return false; const derived=crypto.scryptSync(String(password||''),Buffer.from(saltB64,'base64url'),64,{N,r:R,p:P}); const expected=Buffer.from(hashB64,'base64url'); return derived.length===expected.length && crypto.timingSafeEqual(derived,expected); } catch { return false; } }
export function hashPassword(password) { return scryptHash(password); }
export function verifyPassword(password,stored) { return scryptVerify(password,stored); }
export function sessionCookieName() { return process.env.NODE_ENV==='production' ? '__Host-sid' : 'sid'; }
export async function attachAuth(req,res,next) {
  try {
    let sid=req.cookies?.[sessionCookieName()];
    let session=await getSession(sid);
    if(!session){ sid=await createSession(); session=await getSession(sid); res.cookie(sessionCookieName(),sid,cookieOptions()); }
    if(!session.csrf){session.csrf=crypto.randomBytes(24).toString('base64url'); await setSessionCsrf(sid,session.csrf);}
    req.sessionId=sid;
    req.session=session;
    req.user=session.user_id?await getUserById(session.user_id):null;
    res.locals.user=req.user;
    res.locals.isLoggedIn=Boolean(req.user);
    next();
  } catch(error) { next(error); }
}
export function cookieOptions() { return {httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/',maxAge:1000*60*60*24*14}; }
export async function login(req,res,userId) { const oldSession=req.session; const newSid=await createSession(userId); await setSessionUser(newSid,userId); await setSessionCsrf(newSid,crypto.randomBytes(24).toString('base64url')); await saveSessionCart(newSid,oldSession?.cart||[]);
  await saveSessionWishlist(newSid,oldSession?.wishlist||[]); await saveSessionCoupon(newSid,oldSession?.coupon||null); await destroySession(req.sessionId); res.cookie(sessionCookieName(),newSid,cookieOptions()); }
export async function logout(req,res) { await destroySession(req.sessionId); res.clearCookie(sessionCookieName(),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/'}); }
export function requireAuth(req,res,next) { if(!req.user) return res.redirect('/login?next='+encodeURIComponent(req.originalUrl)); next(); }
export function requireManager(req,res,next) { if(!req.user) return res.redirect('/login?next='+encodeURIComponent(req.originalUrl)); if(!['manager','admin'].includes(req.user.role)) return res.status(403).render('error',{title:'Access denied',message:'You do not have permission to open this page.'}); next(); }
const DUMMY_HASH=scryptHash('dummy-login-password-not-used');
export async function authenticate(email,password) { const row=await getUserAuthByEmail(String(email||'').trim().toLowerCase()); const valid=verifyPassword(String(password||''),row?.password_hash || DUMMY_HASH); if(!row||!valid) return null; return {id:row.id,email:row.email,role:row.role}; }
