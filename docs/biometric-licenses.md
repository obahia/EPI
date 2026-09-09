# Licenças — identidade biométrica (Fase I)

**Data:** 2026-09-09. **Etapa:** I-N, executada **antes** dos spikes por decisão minha.
**Veredito:** **BLOQUEADO para uso comercial** na combinação escolhida.

A instrução da fase foi explícita: *"Não assumir que licença do wrapper cobre automaticamente os pesos/modelos. Qualquer ambiguidade de licença comercial deve virar blocker."* Este documento é o resultado de aplicar essa regra — e ela produziu um blocker antes de qualquer container subir.

**Por que isto veio primeiro.** A ordem pedida colocava licenças na etapa I-N, quase no fim. Antecipei porque uma restrição de licença invalida todo o trabalho anterior: se os pesos não podem ser usados comercialmente, os spikes, o threat model, o enrollment e o E2E teriam sido construídos sobre uma base inutilizável. Custa uma hora descobrir agora e semanas descobrir depois.

---

## 1. Resumo

| Componente | Licença do **código** | Licença dos **pesos/modelo** | Uso comercial | Veredito |
|---|---|---|---|---|
| CompreFace (Exadel) | Apache-2.0 | — (não treina modelo próprio) | Código: **sim** | Wrapper liberado |
| Modelos de reconhecimento usados pelo CompreFace (InsightFace) | MIT | **"non-commercial research purposes only"** | **NÃO** | **BLOQUEADO** |
| Silent-Face-Anti-Spoofing / MiniFASNet (MiniVision) | Apache-2.0 | **não declarada** | **Incerto** | **BLOQUEADO por ambiguidade** |

---

## 2. CompreFace — o wrapper está liberado, e não é isso que importa

O README declara: *"CompreFace is open-source real-time facial recognition software released under the Apache 2.0 license."* Apache-2.0 permite uso comercial, modificação e distribuição com atribuição.

O README também declara que o produto *"Uses FaceNet and InsightFace libraries"*.

**A documentação própria do CompreFace não diz nada sobre a licença dos pesos dos modelos.** Verifiquei `docs/Face-services-and-plugins.md`: descreve as capacidades (embeddings, landmarks, idade, gênero, máscara, pose) e menciona a InsightFace como biblioteca subjacente, sem qualquer declaração de licenciamento dos modelos.

Esse silêncio é exatamente o problema. Quem implanta herda a obrigação de licença dos pesos, e não há aviso no caminho.

---

## 3. InsightFace — o blocker duro

O repositório distingue as duas coisas de forma explícita:

- **Código:** *"The code of InsightFace is released under the MIT License. There is no limitation for both academic and commercial usage."*
- **Pesos:** *"The training data containing the annotation (and the models trained with these data) are available for **non-commercial research purposes only**."*

A restrição vale para os modelos baixados manualmente **e** para os baixados automaticamente pela biblioteca. Para uso comercial, o projeto direciona a contatos de licenciamento próprios.

**Consequência direta para o Selo:** rodar CompreFace com os modelos InsightFace num produto comercial — que é o que Selo é — **não é permitido pela licença dos pesos**. Não é uma zona cinzenta nem uma questão de interpretação: é uma restrição declarada pelo detentor.

Isto não é ambiguidade a resolver com cuidado. É uma proibição. Sob a regra de parada desta fase (*"modelo não permite uso comercial"*), é motivo de parada imediata.

---

## 4. MiniFASNet / Silent-Face-Anti-Spoofing — ambiguidade, que também é blocker

- O repositório está sob **Apache-2.0**.
- **Não há declaração sobre a licença ou a proveniência dos pesos** publicados.
- O próprio repositório indica que o modelo de alta precisão **não é open source** (「高精度模型」未开源), o que confirma que os autores tratam modelo e código como coisas separadas — e que o que está aberto é a versão inferior.

Uma licença Apache-2.0 no repositório **não transfere automaticamente** direitos sobre pesos treinados em dados de terceiros. Sem declaração sobre os dados de treino, não é possível afirmar que o uso comercial está liberado.

Vale registrar que isto **não é novidade** para este projeto: a pesquisa da FASE 4, registrada em `docs/architecture.md` §9, já concluía que *"nenhuma opção open source é defensável para produção"* e que todo repositório de licença permissiva converge para os mesmos pesos MiniFASNet, sem manutenção desde 2020. A Fase I chegou, por caminho independente, à mesma conclusão.

---

## 5. O que isto NÃO significa

- **Não significa que CompreFace seja inutilizável.** O wrapper é Apache-2.0. O bloqueio está nos pesos de reconhecimento que ele usa por padrão.
- **Não significa que a arquitetura esteja errada.** `IdentityVerificationProvider` continua sendo o lugar certo para plugar um provedor; o que falta é um provedor cujos pesos possam ser usados.
- **Não significa que não exista caminho.** Ver §6.

---

## 6. Opções, com o custo real

Apresentadas sem recomendar a que a fase proibiu (nenhuma API paga foi substituída silenciosamente).

### Opção A — Trocar os pesos, manter CompreFace
Rodar CompreFace com um modelo de reconhecimento cujos pesos sejam comercialmente licenciados. Exige encontrar e validar um: precisa ser compatível com a interface de "calculator" do CompreFace, ter licença explícita para uso comercial **dos pesos**, e ter qualidade comparável.
**Custo:** pesquisa e validação, sem garantia de existir. **Orçamento:** R$0 mantido.
**Risco:** pode simplesmente não haver opção com qualidade aceitável e licença limpa.

### Opção B — Licença comercial da InsightFace
O projeto oferece contatos para licenciamento comercial dos modelos.
**Custo:** desconhecido, quase certamente > R$0. **Viola o orçamento declarado desta fase**, portanto é decisão sua, não minha.

### Opção C — Treinar/afinar modelo próprio sobre dataset licenciado
**Custo:** alto em tempo e computação; exige dataset de faces com licença comercial. Não é trabalho de uma fase.

### Opção D — Adiar biometria e vender o piloto como AL1
O que o produto **já faz e já foi medido**: link individual opaco, desafio de conhecimento pelos 3 últimos dígitos do CPF, assinatura desenhada, evidência selada e verificável publicamente. `docs/pilot-readiness.md` §7 registra isso como pronto.
**Custo:** R$0. **Perde:** a alegação de reconhecimento facial — que hoje não existe de qualquer forma.

### Opção E — Liveness sem reconhecimento facial
Liveness resolve *"há uma pessoa viva na frente da câmera"*; face match resolve *"é esta pessoa"*. São separáveis, e a fase já pedia providers separados. Um AL intermediário (link + conhecimento + prova de vida, **sem** comparação facial) evitaria o blocker da InsightFace — mas continua preso à ambiguidade dos pesos MiniFASNet (§4).

---

## 7. Obrigações de atribuição — se alguma opção destravar

Registrado agora para não ser esquecido depois:

- **Apache-2.0** (CompreFace, Silent-Face-Anti-Spoofing) exige: manter avisos de copyright e licença, indicar arquivos modificados, e incluir o `NOTICE` se existir. Vale para redistribuição — rodar como serviço interno não é redistribuição, mas distribuir imagens Docker derivadas é.
- **MIT** (código InsightFace) exige manter o aviso de copyright.
- **Pesos:** obrigação depende da licença específica que vier a ser adotada. Precisa ser registrada aqui, com a fonte e a data, antes de qualquer uso.

---

## 8. Como reverificar

As licenças mudam. Reverificar antes de qualquer lançamento comercial:

1. `https://github.com/exadel-inc/CompreFace` — licença do wrapper.
2. `https://github.com/deepinsight/insightface` — a distinção código/pesos, que é o ponto.
3. `https://github.com/minivision-ai/Silent-Face-Anti-Spoofing` — se passaram a declarar a licença dos pesos.
4. A documentação do CompreFace sobre qual modelo a configuração em uso realmente carrega — o bloqueio depende do modelo efetivamente carregado, não do que o README menciona.

Consultado em 2026-09-09.
