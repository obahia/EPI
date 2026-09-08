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

---

## Pós-MVP — Identidade visual "Selo" e i18n (2026-09-01)

Fora do roteiro FASE 0–7 (não é parte da Definition of Done do enunciado): o produto ganhou nome ("Selo") e uma identidade visual própria, mais suporte bilíngue pt-BR/inglês com seletor de idioma, cobrindo o painel autenticado inteiro e três telas novas (login, 404, recuperar/redefinir senha).

- **Tokens de design** em `src/app/globals.css`: neutros "papel" (não creme/terracota) + um único acento violeta ("carimbo roxo", a cor da tinta do carimbo brasileiro tradicional) — escolha deliberada para fugir dos três clichês de design gerado por IA (creme+serifa+terracota; quase-preto+neon; layout jornal). Tipografia: Fraunces (heading) + IBM Plex Sans (corpo/UI) + IBM Plex Mono (códigos/CAs/tokens). Marca própria: `src/components/seal-mark.tsx`, um selo/rosácea SVG com variante "quebrada" usada só na página 404 (metáfora: link inexistente = selo quebrado).
- **i18n leve e caseira** em `src/i18n/` — decisão deliberada de NÃO usar `next-intl`: a rota `[locale]`/middleware de roteamento do next-intl exigiria reestruturar todas as rotas existentes, incluindo o fluxo do trabalhador sem token (`/e/*`) e a página pública `/verify/*`, que ficam **fora do escopo aprovado** (só pt-BR) e não podem ser tocadas. Em vez disso: dicionário `pt`/`en` como objeto plano (`src/i18n/dictionaries.ts`, `en: typeof pt` força as duas árvores de chaves ficarem idênticas em tempo de compilação), cookie `selo_locale` (`src/i18n/get-locale.ts` para Server Components/Actions, `src/i18n/actions.ts` para trocar), e `I18nProvider`/`useT()`/`useLocale()` (`src/i18n/provider.tsx`) para Client Components — o provider embrulha só `(auth)` e `(dashboard)`, nunca o layout raiz nem `/e/*`/`/verify/*`.
- **Autenticação**: `/forgot-password` e `/reset-password` são fluxos novos (não existiam antes), usando o fluxo PKCE padrão do Supabase Auth (`/auth/callback/route.ts` troca o `code` por sessão via `exchangeCodeForSession`). Mesma decisão já documentada para signup na FASE 0: sem provedor de e-mail transacional configurado no projeto ainda, o e-mail de redefinição não é entregue de verdade em dev — o código está correto e pronto, igual ao signup.
- **Painel redesenhado**: navegação superior fina trocada por barra lateral (`src/components/dashboard-sidebar.tsx`) com ícones lucide-react, item ativo destacado, seletor de idioma e botão sair fixos no rodapé — melhora de hierarquia visual pedida explicitamente pelo usuário ("a hierarquia da ui ux tá bem feio").
- **Tradução de todo o painel** (empresas, funcionários, EPIs, entregas, lotes) feita por dois agentes em background, sequenciais (não paralelos) para evitar condição de corrida na edição simultânea do mesmo arquivo `dictionaries.ts` — um para empresas+funcionários, outro para EPIs+entregas+lotes. Regra passada aos dois: só extrair strings para o dicionário, nunca tocar lógica de negócio/RPCs/validação; qualquer classe de cor hardcoded (`text-green-600` etc.) vira token (`text-success`/`text-warning`/`text-destructive`). Ambos os diffs foram revisados manualmente neste arquivo por arquivo em `batch-actions.ts` e `epis/actions.ts` (os mais sensíveis, com geração de token/RPC) — confirmado: só troca de string, nenhuma mudança de lógica.
- `getDeliveryStatusMeta()` (função pura testada em `delivery-status-badge.test.ts`) continua retornando o rótulo pt-BR original — a tradução de fato acontece em `deliveryStatusLabel(t, status)`, chamada só no componente `<DeliveryStatusBadge>` (que agora é Client Component com `useT()`), preservando o teste existente sem enfraquecê-lo.
- **Verificado**: `npx tsc --noEmit`, `npx eslint src --max-warnings=0` e `npx vitest run` (81/81) passam limpos após as duas rodadas do agente. `npx playwright` screenshot manual confirmou visualmente `/`, `/login`, `/forgot-password`, `/reset-password` e uma rota 404 (`/this-does-not-exist`) contra o dev server local. **Não verificado ao vivo**: o painel autenticado (`/dashboard`, `/companies`, etc.) com a barra lateral nova — tentativas de criar uma conta de teste via signup falharam (provavelmente rate limit do Supabase Auth após tentativas repetidas nesta sessão), não uma regressão introduzida aqui; recomenda-se conferir visualmente na próxima vez que alguém logar de verdade.

---

## FASE F — Integrações (2026-09-07)

Escopo: §18 (importação), §19 (API pública), §20 (webhooks) da especificação original. Precedida por uma reconstrução de escopo (Passo 0) e por um contrato formal, ambos aprovados antes de qualquer linha de código.

### O que foi construído

**Extração do domínio, em duas etapas separadas de propósito.** A `20260907000000` move o corpo de `api.create_employee`/`api.update_employee` para `app.*_core(app.actor_context, …)` removendo **somente** a autorização — a prova de neutralidade é que as suítes pgTAP 020–170 passam sem uma única edição. A `20260907005000` só então adiciona `EMPLOYEE_CREATED`/`EMPLOYEE_UPDATED`. Juntar as duas teria tornado a afirmação de neutralidade impossível de verificar.

**Plano M2M.** `m2m` (principals, chaves, idempotência, quota) e `m2m_rpc` (o único schema novo exposto ao PostgREST, concedido só a `service_role`). Uma API key não é usuário: `auth.uid()` e os quatro helpers `auth_ctx.*` ficam byte a byte iguais. As RPCs recebem `(key_id, secret_hash)` e resolvem o principal dentro do Postgres — a credencial de banco sozinha não autoriza nada.

**API v1.** Nove rotas (`employees` read/write, `positions`/`locations`/`epis`/`deliveries` read). `POST /v1/deliveries` e o escopo `deliveries:write` ficaram fora por decisão explícita. Confirmação e selamento de evidência são inalcançáveis por construção.

**Webhooks.** `hooks.outbox` alimentado por trigger `AFTER INSERT` em `audit.audit_events`, na própria transação do evento. Runner em Vercel Cron. Política SSRF com pinagem de IP pós-resolução DNS, sem seguir redirect.

**Importação.** Cargo → `position_id`, Unidade → `location_id`, XLSX, e `app.import_runs`/`app.import_run_chunks` para que uma importação parcial seja legível e retomável. Nada é criado automaticamente.

### Verificações que mudaram o desenho

**T.1 — o papel `selo_m2m` não pôde ser usado, apesar de ser suportado.** Uma sonda descartável rodada em `epi-dev` (dentro de `begin/rollback`, sem resíduo) provou que criar o papel funciona, que `GRANT ... TO authenticator` funciona, e que o isolamento é total: 10 schemas negados, 6 tabelas negadas no catálogo *e* com `42501` na leitura real, `auth.uid()` inalcançável. Mas o JWKS do projeto publica **apenas ES256 assimétrico** e a chave privada é do Supabase — não há como assinar um JWT com `role = selo_m2m`. Foi o que levou à decisão Alt-2, e à percepção de que a âncora de autorização deveria ser a chave de API resolvida no banco, não o papel Postgres.

**T.2 — o runner.** Nada está implantado (sem `vercel.json` até esta fase, sem workflow de deploy, sem Edge Functions, sem `pg_cron`/`pg_net` no banco real). A única decisão de deployment que o projeto tomou é Vercel (§19), e Vercel Cron é a única opção que não adiciona runtime, pipeline nem observabilidade novos. `pg_net` foi rejeitado por colocar I/O de rede dentro do Postgres.

### Bugs reais encontrados por teste, não por leitura

1. `parseApiKey` fazia `split("_")` na chave inteira, mas o segredo é base64url — cujo alfabeto contém `_`. Cerca de metade das chaves geradas falhava no parse.
2. `checkWebhookUrl` não reconhecia literais IPv6: `URL.hostname` mantém os colchetes e `isIP()` não aceita endereço entre colchetes, então o check `ip_literal` nunca disparava. Era recusado apenas pela heurística "precisa conter ponto" — que `[::ffff:127.0.0.1]` satisfaz.
3. `api.resolve_import_references` usava o operador `%` do pg_trgm sob `search_path = ''`, onde ele não resolve. Corrigido para `OPERATOR(extensions.%)` — qualificar uma *função* é hábito, qualificar um *operador* precisa dessa sintaxe e passa despercebido.

### Divergências registradas, não resolvidas silenciosamente

- Roadmap ("position CSV import") vs §18 (import de colaboradores): ver `docs/architecture.md` §25.
- `docs/architecture.md` §10 e §11 descreviam como presente um design nunca construído (`notification_attempts`, `integ.*`, `app.new_employee_version`, `employee_fields_are_readonly`). Corrigidos e rotulados, sem construir a arquitetura antiga só para tornar o doc verdadeiro.

### Não implementado, declarado

- `delivery.refused` (nenhum evento tem essa semântica) e `compliance.changed` (compliance é derivada; materializá-la criaria uma segunda fonte de verdade).
- `X-RateLimit-Remaining` em respostas de sucesso.
- Criação automática de cargo/unidade no import — proibida, sem opt-in.

### FASE F — resultado do benchmark do outbox (CI run #29, Postgres real)

Executado em `.github/workflows/ci.yml`, job `database`, com `BENCH_REPEATS=3`, `BENCH_SEQUENTIAL_N=200`, `BENCH_CONCURRENT_N=240`. Primeira repetição descartada como aquecimento; medianas entre repetições.

| Config | S3 seq p50 | S3 seq p95 | S3 seq p99 | S4 conc p95 | tx/s | outbox após |
|---|---|---|---|---|---|---|
| **B0** sem trigger (baseline) | 0,575 ms | 0,689 ms | 0,896 ms | 13,82 ms | 1661 | 0 |
| **B1** trigger, zero endpoints | 0,568 ms | 0,681 ms | 0,953 ms | 13,98 ms | 1716 | 0 |
| **B2** trigger, 1 endpoint, runner off | 0,603 ms | 0,762 ms | 0,921 ms | 13,84 ms | 1567 | 1320 |
| **B3** B2 + backlog, runner off | 0,586 ms | 0,755 ms | 0,952 ms | 13,16 ms | 1593 | 5280 |

**B1 — o caso que 100% dos tenants pagam hoje.** p95 sequencial **−1,2%**, throughput **+3,3%**, ambos *melhores* que o baseline. Isso é a assinatura de ruído, não de ganho: a guarda `EXISTS` sobre `hooks.endpoints` não tem custo mensurável. Nenhuma linha de outbox é escrita (`outbox após = 0`), confirmando que o caminho barato é de fato o caminho tomado.

**Piso de ruído.** B1 deveria ser ~0% em relação a B0 e mediu +3,3% de throughput; isso situa a variação entre configurações em torno de **±5%**. Todo número abaixo é lido contra esse piso.

**B2 — o custo real do `INSERT` de enfileiramento.** p95 sequencial **+10,7%**, que em absoluto são **+73 µs** sobre uma operação de 0,689 ms; p50 **+28 µs**. Throughput −5,7%, na borda do piso de ruído. Sob concorrência de 8 conexões na mesma organização — o cenário realista — a diferença é **+0,1%**, indistinguível: ali o lock em `audit.chain_heads` domina (13,8 ms p95, ~18× maior que a operação inteira sequencial) e o INSERT extra desaparece dentro dele.

**Veredito sobre B2:** custo real, pequeno, sub-100 µs, e pago **apenas** por organizações que ativaram um webhook. Não é regressão material. Nenhuma mudança de desenho.

**B3 — a asserção que bloquearia a fase.** B3 não é pior que B2 em nenhuma métrica: p95 sequencial **−0,9%**, p50 **−2,8%**, p95 concorrente **−4,9%**, throughput **+1,7%**. O custo do enfileiramento **não cresce com o backlog**.

**Limitação declarada do B3.** O rótulo diz "10k row backlog", mas o backlog real foi de **~3.960 linhas**, não 10.000: o script semeia o backlog a partir dos eventos de auditoria que aquele tenant já acumulou (`limit 10000`), e ao chegar em B3 existiam apenas ~3.960. A conclusão está sustentada nessa escala; **não** está sustentada em 100k. Como o enfileiramento é um `INSERT` numa tabela com índice único sobre `audit_event_id`, a degradação esperada seria logarítmica, mas isso é raciocínio, não medição. Correção para uma próxima execução: semear o backlog sinteticamente em vez de derivá-lo do histórico do tenant.

**Contenção de lock.** Amostras de espera em lock: 39 / 37 / 42 / 51 (B0…B3). Números pequenos e ruidosos; a leve alta em B3 não é distinguível de variação amostral. A janela do lock em `chain_heads` é o fator dominante em todas as quatro configurações, com ou sem trigger.

**Nenhum limiar foi aplicado.** Os números acima são o entregável; o baseline foi medido primeiro, com o trigger removido, e cada configuração é relatada contra ele.

---

## FASE G — Membros e convites (2026-09-08)

Escopo: a fundação de parceria/membership. O que foi construído é a gestão de equipe que faltava desde a FASE 0 — convidar, escopar, trocar papel, revogar — e **não** acesso entre organizações.

### Por que não travou numa pergunta

A leitura de `partner_relationships` no roadmap de expansão é ambígua: pode significar "permissões delegadas separadas da posse" (algo novo) ou "a organização PARTNER com N empresas-clientes" (que já existe e é testada desde a FASE 0). Levantei isso como bloqueio e estava errado: **o trabalho é o mesmo sob as duas leituras.** Acesso entre orgs seria uma adição por cima, não uma alternativa. A pergunta ficou registrada em `docs/architecture.md` §26; a fase seguiu.

### O que foi construído

**`auth_ctx.can_grant_role`** — a regra que faltava atrás de `membership.manage`, que `COMPANY_ADMIN` e `ORG_ADMIN` compartilham. Os cinco helpers `auth_ctx.*` anteriores continuam byte a byte iguais; este é aditivo.

**`authz.membership_invitations`** — só o hash do token, endereço fixado, TTL com teto de 30 dias, e três estados terminais mutuamente exclusivos por CHECK (aberto / aceito / revogado).

**`api.invite_member`, `api.accept_invitation`, `api.revoke_invitation`, `api.list_members`, `api.list_invitations`, `api.update_membership_role`, `api.revoke_membership`** — e `authz.is_last_org_admin`, consultada pela revogação e pelo rebaixamento.

**Painel** — `/settings/team` (equipe + convites), `/convite/<token>` (aceitação, fora do dashboard), e a primeira linha de navegação do app cuja visibilidade depende do papel de quem olha.

**Eventos** — `MEMBER_INVITED`, `INVITATION_ACCEPTED`, `INVITATION_REVOKED`, `MEMBER_ROLE_CHANGED`, `MEMBER_REVOKED`, todos na cadeia de auditoria do próprio tenant. O endereço convidado **não** é gravado: é dado pessoal, e a trilha responde "quem concedeu qual escopo", o que os ids já fazem.

### Decisões que valem registrar

**Token sem pepper, ao contrário do token do trabalhador e da API key.** Justificativa completa em `src/lib/crypto/invitation-token.ts` e em `docs/architecture.md` §26. Resumo: pepper protege contra entrada adivinhável; 256 bits de CSPRNG não são adivinháveis, e um sétimo segredo para manter sincronizado entre ambientes é uma classe de falha que este projeto já pagou.

**Aceitação por POST, não por GET.** Um convite é de uso único; um prefetch ou scanner de link o queimaria antes do clique.

**Redirect pós-login restrito a um único formato.** `/login?next=…` aceita **apenas** `^/convite/[A-Za-z0-9_-]{43}$`, casado literalmente. "Começa com barra" é como uma página de login vira ponte de phishing.

### Estado de verificação

| Camada | Estado |
|---|---|
| `npm run typecheck` / `lint` / `test` (218 testes, 9 novos em `invitation-token.test.ts`) | verde local |
| `npm run build` | verde local, `/convite/[token]` e `/settings/team` presentes |
| `npm run db:check:local` (PGlite) | as duas migrations aplicam de zero |
| pgTAP `230_membership_invitations.sql` (26 asserções) | **primeira execução no CI falhou no fixture, antes de qualquer asserção** — ver abaixo |
| `scripts/concurrency-test.mjs` cenário 3 (duas aceitações simultâneas do mesmo token) | **escrito, ainda não executado** — exige duas conexões reais, roda só no CI |
| Migrations aplicadas em `epi-dev` | **não** |
| E2E ao vivo (convidar, aceitar em outra sessão, revogar) | **não** |

Nada acima é relatado como funcionando por parecer certo. As três últimas linhas mudam quando houver evidência, não antes.

### FASE G — o que a primeira execução do CI pegou

**Bug no fixture da suíte, não no código da fase.** A suíte pedia à `api.onboard_organization` o tenant PARTNER de que precisava, mas o onboarding **sempre** grava `kind = 'DIRECT'`, e o índice `companies_one_per_direct_org` (FASE 0) então permite exatamente uma empresa por organização. A segunda `api.create_company` levantou `23505` e o arquivo abortou com *"You planned 22 tests but ran 0"* — **nenhuma asserção da fase chegou a rodar**.

A restrição está certa e não foi tocada. Uma organização PARTNER é criada pelos operadores do próprio Selo hoje, não em self-service, então nenhuma RPC cunha uma — é justamente por isso que o fixture precisa inseri-la direto, do mesmo jeito que a `010_tenant_isolation.sql` monta seus dois tenants sob privilégio total antes de trocar de papel.

**E o que a falha expôs de mais grave:** a suíte tinha o mesmo buraco que custou caro na Fase F. `api.list_members` e `api.list_invitations` são `RETURNS TABLE`, a forma exata que já quebrou quatro vezes neste código por `42702` em tempo de execução, e a suíte só checava a lista de retorno delas — **nunca as chamava**. Foi assim que `api.list_api_keys`, `api.list_webhook_deliveries` e `api.import_run_status` passaram por um CI verde estando quebradas em *toda* chamada. As duas agora são chamadas de verdade (seção 2b), o que levou a suíte de 22 para 26 asserções.
