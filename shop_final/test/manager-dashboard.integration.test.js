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
  assert.match(await deploymentOriginLogin.text(), /Invalid email or password\./);

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
  assert.match(await requestHostOriginLogin.text(), /Invalid email or password\./);

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
  assert.match(await projectDeploymentOriginLogin.text(), /Invalid email or password\./);

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
  assert.match(await canonicalShopOriginLogin.text(), /Invalid email or password\./);

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
  assert.match(await rejectedOrigin.text(), /Invalid email or password\./);

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

  const customerEmail = 'customer-smoke@example.test';
  const customerPassword = 'Customer-strong-test-password-2026';
  const registrationPage = await fetch(`${base}/login?mode=register`);
  const registrationCsrf = (await registrationPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  const registrationCookie = registrationPage.headers.get('set-cookie')?.split(';')[0];
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