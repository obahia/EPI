# Runbook — Segredos

**Nenhum valor real de segredo entra neste documento, no repositório, num commit, num log ou numa mensagem.** Este runbook descreve categorias, donos, e o que fazer. Os valores vivem apenas nos cofres nomeados na §2.

Escrito para o PILOT READINESS (P1-5). O que ele resolve: dois destes segredos são **irrecuperáveis por natureza** e até agora não havia procedimento escrito de custódia. Perder um deles não é um incidente de disponibilidade, é perda permanente de capacidade.

---

## 1. Categorias

| Segredo | Categoria | Se for perdido | Se vazar |
|---|---|---|---|
| `CPF_HASH_PEPPER` | **Irrecuperável** | A evidência selada continua íntegra, mas **desaparece para sempre** a capacidade de reconferir qual CPF está por trás de um hash histórico. Nenhum backup do banco recupera isto — o valor nunca esteve lá | Um dump do banco passa a permitir enumerar CPFs por força bruta (11 dígitos são enumeráveis; o pepper é a única coisa que impede) |
| `CPF_ENCRYPTION_KEY` | **Irrecuperável** | Todo `cpf_enc` armazenado vira ruído: o desafio de identidade AL1 (3 últimos dígitos) para de funcionar para **todo** trabalhador | Quem tiver a chave e um dump lê o CPF em claro de todos os funcionários |
| `WORKER_TOKEN_PEPPER` | **Irrecuperável** | Todo link de confirmação pendente deixa de resolver. Entregas já confirmadas não são afetadas; as pendentes precisam de link novo | Quem tiver um dump pode calcular o hash de um token adivinhado — mas o token tem 256 bits, então o risco prático é baixo |
| `API_KEY_PEPPER` | **Irrecuperável** | Toda chave de API emitida deixa de autenticar de uma vez | Um dump permite validar chaves adivinhadas; mesma ressalva de entropia |
| `WEBHOOK_SECRET_KEY` | **Irrecuperável** | Todo segredo de endpoint armazenado fica indecifrável; nenhuma entrega de webhook consegue ser assinada | Permite forjar a assinatura de webhooks para os endpoints do cliente |
| `SUPABASE_SECRET_KEY` | **Rotacionável** | Nada se perde; emite-se outra | Acesso administrativo ao projeto Supabase (Admin API de auth). **Não** dá acesso a dado de tenant por RLS — `service_role` não tem USAGE em schema nenhum deste projeto — mas dá controlo sobre contas |
| `CRON_SECRET` | **Rotacionável** | Os jobs param até ser reposto | Terceiros conseguem disparar o runner de webhooks e a manutenção |
| `NEXT_PUBLIC_SUPABASE_URL` | **Público** | — | Não é segredo; vai no bundle do navegador |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **Público** | — | Não é segredo por desenho; sozinha não autoriza nada além do que a RLS permitir ao papel `anon` |

`DEV_PROBE_KEY` e `RESEND_API_KEY` aparecem em `.env.example` mas **não são lidos por nenhum código** (verificado por busca em `src/`). Não configure em produção enquanto não houver consumidor.

**Por que estes cinco não estão no Supabase Vault:** decisão de `docs/architecture.md` §8/§16. A ameaça realista é um dump do banco, e o Vault fica dentro do banco. Um pepper guardado ao lado do hash que ele protege não protege nada.

---

## 2. Onde ficam

| Ambiente | Cofre | Quem alcança |
|---|---|---|
| Produção | Variáveis de ambiente do projeto na Vercel (escopo *Production*) | Quem tem acesso de administrador ao projeto Vercel |
| Preview/dev na Vercel | Variáveis de ambiente, escopo *Preview* | idem |
| Máquina de desenvolvimento | `.env` local, **fora do git** (`.gitignore`) | O desenvolvedor |
| CI (GitHub Actions) | Segredo `CRON_SECRET` + variável `APP_BASE_URL` | Administradores do repositório |
| Escrow | **A definir — ver §7** | — |

O job de CI que roda migrations e pgTAP **não recebe nenhum destes segredos**, e a suíte Playwright do CI roda sem `.env` de propósito (achado TST-01): o que ela exercita são páginas não autenticadas, e uma build de produção com zero variáveis é exatamente o caso que vale provar lá.

---

## 3. Quem usa o quê

| Segredo | Consumidor no código |
|---|---|
| `CPF_HASH_PEPPER`, `CPF_ENCRYPTION_KEY` | `src/lib/crypto/cpf-secrets.ts` |
| `WORKER_TOKEN_PEPPER` | `src/lib/crypto/worker-token.ts` |
| `API_KEY_PEPPER` | `src/lib/crypto/api-key.ts` |
| `WEBHOOK_SECRET_KEY` | `src/lib/crypto/webhook-secret.ts` |
| `CRON_SECRET` | `src/app/api/internal/webhook-runner/route.ts`, `.../maintenance/route.ts` |
| `SUPABASE_SECRET_KEY` | `src/lib/supabase/machine-client.ts` |

**Regra que vale para os cinco irrecuperáveis:** todo ambiente que aponta para o **mesmo projeto Supabase** tem de usar o **mesmo valor**. Valores diferentes contra o mesmo banco produzem falhas silenciosas — links que não resolvem, chaves que não autenticam, CPFs que não conferem — e nenhuma delas se parece com "a variável está errada".

---

## 4. Acesso

- Concessão: mesma lista de quem administra o projeto na Vercel. Não há outra cópia autorizada.
- Ninguém precisa ler um valor para operar o sistema. Ler um valor é sempre exceção, com motivo.
- Um segredo **nunca** é enviado por chat, e-mail ou ticket. Quem precisa, recebe acesso ao cofre.
- Nenhum destes valores pode aparecer num log. `src/lib/observability/report.ts` recusa qualquer valor que não seja identificador, código curto ou número, justamente para que um erro de programação não vire vazamento.

---

## 5. Rotação

| Segredo | Pode rotacionar? | Procedimento |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Sim, sem impacto | Emitir nova no dashboard, atualizar na Vercel, redeploy, revogar a antiga |
| `CRON_SECRET` | Sim, com janela | Gerar novo, atualizar na Vercel **e** no segredo do GitHub, redeploy. Entre os dois, o job falha; ele é idempotente e recupera na execução seguinte |
| `WEBHOOK_SECRET_KEY` | Sim, **com migração de dados** | Os segredos de endpoint estão cifrados com ela. Rotacionar exige decifrar com a chave antiga e recifrar com a nova, em migration própria. Trocar sem isso quebra toda assinatura de webhook |
| `API_KEY_PEPPER` | Sim, **invalidando tudo** | Não há como recalcular o hash sem o segredo original da chave (que ninguém tem). Rotacionar = revogar todas as chaves e emitir novas com os clientes |
| `WORKER_TOKEN_PEPPER` | Sim, **invalidando pendentes** | Links pendentes deixam de resolver. Reenviar os links das entregas ainda não confirmadas (`api.resend_batch_pending` existe para isso) |
| `CPF_HASH_PEPPER` | **Não, na prática** | Só é possível se todos os CPFs puderem ser re-derivados dos `cpf_enc` com a chave de cifra: decifrar, re-hashear com o pepper novo, gravar — numa migration, com o banco fora de uso. Nunca foi executado |
| `CPF_ENCRYPTION_KEY` | **Não, na prática** | Mesma restrição, na direção oposta: decifrar tudo com a chave antiga e recifrar. Se ela já se perdeu, não há caminho |

**Rotação programada não é recomendada para os dois de CPF.** O risco da operação é maior que o risco que ela reduz. Rotacione-os apenas em resposta a comprometimento confirmado (§8).

---

## 6. Revogação

- **`SUPABASE_SECRET_KEY`:** revogar no dashboard revoga imediatamente. Faça isto primeiro em qualquer suspeita.
- **`CRON_SECRET`:** trocar o valor revoga o anterior na prática, já que as rotas comparam com `timingSafeEqual` e **falham fechadas** quando não há segredo configurado.
- **Chaves de API de cliente:** `api.revoke_api_key` — não exige tocar em nenhum segredo de plataforma.
- **Endpoints de webhook:** `api.set_webhook_endpoint_status` para `REVOKED`; as entregas pendentes são liquidadas (migration `20260908001000`).
- **Os peppers não têm revogação.** Só substituição, com as consequências da §5.

---

## 7. Escrow e recuperação — **PENDENTE, e é o item que trava o GO**

Hoje os cinco irrecuperáveis existem em **dois lugares**: a Vercel e o `.env` de quem os gerou. Não há terceira cópia, nem procedimento se ambas se perderem.

Antes do primeiro cliente real:

1. [ ] Escolher o cofre de escrow (gerenciador de senhas da empresa com item compartilhado, ou envelope físico em cofre — a decisão é organizacional, não técnica).
2. [ ] Depositar os **cinco** irrecuperáveis, cada um identificado por nome de variável, ambiente e data de criação — **nunca** junto de um dump ou de credencial de banco.
3. [ ] Nomear duas pessoas com acesso. Uma só é ponto único de falha; três ou mais aumentam a superfície sem ganho.
4. [ ] Registrar a data. Um escrow sem data não diz se está desatualizado depois de uma rotação.
5. [ ] Testar a leitura uma vez, por alguém que não depositou.

**Recuperação:** repor o valor na variável de ambiente da Vercel e fazer redeploy. Não há migração de dados — o valor certo simplesmente volta a funcionar. Se o valor certo não existir em lugar nenhum, veja a coluna "Se for perdido" da §1: essa é a consequência definitiva.

---

## 8. Resposta a comprometimento

**Primeiro, sempre:** determinar QUAL segredo e qual ambiente. A resposta é diferente para cada um.

1. **`SUPABASE_SECRET_KEY`** — revogar no dashboard, emitir nova, atualizar, redeploy. Depois: revisar `audit.audit_events` do período e as contas em `auth.users` procurando criação ou alteração não reconhecida. Não há acesso a dado de tenant por esta chave, mas há controlo sobre contas.
2. **`CRON_SECRET`** — trocar. Verificar `hooks.deliveries` procurando execuções não esperadas.
3. **`WEBHOOK_SECRET_KEY`** — assumir que assinaturas podem ter sido forjadas para os endpoints dos clientes. Rotacionar com migração (§5), girar o segredo de cada endpoint (`api.rotate_webhook_secret`), e **avisar os clientes afetados**: eles confiaram numa assinatura que pode não ter sido nossa.
4. **`API_KEY_PEPPER`** — revogar todas as chaves, emitir novas com cada cliente.
5. **`WORKER_TOKEN_PEPPER`** — reemitir os links pendentes.
6. **`CPF_HASH_PEPPER` ou `CPF_ENCRYPTION_KEY`** — este é o caso grave. Se o vazamento coincidir com acesso a um dump do banco, presuma **exposição de CPF de todos os funcionários de todos os tenants**. Isto é incidente de dado pessoal sob a LGPD: aciona notificação à ANPD e aos titulares, com prazo. A decisão é jurídica, não de engenharia — escale imediatamente e preserve os logs antes de qualquer rotação.

Em todos os casos, registre o que foi feito e quando. O `audit.audit_events` de cada tenant é encadeado por hash e é a melhor prova disponível de que o histórico não foi alterado durante o incidente.

---

## 9. Checklist antes do primeiro cliente

- [ ] Os nove valores definidos em produção, **distintos** dos de desenvolvimento.
- [ ] `DEV_PROBE_KEY` e `RESEND_API_KEY` **não** definidos (não têm consumidor).
- [ ] Escrow feito, com duas pessoas e data (§7).
- [ ] Confirmado que nenhum `.env` está versionado (`git ls-files | grep -c '^\.env$'` deve devolver 0).
- [ ] Confirmado que produção e qualquer preview que aponte para o **mesmo** projeto Supabase usam os **mesmos** cinco valores irrecuperáveis.
