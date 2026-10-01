import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProductDiscountPercent, applyPercentDiscountCents } from './pricing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const dataDir = process.env.VERCEL === '1' ? '/tmp/universal-shop-data' : path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','manager','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  cart_json TEXT NOT NULL DEFAULT '[]',
  wishlist_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  csrf_token TEXT,
  coupon_code TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  short_description TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  sale_price_cents INTEGER CHECK(sale_price_cents IS NULL OR sale_price_cents >= 0),
  sale_start TEXT,
  sale_end TEXT,
  automatic_discount_percent INTEGER NOT NULL DEFAULT 0 CHECK(automatic_discount_percent >= 0 AND automatic_discount_percent <= 90),
  sku TEXT NOT NULL UNIQUE,
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  reserved_stock INTEGER NOT NULL DEFAULT 0 CHECK(reserved_stock >= 0),
  category_id INTEGER,
  tags TEXT NOT NULL DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at);
CREATE INDEX IF NOT EXISTS idx_products_featured_active ON products(featured, active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_role_created ON users(role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL CHECK(type IN ('percent','fixed')),
  value INTEGER NOT NULL CHECK(value > 0),
  min_subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK(min_subtotal_cents >= 0),
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  product_id INTEGER,
  published_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_window ON stories(active, published_at, expires_at);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','processing','shipped','completed','cancelled')),
  payment_provider TEXT NOT NULL DEFAULT 'stripe',
  payment_reference TEXT,
  client_token TEXT UNIQUE,
  subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents >= 0),
  automatic_discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(automatic_discount_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
  total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR',
  shipping_name TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  shipping_city TEXT NOT NULL,
  shipping_postal_code TEXT NOT NULL,
  shipping_country TEXT NOT NULL DEFAULT 'BE',
  shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK(shipping_cents >= 0),
  customer_note TEXT NOT NULL DEFAULT '',
  terms_accepted_at TEXT,
  reservation_expires_at TEXT,
  payment_url TEXT,
  confirmation_email_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_email_created ON orders(email, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_reference ON orders(payment_reference) WHERE payment_reference IS NOT NULL;
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
  total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
`);

// Settings writer must exist before startup migrations use it. Keep this declaration
// immediately after schema creation to avoid a temporal-dead-zone failure at startup.
const upsertSetting = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

// Backward-compatible migrations for fields added after the original checkout schema.
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(r => r.name);
if (!orderColumns.includes('customer_phone')) db.exec("ALTER TABLE orders ADD COLUMN customer_phone TEXT NOT NULL DEFAULT ''");
if (!orderColumns.includes('automatic_discount_cents')) db.exec("ALTER TABLE orders ADD COLUMN automatic_discount_cents INTEGER NOT NULL DEFAULT 0");
if (!orderColumns.includes('confirmation_email_sent_at')) db.exec("ALTER TABLE orders ADD COLUMN confirmation_email_sent_at TEXT");

// Small forward-only migrations for databases created by earlier versions.
// Only skip a migration when the target column already exists; real SQL errors are allowed to fail loudly.
const forwardMigrations = [
  { table:'products', column:'reserved_stock', sql:'ALTER TABLE products ADD COLUMN reserved_stock INTEGER NOT NULL DEFAULT 0' },
  { table:'sessions', column:'wishlist_json', sql:"ALTER TABLE sessions ADD COLUMN wishlist_json TEXT NOT NULL DEFAULT '[]'" },
  { table:'sessions', column:'coupon_code', sql:'ALTER TABLE sessions ADD COLUMN coupon_code TEXT' },
  { table:'orders', column:'reservation_expires_at', sql:'ALTER TABLE orders ADD COLUMN reservation_expires_at TEXT' },
  { table:'orders', column:'shipping_country', sql:"ALTER TABLE orders ADD COLUMN shipping_country TEXT NOT NULL DEFAULT 'BE'" },
  { table:'orders', column:'shipping_cents', sql:"ALTER TABLE orders ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0" },
  { table:'orders', column:'customer_note', sql:"ALTER TABLE orders ADD COLUMN customer_note TEXT NOT NULL DEFAULT ''" },
  { table:'orders', column:'terms_accepted_at', sql:'ALTER TABLE orders ADD COLUMN terms_accepted_at TEXT' },
  { table:'orders', column:'payment_url', sql:'ALTER TABLE orders ADD COLUMN payment_url TEXT' },
  { table:'orders', column:'confirmation_email_sent_at', sql:'ALTER TABLE orders ADD COLUMN confirmation_email_sent_at TEXT' },
  { table:'products', column:'automatic_discount_percent', sql:'ALTER TABLE products ADD COLUMN automatic_discount_percent INTEGER NOT NULL DEFAULT 0 CHECK(automatic_discount_percent >= 0 AND automatic_discount_percent <= 90)' }
];
for (const migration of forwardMigrations) {
  const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all();
  if (!columns.some(c => c.name === migration.column)) db.exec(migration.sql);
}

if (getSetting('prices_include_tax','') === '') {
  upsertSetting.run('prices_include_tax', process.env.PRICES_INCLUDE_TAX === 'true' ? '1' : '0');
}

// One-time migration from the old storewide setting to each existing product.
// This preserves a previously configured promotion while moving control to per-product discounts.
if (getSetting('legacy_storewide_discount_migrated','0') !== '1') {
  const legacy = Number(getSetting('automatic_discount_percent','0'));
  const safeLegacy = normalizeProductDiscountPercent(legacy);
  if (safeLegacy > 0) db.prepare('UPDATE products SET automatic_discount_percent=? WHERE automatic_discount_percent=0').run(safeLegacy);
  upsertSetting.run('legacy_storewide_discount_migrated', '1');
}

const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const escapeLike = value => String(value ?? '').replace(/!/g,'!!').replace(/%/g,'!%').replace(/_/g,'!_');

if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('store_name')) upsertSetting.run('store_name', process.env.STORE_NAME || 'ShopEasy');
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('currency')) upsertSetting.run('currency', process.env.STORE_CURRENCY || 'EUR');
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('ai_enabled')) upsertSetting.run('ai_enabled', '0');

if (process.env.SEED_DEMO_DATA === 'true' && db.prepare('SELECT COUNT(*) AS c FROM categories').get().c === 0) {
  const insert = db.prepare('INSERT INTO categories(name,slug) VALUES(?,?)');
  for (const name of ['New arrivals', 'Electronics', 'Fashion', 'Home', 'Beauty']) insert.run(name, slugify(name));
}
if (process.env.SEED_DEMO_DATA === 'true' && db.prepare('SELECT COUNT(*) AS c FROM products').get().c === 0) {
  const category = (slug) => db.prepare('SELECT id FROM categories WHERE slug=?').get(slug)?.id || null;
  const insert = db.prepare(`INSERT INTO products(name,slug,short_description,description,image_url,price_cents,sale_price_cents,sale_start,sale_end,sku,stock,category_id,tags,featured,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const start = new Date(Date.now() - 2 * 86400000).toISOString();
  const end = new Date(Date.now() + 10 * 86400000).toISOString();
  insert.run('Astra Everyday Backpack','astra-everyday-backpack','A clean everyday carry for work, study and travel.','A versatile everyday backpack designed around a simple silhouette, practical organization and comfortable carry.','/assets/product-1.svg',8900,6900,start,end,'ASTRA-001',24,category('fashion'),'bag,travel,work',1,1);
  insert.run('Nova Desk Lamp','nova-desk-lamp','Warm, adjustable light for focused work.','A minimal desk light with an adjustable angle and a soft warm mode for evenings.','/assets/product-2.svg',5900,null,null,null,'NOVA-002',40,category('home'),'desk,home,light',1,1);
  insert.run('Core Stainless Bottle','core-stainless-bottle','Simple, durable and made for daily use.','A reusable stainless bottle with a clean shape and an everyday carry size.','/assets/product-3.svg',3200,2790,null,null,'CORE-003',60,category('fashion'),'bottle,travel',0,1);
  insert.run('Studio Cable Kit','studio-cable-kit','An organized kit for everyday devices.','A compact cable kit for home and travel organization.','/assets/product-4.svg',2490,null,null,null,'STUDIO-004',18,category('electronics'),'desk,tech',1,1);
}

export function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
export function createSession(userId = null, maxAgeMs = 1000 * 60 * 60 * 24 * 14) {
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(id, userId, Date.now(), Date.now() + maxAgeMs);
  return id;
}
export function getSession(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?').get(id, Date.now());
  if (!row) return null;
  let cart = [];
  try {
    cart = JSON.parse(row.cart_json || '[]');
    if (!Array.isArray(cart)) cart = [];
  } catch { cart = []; }
  let wishlist = [];
  try { wishlist = JSON.parse(row.wishlist_json || '[]'); if (!Array.isArray(wishlist)) wishlist=[]; } catch { wishlist=[]; }
  return { ...row, cart, wishlist, coupon: row.coupon_code || null, csrf: row.csrf_token || null };
}
export function setSessionCsrf(id, token) { db.prepare('UPDATE sessions SET csrf_token=? WHERE id=?').run(token, id); }
export function saveSessionCart(id, cart) {
  const safeCart = (Array.isArray(cart) ? cart : []).filter(x => Number.isInteger(x?.productId) && x.productId > 0 && Number.isInteger(x?.quantity) && x.quantity > 0).slice(0, 50);
  db.prepare('UPDATE sessions SET cart_json=?, expires_at=? WHERE id=?').run(JSON.stringify(safeCart), Date.now() + 1000 * 60 * 60 * 24 * 14, id);
}
export function saveSessionWishlist(id, wishlist) {
  const safeWishlist = [...new Set((Array.isArray(wishlist) ? wishlist : []).map(Number).filter(Number.isInteger).filter(n => n > 0))].slice(0, 50);
  db.prepare('UPDATE sessions SET wishlist_json=?, expires_at=? WHERE id=?').run(JSON.stringify(safeWishlist), Date.now() + 1000 * 60 * 60 * 24 * 14, id);
}
export function saveSessionCoupon(id, couponCode) {
  const safe = couponCode ? String(couponCode).trim().toUpperCase().slice(0,40) : null;
  db.prepare('UPDATE sessions SET coupon_code=?, expires_at=? WHERE id=?').run(safe, Date.now() + 1000 * 60 * 60 * 24 * 14, id);
}
export function setSessionUser(id, userId) { db.prepare('UPDATE sessions SET user_id=?, expires_at=? WHERE id=?').run(userId, Date.now() + 1000 * 60 * 60 * 24 * 14, id); }
export function destroySession(id) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); }

export function getUserById(id) { return db.prepare('SELECT id,email,role,created_at FROM users WHERE id=?').get(id); }
export function getUserAuthByEmail(email) { return db.prepare('SELECT * FROM users WHERE email=?').get(email); }
export function updateUserPassword(userId,passwordHash) { return db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,userId).changes===1; }
export function destroyUserSessionsExcept(userId,keepSessionId) { db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(userId,keepSessionId||''); }
export function createUser(email, passwordHash, role='customer') { return db.prepare('INSERT INTO users(email,password_hash,role) VALUES(?,?,?)').run(email, passwordHash, role).lastInsertRowid; }
export function listCustomers({limit=50, offset=0, search=''}={}) {
  const params={};
  const conditions=["u.role='customer'"];
  if(search){ const like=`%${escapeLike(String(search).trim().slice(0,120))}%`; conditions.push("(u.email LIKE @likeSearch ESCAPE '!')"); params.likeSearch=like; }
  params.limit=Math.min(Math.max(Number(limit)||50,1),200); params.offset=Math.max(Number(offset)||0,0);
  return db.prepare(`SELECT u.id,u.email,u.created_at,COUNT(o.id) AS order_count,COALESCE(SUM(CASE WHEN o.status IN ('paid','processing','shipped','completed') THEN o.total_cents ELSE 0 END),0) AS lifetime_value_cents,
    (SELECT o2.customer_phone FROM orders o2 WHERE o2.user_id=u.id AND o2.customer_phone<>'' ORDER BY o2.created_at DESC LIMIT 1) AS phone,
    (SELECT o3.shipping_city FROM orders o3 WHERE o3.user_id=u.id ORDER BY o3.created_at DESC LIMIT 1) AS last_city,
    (SELECT o4.shipping_country FROM orders o4 WHERE o4.user_id=u.id ORDER BY o4.created_at DESC LIMIT 1) AS last_country
    FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE ${conditions.join(' AND ')} GROUP BY u.id ORDER BY u.created_at DESC LIMIT @limit OFFSET @offset`).all(params);
}
export function countCustomers(search='') {
  if(!search) return Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='customer'").get().c||0);
  return Number(db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='customer' AND email LIKE ? ESCAPE '!'").get(`%${escapeLike(String(search).trim().slice(0,120))}%`).c||0);
}
export function getDashboardStats() {
  const products = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN active=1 AND stock-reserved_stock<=0 THEN 1 ELSE 0 END) AS sold_out FROM products').get();
  const orders = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, COALESCE(SUM(CASE WHEN status IN ('paid','processing','shipped','completed') THEN total_cents ELSE 0 END),0) AS revenue FROM orders`).get();
  const customers = db.prepare("SELECT COUNT(*) AS total FROM users WHERE role='customer'").get();
  const stories = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN active=1 AND datetime(published_at)<=datetime('now') AND datetime(expires_at)>=datetime('now') THEN 1 ELSE 0 END) AS live FROM stories").get();
  return { products, orders, customers, stories };
}

export function listCategories() { return db.prepare('SELECT * FROM categories ORDER BY name').all(); }
export function createCategory(name, slug) { return Number(db.prepare('INSERT INTO categories(name,slug) VALUES(?,?)').run(name,slug).lastInsertRowid); }
export function updateCategory(id, name, slug) { const changed=db.prepare('UPDATE categories SET name=?,slug=? WHERE id=?').run(name,slug,id).changes; if(changed!==1) throw new Error('NOT_FOUND'); return Number(id); }
export function deleteCategory(id) { db.prepare('DELETE FROM categories WHERE id=?').run(id); }
export function listProducts({search='', category='', sort='featured', onlyActive=true, featured=false, limit=48, offset=0} = {}) {
  const conditions = [];
  const params = {};
  if (onlyActive) conditions.push('p.active=1');
  if (search) {
    const tokens = search.split(/\s+/).filter(Boolean).slice(0,6);
    const clauses=[];
    for (const token of tokens) {
      const paramName=`term${clauses.length}`;
      clauses.push(`(p.name LIKE @${paramName} ESCAPE '!' OR p.short_description LIKE @${paramName} ESCAPE '!' OR p.description LIKE @${paramName} ESCAPE '!' OR p.tags LIKE @${paramName} ESCAPE '!' OR p.sku LIKE @${paramName} ESCAPE '!')`);
      params[paramName]=`%${escapeLike(token)}%`;
    }
    if (clauses.length) conditions.push(`(${clauses.join(' AND ')})`);
  }
  if (category) { conditions.push('c.slug=@category'); params.category = category; }
  if (featured) conditions.push('p.featured=1');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const basePriceSql = `CASE WHEN p.sale_price_cents IS NOT NULL AND p.sale_price_cents<p.price_cents AND (p.sale_start IS NULL OR p.sale_start<=datetime('now')) AND (p.sale_end IS NULL OR p.sale_end>=datetime('now')) THEN p.sale_price_cents ELSE p.price_cents END`;
  const availablePriceSql = `CASE WHEN (${basePriceSql}) > 0 AND p.automatic_discount_percent > 0 THEN MAX(1, CAST((${basePriceSql}) * (100-p.automatic_discount_percent) / 100 AS INTEGER)) ELSE (${basePriceSql}) END`;
  const sortMap={featured:'p.featured DESC,p.created_at DESC',newest:'p.created_at DESC',price_low:'available_price ASC,p.created_at DESC',price_high:'available_price DESC,p.created_at DESC',name:'p.name COLLATE NOCASE ASC,p.created_at DESC'};
  const order=sortMap[sort]||sortMap.featured;
  params.limit = Math.min(Math.max(Number(limit) || 48, 1), 500);
  params.offset = Math.max(Number(offset) || 0, 0);
  return db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug, MAX(p.stock-p.reserved_stock,0) AS available_stock, ${availablePriceSql} AS available_price FROM products p LEFT JOIN categories c ON c.id=p.category_id ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all(params);
}
export function countProducts({search='', category='', onlyActive=true} = {}) {
  const conditions=[]; const params={};
  if (onlyActive) conditions.push('p.active=1');
  if (search) { const tokens=search.split(/\s+/).filter(Boolean).slice(0,6); const clauses=[]; for (const token of tokens){ const key=`t${clauses.length}`; clauses.push(`(p.name LIKE @${key} ESCAPE '!' OR p.short_description LIKE @${key} ESCAPE '!' OR p.description LIKE @${key} ESCAPE '!' OR p.tags LIKE @${key} ESCAPE '!' OR p.sku LIKE @${key} ESCAPE '!')`); params[key]=`%${escapeLike(token)}%`; } if(clauses.length) conditions.push(`(${clauses.join(' AND ')})`); }
  if(category){conditions.push('c.slug=@category');params.category=category;}
  const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM products p LEFT JOIN categories c ON c.id=p.category_id ${where}`).get(params).c||0);
}

export function getProductBySlug(slug) { return db.prepare('SELECT p.*, c.name AS category_name, c.slug AS category_slug, MAX(p.stock-p.reserved_stock,0) AS available_stock FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.slug=?').get(slug); }
export function getProductById(id) { return db.prepare('SELECT p.*, MAX(p.stock-p.reserved_stock,0) AS available_stock FROM products p WHERE p.id=?').get(id); }
export function getActiveStories(limit=24) {
  const safeLimit=Math.min(Math.max(Number(limit)||24,1),100);
  return db.prepare(`SELECT s.*, p.name AS product_name, p.slug AS product_slug FROM stories s LEFT JOIN products p ON p.id=s.product_id
    WHERE s.active=1 AND datetime(s.published_at)<=datetime('now') AND datetime(s.expires_at)>=datetime('now') ORDER BY s.published_at DESC LIMIT ?`).all(safeLimit);
}
export function listStories(limit=100) { return db.prepare('SELECT s.*, p.name AS product_name FROM stories s LEFT JOIN products p ON p.id=s.product_id ORDER BY s.published_at DESC LIMIT ?').all(Math.min(Math.max(Number(limit)||100,1),500)); }
export function getStory(id) { return db.prepare('SELECT * FROM stories WHERE id=?').get(id); }
export function listCoupons(limit=500) { return db.prepare('SELECT * FROM coupons ORDER BY active DESC, code LIMIT ?').all(Math.min(Math.max(Number(limit)||500,1),1000)); }
export function getCoupon(code) { return db.prepare(`SELECT * FROM coupons WHERE code=? AND active=1 AND (expires_at IS NULL OR expires_at>?)`).get(code.trim().toUpperCase(), new Date().toISOString()); }
export function getCouponById(id) { return db.prepare('SELECT * FROM coupons WHERE id=?').get(id); }
export function adminCreateOrUpdateCoupon(data) {
  const values = [data.code.toUpperCase(), data.type, data.value, data.minSubtotalCents, data.expiresAt || null, data.active ? 1 : 0];
  if (data.id) {
    const changed=db.prepare('UPDATE coupons SET code=?,type=?,value=?,min_subtotal_cents=?,expires_at=?,active=? WHERE id=?').run(...values, data.id).changes;
    if(changed!==1) throw new Error('NOT_FOUND');
    return Number(data.id);
  }
  return Number(db.prepare('INSERT INTO coupons(code,type,value,min_subtotal_cents,expires_at,active) VALUES(?,?,?,?,?,?)').run(...values).lastInsertRowid);
}
export function deleteCoupon(id) { db.prepare('DELETE FROM coupons WHERE id=?').run(id); }
export function getSetting(key, fallback='') { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback; }
export function getProductDiscountPercent(product) { return normalizeProductDiscountPercent(product?.automatic_discount_percent); }
export function setSetting(key, value) { upsertSetting.run(key, value); }
export function createAudit(userId, action, targetType, targetId, meta={}) { db.prepare('INSERT INTO audit_logs(user_id,action,target_type,target_id,meta_json) VALUES(?,?,?,?,?)').run(userId,action,targetType,targetId ? String(targetId) : null,JSON.stringify(meta)); }
export function listAuditLogs(limit=150) { return db.prepare(`SELECT a.*,u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT ?`).all(limit); }
export function listOrders({limit=100,offset=0,search='',status=''}={}) {
  const conditions=[]; const params={};
  if(search){conditions.push("(CAST(o.id AS TEXT)=@search OR o.email LIKE @likeSearch ESCAPE '!' OR o.payment_reference LIKE @likeSearch ESCAPE '!')");params.search=search;params.likeSearch=`%${escapeLike(search)}%`;}
  if(status && ['pending','paid','processing','shipped','completed','cancelled'].includes(status)){conditions.push('o.status=@status');params.status=status;}
  const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
  params.limit=Math.min(Math.max(Number(limit)||100,1),200); params.offset=Math.max(Number(offset)||0,0);
  return db.prepare(`SELECT o.*, u.email AS account_email FROM orders o LEFT JOIN users u ON u.id=o.user_id ${where} ORDER BY o.created_at DESC LIMIT @limit OFFSET @offset`).all(params);
}
export function countOrders({search='',status=''}={}) {
  const conditions=[]; const params={};
  if(search){conditions.push("(CAST(o.id AS TEXT)=@search OR o.email LIKE @likeSearch ESCAPE '!' OR o.payment_reference LIKE @likeSearch ESCAPE '!')");params.search=search;params.likeSearch=`%${escapeLike(search)}%`;}
  if(status && ['pending','paid','processing','shipped','completed','cancelled'].includes(status)){conditions.push('o.status=@status');params.status=status;}
  const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM orders o ${where}`).get(params).c||0);
}
export function getOrderByClientToken(token) { return db.prepare('SELECT * FROM orders WHERE client_token=?').get(token); }
export function saveCheckoutSession(orderId, sessionId, paymentUrl) { return db.prepare("UPDATE orders SET payment_reference=?,payment_url=?,updated_at=datetime('now') WHERE id=? AND status='pending'").run(sessionId,paymentUrl,orderId).changes===1; }
export function markConfirmationEmailSent(orderId) { return db.prepare("UPDATE orders SET confirmation_email_sent_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND confirmation_email_sent_at IS NULL").run(orderId).changes===1; }
export function getOrder(id) { const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id); if (!order) return null; order.items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id); return order; }
export function listUserOrders(userId, limit=200) { return db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(userId, Math.min(Math.max(Number(limit)||200,1),500)); }

export function baseEffectivePrice(product, now = new Date()) {
  const nowIso = now.toISOString();
  const inWindow = (!product.sale_start || product.sale_start <= nowIso) && (!product.sale_end || product.sale_end >= nowIso);
  if (inWindow && product.sale_price_cents != null && product.sale_price_cents < product.price_cents) return product.sale_price_cents;
  return product.price_cents;
}

export function effectivePrice(product, now = new Date()) {
  const base = baseEffectivePrice(product, now);
  return applyPercentDiscountCents(base, getProductDiscountPercent(product));
}

export function releaseExpiredReservations() {
  const graceMinutes=Math.max(5,Math.min(60,Number(process.env.RESERVATION_RELEASE_GRACE_MINUTES||10)||10));
  const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000).toISOString();
  const expired = db.prepare("SELECT id FROM orders WHERE status='pending' AND reservation_expires_at IS NOT NULL AND reservation_expires_at<?").all(cutoff);
  for (const order of expired) cancelPendingOrder(order.id);
}

export function createOrderAtomic({userId, email, customerPhone='', items, shipping, shippingCents=0, customerNote='', currency='EUR', coupon=null, paymentProvider='stripe', clientToken, termsAcceptedAt, reservationMinutes=60}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('EMPTY_CART');
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(clientToken || '')) throw new Error('INVALID_IDEMPOTENCY');
  const grouped = new Map();
  for (const input of items) {
    const productId = Number(input?.productId);
    const quantity = Number(input?.quantity);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('INVALID_QUANTITY');
    grouped.set(productId, (grouped.get(productId) || 0) + quantity);
  }
  if ([...grouped.values()].some(q => q > 99)) throw new Error('INVALID_QUANTITY');
  const tx = db.transaction(() => {
    if (db.prepare('SELECT id FROM orders WHERE client_token=?').get(clientToken)) throw new Error('IDEMPOTENCY_EXISTS');
    const normalized = [];
    for (const [productId, quantity] of grouped) {
      const product = getProductById(productId);
      if (!product || !product.active) throw new Error('PRODUCT_UNAVAILABLE');
      const baseUnit = baseEffectivePrice(product);
      const unit = effectivePrice(product);
      normalized.push({product, quantity, baseUnit, unit, total: unit * quantity});
    }
    const subtotalBeforeAutomaticDiscount = normalized.reduce((sum, line) => sum + line.baseUnit * line.quantity, 0);
    const automaticDiscount = Math.max(0, subtotalBeforeAutomaticDiscount - normalized.reduce((sum, line) => sum + line.total, 0));
    const subtotal = subtotalBeforeAutomaticDiscount;
    let couponDiscount = 0;
    if (coupon) {
      const couponRow = getCoupon(coupon);
      if (!couponRow) throw new Error('INVALID_COUPON');
      const couponBase = subtotalBeforeAutomaticDiscount - automaticDiscount;
      if (couponBase < couponRow.min_subtotal_cents) throw new Error('COUPON_MINIMUM');
      couponDiscount = couponRow.type === 'percent' ? Math.floor(couponBase * couponRow.value / 100) : couponRow.value;
      couponDiscount = Math.min(couponDiscount, couponBase);
    }
    const safeShippingCents = Number.isInteger(shippingCents) && shippingCents>=0 ? shippingCents : 0;
    const total = subtotal - automaticDiscount - couponDiscount + safeShippingCents;
    const discount = couponDiscount;
    if (total <= 0) throw new Error('ZERO_TOTAL');
    const minutes=Number(reservationMinutes);
    if(!Number.isInteger(minutes)||minutes<30||minutes>1440) throw new Error('INVALID_RESERVATION');
    const reservationExpires = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const note=String(customerNote||'').slice(0,500);
    const phone=String(customerPhone||'').trim().slice(0,32);
    if(!/^\+?[0-9 ()-]{7,32}$/.test(phone)) throw new Error('INVALID_PHONE');
    const insertOrder = db.prepare(`INSERT INTO orders(user_id,email,customer_phone,status,payment_provider,client_token,subtotal_cents,automatic_discount_cents,discount_cents,total_cents,currency,shipping_name,shipping_address,shipping_city,shipping_postal_code,shipping_country,shipping_cents,customer_note,terms_accepted_at,reservation_expires_at,payment_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const info = insertOrder.run(userId,email,phone,'pending',paymentProvider,clientToken,subtotal,automaticDiscount,discount,total,currency,shipping.name,shipping.address,shipping.city,shipping.postalCode,shipping.country,safeShippingCents,note,termsAcceptedAt,reservationExpires,null);
    const orderId = Number(info.lastInsertRowid);
    const insertItem = db.prepare('INSERT INTO order_items(order_id,product_id,product_name,sku,quantity,unit_price_cents,total_cents) VALUES(?,?,?,?,?,?,?)');
    const reserve = db.prepare('UPDATE products SET reserved_stock=reserved_stock+?,updated_at=datetime(\'now\') WHERE id=? AND stock-reserved_stock>=?');
    for (const line of normalized) {
      if (reserve.run(line.quantity, line.product.id, line.quantity).changes !== 1) throw new Error('INSUFFICIENT_STOCK');
      insertItem.run(orderId,line.product.id,line.product.name,line.product.sku,line.quantity,line.unit,line.total);
    }
    return {orderId,subtotal,automaticDiscount,discount,shipping:safeShippingCents,total,items:normalized,reservationExpires};
  });
  return tx();
}

export function markOrderPaid(id, paymentReference) {
  const tx = db.transaction(() => {
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND status='pending'").get(id);
    if (!order) return false;
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id);
    const consume = db.prepare('UPDATE products SET stock=stock-?, reserved_stock=reserved_stock-?, updated_at=datetime(\'now\') WHERE id=? AND stock>=? AND reserved_stock>=?');
    for (const item of items) {
      if (consume.run(item.quantity,item.quantity,item.product_id,item.quantity,item.quantity).changes !== 1) throw new Error('STOCK_INTEGRITY');
    }
    db.prepare("UPDATE orders SET status='paid',payment_reference=?,reservation_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='pending'").run(paymentReference,id);
    return true;
  });
  return tx();
}

export function cancelPendingOrder(id) {
  const tx = db.transaction(() => {
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND status='pending'").get(id);
    if (!order) return false;
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id);
    const release = db.prepare('UPDATE products SET reserved_stock=CASE WHEN reserved_stock>=? THEN reserved_stock-? ELSE 0 END, updated_at=datetime(\'now\') WHERE id=?');
    for (const item of items) release.run(item.quantity,item.quantity,item.product_id);
    db.prepare("UPDATE orders SET status='cancelled',reservation_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='pending'").run(id);
    return true;
  });
  return tx();
}

export function setOrderStatus(id,status) {
  const allowed = {
    paid: new Set(['processing']),
    processing: new Set(['shipped']),
    shipped: new Set(['completed']),
    completed: new Set(),
    cancelled: new Set(),
    pending: new Set(['cancelled'])
  };
  const current = db.prepare('SELECT status FROM orders WHERE id=?').get(id)?.status;
  if (!current || !allowed[current]?.has(status)) return false;
  if (current === 'pending' && status === 'cancelled') return cancelPendingOrder(id);
  const changed = db.prepare('UPDATE orders SET status=?,updated_at=datetime(\'now\') WHERE id=? AND status=?').run(status,id,current);
  return changed.changes === 1;
}

export function adminCreateOrUpdateProduct(data) {
  const existingReserved = data.id ? Number(db.prepare('SELECT reserved_stock FROM products WHERE id=?').get(data.id)?.reserved_stock || 0) : 0;
  if (data.stock < existingReserved) throw new Error('RESERVED_STOCK');
  const discountPercent = normalizeProductDiscountPercent(data.automaticDiscountPercent);
  const values = [data.name,data.slug,data.shortDescription,data.description,data.imageUrl,data.priceCents,data.salePriceCents ?? null,data.saleStart || null,data.saleEnd || null,discountPercent,data.sku,data.stock,data.categoryId || null,data.tags,data.featured?1:0,data.active?1:0];
  if (data.id) {
    const changed=db.prepare(`UPDATE products SET name=?,slug=?,short_description=?,description=?,image_url=?,price_cents=?,sale_price_cents=?,sale_start=?,sale_end=?,automatic_discount_percent=?,sku=?,stock=?,category_id=?,tags=?,featured=?,active=?,updated_at=datetime('now') WHERE id=?`).run(...values,data.id).changes;
    if(changed!==1) throw new Error('NOT_FOUND');
    return Number(data.id);
  }
  return Number(db.prepare(`INSERT INTO products(name,slug,short_description,description,image_url,price_cents,sale_price_cents,sale_start,sale_end,automatic_discount_percent,sku,stock,category_id,tags,featured,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values).lastInsertRowid);
}
export function deleteProduct(id) { db.prepare('DELETE FROM products WHERE id=?').run(id); }
export function adminCreateOrUpdateStory(data) {
  const values = [data.title,data.body,data.imageUrl,data.linkUrl || '',data.productId || null,data.publishedAt,data.expiresAt,data.active?1:0];
  if (data.id) { const changed=db.prepare(`UPDATE stories SET title=?,body=?,image_url=?,link_url=?,product_id=?,published_at=?,expires_at=?,active=? WHERE id=?`).run(...values,data.id).changes; if(changed!==1) throw new Error('NOT_FOUND'); return Number(data.id); }
  return Number(db.prepare(`INSERT INTO stories(title,body,image_url,link_url,product_id,published_at,expires_at,active) VALUES(?,?,?,?,?,?,?,?)`).run(...values).lastInsertRowid);
}
export function deleteStory(id) { db.prepare('DELETE FROM stories WHERE id=?').run(id); }

export default db;
