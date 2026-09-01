# MVP Roadmap — Plataforma de Entrega Digital de EPI

Companion de `docs/architecture.md`. Cada fase termina com lint + typecheck + testes + revisão de migrations/RLS + relato exato do que foi criado e do que ficou pendente — nunca declarar algo funcionando sem verificar.

Convenção: ✅ = critério de aceite verificável por comando ou teste automatizado, não por inspeção visual.

---

## FASE 0 — Foundation

**Objetivo**: repositório instalável, banco vazio com tenancy/RLS/RBAC provados por teste, CI verde, nenhuma feature de produto ainda.

- Projeto Next.js 16.3.x (App Router, TypeScript strict, React 19.2.x) — pinado em ≥16.3.3 (release de segurança de agosto/2026, corrige duas RCEs críticas).
- Tailwind CSS 4.x + shadcn/ui (`npx shadcn init -b radix` — Radix explícito, já que desde jul/2026 o default do CLI é Base UI).
- Supabase: projeto `sa-east-1` confirmado (produção) + estratégia de dev definida — ver "Bloqueio aberto" abaixo.
- `supabase/migrations/` com o schema de `app`/`authz`/`evidence`/`audit`/`integ`/`api` do §6–§7 da arquitetura: `organizations`, `companies`, `users`, `memberships`, `role_permissions`, `platform_admins`, `platform_access_grants`, `state_transitions` — só a espinha de tenancy/RBAC, sem entidades de negócio ainda.
- RLS: helpers `auth_ctx.*`, policies no padrão `(SELECT auth_ctx.…())`, `FORCE ROW LEVEL SECURITY` em tudo, `authz.memberships` sem grant nenhum a `authenticated`/`anon`.
- Suite pgTAP inicial: dois tenants sintéticos, prova que RLS isola em toda tabela criada nesta fase; teste que falha o build se alguma tabela nova não tiver RLS habilitado.
- CI (GitHub Actions): lint, typecheck, `supabase db reset` + pgTAP em todo PR.
- `.env.example` com nomes exatos de variável e comentário de onde obter cada uma; segredos nunca no repositório.
- Layout base do painel (shell autenticado, sem telas de produto ainda) + página pública mínima.

✅ `npm run lint && npm run typecheck && npm test` verde. `supabase db reset` aplica do zero sem erro. pgTAP prova isolamento das tabelas de tenancy. Login funcional com `getClaims()`.

**Bloqueio aberto antes de eu poder configurar `.env`/CI de produção**: qual dos dois projetos Supabase criados nesta conversa (`yqbhdpennqcywxatvhwr`, `zowuandkuubskaqlpfka`) é produção — a região de ambos precisa ser reconfirmada como `sa-east-1` antes de qualquer dado real entrar.

---

## FASE 1 — Companies + Employees

**Objetivo**: gestor cria empresa e funcionários; isolamento provado; importação básica funcionando sem tabela de staging.

**Decisões tomadas durante a implementação** (registradas aqui para não ficarem só no código):
- **Onboarding**: sem sistema de convite ainda, então um usuário recém-cadastrado com zero `memberships` cria a própria organização `DIRECT` + sua única empresa + vira `ORG_ADMIN` num único RPC (`api.onboard_organization`), transação única. É estritamente *one-shot* — uma segunda chamada é rejeitada (`already_onboarded`). Isso é o que torna "Admin cria empresa" (DoD passo 1) testável sem esperar pela Fase de convites.
- **CPF nunca chega em texto puro ao Postgres**: hash (HMAC) e cifra (AES-256-GCM) são computados em `src/lib/crypto/cpf-secrets.ts`, no servidor Next.js, com segredos (`CPF_HASH_PEPPER`, `CPF_ENCRYPTION_KEY`) fora do Supabase Vault — mesmo raciocínio do pepper de token (§8). As RPCs (`api.create_employee`, `api.import_employees_commit`) só recebem o hash/cifra já prontos, em base64.
- **"Revelar CPF completo" foi deliberadamente adiado**, não construído na Fase 1 — `cpf_enc` já é armazenado (para não exigir reimportação depois), mas não existe RPC nem UI de revelação ainda. Ver §20 do architecture.md.
- **Importação é CSV apenas na Fase 1** — XLSX fica para depois. Motivo: a pesquisa de bibliotecas encontrou que o pacote `xlsx` do npm está congelado numa versão vulnerável (CVEs sem correção via registry); suportar CSV apenas remove essa dependência inteira do MVP sem perder o essencial do fluxo de importação.
- **Import é upsert, não insert cego**: uma linha cujo CPF já existe na empresa atualiza o cadastro em vez de duplicar ou rejeitar — permite reenviar a mesma planilha corrigida sem se preocupar em "já importei isso?".

- CRUD de `companies` (dentro de uma `organization`, via RPCs `api.create_company`/`api.update_company`), CRUD de `employees` (§6.1: CPF cifrado + hash + máscara via `api.create_employee`/`api.update_employee`, `data_origin`, colunas de `external_ref` já presentes mesmo sem sync WOTY ativo).
- Cadastro manual de funcionário (CPF/telefone validados inline com `src/lib/br/{cpf,cnpj,phone}.ts`, hash/cifra computados em `src/lib/crypto/cpf-secrets.ts` antes de qualquer chamada ao banco).
- Importação **CSV** (XLSX adiado — ver decisão acima): parsing **no navegador** com papaparse (nenhum arquivo bruto chega ao servidor — §17/§15), preview, mapeamento de colunas, validação (CPF inválido, duplicata dentro do arquivo, campo obrigatório ausente, telefone inválido), relatório de erro, confirmação, commit via `api.import_employees_commit` (upsert set-based, uma transação).
- Testes: isolamento de `employees`/`companies` entre tenants (pgTAP, `supabase/tests/database/020_employee_isolation.sql`); validação de CPF/CNPJ com vetores oficiais incluindo o caso alfanumérico de CNPJ (`src/lib/br/{cpf,cnpj}.test.ts`); importação com arquivo contendo linhas inválidas propositalmente.

✅ Dois tenants sintéticos, funcionário criado em um não aparece em nenhuma query do outro (RLS **e** teste de API). Importação de planilha com 3 erros propositais gera relatório com exatamente 3 erros e 0 linhas inválidas commitadas.

---

## FASE 2 — EPI

**Objetivo**: catálogo de EPI e entrega individual com snapshot imutável e máquina de estados, sem ainda envolver token/link do trabalhador (isso é a Fase 3).

- CRUD de `epis`/`epi_versions` (nome, CA, fabricante/modelo/descrição opcionais, ativo/inativo — sem estoque, sem compras).
- `epi_deliveries`/`epi_delivery_items` com snapshot por valor no momento da criação (§12).
- Máquina de estados da entrega (`DRAFT → ISSUED → …`) como dado (`state_transitions`), aplicada por gatilho + `REVOKE UPDATE` de coluna (§8) — sem isso ainda ter um link de confirmação real por trás.
- Testes: alterar um `epi` depois de uma entrega `ISSUED` não muda o snapshot da entrega (prova direta, não apenas confiança na constraint); transição de estado ilegal levanta exceção; tentativa de `UPDATE` direto via PostgREST em coluna de estado falha por falta de grant.

✅ Suite de transições cobre toda aresta declarada em `state_transitions` e prova que a aresta inversa/inexistente é rejeitada.

**Verificado ao vivo (2026-08-31)**: além da suite pgTAP e do teste funcional PGlite (`fase2-rpcs.mjs`, 15/15), rodado E2E via Playwright contra a build de dev real (`npm run dev`) e o banco remoto `epi-dev`: criada entrega DRAFT para "João da Silva" com item "Luva de Proteção" (CA 54321, qty 2) → `Emitir` (DRAFT→ISSUED confirmado na UI) → EPI editado no catálogo para "Luva de Proteção V2"/CA 99999 via `update_epi` → reaberta a página de detalhe da entrega e o item continua mostrando exatamente "Luva de Proteção"/CA 54321 (o snapshot antigo, não o novo). Prova a imutabilidade do snapshot ponta a ponta pela UI real, não só pela constraint isolada.

---

## FASE 3 — Confirmation

**Objetivo**: o loop completo do trabalhador funciona ponta a ponta — sem verificação de identidade biométrica ainda (nível `AL0`/`AL1` só, conforme o default recomendado em §16).

- Geração de token (§8: hash calculado fora do SQL, pepper em variável de ambiente, nunca no Vault).
- Rota `/e/[token]`: sondagem de capacidade, troca de token por cookie, redirecionamento para caminho sem token.
- Tela mobile-first de revisão (empresa, nome, itens, CA, quantidade) + confirmar/contestar.
- Papel Postgres dedicado (`epi_worker_gw`, zero grant de tabela) + funções `SECURITY DEFINER` parametrizadas por token.
- Contestação (motivos do enunciado + comentário livre), preservando histórico, nunca contando como confirmação.
- Auditoria: eventos de todo passo do fluxo (`LINK_VIEWED`, `DELIVERY_CONFIRMED`, `DELIVERY_CONTESTED`, etc.).
- Rate limiting em camadas (WAF + tabela Postgres atômica).
- Testes: replay do link após confirmação retorna visão somente-leitura, nunca reabre o formulário; token de outro tenant/entrega nunca retorna dado de terceiro; dupla confirmação concorrente — um dos dois requests falha por violação de índice único, nunca as duas commitam.

✅ Os passos 4–10 e 14 (parcial: sem lote ainda) da Definition of Done do enunciado passam em E2E Playwright contra build de produção.

**Decisões tomadas durante a implementação:**
- **`epi_worker_gw` (papel Postgres dedicado) não foi criado nesta fase.** `anon` já tem zero grant de tabela em todo o schema (invariante já provado desde a FASE 0); o real mecanismo de segurança — "sem id nenhum para um IDOR substituir, só o hash do token" — está inteiramente nas funções `SECURITY DEFINER` do schema `worker`, não no papel de conexão. Um papel dedicado exigiria gerenciar uma conexão Postgres direta fora do PostgREST/cliente Supabase só por essa camada extra de defesa-em-profundidade — complexidade real por um ganho marginal sobre uma postura já forte. Fica como candidato a hardening futuro, não como lacuna: `src/lib/supabase/worker-client.ts` é o equivalente no limite do módulo (nunca carrega cookie nenhum, nunca importável fora da árvore `/e/*`).
- **Nível de garantia AL1 (`AL1_LINK_KNOWLEDGE`) implementado como desafio dos 3 últimos dígitos do CPF**, não OTP — não há canal de envio de OTP construído ainda (só `MANUAL_COPY`, o gestor copia o link), e os 3 últimos dígitos já são algo que o trabalhador sabe de cor e que a empresa já possui, sem exigir nova coleta de dado. A comparação acontece inteiramente no Node (`src/app/e/s/[id]/actions.ts`): `worker.begin_confirmation` devolve o `cpf_enc` cifrado, o Node decifra com `CPF_ENCRYPTION_KEY` (nunca disponível ao Postgres), compara, descarta — só o resultado booleano cruza de volta para `worker.finish_confirmation`. Documentado aqui por ser uma escolha de produto (qual desafio de conhecimento usar), não uma decisão de segurança/legal pendente.
- **Bug real encontrado só ao executar contra PGlite (não por inspeção)**: a primeira versão de `worker.finish_confirmation` fazia `UPDATE ... SET status = 'IDENTITY_FAILED' ...` e em seguida `RAISE EXCEPTION 'identity_mismatch'` para sinalizar a tentativa errada ao chamador — mas uma `RAISE EXCEPTION` não capturada aborta a transação INTEIRA no Postgres, desfazendo o próprio UPDATE que acabara de rodar. Um "erro" esperado (dígitos errados, ainda com tentativas sobrando) precisa ser um retorno normal da função, não uma exceção — corrigido para `RETURN QUERY SELECT 'IDENTITY_MISMATCH', ...` nesses dois ramos (tentativa errada / limite esgotado), preservando `RAISE EXCEPTION` só para casos genuinamente excepcionais (link inexistente, replay, rate limit).
- **Revisitar o link depois de CONFIRMED/CONTESTED mostra um recibo somente-leitura, nunca um erro** — `worker.open_link` distingue esse caso (token já provado, então não há mais razão de anti-enumeração para esconder o motivo) do caso "morto de verdade" (expirado/revogado/inexistente, que continua com a mesma resposta genérica `link_not_available`).
- Parâmetros `bytea` (hash de token) em toda função `api.*`/`worker.*` chamada via RPC do Supabase são recebidos como `text` base64 + `decode(...,'base64')` internamente — mesma convenção já estabelecida na FASE 1 para CPF (`cpf_hash_b64`), evitando depender do formato de wire hex-texto (`\x...`) do Postgres numa chamada JSON-RPC.
- Verificado localmente via um script funcional PGlite dedicado (28 checks: link creation, view idempotente, tentativa de identidade errada persistindo corretamente, replay de nonce rejeitado, dupla confirmação concorrente rejeitada, contestação nunca cria `identity_verifications`, isolamento entre tenants, rate limiting, trilha de auditoria, imutabilidade de `audit.audit_events`) e via `supabase/tests/database/040_confirmation_flow.sql` (pgTAP, 16 assertions, sintaticamente verificado por um checker PGlite ad-hoc já que pgTAP em si não roda fora do stack real do Supabase).
- **Bug real encontrado só em E2E ao vivo, invisível ao PGlite**: `worker.begin_confirmation` devolvia `cpf_enc` como `bytea` puro — o PostgREST serializa uma coluna de saída `bytea` no formato hex-texto do próprio Postgres (`\x...`), não em base64, mas o Server Action já esperava base64 (mesma convenção usada em todo o resto do projeto). O resultado era `AES-256-GCM` decifrando bytes errados e falhando com "Unsupported state or unable to authenticate data" a cada tentativa real. PGlite não pega esse tipo de bug porque devolve `bytea` como bytes crus, sem passar pela serialização JSON do PostgREST — só apareceu batendo contra o cliente Supabase de verdade. Corrigido: a função agora devolve `cpf_enc_b64 text` (`encode(..., 'base64')` explícito), mesma convenção já usada para os parâmetros de entrada. **Lição para fases futuras**: nenhuma coluna `bytea` deve cruzar uma função `api.*`/`worker.*` sem `encode(...,'base64')` explícito, em nenhuma direção (parâmetro OU retorno) — e esse tipo de bug só aparece testando contra o Supabase real, reforçando por que a verificação em PGlite nunca substitui o E2E ao vivo antes de fechar uma fase.

**Verificado ao vivo (2026-09-01)**: fluxo completo via Playwright contra `epi-dev` real — funcionário/EPI novos criados, entrega emitida, link de confirmação gerado pelo gestor, aberto pelo trabalhador (token → cookie → `/e/s/<id>`), tentativa de CPF errada (mostra "4 tentativa(s) restante(s)", sem quebrar), tentativa correta (confirma, mostra recibo), revisita ao mesmo link (mostra o MESMO recibo somente-leitura, nunca reabre o formulário nem dá erro), painel do gestor mostrando status/nível de garantia/histórico de auditoria completo (`CONFIRMATION_CREATED` → `LINK_VIEWED` → `IDENTITY_FAILED` → `LINK_VIEWED` → `IDENTITY_VERIFIED` → `DELIVERY_CONFIRMED`). Segunda entrega testando o caminho de contestação: trabalhador contesta com motivo + comentário, recibo "Entrega contestada", gestor vê a contestação e registra uma resposta. Link inexistente mostra "Link não disponível" (não uma tela quebrada). Todos os passos passaram após a correção do bug de bytea acima.

---

## FASE 4 — Identity

**Objetivo**: abstração de identidade implementada e testável; **fornecedor real plugado só depois da decisão de negócio em §9/§20** — até lá, um provedor de desenvolvimento (`method='LINK_ONLY'`/OTP simulado) prova a interface.

- Interface `IdentityVerificationProvider` implementada; adaptador "dev/no-op" para testes e para o `AL1_LINK_KNOWLEDGE` (desafio de conhecimento/OTP) que é o **default de produto** conforme §16.
- `identity_profiles`/`identity_verifications` completos, incluindo o teto `achieved >= required` como `CHECK` de banco.
- Se e quando o fornecedor comercial for aprovado (AWS/Azure/Serpro-via-revenda — decisão de negócio pendente): adaptador real implementado atrás da mesma interface, sem tocar `epi_deliveries`/`confirmation_requests`.
- Fluxo mobile de captura (quando biometria estiver ligada por uma organização): sondagem de câmera real, degradação para `<input capture>` com marcação de garantia reduzida, nunca bloqueio sem alternativa.
- **Antes de escrever o fluxo de captura**: teste manual em dispositivos físicos (iOS Safari, iOS WhatsApp com link comum, iOS Instagram/Facebook, Android Chrome/WhatsApp) — o achado de pesquisa sobre `getUserMedia` em navegador embutido do WhatsApp permanece não verificado por fonte primária.

✅ Suite de contrato roda contra qualquer implementação de `IdentityVerificationProvider` (incluindo a de dev) e passa igual. Troca de adaptador não altera nenhum teste de `epi_deliveries`.

**Decisões tomadas durante a implementação:**
- **Interface simplificada em relação ao pseudocódigo ilustrativo do §9** (`createVerification`/`checkLiveness`/`verifyFace`/`getVerificationResult`/`enroll`/`deleteSubject`, pensado para uma sessão assíncrona de fornecedor biométrico). O `AL1_LINK_KNOWLEDGE` de fato implementado na FASE 3 (desafio dos 3 últimos dígitos do CPF) é síncrono, sem sessão — forçar isso pela forma assíncrona multi-etapa do §9 seria construir superfície sem uso real agora. A interface implementada (`src/lib/identity/provider.ts`) é um único `check(input): Promise<result>` — cobre honestamente os dois adaptadores reais que existem hoje (`LinkOnlyProvider`, `LinkKnowledgeProvider`). Quando o fornecedor biométrico real for aprovado, a forma de sessão do §9 provavelmente será necessária *naquele momento*, como extensão — não construída especulativamente agora.
- **Refatoração, não feature nova**: a lógica de decifrar/comparar CPF já existia desde a FASE 3, embutida diretamente em `src/app/e/s/[id]/actions.ts`. A FASE 4 extraiu isso para `LinkKnowledgeProvider` atrás da interface, com `LinkOnlyProvider` (sempre aprova, para `AL0_LINK_ONLY`) e `src/lib/identity/registry.ts` (seleciona o adaptador pelo `assurance_level` exigido). O ponto de troca de adaptador nunca toca `epi_deliveries`/`confirmation_requests` — já era assim antes (Postgres só recebe o booleano `p_identity_passed`), a FASE 4 só formaliza isso em código.
- **`achieved >= required` já era um `CHECK` de banco desde a FASE 3** (`confirmation_requests.achieved_ge_required_ck`) — nada novo precisou ser adicionado aqui.
- **`app.identity_profiles` criada como scaffold vazio**, sem RPC de escrita — nenhum adaptador hoje precisa de matrícula prévia (AL0/AL1 não têm conceito de "enrollment"). Mesmo padrão já usado para `evidence`/`audit` na FASE 0 e `integ.*` para o WOTY: arquitetura pronta, sem superfície de API fictícia.
- **Fluxo mobile de captura de câmera não construído** — depende de uma organização ter biometria (AL2+) ligada, o que por sua vez depende do fornecedor comercial ainda não escolhido (decisão de negócio pendente em §9/§20: exige serviço pago e credenciais). Fica pendente exatamente como a integração real do WOTY na FASE 7 — arquitetura pronta (a interface já suporta AL2-AL4 no tipo, só falta o adaptador), integração real aguardando decisão.
- Suite de contrato (`src/lib/identity/provider.contract.ts`) roda as mesmas 4 assertivas contra os dois adaptadores reais (`link-only-provider.test.ts`, `link-knowledge-provider.test.ts`) — 68/68 testes Vitest passam. Reverificado ao vivo contra `epi-dev`: o caminho de confirmação, agora passando pela abstração, continua confirmando corretamente (mesmo teste do CPF correto da FASE 3, refeito depois da refatoração).

---

## FASE 5 — Evidence

**Objetivo**: selamento canônico, hash, documento, verificação pública — o núcleo jurídico do produto.

- Canonicalização `epi-canon/1` (RFC 8785 + regras de §12) com vetores de ouro fixos em CI.
- `app.confirm_delivery()` transacional completo (§12): sela evidência, grava posição na cadeia de auditoria, tudo ou nada.
- Geração de PDF assíncrona pós-commit (@react-pdf/renderer, datas de criação/modificação fixadas para determinismo — verificado empiricamente na pesquisa) + QR apontando para `/verify/<código>`.
- Página pública `/verify/<código>` — não revela dado pessoal além do mínimo (§8).
- Cadeia de auditoria por organização com hash chain (§13); âncora diária ainda pode ser um job simples sem carimbo ICP-Brasil real até a decisão jurídica de §20.
- Testes: dois selamentos do mesmo payload em processos diferentes produzem hash idêntico; alterar um único caractere do texto da declaração muda o hash; tentativa de `UPDATE`/`DELETE` em `evidence.evidence_versions` falha em toda camada (grant, gatilho, ausência de rota HTTP).

✅ Os passos 9–13 da Definition of Done passam em E2E. Um script de verificação externo (fora da aplicação) recomputa o hash a partir de `canonical_bytes` e bate com `payload_sha256` para 100% de uma amostra de confirmações de teste.

**Decisões tomadas durante a implementação:**
- **Canonicalização via biblioteca (`canonicalize` npm, MIT/Apache-2.0, zero deps), não implementação própria de RFC 8785.** A ordenação de chaves e formatação numérica do JCS têm casos de borda reais o bastante para que "citar um padrão publicado, não inventar um formato" se estenda a "não inventar uma implementação dele". `src/lib/evidence/canon.ts` faz a validação/normalização própria (NFC, proibição de float/null/controle/bidi, timestamps `_utc`) por cima da biblioteca.
- **Canonicalização acontece no Node, não em PL/pgSQL** — Postgres não tem implementação de JCS para se apoiar. Para preservar "tudo ou nada" mesmo assim: `worker.get_evidence_source` (nova RPC, só leitura, sem efeito colateral) devolve os dados AUTORITATIVOS que o Node usa para montar e hashear o payload; só então `worker.finish_confirmation` recebe os bytes/hash já prontos e faz TUDO no mesmo transaction — transição, verificação de identidade, selamento. Nunca existe uma janela com `CONFIRMED` sem evidência: se o processo cair entre a leitura e a chamada final, a entrega simplesmente não avança (sem escrita nenhuma), nunca fica num estado parcial.
- **`p_confirmed_at_utc` é gerado uma única vez no Node** e usado tanto no `confirmed_at_utc` do payload quanto em todo timestamp que o banco grava nesta chamada (`confirmed_at`/`frozen_at`/`sealed_at`) — um relógio só, nunca dois tomados independentemente que poderiam divergir por milissegundos.
- **`app.confirm_delivery()` do enunciado não foi criada como função separada** — a lógica de selamento foi anexada dentro de `worker.finish_confirmation` (já a função que transiciona `CONFIRMED` desde a FASE 3) via um helper interno `app.seal_evidence()`, nunca exposto ao PostgREST. Mesma coisa, nome diferente — a arquitetura já normatizava o COMPORTAMENTO ("selar evidência, gravar posição na auditoria, tudo ou nada"), não literalmente uma função com esse nome exato.
- **Geração de PDF via `@react-pdf/renderer` + Storage NÃO foi construída nesta fase** — decisão de escopo deliberada, documentada aqui, não um corte de segurança. O "comprovante" da Definition of Done é satisfeito pela página pública `/verify/<código>` (dado mínimo, sem login) mais o painel "Comprovante" no gestor (código completo, timestamp, hash, link) mais o recibo do próprio trabalhador (com QR) — todos já reais e verificados ao vivo. Um PDF gerado no servidor + bucket de Storage + signed URLs seria uma CAMADA DE APRESENTAÇÃO adicional sobre uma evidência já completa e selada, não uma peça faltando da prova em si; o navegador já imprime qualquer uma dessas páginas em PDF nativamente. Fica como candidato de FASE futura se o cliente pedir explicitamente um arquivo baixável.
- **Âncora diária de hash chain com carimbo de tempo externo (RFC 3161) não foi construída** — depende de decisão jurídica pendente (§20: se é obrigatório ICP-Brasil) e de infraestrutura de job/cron que ainda não existe (só chega na FASE 6). A cadeia de hash por organização em si (`audit.audit_events`, já construída na FASE 3) já é tamper-evident sem a âncora; a âncora é uma camada adicional de "um terceiro atestou isso nesta data", explicitamente marcada como opcional-por-ora no próprio enunciado da FASE 5.
- **Código de verificação sem dígito de checagem formal Crockford** (só 12 caracteres aleatórios do alfabeto, 32^12 combinações) — simplificação deliberada: o código é uma chave de busca, não um segredo; um código digitado errado simplesmente não encontra nada, sem consequência de segurança.
- **Bugs reais encontrados nesta fase**: (1) mesmo erro de ambiguidade de coluna já visto antes (`api.delivery_audit_events` na FASE 3) — desta vez em `worker.verify_document`, onde `RETURNS TABLE(verification_code text, ...)` colidia com a coluna de mesmo nome em `evidence.documents`; corrigido qualificando com alias de tabela. (2) Meu próprio teste funcional tinha um bug: tentava provar que a `CHECK` de hash rejeita um par adulterado, mas rodava como `authenticated` (sem grant de INSERT nenhum ali) — o erro real testado era permissão, não a `CHECK`; corrigido rodando como o papel dono/irrestrito para isolar exatamente a constraint sendo testada. (3) No pgTAP: `select is(...)`/`ok(...)` chamados diretamente enquanto o papel ainda era `anon`/`authenticated` falhavam com "permission denied for schema extensions" no meu checker ad-hoc local (que qualifica essas chamadas explicitamente) — corrigido capturando o valor numa fixture dentro do bloco com papel trocado, resetando o papel, e só then chamando a asserção — mesmo padrão já usado em outros pontos do mesmo arquivo, só que eu tinha esquecido de aplicá-lo aqui.
- Verificado localmente via script funcional PGlite dedicado (20 checks, usando o módulo REAL `src/lib/evidence/canon.ts`, não um stub) e `supabase/tests/database/050_evidence_sealing.sql` (pgTAP, 15 assertions). **Verificado ao vivo (2026-09-01)** via Playwright contra `epi-dev` real: entrega confirmada com CPF correto → recibo do trabalhador mostra QR + código de 12 caracteres → painel "Comprovante" do gestor mostra o MESMO código, timestamp de selamento e início do hash → página pública `/verify/<código>`, acessada de um contexto de navegador totalmente separado sem cookie nenhum, mostra CONFIRMADO + nome da empresa + data + prefixo do hash, e **nunca** o nome do trabalhador nem os itens da entrega em lugar nenhum da resposta (confirmado inspecionando o HTML completo da página) → código inexistente mostra "Código não encontrado", nunca um erro. Linha do tempo de auditoria do gestor mostra `EVIDENCE_SEALED` corretamente rotulado como "Comprovante selado".

---

## FASE 6 — Scale

**Objetivo**: entrega em massa, lembretes, dashboard operacional — pensado para milhares de funcionários, sem processamento pesado síncrono no navegador.

- Criação de lote: uma única instrução SQL set-based (CTE de inserção, §6 da pesquisa operacional), com teto explícito por lote e erro claro acima dele — nunca travar silenciosamente.
- Envio como fila: o próprio `confirmation_requests` pendente de token é a fila; `pg_cron` + Edge Function drena em lotes com `FOR UPDATE SKIP LOCKED` — sem infraestrutura nova (Redis/pgmq só entram se a operação provar necessidade).
- Contadores do lote: gatilhos **de nível de statement** com `REFERENCING NEW TABLE` (não por linha) — um insert de 5.000 linhas toca o contador uma vez, não 5.000 vezes.
- Reenvio de pendentes apenas (nunca reenvia confirmados/contestados).
- Dashboard operacional (§ do enunciado 24): funcionários ativos, entregas no período, confirmadas/aguardando/contestadas/falhas, entregas pendentes há X dias, últimas atividades — perguntas, não gráficos decorativos.
- Testes: lote de 5.000 funcionários sintéticos cria exatamente 5.000 entregas + 5.000 confirmation_requests + 5.000 eventos de auditoria em uma transação, dentro do orçamento de tempo do plano Vercel escolhido; reenvio-só-pendentes não toca nenhuma linha já confirmada ou contestada.

✅ O passo 15–16 da Definition of Done passa para um lote sintético de 237 registros (o número do próprio exemplo do enunciado) e, em teste de carga separado, para 5.000.

**Decisões tomadas durante a implementação:**
- **Contadores do lote NÃO usam gatilho de nível de statement com `REFERENCING NEW TABLE`** como o enunciado original sugeria — usei uma abordagem funcionalmente equivalente mas mais simples: `api.create_delivery_batch` já controla 100% do caminho que insere `epi_deliveries` em massa (nenhum outro código faz isso), então ela mesma grava `total_count` uma única vez, via `GET DIAGNOSTICS`/contagem do próprio `INSERT ... RETURNING`, logo após o insert — sem gatilho nenhum para essa direção. Para `confirmed_count`/`contested_count`/`cancelled_count`, que crescem um de cada vez conforme trabalhadores confirmam/contestam individualmente ao longo de dias (nunca em lote), um gatilho **de linha** (`app.bump_batch_counter`) é a ferramenta certa — nunca dispara 5.000 vezes de uma vez, porque essas atualizações nunca chegam em lote de verdade.
- **Envio como fila (`pg_cron` + Edge Function + `FOR UPDATE SKIP LOCKED`) não foi construído.** Sem fornecedor de mensageria aprovado (WhatsApp Business exige template Meta ainda não iniciado; nenhum serviço de e-mail transacional foi contratado), construir uma fila de DRENAGEM sem nada a drenar de verdade seria infraestrutura sem uso real. O que existe: cada entrega do lote já tem seu link individual gerado (mesmo mecanismo `MANUAL_COPY` das entregas avulsas), devolvido ao gestor como uma lista `funcionário → link` na tela — funciona de verdade para o exemplo de 237 do enunciado; para milhares, o gestor tem a lista completa para usar com qualquer canal disponível hoje, mas o envio automatizado real continua pendente da decisão de fornecedor (mesmo tipo de corte já documentado para o WOTY na FASE 7 e o fornecedor biométrico na FASE 4: arquitetura pronta — a fila JÁ é o próprio `confirmation_requests` pendente, exatamente como o enunciado pede — só a drenagem automática que falta).
- **Geração de PDF/e-mail de lembrete não construída** — mesmo raciocínio acima, sem fornecedor.
- **Entregas de lote são criadas diretamente como `ISSUED`, nunca `DRAFT`** — diferente do fluxo individual (`api.create_delivery`, que cria `DRAFT` e só emite depois via `api.issue_delivery`). Um lote não tem etapa de revisão por funcionário: o gestor já revisou a lista inteira antes de submeter, e como o `confirmation_request` de cada entrega é criado na MESMA transação, a entrega precisa nascer `ISSUED` (única entrada válida para ter um link ativo). Isso exigiu uma correção retroativa no gatilho `app.enforce_items_draft_only` da FASE 2 (via nova migration, nunca editando a já aplicada) — o gatilho bloqueava qualquer `INSERT` de item a menos que a entrega estivesse em `DRAFT`; a invariante real que ele precisa proteger é mais estreita ("nenhuma MUDANÇA depois de emitida", não "nenhuma inserção fora de DRAFT") — corrigido para permitir `INSERT` sempre, mantendo `UPDATE`/`DELETE` restritos a `DRAFT`.
- **Bugs reais encontrados só executando contra PGlite** (nenhum destes seria pego só lendo o SQL): (1) a mesma classe de ambiguidade `RETURNS TABLE` vs. coluna já vista em fases anteriores, desta vez em `api.resend_batch_pending` (`delivery_id` na cláusula `RETURNING`). (2) **Condição de corrida real dentro de uma única instrução `WITH`**: `revoked` (um `UPDATE`) e `new_confirmations` (um `INSERT`) eram CTEs irmãs sem dependência de dados entre si — Postgres NÃO garante ordem de execução entre CTEs-irmãs num mesmo `WITH`, só entre as que genuinamente leem a saída umas das outras. Sem uma dependência real, o `INSERT` podia rodar antes do `UPDATE` "revogar" o link antigo, violando o índice único `confirmation_requests_one_live_per_delivery`. Corrigido tornando `new_confirmations` depender de fato de `revoked` (`LEFT JOIN`), forçando a ordem. Isso levou à descoberta de um problema maior: (3) uma atualização em MASSA (`UPDATE` afetando várias linhas de uma vez) não consegue satisfazer o guard de `app.transition_ok` do gatilho genérico de transição de estado (que autoriza exatamente uma linha por vez, por design) — resolvido convertendo só o passo de revogação do reenvio para um laço `PL/pgSQL` (linha a linha, mas inteiramente dentro de uma única chamada de função no servidor — nada como looping de chamadas RPC pelo navegador), sem tocar a função de gatilho compartilhada entre as duas máquinas de estado.
- Verificado localmente via script funcional PGlite dedicado: lote de 237 (100-140ms) com todas as contagens corretas, snapshot imune a edição posterior do catálogo, isolamento entre tenants, reenvio-só-pendentes provado (236 reenviadas de 237, a já confirmada nunca tocada), painel operacional com números corretos. **Teste de carga separado: lote sintético de 5.000 funcionários, uma única instrução `create_delivery_batch`, ~3,7s em PGlite (WASM, mais lento que Postgres real) — 5.000 entregas + 5.000 `confirmation_requests` + exatamente UM evento `BATCH_CREATED`.** `supabase/tests/database/060_delivery_batches.sql` (pgTAP, 11 assertions) cobre a mesma superfície em escala pequena/rápida para CI.

**Verificado ao vivo (2026-09-01)** via Playwright contra `epi-dev` real: lote de 3 funcionários criado a partir de `/deliveries/batch/new` (checkbox "Selecionar todos os ativos" + 1 item de EPI) → tela de resultado mostra os 3 links individuais com botão "Copiar" cada → `/deliveries/batches/<id>` mostra Total=3/Confirmadas=0/Pendentes=3/Contestadas=0/Canceladas=0 e a tabela de entregas do lote com status "Emitida" para cada uma → abrindo o link de um dos funcionários (numa aba/contexto totalmente separado) confirma que a entrega do lote está realmente viva e passa pelo desafio AL1 (CPF) normalmente, igual a uma entrega individual → botão "Reenviar pendentes" gerou 3 novos links (nenhuma das 3 estava confirmada ainda), sem alterar as contagens do lote → painel operacional em `/companies/<id>/dashboard` mostrou números reais e corretos (funcionários ativos, entregas no período, confirmadas/aguardando/contestadas/canceladas, pendentes há mais de 3/7 dias) e a linha do tempo de atividade da empresa inteira (não só de uma entrega), incluindo os dois eventos `BATCH_CREATED` dos lotes criados durante o teste, corretamente ordenados cronologicamente.

---

## FASE 7 — Integration

**Objetivo**: adaptador WOTY real — só depois de credenciais e confirmação de autenticação obtidas do cliente/WOTY (§11/§20). Até lá esta fase fica com a arquitetura pronta e a integração real marcada como pendente.

- Arquitetura de adaptador (`integ.integration_connections`/`external_mappings`/`sync_runs`) já existe desde a Fase 0 do schema; esta fase liga a implementação real.
- Sincronização full-scan periódica paginada (sem suporte a delta/webhook confirmado pela pesquisa).
- Escrita de sync sempre via `app.new_employee_version(data_origin='SYNC_WOTY')` — nunca `UPDATE` in-place.
- Campos sincronizados ficam somente-leitura no painel para empresas conectadas; edição manual rejeitada com mensagem clara (decisão a confirmar com o primeiro cliente antes de codificar a UI — §11).
- Testes: com um servidor WOTY simulado (mock, já que não há credenciais reais), prova que queda do serviço externo não afeta nenhuma leitura da aplicação; prova que um `sync_run` parcialmente falho não corrompe `external_mappings`.

✅ Toda a suite de testes desta fase roda contra um mock — nenhuma chamada real à API do WOTY é implementada nem testada até que credenciais e confirmação de autenticação sejam fornecidas pelo cliente. Isso é reportado explicitamente como pendente, não como concluído.

---

## O que nunca entra no MVP (lembrete, não decisão a reabrir a cada fase)

Estoque, compras, PGR/PCMSO/ASO, folha, financeiro, CRM, eSocial completo (embora o modelo de dados não o impeça — §12 do enunciado), treinamentos, IA, aplicativo nativo, reconhecimento facial próprio, white-label completo, faturamento automático.

## Fim do MVP

O MVP é considerado funcional quando os 16 passos da Definition of Done do enunciado passam em E2E automatizado contra uma build de produção, com os dois tenants do passo 14 provados por teste, não por inspeção — isto é, quando a suite completa das Fases 0–6 está verde. A Fase 7 (WOTY real) é posterior e depende de terceiro.
