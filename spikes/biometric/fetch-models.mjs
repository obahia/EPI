// Fetches the model weights the spike needs. Kept out of git: 36.9 MB of binary that would sit
// in history forever, and the licence permits redistribution but nothing requires it.
//
// SFace: Apache-2.0, granted by the model directory's own LICENSE file, which the README states
// covers "all files in this directory" -- the .onnx included. See docs/biometric-licenses.md §17.
//
// Run: node fetch-models.mjs
import fs from 'node:fs';

const MODELS = [
  {
    name: 'sface_2021dec.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    minBytes: 30_000_000,
    licence: 'Apache-2.0 (opencv_zoo, models/face_recognition_sface/LICENSE)',
  },
];

fs.mkdirSync('models', { recursive: true });

for (const m of MODELS) {
  const target = `models/${m.name}`;
  if (fs.existsSync(target)) {
    console.log(`já existe: ${target}`);
    continue;
  }
  const res = await fetch(m.url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < m.minBytes) {
    console.error(`${m.name}: resposta pequena demais (${buf.length} bytes) -- provavelmente um ponteiro LFS ou um erro`);
    process.exit(1);
  }
  fs.writeFileSync(target, buf);
  console.log(`baixado ${target} (${(buf.length / 1024 / 1024).toFixed(1)} MB) -- ${m.licence}`);
}
