# Spike biométrico — resultado

**Data:** 2026-09-09. **Escopo:** provar tecnicamente SFace 1:1 + ACTIVE_LIVENESS_BASIC, isolado do produto.
**Recomendação: CONDITIONAL GO.**

Nada foi integrado. Sem migration, sem alteração no pipeline de evidência, sem tocar no fluxo de confirmação, sem provider no domínio, AL1 intacto. O spike vive em `spikes/biometric/`, com `package.json` próprio, em `.mjs` — o `tsconfig` do produto inclui `**/*.ts` e `**/*.mts`, então não enxerga estes arquivos.

---

## 1. Ambiente — sem Docker e sem Python

A máquina não tem Docker, Docker Desktop nem WSL (verificado antes). Também **não tem Python** (`python`/`py` ausentes). Não instalei nenhum dos dois.

O spike roda em **Node + `onnxruntime-node` 1.29.0**, que executa ONNX com binários pré-compilados, sem Python e sem container. Isso é melhor que a alternativa sugerida: mantém o spike no toolchain do próprio repositório e remove Docker do caminho crítico. **Docker não é requisito técnico para SFace.**

Reprodução:

```
cd spikes/biometric && npm install && node fetch-models.mjs
node run-sface-bench.mjs
node run-liveness-attacks.mjs
```

Os pesos não estão no git (36,9 MB); `fetch-models.mjs` os busca e registra a licença de cada um.

---

## 2. Face Verification — **PARTIAL**

### Medido, números reais

| | |
|---|---|
| Modelo | `face_recognition_sface_2021dec.onnx`, 36,9 MB, Apache-2.0 |
| Carrega sob `onnxruntime-node` | **sim**, sem Python, sem Docker |
| Entrada / saída | `data` → `fc1` |
| **Dimensão do embedding** | **128** |
| Cold start (carregar o modelo) | **227 ms** |
| RSS ao carregar | **+60,7 MB** |
| **Latência p50** | **9,3 ms** |
| Latência p95 / p99 | 10,2 ms / 10,4 ms |
| min / max | 6,9 / 10,4 ms |
| **Verificação 1:1 completa** | **≈19 ms** (duas inferências) |
| Com referência pré-computada | **≈9 ms** por confirmação |
| Determinismo | **SIM** — mesma entrada dá embedding idêntico bit a bit, `cos(self) = 1.000000` |
| RSS final do processo | 136,6 MB |

O determinismo importa mais do que parece: uma referência guardada hoje tem de continuar comparável daqui a meses. Um modelo não determinístico tornaria o enrollment inútil.

### Não medido — **BLOCKED_BY_ENVIRONMENT**

**Genuine accepts e impostor rejects não foram medidos, e nenhum threshold é proposto.**

Motivo, dito sem rodeio: acurácia exige pares de faces reais — a mesma pessoa duas vezes e duas pessoas diferentes. Não há dataset facial com licença adequada disponível, não há câmera nesta máquina e não há sujeito autorizado. Rodar o modelo em fotos de pessoas identificáveis baixadas da internet seria processar biometria de terceiros sem consentimento para provar um ponto sobre um produto que não lançou.

O `cos` entre duas entradas sintéticas distintas deu 0,8478. **Isso não é sinal de acurácia** — entradas sintéticas não são faces, e o número está no relatório apenas para mostrar que o espaço de saída se comporta como métrica.

O 99,40% que o README do SFace publica é afirmação do publicador, **não medição minha**.

**Portanto: PARTIAL.** O pipeline funciona, é rápido e é determinístico. A pergunta "o face match funciona suficientemente bem?" continua sem resposta e só um conjunto de faces autorizado responde.

---

## 3. Active Liveness — **PARTIAL**

### Ataques de protocolo — 14 executados, 14 bloqueados

| # | Ataque | Resultado | Sinal |
|---|---|---|---|
| CTRL | submissão bem formada | **PASSA** (controle) | — |
| A07 | replay da mesma sessão | **BLOQUEADO** | `challenge_already_consumed` |
| A08 | replay dos frames numa sessão nova | **BLOQUEADO** | `frame_predates_challenge` |
| A09 | `challenge_id` alterado | **BLOQUEADO** | `challenge_id_mismatch` |
| A10 | ações na ordem errada | **BLOQUEADO** | `primitive_not_satisfied` |
| A11 | uma ação omitida | **BLOQUEADO** | `primitive_not_satisfied` |
| A12 | nonce repetido | **BLOQUEADO** | `nonce_replayed` |
| A13 | sessão expirada | **BLOQUEADO** | `EXPIRED` |
| A14 | reaproveitar um PASS anterior | **BLOQUEADO** | `challenge_already_consumed` |
| A06b | challenge de um funcionário usado para outro | **BLOQUEADO** | `subject_mismatch` |
| A04b | mesmo frame repetido (imagem estática) | **BLOQUEADO** | `duplicate_frames` |
| A05b | um frame único satisfazendo uma primitiva | **BLOQUEADO** | exige estabilidade temporal |
| A05c | frames gravados antes do challenge | **BLOQUEADO** | `frame_predates_challenge` |
| ERR | falha do provedor | **`PROVIDER_ERROR`**, nunca `FAILED` | — |

O controle existe porque um arnês em que tudo falha não prova nada.

### Ataques físicos — **BLOCKED_BY_ENVIRONMENT**

Foto impressa, foto noutro celular, screenshot, vídeo gravado, pessoa real, pessoa diferente: **não executados**. Sem câmera, sem impressora, sem segundo aparelho, sem sujeitos autorizados. Nenhum resultado inventado.

**Isto é o que impede PASS.** O desenho ataca essas fraudes — exigência de piscar, giro sustentado, mudança de escala, frames distintos — mas **desenho não é evidência**.

### Um bug real, encontrado pelo próprio arnês

A primeira execução deixou dois ataques passarem. Causa: o cursor avançava pelo **tamanho da corrida** de frames, não pelo **índice onde a primitiva foi satisfeita**, deixando frames já consumidos disponíveis para a primitiva seguinte. Isso enfraquecia a exigência de ordem — exatamente a propriedade que sustenta A10 e A11. Corrigido; os 14 passam.

Vale registrar: o bug estava no protocolo, não no teste, e só apareceu porque o arnês incluía um controle e ataques de ordenação.

### Thresholds — provisórios

`yaw ≥ 20°`, `≥ 5 frames consecutivos` **e** `≥ 300 ms`, piscar como transição fechado→aberto (`≤ 0,18` depois `≥ 0,25`), escala `±15%`, TTL de sessão 60 s. **Todos são chute informado** até serem medidos contra rostos reais.

---

## 4. Trust model server-side — **PASS**

Esta era a pergunta 4, e é a única que o ambiente permitiu responder por inteiro.

O verificador aceita **apenas** estado que o servidor gerou: `challengeId`, `nonce`, sequência, janela temporal, `subjectId`. Um `liveness=true` vindo do navegador não tem onde entrar — não existe campo para ele. O frame que irá para o face match é escolhido **pelo servidor**, entre os que passaram, e não pelo cliente; caso contrário o liveness provaria uma imagem e a comparação rodaria noutra.

### Abordagem A vs B

| | **A — frames ao servidor** | **B — landmarks + checkpoints** |
|---|---|---|
| Segurança | Servidor re-deriva tudo | Série temporal é fácil de sintetizar sem câmera |
| CPU do servidor | Alta (extração por frame) | Baixa |
| Rede | Alta | Baixa |
| Privacidade | Pior: frames chegam ao servidor | Melhor |
| Complexidade | Maior | Menor |

**Recomendo A.** B é mais barato em tudo, e inútil no que importa: se o servidor confia na série de landmarks, um atacante gera uma série plausível num editor de texto, sem câmera nenhuma. B só se torna defensável quando os checkpoints são frames de verdade re-analisados — e aí já é A com menos frames.

Mitigação de privacidade para A: descartar os frames após a decisão e guardar apenas `image_sha256` — coluna que `app.identity_verifications` **já tem** desde a FASE 3.

---

## 5. Licença — **CLEAN** para o que foi executado

Só um artefato de terceiros foi usado: o ONNX do SFace, sob a concessão Apache-2.0 do `LICENSE` do próprio diretório, que o README declara cobrir todos os arquivos ali. Detalhe em `docs/biometric-licenses.md` §17.

**Nenhum detector foi usado neste spike.** Não rodei YuNet: a incerteza WIDER Face continua registrada e não quis que uma execução transformasse o detector em decisão de produção pela porta dos fundos. **A escolha do detector segue em aberto.**

MediaPipe também não foi usado — o liveness aqui foi exercitado no nível do protocolo, que é agnóstico a quem extrai os landmarks.

---

## 6. Performance

| | |
|---|---|
| SFace, inferência | p50 9,3 ms / p95 10,2 ms (CPU x64) |
| SFace, cold start | 227 ms |
| Memória, modelo carregado | +60,7 MB; processo 136,6 MB |
| Verificação 1:1 | ≈19 ms, ou ≈9 ms com referência guardada |
| Verificação de protocolo do liveness | abaixo de 1 ms; é aritmética sobre uma lista |

**A latência não é problema.** O custo real será a extração de landmarks por frame no servidor (abordagem A), **que não foi medida** — não há implementação server-side de landmarks neste spike.

---

## 7. Blockers

### P0 — impedem GO FOR AL2 INTEGRATION

1. **Ataques de apresentação nunca executados.** Foto, tela e replay físico são exatamente o que este mecanismo promete bloquear, e nenhum foi testado. Exige câmera, impressora, segundo aparelho e uma pessoa.
2. **Acurácia do face match não medida.** Sem dataset autorizado, não se sabe se a mesma pessoa é aceita nem se outra é rejeitada — e sem isso não há threshold.

### P1

3. **Extração de landmarks server-side não implementada nem medida.** A abordagem A depende dela, e o custo de CPU por confirmação é desconhecido.
4. **Detector não escolhido.** YuNet carrega a tensão WIDER Face; nenhuma alternativa foi validada.
5. **Thresholds provisórios**, sem base empírica.

### P2

6. Deepfake em tempo real e injeção de câmera virtual continuam fora do alcance deste desenho — declarado, não resolvido.
7. Não há métrica de qualidade de imagem (foco, iluminação, oclusão) antes do match.

---

## 8. Critério de saída

| Condição para GO | Estado |
|---|---|
| face match funciona em 1:1 | **NÃO VERIFICADO** — pipeline sim, acurácia não |
| pessoa diferente é rejeitada | **NÃO VERIFICADO** |
| foto estática não passa no liveness | **NÃO VERIFICADO** (desenhado para bloquear) |
| tela estática não passa | **NÃO VERIFICADO** |
| replay simples não passa | **VERIFICADO** — A07, A08, A14 |
| challenge não reutilizável | **VERIFICADO** — A12, A14 |
| decisão final não é do cliente | **VERIFICADO** |
| licença sem blocker explícito | **VERIFICADO** para o SFace |

Quatro das oito verificadas. As quatro que faltam dependem todas da mesma coisa: uma câmera, uma pessoa e uma impressora.

---

## 9. Recomendação

# CONDITIONAL GO

**Não integrar ao AL2 ainda**, porque quatro das oito condições de saída não foram verificadas — e não por terem falhado, mas por não terem sido testáveis aqui.

O que o spike estabeleceu, e é substancial:

- **SFace roda sem Docker e sem Python**, em 9,3 ms p50, determinístico, com licença limpa. Docker deixa de ser requisito.
- **O modelo de confiança server-side funciona.** Catorze ataques de protocolo, todos bloqueados, com controle. Era a pergunta arquitetural de maior risco e está respondida.
- **A abordagem A é a única defensável**, com o custo em privacidade e CPU declarado.
- **Um bug real de protocolo foi encontrado e corrigido** antes de existir produto em cima dele.

**Condição para converter em GO:** uma sessão de testes presenciais com câmera, impressora, um segundo aparelho e pelo menos duas pessoas que consintam por escrito. Meia hora de trabalho de alguém com hardware. Nessa sessão: os seis ataques físicos, e pares genuine/impostor suficientes para derivar um threshold inicial.

Até lá, `ACTIVE_LIVENESS_BASIC` **não pode ser vendido nem descrito como proteção contra fraude por foto**, porque isso é exatamente o que ainda não foi demonstrado.
