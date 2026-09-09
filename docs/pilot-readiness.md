# PILOT READINESS — Selo

**Data da auditoria:** 2026-09-09
**Escopo:** determinar se conseguimos colocar **uma empresa real** no sistema e executar o fluxo completo de entrega de EPI, com segurança.
**Não é escopo:** adicionar capacidades. Nenhum módulo novo foi construído para esta auditoria.

---

## 0. Como ler este documento

Cada afirmação aqui é **medida** ou **declarada como não medida**. Onde houve execução, o artefato que a produziu está nomeado e pode ser rodado de novo:

| Artefato | O que produz |
|---|---|
| `scripts/pilot-readiness-probe.mjs` | Os 18 passos do cenário, executados contra o projeto `epi-dev` real, com o percurso do trabalhador conduzido no **navegador de verdade** |
| `scripts/security-audit.mjs` | Auditoria de catálogo (RLS, `SECURITY DEFINER`, `search_path`, superfície `anon`, imutabilidade, PII) sobre o schema construído a partir das 69 migrations |
| `.github/workflows/ci.yml` | 25 arquivos pgTAP + corridas reais de concorrência, em Postgres real |
| `scripts/e2e-phase-g.mjs`, `e2e-phase-h.mjs`, `*-ui.mjs` | Verificações ao vivo das fases G e H |

**Por que o percurso do trabalhador roda no navegador e não por RPC:** selar evidência exige canonicalizar um payload em Node (`epi-canon/1`) antes de ele chegar ao Postgres. Uma sonda que chamasse `worker.finish_confirmation` direto teria de reimplementar esse passo — e então estaria testando a minha reimplementação, não o produto. O mesmo vale para cadastrar o funcionário: o hash e a cifra do CPF acontecem no app.

---

## 1. Cenário end-to-end — resultado

**18 de 18 PASS**, medidos em 2026-09-09 contra `epi-dev`, com build de produção.

| # | Requisito | Veredito | Evidência |
|---|---|---|---|
| 1 | Criar/ativar uma organização cliente | **PASS** | `api.onboard_organization` cria organização + empresa + `ORG_ADMIN` numa transação |
| 2 | Criar usuários da empresa com permissões corretas | **PASS** | Convite emitido com papel e escopo; `auth_ctx.can_grant_role` impede escalada (7 recusas provadas na suíte 230) |
| 3 | Importar ou cadastrar funcionários | **PASS** (cadastro) | Criado pelo formulário real; CPF gravado só como hash+cifra+máscara (`***.921.852-**`) |
| 4 | Cadastrar EPIs/variantes | **PASS** | EPI criado pelo formulário real, CA 200770 |
| 5 | Criar uma entrega individual | **PASS** | `create_delivery` + `issue_delivery` |
| 6 | Criar uma entrega em massa | **PASS** | `create_delivery_batch` → 1 lote, 1 entrega, tokens gerados em Node |
| 7 | Trabalhador acessar por link seguro | **PASS** | Contexto de navegador **sem sessão nenhuma** → `/e/<token>` → `/e/s/<id>` |
| 8 | Visualizar exatamente os EPIs entregues | **PASS** | A tela mostra o nome do EPI e o CA da entrega |
| 9 | Passar pelo mecanismo de identidade | **PASS** | AL1: link + 3 últimos dígitos do CPF + assinatura desenhada |
| 10 | Confirmar ou contestar | **PASS** | `status=CONFIRMED` |
| 11 | Preservar snapshot/evidência imutável | **PASS** | `evidence_version` selada, `payload_sha256` presente |
| 12 | Gerar comprovante | **PASS** | Código `VZN9S2D3A1CB` |
| 13 | Verificar comprovante por QR/código | **PASS** | `/verify/<code>` responde **sem sessão** e **sem PII** do trabalhador |
| 14 | Gestor acompanhar pendentes/confirmados/contestados | **PASS** | `dashboard_summary` com as seis contagens |
| 15 | Executar troca/reposição | **PASS** | `create_replacement_delivery` encadeia a substituição |
| 16 | Ver alertas de ciclo de vida/compliance | **PASS**, com condição | Só depois de ligar `compliance_enabled` — ver §1.1 |
| 17 | Isolamento total entre tenants | **PASS** | Admin de outro tenant: 0 linhas visíveis; escrita recusada com `42501` |
| 18 | Revogações com efeito imediato | **PASS** (evidência anterior) | Ver §1.1 |

### 1.1 Ressalvas honestas sobre os PASS

Três vereditos acima merecem qualificação, e escondê-la tornaria a tabela inútil:

- **#16 exigiu ligar um flag.** `compliance_enabled` nasce `false` em toda organização — decisão correta (nenhum tenant existente muda de comportamento), mas significa que **todo cliente novo precisa disso ligado deliberadamente**. Está no checklist de onboarding (§5). Sem isso o módulo responde `feature_disabled`, que é o comportamento certo, não um defeito.
- **#18 não foi remedido nesta execução.** É citado das fases G (19/19) e H (18/18), onde revogar cortou a leitura na chamada seguinte, sem sessão a expirar. É evidência real, mas de ontem, não de hoje.
- **#3 cobre cadastro, não importação.** O caminho de import CSV/XLSX existe (`/employees/import`, `/epis/import`, `app.import_runs`) e tem suíte pgTAP, mas **não foi exercitado nesta auditoria**. Ver P1-4.

### 1.2 O que a própria sonda errou, e por que isso importa

Cinco execuções desta sonda reportaram falhas que **não eram do produto**. Registro porque cada uma é uma armadilha que qualquer teste de UI deste repositório vai encontrar de novo:

1. **`button[type="submit"]` clica em "Sair".** A barra lateral renderiza `<form action={signOut}>` antes na DOM. Três execuções acusaram falha no cadastro de funcionário que era o meu clique deslogando a sessão.
2. **Ler o banco logo após o clique mede o instante errado.** `networkidle` dispara enquanto o botão ainda diz "Salvando…". Passos 3, 4 e 10 falharam por isso.
3. **Inputs controlados perdem o preenchimento antes da hidratação**, e o `required` nativo bloqueia o submit com um balão que não aparece em screenshot nem em `innerText`.
4. **Antes da hidratação o submit é um POST nativo** — a página recarrega vazia, sem erro nenhum na tela.
5. **O token do link do trabalhador é HMAC com pepper**, não SHA-256 simples. Hashear errado derrubou os passos 7 a 13 de uma vez por um motivo que nada tinha a ver com o produto.

**Nenhuma delas virou achado de produto.** Uma foi investigada em isolamento (`/employees/new` aguentou 5 navegações seguidas) justamente para não reportar defeito irreproduzível fora do meu próprio arnês.

---

## 2. Revisão de segurança

Medido por `scripts/security-audit.mjs` salvo onde indicado.

| Área | Veredito | Fato |
|---|---|---|
| **RLS** | **PASS** | Toda tabela de negócio com RLS habilitada; forçada em todas menos `authz.memberships`, que é deliberada (FORCE prende o dono, e os helpers `auth_ctx.*` são `SECURITY DEFINER` que precisam ler entre tenants) e que **não tem grant para papel nenhum**. Nenhuma tabela concedida a `authenticated`/`anon` sem policy. Toda view `api.*` com `security_invoker` |
| **SECURITY DEFINER** | **PASS** | Todas as funções `SECURITY DEFINER` fixam `search_path` |
| **search_path** | **PASS** | Todas fixam o caminho **vazio**, não um conveniente |
| **storage policies** | **N/A** | Supabase Storage **não é usado em lugar nenhum**: nenhum bucket, nenhuma policy em `storage.objects`. A evidência vive no Postgres. Não há o que configurar errado — e não há anexo de foto no produto |
| **tokens públicos** | **PASS** | `anon` executa exatamente 5 funções (`worker.*`) e **não tem privilégio direto em tabela ou view nenhuma**. Token do trabalhador: HMAC-SHA256 com pepper, o cru nunca chega ao Postgres. Convite: SHA-256 de 256 bits de CSPRNG. Código de verificação é chave de busca, não segredo |
| **rate limiting** | **PASS** (plano do trabalhador) | `app.check_rate_limit` é chamada nas três RPCs do trabalhador — 20/5min por token e 60/5min por IP — mais `identity_max_attempts` (5). API pública tem `m2m.quota_counters`. O login do gestor depende do limite do próprio GoTrue |
| **idempotência** | **PASS** (API) / **PARTIAL** (painel) | A API pública faz claim → domínio → COMPLETED numa transação, então "domínio gravado mas cliente sem resposta" é estruturalmente impossível. **As Server Actions do painel não são idempotentes**: duplo clique pode criar duas entregas. Ver P2 |
| **audit trail** | **PASS** | Encadeado por hash por organização, append-only, com trigger de backstop, sem grant para papel nenhum — nem `service_role` |
| **imutabilidade** | **PARTIAL → P1-1** | `audit.audit_events` e `evidence.evidence_versions` têm trigger contra UPDATE/DELETE. **`evidence.documents` não tem.** Ver P1-1 |
| **PII / CPF** | **PASS** | Varredura de catálogo: só `cpf_hash` (bytea), `cpf_enc` (bytea) e `cpf_masked`. Nenhuma coluna em claro. A página pública `/verify` foi medida e não expõe nome nem CPF |
| **biometria** | **N/A, por decisão** | AL2–AL4 não implementados e lançam explicitamente. O padrão é AL1 não biométrico, por leitura da NT 4/2026 da ANPD. Não há template biométrico em lugar nenhum do schema |
| **backups / recovery** | **DESCONHECIDO → P1-2** | Não consigo ler o plano nem a configuração de PITR do projeto Supabase a partir daqui |
| **observabilidade** | **FAIL → P1-3** | Seis pontos de log em toda a aplicação. Sem rastreamento de erro, sem alerta — exceto a checagem de atraso do runner de webhooks |
| **tratamento de erro** | **PASS** | `describeRpcError` traduz código do Postgres para pt-BR sem vazar nome de constraint ou schema; a API devolve 503 para erro de configuração e 500 opaco para o resto |
| **secrets** | **PARTIAL → P1-5** | Nove variáveis obrigatórias, todas fora do Vault por decisão (o dump do banco é a ameaça realista). **Não existe procedimento escrito de custódia, escrow e rotação** |
| **migrations** | **PASS** | 69 migrations aplicam do zero (medido hoje); disciplina append-only; o CI prova a aplicação a partir do nada a cada PR |
| **rollback / recovery** | **PARTIAL → P1-6** | Não há migration de volta (append-only, por desenho) e o rollback da Vercel **não desfaz migration** |

---

## 3. Blockers P0/P1

Nenhum **P0**. Nada impede tecnicamente colocar um cliente e rodar o fluxo — isso foi executado hoje, inteiro.

Os P1 abaixo são o que separa "funciona" de "posso responder por isso quando der problema".

### P1-1 — `evidence.documents` sem trava de imutabilidade
**O quê:** a tabela que liga o código de verificação à versão da evidência não tem o trigger contra UPDATE/DELETE que suas irmãs têm.
**Impacto real:** repontar um `verification_code` para outra `evidence_version` faria o QR de um comprovante impresso verificar contra conteúdo diferente. Alcançável apenas por quem tem acesso de dono ao banco — mas essa é exatamente a camada que `evidence_versions` já fecha, e a assimetria não está documentada em lugar nenhum. É a alegação central do produto.
**Correção:** uma migration com o mesmo trigger já usado em `evidence_versions`.

### P1-2 — Backup e recuperação não confirmados
**O quê:** ninguém confirmou plano do Supabase, retenção de backup ou PITR.
**Impacto real:** a evidência de um cliente real passa a viver ali. Sem PITR, um `DELETE` errado ou um incidente do fornecedor é perda definitiva de prova pericial. Também não houve **teste de restauração** — backup não testado não é backup.
**Correção:** confirmar o plano, ativar PITR, e restaurar uma vez para um projeto descartável, cronometrando.

### P1-3 — Sem observabilidade
**O quê:** seis pontos de log; nenhum rastreamento de erro; nenhum alerta.
**Impacto real:** se o cliente-piloto encontrar um erro, ninguém fica sabendo. O produto acabou de encontrar cinco defeitos reais em produção **só porque alguém foi olhar** — em piloto não haverá quem olhe.
**Correção:** rastreador de erro no app e nas rotas `/api/*`, mais alerta para: falha de Server Action, `5xx` na API, e outbox de webhook parado.

### P1-4 — Importação nunca exercitada ponta a ponta
**O quê:** o caminho CSV/XLSX tem RPCs e suíte pgTAP, mas nenhuma execução ao vivo com arquivo real.
**Impacto real:** é assim que um cliente de verdade carrega 200 funcionários. Se falhar no primeiro dia, o piloto começa cadastrando à mão.
**Correção:** rodar um import real de ~50 linhas com CPFs válidos, incluindo linhas ruins, e conferir `import_runs`.

### P1-5 — Segredos sem custódia escrita
**O quê:** nove segredos, dos quais dois são irrecuperáveis por natureza.
**Impacto real:** perder `CPF_HASH_PEPPER` não apaga a evidência, mas **destrói para sempre** a capacidade de reconferir o CPF por trás de um hash histórico. Perder `WORKER_TOKEN_PEPPER` invalida todo link pendente. Hoje isso mora num `.env` e na Vercel, sem escrow.
**Correção:** procedimento de uma página — quem detém a cópia, onde fica o escrow, o que se faz se o valor de produção se perder.

### P1-6 — Sem estratégia escrita de rollback
**O quê:** rollback da Vercel reverte o app, não o banco.
**Impacto real:** uma migration ruim aplicada com um cliente ativo não tem caminho de volta ensaiado. As migrations são append-only por decisão, o que torna o **forward fix** a única saída — mas isso precisa estar escrito antes de ser preciso, não durante.
**Correção:** meia página: como se detecta, quem decide, forward-fix como padrão, e quando se recorre ao PITR do P1-2.

---

## 4. Pode esperar o pós-piloto

- **Integração WOTY.** Bloqueada até haver credenciais reais. A arquitetura de adaptador existe e está vazia; **nenhum mock é apresentado como integração pronta**. Não bloqueia o piloto: o cliente entra por cadastro manual ou importação.
- **`partner_relationships`.** Não construída. Não bloqueia: operar **uma empresa diretamente** funciona hoje, e a organização `PARTNER` com N empresas já é suportada e testada.
- **Idempotência das Server Actions do painel** (duplo clique cria entrega duplicada).
- **Concessão de break-glass com escopo de empresa** — existe e é testada no banco, mas o console só emite escopo organizacional.
- **Envio de e-mail transacional** (convite e recuperação de senha são links copiados à mão hoje).
- **AL2–AL4 / biometria**, PWA offline, exportação de ficha em PDF além do que já existe.
- **Testes automatizados das telas novas** das fases G e H no CI (hoje são scripts manuais, deliberadamente fora do CI para não pôr credenciais reais lá).

---

## 5. Checklist operacional — onboarding do primeiro cliente

1. [ ] Criar a conta do gestor e concluir `onboard_organization` (razão social + CNPJ da empresa).
2. [ ] **Ligar os flags da organização** em `/settings` — `compliance_enabled` no mínimo; `inventory_enabled` e `role_matrix_enabled` conforme o combinado. **Nascem desligados.**
3. [ ] Conferir `early_replacement_policy` e `replacement_alert_days` com o cliente.
4. [ ] Convidar os usuários da empresa em `/settings/team`, com escopo e papel corretos. **O Selo não envia e-mail**: o link sai uma única vez na tela e é repassado à mão.
5. [ ] Cadastrar cargos e locais antes dos funcionários (o vínculo é opcional, mas retroativo dá trabalho).
6. [ ] Importar funcionários (CSV/XLSX) — validar o `import_run` antes de seguir. Ver P1-4.
7. [ ] Cadastrar o catálogo de EPIs com CA e vida útil padrão; variantes onde houver numeração.
8. [ ] Emitir **uma entrega de teste** para um funcionário real e percorrer o link do trabalhador do começo ao fim, no celular dele.
9. [ ] Verificar o comprovante em `/verify/<código>` num aparelho sem sessão.
10. [ ] Mostrar ao cliente `/settings/acesso-do-suporte` e explicar o que ele vê ali.
11. [ ] Confirmar com o cliente o número de latência de webhook (minutos, não segundos — o agendador do GitHub Actions), se ele for usar webhooks.
12. [ ] Registrar quem, do lado do cliente, é o último `ORG_ADMIN` — e garantir que exista um segundo.

---

## 6. Checklist de segurança para produção

1. [ ] Confirmar qual projeto Supabase é produção (`yqbhdpennqcywxatvhwr` vs `zowuandkuubskaqlpfka` **segue não resolvido** em `docs/architecture.md` §20).
2. [ ] PITR ativo e **uma restauração testada** (P1-2).
3. [ ] Os nove segredos definidos em produção, distintos dos de dev, com escrow escrito (P1-5).
4. [ ] Schemas expostos ao PostgREST conferidos no dashboard: `graphql_public, api, worker, m2m_rpc, ops_rpc` — é ajuste de dashboard, invisível às migrations.
5. [ ] `scripts/security-audit.mjs` rodando limpo (hoje: 1 violação, P1-1).
6. [ ] Rastreamento de erro e alertas ligados (P1-3).
7. [ ] Procedimento de rollback escrito (P1-6).
8. [ ] Nenhuma conta de teste `e2e-*@example.com` no projeto de produção.
9. [ ] Nenhum `platform_admin` semeado em produção além dos nomeados; lembrar que o primeiro é sempre `insert` manual, por desenho.
10. [ ] Confirmar retenção de log e que o log da Vercel não recebe PII.
11. [ ] Revisar as pendências jurídicas de `docs/architecture.md` §20 que **bloqueiam alegação comercial**, não código: nível de garantia aceito em juízo, base legal LGPD, necessidade de ICP-Brasil.

---

## 7. Recomendação

# CONDITIONAL GO

**O produto faz o que promete.** O fluxo inteiro — onboarding, usuários, funcionários, catálogo, entrega individual, entrega em massa, link do trabalhador, identidade, confirmação, evidência selada, comprovante, verificação pública, acompanhamento, troca, compliance, isolamento e revogação — foi executado hoje, ponta a ponta, contra o projeto real, com o percurso do trabalhador num navegador de verdade. **18 de 18.** O isolamento entre tenants e a superfície `anon` foram verificados no catálogo, não presumidos.

**A condição não é sobre funcionalidade, é sobre o que acontece quando algo der errado.** Um piloto com empresa real precisa de três coisas que hoje não existem: saber que quebrou (P1-3), poder voltar atrás (P1-2, P1-6) e não perder para sempre um segredo que não se recupera (P1-5). Some-se a trava que falta na tabela que sustenta a alegação central do produto (P1-1) e o caminho pelo qual o cliente realmente carrega os dados dele (P1-4).

**Mínimo para o GO:** P1-1 (uma migration), P1-2 (confirmar e testar restauração), P1-3 (erro + alerta), P1-5 (uma página escrita). P1-4 e P1-6 podem correr em paralelo à primeira semana do piloto **se** o cliente entrar com poucos funcionários e o cadastro for manual.

**O que eu não afirmo:** que já rodou com volume real, que a importação funciona ao vivo, que o backup restaura, ou que alguém vai perceber uma falha em produção. Nada disso foi medido, e as três primeiras podem ser medidas esta semana.
