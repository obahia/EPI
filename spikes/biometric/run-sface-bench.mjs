// SFace 1:1 -- what can honestly be measured on this machine, and a blunt statement of what
// cannot.
//
// WHAT THIS DOES NOT DO: it does not measure recognition accuracy. Accuracy needs pairs of real
// faces -- the same person twice, and two different people -- and this spike has no licensed,
// ethically usable face dataset and no camera to make one. Running the model on whatever face
// images happen to be downloadable would mean processing identifiable people's biometrics
// without their consent to prove a point about a product that has not shipped. So genuine
// accepts and impostor rejects are reported BLOCKED_BY_ENVIRONMENT, not estimated.
//
// WHAT IT DOES MEASURE, and these are real numbers: that the Apache-2.0 SFace ONNX loads and
// runs under onnxruntime-node with no Python and no Docker; its input and output shapes; the
// embedding dimensionality; per-inference latency over many runs; that the model is
// deterministic (the same input yields a bit-identical embedding, which is what makes a stored
// reference comparable months later); and that cosine similarity behaves as a metric on its
// output space.
//
// Run: node run-sface-bench.mjs

import ort from 'onnxruntime-node';
import crypto from 'node:crypto';
import fs from 'node:fs';

const MODEL = 'models/sface_2021dec.onnx';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Deterministic pseudo-image so runs are comparable. NOT a face: this measures compute, and
 * the report says so wherever these numbers appear. */
function tensorFrom(seed) {
  const rng = crypto.createHash('sha256').update(String(seed)).digest();
  const data = new Float32Array(1 * 3 * 112 * 112);
  let x = rng.readUInt32BE(0) || 1;
  for (let i = 0; i < data.length; i += 1) {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    data[i] = (x % 256) - 127.5;
  }
  return new ort.Tensor('float32', data, [1, 3, 112, 112]);
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function main() {
  if (!fs.existsSync(MODEL)) {
    console.error(`Modelo ausente: ${MODEL}`);
    process.exit(1);
  }
  const sizeMb = mb(fs.statSync(MODEL).size);
  const rssBefore = process.memoryUsage().rss;

  const tLoadStart = performance.now();
  const session = await ort.InferenceSession.create(MODEL);
  const loadMs = performance.now() - tLoadStart;
  const rssAfterLoad = process.memoryUsage().rss;

  console.log('=== SFace (opencv_zoo, Apache-2.0) sob onnxruntime-node ===\n');
  console.log(`modelo            : ${MODEL} (${sizeMb} MB)`);
  console.log(`entradas          : ${session.inputNames.join(', ')}`);
  console.log(`saídas            : ${session.outputNames.join(', ')}`);
  console.log(`cold start (load) : ${loadMs.toFixed(0)} ms`);
  console.log(`RSS após carregar : +${mb(rssAfterLoad - rssBefore)} MB\n`);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  // Warm-up, excluded from the numbers: the first inference pays one-off allocation.
  const warm = await session.run({ [inputName]: tensorFrom('warm') });
  const dim = warm[outputName].data.length;
  console.log(`dimensão do embedding: ${dim}`);

  // --- determinism --------------------------------------------------------------------
  const a1 = (await session.run({ [inputName]: tensorFrom(1) }))[outputName].data;
  const a2 = (await session.run({ [inputName]: tensorFrom(1) }))[outputName].data;
  const identical = a1.every((v, i) => v === a2[i]);
  console.log(`determinístico       : ${identical ? 'SIM' : 'NÃO'} (mesma entrada → embedding idêntico bit a bit)`);
  console.log(`cos(self)            : ${cosine(a1, a2).toFixed(6)}`);

  const b = (await session.run({ [inputName]: tensorFrom(2) }))[outputName].data;
  console.log(`cos(a, b) entrada distinta: ${cosine(a1, b).toFixed(4)}   <- NÃO é medida de acurácia, ver cabeçalho\n`);

  // --- latency ------------------------------------------------------------------------
  const N = 60;
  const times = [];
  for (let i = 0; i < N; i += 1) {
    const t = tensorFrom(`lat-${i}`);
    const t0 = performance.now();
    await session.run({ [inputName]: t });
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);

  console.log(`latência de inferência (${N} execuções, CPU, ${process.arch}):`);
  console.log(`  p50 : ${percentile(times, 50).toFixed(1)} ms`);
  console.log(`  p95 : ${percentile(times, 95).toFixed(1)} ms`);
  console.log(`  p99 : ${percentile(times, 99).toFixed(1)} ms`);
  console.log(`  min : ${times[0].toFixed(1)} ms   max: ${times[times.length - 1].toFixed(1)} ms`);

  // A 1:1 verification is two embeddings plus a cosine -- the cosine is free next to inference.
  console.log(`\n  custo de uma verificação 1:1 (2 inferências + cosseno) ≈ ${(percentile(times, 50) * 2).toFixed(0)} ms p50`);
  console.log(`  (referência pode ser pré-computada e guardada, caindo para ≈ ${percentile(times, 50).toFixed(0)} ms por confirmação)`);

  console.log(`\nRSS ao final       : ${mb(process.memoryUsage().rss)} MB`);
  console.log('\n=== NÃO MEDIDO ===');
  console.log('genuine accepts / impostor rejects: BLOCKED_BY_ENVIRONMENT');
  console.log('  sem dataset facial com licença adequada e sem câmera nesta máquina.');
  console.log('  Nenhum threshold é proposto a partir desta execução -- seria inventar.');
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
