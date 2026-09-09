# ADR 0002: Identidade biométrica (AL2) — auditoria da arquitetura e parada por blocker

**Status:** Parado em blocker, antes de qualquer alteração de código. **Data:** 2026-09-09. **Fase:** I (Open Source Biometric Identity).

## Contexto

A Fase I autorizou adicionar reconhecimento facial + prova de vida usando apenas componentes gratuitos/open-source, com orçamento de API em R$0, preservando o fluxo AL1 como fallback. A ordem imposta foi explícita: **auditar antes de mexer em código (I-A), provar em spike isolado (I-B/I-C), e só então integrar (I-G em diante)**. A fase também trouxe uma regra de parada com cinco condições.

Este ADR registra o resultado de I-A e a parada. **Nenhuma migration foi criada. Nenhum código de produção foi alterado.**

---

## I-A.1 — O que já existe

### A abstração de provider

`src/lib/identity/provider.ts` define `IdentityVerificationProvider`: uma interface com `assuranceLevel` e um único `check(input): Promise<IdentityCheckResult>`. O domínio (`epi_deliveries`, `confirmation_requests`) **nunca importa um SDK de fornecedor** — só esta interface e o resultado cruzam para `worker.finish_confirmation`.

`src/lib/identity/registry.ts` seleciona o provider pelo `required_assurance_level` do `confirmation_request`. AL2–AL4 **lançam exceção explícita** hoje. Trocar quem atende um nível não exige tocar no domínio: só o registry e um arquivo de adaptador.

Implementados: `LinkOnlyProvider` (AL0) e `LinkKnowledgeProvider` (AL1). Ambos satisfazem uma suíte de contrato compartilhada (`provider.contract.ts`).

### Níveis de garantia

`app.assurance_level` é um enum **ordenado** — `AL0_LINK_ONLY`, `AL1_LINK_KNOWLEDGE`, `AL2_SELFIE_LIVENESS`, `AL3_FACE_MATCH_ENROLLED`, `AL4_GOV_VERIFIED` — declarado nessa ordem de propósito, para que `achieved >= required` funcione como comparação nativa.

`app.organizations.default_assurance_level` tem default `AL1_LINK_KNOWLEDGE`.

### A proteção contra downgrade **já existe**

`app.confirmation_requests` carrega:

```sql
constraint achieved_ge_required_ck
  check (status <> 'CONFIRMED' or achieved_assurance_level >= required_assurance_level)
```

Isto é exatamente o "não permitir downgrade silencioso de AL2 para AL1" que a etapa I-G pede, e está no banco desde a FASE 3. Uma confirmação que exigia AL2 **não pode** ser gravada como CONFIRMED tendo alcançado AL1. Nenhum código novo precisa reimplementar essa regra — precisa apenas não contorná-la.

### Fluxo do trabalhador

`/e/<token>` → hash HMAC-SHA256 com `WORKER_TOKEN_PEPPER` → cookie HttpOnly → redirect 303 para `/e/s/<confirmation_request_id>`. O token cru nunca chega ao Postgres. Três RPCs `anon`: `worker.open_link`, `worker.begin_confirmation`, `worker.finish_confirmation` (mais `get_evidence_source` e `verify_document`).

Rate limiting real, já verificado: `app.check_rate_limit` é chamada nas três — 20 por 5 min por token, 60 por 5 min por IP — mais `identity_max_attempts` (padrão 5) por organização.

### Selagem de evidência

`worker.finish_confirmation` recebe o payload canônico já construído em Node (`epi-canon/1`), e `app.seal_evidence` grava `evidence.evidence_versions` + `evidence.documents` na mesma transação. As três tabelas de evidência/auditoria são append-only com trigger que recusa `UPDATE`/`DELETE` **até para o dono** (suíte 250).

### Trilha de auditoria

`audit.audit_events`, encadeada por hash por organização, sem grant para papel nenhum. `actor_kind` já aceita `USER`, `WORKER`, `SYSTEM`, `PROVIDER`, `PLATFORM` — **`PROVIDER` já existe e nunca foi usado**; é o valor certo para um evento originado por um serviço biométrico.

### Tabelas de identidade

`app.identity_profiles` — `(organization_id, company_id, employee_id, provider, provider_subject_id)`, com FK composta que prende o funcionário à empresa, e único por `(employee_id, provider)`.

`app.identity_verifications` — uma linha por fator, com `provider`, `method`, `result`, `achieved_assurance_level`, `match_score` (texto numérico), **`image_sha256`** e `factor_type`.

**O `image_sha256` merece destaque:** a coluna existe desde a FASE 3 e antecipa exatamente a política que a etapa I-F pediria — provar que uma imagem específica foi apresentada **sem armazenar a imagem**.

---

## I-A.2 — O que o produto **não** armazena hoje

Verificado por varredura de catálogo (`scripts/security-audit.mjs`), não por leitura:

- **Nenhum template ou embedding biométrico** em nenhuma tabela.
- **Nenhuma imagem, selfie ou blob** de face. `evidence.evidence_versions.canonical_bytes` guarda os bytes canônicos do payload, que é JSON.
- **Supabase Storage não é usado em lugar nenhum** — nenhum bucket, nenhuma policy em `storage.objects`.
- CPF existe apenas como `cpf_hash` (HMAC com pepper), `cpf_enc` (AES-256-GCM) e `cpf_masked`. Nunca em claro.

Ou seja: **a superfície biométrica atual é zero.** Qualquer coisa que a Fase I adicionasse seria a primeira.

---

## I-A.3 — Onde AL2 entraria, e o que o schema realmente exigiria

Se e quando os spikes forem possíveis, estas são as mudanças **mínimas** — nomeadas agora para que ninguém as descubra no meio da implementação:

1. **`app.identity_verifications.provider` está travado.**
   `check (provider in ('INTERNAL'))` (migration `20260904100000`). Qualquer provider externo exige alargar esse CHECK. Uma migration aditiva, mas obrigatória.

2. **`factor_type` não tem valor biométrico.**
   Hoje: `IDENTITY_KNOWLEDGE`, `IDENTITY_OTP`, `IDENTITY_PRESENCIAL`, `DECLARATION_SIGNATURE`. Faltam algo como `IDENTITY_LIVENESS` e `IDENTITY_FACE_MATCH`. A migration da FASE E deliberadamente recusa (`0A000 unsupported_factor_type`) qualquer tipo não implementado — o que é a proteção certa e é também a razão de a mudança ser obrigatória.

3. **`result` só tem `PASS`/`FAIL`.**
   A etapa I-J exige distinguir `FAILED` de `PROVIDER_ERROR`, e I-G exige `INCONCLUSIVE`. São três estados novos num CHECK existente. **Isto é o item de schema mais importante da fase:** sem ele, um serviço fora do ar seria gravado como reprovação do trabalhador — uma acusação falsa, selada em evidência imutável.

4. **`app.identity_profiles` não suporta o modelo de enrollment pedido em I-E.**
   Faltam: `enrollment_source` (`SELF_ENROLLED` / `EMPLOYER_VERIFIED` / `PRESENTIAL_EMPLOYER_VERIFIED` / `EXTERNAL_IDENTITY_VERIFIED`), `enrolled_by`, `status`, `revoked_at`, versão/substituição, e versão do modelo do provedor. O único índice hoje é `unique (employee_id, provider)`, que **impede** ter uma referência revogada e uma ativa ao mesmo tempo — precisaria virar índice parcial `where revoked_at is null`, o mesmo padrão já usado em `authz.memberships`.

5. **`match_score` é `text` com regex numérica.** Serve; o threshold usado precisa ser gravado junto, e não há coluna para ele.

**Nada disso exige alterar o pipeline de evidência.** O payload canônico é construído em Node a partir de `worker.get_evidence_source`, e os fatores já são uma lista extensível — foi assim que a FASE E adicionou assinatura sem tocar em `epi-canon/1`. Isso responde negativamente à quarta condição de parada ("arquitetura atual exige alteração profunda da evidence pipeline"): **não exige**.

---

## Decisão

**Parar a Fase I na fronteira entre I-A e I-B, e não escrever migration, provider ou serviço.**

Duas condições de parada da própria fase foram atingidas, e uma terceira impede a execução:

### 1. Licença — os pesos não permitem uso comercial (`docs/biometric-licenses.md`)

CompreFace é Apache-2.0, mas usa modelos InsightFace, cujo repositório separa explicitamente as duas licenças: código MIT com uso comercial livre, e **pesos "available for non-commercial research purposes only"**. Selo é um produto comercial. Isso é a primeira condição de parada, literal: *"modelo não permite uso comercial"*.

O liveness escolhido (MiniFASNet / Silent-Face-Anti-Spoofing) está sob Apache-2.0 **sem declaração sobre os pesos**, e o modelo de alta precisão é assumidamente fechado. Pela regra da fase — *"qualquer ambiguidade de licença comercial deve virar blocker"* — também bloqueia.

Antecipei I-N para antes dos spikes exatamente porque uma restrição de licença invalida todo o trabalho posterior.

### 2. Ambiente — os spikes não são executáveis nesta máquina

Verificado, não presumido: `docker` não está no PATH, Docker Desktop não está instalado, e o WSL não está instalado (*"O Subsistema Windows para Linux não está instalado"*). É consistente com a decisão registrada em `feedback-epi-no-docker`, que é a razão de o CI ser o gate autoritativo deste repositório.

CompreFace e o serviço de liveness são, por definição desta fase, self-hosted em Docker. **Sem Docker, I-B e I-C não podem ser executados** — e a fase proíbe integrar antes de prová-los.

### 3. Ataques de apresentação exigem mundo físico

I-C e I-L pedem foto impressa, face exibida em tela de celular, e replay de vídeo — diante de uma câmera, com uma pessoa. **Nenhuma configuração de máquina me permite executar isso.** Um resultado inventado aqui seria exatamente o "PASS narrativo" que a fase proíbe.

---

## Consequências

- Nenhuma dependência nova. Nenhuma migration. Nenhum container. `IdentityVerificationProvider` segue com AL2–AL4 lançando exceção, que continua sendo a representação honesta.
- O AL1 permanece intocado — é o que `docs/pilot-readiness.md` mede como pronto para piloto.
- A auditoria I-A acima **não se perde**: quando (e se) o blocker de licença for resolvido, as cinco mudanças de schema da §I-A.3 já estão nomeadas, e a boa notícia é que o pipeline de evidência não precisa mudar.
- `docs/biometric-licenses.md` §6 lista as opções com o custo real de cada uma. Nenhuma API paga foi introduzida sub-repticiamente — a fase proibiu, e substituir tecnologia em silêncio seria pior que parar.

## O que faria esta decisão ser revista

1. Um modelo de reconhecimento com licença **comercial explícita para os pesos**, compatível com a interface de calculator do CompreFace.
2. Uma declaração de licença dos pesos do liveness, ou um modelo alternativo com licença limpa.
3. Docker disponível numa máquina de desenvolvimento ou num runner, mais uma pessoa capaz de executar os testes de apresentação física.

Os três são necessários. Um sozinho não destrava a fase.
