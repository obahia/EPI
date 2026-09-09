// ACTIVE_LIVENESS_BASIC -- the server-side half, which is the half that decides whether the
// whole idea is worth anything.
//
// SPIKE CODE. Isolated from the product on purpose: its own package.json, plain .mjs so the
// product's typecheck never sees it, and no import from src/ in either direction. Nothing here
// is wired into a migration, the evidence pipeline or the confirmation flow.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the browser is not a witness. It may capture, it may
// run landmarks for live UX, it may pre-process -- but a POST saying `liveness=true` proves
// nothing, and neither does a landmark time series the browser typed out by hand. Everything
// below is written so that the decision depends only on state the SERVER generated and on
// evidence the server can re-derive.
//
// What this file does NOT do: decide whether a face is alive. That needs the landmark
// extraction to run server-side over submitted frames (see verify() -- it consumes an
// already-extracted series and is deliberately agnostic about who extracted it, so the spike
// can test the protocol without a camera). Feeding it browser-supplied landmarks in production
// would reintroduce exactly the trust hole this file is about.

import crypto from 'node:crypto';

export const PRIMITIVES = ['LOOK_FORWARD', 'TURN_LEFT', 'TURN_RIGHT', 'BLINK', 'MOVE_CLOSER', 'MOVE_AWAY'];

export const STATES = ['CREATED', 'STARTED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'EXPIRED', 'PROVIDER_ERROR'];

/** Provisional, and every one of them is a guess until measured against real faces. Named
 * constants rather than literals so the spike report can print exactly what it ran with. */
export const THRESHOLDS = {
  /** Degrees of yaw before a turn counts as a turn. */
  yawDegrees: 20,
  /** A primitive must hold for this many consecutive frames -- one frame is a glitch, not a
   * gesture, and accepting a single frame is how a spliced still image passes. */
  minStableFrames: 5,
  /** ...and for at least this long, so a high-framerate burst cannot satisfy the frame count
   * in an implausibly short time. */
  minStableMs: 300,
  /** Eye aspect ratio below this is "closed". */
  blinkClosedRatio: 0.18,
  /** ...and it has to reopen above this, or a photo of someone mid-blink would qualify. */
  blinkOpenRatio: 0.25,
  /** Relative face-scale change for MOVE_CLOSER / MOVE_AWAY. */
  scaleDelta: 0.15,
  /** A whole session has to complete inside this, or a human-in-the-loop attacker has time to
   * assemble a response. */
  sessionTtlMs: 60_000,
  /** Frames older than this relative to session start are refused outright. */
  maxFrameAgeMs: 90_000,
};

/**
 * A challenge the client cannot predict.
 *
 * Unpredictability is doing the real work here: if the sequence were fixed, an attacker would
 * record one video of the six primitives and replay the right clip forever. The sequence is
 * drawn server-side, after the session exists, from a CSPRNG.
 */
export function createSession({ subjectId, sessionLength = 3, now = Date.now() }) {
  if (!subjectId) throw new Error('subjectId is required -- a challenge not bound to a subject is transferable');

  const pool = [...PRIMITIVES];
  const sequence = [];
  for (let i = 0; i < sessionLength; i += 1) {
    const pick = crypto.randomInt(0, pool.length);
    sequence.push(pool[pick]);
    pool.splice(pick, 1);
  }

  return {
    challengeId: crypto.randomUUID(),
    nonce: crypto.randomBytes(32).toString('base64url'),
    subjectId,
    sequence,
    state: 'CREATED',
    createdAt: now,
    expiresAt: now + THRESHOLDS.sessionTtlMs,
    consumedAt: null,
    seenNonces: new Set(),
  };
}

/** One primitive, verified over a window of frames rather than at a single instant. */
function primitiveSatisfied(primitive, frames, baseline) {
  let run = 0;
  let runStartTs = null;
  let blinkClosed = false;

  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i];
    let holds = false;

    switch (primitive) {
      case 'LOOK_FORWARD':
        holds = Math.abs(f.yaw) < THRESHOLDS.yawDegrees / 2;
        break;
      case 'TURN_LEFT':
        holds = f.yaw <= -THRESHOLDS.yawDegrees;
        break;
      case 'TURN_RIGHT':
        holds = f.yaw >= THRESHOLDS.yawDegrees;
        break;
      case 'MOVE_CLOSER':
        holds = f.faceScale >= baseline.faceScale * (1 + THRESHOLDS.scaleDelta);
        break;
      case 'MOVE_AWAY':
        holds = f.faceScale <= baseline.faceScale * (1 - THRESHOLDS.scaleDelta);
        break;
      case 'BLINK':
        // A blink is a transition, not a state: closed and then open again. A still photo of
        // open eyes never closes; a still photo of closed eyes never reopens.
        if (f.eyeOpenness <= THRESHOLDS.blinkClosedRatio) blinkClosed = true;
        if (blinkClosed && f.eyeOpenness >= THRESHOLDS.blinkOpenRatio) {
          return { ok: true, frames: i + 1, endIndex: i };
        }
        continue;
      default:
        return { ok: false, reason: 'unknown_primitive' };
    }

    if (holds) {
      run += 1;
      runStartTs ??= f.ts;
      const heldMs = f.ts - runStartTs;
      if (run >= THRESHOLDS.minStableFrames && heldMs >= THRESHOLDS.minStableMs) {
        return { ok: true, frames: run, heldMs, endIndex: i };
      }
    } else {
      run = 0;
      runStartTs = null;
    }
  }

  return { ok: false, reason: primitive === 'BLINK' ? 'no_blink_transition' : 'not_held_long_enough' };
}

/**
 * Verifies a submission against the session the SERVER created.
 *
 * `series` is a list of per-frame observations -- {ts, yaw, eyeOpenness, faceScale, frameHash}.
 * In production these must be derived server-side from submitted frames; the spike passes them
 * in directly so the protocol can be attacked without a camera. The distinction is the whole
 * point of §"trust boundary" in the report and is not glossed over anywhere.
 */
export function verify(session, submission, now = Date.now()) {
  const fail = (state, reason) => ({ ...session, state, reason, decidedAt: now });

  // --- identity and freshness of the CHALLENGE itself -----------------------------------
  if (session.state === 'PASSED' || session.consumedAt !== null) {
    return fail('FAILED', 'challenge_already_consumed');
  }
  if (submission.challengeId !== session.challengeId) {
    return fail('FAILED', 'challenge_id_mismatch');
  }
  if (submission.nonce !== session.nonce) {
    return fail('FAILED', 'nonce_mismatch');
  }
  if (session.seenNonces.has(submission.nonce)) {
    return fail('FAILED', 'nonce_replayed');
  }
  if (now > session.expiresAt) {
    return fail('EXPIRED', 'session_expired');
  }
  if (submission.subjectId !== session.subjectId) {
    // A challenge issued for one employee must never settle a confirmation for another.
    return fail('FAILED', 'subject_mismatch');
  }

  const series = submission.series ?? [];
  if (series.length === 0) {
    return fail('FAILED', 'empty_series');
  }

  // --- freshness of the FRAMES ----------------------------------------------------------
  // Frames must fall inside the session's own window. This is what stops a submission
  // assembled from a recording made before the challenge existed: it cannot carry timestamps
  // the server issued after it was made.
  for (const f of series) {
    if (f.ts < session.createdAt) return fail('FAILED', 'frame_predates_challenge');
    if (f.ts > session.expiresAt) return fail('FAILED', 'frame_after_expiry');
    if (f.ts - session.createdAt > THRESHOLDS.maxFrameAgeMs) return fail('FAILED', 'frame_too_old');
  }

  // Frame hashes must be distinct. Identical hashes mean the same image was submitted more
  // than once -- a still photo padded out to look like a stream.
  const hashes = series.map((f) => f.frameHash).filter(Boolean);
  if (hashes.length > 0 && new Set(hashes).size !== hashes.length) {
    return fail('FAILED', 'duplicate_frames');
  }

  // --- the sequence, IN ORDER -----------------------------------------------------------
  // Each primitive must be satisfied by frames that come strictly after the previous one was
  // satisfied. Doing them in the wrong order, or skipping one, cannot pass.
  const baseline = series[0];
  let cursor = 0;
  const steps = [];

  for (const primitive of session.sequence) {
    const window = series.slice(cursor);
    const result = primitiveSatisfied(primitive, window, baseline);
    if (!result.ok) {
      return { ...fail('FAILED', `primitive_not_satisfied:${primitive}`), steps };
    }
    // Advance past the frame where this primitive was actually satisfied, so the next one
    // must be satisfied by LATER frames. This is what makes "in order" mean in order.
    cursor += (result.endIndex ?? 0) + 1;
    steps.push({ primitive, ...result });
  }

  return {
    ...session,
    state: 'PASSED',
    reason: null,
    steps,
    decidedAt: now,
    consumedAt: now,
    // The frame the face match will run on is chosen HERE, from the frames that passed --
    // not by the client. Otherwise liveness proves one image and the match runs on another.
    matchFrameHash: series[series.length - 1].frameHash ?? null,
  };
}

/** Marks a session as unusable because the provider failed -- explicitly NOT the same as the
 * person failing. Sealing "provider was down" as "this worker failed verification" would be a
 * false accusation written into immutable evidence. */
export function providerError(session, now = Date.now()) {
  return { ...session, state: 'PROVIDER_ERROR', reason: 'provider_unavailable', decidedAt: now };
}
