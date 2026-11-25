# AirClass ✋🎥

Hands-free classroom controls using a webcam, four one-hand gestures, and
two-hand page zoom. The video never leaves your device — everything runs in the
browser.

## Setup

```bash
cd airclass
npm install
npm run dev
```

Open http://localhost:5173 and allow camera access. When multiple cameras are
available, AirClass prefers a non-virtual camera; use **Camera source** below
the preview to switch devices if the image is blank.

## Teacher and student portals

The welcome screen offers a teacher or student demo portal. Enter a display
name; sign-in is local demo behavior and does not authenticate against a server.
Teachers get a three-slide presentation with mouse, arrow-key, and middle-pinch
navigation plus teaching prompts. Students get the lesson and quiz. Both
portals include a quick-use guide and can use the mouse if camera access is not
available.

Teachers can upload PDF or PPTX lesson material. Readable document text is
processed locally to create a sentence-completion question for each page or
slide with enough text. Moving to the next or previous page/slide also shows
its matching quiz question. PDFs display in the browser's viewer; PPTX files
get a text-only slide preview, while PDF preserves the original slide layout.
Scanned PDFs, legacy PPT files, and pages/slides with too little text cannot
generate a question. Quiz questions remain available to the student portal
for the current browser session. Presenter notes and uploaded files stay
local and are cleared when switching portals.

## Gestures

| Gesture      | Finger landmarks               | Action                          |
| ------------ | ------------------------------ | ------------------------------- |
| Index pinch  | thumb tip (4) + index tip (8)  | Select an answer or drag labels |
| Middle pinch | thumb tip (4) + middle tip (12) | Next slide or lesson section    |
| Ring pinch   | thumb tip (4) + ring tip (16)   | Previous slide or section       |
| Pinky pinch  | thumb tip (4) + pinky tip (20)  | Pause / resume gestures         |

Signals are the pinch distance normalized by hand size
(wrist 0 → middle-finger MCP 9), so they work at any distance from the camera.
The cursor is the index fingertip, mapped to the screen with a 22% margin so a
small movement range covers the whole screen.
Pinch one fingertip to your thumb while keeping at least two other fingers
extended. Closed fists are ignored. One-hand gestures do not zoom the page.

## Two-hand page zoom

Pinch thumb + index on both hands and hold briefly to engage zoom. While keeping
both pinches, spread your hands to zoom in or bring them together to zoom out.
Release both pinches to return to the other gestures. Zoom is clamped between
70% and 160%; use the on-screen controls to adjust it with the mouse or reset to
100%.

## Intent recognition (why it doesn't fire randomly)

Each pinch runs its own state machine: `IDLE → CANDIDATE → ACTIVE → RELEASE`.

- **Hold time** — the pinch must stay closed ~250 ms; releasing early cancels.
- **Hysteresis** — separate _start_ (strict) and _end_ (relaxed) thresholds.
- **Smoothing** — exponential moving average on the raw signal.
- **Edge-triggered** — one command per gesture, then 400 ms cooldown after release.
- **Priority** — middle pinch is ignored while the index pinch is active.
- **Pose check** — a pinch is accepted only when at least two other fingers are
  extended, preventing a closed fist from firing gestures.
- **Explainability** — the live signal bars show the EMA value with the start/end
  threshold markers, so you can see exactly _why_ a command fired.

State machine lives in `src/gesture/GestureEngine.js` (framework-free, unit-testable).

## Per-learner calibration

1. Type a profile name (e.g. `Himanshu (small range)`).
2. Click **Calibrate this profile**. For each finger pinch:
   - 3 s **rest** (relax, fingers open) — threshold base = _median_ of samples.
   - 3 s **active** (do the pinch and hold) — threshold base = _25th percentile_.
3. If rest and active are too similar the calibration is **rejected** and you are
   asked to retry with a bigger finger movement.
4. The profile is saved to `localStorage` with strict start / relaxed end thresholds.
5. Toggle **Use calibrated thresholds** to compare calibrated vs default at any time.

## Two-user test

1. Profile A (e.g. small movement range): calibrate, run **Start activity**
   (resets lesson + timer) and the **30-second rest test** (do nothing — every
   command that fires is counted as an accidental activation and is _not_ executed).
2. Switch to **default thresholds** (untoggle) and repeat both tests.
3. Profile B (normal movement): calibrate and repeat.
4. Compare in the **Results** table: profile · mode (calibrated/default) ·
   test (activity / rest-30s) · value.

## Controls

- **Pause / Resume** — big button or `Space`. Pausing cancels any drag in progress.
- **Undo** — big button or `Z`. Reverts the last select, label placement or scroll.
- Camera permission denied? A clear message explains how to re-enable it.

## Tech

React + Vite (JavaScript), plain CSS, `@mediapipe/tasks-vision` HandLandmarker,
PDF.js and fflate for local document reading.
Per-frame state is kept in refs; the cursor is updated via the DOM (no re-render
per frame). Profiles, thresholds and results are stored in `localStorage`.
