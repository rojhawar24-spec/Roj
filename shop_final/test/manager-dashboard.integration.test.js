import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.SHOP_DATABASE_URL = ':memory:';
process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.TURSO_DATABASE_URL = ':memory:';
process.env.TURSO_AUTH_TOKEN = 'test-only-token';
process.env.VERCEL_URL = 'shop-deployment.vercel.app';
process.env.ADMIN_EMAIL = 'manager-smoke@example.test';
process.env.ADMIN_PASSWORD = `Smoke-${crypto.randomBytes(24).toString('hex')}-Safe`;
process.env.BASE_URL = 'https://shop.example.test';

const { db } = await import('../src/database.js');
const data = await import('../src/db.js');
const { hashPassword, sessionCookieName } = await import('../src/auth.js');
await data.createUser(process.env.ADMIN_EMAIL, hashPassword('Old-manager-password-before-reset'), 'customer');
const { default: app } = await import('../api/index.js');

test('bootstrapped manager can sign in and open dashboard', async t => {
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const forwardedLogin = await fetch(`${base}/login`, {
    headers: {
      Forwarded: 'for=203.0.113.8;proto=https;host=roj-shop.vercel.app',
      'x-forwarded-for': '203.0.113.8'
    }
  });
  assert.equal(forwardedLogin.status, 200);

  const invalidCsrf = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'invalid-token', email: 'invalid@example.test', password: 'Not-a-real-password-123' })
  });
  assert.equal(invalidCsrf.status, 403);
  assert.match(await invalidCsrf.text(), /security token is missing or invalid/i);

  const originLoginPage = await fetch(`${base}/login`);
  const originLoginHtml = await originLoginPage.text();
  const originCsrf = originLoginHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const originCookie = originLoginPage.headers.get('set-cookie')?.split(';')[0];
  const deploymentOriginLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: originCookie,
      origin: 'https://shop-deployment.vercel.app'
    },
    body: new URLSearchParams({ _csrf: originCsrf, email: 'origin-smoke@example.test', password: 'Not-a-real-password-123' })
  });
  assert.equal(deploymentOriginLogin.status, 200);
  const deploymentOriginLoginHtml = await deploymentOriginLogin.text();
  assert.match(deploymentOriginLoginHtml, /Email or password does not match/);
  assert.match(deploymentOriginLoginHtml, /value="origin-smoke@example\.test"/);

  const previousDeploymentUrl = process.env.VERCEL_URL;
  delete process.env.VERCEL_URL;
  const requestHostOriginLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: originCookie,
      origin: base
    },
    body: new URLSearchParams({ _csrf: originCsrf, email: 'origin-smoke@example.test', password: 'Not-a-real-password-123' })
  });
  process.env.VERCEL_URL = previousDeploymentUrl;
  assert.equal(requestHostOriginLogin.status, 200);
  assert.match(await requestHostOriginLogin.text(), /Email or password does not match/);

  const projectDeploymentOriginLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: originCookie,
      origin: 'https://roj-shop-49gwcuugo-rojhawar24-specs-projects.vercel.app'
    },
    body: new URLSearchParams({ _csrf: originCsrf, email: 'origin-smoke@example.test', password: 'Not-a-real-password-123' })
  });
  assert.equal(projectDeploymentOriginLogin.status, 200);
  assert.match(await projectDeploymentOriginLogin.text(), /Email or password does not match/);

  const canonicalShopOriginLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: originCookie,
      origin: 'https://roj-shop.vercel.app'
    },
    body: new URLSearchParams({ _csrf: originCsrf, email: 'origin-smoke@example.test', password: 'Not-a-real-password-123' })
  });
  assert.equal(canonicalShopOriginLogin.status, 200);
  assert.match(await canonicalShopOriginLogin.text(), /Email or password does not match/);

  const rejectedOrigin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: originCookie,
      origin: 'https://attacker.example'
    },
    body: new URLSearchParams({ _csrf: originCsrf, email: 'origin-smoke@example.test', password: 'Not-a-real-password-123' })
  });
  assert.equal(rejectedOrigin.status, 200);
  assert.match(await rejectedOrigin.text(), /Email or password does not match/);

  const crossSiteWithoutCsrf = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: originCookie,
      origin: 'https://attacker.example'
    },
    body: new URLSearchParams({ _csrf: 'invalid-token', email: 'origin-smoke@example.test', password: 'Not-a-real-password-123' })
  });
  assert.equal(crossSiteWithoutCsrf.status, 403);
  assert.match(await crossSiteWithoutCsrf.text(), /security token is missing or invalid/i);

  const anonymousDashboard = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(anonymousDashboard.status, 302);
  assert.equal(anonymousDashboard.headers.get('location'), '/login?next=%2Fadmin');

  const loginPage = await fetch(`${base}/login`);
  const csrf = (await loginPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  const initialCookie = loginPage.headers.get('set-cookie')?.split(';')[0];
  assert.ok(csrf);
  assert.ok(initialCookie);

  const loginResponse = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: initialCookie
    },
    body: new URLSearchParams({
      _csrf: csrf,
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD
    }),
    redirect: 'manual'
  });
  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), '/admin');

  const managerCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(managerCookie);
  const dashboard = await fetch(`${base}/admin`, { headers: { cookie: managerCookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Your store, at a glance\./);

  const productPage = await fetch(`${base}/admin/products/new`, { headers: { cookie: managerCookie } });
  assert.equal(productPage.status, 200);
  const productHtml = await productPage.text();
  assert.match(productHtml, /name="salePrice"/);
  assert.match(productHtml, /SKU \(optional\)/);
  assert.match(productHtml, /More options/);
  const productCsrf = productHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const productName = 'Temporary manager product';
  const productForm = new FormData();
  for (const [key,value] of Object.entries({
    _csrf: productCsrf,
    name: productName,
    sku: '',
    categoryId: '',
    shortDescription: 'Product flow integration test',
    description: 'Temporary product created and deleted by the integration test.',
    tags: 'test',
    price: '12.34',
    salePrice: '',
    automaticDiscountPercent: '0',
    saleStart: '',
    saleEnd: '',
    stock: '2',
    imageUrl: '',
    active: 'on'
  })) productForm.set(key,value);
  productForm.set('image',new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])],{type:'image/png'}),'smoke.png');
  const invalidProductForm = new FormData();
  for (const [key,value] of productForm.entries()) invalidProductForm.append(key,value);
  invalidProductForm.set('salePrice','99.99');
  const rejectedProduct = await fetch(`${base}/admin/products/save`, {
    method: 'POST',
    headers: { cookie: managerCookie },
    body: invalidProductForm,
    redirect: 'manual'
  });
  assert.equal(rejectedProduct.status,400);
  const rejectedHtml = await rejectedProduct.text();
  assert.match(rejectedHtml,/value="12\.34"/);
  assert.match(rejectedHtml,/value="99\.99"/);
  assert.match(rejectedHtml,/Sale price must be greater than zero and lower than the regular price\./);
  const saveProduct = await fetch(`${base}/admin/products/save`, {
    method: 'POST',
    headers: { cookie: managerCookie },
    body: productForm,
    redirect: 'manual'
  });
  assert.equal(saveProduct.status, 302);
  assert.equal(saveProduct.headers.get('location'), '/admin/products');
  const productQuery = await db.execute({ sql: 'SELECT id,image_url,sku,slug FROM products WHERE name=?', args: [productName] });
  const createdProduct = productQuery.rows[0];
  assert.ok(createdProduct);
  assert.match(createdProduct.sku,/^TEMPORARY-MANAGER-PRODUCT(?:-\d+)?$/);
  assert.match(createdProduct.image_url,/^\/uploads\/[a-f0-9]{32}\.png$/);
  for (const route of ['/', '/shop', `/product/${createdProduct.slug}`, '/admin/products']) {
    const renderedPage = await fetch(`${base}${route}`, { headers: { cookie: managerCookie } });
    assert.equal(renderedPage.status,200,`${route} should render with a product in the catalog`);
  }
  const uploadedImage = await fetch(`${base}${createdProduct.image_url}`);
  assert.equal(uploadedImage.status,200);
  assert.equal(uploadedImage.headers.get('content-type'),'image/png');
  assert.deepEqual([...new Uint8Array(await uploadedImage.arrayBuffer())],[137,80,78,71,13,10,26,10,0,0,0,0]);
  await db.execute({ sql: 'DELETE FROM uploaded_assets WHERE path=?', args: [createdProduct.image_url] });
  await db.execute({ sql: 'DELETE FROM audit_logs WHERE target_type=? AND target_id=?', args: ['product',String(createdProduct.id)] });
  await data.deleteProduct(Number(createdProduct.id));

  const customerEmail = 'customer-smoke@example.test';
  const customerPassword = 'Customer-strong-test-password-2026';
  const registrationPage = await fetch(`${base}/register`);
  const registrationHtml = await registrationPage.text();
  assert.match(registrationHtml,/Create a customer account/);
  assert.match(registrationHtml,/action="\/register"/);
  assert.match(registrationHtml,/Use at least 12 characters/);
  const registrationCsrf = registrationHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const registrationCookie = registrationPage.headers.get('set-cookie')?.split(';')[0];
  const invalidRegistration = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: registrationCookie },
    body: new URLSearchParams({ _csrf: registrationCsrf, email: customerEmail, password: 'short' })
  });
  assert.equal(invalidRegistration.status,200);
  const invalidRegistrationHtml = await invalidRegistration.text();
  assert.match(invalidRegistrationHtml,/password with at least 12 characters/);
  assert.match(invalidRegistrationHtml,/value="customer-smoke@example\.test"/);
  const registration = await fetch(`${base}/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: registrationCookie
    },
    body: new URLSearchParams({ _csrf: registrationCsrf, email: customerEmail, password: customerPassword }),
    redirect: 'manual'
  });
  assert.equal(registration.status, 302);
  assert.equal(registration.headers.get('location'), '/account');
  const registeredAccount = await fetch(`${base}/account`, {
    headers: { cookie: registration.headers.get('set-cookie')?.split(';')[0] }
  });
  assert.equal(registeredAccount.status, 200);
  assert.match(await registeredAccount.text(), /customer-smoke@example\.test/);

  const duplicateRegistrationPage = await fetch(`${base}/register`);
  const duplicateRegistrationCsrf = (await duplicateRegistrationPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  const duplicateRegistrationCookie = duplicateRegistrationPage.headers.get('set-cookie')?.split(';')[0];
  const duplicateRegistration = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: duplicateRegistrationCookie },
    body: new URLSearchParams({ _csrf: duplicateRegistrationCsrf, email: customerEmail, password: customerPassword })
  });
  assert.equal(duplicateRegistration.status,200);
  assert.match(await duplicateRegistration.text(),/An account with this email already exists\. Sign in instead\./);

  const customerLoginPage = await fetch(`${base}/login?next=%2Fadmin`);
  const customerCsrf = (await customerLoginPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  const customerInitialCookie = customerLoginPage.headers.get('set-cookie')?.split(';')[0];
  const customerLogin = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: customerInitialCookie
    },
    body: new URLSearchParams({
      _csrf: customerCsrf,
      email: customerEmail,
      password: customerPassword,
      next: '/admin'
    }),
    redirect: 'manual'
  });
  assert.equal(customerLogin.status, 302);
  assert.equal(customerLogin.headers.get('location'), '/account');

  const customerSession = customerLogin.headers.get('set-cookie')?.split(';')[0];
  const customerDashboard = await fetch(`${base}/admin`, {
    headers: { cookie: customerSession || `${sessionCookieName()}=invalid` },
    redirect: 'manual'
  });
  assert.equal(customerDashboard.status, 403);
});