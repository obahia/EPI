// Phase G UI end-to-end: drives the two screens this phase added, in a real browser,
// against a production build and the real epi-dev database.
//
// Why this is a script and not a spec under e2e/: the Playwright job in CI runs with NO
// .env and no Supabase secrets, deliberately (audit finding TST-01 -- every page that suite
// touches is unauthenticated, and a production build with zero env vars set is the
// CI-representative case worth proving). Putting real project credentials into CI to
// authenticate a browser would undo that decision for one spec. So this lives beside
// scripts/e2e-phase-g.mjs as a manual live-verification tool, run by a human with .env
// loaded, and reports what it found.
//
// scripts/e2e-phase-g.mjs already proved the RPCs. This proves the part that one could not:
// that the invitation link the panel actually renders is the link that actually works, that
// the acceptance screen refuses to consume the invitation on page load, and that a person
// who is not signed in gets somewhere they can act from.
//
// Run: node --env-file=.env scripts/e2e-phase-g-ui.mjs
// Requires a PRODUCTION build already listening on http://127.0.0.1:3000 -- `npm run build`
// then the `selo-prod` entry in .claude/launch.json. It must be a fresh build: rebuilding
// under a running server replaces .next while the old process still serves the old asset
// hashes, and the page then loads with no CSS or JS at all. That state silently passes every
// assertion here, because a JS-less form falls back to a plain POST with a full navigation --
// which is exactly the case that hides a stale-render bug. Restart the server after building.
//
// Passwords are generated in this process, typed into the browser by this process, and never
// printed or written anywhere.

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  console.error('Missing Supabase env. Run with: node --env-file=.env scripts/e2e-phase-g-ui.mjs');
  process.exit(1);
}

const INVITER_EMAIL = 'e2e-selo-closure-audit@example.com';
const INVITEE_EMAIL = 'e2e-selo-phase-g-invitee@example.com';
const SHOTS = 'playwright-report/phase-g-ui';

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' -- ' + label + (detail ? `  (${detail})` : ''));
  if (!cond) failures += 1;
}

const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function identity(email, fullName) {
  const password = crypto.randomBytes(18).toString('base64url');
  const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  const found = list.users.find((u) => u.email === email);
  if (found) {
    const { error: e } = await admin.auth.admin.updateUserById(found.id, { password });
    if (e) throw new Error(`updateUserById: ${e.message}`);
    return { id: found.id, email, password };
  }
  const { data: created, error: e } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (e) throw new Error(`createUser: ${e.message}`);
  return { id: created.user.id, email, password };
}

/** Signs in through the real login form, not by injecting a session. */
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

  const inviter = await identity(INVITER_EMAIL, 'E2E Closure Audit');
  const invitee = await identity(INVITEE_EMAIL, 'E2E Phase G Invitee');

  // Leave the tenant in the state this run expects, using the RPCs rather than the UI --
  // cleanup is not what is under test here.
  const cleanupClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await cleanupClient.auth.signInWithPassword({ email: inviter.email, password: inviter.password });
  const { data: myMemberships } = await cleanupClient.schema('api').rpc('my_memberships');
  const orgAdmin = (myMemberships ?? []).find((m) => m.company_id === null && m.role === 'ORG_ADMIN');
  if (!orgAdmin) throw new Error('the inviter has no org-wide ORG_ADMIN membership');
  const organizationId = orgAdmin.organization_id;

  const { data: existingMembers } = await cleanupClient
    .schema('api')
    .rpc('list_members', { p_organization_id: organizationId });
  for (const m of existingMembers ?? []) {
    if (m.user_id === invitee.id) {
      await cleanupClient.schema('api').rpc('revoke_membership', { p_membership_id: m.membership_id });
    }
  }
  const { data: existingInvites } = await cleanupClient
    .schema('api')
    .rpc('list_invitations', { p_organization_id: organizationId });
  for (const i of existingInvites ?? []) {
    if (i.email === INVITEE_EMAIL && i.status === 'OPEN') {
      await cleanupClient.schema('api').rpc('revoke_invitation', { p_invitation_id: i.invitation_id });
    }
  }

  const browser = await chromium.launch();

  // -----------------------------------------------------------------------------------
  // The inviter's session
  // -----------------------------------------------------------------------------------
  const inviterContext = await browser.newContext();
  const inviterPage = await signIn(inviterContext, inviter);

  await inviterPage.goto(`${BASE}/settings/team`);
  await inviterPage.waitForLoadState('networkidle');
  await inviterPage.screenshot({ path: `${SHOTS}/1-team-page.png`, fullPage: true });

  check(
    '/settings/team renders for an org-wide ORG_ADMIN',
    inviterPage.url().includes('/settings/team'),
    inviterPage.url(),
  );
  const teamText = await inviterPage.locator('body').innerText();
  check(
    'and lists the existing team, showing the inviter',
    teamText.includes(INVITER_EMAIL),
    teamText.includes(INVITER_EMAIL) ? '' : teamText.slice(0, 300),
  );
  check(
    'with the last org-wide admin marked as such rather than offered a remove button',
    teamText.includes('Último administrador'),
  );

  // The sidebar row this phase added, visible because this identity is an ORG_ADMIN.
  check(
    'the sidebar shows the Equipe row for an admin',
    (await inviterPage.locator('a[href="/settings/team"]').count()) > 0,
  );

  // -----------------------------------------------------------------------------------
  // Create the invitation THROUGH THE FORM, and take the link the panel renders
  // -----------------------------------------------------------------------------------
  await inviterPage.fill('input[name="email"]', INVITEE_EMAIL);
  await inviterPage.selectOption('select[name="role"]', 'SST_OPERATOR');
  await inviterPage.selectOption('select[name="companyId"]', '');
  await inviterPage.selectOption('select[name="ttlHours"]', '24');
  await inviterPage.getByRole('button', { name: 'Gerar convite' }).click();

  await inviterPage.waitForSelector('code', { timeout: 30_000 });
  await inviterPage.screenshot({ path: `${SHOTS}/2-invite-created.png`, fullPage: true });

  const link = (await inviterPage.locator('code').first().innerText()).trim();
  check(
    'the panel renders a one-time invitation link',
    /^https?:\/\/[^/]+\/convite\/[A-Za-z0-9_-]{43}$/.test(link),
    link.slice(0, 60),
  );

  const afterInvite = await inviterPage.locator('body').innerText();
  check(
    'and says plainly that Selo does not send the email itself',
    afterInvite.includes('ainda não envia e-mails'),
  );

  // -----------------------------------------------------------------------------------
  // The invited person, in a completely separate browser context
  // -----------------------------------------------------------------------------------
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();

  const path = new URL(link).pathname;
  await inviteePage.goto(`${BASE}${path}`);
  await inviteePage.waitForLoadState('networkidle');
  await inviteePage.screenshot({ path: `${SHOTS}/3-invitation-signed-out.png`, fullPage: true });

  const signedOutText = await inviteePage.locator('body').innerText();
  check(
    'an unauthenticated visitor gets somewhere they can act from, not a redirect into nothing',
    signedOutText.includes('Entrar') && signedOutText.includes('Criar conta'),
    signedOutText.slice(0, 200),
  );
  check(
    'and the page discloses nothing about the invitation -- no organization, role or inviter',
    !signedOutText.includes('SST_OPERATOR') && !signedOutText.includes('Operador'),
  );

  // Sign in through the link's own "Entrar" button, which must carry the invitation forward.
  await inviteePage.getByRole('link', { name: 'Entrar' }).click();
  await inviteePage.waitForURL(/\/login/, { timeout: 30_000 });
  check(
    'the sign-in link carries the invitation as ?next=',
    inviteePage.url().includes('next=') && inviteePage.url().includes('convite'),
    inviteePage.url(),
  );

  await inviteePage.fill('input[name="email"]', invitee.email);
  await inviteePage.fill('input[name="password"]', invitee.password);
  await inviteePage.click('button[type="submit"]');
  await inviteePage.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

  check(
    'and signing in lands back on the invitation, not on the dashboard',
    inviteePage.url().includes(path),
    inviteePage.url(),
  );
  await inviteePage.screenshot({ path: `${SHOTS}/4-invitation-signed-in.png`, fullPage: true });

  const signedInText = await inviteePage.locator('body').innerText();
  check(
    'the screen names the account being used, so a wrong-account acceptance is visible before the click',
    signedInText.includes(INVITEE_EMAIL),
  );

  // The invitation must still be OPEN: loading the page must not have consumed it.
  const { data: stillOpen } = await cleanupClient
    .schema('api')
    .rpc('list_invitations', { p_organization_id: organizationId });
  const thisInvite = (stillOpen ?? []).find((i) => i.email === INVITEE_EMAIL && i.status === 'OPEN');
  check(
    'loading the acceptance page did NOT consume the invitation -- accepting is a POST',
    Boolean(thisInvite),
    thisInvite ? '' : JSON.stringify((stillOpen ?? []).map((i) => [i.email, i.status])),
  );

  await inviteePage.getByRole('button', { name: 'Aceitar convite' }).click();
  await inviteePage.waitForURL(/\/dashboard/, { timeout: 30_000 });
  await inviteePage.screenshot({ path: `${SHOTS}/5-accepted-dashboard.png`, fullPage: true });
  check('accepting lands the new member on the dashboard', inviteePage.url().includes('/dashboard'));

  // An SST_OPERATOR does not hold membership.manage, so the row must not be there.
  check(
    'and the Equipe row is absent from a non-admin sidebar',
    (await inviteePage.locator('a[href="/settings/team"]').count()) === 0,
  );

  // -----------------------------------------------------------------------------------
  // Back in the inviter's panel
  // -----------------------------------------------------------------------------------
  await inviterPage.goto(`${BASE}/settings/team`);
  await inviterPage.waitForLoadState('networkidle');
  await inviterPage.screenshot({ path: `${SHOTS}/6-team-after-accept.png`, fullPage: true });

  const afterAccept = await inviterPage.locator('body').innerText();
  check('the new member appears in the team list', afterAccept.includes(INVITEE_EMAIL));
  check('and the invitation is now shown as accepted', afterAccept.includes('Aceito'));

  // Revoke through the UI.
  const membersSection = inviterPage.locator('section').first();
  const revokeButton = membersSection
    .locator('tr', { hasText: INVITEE_EMAIL })
    .getByRole('button', { name: 'Remover acesso' });
  check('the panel offers a remove button for a member the admin may revoke', (await revokeButton.count()) > 0);
  if ((await revokeButton.count()) > 0) {
    const memberRow = membersSection.locator('tr', { hasText: INVITEE_EMAIL }).first();
    await revokeButton.first().click();

    // Waits for the row to actually go, not for the network to fall quiet. `networkidle`
    // answers "the POST finished", not "the server component re-rendered", and the gap
    // between those two is exactly the bug this assertion would otherwise hide.
    let stillRendered = true;
    try {
      await memberRow.waitFor({ state: 'detached', timeout: 15_000 });
      stillRendered = false;
    } catch {}
    check('revoking through the UI updates the team list with no manual reload', !stillRendered);

    if (stillRendered) {
      await inviterPage.reload();
      await inviterPage.waitForLoadState('networkidle');
      const reloaded = await inviterPage.locator('body').innerText();
      const stillThere = reloaded.split('Convites')[0]?.includes(INVITEE_EMAIL);
      check('...but is gone after a manual reload -- a stale render, not a failed revoke', !stillThere);
    }

    await inviterPage.screenshot({ path: `${SHOTS}/7-team-after-revoke.png`, fullPage: true });
  }

  await browser.close();
  console.log(`\nScreenshots in ${SHOTS}/`);
  console.log(`\n=== PHASE G UI E2E: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message);
  process.exit(1);
});
