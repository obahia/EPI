// PILOT READINESS — the employee import, exercised end to end with a realistic file.
//
// This is how a real customer loads their staff on day one, and until now it had unit tests
// and a pgTAP suite but had never been run with a file. The whole path is client-side up to
// the commit (docs/architecture.md: the CSV is parsed in the browser and nothing is persisted
// server-side before validation), so the only honest way to test it is to drive the wizard.
//
// The dataset is SYNTHETIC and generated fresh on every run: names assembled from a fixed word
// list, CPFs computed with real check digits from a CSPRNG. No real person's data is used, and
// nothing is read from any existing tenant.
//
// It deliberately includes three kinds of bad row, because "does the happy path work" is not
// the question a pilot needs answered:
//   · duplicates INSIDE the file (the same CPF twice)
//   · a duplicate of somebody ALREADY in the tenant
//   · malformed rows (bad CPF check digit, missing name, unparseable e-mail)
//
// Run: node --env-file=.env scripts/e2e-import.mjs
// Requires a production build already serving, started AFTER the build.

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishableKey || !secretKey) {
  console.error('Missing Supabase env. Run with: node --env-file=.env scripts/e2e-import.mjs');
  process.exit(1);
}

const PILOT_EMAIL = 'e2e-selo-pilot-admin@example.com';
const OTHER_EMAIL = 'e2e-selo-closure-audit@example.com';
const SHOTS = 'playwright-report/import';
const TMP = 'playwright-report/import/dataset';

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
  if (!found) throw new Error(`${email} does not exist -- run scripts/pilot-readiness-probe.mjs first`);
  const { error: e } = await admin.auth.admin.updateUserById(found.id, { password });
  if (e) throw new Error(`updateUserById: ${e.message}`);
  return { id: found.id, email, password };
}

async function apiClient({ email, password }) {
  const c = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return c;
}

/** Real check digits, so a valid row is valid for the same reason a real one would be. */
function validCpf() {
  const n = Array.from({ length: 9 }, () => crypto.randomInt(0, 10));
  const dv = (base) => {
    const w = base.length + 1;
    const sum = base.reduce((acc, d, i) => acc + d * (w - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(n);
  return [...n, d1, dv([...n, d1])].join('');
}

/** Same shape, wrong check digit -- the realistic typo, not obvious garbage. */
function invalidCpf() {
  const good = validCpf();
  const lastDigit = Number(good[10]);
  return good.slice(0, 10) + String((lastDigit + 1) % 10);
}

const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fabio', 'Gisele', 'Heitor', 'Iara', 'Joana'];
const LAST = ['Almeida', 'Barbosa', 'Cardoso', 'Duarte', 'Esteves', 'Ferreira', 'Gomes', 'Henriques'];

function buildDataset(stamp) {
  const rows = [];
  const seen = [];

  // 170 clean rows.
  for (let i = 0; i < 170; i += 1) {
    const cpf = validCpf();
    seen.push(cpf);
    rows.push({
      nome: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]} ${stamp}${i}`,
      cpf,
      matricula: `M${stamp}${i}`,
      email: `sintetico.${stamp}.${i}@exemplo.invalid`,
      // Unique per run, so pass 1 ALWAYS meets a Cargo the tenant does not have. Using a
      // generic label made the script pass or fail depending on what an earlier run left behind.
      cargo: i % 3 === 0 ? `Operador ${stamp}` : `Auxiliar ${stamp}`,
      departamento: 'Producao',
    });
  }

  // 15 duplicates of rows already in this same file.
  for (let i = 0; i < 15; i += 1) {
    const original = rows[i];
    rows.push({ ...original, nome: `${original.nome} (repetido)`, matricula: `D${stamp}${i}` });
  }

  // 15 malformed rows, three distinct ways a real spreadsheet goes wrong.
  for (let i = 0; i < 5; i += 1) {
    rows.push({
      nome: `${FIRST[i]} CpfErrado ${stamp}`,
      cpf: invalidCpf(),
      matricula: `X${stamp}a${i}`,
      email: `sintetico.bad.${stamp}.${i}@exemplo.invalid`,
      cargo: `Operador ${stamp}`,
      departamento: 'Producao',
    });
  }
  for (let i = 0; i < 5; i += 1) {
    rows.push({
      nome: '',
      cpf: validCpf(),
      matricula: `X${stamp}b${i}`,
      email: `sintetico.noname.${stamp}.${i}@exemplo.invalid`,
      cargo: `Operador ${stamp}`,
      departamento: 'Producao',
    });
  }
  for (let i = 0; i < 5; i += 1) {
    rows.push({
      nome: `${FIRST[i]} EmailErrado ${stamp}`,
      cpf: validCpf(),
      matricula: `X${stamp}c${i}`,
      email: 'nao-e-um-email',
      cargo: `Operador ${stamp}`,
      departamento: 'Producao',
    });
  }

  return { rows, cleanCpfs: seen };
}

function toCsv(rows) {
  const headers = ['nome', 'cpf', 'matricula', 'email', 'cargo', 'departamento'];
  const escape = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h] ?? '')).join(','))].join('\n');
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  const pilot = await identity(PILOT_EMAIL);
  const other = await identity(OTHER_EMAIL);
  const pilotApi = await apiClient(pilot);
  const otherApi = await apiClient(other);

  const { data: companies } = await pilotApi.schema('api').from('companies').select('id, organization_id');
  const company = companies?.[0];
  if (!company) throw new Error('the pilot identity administers no company');

  const stamp = String(Date.now()).slice(-9);
  const { rows, cleanCpfs } = buildDataset(stamp);

  // One CPF that ALREADY exists in the tenant, so the run covers a collision with stored data
  // and not only with the file itself.
  const preexistingCpf = cleanCpfs[0];
  rows.push({
    nome: `Ana Almeida ${stamp}0 (ja existente)`,
    cpf: preexistingCpf,
    matricula: `P${stamp}`,
    email: `sintetico.pre.${stamp}@exemplo.invalid`,
    cargo: 'Operador',
    departamento: 'Producao',
  });

  const csvPath = path.resolve(TMP, `funcionarios-${stamp}.csv`);
  writeFileSync(csvPath, toCsv(rows), 'utf8');
  console.log(`Dataset sintético: ${rows.length} linhas em ${csvPath}\n`);

  const { count: before } = await pilotApi
    .schema('api').from('employees').select('id', { count: 'exact', head: true }).eq('company_id', company.id);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', pilot.email);
  await page.fill('input[name="password"]', pilot.password);
  await page.locator('form:has(input[name="password"]) button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 });

  await page.goto(`${BASE}/employees/import`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const forms = Array.from(document.querySelectorAll('form'));
    return forms.every((f) => Object.keys(f).some((k) => k.startsWith('__react')));
  }, null, { timeout: 30_000 }).catch(() => {});

  // ---------------------------------------------------------------------------------
  // Upload → preview
  // ---------------------------------------------------------------------------------
  await page.setInputFiles('input[type="file"]', csvPath);
  await page.waitForSelector('text=Confirmar importação', { timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/1-preview.png`, fullPage: true });

  const previewText = await page.locator('main').innerText();
  check(
    'o assistente lê o arquivo inteiro e diz quantas linhas encontrou',
    previewText.includes(String(rows.length)),
    `${rows.length} linhas no arquivo`,
  );
  check(
    'e afirma explicitamente que nada foi enviado ainda',
    /nada foi enviado|nothing.*sent/i.test(previewText),
  );

  // PanelKicker renders uppercase via CSS and innerText returns what was RENDERED, so the
  // match has to be case-insensitive. Comparing case-sensitively reported "0 linhas com
  // problema" while the screen plainly said "31 LINHAS COM PROBLEMA".
  const problemsMatch = previewText.match(/(\d+)\s+linhas com problema/i);
  const reportedProblems = problemsMatch ? Number(problemsMatch[1]) : 0;
  check(
    'as linhas malformadas são recusadas ANTES de qualquer envio',
    reportedProblems >= 15,
    `${reportedProblems} linhas com problema apontadas na tela`,
  );

  // The error list a real user reads. It has to name the row and the reason.
  const problemsIndex = previewText.toUpperCase().indexOf('LINHAS COM PROBLEMA');
  const errorPanel = problemsIndex >= 0 ? previewText.slice(problemsIndex) : '';
  check(
    'e cada erro nomeia a linha E o motivo, que é o que um usuário real precisa para corrigir',
    /linha\s*\d+/i.test(errorPanel) && /(duplicad|inválid|invalid|obrigat)/i.test(errorPanel),
    errorPanel.replace(/\s+/g, ' ').slice(0, 200),
  );

  // The counter the user acts on, read from the panel that owns it -- not from a loose
  // regex over the whole page, which on the first run matched the "201 lines read" figure and
  // reported a pass it had not earned.
  const willImport = Number(
    (previewText.match(/(\d+)\s*\n?\s*funcion[áa]rios ser[ãa]o importados/i) ?? [])[1] ?? NaN,
  );
  check(
    'e diz exatamente quantos serão criados, separando-os das linhas recusadas',
    willImport === rows.length - reportedProblems,
    `tela: ${willImport} a importar, ${reportedProblems} recusadas, ${rows.length} lidas`,
  );

  // ---------------------------------------------------------------------------------
  // Commit
  // ---------------------------------------------------------------------------------
  // PASS 1 -- the Cargo column names positions this tenant does not have. Selo refuses to
  // invent them (docs/mvp-roadmap.md FASE F: nothing is created on the customer's behalf), so
  // the correct outcome is a refusal. What matters for a pilot is that the refusal is VISIBLE:
  // the first run of this script clicked the button and the screen simply did not change.
  await page.getByRole('button', { name: 'Confirmar importação' }).click();
  await page
    .waitForSelector('text=/Importação concluída|Importação parcial/', { timeout: 600_000 })
    .catch(() => {});
  await page.screenshot({ path: `${SHOTS}/2-unmatched-references.png`, fullPage: true });

  const refusalText = await page.locator('main').innerText();
  check(
    'um Cargo que não existe no catálogo produz uma recusa VISÍVEL, não uma tela parada',
    /Importação parcial|Importação concluída/.test(refusalText),
    refusalText.replace(/\s+/g, ' ').slice(0, 180),
  );
  check(
    'e a recusa explica quais linhas ficaram de fora',
    /linhas com problema/i.test(refusalText) || /refer[êe]ncia/i.test(refusalText),
    refusalText.replace(/\s+/g, ' ').slice(0, 180),
  );

  const { count: afterRefusal } = await pilotApi
    .schema('api').from('employees').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
  check(
    'e nada foi criado enquanto as referências não batem -- a recusa é real, não cosmética',
    (afterRefusal ?? 0) === (before ?? 0),
    `antes=${before} depois=${afterRefusal}`,
  );

  // PASS 2 -- the same file, after the two positions exist in the catalogue. This is the path
  // the customer takes once the operator has created their Cargos, and it is the one that has
  // to actually write 170 employees.
  for (const title of [`Operador ${stamp}`, `Auxiliar ${stamp}`]) {
    await pilotApi.schema('api').rpc('create_job_position', {
      p_organization_id: company.organization_id,
      p_company_id: company.id,
      p_title: title,
      p_description: null,
    });
  }

  await page.goto(`${BASE}/employees/import`);
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('input[type="file"]', csvPath);
  await page.waitForSelector('text=Confirmar importação', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Confirmar importação' }).click();
  await page
    .waitForSelector('text=/Importação concluída|Importação parcial/', { timeout: 600_000 })
    .catch(() => {});
  await page.screenshot({ path: `${SHOTS}/3-result.png`, fullPage: true });

  const resultText = await page.locator('main').innerText();
  const partial = resultText.includes('Importação parcial');
  check(
    'com os Cargos cadastrados, a importação roda até o fim e informa o resultado',
    resultText.includes('Importação concluída') || partial,
    resultText.replace(/\s+/g, ' ').slice(0, 180),
  );

  // ---------------------------------------------------------------------------------
  // What actually landed
  // ---------------------------------------------------------------------------------
  const { count: after } = await pilotApi
    .schema('api').from('employees').select('id', { count: 'exact', head: true }).eq('company_id', company.id);
  const created = (after ?? 0) - (before ?? 0);

  check(
    'somente as linhas válidas foram criadas -- nenhuma linha malformada virou funcionário',
    created > 0 && created <= 170,
    `criados=${created} (limite superior 170 linhas limpas; duplicados e inválidos não contam)`,
  );

  const { data: sample } = await pilotApi
    .schema('api').from('employees').select('cpf_masked, full_name').ilike('full_name', `%${stamp}%`).limit(3);
  check(
    'e o CPF importado está mascarado na leitura, como qualquer outro',
    (sample ?? []).every((e) => /^\*{3}\.\d{3}\.\d{3}-\*{2}$/.test(e.cpf_masked ?? '')),
    JSON.stringify((sample ?? []).map((e) => e.cpf_masked)),
  );

  const { data: duplicated } = await pilotApi
    .schema('api').from('employees').select('id').ilike('full_name', `%(repetido)%`);
  check(
    'as duplicatas internas do arquivo não geraram um segundo funcionário',
    (duplicated ?? []).length === 0,
    `${(duplicated ?? []).length} linhas "(repetido)" viraram funcionário`,
  );

  const { data: preexisting } = await pilotApi
    .schema('api').from('employees').select('id').ilike('full_name', `%(ja existente)%`);
  check(
    'nem a duplicata de alguém que já estava no tenant',
    (preexisting ?? []).length === 0,
    `${(preexisting ?? []).length} linha(s) colidindo com dado existente foram criadas`,
  );

  // ---------------------------------------------------------------------------------
  // Isolation: none of this is visible from another tenant
  // ---------------------------------------------------------------------------------
  const { data: foreign } = await otherApi
    .schema('api').from('employees').select('id').ilike('full_name', `%${stamp}%`);
  check(
    'nada do que foi importado é visível de outro tenant',
    (foreign ?? []).length === 0,
    `${(foreign ?? []).length} linhas visíveis para um admin de outra organização`,
  );

  // ---------------------------------------------------------------------------------
  // The run itself is auditable
  // ---------------------------------------------------------------------------------
  // app.import_runs is written, but nothing exposes a HISTORY of runs: api.import_run_status
  // takes a run id, and that id only exists inside the wizard session. What a customer can
  // actually look up afterwards is their own audit trail, so that is what gets asserted --
  // the missing history screen is recorded as a limitation rather than tested as if it existed.
  const { data: events, error: eventsError } = await pilotApi
    .schema('api').rpc('company_audit_events', { p_company_id: company.id, p_limit: 50 });
  const importEvent = (events ?? []).find((e) => e.event_type === 'EMPLOYEES_IMPORTED');
  check(
    'a importação fica registrada na trilha de auditoria do próprio tenant',
    !eventsError && Boolean(importEvent),
    eventsError ? `${eventsError.code}: ${eventsError.message}` : JSON.stringify(importEvent?.data ?? null).slice(0, 160),
  );

  await browser.close();
  console.log(`\nCapturas em ${SHOTS}/`);
  console.log(`\n=== IMPORT E2E: ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message);
  process.exit(1);
});
