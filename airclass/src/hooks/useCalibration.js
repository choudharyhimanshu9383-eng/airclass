import { useRef, useState, useCallback } from "react";
import {
  buildThresholds,
  isCalibrationValid,
} from "../gesture/GestureEngine.js";

const CALIBRATION_GESTURES = [
  { gesture: "index", label: "index" },
  { gesture: "middle", label: "middle" },
  { gesture: "ring", label: "ring" },
  { gesture: "pinky", label: "pinky" },
];

/**
 * Drives the calibration flow for one profile.
 * Each pinch: 3s REST then 3s ACTIVE, samples collected per frame.
 */
export const CALIB_STEPS = CALIBRATION_GESTURES.flatMap(
  ({ gesture, label }, index) => [
    {
      gesture,
      phase: "rest",
      ms: 3000,
      prompt: `${index === 0 ? "Relax your hand" : "Relax your hand again"} — keep your ${label} finger open…`,
    },
    {
      gesture,
      phase: "active",
      ms: 3000,
      prompt: `Pinch your ${label} finger + thumb and HOLD; keep your other fingers open…`,
    },
  ],
);

export function useCalibration(computeSignals, toast) {
  const [calib, setCalib] = useState(null); // {step, startedAt, progress}
  const [calibStatus, setCalibStatus] = useState("");
  const calibRef = useRef(null);
  const store = useRef({
    index: { rest: [], active: [] },
    middle: { rest: [], active: [] },
    ring: { rest: [], active: [] },
    pinky: { rest: [], active: [] },
  });

  const start = useCallback(() => {
    store.current = {
      index: { rest: [], active: [] },
      middle: { rest: [], active: [] },
      ring: { rest: [], active: [] },
      pinky: { rest: [], active: [] },
    };
    const next = { step: 0, startedAt: performance.now() };
    calibRef.current = next;
    setCalib(next);
    setCalibStatus(CALIB_STEPS[0].prompt);
  }, []);

  const cancel = useCallback(() => {
    calibRef.current = null;
    setCalib(null);
    setCalibStatus("");
  }, []);

  /** Call every frame while calibrating. Returns true while running. */
  const tick = useCallback(
    (now) => {
      const prev = calibRef.current;
      if (!prev) return false;
      const step = CALIB_STEPS[prev.step];
      const el = now - prev.startedAt;
      const sig = computeSignals();
      if (sig) {
        const bucket = store.current[step.gesture];
        bucket[step.phase].push(sig[step.gesture]);
      }
      if (el >= step.ms) {
        const nextStep = prev.step + 1;
        if (nextStep >= CALIB_STEPS.length) {
          finish(now);
          calibRef.current = null;
          setCalib(null);
          return false;
        }
        const next = { step: nextStep, startedAt: now };
        calibRef.current = next;
        setCalib(next);
        setCalibStatus(CALIB_STEPS[nextStep].prompt);
      } else {
        setCalibStatus(`${step.prompt}  ${Math.ceil((step.ms - el) / 1000)}s`);
      }
      return true;
    },
    [computeSignals],
  );

  const finish = (now) => {
    const s = store.current;
    const t = {};
    for (const g of CALIBRATION_GESTURES.map((item) => item.gesture)) {
      t[g] = buildThresholds(s[g].rest, s[g].active);
    }
    const invalidGesture = CALIBRATION_GESTURES.find(
      ({ gesture }) => !isCalibrationValid(t[gesture]),
    );
    setCalib(null);
    if (invalidGesture) {
      const bad = invalidGesture.label;
      setCalibStatus(
        `Calibration rejected: ${bad} pinch too similar to rest (Δ=${t[invalidGesture.gesture].delta.toFixed(2)}). Move your finger more and try again.`,
      );
      toast("Calibration rejected — try again with a bigger difference", "bad");
      return null;
    }
    setCalibStatus(
      `Calibration saved ✓ for all four finger pinches`,
    );
    toast("Calibration saved ✓", "ok");
    window.dispatchEvent(
      new CustomEvent("airclass-calib-saved", {
        detail: {
          index: { start: t.index.start, end: t.index.end },
          middle: { start: t.middle.start, end: t.middle.end },
          ring: { start: t.ring.start, end: t.ring.end },
          pinky: { start: t.pinky.start, end: t.pinky.end },
        },
      }),
    );
    return t;
  };

  return { calib, calibStatus, start, cancel, tick };
}
