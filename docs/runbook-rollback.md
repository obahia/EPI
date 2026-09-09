# Runbook — Rollback e recuperação

Escrito para o PILOT READINESS (P1-6). O que ele resolve: o rollback da Vercel reverte a aplicação e **não desfaz uma migration**. Com um cliente real ativo, uma migration ruim não tinha caminho de volta ensaiado.

**A regra que governa tudo abaixo:** as migrations deste projeto são **append-only por decisão** (`docs/architecture.md`, disciplina mantida desde a FASE 0). Não existe migration de volta, e não vai existir. Portanto **forward fix é o caminho padrão** e reverter o banco é a exceção cara.

---

## 1. Decidir depressa: o que exatamente quebrou?

| Sintoma | Camada | Vá para |
|---|---|---|
| A aplicação não carrega, ou uma tela quebrou depois de um deploy | Aplicação | §2 |
| Uma RPC devolve erro em toda chamada; a tela renderiza vazia | Banco (schema) | §3 |
| Dados errados foram gravados (importação, lote, atualização em massa) | Dados | §4 |
| Um comprovante não confere, ou a cadeia de auditoria não fecha | Evidência | §5 |
| Suspeita de acesso indevido | Segurança | `docs/runbook-secrets.md` §8 |

**Antes de qualquer ação:** anote a hora UTC de início do problema. Toda opção de recuperação abaixo depende de saber o instante para onde voltar.

---

## 2. Aplicação

**Rollback é instantâneo e seguro.** Vercel → Deployments → o deployment anterior conhecido como bom → *Promote to Production*.

Isto reverte código, e **nada mais**. Não reverte migration, não reverte dado, não reverte variável de ambiente.

Cuidado que importa: se o deploy ruim veio acompanhado de uma migration, voltar só o código deixa uma aplicação antiga contra um schema novo. Como as migrations são aditivas (nova coluna, nova função, novo trigger), a aplicação antiga normalmente continua funcionando — ela simplesmente ignora o que não conhece. **A exceção é uma migration que aperta uma regra** (um `CHECK` novo, um `NOT NULL`, um trigger que passa a recusar): aí o código antigo pode começar a falhar. Nesse caso vá para §3.

---

## 3. Banco (schema)

**Forward fix é o padrão.** Escreva uma migration nova que corrija, aplique, faça deploy. É o mesmo mecanismo que já entregou 70 migrations e é o único caminho testado pelo CI, que aplica tudo do zero a cada PR.

Ordem:

1. Reproduza localmente: `npm run db:check:local` aplica todas as migrations do zero em segundos.
2. Escreva a correção como **nova** migration. **Nunca edite uma migration já aplicada** — o registro em `supabase_migrations.schema_migrations` faria o CLI pular a versão corrigida, e o schema de produção divergiria do repositório para sempre.
3. Rode `node scripts/security-audit.mjs` e `node scripts/check-pgtap-lint.mjs`.
4. Deixe o CI verde (`supabase db reset` + pgTAP + concorrência real).
5. Aplique em produção. Deploy.

**Quando o forward fix não serve:** a migration ruim destruiu ou reescreveu dados (um `UPDATE` numa migration, uma coluna removida). Aí o schema não é o problema — os dados são. Vá para §4.

**Reverter um objeto isolado** (um trigger recém-criado que recusa algo legítimo, uma função quebrada) é uma migration nova com `drop trigger` / `create or replace function`. Continua sendo forward fix; só o efeito é de reversão.

---

## 4. Dados

Aqui a resposta depende inteiramente de uma coisa que **precisa estar confirmada antes do piloto**: se o projeto Supabase tem PITR ativo. Ver `docs/pilot-readiness.md` P1-2 — no momento em que este runbook foi escrito, isso **não estava verificado**.

### 4.1 Com PITR

1. **Nunca restaure sobre o projeto de produção.** Restaure para um projeto novo, no instante anterior ao incidente.
2. Compare. Identifique exatamente as linhas afetadas.
3. Traga de volta **só o que precisa**, com um script revisado, contra produção. Uma restauração completa por cima desfaz também tudo o que aconteceu de legítimo desde o incidente — inclusive confirmações de trabalhadores, que são prova.
4. Registre o que foi alterado e por quê.

### 4.2 Sem PITR, só backup diário

A perda máxima é de até 24 horas. Mesma regra: restaurar para um projeto separado e trazer as linhas de volta seletivamente.

### 4.3 O que NÃO se recupera de um backup

- **`CPF_HASH_PEPPER` e `CPF_ENCRYPTION_KEY`** nunca estiveram no banco. Um restore sem o pepper certo produz um banco onde nenhum CPF confere. Ver `docs/runbook-secrets.md`.
- **Links de confirmação pendentes** dependem de `WORKER_TOKEN_PEPPER`, também fora do banco.

---

## 5. Evidência e comprovantes

**Não há rollback de evidência, por desenho.** `evidence.evidence_versions`, `evidence.documents` e `audit.audit_events` são append-only com trigger que recusa `UPDATE` e `DELETE` **até para o dono da tabela** (suíte `250_evidence_document_immutability.sql`). Isso é a propriedade que o produto vende: um comprovante emitido não pode ser silenciosamente reapontado para outra evidência.

Consequências práticas:

- **Uma entrega confirmada por engano não se apaga.** O caminho é `api.create_replacement_delivery` — uma entrega nova que corrige a anterior e a marca `SUPERSEDED`, deixando as duas na história. É assim que se corrige sem destruir prova.
- **Uma cadeia de auditoria que não fecha é incidente, não bug de dado.** Cada evento carrega `prev_hash`; percorrer a cadeia mostra onde ela quebra. Uma quebra significa escrita fora de `app.log_audit_event`, o que só é possível com acesso de dono. Trate como §"resposta a comprometimento" do runbook de segredos e **preserve o estado antes de mexer**.
- Se um restore for inevitável, restaurar `evidence.*` para um instante anterior **remove comprovantes que já foram entregues a trabalhadores**. Um QR impresso deixa de resolver. Isso é dano ao cliente, não só à base — decida com quem responde pelo contrato.

---

## 6. Incidentes: sequência

1. **Estancar.** Rollback da aplicação (§2) se o deploy foi a causa. É reversível e barato.
2. **Preservar.** Anote horários; não apague nada; não rotacione segredo antes de registrar (rotacionar pode apagar o rastro de como foi usado).
3. **Delimitar.** Um tenant ou todos? Use `api.company_audit_events` do tenant afetado — é o registro encadeado e é a melhor prova disponível.
4. **Corrigir.** §3 para schema, §4 para dados.
5. **Comunicar.** Se dado pessoal foi exposto, a decisão de notificar ANPD e titulares é **jurídica** e tem prazo. Escale; não decida na engenharia.
6. **Registrar.** O que quebrou, o que se fez, e o que muda para não repetir.

---

## 7. Alerta — **PENDENTE, decisão sua**

`src/lib/observability/report.ts` emite um evento JSON por falha crítica, com id de correlação e sem PII (redação testada em `report.test.ts`). Os eventos vão para stderr e o host coleta.

**O que falta é o sino.** Nada hoje avisa um humano. As opções, com o custo real:

| Opção | Custo | O que dá | O que não dá |
|---|---|---|---|
| **Vercel Runtime Logs** (já existe) | grátis | Consultar depois de suspeitar | Não avisa ninguém; retenção curta no plano Hobby |
| **Vercel Log Drain → destino** | exige plano **Pro** | Encaminha tudo para um destino de log | Precisa do destino também |
| **Sentry** (free tier) | grátis até um volume; **conta externa** | Captura de exceção, agrupamento, alerta por e-mail | Dado sai para terceiro — avaliar sob LGPD antes, mesmo com a redação em vigor |
| **Poll por GitHub Actions** | grátis | Um job periódico consultando um endpoint de saúde, como o runner de webhooks já faz | Só cobre o que um endpoint souber contar; hoje nada persiste contagem de erro |

**Nenhuma foi integrada.** Todas exigem plano pago ou credencial externa, e a instrução foi parar antes disso e apresentar as opções. A recomendação, se me perguntarem: Sentry no free tier é o menor esforço para o maior ganho, **desde que** se registre a decisão de enviar telemetria a terceiro — a redação já garante que nenhum CPF, nome, token ou payload sai, mas ids de tenant saem, e isso é uma decisão de contrato.

---

## 8. Ensaios que ainda não foram feitos

Honestidade sobre o que este runbook descreve mas ninguém executou:

- [ ] Restaurar um backup para um projeto isolado e cronometrar (P1-2).
- [ ] Um forward fix ensaiado com um cliente ativo.
- [ ] Um rollback de aplicação em produção.

Um procedimento nunca executado é uma hipótese. Os três acima devem sair do papel antes ou durante a primeira semana do piloto.
