/**
 * signals.js — scalar gesture signals from MediaPipe hand landmarks.
 *
 * Every distance is normalized by hand size = |wrist(0) - middleMCP(9)| so the
 * signals are scale invariant (works near and far from the camera).
 * Convention: LOWER value = MORE active.
 */

export const TIPS = { index: 8, middle: 12, ring: 16, pinky: 20 };

export function handSize(lm) {
  const a = lm[0],
    b = lm[9];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Thumb-tip (4) to fingertip distance, normalized. Lower = pinched. */
export function pinchRatio(lm, tip) {
  const s = handSize(lm);
  if (s < 1e-6) return 1;
  return dist(lm[4], lm[tip]) / s;
}

/** Mean fingertip-to-wrist distance / handSize. Lower = fist. */
export function fistRatio(lm) {
  const s = handSize(lm);
  if (s < 1e-6) return 1;
  let sum = 0;
  for (const t of [8, 12, 16, 20]) sum += dist(lm[0], lm[t]);
  return sum / 4 / s;
}

/** 1 - fistRatio: LOW when the hand is wide open. */
export function openPalmRatio(lm) {
  return 1 - fistRatio(lm);
}

/** Index-fingertip wrist velocity (normalized units / second). For steadiness. */
export function wristVelocity(lm, prevLm, dtMs) {
  if (!prevLm || !dtMs || dtMs <= 0) return 0;
  const d = Math.hypot(lm[0].x - prevLm[0].x, lm[0].y - prevLm[0].y);
  return (d / dtMs) * 1000;
}

/**
 * All scalar signals for one frame, plus the cursor source point
 * (index fingertip in camera space [0..1], x NOT yet mirrored).
 */
export function signals(lm) {
  return {
    index: pinchRatio(lm, 8),
    middle: pinchRatio(lm, 12),
    ring: pinchRatio(lm, 16),
    fist: fistRatio(lm),
    openPalm: openPalmRatio(lm),
    cursor: { x: lm[8].x, y: lm[8].y },
  };
}

/* ---------- statistics used by calibration ---------- */

export function median(arr) {
  if (!arr.length) return 1;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return 1;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * Build thresholds from calibration samples.
 * rest = median of REST samples, active = 25th percentile of ACTIVE samples.
 * start = active + 0.4*(rest-active)  (strict, fires deliberately)
 * end   = active + 0.6*(rest-active)  (relaxed, releases easily)
 */
export function thresholdsFromSamples(restSamples, activeSamples) {
  const rest = median(restSamples);
  const active = percentile(activeSamples, 25);
  const delta = rest - active;
  const start = active + 0.4 * delta;
  const end = active + 0.6 * delta;
  return { rest, active, delta, start, end };
}

/** Reject calibration when rest and active are too similar. */
export function isCalibrationValid(t, minDelta = 0.12) {
  return t.delta > minDelta && t.end > t.start;
}

/**
 * Generic (uncalibrated) thresholds, so calibrated vs default can be compared.
 * Pinches/fist: open hand ~0.9-1.4, closed ~0.05-0.25.
 */
export const DEFAULT_THRESHOLDS = {
  index: { start: 0.45, end: 0.6 },
  middle: { start: 0.45, end: 0.6 },
  ring: { start: 0.45, end: 0.6 },
  fist: { start: 0.45, end: 0.6 },
  openPalm: { start: 0.18, end: 0.28 },
};

/** Cursor mapping: camera space [0..1] -> full window. Mirrors x. */
export function mapCursor(x, y, margin = 0.15) {
  const lo = margin,
    hi = 1 - margin;
  const cx = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  const cy = Math.min(1, Math.max(0, (y - lo) / (hi - lo)));
  return {
    x: (1 - cx) * window.innerWidth, // mirror horizontally
    y: cy * window.innerHeight,
  };
}

export function ema(prev, value, alpha = 0.35) {
  return prev + alpha * (value - prev);
}
