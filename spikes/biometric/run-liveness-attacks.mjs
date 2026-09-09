// The fourteen attacks the spike was told to run, executed rather than described.
//
// Six of them need a camera, a person, a printer or a second phone. This machine has none of
// those, so they are reported BLOCKED_BY_ENVIRONMENT and no result is invented for them --
// that is the whole reason the spike was allowed to report that state.
//
// The other eight are PROTOCOL attacks: replay, nonce reuse, challenge substitution, reordering,
// skipping, expiry, and reusing a previous PASS. Those need no camera at all, and they are the
// ones that decide whether the server-side trust model holds. They run here for real.
//
// Run: node run-liveness-attacks.mjs

import { createSession, verify, providerError, THRESHOLDS } from './liveness-protocol.mjs';
import crypto from 'node:crypto';

let failures = 0;
const rows = [];

function check(id, label, cond, detail) {
  rows.push({ id, label, verdict: cond ? 'BLOCKED (bom)' : 'PASSOU (ruim)', detail: detail ?? '' });
  console.log(`${cond ? 'PASS' : 'FAIL'} -- [${id}] ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures += 1;
}

function blockedByEnv(id, label, why) {
  rows.push({ id, label, verdict: 'BLOCKED_BY_ENVIRONMENT', detail: why });
  console.log(`SKIP -- [${id}] ${label}  (BLOCKED_BY_ENVIRONMENT: ${why})`);
}

/** A synthetic landmark series that genuinely satisfies a primitive sequence. This is NOT a
 * face and makes no claim about real faces -- it is the protocol's input shape, used to prove
 * that a WELL-FORMED submission passes so the refusals below mean something. A harness where
 * everything fails proves nothing. */
function seriesFor(sequence, session, opts = {}) {
  const t0 = opts.startTs ?? session.createdAt + 100;
  const frames = [];
  let ts = t0;
  let scale = 1.0;

  const push = (over) => {
    frames.push({
      ts,
      yaw: 0,
      eyeOpenness: 0.32,
      faceScale: scale,
      frameHash: crypto.randomBytes(8).toString('hex'),
      ...over,
    });
    ts += 80;
  };

  push({});
  for (const primitive of sequence) {
    const held = THRESHOLDS.minStableFrames + 2;
    switch (primitive) {
      case 'LOOK_FORWARD':
        for (let i = 0; i < held; i += 1) push({ yaw: 0 });
        break;
      case 'TURN_LEFT':
        for (let i = 0; i < held; i += 1) push({ yaw: -(THRESHOLDS.yawDegrees + 8) });
        break;
      case 'TURN_RIGHT':
        for (let i = 0; i < held; i += 1) push({ yaw: THRESHOLDS.yawDegrees + 8 });
        break;
      case 'BLINK':
        push({ eyeOpenness: 0.30 });
        push({ eyeOpenness: 0.10 });
        push({ eyeOpenness: 0.31 });
        break;
      case 'MOVE_CLOSER':
        scale = 1.0 * (1 + THRESHOLDS.scaleDelta + 0.05);
        for (let i = 0; i < held; i += 1) push({ faceScale: scale });
        break;
      case 'MOVE_AWAY':
        scale = 1.0 * (1 - THRESHOLDS.scaleDelta - 0.05);
        for (let i = 0; i < held; i += 1) push({ faceScale: scale });
        break;
      default:
        break;
    }
  }
  return frames;
}

console.log('=== ACTIVE_LIVENESS_BASIC -- ataques de protocolo (executados) ===\n');

// Control: a well-formed submission must PASS, or every refusal below is meaningless.
{
  const s = createSession({ subjectId: 'employee-1' });
  const out = verify(s, {
    challengeId: s.challengeId,
    nonce: s.nonce,
    subjectId: 'employee-1',
    series: seriesFor(s.sequence, s),
  }, s.createdAt + 5_000);
  check('CTRL', 'submissão bem formada PASSA (controle -- sem isto nada abaixo significa nada)',
    out.state === 'PASSED', `state=${out.state} reason=${out.reason ?? '-'} seq=${s.sequence.join('>')}`);
}

// 7. Replay of the same session
{
  const s = createSession({ subjectId: 'employee-1' });
  const sub = { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series: seriesFor(s.sequence, s) };
  const first = verify(s, sub, s.createdAt + 5_000);
  const second = verify(first, sub, s.createdAt + 6_000);
  check('A07', 'replay da mesma sessão', second.state === 'FAILED' && second.reason === 'challenge_already_consumed',
    `1ª=${first.state} 2ª=${second.state}:${second.reason}`);
}

// 8. Replay of the same frames into a NEW session
{
  const s1 = createSession({ subjectId: 'employee-1' });
  const captured = seriesFor(s1.sequence, s1);
  const s2 = createSession({ subjectId: 'employee-1', now: s1.createdAt + 120_000 });
  const out = verify(s2, { challengeId: s2.challengeId, nonce: s2.nonce, subjectId: 'employee-1', series: captured },
    s2.createdAt + 5_000);
  check('A08', 'replay dos mesmos frames numa sessão nova', out.state === 'FAILED',
    `${out.state}:${out.reason}`);
}

// 9. Tampered challenge_id
{
  const s = createSession({ subjectId: 'employee-1' });
  const out = verify(s, { challengeId: crypto.randomUUID(), nonce: s.nonce, subjectId: 'employee-1', series: seriesFor(s.sequence, s) },
    s.createdAt + 5_000);
  check('A09', 'challenge_id alterado', out.state === 'FAILED' && out.reason === 'challenge_id_mismatch', `${out.reason}`);
}

// 10. Actions performed in the wrong order
{
  let s = createSession({ subjectId: 'employee-1', sessionLength: 3 });
  while (new Set(s.sequence).size < 3) s = createSession({ subjectId: 'employee-1', sessionLength: 3 });
  const reversed = [...s.sequence].reverse();
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series: seriesFor(reversed, s) },
    s.createdAt + 5_000);
  check('A10', 'ações na ordem errada', out.state === 'FAILED',
    `pedido=${s.sequence.join('>')} enviado=${reversed.join('>')} → ${out.reason}`);
}

// 11. One action skipped
{
  const s = createSession({ subjectId: 'employee-1', sessionLength: 3 });
  const partial = s.sequence.slice(0, 2);
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series: seriesFor(partial, s) },
    s.createdAt + 5_000);
  check('A11', 'uma ação omitida', out.state === 'FAILED',
    `pedido=${s.sequence.join('>')} enviado=${partial.join('>')} → ${out.reason}`);
}

// 12. Nonce reuse
{
  const s = createSession({ subjectId: 'employee-1' });
  s.seenNonces.add(s.nonce);
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series: seriesFor(s.sequence, s) },
    s.createdAt + 5_000);
  check('A12', 'nonce repetido', out.state === 'FAILED' && out.reason === 'nonce_replayed', `${out.reason}`);
}

// 13. Expired session
{
  const s = createSession({ subjectId: 'employee-1' });
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series: seriesFor(s.sequence, s) },
    s.expiresAt + 1);
  check('A13', 'sessão expirada', out.state === 'EXPIRED', `${out.state}:${out.reason}`);
}

// 14. Reusing a previous PASS
{
  const s = createSession({ subjectId: 'employee-1' });
  const passed = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series: seriesFor(s.sequence, s) },
    s.createdAt + 5_000);
  const out = verify(passed, { challengeId: passed.challengeId, nonce: passed.nonce, subjectId: 'employee-1', series: seriesFor(passed.sequence, passed) },
    s.createdAt + 7_000);
  check('A14', 'reaproveitar um PASS anterior', out.state === 'FAILED' && out.reason === 'challenge_already_consumed',
    `${out.reason}`);
}

// 6-adjacent: a challenge issued to one employee settling another's confirmation.
{
  const s = createSession({ subjectId: 'employee-1' });
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-2', series: seriesFor(s.sequence, s) },
    s.createdAt + 5_000);
  check('A06b', 'challenge de um funcionário usado para outro', out.state === 'FAILED' && out.reason === 'subject_mismatch',
    `${out.reason}`);
}

// Static-image signature: the same frame padded out to look like a stream.
{
  const s = createSession({ subjectId: 'employee-1' });
  const series = seriesFor(s.sequence, s);
  const oneHash = series[0].frameHash;
  for (const f of series) f.frameHash = oneHash;
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series },
    s.createdAt + 5_000);
  check('A04b', 'mesmo frame repetido (assinatura de imagem estática)',
    out.state === 'FAILED' && out.reason === 'duplicate_frames', `${out.reason}`);
}

// A single frame satisfying a whole primitive -- the spliced-still attack.
{
  const s = createSession({ subjectId: 'employee-1', sessionLength: 1 });
  while (s.sequence[0] === 'BLINK') { const r = createSession({ subjectId: 'employee-1', sessionLength: 1 }); Object.assign(s, r); }
  const series = [
    { ts: s.createdAt + 100, yaw: 0, eyeOpenness: 0.32, faceScale: 1, frameHash: 'a' },
    { ts: s.createdAt + 180, yaw: s.sequence[0] === 'TURN_LEFT' ? -40 : 40, eyeOpenness: 0.32, faceScale: 1.4, frameHash: 'b' },
  ];
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series }, s.createdAt + 3_000);
  check('A05b', 'um único frame satisfazendo uma primitiva (still emendado)',
    out.state === 'FAILED', `pedido=${s.sequence[0]} → ${out.state}:${out.reason}`);
}

// Frames captured BEFORE the challenge existed.
{
  const s = createSession({ subjectId: 'employee-1' });
  const series = seriesFor(s.sequence, s, { startTs: s.createdAt - 60_000 });
  const out = verify(s, { challengeId: s.challengeId, nonce: s.nonce, subjectId: 'employee-1', series }, s.createdAt + 5_000);
  check('A05c', 'frames gravados ANTES do challenge existir',
    out.state === 'FAILED' && out.reason === 'frame_predates_challenge', `${out.reason}`);
}

// Provider failure must not read as the person failing.
{
  const s = createSession({ subjectId: 'employee-1' });
  const out = providerError(s);
  check('ERR', 'falha do provedor é PROVIDER_ERROR, nunca FAILED',
    out.state === 'PROVIDER_ERROR' && out.state !== 'FAILED', `${out.state}`);
}

console.log('\n=== ataques que exigem mundo físico ===\n');
blockedByEnv('A01', 'pessoa real diante da câmera', 'sem câmera e sem pessoa nesta máquina');
blockedByEnv('A02', 'foto impressa', 'sem impressora, sem câmera');
blockedByEnv('A03', 'foto exibida noutro celular', 'sem segundo aparelho, sem câmera');
blockedByEnv('A04', 'screenshot exibido', 'sem câmera');
blockedByEnv('A05', 'vídeo previamente gravado', 'sem câmera e sem sujeito autorizado');
blockedByEnv('A06', 'pessoa diferente da referência', 'sem duas pessoas autorizadas');

const executed = rows.filter((r) => r.verdict !== 'BLOCKED_BY_ENVIRONMENT').length;
const blocked = rows.filter((r) => r.verdict === 'BLOCKED_BY_ENVIRONMENT').length;
console.log(`\n=== ${executed} ataques de protocolo executados, ${failures} passaram indevidamente; ${blocked} bloqueados pelo ambiente ===`);
process.exit(failures === 0 ? 0 : 1);
