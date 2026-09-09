# Licenças — identidade biométrica (Fase I)

**Data:** 2026-09-09. **Etapa:** I-N, executada **antes** dos spikes por decisão minha.
**Veredito:** **BLOQUEADO para uso comercial** na combinação escolhida.
**Investigação 2 (2026-09-09):** busca por qualquer stack R$0 comercialmente limpa — **NO-GO**. Ver §9 em diante.

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

---

# Investigação 2 — busca por uma stack R$0 comercialmente limpa

**Data:** 2026-09-09. **Pedido:** encontrar pelo menos uma combinação viável de detecção, verificação 1:1 e liveness em que **código e pesos** permitam uso comercial, sem API paga, self-hosted.
**Resultado:** **NO-GO — nenhuma stack biométrica comercialmente limpa encontrada.**

## 9. Método

Para cada componente verifiquei separadamente, em fonte primária: licença do código, licença declarada dos pesos, dataset de treino, e termos adicionais. A regra aplicada foi a sua: **licença de repositório não é prova, e ambiguidade em qualquer camada = BLOQUEADO.**

O que a investigação encontrou não foi má sorte com um projeto específico. É um padrão estrutural: **quase todo modelo facial público é treinado num dataset acadêmico cuja licença proíbe exploração comercial de dados derivados** — e um modelo treinado nessas imagens é dado derivado. A licença permissiva que os repositórios exibem cobre o código e o artefato que eles empacotam, não a proveniência.

## 10. Tabela

| Projeto / modelo | Função | Licença do código | Licença dos pesos | Dataset de treino | Comercial | Self-host | CPU/GPU | Formato | Benchmark publicado | Manutenção | Risco / evidência |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **CompreFace** (Exadel) | wrapper/REST | Apache-2.0 | não treina modelo próprio | — | wrapper: **sim** | sim | ambos | serviço | — | ativa | Doc própria **silencia** sobre a licença dos pesos que carrega |
| **InsightFace** | embedding 1:1 | MIT | *"non-commercial research purposes only"* | MS1M et al. | **NÃO** | sim | ambos | MXNet/ONNX | LFW ~99,8% | ativa | Restrição declarada pelo detentor. Vende licença comercial à parte |
| **OpenCV Zoo — YuNet** | detecção | MIT (por diretório) | MIT declarada | **WIDER FACE** | **BLOQUEADO** | sim | CPU | ONNX | WIDER AP 0,884 / 0,866 / 0,750 | ativa | WIDER FACE é **CC BY-NC-ND 2.0**: não-comercial **e** sem derivados |
| **OpenCV Zoo — SFace** | verificação 1:1 | Apache-2.0 (por diretório) | Apache-2.0 declarada | **não nomeado** | **BLOQUEADO** | sim | CPU | ONNX | 99,40% | ativa | Melhor declaração encontrada, mas proveniência não divulgada → ambíguo |
| **OMZ — anti-spoof-mn3** | liveness | MIT (kprokofi) | MIT declarada | **CelebA-Spoof** | **NÃO** | sim | ambos | IR/ONNX | ACER 3,81% | OMZ em *legacy* | CelebA-Spoof proíbe explorar comercialmente *"any portion of derived data"* |
| **OMZ — face-reidentification-retail-0095** | verificação 1:1 | Apache-2.0 (repo) | **sem declaração** | **não nomeado** | **BLOQUEADO** | sim | ambos | IR | LFW 99,47% | OMZ em *legacy* | Model card só traz aviso de marcas; README do OMZ não fala de pesos |
| **OMZ — face-recognition-resnet100-arcface-onnx** | verificação 1:1 | Apache-2.0 | aponta para o **LICENSE do repo onnx/models** | MS-Celeb-1M (ArcFace, arXiv 1801.07698) | **NÃO** | sim | ambos | ONNX | LFW 99,68% | OMZ em *legacy* | Licença de repositório, não dos pesos. O modelo é o da InsightFace |
| **VirtuoTuring face embedder** (HF) | verificação 1:1 | MIT | MIT | 23.660 imagens, **origem não divulgada** | **BLOQUEADO** | sim | CPU | ONNX | não publicado | desconhecida | Publicador desconhecido, proveniência não divulgada. Visto apenas em busca, não verificado em fonte primária |

**Sobre o que verifiquei e como.** As linhas de CompreFace, InsightFace, YuNet, SFace, anti-spoof-mn3, face-reidentification-retail-0095 e arcface-onnx foram lidas em fonte primária (README ou model card do próprio projeto). CelebA-Spoof foi lido no README oficial do dataset. WIDER FACE e a linha VirtuoTuring vêm de resultado de busca, **não** de fonte primária — estão marcadas como tal e não sustentam nenhuma conclusão de liberação.

## 11. As três descobertas que decidem

**11.1 O dataset alcança o modelo.** CelebA-Spoof: *"You agree not to reproduce, duplicate, copy, sell, trade, resell or exploit for any commercial purposes, any portion of the images **and any portion of derived data**."* Um modelo treinado nessas imagens é dado derivado. A licença MIT que o autor do código pôs no repositório não pode conceder mais direitos do que ele próprio tem sobre o treino.

**11.2 "Legal Information" costuma apontar para o repositório, não para os pesos.** O `face-recognition-resnet100-arcface-onnx` do OMZ diz que *"the original model is distributed under the Apache License, Version 2.0"* e aponta para o `LICENSE` do repositório **onnx/models**. Isso é a licença de um repositório que redistribui, não uma concessão sobre a proveniência. O modelo é o ArcFace ResNet100 da InsightFace — a mesma entidade que declara os próprios pesos como research-only.

**11.3 Nem o modelo treinado por fornecedor resolve.** O `face-reidentification-retail-0095` era a candidata mais forte: modelo de fornecedor, LFW 99,47%, exatamente 1:1 e não 1:N. Mas o model card **não nomeia dataset** e **não traz declaração de licença** além de um aviso de marcas, e o README do OMZ não diz nada sobre licença de pesos nem sobre quem treinou os modelos de `models/intel/`. Sem a camada de proveniência, é ambíguo — e ambíguo é bloqueado, pela sua regra.

Há ainda uma confirmação independente do lado da indústria, encontrada em busca: treinar um sistema comercial de liveness sobre datasets públicos é tipicamente violação de licença, e um produto que precise passar por certificação exige fonte comercial. É consistente com tudo que verifiquei — e explica por que a própria InsightFace vende licenciamento comercial: os pesos gratuitos são research-only **por desenho de negócio**, não por descuido.

## 12. Stacks candidatas

**Nenhuma.** Não monto STACK A/B/C porque não há combinação em que as três camadas passem — e preencher a tabela com um componente bloqueado seria exatamente o contorno que você proibiu.

O mais perto que se chega, e o que faltaria a cada um:

| Quase-stack | Detecção | Verificação | Liveness | O que falta |
|---|---|---|---|---|
| OpenCV Zoo | YuNet (WIDER FACE, NC-ND) | SFace (dataset não nomeado) | **não existe no zoo** | Proveniência de ambos, mais um liveness inteiro |
| OpenVINO OMZ | face-detection-retail | face-reidentification-retail-0095 (sem declaração) | anti-spoof-mn3 (CelebA-Spoof, NC) | Declaração de proveniência da Intel e substituir o liveness |
| CompreFace | embutida | InsightFace (**proibido**) | não tem | Trocar o modelo de reconhecimento e adicionar liveness |

**O liveness é a camada mais dura.** Detecção e verificação ainda têm candidatos plausíveis aguardando esclarecimento de proveniência. Para liveness, o único modelo com licença declarada que encontrei está treinado num dataset que proíbe uso comercial de derivados — e a alternativa citada como estado da arte aberto é um Swin Transformer de competição acadêmica, cuja proveniência é ainda mais claramente acadêmica.

## 13. O que destravaria

Em ordem de esforço:

1. **Uma resposta escrita da Intel** sobre a proveniência e a licença dos pesos de `models/intel/`. Se a Intel declarar que treinou com dados licenciados e concede Apache-2.0 sobre os pesos, `face-reidentification-retail-0095` + `face-detection-retail-*` viram detecção e verificação limpas — e resta só o liveness. **Custo: um e-mail.** É a ação de maior retorno da lista.
2. **A mesma pergunta ao mantenedor do SFace** (Yaoyao Zhong / OpenCV Zoo): qual dataset treinou os pesos publicados. Uma issue em `opencv/opencv_zoo`. **Custo: uma issue.**
3. **Um modelo treinado em faces sintéticas** com licença comercial explícita — resolve a proveniência pela raiz, já que não há pessoas reais no treino. Existe pesquisa nessa direção; não encontrei artefato pronto com licença limpa.
4. **Licença comercial da InsightFace** — destrava reconhecimento e liveness de uma vez, com fornecedor identificável. **Viola o orçamento de R$0 desta fase**, então é decisão sua, não minha. Registro porque é a única opção que resolve as três camadas com um único contrato.
5. **Treinar sobre dataset licenciado** — semanas de trabalho e custo de computação, fora do escopo de uma fase.

Os itens 1 e 2 custam praticamente nada e podem converter duas linhas "BLOQUEADO por ambiguidade" em "liberado". **Recomendo fazê-los antes de qualquer decisão de orçamento** — mudam a conversa sem gastar nada.

## 14. Veredito

# NO-GO — nenhuma stack biométrica comercialmente limpa encontrada

Não por falta de opção técnica: SFace tem 99,40% em LFW, YuNet detecta bem, anti-spoof-mn3 tem ACER de 3,81%. Tecnicamente a stack existe e rodaria hoje.

**O bloqueio é inteiramente jurídico, e está na camada dos pesos** — a camada que a licença exibida no repositório não cobre e que quase ninguém documenta. Foi por isso que você mandou verificar cada camada em separado, e é exatamente aí que todos os candidatos caem.

O AL1 do produto permanece intocado e continua sendo o que `docs/pilot-readiness.md` mede como pronto para piloto.

## 15. Fontes

- CompreFace — https://github.com/exadel-inc/CompreFace
- CompreFace, plugins e modelos — https://github.com/exadel-inc/CompreFace/blob/master/docs/Face-services-and-plugins.md
- InsightFace — https://github.com/deepinsight/insightface
- OpenCV Zoo — https://github.com/opencv/opencv_zoo
- SFace — https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface
- YuNet — https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- OMZ anti-spoof-mn3 — https://github.com/openvinotoolkit/open_model_zoo/blob/master/models/public/anti-spoof-mn3/README.md
- OMZ face-reidentification-retail-0095 — https://github.com/openvinotoolkit/open_model_zoo/blob/master/models/intel/face-reidentification-retail-0095/README.md
- OMZ face-recognition-resnet100-arcface-onnx — https://github.com/openvinotoolkit/open_model_zoo/blob/master/models/public/face-recognition-resnet100-arcface-onnx/README.md
- CelebA-Spoof — https://github.com/ZhangYuanhan-AI/CelebA-Spoof
- Silent-Face-Anti-Spoofing — https://github.com/minivision-ai/Silent-Face-Anti-Spoofing
- InsightFace, licenciamento comercial — https://www.insightface.ai/
