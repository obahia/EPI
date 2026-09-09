// Phase H UI end-to-end: the support console and the customer's own view of vendor access,
// in a real browser, against a production build and the real epi-dev database.
//
// Same reasoning as scripts/e2e-phase-g-ui.mjs for why this is a script and not a CI spec:
// the Playwright job runs with no .env and no secrets on purpose (finding TST-01), and
// authenticating a browser would mean putting real project credentials into CI.
//
// Phase G is why this exists at all. There, every text assertion passed while the action
// column of both tables sat outside the visible area behind a horizontal scrollbar --
// innerText contains clipped text just the same. These are two more new pages with tables in
// panels, so they get looked at, not just queried.
//
// Requires a PRODUCTION build already listening on http://127.0.0.1:3000, and a build made
// BEFORE the server started: rebuilding under a running server replaces .next while the old
// process serves the old asset hashes, and the page then loads with no CSS or JS -- a state
// that silently passes assertions like these.
//
// Run: node --env-file=.env scripts/e2e-phase-h-ui.mjs

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  console.error('Missing Supabase env. Run with: node --env-file=.env scripts/e2e-phase-h-ui.mjs');
  process.exit(1);
}

const SUPER_EMAIL = 'e2e-selo-platform-super@example.com';
const SUPPORT_EMAIL = 'e2e-selo-platform-support@example.com';
const TENANT_ADMIN_EMAIL = 'e2e-selo-closure-audit@example.com';
const SHOTS = 'playwright-report/phase-h-ui';

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' -- ' + label + (detail ? `  (${detail})` : ''));
  if (!cond) failures += 1;
}

const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function identity(email) {
  const password = crypto.randomBytes(18).toString('base64url');
  const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  const found = list.users.find((u) => u.email === email);
  if (!found) throw new Error(`${email} does not exist -- run scripts/e2e-phase-h.mjs first`);
  const { error: e } = await admin.auth.admin.updateUserById(found.id, { password });
  if (e) throw new Error(`updateUserById: ${e.message}`);
  return { id: found.id, email, password };
}

async function signIn(context, { email, password }) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  return page;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const superAdmin = await identity(SUPER_EMAIL);
  const support = await identity(SUPPORT_EMAIL);
  const tenantAdmin = await identity(TENANT_ADMIN_EMAIL);

  // Start from no live grant, through the RPCs -- cleanup is not what is under test.
  const api = createClient(url, publishableKey, { auth: { persistSession: false } });
  await api.auth.signInWithPassword({ email: superAdmin.email, password: superAdmin.password });
  const supportApi = createClient(url, publishableKey, { auth: { persistSession: false } });
  await supportApi.auth.signInWithPassword({ email: support.email, password: support.password });
  const { data: existing } = await supportApi.schema('api').rpc('my_platform_grants');
  for (const g of existing ?? []) {
    if (!g.revoked_at && new Date(g.expires_at) > new Date()) {
      await api.schema('api').rpc('revoke_platform_access', { p_grant_id: g.grant_id });
    }
  }

  const browser = await chromium.launch();

  // -----------------------------------------------------------------------------------
  // A customer is not shown that a support console exists at all.
  // -----------------------------------------------------------------------------------
  const tenantContext = await browser.newContext();
  const tenantPage = await signIn(tenantContext, tenantAdmin);
  await tenantPage.goto(`${BASE}/plataforma`);
  await tenantPage.waitForLoadState('networkidle');
  check(
    'an ordinary customer opening /plataforma is sent away, with no hint the console exists',
    !tenantPage.url().includes('/plataforma'),
    tenantPage.url(),
  );

  // -----------------------------------------------------------------------------------
  // Staff, with no grant.
  // -----------------------------------------------------------------------------------
  const supportContext = await browser.newContext();
  const supportPage = await signIn(supportContext, support);
  await supportPage.goto(`${BASE}/plataforma`);
  await supportPage.waitForLoadState('networkidle');
  await supportPage.screenshot({ path: `${SHOTS}/1-console-no-grant.png`, fullPage: true });

  const noGrantText = await supportPage.locator('body').innerText();
  check('the console renders for a platform admin', supportPage.url().includes('/plataforma'), supportPage.url());
  check(
    'and says plainly that being on the team is not access',
    noGrantText.includes('não dá acesso a dado nenhum'),
    noGrantText.slice(0, 200),
  );

  // -----------------------------------------------------------------------------------
  // The SUPER issues the grant through the form.
  // -----------------------------------------------------------------------------------
  const superContext = await browser.newContext();
  const superPage = await signIn(superContext, superAdmin);
  await superPage.goto(`${BASE}/plataforma`);
  await superPage.waitForLoadState('networkidle');

  const granteeOptions = await superPage.locator('select[name="adminUserId"] option').allTextContents();
  check(
    'the grant form does not offer the granter themselves -- four eyes reads as a rule, not an error',
    !granteeOptions.some((t) => t.includes('Super')),
    granteeOptions.join(' | '),
  );

  const REASON = 'verificacao de UI do console de suporte em ambiente de desenvolvimento';
  await superPage.selectOption('select[name="adminUserId"]', { index: 1 });
  await superPage.selectOption('select[name="organizationId"]', { index: 1 });
  await superPage.fill('textarea[name="reason"]', REASON);
  await superPage.fill('input[name="ticketRef"]', 'E2E-UI-H');
  await superPage.selectOption('select[name="ttlHours"]', '1');
  await superPage.getByRole('button', { name: 'Conceder' }).click();
  await superPage.waitForLoadState('networkidle');
  await superPage.screenshot({ path: `${SHOTS}/2-grant-issued.png`, fullPage: true });

  // -----------------------------------------------------------------------------------
  // The grantee now has somewhere to go.
  // -----------------------------------------------------------------------------------
  await supportPage.goto(`${BASE}/plataforma`);
  await supportPage.waitForLoadState('networkidle');
  await supportPage.screenshot({ path: `${SHOTS}/3-console-with-grant.png`, fullPage: true });

  const grantsSection = supportPage.locator('section, div').filter({ hasText: 'Meus acessos' }).first();
  const orgLink = supportPage.locator('a[href^="/plataforma/"]').first();
  check(
    'the grant appears in the grantee’s console as a link into the tenant',
    (await orgLink.count()) > 0,
    (await grantsSection.innerText().catch(() => '')).slice(0, 200),
  );

  await orgLink.click();
  await supportPage.waitForURL(/\/plataforma\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await supportPage.waitForLoadState('networkidle');
  await supportPage.screenshot({ path: `${SHOTS}/4-tenant-under-grant.png`, fullPage: true });

  const tenantViewText = await supportPage.locator('body').innerText();
  check('the tenant page opens under the grant', supportPage.url().includes('/plataforma/'), supportPage.url());
  check(
    'and shows the counts, including the admin count that reveals a lockout',
    // PanelKicker renders uppercase via CSS, and innerText returns what is RENDERED.
    tenantViewText.toLowerCase().includes('admins da organização'),
  );
  check('with the tenant’s own audit trail', tenantViewText.includes('Trilha de auditoria'));
  check(
    'and no CPF anywhere on the page',
    !/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(tenantViewText),
  );

  // Every column of both tables must be reachable -- the Phase G defect.
  for (const [label, selector] of [['every table on the tenant page', 'table']]) {
    const overflowing = await supportPage.evaluate((sel) => {
      const tables = Array.from(document.querySelectorAll(sel));
      return tables.some((t) => {
        const box = t.closest('[data-slot="table-container"]');
        return box ? box.scrollWidth > box.clientWidth + 1 : false;
      });
    }, selector);
    check(`${label} fits its panel -- no action column hidden behind a horizontal scrollbar`, !overflowing);
  }

  // -----------------------------------------------------------------------------------
  // The customer's own view.
  // -----------------------------------------------------------------------------------
  await tenantPage.goto(`${BASE}/settings/acesso-do-suporte`);
  await tenantPage.waitForLoadState('networkidle');
  await tenantPage.screenshot({ path: `${SHOTS}/5-customer-transparency.png`, fullPage: true });

  const customerText = await tenantPage.locator('body').innerText();
  check(
    'the customer sees the grant on their own settings page',
    customerText.includes(SUPPORT_EMAIL),
    customerText.slice(0, 200),
  );
  check('with the reason they are entitled to read', customerText.includes(REASON));
  check('who approved it', customerText.includes('E2E Platform Super'));
  check(
    'and whether it was actually used, not merely authorised',
    customerText.includes('Nunca usado') || /\d+×/.test(customerText),
  );

  const customerOverflow = await tenantPage.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('[data-slot="table-container"]'));
    return boxes.some((b) => b.scrollWidth > b.clientWidth + 1);
  });
  check('and that table fits its panel too', !customerOverflow);

  await browser.close();
  console.log(`\nScreenshots in ${SHOTS}/`);
  console.log(`\n=== PHASE H UI E2E: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message);
  process.exit(1);
});
