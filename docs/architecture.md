# Arquitetura — Plataforma de Entrega Digital de EPI

Status: proposta v1 — pendente de aprovação antes da FASE 0.
Escopo: MVP comercial (não é protótipo). Este documento é normativo: código que contradiga uma decisão aqui deve mudar o código ou atualizar este documento explicitamente, nunca divergir silenciosamente.

Metodologia: esta arquitetura foi construída em duas etapas. (1) Pesquisa verificada contra documentação oficial e fontes primárias (Next.js, Supabase, comportamento de câmera em iOS/PWA, licenças de bibliotecas de biometria, legislação brasileira aplicável, bibliotecas de suporte) — cada afirmação carrega uma fonte ou está marcada como não verificada. (2) Três modelos de dados desenhados independentemente sob lentes diferentes (evidência/defensabilidade jurídica, isolamento/segurança, simplicidade operacional), cada um criticado adversarialmente, sintetizados aqui num único modelo. Decisões conflitantes entre os três foram resolvidas explicitamente — ver §20.

---

## 1. Visão geral

Fluxo central: **empresa registra entrega → trabalhador recebe link individual → confere os EPIs → confirma ou contesta → sistema sela evidência imutável → empresa consulta histórico e emite comprovante verificável por QR.**

O produto tem duas superfícies com requisitos de autenticação opostos:

- **Painel do gestor** — autenticado (Supabase Auth), multi-tenant, desktop-first mas responsivo.
- **Fluxo do trabalhador** — nunca autenticado. Acesso exclusivamente por posse de um token opaco de uso único. Um `employee` nunca é um `auth user`; não existe (e nunca existirá) coluna alguma ligando as duas tabelas.

Esta distinção é o eixo de segurança do sistema inteiro: **o papel Postgres que atende o caminho do trabalhador não tem privilégio de tabela nenhum.** Todo acesso passa por funções `SECURITY DEFINER` parametrizadas pelo token — nunca por um id que um IDOR possa substituir.

## 2. Boundaries (domain / service)

Sem microserviços — a spec pede explicitamente para não introduzir isso por estética. Os *boundaries* são de **schema Postgres + módulo TypeScript**, não de processo:

| Boundary | Mecanismo | Por quê |
|---|---|---|
| Domínio de negócio ↔ evidência/auditoria | Schemas `app` vs `evidence` vs `audit` no mesmo Postgres | Privilégios e gatilhos diferentes; `evidence`/`audit` não têm GRANT de escrita para nenhum papel de aplicação, nem sequer `service_role`. |
| API pública (PostgREST) ↔ tabelas de negócio | Apenas o schema `api` (views `security_invoker`) é exposto via `PGRST_DB_SCHEMAS`; `app`, `authz`, `evidence`, `audit`, `integ` nunca são alcançáveis por HTTP | Uma tabela nova sem view em `api` é invisível por padrão — não "exposta e devendo ter policy", mas inatingível estruturalmente. Fecha a falha clássica "criei uma tabela e esqueci a RLS". |
| Verificação de identidade ↔ resto do domínio | Interface `IdentityVerificationProvider` (TypeScript) + tabela `identity_verifications` guardando apenas o *resultado* | Troca de fornecedor não deve tocar `epi_deliveries`. Ver §9. |
| Notificação ↔ resto do domínio | Interface `NotificationProvider` | Troca de WhatsApp/SMS/e-mail não deve tocar o domínio de confirmação. Ver §10. |
| WOTY ↔ nosso banco | Schema `integ`, sincronização unidirecional (pull), nunca dependência de runtime | Se o WOTY cair, o produto continua funcionando. Ver §11. |

## 3. Tenancy

### Definições (sem sinônimos, sem ambiguidade)

- **Tenant = `app.organizations`.** É a raiz de isolamento, faturamento, contrato e branding. Não existe uma tabela "tenant" separada de "organization" — seriam sempre 1:1 e só criariam ambiguidade de ownership.
- **Organization** — a mesma linha acima. `kind ∈ {PARTNER, DIRECT}`. `PARTNER` é a clínica/parceiro SST administrando N empresas-cliente; `DIRECT` é uma empresa que comprou diretamente e possui exatamente 1 `company`. **O primeiro cliente (uma clínica) não é um caso especial — é `kind='PARTNER'` com N empresas.** Isso é o que evita acoplar o produto ao cliente inicial.
- **Company** — `app.companies`. Pessoa jurídica brasileira (CNPJ), empregadora de registro, sujeito legal da evidência NR-6. Pertence a exatamente uma organization, para sempre. Não existe operação de "mover empresa entre organizações" no código de aplicação — é uma operação de plataforma, auditada.
- **User** — `app.users`, espelho 1:1 de `auth.users`. Um humano que faz login no painel. Não pertence a nenhuma organização por si só — acesso vem exclusivamente de `membership`.
- **Membership** — `authz.memberships (user_id, organization_id, company_id NULL, role, revoked_at)`. **O único mecanismo de concessão de acesso.** `company_id IS NULL` = papel vale em toda organização, presente e futura (é assim que um Partner Admin cobre 200 empresas-cliente com 1 linha, sem policy N+1). `company_id` preenchido = escopo de uma empresa.
- **Employee** — `app.employees`. Trabalhador de uma empresa. **NÃO é um usuário autenticado.** Não existe coluna `user_id` em `employees`, não existe linha em `auth.users`, não existe senha. A única via de acesso é a posse de um token de `confirmation_request`.

### Hierarquia: dois níveis fixos, não uma árvore auto-referenciada

`organizations` **não tem** `parent_organization_id`. Decisão deliberada: uma árvore auto-referenciada (para modelar sub-revendedores) obriga toda policy de RLS a responder "X é descendente de alguma organização minha?", o que é uma CTE recursiva ou uma lookup em `ltree`/closure table dentro do `USING` da policy — não redutível a `ScalarArrayOpExpr` indexável, não faz sentido em uma dashboard de lote com centenas de linhas, e é historicamente a causa mais comum de vazamento entre tenants em sistemas reais (o predicado de ancestralidade é escrito uma vez e sutilmente errado).

Se aparecer um sub-revendedor no futuro, a solução é uma coluna `reseller_of_organization_id` usada **apenas para relatórios/faturamento, nunca em predicado de RLS** — acesso a dados continua exigindo uma `membership` explícita.

### O mecanismo estrutural anti-escape: foreign keys compostas encadeadas

Toda tabela de negócio carrega `organization_id` **e**, quando aplicável, `company_id`, desnormalizados. O risco clássico da desnormalização — uma linha cujo `company_id` discorda do pai — é eliminado, não gerenciado, por FKs compostas encadeadas:

```sql
ALTER TABLE app.companies  ADD CONSTRAINT companies_id_org_key  UNIQUE (id, organization_id);
ALTER TABLE app.employees
  ADD CONSTRAINT employees_id_company_key UNIQUE (id, company_id),
  ADD CONSTRAINT employees_company_org_fk  FOREIGN KEY (company_id, organization_id)
      REFERENCES app.companies (id, organization_id);
ALTER TABLE app.epi_deliveries
  ADD CONSTRAINT deliveries_employee_company_fk FOREIGN KEY (employee_id, company_id)
      REFERENCES app.employees (id, company_id);
-- e assim por diante para epi_delivery_items, confirmation_requests, evidence_snapshots, documents…
```

Consequência: é **impossível** gravar uma entrega apontando para um funcionário de outra empresa, ou uma linha cujo `organization_id` discorde do da empresa-pai. Não é "não deveria acontecer" — é violação de FK (`23503`), rejeitada antes de qualquer policy rodar. Isso transforma "tenant escape" de uma classe de bug de aplicação em uma classe de escrita impossível. **É o único ponto em que os três desenhos independentes convergiram sem discordância — é o alicerce não-negociável do modelo.**

## 4. Auth

- Supabase Auth para o painel do gestor. `@supabase/ssr` (App Router), cookies `getAll`/`setAll`, chaves novas (`sb_publishable_...` no browser, `sb_secret_...` só no servidor) — ver §20 sobre por que não as chaves legadas.
- **`getClaims()`, nunca `getSession()`, para proteger página ou dado.** A documentação atual do Supabase é explícita: `getSession()` não garante revalidação do token no servidor. Chaves de assinatura assimétricas (ES256) permitem verificação local sem round-trip à rede.
- **`middleware.ts`/`proxy.ts` nunca é a fronteira de autorização.** Faz apenas checagem otimista (existe cookie de sessão?) para UX; a autorização real acontece o mais perto possível dos dados, em cada Server Action/Route Handler, e — camada final e não contornável — em RLS. Isso não é conservadorismo gratuito: há duas CVEs de bypass de middleware/proxy no Next.js nos últimos 18 meses (CVE-2025-29927 crítica; CVE-2026-64642 em julho/2026), e a própria documentação do framework diz para nunca depender só disso.
- **O caminho do trabalhador nunca usa Supabase Auth.** Não há sessão `anon` nem `authenticated` — o papel `anon` do Postgres não tem grant de tabela nenhum (ver §5 e §8). Autorização é 100% via posse de token + funções `SECURITY DEFINER`.

## 5. RBAC

Papéis de `membership` (4, não 5 — "Employee" não é um papel de usuário, é uma entidade separada):

`VIEWER < SST_OPERATOR < COMPANY_ADMIN < ORG_ADMIN` (mais `PLATFORM_ADMIN`, fora da árvore de organizações).

| Papel do enunciado | Papel no modelo |
|---|---|
| Platform Super Admin | `app.platform_admins` — tabela separada, **não** um `membership`, **não** um bypass de RLS. Acesso de suporte é *break-glass*: `app.platform_access_grants`, com motivo obrigatório (≥20 caracteres), aprovador ≠ solicitante (regra dos quatro olhos), teto de 72h, e cada concessão grava um evento `PLATFORM_ACCESS_GRANTED` **na cadeia de auditoria do próprio tenant afetado** — o cliente pode ver quem da nossa equipe acessou seus dados e por quê. |
| Partner Admin | `ORG_ADMIN` de uma organização `kind='PARTNER'`. |
| Company Admin | `ORG_ADMIN` de uma organização `kind='DIRECT'`, ou `COMPANY_ADMIN` com `company_id` fixo sob um parceiro. |
| SST Operator | `SST_OPERATOR` — CRUD de funcionários/EPIs/entregas conforme permissão, sem gestão de membros ou faturamento. |
| Employee | Não é um papel de usuário — ver §3. |

Permissões são uma matriz estática `authz.role_permissions(role, permission)`, semeada por migration. Escalada de privilégio exigiria uma migration, não um `UPDATE` em runtime.

**Revelar o CPF completo** é uma permissão própria (`employee.cpf.reveal`), **fora** do papel padrão de `PARTNER_ADMIN`/`ORG_ADMIN` — reflete a distinção controlador/operador da LGPD (a clínica tipicamente é operadora do dado do funcionário; a empresa-cliente é controladora) e cada revelação grava um evento de auditoria nomeando o usuário.

## 6. Modelo de dados

O modelo completo tem ~20 tabelas de negócio + `evidence.*`/`audit.*`. A lista de referência do enunciado foi ajustada: **colapsada** onde gerava cerimônia sem benefício, **desdobrada** onde uma tabela escondia duas máquinas de estado diferentes.

### Colapsos deliberados (vs. a lista de referência)

| Entidade da lista | Decisão |
|---|---|
| `documents` + `document_versions` | Uma tabela, `evidence.documents`. Um recibo é uma *renderização* de uma `evidence_version` imutável, não um objeto versionado independente — correção já vive em `evidence_versions.chain_version`. |
| `integration_connections` + `external_mappings` + `sync_runs` | Mantidas como 3 tabelas no schema `integ` (não colapsadas) — WOTY sincroniza **empresas e funcionários**, dois tipos de entidade reais hoje, e histórico de execução de sync é operacionalmente importante o bastante para não virar só eventos de auditoria perdidos em meio a outros 30 tipos de evento. Ver §11. |
| `identity_profiles` | Mantida, mas estreita: apenas o ponteiro (`provider`, `provider_subject_id`) para o cadastro no fornecedor — nunca um template biométrico. |
| Uma tabela de *staging* de importação (`import_jobs`) | **Não criada.** Ver §6.4 — parsing acontece no navegador, nada de arquivo bruto persistido no servidor. |

### 6.1 Tabelas centrais (DDL representativo — ver migrations para o esquema completo)

```sql
CREATE TYPE app.org_kind AS ENUM ('PARTNER','DIRECT');

CREATE TABLE app.organizations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                      app.org_kind NOT NULL,
  legal_name                text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 2 AND 200),
  cnpj                      text CHECK (cnpj ~ '^[0-9A-Z]{14}$'),   -- CNPJ alfanumérico a partir de jul/2026 — ver §20
  status                    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  default_assurance_level   app.assurance_level NOT NULL DEFAULT 'AL1_LINK_KNOWLEDGE',  -- default NÃO biométrico — ver §16
  link_ttl_hours            int  NOT NULL DEFAULT 168 CHECK (link_ttl_hours BETWEEN 1 AND 720),
  retain_selfie             boolean NOT NULL DEFAULT false,
  evidence_retention_months int  NOT NULL DEFAULT 240 CHECK (evidence_retention_months BETWEEN 24 AND 480),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_id_kind_key UNIQUE (id, kind)
);

CREATE TABLE app.companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  organization_kind app.org_kind NOT NULL,
  cnpj              text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{14}$'),
  legal_name        text NOT NULL,
  trade_name        text,
  archived_at       timestamptz,
  FOREIGN KEY (organization_id, organization_kind) REFERENCES app.organizations (id, kind),
  CONSTRAINT companies_org_cnpj_key UNIQUE (organization_id, cnpj),
  CONSTRAINT companies_id_org_key   UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX companies_one_per_direct_org
  ON app.companies (organization_id) WHERE organization_kind = 'DIRECT';

CREATE TABLE authz.memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app.users(id),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  company_id      uuid,                      -- NULL = toda a organização
  role            app.role NOT NULL,
  revoked_at      timestamptz,
  FOREIGN KEY (organization_id, company_id) REFERENCES app.companies (organization_id, id)
);
-- authz.memberships NUNCA recebe GRANT para `authenticated`/`anon` — só é lido por funções
-- SECURITY DEFINER. É assim que a recursão de RLS se torna estruturalmente impossível (§7).

CREATE TABLE app.employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  company_id          uuid NOT NULL,
  cpf_enc             bytea NOT NULL,          -- AES-256-GCM, chave fora do Vault — ver §20
  cpf_hash            bytea NOT NULL,          -- HMAC-SHA256(pepper, cpf) — dedupe e ligação com evidência
  cpf_masked          text  GENERATED ALWAYS AS ('***.' || substr(cpf_hash_digits,4,3) || '.***-**') STORED,
  full_name           text NOT NULL,
  registration_number text,
  phone_e164          text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  position_title      text,
  department          text,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_LEAVE','TERMINATED')),
  data_origin         text NOT NULL DEFAULT 'MANUAL' CHECK (data_origin IN ('MANUAL','IMPORT','SYNC_WOTY','API')),
  external_source     text,                    -- 'woty' quando data_origin = SYNC_WOTY
  external_ref        text,
  FOREIGN KEY (organization_id, company_id) REFERENCES app.companies (organization_id, id),
  CONSTRAINT employees_id_company_key UNIQUE (id, company_id)
);
CREATE UNIQUE INDEX employees_company_cpf_key ON app.employees (company_id, cpf_hash) WHERE status <> 'TERMINATED' OR archived_at IS NULL;
CREATE UNIQUE INDEX employees_external_key ON app.employees (company_id, external_source, external_ref) WHERE external_ref IS NOT NULL;
REVOKE SELECT (cpf_enc) ON app.employees FROM authenticated;  -- só via app.reveal_cpf(), auditado
```

`epis`/`epi_versions`, `epi_deliveries`, `epi_delivery_items`, `delivery_batches`, `confirmation_requests`, `identity_profiles`/`identity_verifications`, `delivery_contests` seguem o mesmo padrão (`organization_id` + `company_id` desnormalizados, FK composta para o pai, RLS por `company_id`). O esquema completo, com todas as `CHECK`, índices parciais e comentários, é entregue como migrations versionadas na FASE 0–2 (não duplicado aqui para o documento continuar navegável) — cada tabela abaixo tem sua justificativa registrada como comentário `COMMENT ON TABLE` na migration correspondente, seguindo a convenção já em uso no projeto WeGest desta mesma organização.

**Catálogo de EPI**: `nome`, `CA`, fabricante/modelo/descrição opcionais, `is_active`. Sem estoque, sem compras — conforme §29 do enunciado. Versionado (`epi_versions`) para que uma correção de CA não altere retroativamente uma entrega já confirmada.

## 7. Isolamento (RLS) — quatro camadas, RLS é a última, não a primeira

1. **Exposição de schema.** Só o schema `api` (views `security_invoker=true`) é visível ao PostgREST (`PGRST_DB_SCHEMAS=api`). Uma tabela sem view em `api` não existe por HTTP.
2. **Privilégio.** `anon` não tem grant de tabela nenhum, em lugar nenhum. `authenticated` tem `SELECT` nas views e `UPDATE` limitado por lista de colunas — nunca em `organization_id`, `company_id`, colunas de estado (`status`, `frozen_at`, `confirmed_at`…) ou de token. Escrita real é sempre via RPC.
3. **Estrutura referencial.** As FKs compostas do §3 — uma linha cross-tenant é violação de constraint antes de qualquer policy.
4. **RLS**, com `FORCE ROW LEVEL SECURITY`. Pega bugs nossos, não é a defesa contra um atacante.

### Funções auxiliares (o padrão obrigatório em toda policy)

```sql
CREATE SCHEMA auth_ctx;

CREATE FUNCTION auth_ctx.company_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(array_agg(DISTINCT c.id), '{}'::uuid[])
  FROM authz.memberships m
  JOIN app.companies c ON c.organization_id = m.organization_id
                       AND (m.company_id IS NULL OR c.id = m.company_id)
  WHERE m.user_id = (SELECT auth.uid()) AND m.revoked_at IS NULL AND c.archived_at IS NULL;
$$;
REVOKE EXECUTE ON FUNCTION auth_ctx.company_ids() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION auth_ctx.company_ids() TO authenticated;

CREATE POLICY employees_select ON app.employees FOR SELECT TO authenticated
  USING (company_id = ANY ((SELECT auth_ctx.company_ids())::uuid[]));
```

**Por que o `(SELECT …)` é obrigatório e não estético**: sem o wrapper, uma função `STABLE` é reavaliada por linha em um sequential scan; o benchmark oficial da Supabase mostra exatamente esse padrão indo de 9.000ms → 20ms ao mover o predicado para essa forma. Com o wrapper, o planejador do Postgres materializa a subconsulta como **InitPlan** — executado **uma vez por statement**, virando uma constante — e `company_id = ANY($0)` passa a ser um `ScalarArrayOpExpr` indexável. Isso é verificado por um **teste de CI que faz grep em toda policy exigindo o padrão `(SELECT auth_ctx.` **, não por revisão manual.

**Pegadinha real, encontrada só ao executar contra um Postgres de verdade (não por inspeção)**: o `::uuid[]` ao final não é opcional. `x = ANY ((SELECT f()))` sem o cast é interpretado pelo Postgres como a forma "`= ANY(subquery)`" — comparando `x` contra cada LINHA que a subconsulta retorna — e não como "`= ANY(array)`". Como `auth_ctx.company_ids()` retorna uma única linha contendo um valor `uuid[]`, o resultado é `operator does not exist: uuid = uuid[]`, um erro que só aparece ao rodar `CREATE POLICY`, não ao ler o código. O `::uuid[]` força a interpretação correta ("forma array") sem perder o InitPlan — confirmado via `EXPLAIN` durante a implementação da FASE 0 (ver `supabase/migrations/20260831140600_rls_policies.sql`, que documenta isso inline). As três variantes de design que alimentaram esta arquitetura tinham esse mesmo erro no pseudocódigo; foi corrigido ao escrever as migrations reais.

### Por que isso não recursa

`authz.memberships` não tem policy nenhuma nem grant nenhum para `authenticated`/`anon` — só é lida dentro de funções `SECURITY DEFINER` (que rodam como o dono da tabela, isento de suas próprias policies). É estruturalmente impossível uma policy em `memberships` disparar leitura de `memberships`. **Invariante crítico**: `authz.memberships` nunca pode receber `FORCE ROW LEVEL SECURITY` — isso re-armaria a recursão. Um teste de CI verifica `pg_class.relforcerowsecurity = false` nessa tabela especificamente, com o motivo documentado como comentário na migration.

### Por que não JWT claims

Custom Access Token Hook existe no Supabase e removeria a leitura de tabela do caminho crítico. **Rejeitado como fonte de autorização** pelos três desenhos: um token vive até 1h por padrão; um operador demitido ou um parceiro com contrato encerrado manteria acesso aos dados pessoais dos funcionários por até uma hora após a revogação — inaceitável para um produto que teria de declarar isso em um questionário de segurança ou incidente ANPD. O custo de ler a tabela é um InitPlan por statement, cache-friendly. Revogação imediata vale mais que essa otimização.

### O caminho anônimo do trabalhador

`anon` **não toca tabela nenhuma** — nem via RLS "permissiva", nem via policy alguma. O acesso é inteiramente por 4–5 funções `SECURITY DEFINER`, cada uma tomando **o token como parâmetro, nunca um id**: não há id para um IDOR substituir, porque não há id no contrato da função. Ver §8.

Para reduzir ainda mais o raio de explosão de um bug de código (ex.: um SQL dinâmico mal escapado dentro de uma dessas funções, ou um import acidental do client admin em uma rota que não deveria tê-lo), a conexão que serve o caminho do trabalhador usa um papel Postgres dedicado, `epi_worker_gw` — `NOINHERIT`, zero grant de tabela, `EXECUTE` em exatamente essas funções. A conexão de serviço executa `SET LOCAL ROLE epi_worker_gw` como a primeira instrução de toda transação do caminho do trabalhador; isso é encapsulado em um único módulo servidor (`src/server/db/worker-client.ts`) e uma regra de ESLint (`no-restricted-imports`) proíbe importar o cliente administrativo em qualquer outro lugar da árvore de rotas do trabalhador. `service_role`/`sb_secret_...` nunca serve uma requisição HTTP do trabalhador — fica reservado a migrations e jobs de fundo em contexto de confiança.

### Verificação — não é afirmação, é teste

Suite `pgTAP` obrigatória (`supabase/tests/database/`), rodando em todo PR contra um Postgres efêmero: para **cada** tabela em `app`/`evidence`/`audit`/`integ`, com dois tenants sintéticos de forma sobreposta, assere que `SET LOCAL role authenticated; SET LOCAL request.jwt.claims = '{"sub":"<user do tenant A>"}'` retorna zero linhas do tenant B, e que um `INSERT`/`UPDATE` carimbado com o id do tenant B levanta exceção. Um segundo teste varre `pg_class` e falha o build se qualquer tabela dos schemas acima tiver `relrowsecurity = false`. Isso é a Definition of Done item 14 expressa como código, não como promessa.

## 8. Confirmation flow

### Máquina 1 — `confirmation_requests` (uma tentativa; uma entrega pode ter várias)

`PENDING → SENT → VIEWED → IDENTITY_PENDING → IDENTITY_VERIFIED → CONFIRMED`, com ramos para `DELIVERY_FAILED`, `IDENTITY_FAILED` (retry até `identity_max_attempts`), `CONTESTED`, `EXPIRED`, `REVOKED`. Estados terminais: `CONFIRMED`, `CONTESTED`, `EXPIRED`, `REVOKED`.

Duas regras deliberadas:
- **Não existe aresta para `CONFIRMED` que não passe por `IDENTITY_VERIFIED`** — mesmo no nível de garantia mais baixo, `AL0_LINK_ONLY`, o fluxo cria uma linha em `identity_verifications` com `method='LINK_ONLY'`. A evidência nunca tem um campo de identificação em branco.
- **Contestar não exige identidade.** Um trabalhador que não passa na verificação facial ainda precisa poder dizer "não recebi isto" — bloquear isso deixaria uma empresa suprimir contestações configurando uma verificação que o trabalhador não consegue passar. A contestação registra honestamente o `raised_assurance_level` alcançado. Organizações que quiserem o comportamento mais estrito ligam `contest_requires_identity` (default `false`).

### Máquina 2 — `epi_deliveries` (o fato de negócio)

`DRAFT → ISSUED → {CONFIRMED | CONTESTED | CANCELLED}`, mais `SUPERSEDED` (só a partir de `CONFIRMED`/`CONTESTED`, quando uma correção é emitida). `CANCELLED` só é permitido em `DRAFT`/`ISSUED` — **nunca depois que existe uma `evidence_version`.**

Por que duas máquinas e não uma: os 11 estados do enunciado misturam propriedades de uma **tentativa** (`SENT`/`VIEWED`/`IDENTITY_*`/`EXPIRED`) com propriedades do **fato de negócio** (`CONFIRMED`/`CANCELLED`). Se `VIEWED` vivesse na entrega, um reenvio teria de sobrescrever o registro da primeira tentativa — exatamente a evidência que perderíamos ("tentamos três vezes, ele abriu duas, falhou a verificação facial uma vez") e exatamente o que não pode ser destruído.

### Fronteira de congelamento

No instante em que uma entrega chega a `CONFIRMED` ou `CONTESTED`, `frozen_at` é gravado e existe uma linha em `evidence.evidence_versions`. A partir daí: nenhuma transição para `CANCELLED`, nenhuma edição de coluna, nenhuma edição de item, nenhuma exclusão. Uma correção é uma **nova** linha em `epi_deliveries` com o mesmo `chain_id`, `chain_version+1`, apontando de volta via `corrects_delivery_id` — o trabalhador confirma a entrega corrigida, uma segunda `evidence_version` é selada carregando `prev_evidence_sha256`, e só então a linha antiga vira `SUPERSEDED`. A evidência e o recibo antigos continuam válidos e verificáveis para sempre; `/verify/<código antigo>` responde "VÁLIDO — substituído em `<data>` pelo documento `<código novo>`".

### Aplicação em nível de banco (não confiar em disciplina de código)

1. **Privilégio**: `REVOKE UPDATE` de toda coluna de estado em `authenticated`. PostgREST roda como `authenticated` — não pode escrever `status` por nenhum formato de requisição.
2. **Gatilho + tabela de regras**: um `BEFORE UPDATE` genérico valida `(OLD.status, evento, NEW.status)` contra `app.state_transitions`, semeada por migration, com PK `(machine, machine_version, from_state, event)` — não-determinismo vira violação de chave, não achado de code review.
3. **Índices únicos parciais** — o mecanismo que sobrevive a concorrência, onde gatilho sozinho não bastaria: `cr_one_confirmed_per_delivery (delivery_id) WHERE status='CONFIRMED'` torna dupla confirmação **aritmeticamente impossível**, não apenas defendida em código de aplicação — duas requisições de confirmação concorrentes, ambas passando pelo gatilho, uma falha em violação de unicidade no `COMMIT`.
4. **CHECK constraints** de coerência entre colunas (`frozen_iff_evidence`, `confirmed_only_if_achieved_ge_required`).

### Token do trabalhador — `/e/<token>`

- **Geração**: 32 bytes de CSPRNG, base64url sem padding (43 caracteres). Nunca UUID, nunca sequencial.
- **Hash calculado fora do Postgres.** O token bruto **nunca** é passado como parâmetro SQL — isso o colocaria em texto de log de query/`pg_stat_statements`/WAL, mesmo que só temporariamente. A rota Next.js (Node runtime, nunca Edge) calcula `HMAC-SHA256(pepper, token)` **antes** de chamar a função `SECURITY DEFINER`; só o hash cruza a rede até o banco.
- **O pepper vive fora do Supabase Vault** — em variável de ambiente do servidor (Vercel, criptografada, nunca `NEXT_PUBLIC_*`). Raciocínio: a brecha realista é um dump do banco; o Vault está *dentro* do banco. Manter o pepper no ambiente de aplicação garante que um dump não gera links forjáveis.
- **Armazenamento**: `confirmation_links.token_hash bytea UNIQUE`, sem coluna de plaintext em lugar nenhum.
- **Busca**: uma função `worker.open_link(p_token_hash bytea, …)` faz **uma** sondagem de índice único, checa expiração/revogação/consumo em ordem fixa, e retorna o mesmo resultado genérico para "não existe", "expirado", "revogado" e "já consumido" — só depois que o hash bate é que a resposta pode diferenciar o motivo (o chamador já provou posse do segredo, então não há vazamento de oráculo em dizer "expirado" nesse ponto).
- **Expiração**: configurável por organização (`link_ttl_hours`, default 168h/7 dias), aplicada na própria função de busca (`expires_at > now()`), não só por um sweeper — uma falha do cron nunca deve deixar um link morto passando por vivo.
- **Revogação**: imediata (checagem é na linha, não em cache). **Todo reenvio roda o token** — o link antigo é revogado na mesma transação em que o novo é emitido, garantido por índice único parcial `WHERE revoked_at IS NULL AND consumed_at IS NULL`.
- **Uso único no ato de confirmar/contestar** (visualizar é repetível — um trabalhador perde sinal e reabre o link legitimamente): `UPDATE … WHERE status='IDENTITY_VERIFIED' RETURNING id` — zero linhas de volta = replay, resposta genérica 409 mais evento de auditoria. Depois do desfecho, a mesma URL passa a renderizar um recibo somente-leitura (ainda exigindo o cookie de sessão), nunca um erro — um trabalhador que salva o link nos favoritos encontra sua prova, não uma tela quebrada.
- **Token nunca aparece na barra de endereço depois do primeiro carregamento**: `GET /e/<token>` troca por um cookie `HttpOnly; Secure; SameSite=Strict` e redireciona 303 para um caminho sem token, `/e/s/<id-de-view-opaco>`. Isso neutraliza vazamento via `Referer`, histórico do navegador e pré-visualização de link do WhatsApp (que recebe 204 sem tags OG para user-agents não-navegador, para que a pré-busca de preview não conte como visualização nem consuma nada).
- **Replay/CSRF na submissão**: cookie de sessão `SameSite=Strict` + nonce de ação de uso único, emitido quando a tela de revisão renderiza e consumido via `UPDATE … WHERE nonce_consumed_at IS NULL RETURNING id`.
- **Rate limiting em camadas**: WAF do Vercel (IP, gratuito mesmo no Hobby, primeira linha barata) + tabela Postgres `UNLOGGED` com `INSERT … ON CONFLICT DO UPDATE … RETURNING hits <= limite` (atômico, sem race de leitura-then-escrita) para limites por link/por token/por IP que precisam estar amarrados à linha que já estamos tocando na mesma transação.
- **Código público de verificação** (`/verify/<código>`): 12 caracteres Crockford base32 (60 bits) com dígito de checagem — legível em um comprovante impresso, e 60 bits mais limite de taxa por IP tornam varredura impraticável. A página não revela nome, CPF (nem mascarado), itens ou CA — apenas `{código, status, nome_fantasia_da_empresa, data_emissão, hash_prefix, coincide: true|false}`.

## 9. Abstração do provedor de identidade

```typescript
interface IdentityVerificationProvider {
  createVerification(input: CreateVerificationInput): Promise<VerificationSession>
  checkLiveness(sessionId: string, frame: MediaCapture): Promise<LivenessResult>
  verifyFace(sessionId: string, capture: MediaCapture): Promise<FaceMatchResult>
  getVerificationResult(sessionId: string): Promise<VerificationResult>
  enroll(employeeId: string, capture: MediaCapture): Promise<EnrollmentResult>
  deleteSubject(providerSubjectId: string): Promise<void>   // para exclusão sob LGPD
}
```

O domínio (`epi_deliveries`, `confirmation_requests`) nunca importa um SDK de fornecedor — só conhece essa interface e a tabela `identity_verifications`, que guarda **o resultado**, nunca o dado biométrico bruto: `provider`, `provider_verification_id`, `method`, `result`, `match_score` (string decimal fixa, nunca float), `achieved_assurance_level`, `image_sha256` (opcional) — nunca embedding, nunca template, nunca a imagem em si por padrão.

### Nível de garantia como dado, não como suposição jurídica fixa no código

```sql
CREATE TYPE app.assurance_level AS ENUM (
  'AL0_LINK_ONLY', 'AL1_LINK_KNOWLEDGE', 'AL2_SELFIE_LIVENESS',
  'AL3_FACE_MATCH_ENROLLED', 'AL4_GOV_VERIFIED'
);  -- enum ordenado: '>=' funciona nativamente
```

`organizations.default_assurance_level`, com override por `company`, copiado para cada `delivery`/`confirmation_request` **no momento da criação** — histórico permanece honesto sobre o que era exigido *então*, mesmo que a política mude depois. Uma confirmação só é aceita se `achieved >= required` (`CHECK` de banco). **Ver §16 — a pesquisa jurídica muda o default recomendado de "biométrico" para "não-biométrico" em relação ao que o enunciado original presumia.**

### Avaliação de fornecedores (pesquisa verificada — não escolha automática)

| Opção | Veredito | Por quê |
|---|---|---|
| **CompreFace** | **Rejeitada para produção.** | Sem commit desde 2023-11-14, imagens Docker de 2023-08-14, ~860 vulnerabilidades conhecidas na stack Python fixada (TensorFlow 2.2.0 sozinho: 752, 113 HIGH/CRITICAL), Spring Boot 2.5.13 fora de suporte desde 2022. Não é sobre a licença (Apache-2.0, ok) — é sobre expor um serviço morto a dados de CPF. |
| **DeepFace** | Utilizável **só com pin explícito de modelo**. | Ativamente mantido (MIT), mas o modelo *default* em toda API pública é VGG-Face, licenciado **CC BY-NC 4.0 — não-comercial**. Combinações defensáveis: Facenet/Facenet512 (MIT) ou SFace (Apache-2.0) como reconhecedor, RetinaFace/MTCNN/Dlib como detector. Nunca o detector `yolo` (Ultralytics é AGPL-3.0, copyleft de rede alcançaria nosso backend). |
| **InsightFace / buffalo_l** | **Indisponível** sem licença comercial por escrito. | O próprio README fecha a brecha: pesos, mesmo baixados automaticamente pelo pip, são "non-commercial research purposes only"; `buffalo_l` exige contato com `recognition-oss-pack@insightface.ai`. |
| **Liveness/anti-spoof open source** | **Nenhuma opção com peso jurídico real existe.** | Todo caminho permissivo (DeepFace FasNet, `facex`, `uniface`) converge para os mesmos pesos MiniFASNet de 2020 (minivision, projeto morto desde 2020-08-05, sem certificação, modelo "de verdade" privado). Repositórios "open source" de liveness com alta estrela são, na prática, SDKs proprietários com placeholder de chave de licença no lugar do arquivo de licença. |
| **AWS Rekognition Face Liveness** | Opção comercial mais viável para o piloto. | Certificado ISO/IEC 30107-3 nível 1 e 2 (iBeta), self-serve, roda em `sa-east-1`, ~US$0,015/verificação (preço US East, não confirmado para SP). **Bloqueador de lançamento**: por padrão a AWS usa as imagens para melhorar seus próprios modelos de ML — exige política de opt-out via AWS Organizations *antes* de qualquer tráfego de produção. |
| **Azure AI Face Liveness** | Viável, mas com risco de cronograma. | Também certificado ISO 30107-3, porém é *gated* — o SDK nem compila sem aprovação prévia via formulário, a critério da Microsoft, sem SLA publicado. |
| **Serpro Datavalid** (CPF ↔ base governamental) | **Bloqueada para contratação direta agora.** | Prazo de credenciamento GCC (Portaria SENATRAN 139/2025) encerrou em 22/06/2026; Serpro alerta risco de interrupção desde 23/06/2026. Acessível via revenda (ZapSign "face-match-and-datavalid" ~R$3,50; Clicksign "biometric" ~R$4,50) — viável para v1 se formos por aí, mas ~40–80x mais caro por verificação que a AWS. Datavalid explicitamente **não** detecta ataque de injeção/deepfake — só compara com a foto de base. |

**Nenhuma opção open source é adequada como decisão final de produção.** Não desenvolvemos algoritmo próprio (proibido pelo enunciado) nem tratamos comparação simples de imagem como suficiente. A abstração acima existe precisamente para que a escolha comercial (AWS vs Azure vs Serpro-via-revenda vs Unico/iProov/Incode) seja uma decisão de negócio tomada depois, sem reescrever a entrega de EPI.

## 10. Abstração de notificação

```typescript
interface NotificationProvider {
  sendConfirmationRequest(input: SendConfirmationInput): Promise<NotificationAttempt>
  sendReminder(requestId: string): Promise<NotificationAttempt>
}
```

`notification_attempts` (append-only) grava tentativa, provedor, status, erro, timestamp — nunca o link/token em si. MVP: canal `MANUAL_COPY` (gestor copia o link) + e-mail, sempre disponíveis sem depender de aprovação externa. WhatsApp Business (canal preferencial) fica de fora do MVP inicial não por escolha técnica, mas porque a aprovação de template da Meta leva semanas e o texto fica efetivamente congelado depois de aprovado — **iniciar esse processo agora é uma ação recomendada independente do cronograma de código.**

## 11. Estratégia de integração WOTY

A pesquisa confirmou que existe documentação pública, não-autenticada, em `https://integracao.woty.com.br/Help` — 27 endpoints reais em 12 controllers (`Customers`/empresas, `Employees`/funcionários, `Positions`, `Departments`, etc.), verificados por fetch direto, não inventados. Pontos concretos e já confirmados:

- `POST api/employees/minimal` aceita `Gender` como **enum numérico** (1=Masculino, 2=Feminino — não string), `BirthDate` em `dd/MM/yyyy`, CPF/telefone como strings formatadas.
- Paginação sem `total`/`hasMore` documentado e sem tamanho de página conhecido — cliente precisa iterar até página vazia.
- **Sem campo de `updatedAt`/versão e sem webhook visível** — sincronização incremental por *delta* não é possível com o que foi encontrado; a arquitetura deve assumir *full scan* periódico paginado, com filtro por data quando disponível.
- **O que permanece genuinamente desconhecido**: o **esquema de autenticação**. Toda tentativa de acesso a rota protegida retornou 401 sem corpo e sem header `WWW-Authenticate` — não há indício de OAuth, API key em header, ou Basic Auth visível de fora. **Isto não será inventado.** Exige contato direto com o WOTY/cliente para obter credenciais e, idealmente, documentação de autenticação antes de qualquer chamada real.

### Arquitetura (pronta; chamadas reais pendentes)

```
WOTY  →  integ.sync_runs (pull periódico, paginado)  →  nosso banco  →  aplicação lê só nosso banco
```

`integ.integration_connections` guarda `credential_ref` (ponteiro para Supabase Vault — aqui sim Vault é apropriado, pois é um segredo de terceiro, não nosso token de sessão), nunca a credencial em si. `integ.external_mappings (provider, entity_type, external_id, internal_id)` sobrevive independente da disponibilidade do WOTY. Escrita de sincronização passa por `app.new_employee_version(data_origin='SYNC_WOTY')` — nunca um `UPDATE` in-place, porque uma mudança de cargo vinda do WOTY não pode reescrever retroativamente o que um recibo de 2026 já declarou.

**Decisão de conflito** (WOTY vs edição manual): campos sincronizados ficam somente-leitura no painel para empresas conectadas (`integration_connections.employee_fields_are_readonly`); uma tentativa de edição manual é rejeitada com mensagem clara, não sobrescrita silenciosa no próximo sync. **Confirmar com o primeiro cliente antes da integração real** — é comportamento de UI visível, não um detalhe.

Se o WOTY cair, nada no produto quebra — a última sincronização bem-sucedida (`last_success_at`) permanece como os dados de trabalho.

## 12. Modelo de evidência

**O que provamos**: não "uma entrega aconteceu" — precisamente, que **este** trabalhador, identificado **desta forma**, neste instante, viu **estas palavras exatas** e **estes itens exatos**, e apertou confirmar. O payload carrega as *strings de exibição*, não só ids — um tribunal pergunta o que ele viu, não o que nossas foreign keys diziam.

### Armazenamento: normalizado + JSONB + bytes crus, as três coisas

- Colunas normalizadas (`epi_delivery_items.epi_name/ca_number/quantity`) — sem isso, a dashboard de lote de 237 linhas, busca por CA, filtro por departamento viram *sequential scan* sobre documentos.
- `payload jsonb` — o documento evidencial completo, incluindo o texto renderizado da declaração com substituições aplicadas.
- `canonical_bytes bytea` — os bytes UTF-8 literais que alimentaram o SHA-256. Reconstituir um documento byte-a-byte a partir de doze tabelas em 2031 depende de doze pedaços de código se comportando identicamente a 2026; guardar os bytes elimina essa dependência. `CHECK (payload_sha256 = digest(canonical_bytes,'sha256'))` — o próprio banco recusa uma linha incoerente.

### Canonicalização — `epi-canon/1`

Base: **RFC 8785 (JSON Canonicalization Scheme — JCS)**. Citar um padrão publicado, e não inventar um formato, importa em tribunal: um perito consegue verificar nosso hash com uma biblioteca padrão de mercado. Regras adicionais (todas *restringem* JCS, nunca o contradizem):

1. Toda string (chave e valor) normalizada para **NFC** antes de serializar; rejeitamos (erro no selamento, não corrigimos silenciosamente) surrogates desemparelhados e caracteres de controle/bidi ocultos.
2. **Nenhum número de ponto flutuante.** Toda quantidade decimal (score, threshold) é string com casas decimais fixas. Arredondamento de double é a causa mais comum de uma canonicalização parar de reproduzir — eliminamos a regra em vez de documentá-la.
3. **`null` proibido.** Ausência de valor é chave ausente, nunca `null` nem string vazia.
4. Instantes: sufixo de chave `_utc`, RFC 3339 em UTC com `Z` literal e exatamente 3 casas decimais. Datas locais são strings de exibição opacas, nunca reprocessadas.
5. Arrays têm ordem definida no schema (`items` por `line_no` asc).
6. `_canon` (o identificador desta versão do algoritmo) vai **dentro** do documento hasheado — nunca pode ser reatribuído depois. Mudança de regra = `epi-canon/2`, implementação da v1 nunca é apagada do repositório, e **vetores de ouro** (payload fixo com nome acentuado, emoji, array vazio, inteiro no limite de precisão) são fixture de CI para sempre — um PR que mude o hash da v1 quebra o build.

### Selamento — uma transação, ou nada

`app.confirm_delivery(request_id)` (`SECURITY DEFINER`) faz, atomicamente: revalida o estado, transiciona `confirmation_requests`→`CONFIRMED`, transiciona `epi_deliveries`→`CONFIRMED` (grava `frozen_at`), monta e hasheia o payload, grava em `audit.audit_events` (ganhando posição na cadeia), insere em `evidence.evidence_versions` **amarrando** `audit_seq`/`audit_head_hash`, consome o link. Se qualquer passo falha, tudo desfaz — nunca existe uma janela em que a entrega está `CONFIRMED` sem evidência, ou evidência sem posição na cadeia de auditoria. Geração do PDF acontece **depois** do commit, assíncrona — uma falha de renderização nunca pode custar a confirmação.

### Imobilidade — quatro camadas

1. `REVOKE INSERT, UPDATE, DELETE, TRUNCATE` em `evidence.*`/`audit.*` de **todo** papel, incluindo `service_role`. Escrita só por função `SECURITY DEFINER` do dono.
2. Gatilho `BEFORE UPDATE OR DELETE → RAISE` — dispara mesmo para um superusuário via `psql`.
3. Schemas `evidence`/`audit` fora de `PGRST_DB_SCHEMAS` — nenhum endpoint HTTP os alcança.
4. Detectabilidade: cadeia de hash (ver §13) mais âncora externa diária. **Reivindicamos evidência à prova de adulteração (*tamper-evident*), não invulnerabilidade (*tamper-proof*)** — um superusuário do Postgres pode desabilitar o gatilho e reescrever uma linha, e isso **quebra a cadeia** naquele ponto, contradizendo um carimbo de tempo de terceiro que não controlamos. Dizer isso claramente na documentação voltada ao cliente é o que preserva credibilidade num eventual litígio — superestimar a garantia é como se perde credibilidade no banco das testemunhas.

## 13. Modelo de auditoria

`audit.audit_events` — append-only, **encadeado por hash, por organização** (não uma cadeia global): `event_hash = sha256(canon(prev_hash || seq || org || tipo || timestamp || entidade || ator || dados))`. Cadeia por tenant, não global, por três razões: exportação de um tenant não vaza a existência de eventos de outro; sem ponto de escrita quente único; permite particionamento futuro por `hash(organization_id)` sem quebrar a unicidade `(organization_id, seq)`.

Tipos de evento (subconjunto do enunciado, com adições que a pesquisa mostrou necessárias): `DELIVERY_CREATED/ISSUED/CANCELLED/SUPERSEDED`, `CONFIRMATION_CREATED/SENT/REVOKED/EXPIRED`, `LINK_VIEWED/LOCKED`, `IDENTITY_STARTED/VERIFIED/FAILED`, `DELIVERY_CONFIRMED/CONTESTED`, `CONTEST_RESPONDED`, `EVIDENCE_SEALED`, `DOCUMENT_GENERATED/VERIFIED`, `BATCH_CREATED/COMPLETED`, `IMPORT_COMMITTED`, `CPF_REVEALED`, `PLATFORM_ACCESS_GRANTED/USED`, `MEMBERSHIP_GRANTED/REVOKED`, `SYNC_RUN_COMPLETED`, `RATE_LIMIT_TRIPPED`.

**Nunca em `audit.audit_events`**: selfie, biometria, segredo, token completo, CPF completo sem necessidade. `data jsonb` tem `CHECK (pg_column_size(data) < 8000)` — um limite físico contra alguém tentar enfiar um blob ali por engano.

Uma âncora diária por tenant (`audit.chain_anchors`) — o hash de topo da cadeia daquele dia, timestampado externamente (RFC 3161, autoridade ICP-Brasil credenciada — ver §20 sobre se isso é necessário por confirmação ou só diariamente) e espelhado em armazenamento *object-lock*. Converte "afirmamos que não adulteramos" em "um terceiro atestou nosso hash de topo naquela data".

## 14. Storage

Todos os buckets **privados**. Caminho determinístico `evidence/{organization_id}/{company_id}/{ano}/{mes}/{evidence_id}/{revisão}.pdf`, policy de `storage.objects` checando o segmento de `company_id` contra `auth_ctx.company_ids()`. Acesso sempre via **signed URL de 60 segundos**, mintada no servidor — nunca URL permanente.

Ponto crítico verificado na documentação atual da Supabase: `expiresIn` de uma signed URL é um inteiro em segundos **sem teto prático** (~285 anos) e **sobrevive a qualquer rotação/revogação de chave de Auth** — só a Supabase (via suporte) consegue revogar uma antes do prazo. Para documentos com CPF/dados de trabalhador, isso é incompatível com um pedido de eliminação sob LGPD se alguém configurar TTL de "1 ano" por conveniência. **Regra do produto: TTL de signed URL em minutos, nunca dias, sem exceção — enforçado em code review e, se possível, em um wrapper único que rejeita `expiresIn > 300`.**

Selfies (quando um fornecedor exigir uma, e só se a organização tiver `retain_selfie=true`) vão para um bucket `biometric-transient` que **nenhum papel de aplicação consegue ler** — só o adaptador de servidor, com purga por `pg_cron` dentro de 24h da confirmação do resultado, salvo retenção explícita e temporizada por contrato.

## 15. Segurança — threat model

| Ameaça | Mitigação | Onde |
|---|---|---|
| Tenant escape | FKs compostas encadeadas + RLS `FORCE` + teste pgTAP obrigatório de dois tenants | §3, §7 |
| IDOR | Funções do trabalhador tomam **token**, nunca id — não há id para substituir | §7, §8 |
| Enumeração de token | 256 bits de CSPRNG; resposta genérica idêntica para inexistente/expirado/revogado até prova de posse | §8 |
| Vazamento de token | Hash calculado fora do SQL; troca por cookie antes do primeiro render; `Referrer-Policy: no-referrer`; zero terceiros na página do trabalhador | §8 |
| Replay | Nonce de ação de uso único + índice único parcial + `UPDATE … WHERE status=X RETURNING` (não read-then-write) | §8 |
| Força bruta / credential stuffing | Rate limit em camadas (WAF + Postgres atômico); bloqueio de link vira evento auditável visível ao cliente | §8 |
| Upload malicioso | **Nenhum arquivo bruto chega ao servidor** — parsing de CSV/XLSX no navegador; ver §17 | §17 |
| Confirmação forjada | Selamento atomicamente ligado à cadeia de auditoria; `achieved >= required` é `CHECK` de banco | §8, §12 |
| Escalada de privilégio | `role_permissions` só editável por migration; troca de papel exige `membership` explícita | §5 |
| Adulteração de auditoria | Append-only forçado em 4 camadas independentes (§12) | §12, §13 |
| Mass assignment | `REVOKE UPDATE` em toda coluna de tenant/estado — PostgREST fisicamente não consegue escrevê-las | §7 |
| XSS | CSP estrita com nonce (ver Next.js §20), sem script de terceiro na rota `/e/*` | §17 |
| CSRF | Cookie `SameSite=Strict` (POST cross-site não carrega cookie algum) + double-submit + nonce | §8 |
| SQL injection | Toda escrita via RPC parametrizada; nenhum SQL dinâmico fora de `format(%I,%L)` explicitamente justificado | §7 |
| Exposição de storage | Bucket privado + signed URL curta; nunca URL pública | §14 |
| Vazamento de segredo | Segredos só server-side; pepper de token fora do Vault; `service_role`/`sb_secret_...` nunca no caminho do trabalhador | §8, §14 |
| Credencial de integração comprometida | Credencial nunca em texto puro — ponteiro para Vault; escopo mínimo; sync nunca é dependência de runtime | §11 |

## 16. Privacidade / LGPD

A pesquisa jurídica revelou um fato que **muda a recomendação de default do enunciado original**: em agosto de 2026, a ANPD **suspendeu** um sistema de reconhecimento facial (caso Paraná/educação, NT 4/2026) exatamente pelo raciocínio de que biometria não era "indispensável" (art. 11, II, "a") quando a própria norma setorial já oferecia alternativa não-biométrica — e a **NR-6 6.5.1 "d" oferece explicitamente** "livros, fichas ou sistema eletrônico" como alternativas à biometria. Pelo mesmo teste que a ANPD aplicou, biometria não é indispensável para cumprir a NR-6.

**Decisão de arquitetura resultante**: o fluxo **default** não é biométrico. `organizations.default_assurance_level = 'AL1_LINK_KNOWLEDGE'` (link + desafio de conhecimento/OTP), mapeável a "assinatura eletrônica simples" (Lei 14.063/2020 art. 4º, I). Biometria (`AL2`+) é **opt-in por organização**, nunca o caminho obrigatório — e mesmo quando ligada, a base legal recomendada é **art. 11, II, "g"** (prevenção a fraude na autenticação de cadastro), não consentimento (art. 11, I) — a ANPD já sinalizou que consentimento é uma base frágil na relação de trabalho por desequilíbrio de poder.

Outros pontos que a pesquisa tornou não-negociáveis:

- **Hashear/templatizar não tira o dado do regime de dado sensível.** A própria ANPD (NT 4/2026, itens 5.63–5.64) afirma isso explicitamente. Não vamos comercializar a frase "não guardamos biometria" sem ressalva jurídica — guardamos o **resultado**, e mesmo isso é dado pessoal enquanto vinculado a uma pessoa.
- **CPF nunca em texto puro fora de `cpf_enc`** (cifrado, chave fora do Vault) — dedupe e ligação evidencial usam `cpf_hash` (HMAC com pepper).
- **Minimização por padrão**: `retain_selfie=false`, imagem de verificação normalmente descartada (mantém-se só o SHA-256 dela, para a evidência continuar dizendo *qual* imagem foi usada mesmo depois de destruída).
- **Retenção**: sem regra expressa para a "ficha de EPI" especificamente. 20 anos após desligamento é o número **derivado** (convergência de NR-1 1.5.7.3.3.1, NR-7 7.6.1.1, IN INSS 128/2022 art. 284 §9º) e o default do produto — mas retenção de **artefato biométrico bruto** é separada e muito mais curta (dias/semanas), nunca acoplada ao prazo de 20 anos da evidência textual. Ver §20 — número final precisa de aprovação jurídica.
- **RIPD/DPIA**: não é opcional para um sistema com opt-in biométrico em escala — é o próprio ponto que a ANPD usou contra o caso Paraná (ausência de análise documentada de necessidade/proporcionalidade). O produto deve gerar um rascunho de RIPD por tenant que ligar biometria, revisável por advogado — não apresentado como "compliance pronta".
- **Nunca em log**: biometria, segredo, token completo, CPF completo desnecessário — reforçado por serializador com *denylist* de chaves (`token`, `cpf`, `image`, `authorization`) mais um *scrubber* de caminho que reescreve `/e/<43 chars>` antes de qualquer coisa alcançar o coletor de log, testado por unidade.

## 17. PWA

Manifest (`name`, `short_name`, `icons` 192+512px, `start_url`, `display: standalone`), `apple-touch-icon`, `apple-touch-startup-image` + `apple-mobile-web-app-capable` (iOS ainda depende disso para splash screen mesmo após a mudança do Safari 26 que tornou o manifest opcional para instalabilidade). `viewport-fit=cover` + `env(safe-area-inset-*)`; `100svh` como base do palco de câmera (não `100dvh`, que redimensionaria o guia oval durante a sessão).

**Achado decisivo e não resolvido pela pesquisa**: não existe confirmação oficial de que `getUserMedia` funciona dentro do navegador embutido do WhatsApp para um link comum colado em conversa (só uma referência de parceiro BSP sobre um "In-App Browser" da Meta limitado a botões de CTA em template comercial aprovado). Há um defeito documentado e não corrigido pela Apple em navegadores embutidos do iOS desde a versão 15.1 para `getUserMedia` com áudio — mitigado pedindo sempre `{video:true, audio:false}` — mas a captura de vídeo sozinha dentro do WhatsApp iOS **não está confirmada nem refutada** por fonte primária.

**Consequência de arquitetura, não deixada para depois**: a tela do trabalhador faz uma sondagem de capacidade (`window.isSecureContext && navigator.mediaDevices?.getUserMedia`, tentativa real dentro do toque do usuário, timeout de ~8s) e **"abrir no navegador" é um passo de primeira classe do fluxo**, não uma tela de erro — nunca presumimos que a câmera funciona dentro de um navegador embutido. Fallback: `<input type="file" accept="image/*" capture="user">` é aceito, mas **qualquer captura vinda dele é classificada como garantia reduzida** (sem liveness possível, sinalizada para revisão manual, nunca auto-aprovada) — ele só entrega uma foto estática, sem stream, sem controle de pipeline, incapaz de provar que não é foto de uma foto. **Antes de comprometer a arquitetura de captura, é obrigatório um teste em dispositivos físicos reais** (iOS Safari, iOS WhatsApp com link comum e com CTA de template, iOS Instagram/Facebook, Android Chrome, Android WhatsApp) — nenhuma fonte documental resolve isso.

Sem confirmação offline — servidor é obrigatório para preservar consistência da evidência, conforme o enunciado. Service worker cobre apenas o *shell* de UI. `Background Sync` não existe em Safari iOS em nenhuma versão — upload da captura é imediato, em página, com retry explícito, nunca "enviar quando a conexão voltar".

## 18. Estratégia de teste

- **Unitário (Vitest 4)**: canonicalização (vetores de ouro fixos), máquina de estados, geração/hash de token, validação de CPF/CNPJ (incluindo o CNPJ alfanumérico a partir de jul/2026 — ver §20), parsing de CSV.
- **RLS/isolamento (pgTAP, `supabase test db`)**: a suíte descrita em §7 — dois tenants sintéticos, toda tabela de negócio, roda em todo PR contra Postgres efêmero via `supabase db reset`.
- **E2E (Playwright, contra build de produção)**: os 16 passos da Definition of Done fim-a-fim, incluindo o passo 14 (outro tenant não acessa nada).
- **Não buscamos 100% de cobertura** — cobertura dos invariantes críticos: isolamento de tenant, transições de estado impossíveis, segurança de token, imutabilidade de evidência, criação de lote, hashing de evidência.

## 19. Deployment

- Vercel, região de função fixada em `gru1` (São Paulo/`sa-east-1`) — **isto é possível em qualquer plano**, não exige Enterprise (só *multi*-região exige Pro+); confirmado contra a documentação atual, corrigindo uma suposição inicial errada.
- Runtime Node (nunca Edge) em toda rota que toca o pepper de token ou credenciais — `proxy.ts`/middleware roda só como checagem otimista.
- Supabase, projeto dedicado, `sa-east-1`, Postgres 17.
- CI: `supabase/setup-cli@v1`, `supabase db reset` (aplica migrations do zero) + pgTAP em todo PR; `supabase db push` em staging/produção via workflow separado, nunca `db push` manual contra produção.
- Falha de plano Pro relevante e verificada: **failover multi-região de Vercel Functions é recurso Enterprise** — no plano Pro, uma indisponibilidade regional é uma indisponibilidade, ponto. Isso é uma decisão de negócio (aceitar o risco vs. pagar Enterprise), não um detalhe técnico — sinalizado em §20.

## 20. Decisões pendentes (não decidir em código)

### Requer parecer jurídico antes de lançar

- **Nível de garantia de identidade que um tribunal trabalhista brasileiro efetivamente aceita para a NR-6** — a arquitetura já trata isso como dado configurável por organização (`assurance_level`), então uma resposta errada hoje custa mudança de configuração, não migration. Mas a alegação comercial ("assinatura eletrônica avançada", nível de confiança X) depende dessa resposta.
- **Base legal LGPD para o ramo biométrico** — art. 11, II, "g" (recomendado pela pesquisa) vs. art. 11, I (consentimento, desaconselhado pela própria ANPD na relação de trabalho). Determina todo o modelo de retenção/exclusão do ramo biométrico.
- **Se um selfie guardado sem *matching* facial ainda conta como dado biométrico** sob a LGPD — muda se a captura "leve" (sem verificação facial real) é uma opção de produto genuinamente mais simples juridicamente.
- **Prazo de retenção definitivo da "ficha de EPI"** — 20 anos é derivado, não expresso em lei; e prazo separado, mais curto, para artefato biométrico bruto.
- **Necessidade de assinatura/carimbo ICP-Brasil** sobre a evidência selada — muda se cadeia de hash + carimbo RFC 3161 comum basta ou se é preciso uma Autoridade de Carimbo do Tempo credenciada ICP-Brasil por confirmação (custo estimado ~R$0,05–0,20/entrega, real e recorrente em escala).
- **Se um Partner (clínica) pode ver o CPF completo dos funcionários das empresas-cliente** — questão de operador/controlador no contrato, não de engenharia.
- **RIPD/DPIA obrigatório antes do lançamento com biometria ligada** — a ANPD tratou a ausência disso como parte da violação no caso citado.

### Requer serviço pago / credenciais

- **Credenciais de autenticação da API do WOTY** — desconhecidas até contato direto com o WOTY/cliente. Nenhuma chamada real será implementada antes disso; a arquitetura de adaptador já está pronta (§11).
- **Fornecedor comercial de verificação facial/liveness** — nenhuma opção open source é defensável para produção (§9). Requer escolha entre AWS Rekognition (self-serve, mais barato, exige opt-out de treinamento de ML antes do primeiro tráfego), Azure (gated, sem SLA de aprovação) ou Serpro-via-revenda (mais caro, mais alinhado à base do CPF).
- **Provedor de WhatsApp Business** — aprovação de template da Meta leva semanas; recomendado iniciar processo já, independente do cronograma de código.
- **Plano Vercel/Supabase** — Pro (não Hobby) é necessário para: WAF com mais de 1 regra, region failover (se decidido), armazenamento além do limite gratuito, e Storage com transformação de imagem. Custo recorrente real, a aprovar.

### Comprometem segurança / são irreversíveis

- **Projeto Supabase de produção vs. desenvolvimento** — ainda não resolvido nesta conversa (dois projetos foram criados: `yqbhdpennqcywxatvhwr` e `zowuandkuubskaqlpfka`; qual é qual não foi confirmado). **Bloqueia a configuração do `.env`/CI até resposta** — ver próxima mensagem ao usuário.
- **Chaves novas do Supabase (`sb_publishable_`/`sb_secret_`) em vez das legadas `anon`/`service_role`** — decisão tomada nesta arquitetura (as legadas saem de projetos novos a partir de nov/2025 e são descontinuadas até fim de 2026), mas é registrada aqui por ser o tipo de decisão que, se um tutorial desatualizado for seguido, reverte silenciosamente.
- **Formato de CNPJ alfanumérico** — Receita Federal muda o formato a partir de ~jul/2026 (IN RFB 2.229/2024); toda validação/coluna precisa aceitar letras desde o primeiro dia, mesmo que nenhum CNPJ alfanumérico real apareça ainda. Decisão já tomada no schema (`cnpj text CHECK (~ '^[0-9A-Z]{14}$')` em vez de `char(14)` numérico) — mas o algoritmo exato de dígito verificador (verificado independentemente contra o exemplo oficial da Receita) precisa de teste unitário fixo antes de qualquer CNPJ real ser aceito.
- **Isolamento físico por tenant** — RLS compartilhado é a decisão para os primeiros ~100 tenants. Se um cliente grande ou regulado exigir projeto Supabase próprio ou BYOK, o caminho de migração é conhecido (projeto por tenant + camada de roteamento) mas caro — melhor saber disso agora do que depois de cem tenants no mesmo banco.
- **Pepper de CPF e de token — custódia e rotação.** Ambos vivem fora do Vault (decisão tomada, §8/§16), mas **quem** detém a cópia de emergência, onde fica o *escrow*, e o que acontece se o segredo do ambiente de produção se perde precisa de um procedimento escrito antes da primeira confirmação real ser selada — perder o pepper de CPF não apaga a evidência, mas destrói para sempre a capacidade de reconfirmar o CPF por trás de um hash histórico.
- **Reconciliação NR-1 1.6.2 (exige certificado ICP-Brasil para documento digital) vs. NR-6 6.5.1 "d" (permite sistema eletrônico simples, sem menção a ICP-Brasil)** — nenhum instrumento oficial encontrado resolve a tensão entre as duas normas. Decide se selo ICP-Brasil é obrigatório ou um diferencial comercial opcional.

---

Este documento é reavaliado a cada fase — ver `docs/mvp-roadmap.md`. Nenhuma fase avança para código sem que as decisões marcadas "bloqueia" acima estejam resolvidas.
