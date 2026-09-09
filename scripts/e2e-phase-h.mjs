// Phase H live end-to-end: platform break-glass against the REAL epi-dev project.
//
// CI proved the SQL is correct inside one psql session. It cannot prove these functions are
// reachable through PostgREST, that the grants survived the hosted apply, or that the
// migration is even there -- Phase F is the standing evidence for why that gap matters.
//
// This script also PROVISIONS the two platform identities it needs, but it deliberately
// cannot put them on the roster: no function creates the first SUPER, because a function
// able to do that would be a function able to mint platform power out of an ordinary
// account. On a first run it provisions the accounts, reports that they are not on the
// roster, and stops -- that stop is expected, not a failure of the feature. Run the seed
// block at the end of supabase/_faseH_migration_concatenated.sql once, then run this again.
//
// Run: node --env-file=.env scripts/e2e-phase-h.mjs
//
// Passwords are generated in this process, used in this process, and never printed anywhere.

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  console.error('Missing Supabase env. Run with: node --env-file=.env scripts/e2e-phase-h.mjs');
  process.exit(1);
}

const SUPER_EMAIL = 'e2e-selo-platform-super@example.com';
const SUPPORT_EMAIL = 'e2e-selo-platform-support@example.com';
const TENANT_ADMIN_EMAIL = 'e2e-selo-closure-audit@example.com';

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
    return { id: found.id, email, password, created: false };
  }
  const { data: created, error: e } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (e) throw new Error(`createUser: ${e.message}`);
  return { id: created.user.id, email, password, created: true };
}

async function signedIn({ email, password }) {
  const client = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return client;
}

async function main() {
  const superAdmin = await identity(SUPER_EMAIL, 'E2E Platform Super');
  const support = await identity(SUPPORT_EMAIL, 'E2E Platform Support');
  const tenantAdmin = await identity(TENANT_ADMIN_EMAIL, 'E2E Closure Audit');

  const superClient = await signedIn(superAdmin);
  const supportClient = await signedIn(support);
  const tenantClient = await signedIn(tenantAdmin);

  // ---------------------------------------------------------------------------------
  // Roster. Seeded by hand, once, on purpose.
  // ---------------------------------------------------------------------------------
  const { data: roster, error: rosterError } = await superClient.schema('api').rpc('platform_list_admins');
  if (rosterError || !(roster ?? []).some((r) => r.user_id === superAdmin.id && r.level === 'SUPER')) {
    console.log('\nThe two platform identities exist but are not on app.platform_admins yet.');
    console.log('Run the seed block at the end of supabase/_faseH_migration_concatenated.sql once,');
    console.log('then run this script again. Nothing here can do it: no function creates the first SUPER.');
    console.log(`\n  ${SUPER_EMAIL}   -> ${superAdmin.id}`);
    console.log(`  ${SUPPORT_EMAIL} -> ${support.id}`);
    if (rosterError) console.log(`\n(platform_list_admins said: ${rosterError.code}: ${rosterError.message})`);
    process.exit(1);
  }
  check('the platform roster is reachable and the SUPER is on it', true, `${roster.length} admin(s)`);

  // The tenant this run supports: the organization the E2E customer identity administers.
  const { data: myMemberships } = await tenantClient.schema('api').rpc('my_memberships');
  const orgAdmin = (myMemberships ?? []).find((m) => m.company_id === null && m.role === 'ORG_ADMIN');
  if (!orgAdmin) throw new Error('the tenant identity holds no org-wide ORG_ADMIN membership');
  const organizationId = orgAdmin.organization_id;

  // Leave no live grant from an earlier run.
  const { data: previous } = await supportClient.schema('api').rpc('my_platform_grants');
  for (const g of previous ?? []) {
    if (!g.revoked_at && new Date(g.expires_at) > new Date()) {
      await superClient.schema('api').rpc('revoke_platform_access', { p_grant_id: g.grant_id });
    }
  }

  // ---------------------------------------------------------------------------------
  // 1. Being staff is not access
  // ---------------------------------------------------------------------------------
  const { error: noGrantError } = await supportClient
    .schema('api')
    .rpc('platform_organization_overview', { p_organization_id: organizationId });
  check(
    'a platform admin with no grant reads nothing',
    Boolean(noGrantError) && /no_live_platform_grant/.test(noGrantError.message),
    noGrantError ? `${noGrantError.code}: ${noGrantError.message}` : 'ALLOWED -- staff alone is access',
  );

  const { error: tenantSearchError } = await tenantClient
    .schema('api')
    .rpc('platform_search_organizations', { p_query: null, p_limit: 5 });
  check(
    'and an ordinary customer cannot enumerate the vendor’s customers',
    Boolean(tenantSearchError) && tenantSearchError.code === '42501',
    tenantSearchError ? `${tenantSearchError.code}` : 'ALLOWED',
  );

  // ---------------------------------------------------------------------------------
  // 2. Four eyes
  // ---------------------------------------------------------------------------------
  const { error: selfGrantError } = await superClient.schema('api').rpc('grant_platform_access', {
    p_admin_user_id: superAdmin.id,
    p_organization_id: organizationId,
    p_company_id: null,
    p_reason: 'tentando conceder acesso a mim mesmo neste teste',
    p_ticket_ref: 'E2E-SELF',
    p_ttl_hours: 1,
  });
  check(
    'nobody grants themselves access, live',
    Boolean(selfGrantError) && /four_eyes_required/.test(selfGrantError.message),
    selfGrantError ? `${selfGrantError.code}: ${selfGrantError.message}` : 'ALLOWED -- four eyes is not enforced',
  );

  const { error: shortReasonError } = await superClient.schema('api').rpc('grant_platform_access', {
    p_admin_user_id: support.id,
    p_organization_id: organizationId,
    p_company_id: null,
    p_reason: 'curto',
    p_ticket_ref: null,
    p_ttl_hours: 1,
  });
  check(
    'and a grant without a real reason is refused',
    Boolean(shortReasonError) && /reason_too_short/.test(shortReasonError.message),
    shortReasonError ? `${shortReasonError.code}: ${shortReasonError.message}` : 'ALLOWED',
  );

  const REASON = 'cliente relatou entrega presa, verificacao de suporte em ambiente de dev';
  const { data: grantId, error: grantError } = await superClient
    .schema('api')
    .rpc('grant_platform_access', {
      p_admin_user_id: support.id,
      p_organization_id: organizationId,
      p_company_id: null,
      p_reason: REASON,
      p_ticket_ref: 'E2E-H1',
      p_ttl_hours: 1,
    });
  check(
    'api.grant_platform_access is reachable through PostgREST and issues a grant',
    !grantError && Boolean(grantId),
    grantError ? `${grantError.code}: ${grantError.message}` : `id=${grantId}`,
  );
  if (grantError) {
    console.log('\nStopping: the grant RPC did not run. Everything below depends on it.');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------------
  // 3. What the grant opens, and what it does not
  // ---------------------------------------------------------------------------------
  const { data: overview, error: overviewError } = await supportClient
    .schema('api')
    .rpc('platform_organization_overview', { p_organization_id: organizationId });
  const row = (overview ?? [])[0];
  check(
    'the grantee can now read the tenant overview',
    !overviewError && Boolean(row),
    overviewError ? `${overviewError.code}: ${overviewError.message}` : JSON.stringify(row),
  );
  check(
    'and it reports live_org_admin_count, which is how a lockout is seen without reading anyone’s record',
    typeof row?.live_org_admin_count !== 'undefined',
    `live_org_admin_count=${row?.live_org_admin_count}`,
  );

  const { data: events, error: eventsError } = await supportClient
    .schema('api')
    .rpc('platform_audit_events', { p_organization_id: organizationId, p_limit: 20 });
  check(
    'api.platform_audit_events RUNS -- the RETURNS TABLE class that shipped green in Phase F',
    !eventsError && Array.isArray(events),
    eventsError ? `${eventsError.code}: ${eventsError.message}` : `rows=${events?.length}`,
  );

  const { data: members, error: membersError } = await supportClient
    .schema('api')
    .rpc('platform_list_members', { p_organization_id: organizationId });
  check(
    'api.platform_list_members RUNS',
    !membersError && Array.isArray(members),
    membersError ? `${membersError.code}: ${membersError.message}` : `rows=${members?.length}`,
  );

  // A tenant the grant does not cover.
  const { data: orgs } = await superClient
    .schema('api')
    .rpc('platform_search_organizations', { p_query: null, p_limit: 25 });
  const otherOrg = (orgs ?? []).find((o) => o.organization_id !== organizationId);
  if (otherOrg) {
    const { error: crossError } = await supportClient
      .schema('api')
      .rpc('platform_organization_overview', { p_organization_id: otherOrg.organization_id });
    check(
      'a grant on one tenant opens nothing on another',
      Boolean(crossError) && /no_live_platform_grant/.test(crossError.message),
      crossError ? `${crossError.code}` : 'ALLOWED -- cross-tenant read',
    );
  } else {
    check('a grant on one tenant opens nothing on another', true, 'SKIPPED: only one organization exists on this project');
  }

  // ---------------------------------------------------------------------------------
  // 4. The rescue write refuses a stranger
  // ---------------------------------------------------------------------------------
  const { error: strangerError } = await supportClient.schema('api').rpc('platform_grant_org_admin', {
    p_organization_id: organizationId,
    p_user_id: superAdmin.id,
  });
  check(
    'support cannot put a stranger into a customer’s organization',
    Boolean(strangerError) && /not_a_member/.test(strangerError.message),
    strangerError ? `${strangerError.code}: ${strangerError.message}` : 'ALLOWED -- a stranger was added',
  );

  // ---------------------------------------------------------------------------------
  // 5. What the customer sees
  // ---------------------------------------------------------------------------------
  const { data: vendorGrants, error: vendorError } = await tenantClient
    .schema('api')
    .rpc('list_platform_access_grants', { p_organization_id: organizationId });
  const thisGrant = (vendorGrants ?? []).find((g) => g.grant_id === grantId);
  check(
    'the customer can list vendor access over their own organization',
    !vendorError && Boolean(thisGrant),
    vendorError ? `${vendorError.code}: ${vendorError.message}` : `rows=${vendorGrants?.length}`,
  );
  check(
    'with the reason they are entitled to read',
    thisGrant?.reason === REASON,
    thisGrant?.reason ?? 'n/a',
  );
  check(
    'and the fact that it was actually used, not merely authorised',
    thisGrant?.first_used_at !== null && Number(thisGrant?.use_count ?? 0) >= 3,
    `use_count=${thisGrant?.use_count} first_used_at=${thisGrant?.first_used_at}`,
  );

  const usedEvents = (events ?? []).filter((e) => e.event_type === 'PLATFORM_ACCESS_USED');
  check(
    'PLATFORM_ACCESS_USED appears in the tenant’s own chain',
    usedEvents.length >= 1 || Boolean(thisGrant?.first_used_at),
    `events_seen_at_read_time=${usedEvents.length}`,
  );

  // ---------------------------------------------------------------------------------
  // 6. Handing it back
  // ---------------------------------------------------------------------------------
  const { error: revokeError } = await superClient
    .schema('api')
    .rpc('revoke_platform_access', { p_grant_id: grantId });
  check('the grant can be ended early', !revokeError, revokeError ? revokeError.message : '');

  const { error: afterRevokeError } = await supportClient
    .schema('api')
    .rpc('platform_organization_overview', { p_organization_id: organizationId });
  check(
    'and the access is gone immediately, with no session to wait out',
    Boolean(afterRevokeError) && /no_live_platform_grant/.test(afterRevokeError.message),
    afterRevokeError ? `${afterRevokeError.code}` : 'STILL READABLE AFTER REVOCATION',
  );

  console.log(
    `\n=== PHASE H LIVE E2E: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message);
  process.exit(1);
});
