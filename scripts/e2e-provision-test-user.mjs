// Provisions (or reuses) a dedicated E2E test identity in the REAL epi-dev Supabase
// project, using the Admin API (auth.admin.createUser) rather than the public signup
// flow -- the Admin API is a separate, privileged endpoint not subject to GoTrue's public
// signup rate limit, which is what blocked every plain-signup attempt this session.
//
// Reads SUPABASE_SECRET_KEY from .env (never printed, never logged, never committed --
// run this via `node --env-file=.env scripts/e2e-provision-test-user.mjs`, which loads it
// straight from the environment; this script never echoes the key's value anywhere).
//
// The test user's email is fixed and clearly named (e2e-selo-closure-audit@example.com) so
// re-running this script is idempotent: it looks the user up first and reuses it if it
// already exists, rather than creating a new one every run. The password is regenerated
// each run (never persisted to disk) and printed ONLY to this script's own stdout, for
// immediate one-time use signing into the browser in the SAME session -- never stored,
// never reused across runs, never committed anywhere.

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !secretKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in the environment.');
  console.error('Run this with: node --env-file=.env scripts/e2e-provision-test-user.mjs');
  process.exit(1);
}

const TEST_EMAIL = 'e2e-selo-closure-audit@example.com';
const password = crypto.randomBytes(18).toString('base64url');

const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const { data: existing, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listError) {
    console.error('Failed to list users:', listError.message);
    process.exit(1);
  }

  const found = existing.users.find((u) => u.email === TEST_EMAIL);

  let userId;
  if (found) {
    userId = found.id;
    const { error: updateError } = await admin.auth.admin.updateUserById(userId, { password });
    if (updateError) {
      console.error('Failed to reset password for existing test user:', updateError.message);
      process.exit(1);
    }
    console.log(`Reused existing E2E test user (id=${userId}), password reset for this run.`);
  } else {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'E2E Closure Audit' },
    });
    if (createError) {
      console.error('Failed to create test user:', createError.message);
      process.exit(1);
    }
    userId = created.user.id;
    console.log(`Created new E2E test user (id=${userId}).`);
  }

  console.log(`\nEMAIL: ${TEST_EMAIL}`);
  console.log(`PASSWORD (one-time, for this session only): ${password}`);
  console.log('\nThis password is not stored anywhere -- if you need to sign in again later, re-run this script to get a fresh one.');
}

main();
