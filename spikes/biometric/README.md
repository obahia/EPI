# Spike biométrico — Fase I

**Isolado do produto de propósito.** `package.json` próprio, arquivos `.mjs` (o `tsconfig` do
produto inclui `**/*.ts` e `**/*.mts`, não `.mjs`), nenhum import de ou para `src/`. Nenhuma
migration, nada no pipeline de evidência, nada no fluxo de confirmação. AL1 intacto.

Resultado e números: `docs/biometric-spike-report.md`. Licenças: `docs/biometric-licenses.md`.

## Dependências

Sem Docker e sem Python — esta máquina não tem nenhum dos dois, e nenhum foi instalado.
`onnxruntime-node` traz binários pré-compilados e roda ONNX direto no Node.

    node --version      # v24.18.1 no ambiente de referência
    cd spikes/biometric
    npm install         # onnxruntime-node ^1.20.1 (resolveu para 1.29.0)
    node fetch-models.mjs

Os pesos ficam fora do git (36,9 MB). `fetch-models.mjs` os baixa e imprime a licença de cada um.

## Executar

    node run-sface-bench.mjs      # carga, forma, dimensão, determinismo, latência, memória
    node run-liveness-attacks.mjs # 14 ataques de protocolo + 6 marcados BLOCKED_BY_ENVIRONMENT

`run-liveness-attacks.mjs` sai com código diferente de zero se algum ataque passar.

## Arquivos

| Arquivo | O que é |
|---|---|
| `liveness-protocol.mjs` | ACTIVE_LIVENESS_BASIC do lado do servidor: geração de challenge, nonce, TTL, uso único, vínculo com o sujeito, máquina de estados e verificação temporal |
| `run-liveness-attacks.mjs` | Os ataques, executados |
| `run-sface-bench.mjs` | SFace sob onnxruntime-node |
| `fetch-models.mjs` | Baixa os pesos, registrando a licença |

## O que este spike NÃO prova

- Acurácia do face match. Sem dataset facial autorizado e sem câmera, genuine accepts e
  impostor rejects continuam **BLOCKED_BY_ENVIRONMENT**, e nenhum threshold é proposto.
- Resistência a foto impressa, tela ou replay físico. O desenho ataca isso; ninguém testou.
- Custo da extração de landmarks no servidor, que a abordagem recomendada exige e que este
  spike não implementa.

`verify()` recebe uma série de landmarks já extraída, de propósito, para que o protocolo possa
ser atacado sem câmera. **Em produção essa série tem de ser derivada no servidor a partir dos
frames enviados** — alimentá-la com landmarks vindos do navegador reabre exatamente o buraco de
confiança que este spike existe para fechar.
