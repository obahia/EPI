# PILOT READINESS — Selo

**Data da auditoria:** 2026-09-09
**Última revisão:** 2026-09-09, após a rodada Pilot Production Readiness (P1-1, P1-3, P1-4, P1-5, P1-6)
**Escopo:** determinar se conseguimos colocar **uma empresa real** no sistema e executar o fluxo completo de entrega de EPI, com segurança.
**Não é escopo:** adicionar capacidades. Nenhum módulo novo foi construído para esta auditoria.

---

## 0. Como ler este documento

Cada afirmação aqui é **medida** ou **declarada como não medida**. Onde houve execução, o artefato que a produziu está nomeado e pode ser rodado de novo:

| Artefato | O que produz |
|---|---|
| `scripts/pilot-readiness-probe.mjs` | Os 18 passos do cenário, executados contra o projeto `epi-dev` real, com o percurso do trabalhador conduzido no **navegador de verdade** |
| `scripts/security-audit.mjs` | Auditoria de catálogo (RLS, `SECURITY DEFINER`, `search_path`, superfície `anon`, imutabilidade, PII) sobre o schema construído a partir das 69 migrations |
| `.github/workflows/ci.yml` | 26 arquivos pgTAP + corridas reais de concorrência, em Postgres real |
| `scripts/e2e-import.mjs` | A importação de funcionários com um arquivo sintético de 201 linhas, pelo assistente real |
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
- **#3 agora cobre os dois caminhos.** O cadastro manual foi medido na sonda; a importação foi medida separadamente com um arquivo de 201 linhas (`scripts/e2e-import.mjs`, 12/12) — ver §8.4.

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
| **imutabilidade** | **PASS** (corrigido nesta rodada) | As três tabelas agora têm trigger contra UPDATE/DELETE que recusa **até para o dono**. Ver §8 |
| **PII / CPF** | **PASS** | Varredura de catálogo: só `cpf_hash` (bytea), `cpf_enc` (bytea) e `cpf_masked`. Nenhuma coluna em claro. A página pública `/verify` foi medida e não expõe nome nem CPF |
| **biometria** | **N/A, por decisão** | AL2–AL4 não implementados e lançam explicitamente. O padrão é AL1 não biométrico, por leitura da NT 4/2026 da ANPD. Não há template biométrico em lugar nenhum do schema |
| **backups / recovery** | **DESCONHECIDO → P1-2** | Não consigo ler o plano nem a configuração de PITR do projeto Supabase a partir daqui |
| **observabilidade** | **PARTIAL** (era FAIL) | Captura estruturada com id de correlação e redação testada, ligada aos quatro caminhos críticos. **Falta o sino**: nada avisa um humano. Ver §8 e `docs/runbook-rollback.md` §7 |
| **tratamento de erro** | **PASS** | `describeRpcError` traduz código do Postgres para pt-BR sem vazar nome de constraint ou schema; a API devolve 503 para erro de configuração e 500 opaco para o resto |
| **secrets** | **PARTIAL** (era FAIL de documentação) | `docs/runbook-secrets.md` documenta categorias, donos, rotação, revogação e resposta a comprometimento. **O escrow em si continua por fazer** — é um ato organizacional, não um documento |
| **migrations** | **PASS** | 69 migrations aplicam do zero (medido hoje); disciplina append-only; o CI prova a aplicação a partir do nada a cada PR |
| **rollback / recovery** | **PARTIAL** (era sem procedimento) | `docs/runbook-rollback.md` escrito: aplicação, schema, dados, evidência, incidentes. **Nenhum dos três ensaios foi executado** (§8 do runbook) |

---

## 3. Blockers restantes

**P0: nenhum.**

**P1: dois, e ambos são atos organizacionais, não código.**

### P1-2 — Backup e recuperação: não confirmados, e **não confirmáveis a partir daqui**

Tentei ler a configuração real. O servidor MCP do Supabase disponível nesta sessão está autenticado noutra organização (`nftljccaybipqmtbtati`, projeto "WeGest") e **não enxerga os projetos EPI** — `list_projects` devolve um único projeto que não é o `epi-dev`. Portanto:

- **Não sei** se há PITR ativo. **Não presumo.**
- **Não sei** a retenção de backup do plano em uso.
- **Nunca foi feita** uma restauração de teste.

Não executei restore algum: exigiria criar um projeto descartável numa organização a que não tenho acesso, e a instrução — correta — foi nunca arriscar `epi-dev` nem produção para provar restore.

**Impacto para o piloto:** a evidência pericial de um cliente real passa a viver ali. Sem PITR confirmado, um `DELETE` errado ou um incidente do fornecedor é perda definitiva de prova. Um backup nunca restaurado é uma hipótese, não um backup.

**Para fechar:** Dashboard Supabase → projeto → Database → Backups. Registrar plano, PITR (ativo/inativo, janela) e retenção. Depois restaurar uma vez para um projeto **novo e descartável**, cronometrando. Procedimento em `docs/runbook-rollback.md` §4.

### P1-5b — Escrow dos segredos irrecuperáveis

`docs/runbook-secrets.md` está escrito: categorias, donos, consumidores, rotação, revogação e resposta a comprometimento. O que **não** está feito é o próprio escrow.

Cinco segredos são irrecuperáveis por natureza e hoje existem em dois lugares — a Vercel e o `.env` de quem os gerou. Perder `CPF_HASH_PEPPER` não apaga a evidência, mas **destrói para sempre** a capacidade de reconferir qual CPF está por trás de um hash histórico; nenhum backup do banco recupera isso, porque o valor nunca esteve lá.

**Para fechar:** `docs/runbook-secrets.md` §7 — escolher o cofre, depositar os cinco, nomear duas pessoas, datar, e testar a leitura por quem não depositou.

---

## 4. Pode esperar o pós-piloto

- **Alerta ativo.** A captura existe; o sino não. Todas as opções exigem plano pago ou conta externa, então a decisão ficou aberta com os custos na mesa — `docs/runbook-rollback.md` §7. **Nada foi integrado.**
- **Histórico de importações.** `app.import_runs` registra cada execução, mas nada expõe uma lista: `api.import_run_status` recebe o id da execução, e esse id só existe dentro da sessão do assistente. O que o cliente consegue consultar depois é a trilha de auditoria (`EMPLOYEES_IMPORTED`), que foi medida. Uma tela de histórico é conveniência, não bloqueio.
- **Integração WOTY.** Bloqueada até haver credenciais reais. O adaptador existe e está vazio; **nenhum mock é apresentado como integração pronta**. Não bloqueia: o cliente entra por cadastro manual ou pela importação, agora medida.
- `partner_relationships`. Não construída. Operar **uma empresa diretamente** funciona hoje.
- **Idempotência das Server Actions do painel** (duplo clique pode criar entrega duplicada).
- **Concessão de break-glass com escopo de empresa** — existe e é testada no banco; o console só emite escopo organizacional.
- **Envio de e-mail transacional** (convite e recuperação de senha são links copiados à mão).
- **PWA offline**, exportação de ficha em PDF além do que já existe.
- **Testes das telas das fases G e H no CI** — hoje são scripts manuais, deliberadamente fora do CI para não pôr credenciais reais lá.

---

## 5. Checklist operacional — onboarding do primeiro cliente

1. [ ] Criar a conta do gestor e concluir `onboard_organization` (razão social + CNPJ).
2. [ ] **Ligar os flags da organização** em `/settings` — `compliance_enabled` no mínimo. **Nascem desligados.**
3. [ ] Conferir `early_replacement_policy` e `replacement_alert_days` com o cliente.
4. [ ] Convidar os usuários em `/settings/team`. **O Selo não envia e-mail**: o link sai uma vez na tela e é repassado à mão.
5. [ ] **Cadastrar Cargos e Locais ANTES de importar.** A importação recusa uma linha cujo Cargo não exista no catálogo — de propósito, nada é criado por conta do cliente. Medido: com os Cargos ausentes, 0 de 201 linhas entram; com eles cadastrados, 170 entram.
6. [ ] Importar funcionários. Conferir na tela: linhas lidas, linhas recusadas com motivo por linha, e quantas serão criadas. Baixar o relatório de erros se houver.
7. [ ] Cadastrar o catálogo de EPIs com CA e vida útil padrão.
8. [ ] Emitir **uma entrega de teste** para um funcionário real e percorrer o link no celular dele.
9. [ ] Verificar o comprovante em `/verify/<código>` num aparelho sem sessão.
10. [ ] Mostrar ao cliente `/settings/acesso-do-suporte` e explicar o que ele vê ali.
11. [ ] Se for usar webhooks, confirmar a latência (minutos, não segundos — agendador do GitHub Actions).
12. [ ] Garantir que exista um **segundo** `ORG_ADMIN`.

---

## 6. Checklist de segurança para produção

1. [ ] Confirmar qual projeto Supabase é produção (`yqbhdpennqcywxatvhwr` vs `zowuandkuubskaqlpfka` **segue não resolvido** em `docs/architecture.md` §20).
2. [ ] PITR ativo e **uma restauração testada** (P1-2).
3. [ ] Os nove segredos definidos em produção, distintos dos de dev, com escrow feito (P1-5b).
4. [ ] `DEV_PROBE_KEY` e `RESEND_API_KEY` **não** definidos — estão em `.env.example` e não têm consumidor no código.
5. [ ] Schemas expostos ao PostgREST conferidos no dashboard: `graphql_public, api, worker, m2m_rpc, ops_rpc`.
6. [ ] `node scripts/security-audit.mjs` sem violações.
7. [ ] Decidir o destino de alerta (`docs/runbook-rollback.md` §7).
8. [ ] Nenhuma conta `e2e-*@example.com` no projeto de produção.
9. [ ] Nenhum `platform_admin` semeado além dos nomeados. O primeiro é sempre `insert` manual, por desenho.
10. [ ] Confirmar que o log da Vercel não recebe PII — a redação é testada em `src/lib/observability/report.test.ts`.
11. [ ] Revisar as pendências jurídicas de `docs/architecture.md` §20, que bloqueiam **alegação comercial**, não código.

---

## 7. Identidade: AL1 versus reconhecimento facial

O usuário pediu que isto ficasse separado, e é a separação mais importante do documento.

### A) Prontidão para piloto usando AL1 — **PRONTO**

O que foi medido ponta a ponta: link individual e opaco (256 bits de CSPRNG, HMAC com pepper, o token cru nunca chega ao Postgres), desafio de conhecimento pelos 3 últimos dígitos do CPF, assinatura desenhada pelo trabalhador, e o conjunto selado como evidência canônica com hash. Rate limiting nas três RPCs do trabalhador (20/5min por token, 60/5min por IP) e teto de tentativas de identidade (`identity_max_attempts` = 5).

Isto é o `AL1_LINK_KNOWLEDGE` da arquitetura, e a escolha de fazer dele o padrão **não** foi conveniência: `docs/architecture.md` §9 registra a leitura da NT 4/2026 da ANPD, que suspendeu um sistema de reconhecimento facial pelo raciocínio de que biometria não é "indispensável" quando a própria norma oferece alternativa não biométrica — e a NR-6 6.5.1(d) oferece.

### B) Prontidão para comercializar reconhecimento facial / liveness — **NÃO PRONTO. NADA FOI IMPLEMENTADO.**

Isto não é "parcialmente pronto", "preparado" ou "arquitetado". É **inexistente**:

- `AL2` a `AL4` **não têm adaptador**. O registry lança explicitamente para esses níveis.
- `app.identity_profiles` existe como tabela vazia — ponteiro para provedor, **nunca** um template biométrico.
- **Nenhum fornecedor foi contratado, integrado ou testado.** A pesquisa da FASE 4 avaliou AWS Rekognition Face Liveness, Azure e Serpro via revenda; **nenhuma decisão foi tomada** e nenhuma credencial existe.
- A varredura de catálogo confirma: nenhuma coluna, tabela ou payload biométrico em lugar nenhum do schema.

**O que existe é a abstração** (`IdentityVerificationProvider`, nível de garantia como dado por organização em vez de fixo no código). Isso significa que adicionar um fornecedor não exige migration de dados — não significa que exista qualquer capacidade facial.

**Consequência comercial, dita sem rodeio:** vender "reconhecimento facial" ou "prova de vida" hoje seria vender algo que não existe. Antes de qualquer alegação nesse sentido são necessários: escolha e contrato de fornecedor, implementação do adaptador, validação real com pessoas reais, DPIA/RIPD (a ANPD tratou a ausência disso como parte da violação no caso citado), e base legal LGPD para o ramo biométrico definida — art. 11, II, "g" versus consentimento, questão em aberto em `docs/architecture.md` §20.

**Para o piloto isso não é bloqueio**, desde que o piloto seja vendido como o que é: confirmação por link com desafio de conhecimento e assinatura, com evidência selada e verificável.

---

## 8. O que mudou nesta rodada

### 8.1 P1-1 — imutabilidade de `evidence.documents` — **FECHADO**

Migration `20260909100000_evidence_documents_immutability.sql`: trigger `BEFORE UPDATE OR DELETE` usando a mesma `audit.forbid_mutation()` que as tabelas irmãs já usavam, mais `revoke` explícito incluindo `service_role` e `public`.

**Nenhum fluxo legítimo foi afetado**, e isso foi verificado antes de escrever: há exatamente um escritor da tabela em todo o código — `app.seal_evidence`, chamada só de dentro da transação de `worker.finish_confirmation` — e ela só faz `INSERT`. Não existe `UPDATE` nem `DELETE` dessa tabela em migration nenhuma nem em caminho nenhum da aplicação.

Suíte `250_evidence_document_immutability.sql`, 14 asserções, tentando exatamente o ataque:
- repontar `evidence_version_id` de um código já emitido → recusado (`42501`);
- reescrever o `verification_code` → recusado;
- apagar o documento → recusado;
- o mesmo pela chave primária em vez do código → recusado;
- **e depois de todas as tentativas, o comprovante ainda resolve para a evidência original** — `/verify/<code>` devolve o payload real, não o forjado;
- as três tentativas como `authenticated` → recusadas, inclusive emitir um documento novo;
- a evidência selada em si continua imutável;
- o trigger está no catálogo, então uma migration futura que o remova quebra a suíte.

`scripts/security-audit.mjs`: **sem violações** (era 1).

### 8.2 P1-2 — backup/PITR — **NÃO FECHADO**, ver §3

### 8.3 P1-3 — observabilidade — **PARCIALMENTE FECHADO**

`src/lib/observability/report.ts`: captura centralizada, um evento JSON por falha, id de correlação (prefere o id de requisição da plataforma para que as duas linhas possam ser cruzadas), operação de uma lista fechada, e **redação obrigatória**.

A redação é a parte que interessa e é testada em 14 asserções. **Ela pegou um vazamento meu:** a primeira versão aceitava `"961.810.907-87"` como "sinal" — um CPF, direto para a linha de log. A regra passou a exigir letra inicial, proibir ponto e limitar o tamanho.

Ligado a: falha ao selar evidência (`src/app/e/s/[id]/actions.ts`), commit de importação, runner de webhooks, manutenção.

**O que falta:** o sino. Ver §4 e `docs/runbook-rollback.md` §7.

### 8.4 Importação — **MEDIDA, e encontrou um defeito real**

`scripts/e2e-import.mjs`, **12/12**, com 201 linhas sintéticas geradas na hora (CPFs com dígitos verificadores reais, CSPRNG; nenhum dado de pessoa real): 170 limpas, 15 duplicadas dentro do arquivo, 15 malformadas em três formas distintas (dígito verificador errado, nome vazio, e-mail inválido), e 1 colidindo com alguém já existente no tenant.

Medido: o arquivo é lido no navegador e a tela **diz que nada foi enviado**; 31 linhas são recusadas antes de qualquer envio, **cada uma nomeando a linha e o motivo** ("Linha 172 — CPF duplicado (já aparece na linha 2)"); a tela informa 170 a criar; o commit cria exatamente 170; nenhuma linha malformada ou duplicada vira funcionário; o CPF importado sai mascarado; nada é visível de outro tenant; e a importação fica na trilha de auditoria do próprio tenant.

**O defeito:** um Cargo que não existe no catálogo faz a importação recusar — correto, nada é criado por conta do cliente. Mas `commitError` e `resolutionErrors` só eram **renderizados no passo 3**, e o retorno antecipado os definia e voltava **sem mudar de passo**. O operador clicava em "Confirmar importação" e **nada acontecia na tela**: sem erro, sem progresso, sem explicação. Num piloto, o cliente conclui que o produto está quebrado.

Corrigido levando os dois retornos ao passo que já sabia se explicar, marcado como parcial para que a tela nunca possa ser lida como sucesso. Não é funcionalidade nova — é tornar alcançável uma mensagem que já existia.

### 8.5 P1-5 e P1-6 — runbooks — **ESCRITOS**

`docs/runbook-secrets.md` e `docs/runbook-rollback.md`. Nenhum valor real de segredo em nenhum dos dois. Ambos terminam com o que **não** foi ensaiado, porque um procedimento nunca executado é uma hipótese.

---

## 9. Recomendação final

# CONDITIONAL GO

**Mudou o suficiente para justificar a mudança de tom, e não o suficiente para um GO limpo.**

Fechado desde a auditoria anterior: a trava de imutabilidade que faltava na tabela que sustenta a alegação central do produto, com prova de que um comprovante emitido não pode ser silenciosamente reapontado; a importação, agora medida com 201 linhas e um defeito real corrigido no caminho; a captura de exceções com redação que já provou pegar um vazamento; e os dois runbooks.

**Restam dois, e nenhum é código:**

1. **Backup/PITR não confirmado e nunca restaurado (P1-2).** Não consigo verificar daqui — o acesso disponível nesta sessão é de outra organização. É uma consulta de dashboard mais um teste de restauração num projeto descartável.
2. **Escrow dos cinco segredos irrecuperáveis (P1-5b).** Está tudo documentado; falta depositar.

**Vira GO quando esses dois estiverem feitos.** Ambos são horas, não semanas, e nenhum depende de engenharia.

**Sobre alerta:** a captura existe, o sino não, e todas as opções custam dinheiro ou expõem dado a terceiro — a decisão ficou aberta com os custos na mesa, como pedido. Um piloto acompanhado de perto por uma pessoa que consulta os logs sobrevive sem isso; um piloto desacompanhado, não.

**O que eu continuo não afirmando:** que já rodou com volume de produção sustentado, que o backup restaura, que alguém será avisado quando algo falhar, ou que existe qualquer capacidade de reconhecimento facial. Os três primeiros são mensuráveis esta semana. O quarto não existe e não deve ser vendido.
