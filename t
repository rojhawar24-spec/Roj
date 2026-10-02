[1mdiff --git a/shop_final/src/db.js b/shop_final/src/db.js[m
[1mindex 8f21799..10b0485 100644[m
[1m--- a/shop_final/src/db.js[m
[1m+++ b/shop_final/src/db.js[m
[36m@@ -8,7 +8,7 @@[m [mimport { normalizeProductDiscountPercent, applyPercentDiscountCents } from './pr[m
 const __filename = fileURLToPath(import.meta.url);[m
 const __dirname = path.dirname(__filename);[m
 const root = path.resolve(__dirname, '..');[m
[31m-const dataDir = path.join(root, 'data');[m
[32m+[m[32mconst dataDir = process.env.VERCEL === '1' ? '/tmp/universal-shop-data' : path.join(root, 'data');[m
 fs.mkdirSync(dataDir, { recursive: true });[m
 [m
 const db = new Database(path.join(dataDir, 'shop.db'));[m
