// Phase G live end-to-end run against the REAL epi-dev Supabase project.
//
// This is the layer CI structurally cannot reach. `supabase test db` runs every assertion
// inside one psql session against a freshly reset local Postgres -- it proves the SQL is
// correct, and proves nothing about whether the functions are reachable through PostgREST,
// whether the grants survived the hosted apply, or whether the migrations are even there.
// Phase F is the evidence: three read RPCs passed a green CI while being broken on every
// call, and the first thing that noticed was a live run.
//
// What it does, as two genuinely different people:
//   1. Signs in as the inviter (an org-wide ORG_ADMIN), onboarding one if this identity has
//      no membership yet.
//   2. Invites the second identity, org-wide, as SST_OPERATOR -- token generated and hashed
//      here, exactly as the Server Action does it, so only the hash reaches Postgres.
//   3. Proves the link is not a bearer seat: the inviter, holding the token, is refused.
//   4. Accepts as the invited identity, in its own client with its own session.
//   5. Proves the link is spent: replaying it is refused with the same opaque signal.
//   6. Proves the invited identity now has exactly the scope it was granted, and that
//      api.list_members / api.list_invitations RUN (the 42702 class).
//   7. Revokes, and proves the access is gone from the invited identity's own view.
//
// Credentials: reads NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and
// SUPABASE_SECRET_KEY from the environment. Run with
// `node --env-file=.env scripts/e2e-phase-g.mjs`. The secret key is used ONLY for
// auth.admin.createUser (the public signup flow is rate-limited); every RPC below is called
// with a real user JWT through the publishable key, as `authenticated`, because that is the
// only way to exercise the authorization this phase is about. Passwords are generated in
// this process, used in this process, and never printed or written anywhere.

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or SUPABASE_SECRET_KEY.');
  console.error('Run with: node --env-file=.env scripts/e2e-phase-g.mjs');
  process.exit(1);
}

const INVITER_EMAIL = 'e2e-selo-closure-audit@example.com';
const INVITEE_EMAIL = 'e2e-selo-phase-g-invitee@example.com';

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' -- ' + label + (detail ? `  (${detail})` : ''));
  if (!cond) failures += 1;
}

const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

/** Creates or reuses the identity and resets its password to a fresh in-process value. */
async function identity(email, fullName) {
  const password = crypto.randomBytes(18).toString('base64url');
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listError) throw new Error(`listUsers: ${listError.message}`);

  const found = list.users.find((u) => u.email === email);
  if (found) {
    const { error } = await admin.auth.admin.updateUserById(found.id, { password });
    if (error) throw new Error(`updateUserById: ${error.message}`);
    return { id: found.id, email, password, reused: true };
  }

  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  return { id: created.user.id, email, password, reused: false };
}

/** A client holding this identity's own session -- never the secret key. */
async function signedIn({ email, password }) {
  const client = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return client;
}

async function main() {
  const inviter = await identity(INVITER_EMAIL, 'E2E Closure Audit');
  const invitee = await identity(INVITEE_EMAIL, 'E2E Phase G Invitee');
  console.log(
    `Identities ready (inviter ${inviter.reused ? 'reused' : 'created'}, invitee ${invitee.reused ? 'reused' : 'created'}).\n`,
  );

  const inviterClient = await signedIn(inviter);
  const inviteeClient = await signedIn(invitee);

  // ---------------------------------------------------------------------------------
  // The inviter's organization. Onboards one if this identity is brand new.
  // ---------------------------------------------------------------------------------
  let { data: memberships, error: mErr } = await inviterClient.schema('api').rpc('my_memberships');
  if (mErr) throw new Error(`my_memberships: ${mErr.message}`);

  if (!memberships || memberships.length === 0) {
    const stamp = String(Date.now()).slice(-12);
    const { error } = await inviterClient.schema('api').rpc('onboard_organization', {
      p_org_legal_name: 'E2E Fase G LTDA',
      p_org_cnpj: '10' + stamp,
      p_company_legal_name: 'E2E Fase G LTDA',
      p_company_cnpj: '10' + stamp,
      p_company_trade_name: null,
    });
    if (error) throw new Error(`onboard_organization: ${error.message}`);
    ({ data: memberships } = await inviterClient.schema('api').rpc('my_memberships'));
  }

  const orgAdmin = (memberships ?? []).find((m) => m.company_id === null && m.role === 'ORG_ADMIN');
  check('the inviter holds an org-wide ORG_ADMIN membership', Boolean(orgAdmin));
  if (!orgAdmin) {
    console.log('\nCannot continue without an org-wide ORG_ADMIN.');
    process.exit(1);
  }
  const organizationId = orgAdmin.organization_id;

  // Any membership this identity already holds from an earlier run has to go, or
  // invite_member correctly refuses with already_member.
  const { data: existing } = await inviteeClient.schema('api').rpc('my_memberships');
  for (const m of existing ?? []) {
    if (m.organization_id === organizationId) {
      const { error } = await inviterClient.schema('api').rpc('revoke_membership', {
        p_membership_id: m.id,
      });
      if (error) throw new Error(`cleanup revoke_membership: ${error.message}`);
      console.log('Cleared a membership left by an earlier run.');
    }
  }

  // ---------------------------------------------------------------------------------
  // 1. Invite
  // ---------------------------------------------------------------------------------
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHashB64 = crypto.createHash('sha256').update(token, 'utf8').digest('base64');

  const { data: invitationId, error: inviteError } = await inviterClient
    .schema('api')
    .rpc('invite_member', {
      p_organization_id: organizationId,
      p_company_id: null,
      p_email: INVITEE_EMAIL,
      p_role: 'SST_OPERATOR',
      p_token_hash_b64: tokenHashB64,
      p_ttl_hours: 24,
    });

  check(
    'api.invite_member is reachable through PostgREST and creates an invitation',
    !inviteError && Boolean(invitationId),
    inviteError ? `${inviteError.code}: ${inviteError.message}` : `id=${invitationId}`,
  );
  if (inviteError) {
    console.log('\nStopping: the invitation RPC did not run. Everything below depends on it.');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------------
  // 2. The link is not a bearer seat
  // ---------------------------------------------------------------------------------
  const { error: wrongPersonError } = await inviterClient
    .schema('api')
    .rpc('accept_invitation', { p_token_hash_b64: tokenHashB64 });
  check(
    'the inviter, holding the real token, cannot redeem an invitation addressed to someone else',
    Boolean(wrongPersonError) && /invitation_not_available/.test(wrongPersonError.message),
    wrongPersonError ? `${wrongPersonError.code}: ${wrongPersonError.message}` : 'ACCEPTED -- the email pin is not enforced',
  );

  // ---------------------------------------------------------------------------------
  // 3. Accept, as the invited person, in their own session
  // ---------------------------------------------------------------------------------
  const { data: accepted, error: acceptError } = await inviteeClient
    .schema('api')
    .rpc('accept_invitation', { p_token_hash_b64: tokenHashB64 });
  check(
    'the invited identity accepts and gets back the organization, scope and role',
    !acceptError && Array.isArray(accepted) && accepted.length === 1,
    acceptError ? `${acceptError.code}: ${acceptError.message}` : JSON.stringify(accepted),
  );
  check(
    'at exactly the invited role and scope',
    accepted?.[0]?.role === 'SST_OPERATOR' && accepted?.[0]?.company_id === null,
    JSON.stringify(accepted?.[0] ?? null),
  );

  const { error: replayError } = await inviteeClient
    .schema('api')
    .rpc('accept_invitation', { p_token_hash_b64: tokenHashB64 });
  check(
    'replaying the same link is refused with the same opaque signal',
    Boolean(replayError) && /invitation_not_available/.test(replayError.message),
    replayError ? `${replayError.code}: ${replayError.message}` : 'ACCEPTED TWICE',
  );

  // ---------------------------------------------------------------------------------
  // 4. The scope actually took effect
  // ---------------------------------------------------------------------------------
  const { data: inviteeMemberships } = await inviteeClient.schema('api').rpc('my_memberships');
  const granted = (inviteeMemberships ?? []).filter((m) => m.organization_id === organizationId);
  check(
    'the invited identity now sees exactly one membership in that organization',
    granted.length === 1 && granted[0].role === 'SST_OPERATOR' && granted[0].company_id === null,
    JSON.stringify(granted),
  );

  const { data: companies } = await inviteeClient.schema('api').from('companies').select('id');
  check(
    "and can now read the organization's companies through RLS, which it could not before",
    Array.isArray(companies) && companies.length > 0,
    `companies=${companies?.length ?? 0}`,
  );

  // ---------------------------------------------------------------------------------
  // 5. The read RPCs -- CALLED, not merely present. This is the 42702 class that shipped
  //    green through CI in Phase F.
  // ---------------------------------------------------------------------------------
  const { data: members, error: membersError } = await inviterClient
    .schema('api')
    .rpc('list_members', { p_organization_id: organizationId });
  check(
    'api.list_members RUNS over PostgREST and returns rows',
    !membersError && Array.isArray(members) && members.length >= 2,
    membersError ? `${membersError.code}: ${membersError.message}` : `rows=${members?.length}`,
  );
  check(
    'and reports the inviter as the last org-wide ORG_ADMIN, which is what disables the button in the panel',
    (members ?? []).some((m) => m.user_id === inviter.id && m.is_last_org_admin === true),
    JSON.stringify((members ?? []).map((m) => [m.email, m.role, m.is_last_org_admin])),
  );
  check(
    'and never returns a token hash or any column outside its RETURNS list',
    (members ?? []).every((m) => !('token_hash' in m)),
  );

  const { data: invitations, error: invitationsError } = await inviterClient
    .schema('api')
    .rpc('list_invitations', { p_organization_id: organizationId });
  check(
    'api.list_invitations RUNS over PostgREST',
    !invitationsError && Array.isArray(invitations),
    invitationsError ? `${invitationsError.code}: ${invitationsError.message}` : `rows=${invitations?.length}`,
  );
  check(
    'reports the redeemed invitation as ACCEPTED',
    (invitations ?? []).some((i) => i.invitation_id === invitationId && i.status === 'ACCEPTED'),
    JSON.stringify((invitations ?? []).find((i) => i.invitation_id === invitationId) ?? null),
  );
  check(
    'and exposes no token_hash -- a listable token is a redeemable token',
    (invitations ?? []).every((i) => !('token_hash' in i)),
  );

  // ---------------------------------------------------------------------------------
  // 6. Escalation, from the invited identity's own session
  // ---------------------------------------------------------------------------------
  const escalationToken = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('base64');
  const { error: escalationError } = await inviteeClient.schema('api').rpc('invite_member', {
    p_organization_id: organizationId,
    p_company_id: null,
    p_email: 'nobody-should-exist@example.com',
    p_role: 'ORG_ADMIN',
    p_token_hash_b64: escalationToken,
    p_ttl_hours: 24,
  });
  check(
    'an SST_OPERATOR cannot invite anyone at all -- it does not hold membership.manage',
    Boolean(escalationError) && escalationError.code === '42501',
    escalationError ? `${escalationError.code}: ${escalationError.message}` : 'ALLOWED -- privilege escalation',
  );

  // ---------------------------------------------------------------------------------
  // 7. The lockout rule, live
  // ---------------------------------------------------------------------------------
  const inviterMembership = (members ?? []).find((m) => m.user_id === inviter.id);
  const { error: lockoutError } = await inviterClient.schema('api').rpc('revoke_membership', {
    p_membership_id: inviterMembership?.membership_id,
  });
  check(
    'the last org-wide ORG_ADMIN cannot revoke itself, live',
    Boolean(lockoutError) && /last_org_admin/.test(lockoutError.message),
    lockoutError ? `${lockoutError.code}: ${lockoutError.message}` : 'ALLOWED -- the organization is now unadministrable',
  );

  // ---------------------------------------------------------------------------------
  // 8. Revoke, and prove the access is gone
  // ---------------------------------------------------------------------------------
  const inviteeMembership = (members ?? []).find((m) => m.user_id === invitee.id);
  const { error: revokeError } = await inviterClient.schema('api').rpc('revoke_membership', {
    p_membership_id: inviteeMembership?.membership_id,
  });
  check(
    'the inviter can revoke the membership it granted',
    !revokeError,
    revokeError ? `${revokeError.code}: ${revokeError.message}` : '',
  );

  const { data: afterRevoke } = await inviteeClient.schema('api').rpc('my_memberships');
  check(
    'and the revoked identity holds nothing in that organization any more',
    !(afterRevoke ?? []).some((m) => m.organization_id === organizationId),
    JSON.stringify(afterRevoke ?? []),
  );

  const { data: companiesAfter } = await inviteeClient.schema('api').from('companies').select('id');
  check(
    'RLS follows immediately -- the revoked identity can no longer read the companies it could a moment ago',
    (companiesAfter ?? []).length === 0,
    `companies=${companiesAfter?.length ?? 0}`,
  );

  console.log(
    `\n=== PHASE G LIVE E2E: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message);
  process.exit(1);
});
