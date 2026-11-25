/**
 * GestureEngine.js — testable, framework-free intent recognition.
 *
 * Per-gesture state machine: IDLE -> CANDIDATE -> ACTIVE -> RELEASE
 * - hold ~250ms in CANDIDATE before ACTIVE (early release cancels)
 * - hysteresis: separate start / end thresholds (no flicker)
 * - EMA smoothing on the raw signal
 * - edge-triggered: one command per gesture, 400ms cooldown after release
 * - middle pinch is suppressed while index pinch is ACTIVE
 *
 * Signals are normalized by hand size = |wrist(0) - middleMCP(9)|,
 * so they are scale invariant (works close and far from the camera).
 */

export const HOLD_MS = 250;
export const COOLDOWN_MS = 400;
export const PINCH_GESTURES = ["index", "middle", "ring", "pinky"];

const FINGER_JOINTS = {
  index: { mcp: 5, pip: 6, tip: 8 },
  middle: { mcp: 9, pip: 10, tip: 12 },
  ring: { mcp: 13, pip: 14, tip: 16 },
  pinky: { mcp: 17, pip: 18, tip: 20 },
};

export const DEFAULT_THRESHOLDS = {
  index: { start: 0.45, end: 0.6 },
  middle: { start: 0.45, end: 0.6 },
  ring: { start: 0.45, end: 0.6 },
  pinky: { start: 0.45, end: 0.6 },
};

/* ---------- pure helpers (exported for unit testing) ---------- */

export function pinchRatio(a, b, scale) {
  if (!a || !b || !scale || scale < 1e-6) return 1;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return d / scale;
}

export function isFingerExtended(landmarks, gesture) {
  const joints = FINGER_JOINTS[gesture];
  if (!landmarks || !joints) return false;
  const mcp = landmarks[joints.mcp];
  const pip = landmarks[joints.pip];
  const tip = landmarks[joints.tip];
  if (!mcp || !pip || !tip) return false;

  const toMcp = [
    mcp.x - pip.x,
    mcp.y - pip.y,
    (mcp.z || 0) - (pip.z || 0),
  ];
  const toTip = [
    tip.x - pip.x,
    tip.y - pip.y,
    (tip.z || 0) - (pip.z || 0),
  ];
  const mcpLength = Math.hypot(...toMcp);
  const tipLength = Math.hypot(...toTip);
  if (mcpLength < 1e-6 || tipLength < 1e-6) return false;

  const cosine =
    (toMcp[0] * toTip[0] +
      toMcp[1] * toTip[1] +
      toMcp[2] * toTip[2]) /
    (mcpLength * tipLength);
  const angle =
    (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  return angle >= 150;
}

export function getExtendedFingerCount(landmarks) {
  return PINCH_GESTURES.filter((gesture) =>
    isFingerExtended(landmarks, gesture),
  ).length;
}

export function hasIsolatedPinchPose(landmarks, gesture) {
  if (!FINGER_JOINTS[gesture]) return false;
  const otherExtendedFingers = PINCH_GESTURES.filter(
    (otherGesture) =>
      otherGesture !== gesture && isFingerExtended(landmarks, otherGesture),
  ).length;
  return otherExtendedFingers >= 2;
}

export function getNormalizedHandSeparation(firstHand, secondHand) {
  if (!firstHand || !secondHand || !firstHand[0] || !firstHand[9]) return null;
  if (!secondHand[0] || !secondHand[9]) return null;

  const firstScale = Math.hypot(
    firstHand[0].x - firstHand[9].x,
    firstHand[0].y - firstHand[9].y,
  );
  const secondScale = Math.hypot(
    secondHand[0].x - secondHand[9].x,
    secondHand[0].y - secondHand[9].y,
  );
  if (firstScale < 1e-6 || secondScale < 1e-6) return null;

  const firstCenter = {
    x: (firstHand[0].x + firstHand[9].x) / 2,
    y: (firstHand[0].y + firstHand[9].y) / 2,
  };
  const secondCenter = {
    x: (secondHand[0].x + secondHand[9].x) / 2,
    y: (secondHand[0].y + secondHand[9].y) / 2,
  };
  return (
    Math.hypot(
      firstCenter.x - secondCenter.x,
      firstCenter.y - secondCenter.y,
    ) /
    ((firstScale + secondScale) / 2)
  );
}

export function median(arr) {
  if (!arr.length) return 1;
  const s = [...arr].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return 1;
  const s = [...arr].sort((x, y) => x - y);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Build thresholds from rest/active samples. Rest = median, active = 25th pct. */
export function buildThresholds(restSamples, activeSamples) {
  const rest = median(restSamples); // open hand, pinch wide
  const active = percentile(activeSamples, 25); // held pinch
  const margin = Math.max(0.06, (rest - active) * 0.25);
  const start = active + (rest - active) * 0.35; // strict start
  const end = Math.min(rest - margin * 0.5, start + 0.1); // relaxed end
  return { rest, active, start, end, delta: rest - active };
}

/** Reject calibration when rest and active are too similar. */
export function isCalibrationValid(t) {
  return t.delta > 0.14 && t.end > t.start;
}

/* ---------- the engine ---------- */

export class GestureEngine {
  constructor(thresholds, opts = {}) {
    this.thresholds = thresholds;
    this.onCommand = opts.onCommand || (() => {});
    this.suppressOtherWhileIndex = opts.suppressOtherWhileIndex !== false;
    this.ema = Object.fromEntries(PINCH_GESTURES.map((gesture) => [gesture, 1]));
    this.alpha = opts.emaAlpha || 0.35;
    this.reset();
  }

  reset() {
    this.state = Object.fromEntries(
      PINCH_GESTURES.map((gesture) => [gesture, "IDLE"]),
    );
    this.candidateSince = Object.fromEntries(
      PINCH_GESTURES.map((gesture) => [gesture, 0]),
    );
    this.lastReleaseAt = Object.fromEntries(
      PINCH_GESTURES.map((gesture) => [gesture, 0]),
    );
    this.now = 0;
  }

  setThresholds(t) {
    this.thresholds = t;
  }

  /** Feed one frame. Signals are normalized thumb-to-fingertip pinch ratios. */
  update(t, raw) {
    this.now = t;
    for (const g of PINCH_GESTURES) {
      // EMA smoothing
      const prev = this.ema[g];
      const value = Number.isFinite(raw[g]) ? raw[g] : 1;
      const v = prev + this.alpha * (value - prev);
      this.ema[g] = v;
      const anotherGestureActive = PINCH_GESTURES.some(
        (other) =>
          other !== g &&
          (this.state[other] === "ACTIVE" || this.state[other] === "CANDIDATE"),
      );
      if (
        g !== "index" &&
        this.suppressOtherWhileIndex &&
        anotherGestureActive
      ) {
        this.step(g, v, true);
        continue;
      }
      this.step(g, v, false);
    }
    return { ema: { ...this.ema }, state: { ...this.state } };
  }

  step(g, v, suppressed) {
    const th = this.thresholds[g] || DEFAULT_THRESHOLDS[g];
    const st = this.state[g];
    const cooling = this.now - this.lastReleaseAt[g] < COOLDOWN_MS;

    if (suppressed) {
      if (st === "CANDIDATE") this.state[g] = "IDLE";
      return;
    }

    switch (st) {
      case "IDLE":
        if (!cooling && v < th.start) {
          this.state[g] = "CANDIDATE";
          this.candidateSince[g] = this.now;
        }
        break;

      case "CANDIDATE":
        if (v > th.end) {
          this.state[g] = "IDLE"; // released too early -> cancel
        } else if (this.now - this.candidateSince[g] >= HOLD_MS) {
          this.state[g] = "ACTIVE";
          if (g !== "index") {
            const kind = {
              middle: "next",
              ring: "previous",
              pinky: "pause",
            }[g];
            this.onCommand({ gesture: g, kind, at: this.now });
            this.state[g] = "RELEASE";
            this.lastReleaseAt[g] = this.now;
          }
        }
        break;

      case "ACTIVE":
        if (g === "index") {
          if (v > th.end) {
            this.onCommand({ gesture: "index", kind: "release", at: this.now });
            this.state[g] = "RELEASE";
            this.lastReleaseAt[g] = this.now;
          }
        }
        break;

      case "RELEASE":
        if (v > th.end && this.now - this.lastReleaseAt[g] >= COOLDOWN_MS) {
          this.state[g] = "IDLE";
        }
        break;
    }
  }

  /** Did the gesture fire (edge) this frame? index fires 'grab' on ACTIVE entry. */
  firing(g) {
    return false; // commands delivered via onCommand callback instead
  }
}

/**
 * Cursor mapping: fingertip in [0..1] camera space -> screen with a margin,
 * so a small comfortable movement range covers the full screen. Mirrored.
 */
export function mapToScreen(x, y, margin = 0.22) {
  const lo = margin,
    hi = 1 - margin;
  const cx = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  const cy = Math.min(1, Math.max(0, (y - lo) / (hi - lo)));
  return {
    x: (1 - cx) * window.innerWidth, // mirror horizontally
    y: cy * window.innerHeight,
  };
}
