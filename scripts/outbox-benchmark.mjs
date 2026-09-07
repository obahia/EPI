// Phase F: the outbox trigger's cost, measured rather than assumed.
//
// The rule this script exists to enforce: NO threshold is invented. B0 is measured first,
// with the trigger absent, and every other number is reported relative to it. If a
// regression shows up, it is reported with the numbers and a stated cause -- not smoothed
// over, and not compared against a limit someone made up after seeing the result.
//
// Four configurations, in this order:
//   B0  trigger absent                                  -- THE BASELINE
//   B1  trigger present, ZERO active endpoints          -- what 100% of tenants pay today
//   B2  trigger present, one endpoint, runner OFF       -- the enqueue INSERT itself
//   B3  B2 with a large pre-existing backlog, runner OFF -- proves cost does not grow with it
//
// B1 is the one that matters most: every organization in production right now has no
// webhook at all, and that case must stay free. B2/B3 with the runner deliberately stopped
// are what prove the claim that a webhook backlog cannot slow down a confirmation.
//
// Needs a REAL Postgres (the ephemeral one `supabase start` launches in CI). PGlite is a
// single in-process WASM instance and cannot represent lock contention, which is half of
// what this measures.

import pg from 'pg';
import crypto from 'node:crypto';

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const REPEATS = Number(process.env.BENCH_REPEATS || 5);
const SEQUENTIAL_N = Number(process.env.BENCH_SEQUENTIAL_N || 300);
const CONCURRENT_N = Number(process.env.BENCH_CONCURRENT_N || 400);
const CONCURRENCY = 8;
const BACKLOG_ROWS = 10_000;

async function newClient() {
  const client = new pg.Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  return client;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Median across repeats, so one noisy run on a shared CI runner does not become the number
 * anyone reasons about. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const TRIGGER_SQL = `
  create trigger audit_events_enqueue_outbox
    after insert on audit.audit_events
    for each row execute function hooks.enqueue_outbox();
`;

async function setTrigger(client, present) {
  if (present) {
    const { rows } = await client.query(
      `select count(*)::int as n from pg_trigger
        where tgrelid = 'audit.audit_events'::regclass and tgname = 'audit_events_enqueue_outbox'`,
    );
    if (rows[0].n === 0) await client.query(TRIGGER_SQL);
  } else {
    await client.query('drop trigger if exists audit_events_enqueue_outbox on audit.audit_events');
  }
}

async function setupTenant(client) {
  const suffix = String(Date.now()).slice(-8);
  const cnpj = ('90' + String(Date.now()).slice(-12)).slice(0, 14);
  const userId = crypto.randomUUID();

  await client.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       is_sso_user, is_anonymous
     ) values (
       '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
       extensions.crypt('x', extensions.gen_salt('bf')), now(), '{}', '{}', now(), now(),
       '', '', '', '', false, false)`,
    [userId, `bench-${suffix}@example.test`],
  );

  await client.query('set role authenticated');
  await client.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);
  const { rows } = await client.query(
    `select company_id from api.onboard_organization($1, $2, $1, $2, null)`,
    [`Bench ${suffix} LTDA`, cnpj],
  );
  await client.query('reset role');

  const { rows: org } = await client.query(
    'select organization_id from app.companies where id = $1',
    [rows[0].company_id],
  );

  return { companyId: rows[0].company_id, organizationId: org[0].organization_id, userId };
}

/** S3/S4: app.log_audit_event on its own -- isolates the trigger from everything else a
 * business operation does. */
async function measureLogAuditEvent(client, tenant, { sameOrg, count }) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const started = process.hrtime.bigint();
    await client.query(
      `select app.log_audit_event($1, $2, 'EMPLOYEE_CREATED', 'app.employees', gen_random_uuid(),
                                  'USER', null, '{"data_origin":"MANUAL"}'::jsonb)`,
      [sameOrg ? tenant.organizationId : crypto.randomUUID(), null],
    );
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return samples;
}

async function runConcurrent(tenant, count, sameOrg) {
  const clients = await Promise.all(Array.from({ length: CONCURRENCY }, () => newClient()));
  const perClient = Math.ceil(count / CONCURRENCY);
  const started = process.hrtime.bigint();
  const results = await Promise.all(
    clients.map((c) => measureLogAuditEvent(c, tenant, { sameOrg, count: perClient })),
  );
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  await Promise.all(clients.map((c) => c.end()));
  return { samples: results.flat(), throughput: (perClient * CONCURRENCY) / (wallMs / 1000) };
}

async function sampleLockWaits(client) {
  const { rows } = await client.query(
    `select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and state = 'active' and pid <> pg_backend_pid()`,
  );
  return rows[0].n;
}

async function main() {
  const admin = await newClient();
  const tenant = await setupTenant(admin);

  const configurations = [
    { id: 'B0', label: 'trigger absent (BASELINE)', trigger: false, endpoint: false, backlog: 0 },
    { id: 'B1', label: 'trigger present, no endpoints', trigger: true, endpoint: false, backlog: 0 },
    { id: 'B2', label: 'trigger present, 1 endpoint, runner OFF', trigger: true, endpoint: true, backlog: 0 },
    { id: 'B3', label: 'B2 + 10k row backlog, runner OFF', trigger: true, endpoint: true, backlog: BACKLOG_ROWS },
  ];

  const report = [];

  for (const config of configurations) {
    await setTrigger(admin, config.trigger);

    await admin.query('delete from hooks.deliveries');
    await admin.query('delete from hooks.outbox');
    await admin.query('delete from hooks.endpoints where organization_id = $1', [tenant.organizationId]);

    if (config.endpoint) {
      await admin.query(
        `insert into hooks.endpoints (organization_id, url, secret_enc, event_types)
         values ($1, 'https://bench.example.com/hook', repeat('x', 40)::bytea, '{}')`,
        [tenant.organizationId],
      );
    }

    if (config.backlog > 0) {
      // A backlog built directly, not by generating 10k business events -- the point is the
      // table's size at claim time, and generating it through the trigger would take as long
      // as the benchmark itself.
      await admin.query(
        `insert into hooks.outbox (audit_event_id, organization_id, event_type, seq, occurred_at)
         select a.id, a.organization_id, a.event_type, a.seq, a.created_at
           from audit.audit_events a
          where a.organization_id = $1
          limit $2
         on conflict (audit_event_id) do nothing`,
        [tenant.organizationId, config.backlog],
      );
    }

    const sequential = [];
    const concurrentSame = [];
    const concurrentDistinct = [];
    const throughputs = [];
    let lockWaitObservations = 0;

    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const warmup = repeat === 0; // discarded: first pass pays cache and plan costs

      const s3 = await measureLogAuditEvent(admin, tenant, { sameOrg: true, count: SEQUENTIAL_N });
      if (!warmup) sequential.push(...s3);

      const lockSampler = setInterval(() => {
        void sampleLockWaits(admin).then((n) => {
          lockWaitObservations += n;
        });
      }, 50);
      const same = await runConcurrent(tenant, CONCURRENT_N, true);
      clearInterval(lockSampler);

      const distinct = await runConcurrent(tenant, CONCURRENT_N, false);

      if (!warmup) {
        concurrentSame.push(...same.samples);
        concurrentDistinct.push(...distinct.samples);
        throughputs.push(same.throughput);
      }
    }

    const outboxRows = await admin.query(
      'select count(*)::int as n from hooks.outbox where organization_id = $1',
      [tenant.organizationId],
    );

    report.push({
      config: config.id,
      label: config.label,
      S3_sequential: summarize(sequential),
      S4_concurrent_same_org: summarize(concurrentSame),
      S5_concurrent_distinct_org: summarize(concurrentDistinct),
      throughput_tx_per_s: Number(median(throughputs).toFixed(1)),
      lock_wait_observations: lockWaitObservations,
      outbox_rows_after: outboxRows.rows[0].n,
    });
  }

  await setTrigger(admin, true);
  await admin.end();

  const baseline = report[0];
  console.log('\n=== Phase F outbox benchmark (real Postgres) ===\n');
  for (const row of report) {
    const delta = (value, base) => (base === 0 ? 'n/a' : `${(((value - base) / base) * 100).toFixed(1)}%`);
    console.log(`--- ${row.config}: ${row.label}`);
    console.log(
      `  S3 sequential      p50=${row.S3_sequential.p50.toFixed(3)}ms  p95=${row.S3_sequential.p95.toFixed(3)}ms  p99=${row.S3_sequential.p99.toFixed(3)}ms  max=${row.S3_sequential.max.toFixed(3)}ms` +
        (row === baseline ? '' : `   [p95 ${delta(row.S3_sequential.p95, baseline.S3_sequential.p95)} vs B0]`),
    );
    console.log(
      `  S4 concurrent same p50=${row.S4_concurrent_same_org.p50.toFixed(3)}ms  p95=${row.S4_concurrent_same_org.p95.toFixed(3)}ms  p99=${row.S4_concurrent_same_org.p99.toFixed(3)}ms` +
        (row === baseline ? '' : `   [p95 ${delta(row.S4_concurrent_same_org.p95, baseline.S4_concurrent_same_org.p95)} vs B0]`),
    );
    console.log(
      `  S5 concurrent diff p50=${row.S5_concurrent_distinct_org.p50.toFixed(3)}ms  p95=${row.S5_concurrent_distinct_org.p95.toFixed(3)}ms`,
    );
    console.log(
      `  throughput=${row.throughput_tx_per_s} tx/s   lock-wait samples=${row.lock_wait_observations}   outbox rows after=${row.outbox_rows_after}\n`,
    );
  }

  console.log(JSON.stringify(report, null, 2));
  console.log(
    '\nNo pass/fail threshold is applied here on purpose: the numbers above are the deliverable.\n' +
      'B1 is the case to read first -- it is what every tenant without a webhook pays.\n' +
      'B3 materially worse than B2 would mean the enqueue cost grows with the backlog, which\n' +
      'is a design defect and blocks the phase. Any material regression must be explained in\n' +
      'the phase report with its cause, or the design changes.\n',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
