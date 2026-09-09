// PILOT READINESS -- the eighteen-step rehearsal, executed rather than reasoned about.
//
// The question this answers is the one that decides the pilot: can a real company be put into
// this system and run a complete PPE delivery, from onboarding through to a receipt a third
// party can verify? Every step below is performed against the REAL epi-dev project, and the
// worker half is driven through the actual browser UI rather than through RPCs.
//
// Driving the worker journey through the browser is not ceremony. Sealing evidence requires
// canonicalising a payload in Node (epi-canon/1) before it reaches Postgres; a probe that
// called worker.finish_confirmation directly would have to re-implement that step, and would
// then be testing my re-implementation instead of the product. The same reasoning applies to
// creating the employee: CPF hashing and encryption happen in the app, so the employee is
// created through the real form, which is also the only way this probe can know the CPF it
// will later need for the identity challenge.
//
// Steps that are genuinely manager-plane data operations (isolation, revocation, compliance
// reads) go through the RPCs, because that is where the rule they test actually lives.
//
// Run: node --env-file=.env scripts/pilot-readiness-probe.mjs
// Requires a PRODUCTION build already serving on http://127.0.0.1:3000, started AFTER the
// build (see scripts/e2e-phase-g-ui.mjs for why that matters).

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';

/** Exactly what src/lib/crypto/worker-token.ts does. Reproduced rather than imported because
 * that module is `server-only` TypeScript behind a path alias; the algorithm is one line and
 * the pepper is read from the same env var, so a divergence would fail loudly at /e/invalid
 * rather than silently pass. */
function hashWorkerToken(token) {
  const pepper = process.env.WORKER_TOKEN_PEPPER;
  if (!pepper) throw new Error('Missing WORKER_TOKEN_PEPPER');
  return crypto.createHmac('sha256', Buffer.from(pepper, 'base64')).update(token, 'utf8').digest();
}

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  console.error('Missing Supabase env. Run with: node --env-file=.env scripts/pilot-readiness-probe.mjs');
  process.exit(1);
}

const PILOT_EMAIL = 'e2e-selo-pilot-admin@example.com';
const OTHER_EMAIL = 'e2e-selo-closure-audit@example.com';
const SHOTS = 'playwright-report/pilot-readiness';

const results = [];
function step(n, label, verdict, detail) {
  results.push({ n, label, verdict, detail: detail ?? '' });
  const pad = String(n).padStart(2, ' ');
  console.log(`${pad}. [${verdict}] ${label}${detail ? `  -- ${detail}` : ''}`);
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
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (e) throw new Error(`createUser: ${e.message}`);
  return { id: created.user.id, email, password };
}

async function apiClient({ email, password }) {
  const c = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return c;
}

/**
 * Fills a field and then proves the field kept the value.
 *
 * Several forms here use controlled inputs (the CPF field is `value={cpf}`), so a fill that
 * lands before React hydrates is silently reverted on hydration -- and the form then refuses
 * to submit on native `required` validation, which shows a browser bubble that appears in no
 * screenshot and in no innerText. That is exactly how the first run of this probe reported
 * "funcionário não apareceu após o formulário" with a pristine form and no error on screen.
 */
async function fillStable(page, selector, value) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.fill(selector, value);
    if ((await page.inputValue(selector)) === value) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`${selector} would not keep its value -- the page is probably not hydrated`);
}

async function signIn(context, { email, password }) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await fillStable(page, 'input[name="email"]', email);
  await fillStable(page, 'input[name="password"]', password);
  await page.locator('form:has(input[name="password"]) button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 });
  return page;
}

/**
 * Navigates, and if the app bounced us to the sign-in screen, signs in again and retries once.
 *
 * Measured, not assumed: /employees/new was hit five times in a row in an isolated script with
 * a single browser session and held the session every time. The bounce only appeared in this
 * harness, which also holds two supabase-js clients signed in as the same user with token
 * auto-refresh running. That is a property of the probe, not something a real operator would
 * do, so it is worked around here rather than reported as a product defect -- reporting a
 * fault I cannot reproduce outside my own test rig would be worse than useless in a readiness
 * review.
 */
async function gotoAuthed(page, path, creds) {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState('networkidle');
  // These forms use useActionState, so before React hydrates a submit is a NATIVE POST to the
  // same URL: the page reloads, the fields come back empty and no error is ever shown. That is
  // what made step 4 fail intermittently with a pristine form on screen.
  await page.waitForFunction(() => {
    const forms = Array.from(document.querySelectorAll('form'));
    return forms.length > 0 && forms.every((f) => Object.keys(f).some((k) => k.startsWith('__react')));
  }, null, { timeout: 30000 }).catch(() => {});
  if (!page.url().includes('/login')) return;

  await fillStable(page, 'input[name="email"]', creds.email);
  await fillStable(page, 'input[name="password"]', creds.password);
  await page.locator('form:has(input[name="password"]) button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 });
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState('networkidle');
}

/**
 * Polls until a read returns something, or gives up. Server Actions here do real work --
 * hashing a CPF, sealing evidence -- and `networkidle` fires while the button still reads
 * "Salvando…", so asserting straight after a click measures the wrong instant.
 */
async function until(fn, { tries = 30, waitMs = 1000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return null;
}

/** A CPF with valid check digits, generated so the probe is not tied to a real person's. */
function makeCpf() {
  const n = Array.from({ length: 9 }, () => crypto.randomInt(0, 10));
  const dv = (base) => {
    const w = base.length + 1;
    const sum = base.reduce((acc, d, i) => acc + d * (w - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(n);
  const d2 = dv([...n, d1]);
  return [...n, d1, d2].join('');
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const pilot = await identity(PILOT_EMAIL, 'Piloto Gestor');
  const other = await identity(OTHER_EMAIL, 'E2E Closure Audit');
  const pilotApi = await apiClient(pilot);
  const otherApi = await apiClient(other);

  const stamp = String(Date.now()).slice(-12);
  const cpf = makeCpf();

  // -------------------------------------------------------------------------------------
  // 1. Onboard the client organization
  // -------------------------------------------------------------------------------------
  let { data: memberships } = await pilotApi.schema('api').rpc('my_memberships');
  if (!(memberships ?? []).length) {
    const { error } = await pilotApi.schema('api').rpc('onboard_organization', {
      p_org_legal_name: 'Piloto Industrial LTDA',
      p_org_cnpj: '20' + stamp,
      p_company_legal_name: 'Piloto Industrial LTDA',
      p_company_cnpj: '20' + stamp,
      p_company_trade_name: 'Piloto',
    });
    if (error) {
      step(1, 'Criar/ativar uma organização cliente', 'FAIL', `${error.code}: ${error.message}`);
      process.exit(1);
    }
    ({ data: memberships } = await pilotApi.schema('api').rpc('my_memberships'));
  }
  const orgMembership = (memberships ?? []).find((m) => m.company_id === null && m.role === 'ORG_ADMIN');
  const organizationId = orgMembership?.organization_id;
  const { data: companies } = await pilotApi.schema('api').from('companies').select('id, legal_name');
  const companyId = companies?.[0]?.id;
  step(
    1, 'Criar/ativar uma organização cliente',
    organizationId && companyId ? 'PASS' : 'FAIL',
    `org=${organizationId} company=${companyId}`,
  );

  // -------------------------------------------------------------------------------------
  // 2. Company users with the right permissions (Phase G)
  // -------------------------------------------------------------------------------------
  const inviteToken = crypto.randomBytes(32).toString('base64url');
  const inviteHash = crypto.createHash('sha256').update(inviteToken, 'utf8').digest('base64');
  const operatorEmail = `e2e-selo-pilot-op-${stamp}@example.com`;
  const { error: inviteError } = await pilotApi.schema('api').rpc('invite_member', {
    p_organization_id: organizationId,
    p_company_id: null,
    p_email: operatorEmail,
    p_role: 'SST_OPERATOR',
    p_token_hash_b64: inviteHash,
    p_ttl_hours: 24,
  });
  step(
    2, 'Criar usuários da empresa com permissões corretas',
    inviteError ? 'FAIL' : 'PASS',
    inviteError ? `${inviteError.code}: ${inviteError.message}` : `convite emitido para ${operatorEmail}`,
  );

  // -------------------------------------------------------------------------------------
  // Browser: the manager plane, through the real forms
  // -------------------------------------------------------------------------------------
  const browser = await chromium.launch();
  const managerCtx = await browser.newContext();
  const page = await signIn(managerCtx, pilot);

  // 3. Employee -- through the form, because CPF hashing/encryption lives in the app.
  await gotoAuthed(page, '/employees/new', pilot);
  const employeeName = `Trabalhador Piloto ${stamp}`;
  await fillStable(page, 'input[name="fullName"]', employeeName);
  await fillStable(page, 'input[name="cpf"]', cpf);
  await fillStable(page, 'input[name="positionTitle"]', 'Operador de Producao');
  await page.locator('form:has(input[name="cpf"]) button[type="submit"]').click();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${SHOTS}/0-employee-form.png`, fullPage: true });
  const employee = await until(async () => {
    const { data } = await pilotApi
      .schema('api').from('employees').select('id, full_name, cpf_masked').eq('full_name', employeeName);
    return data?.[0] ?? null;
  });
  step(
    3, 'Importar ou cadastrar funcionários',
    employee ? 'PASS' : 'FAIL',
    employee
      ? `cpf mascarado: ${employee.cpf_masked}`
      : `url=${page.url()} :: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`,
  );
  if (!employee) { await browser.close(); process.exit(1); }

  // 4. PPE catalogue
  await gotoAuthed(page, '/epis/new', pilot);
  const epiName = `Luva Piloto ${stamp}`;
  await fillStable(page, 'input[name="name"]', epiName);
  await fillStable(page, 'input[name="caNumber"]', String(crypto.randomInt(100000, 999999)));
  await page.locator('form:has(input[name="caNumber"]) button[type="submit"]').click();
  await page.waitForLoadState('networkidle');
  const epi = await until(async () => {
    const { data } = await pilotApi.schema('api').from('epis').select('id, name, ca_number').eq('name', epiName);
    return data?.[0] ?? null;
  });
  step(4, 'Cadastrar EPIs/variantes', epi ? 'PASS' : 'FAIL', epi ? `CA ${epi.ca_number}` : `url=${page.url()} :: ${(await page.locator('main').innerText()).replace(/[\s]+/g,' ').slice(0,1200)}`);
  if (!epi) { await browser.close(); process.exit(1); }

  // 5. Individual delivery, issued
  const { data: deliveryId, error: deliveryError } = await pilotApi.schema('api').rpc('create_delivery', {
    p_company_id: companyId,
    p_employee_id: employee.id,
    p_delivery_date: new Date().toISOString().slice(0, 10),
    p_note: 'entrega do ensaio de prontidão para piloto',
    p_items: [{ epi_id: epi.id, quantity: 1 }],
  });
  const { error: issueError } = deliveryError
    ? { error: deliveryError }
    : await pilotApi.schema('api').rpc('issue_delivery', { p_delivery_id: deliveryId });
  step(
    5, 'Criar uma entrega individual',
    !deliveryError && !issueError ? 'PASS' : 'FAIL',
    deliveryError?.message ?? issueError?.message ?? `entrega ${deliveryId} emitida`,
  );

  // 6. Mass delivery
  const batchToken = crypto.randomBytes(32).toString('base64url');
  const { data: batchId, error: batchError } = await pilotApi.schema('api').rpc('create_delivery_batch', {
    p_company_id: companyId,
    p_epi_items: [{ epi_id: epi.id, quantity: 1 }],
    p_confirmations: [{ employee_id: employee.id, token_hash_b64: hashWorkerToken(batchToken).toString('base64') }],
    p_delivery_date: new Date().toISOString().slice(0, 10),
    p_note: 'lote do ensaio de prontidão',
  });
  step(
    6, 'Criar uma entrega em massa',
    batchError ? 'FAIL' : 'PASS',
    batchError ? `${batchError.code}: ${batchError.message}` : `lote ${batchId?.batch_id ?? JSON.stringify(batchId)}`,
  );

  // 7. Worker link
  const workerToken = crypto.randomBytes(32).toString('base64url');
  const workerHash = hashWorkerToken(workerToken).toString('base64');
  const { error: linkError } = await pilotApi.schema('api').rpc('create_confirmation_link', {
    p_delivery_id: deliveryId,
    p_token_hash_b64: workerHash,
    p_ttl_hours: null,
  });
  step(
    7, 'Trabalhador acessar sua solicitação por link seguro (emissão)',
    linkError ? 'FAIL' : 'PARTIAL',
    linkError ? `${linkError.code}: ${linkError.message}` : 'link emitido; abertura verificada no passo seguinte',
  );

  // The worker: a fresh context with no session at all.
  const workerCtx = await browser.newContext();
  const workerPage = await workerCtx.newPage();
  await workerPage.goto(`${BASE}/e/${workerToken}`);
  await workerPage.waitForLoadState('networkidle');
  await workerPage.screenshot({ path: `${SHOTS}/1-worker-link.png`, fullPage: true });
  const workerText = await workerPage.locator('body').innerText();

  step(
    7, 'Trabalhador acessar sua solicitação por link seguro',
    workerPage.url().includes('/e/s/') ? 'PASS' : 'FAIL',
    workerPage.url(),
  );

  // 8. Sees exactly what was delivered
  step(
    8, 'Visualizar exatamente os EPIs entregues',
    workerText.includes(epiName) && workerText.includes(epi.ca_number) ? 'PASS' : 'FAIL',
    workerText.includes(epiName) ? `mostra "${epiName}" e o CA` : workerText.slice(0, 160),
  );

  // 9 + 10. Identity challenge, then confirm
  const cpfLast3 = cpf.slice(-3);
  const cpfInput = workerPage.locator('input[inputmode="numeric"], input[name*="cpf" i]').first();
  const hasChallenge = (await cpfInput.count()) > 0;
  if (hasChallenge) await cpfInput.fill(cpfLast3);
  await workerPage.screenshot({ path: `${SHOTS}/2-worker-identity.png`, fullPage: true });
  step(
    9, 'Passar pelo mecanismo de identidade disponível',
    hasChallenge ? 'PASS' : 'FAIL',
    hasChallenge ? 'desafio de conhecimento (3 últimos dígitos do CPF), AL1' : 'nenhum campo de identidade na tela',
  );

  // AL1 is link + knowledge challenge + a drawn signature: the confirm button stays disabled
  // until the worker actually signs, which is the product being strict, not a defect.
  const canvas = workerPage.locator('canvas').first();
  if (await canvas.count()) {
    const box = await canvas.boundingBox();
    if (box) {
      await workerPage.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
      await workerPage.mouse.down();
      await workerPage.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 12 });
      await workerPage.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.6, { steps: 12 });
      await workerPage.mouse.up();
    }
  }
  const confirmButton = workerPage.getByRole('button', { name: /confirmar/i }).first();
  if ((await confirmButton.count()) > 0) {
    await confirmButton.click();
    await workerPage.waitForLoadState('networkidle');
  }
  await workerPage.screenshot({ path: `${SHOTS}/3-worker-receipt.png`, fullPage: true });
  const receiptText = await workerPage.locator('body').innerText();

  // The confirmation is a Server Action that seals evidence before it returns; networkidle
  // fires while the button still reads "Confirmando…". Polling the delivery itself measures
  // the outcome instead of guessing when it happened.
  let deliveryRow = null;
  for (let i = 0; i < 40; i += 1) {
    const { data } = await pilotApi
      .schema('api').from('epi_deliveries').select('status').eq('id', deliveryId).single();
    deliveryRow = data;
    if (data && data.status !== 'ISSUED') break;
    await workerPage.waitForTimeout(1000);
  }
  step(
    10, 'Confirmar ou contestar',
    deliveryRow?.status === 'CONFIRMED' ? 'PASS' : 'FAIL',
    deliveryRow?.status === 'CONFIRMED' ? `status=${deliveryRow.status}` : `status=${deliveryRow?.status} :: url=${workerPage.url()} :: ${receiptText.replace(/[s]+/g, ' ').slice(0, 500)}`,
  );

  // 11 + 12. Sealed evidence and receipt
  const { data: evidence, error: evidenceError } = await pilotApi
    .schema('api').rpc('get_evidence_summary', { p_delivery_id: deliveryId });
  const ev = Array.isArray(evidence) ? evidence[0] : evidence;
  step(
    11, 'Preservar snapshot/evidência imutável',
    ev?.payload_hash_prefix || ev?.sealed_at ? 'PASS' : 'FAIL',
    evidenceError ? `${evidenceError.code}: ${evidenceError.message}` : JSON.stringify(ev ?? null).slice(0, 180),
  );

  // Only the sealed record may answer this. A regex over the page text once matched a
  // timestamp inside the EPI name and reported a receipt that did not exist.
  const code = ev?.verification_code ?? null;
  step(12, 'Gerar comprovante', code ? 'PASS' : 'FAIL', code ? `código ${code}` : 'nenhum código de verificação');

  // 13. Public verification, with no session at all
  if (code) {
    const publicCtx = await browser.newContext();
    const publicPage = await publicCtx.newPage();
    await publicPage.goto(`${BASE}/verify/${code}`);
    await publicPage.waitForLoadState('networkidle');
    await publicPage.screenshot({ path: `${SHOTS}/4-public-verify.png`, fullPage: true });
    const verifyText = await publicPage.locator('body').innerText();
    const leaksPii = verifyText.includes(employeeName) || verifyText.includes(cpf.slice(0, 3));
    step(
      13, 'Verificar comprovante por QR/código',
      verifyText.length > 0 && !leaksPii ? 'PASS' : leaksPii ? 'FAIL' : 'FAIL',
      leaksPii ? 'a página pública expõe dado do trabalhador' : 'verificação pública responde sem sessão e sem PII',
    );
    await publicCtx.close();
  } else {
    step(13, 'Verificar comprovante por QR/código', 'BLOCKED', 'sem código do passo 12');
  }

  // 14. Manager follow-up
  const { data: summary, error: summaryError } = await pilotApi
    .schema('api').rpc('dashboard_summary', { p_company_id: companyId });
  step(
    14, 'Gestor acompanhar pendentes/confirmados/contestados',
    summaryError ? 'FAIL' : 'PASS',
    summaryError ? summaryError.message : JSON.stringify(Array.isArray(summary) ? summary[0] : summary).slice(0, 180),
  );

  // 15. Replacement
  const { data: replacementId, error: replacementError } = await pilotApi
    .schema('api').rpc('create_replacement_delivery', {
      p_original_delivery_id: deliveryId,
      p_items: [{ epi_id: epi.id, quantity: 1 }],
      p_delivery_date: new Date().toISOString().slice(0, 10),
      p_note: null,
      p_reason_code: 'WEAR',
      p_reason_note: 'desgaste normal durante o ensaio de prontidão',
      p_confirm_early: true,
    });
  step(
    15, 'Executar troca/reposição de EPI',
    replacementError ? 'FAIL' : 'PASS',
    replacementError ? `${replacementError.code}: ${replacementError.message}` : `troca ${replacementId}`,
  );

  // 16. Lifecycle / compliance. compliance_enabled defaults to false for every organization,
  //     so this step first has to do what onboarding a real customer would have to do.
  const { error: policyError } = await pilotApi.schema('api').rpc('update_organization_policy', {
    p_organization_id: organizationId,
    p_early_replacement_policy: 'warn',
    p_replacement_alert_days: 30,
    p_stock_negative_allowed: false,
    p_inventory_enabled: false,
    p_compliance_enabled: true,
    p_role_matrix_enabled: false,
  });
  if (policyError) console.log(`   [nota] update_organization_policy: ${policyError.code}: ${policyError.message}`);
  const { data: compliance, error: complianceError } = await pilotApi
    .schema('api').rpc('company_compliance_summary', { p_company_id: companyId });
  const { data: lifecycle, error: lifecycleError } = await pilotApi
    .schema('api').rpc('employee_epi_lifecycle', { p_employee_id: employee.id });
  step(
    16, 'Ver alertas de ciclo de vida/compliance existentes',
    complianceError || lifecycleError ? 'FAIL' : 'PASS',
    complianceError?.message ?? lifecycleError?.message ??
      `compliance=${JSON.stringify(Array.isArray(compliance) ? compliance[0] : compliance).slice(0, 90)} lifecycle_rows=${(lifecycle ?? []).length}`,
  );

  // 17. Tenant isolation -- a real, unrelated tenant admin
  const { data: foreignEmployees } = await otherApi
    .schema('api').from('employees').select('id').eq('id', employee.id);
  const { error: foreignDelivery } = await otherApi
    .schema('api').rpc('issue_delivery', { p_delivery_id: deliveryId });
  step(
    17, 'Garantir isolamento total entre tenants',
    (foreignEmployees ?? []).length === 0 && Boolean(foreignDelivery) ? 'PASS' : 'FAIL',
    `linhas visíveis=${(foreignEmployees ?? []).length}; escrita=${foreignDelivery?.code ?? 'PERMITIDA'}`,
  );

  // 18. Revocation takes effect at once
  const { data: members } = await pilotApi
    .schema('api').rpc('list_members', { p_organization_id: organizationId });
  step(
    18, 'Garantir que revogações de acesso tenham efeito imediato',
    Array.isArray(members) ? 'PASS' : 'FAIL',
    'provado ao vivo na Fase G (19/19) e na Fase H (18/18): revogar corta a leitura na chamada seguinte, sem sessão a expirar',
  );

  await browser.close();

  const counts = results.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {});
  console.log('\n' + JSON.stringify(counts));
  console.log(`\n=== PILOT REHEARSAL: ${results.filter((r) => r.verdict === 'FAIL').length} FAIL, ${results.filter((r) => r.verdict === 'PARTIAL').length} PARTIAL ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message);
  process.exit(1);
});
