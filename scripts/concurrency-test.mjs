// Real-concurrency test for the two operations flagged in the A+B+C closure audit as
// needing genuine two-connection proof, not a sequential approximation:
//
//   1. Two deliveries racing to consume the LAST unit of stock (app.apply_stock_movement's
//      negative-balance guard) -- exactly one must succeed, the other must fail safely,
//      final balance must be exactly 0, exactly one ENTREGA movement must exist, and the
//      losing delivery must NOT be partially issued.
//   2. Two api.create_replacement_delivery calls racing against the SAME original delivery
//      -- exactly one must produce a valid replacement, the original must have exactly one
//      successor, the chain must be consistent, and the loser must get a stable domain
//      error (never the state-machine trigger's raw "row is frozen" message, per the
//      FOR UPDATE fix in 20260903130000_stock_location_transfer_gate_fixes.sql).
//
// This needs a REAL Postgres with two independent client connections -- PGlite (used
// elsewhere in this repo for fast local checks) is a single in-process WASM instance and
// cannot represent this at all. This script is designed to run against the ephemeral
// Postgres `supabase start` launches in CI (see .github/workflows/ci.yml's `database` job)
// -- connection info comes from env vars with the well-known local-dev defaults as
// fallback (these are Supabase CLI's own published local-only defaults, not secrets; the
// instance is only reachable on the CI runner's own localhost).
//
// Runs entirely as the Postgres superuser role the local stack's connection string
// authenticates as, using `set role authenticated` + `set_config('request.jwt.claims', ...)`
// per statement -- the exact same fixture technique this repo's pgTAP suite already uses
// (see e.g. supabase/tests/database/020_employee_isolation.sql), just over two REAL
// connections instead of pgTAP's single session.

import pg from 'pg';
import crypto from 'node:crypto';

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let failures = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' -- ' + label + (detail ? `  (${detail})` : ''));
  if (!cond) failures++;
}

async function newClient() {
  const client = new pg.Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  return client;
}

async function asUser(client, userId, sql, params = []) {
  await client.query('begin');
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  const res = await client.query(sql, params);
  await client.query('commit');
  return res;
}

async function main() {
  const setup = await newClient();

  const adminId = crypto.randomUUID();
  await setup.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user, is_anonymous)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, extensions.crypt('x', extensions.gen_salt('bf')), now(), '{}', '{"full_name":"Concurrency Test Admin"}', now(), now(), '', '', '', '', false, false)`,
    [adminId, `concurrency-${adminId}@selo-test.dev`],
  );

  const onboard = await asUser(
    setup,
    adminId,
    `select company_id from api.onboard_organization($1, $2, $1, $2, null)`,
    ['Concurrency Test LTDA', '10' + String(Date.now()).slice(-12)],
  );
  const companyId = onboard.rows[0].company_id;
  const orgRow = await setup.query('select organization_id from app.companies where id = $1', [companyId]);
  const orgId = orgRow.rows[0].organization_id;

  console.log('\n=== SCENARIO 1: last-unit stock race ===\n');
  await scenarioStockRace(setup, adminId, companyId, orgId);

  console.log('\n=== SCENARIO 2: concurrent replacement race ===\n');
  await scenarioReplacementRace(setup, adminId, companyId);

  await setup.end();
  console.log(`\n=== CONCURRENCY TEST: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenarioStockRace(setup, adminId, companyId, orgId) {
  await setup.query(`update app.organizations set inventory_enabled = true where id = $1`, [orgId]);

  const epi = await asUser(setup, adminId, `select api.create_epi($1, $2, 'Capacete Concorrência', '54321') as id`, [
    orgId,
    companyId,
  ]);
  const epiId = epi.rows[0].id;

  const cpfHashA = await setup.query(`select encode(extensions.digest('cpf-race-a', 'sha256'), 'base64') as v`);
  const cpfEncA = await setup.query(
    `select encode(decode('000000000000000000000000000000000000000000000000000000','hex') || 'fake-race-a'::bytea, 'base64') as v`,
  );
  const empA = await asUser(
    setup,
    adminId,
    `select api.create_employee($1, 'Funcionário Race A', $2, $3, '***.111.111-**') as id`,
    [companyId, cpfHashA.rows[0].v, cpfEncA.rows[0].v],
  );
  const employeeAId = empA.rows[0].id;

  const cpfHashB = await setup.query(`select encode(extensions.digest('cpf-race-b', 'sha256'), 'base64') as v`);
  const cpfEncB = await setup.query(
    `select encode(decode('000000000000000000000000000000000000000000000000000000','hex') || 'fake-race-b'::bytea, 'base64') as v`,
  );
  const empB = await asUser(
    setup,
    adminId,
    `select api.create_employee($1, 'Funcionário Race B', $2, $3, '***.222.222-**') as id`,
    [companyId, cpfHashB.rows[0].v, cpfEncB.rows[0].v],
  );
  const employeeBId = empB.rows[0].id;

  // Balance of exactly 1 unit -- the contested last unit.
  await asUser(setup, adminId, `select api.record_stock_movement($1, null, $2, null, 'ENTRADA', 1, 'estoque inicial', '{}')`, [
    companyId,
    epiId,
  ]);

  const items = JSON.stringify([{ epi_id: epiId, quantity: 1 }]);
  const delA = await asUser(
    setup,
    adminId,
    `select api.create_delivery($1, $2, current_date, null, $3::jsonb) as id`,
    [companyId, employeeAId, items],
  );
  const deliveryAId = delA.rows[0].id;
  const delB = await asUser(
    setup,
    adminId,
    `select api.create_delivery($1, $2, current_date, null, $3::jsonb) as id`,
    [companyId, employeeBId, items],
  );
  const deliveryBId = delB.rows[0].id;

  // The actual race: two REAL, independent Postgres connections, each issuing one of the
  // two deliveries, fired via Promise.all so both requests are in flight concurrently.
  const clientA = await newClient();
  const clientB = await newClient();

  const results = await Promise.allSettled([
    asUser(clientA, adminId, `select api.issue_delivery($1)`, [deliveryAId]),
    asUser(clientB, adminId, `select api.issue_delivery($1)`, [deliveryBId]),
  ]);

  await clientA.end();
  await clientB.end();

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  check('exactly one issue_delivery call succeeded', succeeded.length === 1, `succeeded=${succeeded.length} failed=${failed.length}`);
  check(
    'the losing call failed with insufficient_stock (23514), not some other error',
    failed.length === 1 && String(failed[0].reason?.code) === '23514',
    failed[0] ? `code=${failed[0].reason?.code} message=${failed[0].reason?.message}` : 'n/a',
  );

  const balance = await setup.query(
    `select quantity from app.stock_balances where company_id = $1 and epi_id = $2 and location_id is null and variant_id is null`,
    [companyId, epiId],
  );
  check('final stock balance is exactly 0', balance.rows[0]?.quantity === 0, `got=${balance.rows[0]?.quantity}`);

  const movements = await setup.query(
    `select count(*)::int as n from app.stock_movements where company_id = $1 and epi_id = $2 and movement_type = 'ENTREGA'`,
    [companyId, epiId],
  );
  check('exactly one ENTREGA movement was recorded', movements.rows[0].n === 1, `got=${movements.rows[0].n}`);

  const statuses = await setup.query(
    `select id, status from app.epi_deliveries where id in ($1, $2)`,
    [deliveryAId, deliveryBId],
  );
  const statusById = Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]));
  const issuedCount = Object.values(statusById).filter((s) => s === 'ISSUED').length;
  const draftCount = Object.values(statusById).filter((s) => s === 'DRAFT').length;
  check(
    'exactly one delivery ended ISSUED and the other stayed DRAFT -- no partial issuance of the loser',
    issuedCount === 1 && draftCount === 1,
    `issued=${issuedCount} draft=${draftCount} statuses=${JSON.stringify(statusById)}`,
  );
}

async function scenarioReplacementRace(setup, adminId, companyId) {
  const epi = await asUser(setup, adminId, `select api.create_epi($1, $2, 'Luva Concorrência', '13579') as id`, [
    (await setup.query('select organization_id from app.companies where id = $1', [companyId])).rows[0]
      .organization_id,
    companyId,
  ]);
  const epiId = epi.rows[0].id;

  const cpfHash = await setup.query(`select encode(extensions.digest('cpf-race-c', 'sha256'), 'base64') as v`);
  const cpfEnc = await setup.query(
    `select encode(decode('000000000000000000000000000000000000000000000000000000','hex') || 'fake-race-c'::bytea, 'base64') as v`,
  );
  const emp = await asUser(
    setup,
    adminId,
    `select api.create_employee($1, 'Funcionário Race C', $2, $3, '***.333.333-**') as id`,
    [companyId, cpfHash.rows[0].v, cpfEnc.rows[0].v],
  );
  const employeeId = emp.rows[0].id;

  const items = JSON.stringify([{ epi_id: epiId, quantity: 1 }]);
  const del = await asUser(setup, adminId, `select api.create_delivery($1, $2, current_date, null, $3::jsonb) as id`, [
    companyId,
    employeeId,
    items,
  ]);
  const originalId = del.rows[0].id;
  await asUser(setup, adminId, `select api.issue_delivery($1)`, [originalId]);

  // Bring it to CONFIRMED directly (bypassing the real worker OTP flow -- same fixture
  // technique 110_epi_lifecycle_troca.sql uses; this script's subject is the REPLACEMENT
  // race, not the confirmation flow itself, which is already covered elsewhere).
  await setup.query('begin');
  await setup.query(`select set_config('app.transition_ok', $1, true)`, [originalId]);
  await setup.query(
    `update app.epi_deliveries set status = 'CONFIRMED', last_event = 'REQUEST_CONFIRMED', confirmed_at = clock_timestamp(), frozen_at = clock_timestamp() where id = $1`,
    [originalId],
  );
  await setup.query('commit');

  const clientA = await newClient();
  const clientB = await newClient();

  const results = await Promise.allSettled([
    asUser(
      clientA,
      adminId,
      `select api.create_replacement_delivery($1, $2::jsonb, current_date, null, 'WEAR', null, false) as id`,
      [originalId, items],
    ),
    asUser(
      clientB,
      adminId,
      `select api.create_replacement_delivery($1, $2::jsonb, current_date, null, 'DAMAGE', null, false) as id`,
      [originalId, items],
    ),
  ]);

  await clientA.end();
  await clientB.end();

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  check('exactly one create_replacement_delivery call succeeded', succeeded.length === 1, `succeeded=${succeeded.length} failed=${failed.length}`);
  check(
    'the losing call failed with a STABLE domain error (original_not_replaceable, 23514) -- never the raw state-machine trigger message',
    failed.length === 1 &&
      String(failed[0].reason?.code) === '23514' &&
      String(failed[0].reason?.message || '').includes('original_not_replaceable'),
    failed[0] ? `code=${failed[0].reason?.code} message=${failed[0].reason?.message}` : 'n/a',
  );

  const original = await setup.query(`select status, superseded_by_delivery_id from app.epi_deliveries where id = $1`, [
    originalId,
  ]);
  check('the original has exactly one successor (superseded_by_delivery_id is set, not null)', !!original.rows[0].superseded_by_delivery_id);
  check('the original status is SUPERSEDED', original.rows[0].status === 'SUPERSEDED', `got=${original.rows[0].status}`);

  const successors = await setup.query(
    `select count(*)::int as n from app.epi_deliveries where corrects_delivery_id = $1`,
    [originalId],
  );
  check('exactly one delivery in the whole table corrects the original -- no duplicate successor', successors.rows[0].n === 1, `got=${successors.rows[0].n}`);

  const chainCheck = await setup.query(
    `select d1.chain_id = d2.chain_id as same_chain, d2.chain_version = d1.chain_version + 1 as version_incremented
     from app.epi_deliveries d1 join app.epi_deliveries d2 on d2.id = d1.superseded_by_delivery_id
     where d1.id = $1`,
    [originalId],
  );
  check(
    'the successor shares the same chain_id and has chain_version = original + 1',
    chainCheck.rows[0]?.same_chain === true && chainCheck.rows[0]?.version_incremented === true,
    JSON.stringify(chainCheck.rows[0]),
  );
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
