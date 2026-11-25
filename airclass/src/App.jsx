import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  GestureEngine,
  DEFAULT_THRESHOLDS,
  PINCH_GESTURES,
  getNormalizedHandSeparation,
  getExtendedFingerCount,
  hasIsolatedPinchPose,
  mapToScreen,
  pinchRatio,
} from "./gesture/GestureEngine.js";
import { useCalibration } from "./hooks/useCalibration.js";
import { MCQS, DRAG, TaskSelect, TaskScroll, TaskDrag } from "./lesson/Lesson.jsx";
import PortalEntry from "./components/PortalEntry.jsx";
import {
  loadProfiles,
  saveProfile,
  loadResults,
  saveResult,
  clearResults,
} from "./storage.js";
import "./index.css";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const VIRTUAL_CAMERA_PATTERN = /virtual|eshare|obs|manycam|snap camera|splitcam/i;

function chooseCamera(devices, selectedId, activeId) {
  const activeCamera = devices.find((device) => device.deviceId === activeId);
  return (
    devices.find((device) => device.deviceId === selectedId) ||
    (activeCamera && !VIRTUAL_CAMERA_PATTERN.test(activeCamera.label)
      ? activeCamera
      : null) ||
    devices.find((device) => !VIRTUAL_CAMERA_PATTERN.test(device.label)) ||
    activeCamera ||
    devices[0]
  );
}

const TEACHER_SLIDES = [
  {
    title: "Today: How plants make food",
    body: "Plants use sunlight, water, and carbon dioxide to make their own food.",
    prompt: "Ask: What does a plant need from the Sun?",
  },
  {
    title: "Follow the sunlight",
    body: "Chlorophyll in the leaves captures sunlight and provides energy for the process.",
    prompt: "Point out the leaves in the diagram.",
  },
  {
    title: "A quick knowledge check",
    body: "Invite learners to answer the lesson questions, then review the green answers.",
    prompt: "Use thumb + index to choose an answer.",
  },
];

export default function App() {
  // ---------- refs (per-frame mutable state) ----------
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const cursorRef = useRef(null);
  const appRef = useRef(null);
  const scrollRef = useRef(null);
  const engineRef = useRef(null);
  const landmarkerRef = useRef(null);
  const rafRef = useRef(0);
  const camRef = useRef(null);
  const lastVideoTime = useRef(-1);
  const cmdFired = useRef(null); // set from render each frame -> latest closures
  const cursorElRef = useRef(null);
  const cameraSelectionRef = useRef("");
  const trackingMessageRef = useRef("");
  const zoomGestureRef = useRef({
    active: false,
    candidateSince: null,
    startDistance: 0,
    startZoom: 100,
  });
  const indexRearmRef = useRef(false);
  const zoomLevelRef = useRef(100);
  const lastZoomDisplayAtRef = useRef(0);
  const thresholdsRef = useRef(DEFAULT_THRESHOLDS);

  // ---------- scroll/swipe gesture (open-hand vertical swipe) ----------
  const scrollGestureRef = useRef({
    phase: "idle", // idle -> armed -> swiping -> cooldown
    armedAt: 0,
    lastY: 0,
    lastX: 0,
    cooldownUntil: 0,
  });

  // lesson state in refs
  const selected = useRef({});
  const placed = useRef({});
  const zoneResults = useRef({});
  const dragGhost = useRef(null);
  const undoStack = useRef([]);
  const restTest = useRef({ active: false, fired: 0, doneAt: 0 });
  const cmdCount = useRef(0);
  const activity = useRef({
    active: false,
    startedAt: 0,
    fired: 0,
    q1Done: false,
    placed: 0,
  });
  const elemAt = useRef(null);
  const cursorSmooth = useRef(null);
  const uploadRequestRef = useRef(0);
  const materialPreviewRef = useRef(null);

  // ---------- react state (low-frequency UI only) ----------
  const [camStatus, setCamStatus] = useState("starting");
  const [camError, setCamError] = useState("");
  const [cameraDevices, setCameraDevices] = useState([]);
  const [cameraId, setCameraId] = useState("");
  const [cameraRestart, setCameraRestart] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [zoomStatus, setZoomStatus] = useState(
    "Pinch thumb + index on both hands, then move hands apart or together.",
  );
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [status, setStatus] = useState("Loading hand tracking…");
  const [profiles, setProfiles] = useState(loadProfiles);
  const [profileName, setProfileName] = useState("");
  const [activeProfile, setActiveProfile] = useState("");
  const [useCalib, setUseCalib] = useState(false);
  const [results, setResults] = useState(loadResults);
  const [toasts, setToasts] = useState([]);
  const [restBanner, setRestBanner] = useState("");
  const [activityInfo, setActivityInfo] = useState("");
  const [selUI, setSelUI] = useState({}); // mirrored, low-freq for ring ticks only
  const [sigUI, setSigUI] = useState({
    index: 1,
    middle: 1,
    ring: 1,
    pinky: 1,
    idxTh: DEFAULT_THRESHOLDS.index,
    midTh: DEFAULT_THRESHOLDS.middle,
    ringTh: DEFAULT_THRESHOLDS.ring,
    pinkyTh: DEFAULT_THRESHOLDS.pinky,
    state: {
      index: "IDLE",
      middle: "IDLE",
      ring: "IDLE",
      pinky: "IDLE",
    },
  });
  const [profileSel, setProfileSel] = useState("");
  const [tickUI, setTickUI] = useState({}); // zone results mirror
  const [portalSession, setPortalSession] = useState(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [teacherMaterial, setTeacherMaterial] = useState(null);
  const [speakerNotes, setSpeakerNotes] = useState("");
  const [materialSlides, setMaterialSlides] = useState([]);
  const [materialSlideIndex, setMaterialSlideIndex] = useState(0);
  const [materialPageCount, setMaterialPageCount] = useState(0);
  const [materialPageIndex, setMaterialPageIndex] = useState(1);
  const [quizQuestions, setQuizQuestions] = useState(MCQS);
  const [quizSource, setQuizSource] = useState("");
  const [quizMaterialId, setQuizMaterialId] = useState(null);
  const [quizStatus, setQuizStatus] = useState("");
  const materialUrlRef = useRef(null);

  function updateTrackingMessage(message) {
    if (trackingMessageRef.current === message) return;
    trackingMessageRef.current = message;
    setStatus(message);
  }

  function handleCameraChange(event) {
    const nextCameraId = event.target.value;
    cameraSelectionRef.current = nextCameraId;
    setCameraId(nextCameraId);
    setCameraRestart((version) => version + 1);
  }

  // ---------- toasts ----------
  const toast = useCallback((msg, kind = "info") => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  useEffect(
    () => () => {
      if (materialUrlRef.current) {
        URL.revokeObjectURL(materialUrlRef.current);
      }
    },
    [],
  );

  async function uploadTeachingMaterial(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!["pdf", "ppt", "pptx"].includes(extension)) {
      toast("Choose a PDF, PPT, or PPTX file.", "bad");
      event.target.value = "";
      return;
    }
    event.target.value = "";
    const requestId = ++uploadRequestRef.current;
    if (materialUrlRef.current) {
      URL.revokeObjectURL(materialUrlRef.current);
    }
    const url = URL.createObjectURL(file);
    materialUrlRef.current = url;
    setTeacherMaterial({
      id: requestId,
      file,
      url,
      isPdf: extension === "pdf",
    });
    setMaterialSlides([]);
    setMaterialSlideIndex(0);
    setMaterialPageCount(0);
    setMaterialPageIndex(1);
    setQuizStatus("Reading lesson text and preparing a quiz…");
    try {
      const {
        createDocumentQuizBySections,
        extractPdfText,
        extractPptxSlides,
      } = await import("./lesson/documentQuiz.js");
      let documentSections;
      if (extension === "pdf") {
        const pdf = await extractPdfText(file);
        if (requestId !== uploadRequestRef.current) return;
        documentSections = pdf.pages;
        setMaterialPageCount(pdf.pageCount);
      } else if (extension === "pptx") {
        const slides = await extractPptxSlides(file);
        if (requestId !== uploadRequestRef.current) return;
        setMaterialSlides(slides);
        documentSections = slides;
      } else {
        throw new Error(
          "Legacy .ppt files cannot be read in the browser. Save this presentation as .pptx or PDF, then upload it again.",
        );
      }

      const questions = createDocumentQuizBySections(documentSections);
      if (requestId !== uploadRequestRef.current) return;
      selected.current = {};
      setSelUI({});
      setQuizQuestions(questions);
      setQuizSource(file.name);
      setQuizMaterialId(requestId);
      setQuizStatus(
        `Created ${questions.length} page- or slide-linked quiz questions from ${file.name}.`,
      );
      toast(`Quiz updated from ${file.name}`, "ok");
    } catch (error) {
      if (requestId !== uploadRequestRef.current) return;
      const message =
        error instanceof Error ? error.message : "Could not read this file.";
      setQuizStatus(`Quiz was not changed: ${message}`);
      toast(`Could not create quiz: ${message}`, "bad");
    }
  }

  function leavePortal() {
    if (calibCtl.calib) calibCtl.cancel();
    resetWebpageZoom();
    uploadRequestRef.current += 1;
    if (materialUrlRef.current) {
      URL.revokeObjectURL(materialUrlRef.current);
      materialUrlRef.current = null;
    }
    setTeacherMaterial(null);
    setSpeakerNotes("");
    setMaterialSlides([]);
    setMaterialSlideIndex(0);
    setMaterialPageCount(0);
    setPortalSession(null);
  }

  async function toggleMaterialFullscreen() {
    const preview = materialPreviewRef.current;
    if (!preview) {
      toast("Upload a PDF or PPTX file to present it.", "info");
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await preview.requestFullscreen();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Fullscreen is unavailable.";
      toast(`Could not open presentation: ${message}`, "bad");
    }
  }

  // ---------- signals from landmarks ----------
  const computeSignals = useCallback(() => {
    const res = lastResultRef.current;
    if (!res || !res.landmarks || !res.landmarks[0]) return null;
    const lm = res.landmarks[0];
    const scale = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
    const pinches = {
      index: pinchRatio(lm[4], lm[8], scale),
      middle: pinchRatio(lm[4], lm[12], scale),
      ring: pinchRatio(lm[4], lm[16], scale),
      pinky: pinchRatio(lm[4], lm[20], scale),
    };
    return {
      ...pinches,
      validPinches: Object.fromEntries(
        PINCH_GESTURES.map((gesture) => [
          gesture,
          hasIsolatedPinchPose(lm, gesture),
        ]),
      ),
      extendedFingerCount: getExtendedFingerCount(lm),
      hands: res.landmarks,
      lm,
    };
  }, []);
  const lastResultRef = useRef(null);

  // ---------- calibration ----------
  const calibCtl = useCalibration(calibTickSignals(), toast);

  function calibTickSignals() {
    return () => {
      const res = lastResultRef.current;
      if (!res || !res.landmarks || !res.landmarks[0]) return null;
      const lm = res.landmarks[0];
      const scale = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
      return {
        index: pinchRatio(lm[4], lm[8], scale),
        middle: pinchRatio(lm[4], lm[12], scale),
        ring: pinchRatio(lm[4], lm[16], scale),
        pinky: pinchRatio(lm[4], lm[20], scale),
      };
    };
  }

  // ---------- engine ----------
  const getThresholds = () => {
    if (useCalib && activeProfile && profiles[activeProfile]?.thresholds) {
      return {
        ...DEFAULT_THRESHOLDS,
        ...profiles[activeProfile].thresholds,
      };
    }
    return DEFAULT_THRESHOLDS;
  };
  thresholdsRef.current = getThresholds();

  function applyWebpageZoom(value, now = performance.now(), force = false) {
    const level = Math.round(Math.max(70, Math.min(160, value)));
    if (force || level !== zoomLevelRef.current) {
      zoomLevelRef.current = level;
      if (appRef.current) {
        appRef.current.style.zoom = level === 100 ? "" : `${level}%`;
      }
    }
    if (now - lastZoomDisplayAtRef.current >= 100) {
      lastZoomDisplayAtRef.current = now;
      setZoomLevel(level);
    }
  }

  function adjustWebpageZoom(amount) {
    const level = Math.round(
      Math.max(70, Math.min(160, zoomLevelRef.current + amount)),
    );
    applyWebpageZoom(level, performance.now(), true);
    setZoomLevel(level);
  }

  function resetWebpageZoom() {
    zoomGestureRef.current = {
      active: false,
      candidateSince: null,
      startDistance: 0,
      startZoom: zoomLevelRef.current,
    };
    indexRearmRef.current = true;
    applyWebpageZoom(100, performance.now(), true);
    setZoomLevel(100);
    setZoomStatus("Zoom reset. Pinch thumb + index on both hands to zoom.");
  }

  function updateTwoHandZoom(hands, now) {
    const zoom = zoomGestureRef.current;
    const wasEngaged = zoom.active || zoom.candidateSince !== null;
    const endZoom = () => {
      if (!wasEngaged) return false;
      zoomGestureRef.current = {
        active: false,
        candidateSince: null,
        startDistance: 0,
        startZoom: zoomLevelRef.current,
      };
      indexRearmRef.current = true;
      setZoomStatus("Zoom ended. One-hand gestures are ready.");
      return true;
    };

    if (!hands || hands.length < 2) return endZoom();
    const firstHand = hands[0];
    const secondHand = hands[1];
    const firstScale = Math.hypot(
      firstHand[0].x - firstHand[9].x,
      firstHand[0].y - firstHand[9].y,
    );
    const secondScale = Math.hypot(
      secondHand[0].x - secondHand[9].x,
      secondHand[0].y - secondHand[9].y,
    );
    const firstPinch = pinchRatio(firstHand[4], firstHand[8], firstScale);
    const secondPinch = pinchRatio(secondHand[4], secondHand[8], secondScale);
    const thresholds = thresholdsRef.current.index;
    const pinchLimit =
      zoom.active || zoom.candidateSince !== null
        ? thresholds.end
        : thresholds.start;
    const bothPinching =
      firstPinch <= pinchLimit &&
      secondPinch <= pinchLimit &&
      hasIsolatedPinchPose(firstHand, "index") &&
      hasIsolatedPinchPose(secondHand, "index");
    const separation = getNormalizedHandSeparation(firstHand, secondHand);
    if (!bothPinching || !separation) return endZoom();

    indexRearmRef.current = true;
    if (zoom.candidateSince === null) {
      zoom.candidateSince = now;
      setZoomStatus("Hold both pinches, then move your hands apart or together.");
    }
    if (!zoom.active && now - zoom.candidateSince >= 350) {
      zoom.active = true;
      zoom.startDistance = separation;
      zoom.startZoom = zoomLevelRef.current;
      setZoomStatus("Two-hand zoom active. Spread or bring your hands together.");
    }
    if (zoom.active && zoom.startDistance > 1e-6) {
      applyWebpageZoom(
        zoom.startZoom * (separation / zoom.startDistance),
        now,
      );
    }
    return true;
  }

  const ensureEngine = () => {
    if (!engineRef.current) {
      engineRef.current = new GestureEngine(thresholdsRef.current, {
        onCommand: (cmd) => {
          cmdFired.current?.(cmd);
        },
      });
    }
    return engineRef.current;
  };

  useEffect(() => {
    engineRef.current?.setThresholds(getThresholds());
  }, [useCalib, activeProfile, profiles]);

  // ---------- camera + loop ----------
  useEffect(() => {
    if (!portalSession) return undefined;
    let cancelled = false;
    setCamStatus("starting");
    setCamError("");
    updateTrackingMessage("Starting camera and hand tracking…");
    (async () => {
      let stream;
      try {
        const vision = await import("@mediapipe/tasks-vision");
        const files = await vision.FilesetResolver.forVisionTasks(WASM_URL);
        const modelSources = [
          "/hand_landmarker.task", // same-origin first (works on Netlify)
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", // CDN fallback
        ];
        const createLandmarker = async (modelAssetPath, delegate) =>
          vision.HandLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath, delegate },
            runningMode: "VIDEO",
            numHands: 2,
          });
        let landmarker = null;
        for (const modelAssetPath of modelSources) {
          for (const delegate of ["GPU", "CPU"]) {
            try {
              landmarker = await createLandmarker(modelAssetPath, delegate);
              break;
            } catch (error) {
              if (delegate === "CPU") {
                // both delegates failed for this model source -> try next source
              }
            }
          }
          if (landmarker) break;
        }
        if (!landmarker) {
          throw new Error(
            "Hand-tracking model could not be loaded. Check your internet connection and reload.",
          );
        }
        if (cancelled) return;
        landmarkerRef.current = landmarker;
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            !window.isSecureContext
              ? "Camera access requires HTTPS (or localhost). If you deployed over plain HTTP, open the site with an https:// address."
              : "This browser does not provide webcam access.",
          );
        }
        const requestCamera = async (deviceId) => {
          const constraints = deviceId
            ? { video: { deviceId: { exact: deviceId } } }
            : { video: { facingMode: "user" } };
          try {
            return await navigator.mediaDevices.getUserMedia(constraints);
          } catch (error) {
            if (deviceId) {
              // selected camera may have been unplugged -> fall back to default
              return await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user" },
              });
            }
            throw error;
          }
        };
        const selectedCameraId = cameraSelectionRef.current;
        stream = await requestCamera(selectedCameraId);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        camRef.current = stream;
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === "videoinput",
        );
        if (cancelled) return;
        setCameraDevices(devices);
        const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
        const preferredCamera = chooseCamera(
          devices,
          selectedCameraId,
          activeDeviceId,
        );
        if (
          preferredCamera?.deviceId &&
          preferredCamera.deviceId !== activeDeviceId
        ) {
          stream.getTracks().forEach((track) => track.stop());
          if (camRef.current === stream) camRef.current = null;
          stream = await requestCamera(preferredCamera.deviceId);
          if (cancelled) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          camRef.current = stream;
        }
        if (cancelled) return;
        const activeTrack = stream.getVideoTracks()[0];
        const activeCameraId =
          activeTrack?.getSettings().deviceId ||
          preferredCamera?.deviceId ||
          "";
        cameraSelectionRef.current = activeCameraId;
        setCameraId(activeCameraId);
        lastResultRef.current = null;
        lastVideoTime.current = -1;
        const v = videoRef.current;
        if (!v) throw new Error("The camera preview is unavailable.");
        v.srcObject = stream;
        await v.play().catch(() => {}); // some browsers reject play() before metadata; the loop waits for readyState
        if (cancelled) return;
        setCamStatus("on");
        updateTrackingMessage(
          `Camera ready — ${activeTrack?.label || "webcam"}. Show one hand in frame.`,
        );
      } catch (e) {
        if (cancelled) return;
        camRef.current?.getTracks().forEach((track) => track.stop());
        camRef.current = null;
        landmarkerRef.current?.close();
        landmarkerRef.current = null;
        const denied =
          e?.name === "NotAllowedError" || e?.name === "SecurityError";
        const notFound = e?.name === "NotFoundError" || e?.name === "OverconstrainedError";
        setCamStatus("err");
        setCamError(
          denied
            ? "Camera permission denied. AirClass needs your webcam to track hand gestures — nothing ever leaves your device. Click the camera icon in your browser address bar and allow access, then reload."
            : notFound
              ? "No camera was found on this device. Connect a webcam (or allow camera access for a built-in one) and reload."
              : `Camera/tracking error: ${e?.message || e}`,
        );
        updateTrackingMessage("Camera unavailable");
      }
    })();
    return () => {
      cancelled = true;
      camRef.current?.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(rafRef.current);
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, [portalSession, cameraRestart]);

  // ---------- main per-frame loop ----------
  useEffect(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const v = videoRef.current,
        lm = landmarkerRef.current;
      if (!v || v.readyState < 2 || !lm) return;
      if (v.currentTime === lastVideoTime.current) {
        /* reuse last result */
      } else {
        lastVideoTime.current = v.currentTime;
        try {
          lastResultRef.current = lm.detectForVideo(v, performance.now());
        } catch {
          /* */
        }
      }
      const now = performance.now();
      drawOverlay();
      const calibRunning = calibCtl.tick(now);
      const sig = computeSignals();
      if (calibRunning) return;
      if (!sig) {
        updateTrackingMessage(
          "Camera is live, but no hand is detected. Move one hand into view.",
        );
        return;
      }
      updateTrackingMessage(
        sig.extendedFingerCount < 2
          ? "Open your hand and keep two fingers extended; a closed fist is ignored."
          : "Hand detected — gestures active.",
      );
      // scroll/swipe gesture gets priority when an open hand is armed
      if (updateScrollGesture(sig, now)) {
        updateCursor(null, "IDLE");
        return;
      }
      // cursor + engine
      const eng = ensureEngine();
      if (updateTwoHandZoom(sig.hands, now)) {
        eng.reset();
        eng.ema = Object.fromEntries(PINCH_GESTURES.map((gesture) => [gesture, 1]));
        eng._prevFired = { ...eng.state };
        const idleSignals = Object.fromEntries(
          PINCH_GESTURES.map((gesture) => [gesture, 1]),
        );
        const { ema } = eng.update(now, idleSignals);
        updateCursor(null, "IDLE");
        updateSignalBars(ema, eng.state);
        return;
      }
      const gestureSignals = Object.fromEntries(
        PINCH_GESTURES.map((gesture) => [
          gesture,
          sig.validPinches[gesture] &&
          !(gesture === "index" && indexRearmRef.current)
            ? sig[gesture]
            : 1,
        ]),
      );
      if (indexRearmRef.current && sig.index > thresholdsRef.current.index.end) {
        indexRearmRef.current = false;
        gestureSignals.index = sig.validPinches.index ? sig.index : 1;
      }
      const { ema } = eng.update(now, gestureSignals);
      updateCursor(
        sig.extendedFingerCount >= 2 ? cursorPos(sig.lm) : null,
        eng.state.index,
      );
      const cmds = collectCommands(eng);
      if (cmds.length && !pausedRef.current)
        cmds.forEach((c) => cmdFired.current?.(c));
      updateSignalBars(ema, eng.state);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // calibration is handled inside loop above via calibCtl.tick

  function cursorPos(lm) {
    return { x: lm[8].x, y: lm[8].y };
  }

  /**
   * Scroll gesture: open flat hand (all 5 fingers extended, no pinch),
   * hold still ~0.4s to arm, then move up/down. Each gesture cycle scrolls
   * the lesson box. Swipe left/right = page/slide navigation.
   * Returns true while the scroll gesture "owns" the frame.
   */
  function updateScrollGesture(sig, now) {
    const g = scrollGestureRef.current;
    const HAND = sig.hands?.[0];
    const openHand =
      sig.extendedFingerCount >= 4 &&
      sig.validPinches.index &&
      sig.validPinches.middle &&
      sig.validPinches.ring &&
      sig.validPinches.pinky;

    if (!openHand || !HAND) {
      if (g.phase === "swiping") {
        g.phase = "cooldown";
        g.cooldownUntil = now + 500;
      } else if (g.phase === "cooldown" && now >= g.cooldownUntil) {
        g.phase = "idle";
      }
      return false;
    }
    if (g.phase === "cooldown") {
      if (now >= g.cooldownUntil) g.phase = "idle";
      return true; // still hold ownership until cooldown finishes
    }

    const y = HAND[9].y; // middle MCP — stable, doesn't move when fingers pinch
    const x = HAND[9].x;
    const handScale = Math.hypot(HAND[0].x - HAND[9].x, HAND[0].y - HAND[9].y) || 0.1;

    if (g.phase === "idle") {
      // start arming but DON'T own the frame yet — cursor keeps working
      // until the user actually holds still and starts swiping
      g.phase = "armed";
      g.armedAt = now;
      g.lastY = y;
      g.lastX = x;
      return false;
    }

    if (g.phase === "armed") {
      const moved = Math.hypot(x - g.lastX, y - g.lastY) / handScale;
      if (moved > 0.35) {
        // hand moved too much while arming -> restart (cursor stays active)
        g.armedAt = now;
        g.lastY = y;
        g.lastX = x;
        return false;
      }
      if (now - g.armedAt >= 400) {
        g.phase = "swiping";
        g.lastY = y;
        g.lastX = x;
        setStatus("Scroll/swipe active — move hand up/down to scroll, left/right for slides");
        return true;
      }
      return false;
    }

    // swiping
    const dy = (y - g.lastY) / handScale; // positive = hand moved DOWN in camera (mirrored later)
    const dx = (x - g.lastX) / handScale;
    const TH = 0.55; // distance in hand-sizes to trigger one scroll step
    if (Math.abs(dy) >= TH && Math.abs(dy) >= Math.abs(dx)) {
      const down = dy > 0;
      undoStack.current.push({ type: "scroll", prev: scrollRef.current?.scrollTop ?? 0 });
      scrollRef.current?.scrollBy({ top: down ? 260 : -260, behavior: "smooth" });
      toast(down ? "Scrolled down ↓" : "Scrolled up ↑", "info");
      g.lastY = y;
      g.lastX = x;
    } else if (Math.abs(dx) >= TH * 1.4) {
      changePresentation(dx > 0 ? 1 : -1);
      toast(dx > 0 ? "Next page/slide →" : "← Previous page/slide", "info");
      g.lastY = y;
      g.lastX = x;
    }
    return true;
  }

  function drawOverlay() {
    const c = canvasRef.current,
      v = videoRef.current;
    if (!c || !v) return;
    if (c.width !== v.videoWidth) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    const hands = lastResultRef.current?.landmarks;
    if (!hands?.length) return;
    ctx.fillStyle = "#34d1bf";
    for (const hand of hands) {
      for (const p of hand) {
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, 3.2, 0, 7);
        ctx.fill();
      }
    }
  }

  function updateCursor(pos, state) {
    const el = cursorRef.current;
    if (!el || !pos) {
      if (el) el.style.opacity = 0;
      elemAt.current?.classList?.remove("target");
      elemAt.current = null;
      cursorSmooth.current = null;
      return;
    }
    if (!cursorSmooth.current) {
      cursorSmooth.current = pos;
    } else {
      const dx = pos.x - cursorSmooth.current.x;
      const dy = pos.y - cursorSmooth.current.y;
      // dead-zone: ignore jitter smaller than this (in camera space) so the
      // cursor holds still when the hand is still
      const DEAD = 0.006;
      const dist = Math.hypot(dx, dy);
      let ax, ay;
      if (dist < DEAD) {
        ax = 0;
        ay = 0;
      } else {
        // grow smoothing strength with speed: fast moves catch up quickly,
        // slow moves stay damped (no jitter, no lag feel)
        const alpha = Math.min(0.55, 0.18 + dist * 14);
        ax = alpha * (dx - DEAD * Math.sign(dx));
        ay = alpha * (dy - DEAD * Math.sign(dy));
      }
      cursorSmooth.current = {
        x: cursorSmooth.current.x + ax,
        y: cursorSmooth.current.y + ay,
      };
    }
    pos = cursorSmooth.current;
    el.style.opacity = 1;
    const { x, y } = mapToScreen(pos.x, pos.y);
    el.style.transform = `translate(${x - 26}px, ${y - 26}px)`;
    el.dataset.state = state || "IDLE";
    const ring = el.querySelector(".ring");
    if (ring) ring.style.strokeDasharray = `${state === "CANDIDATE" ? 80 : 0} 999`;
    // highlight target under cursor
    const under = document.elementFromPoint(x, y);
    const target = under?.closest(
      "[data-air-option],[data-air-label],[data-air-zone],[data-air-section]",
    );
    if (target !== elemAt.current) {
      elemAt.current?.classList?.remove("target");
      target?.classList?.add("target");
      elemAt.current = target;
    }
  }

  function collectCommands(eng) {
    const cmds = [];
    const prev = eng._prevFired || {};
    // index pinch edges
    if (eng.state.index === "ACTIVE" && prev.index !== "ACTIVE") {
      const pt = screenPointUnderCursor();
      cmds.push({ type: "grab", x: pt.x, y: pt.y, gesture: "index" });
    }
    if (eng.state.index === "RELEASE" && prev.index === "ACTIVE") {
      const pt = screenPointUnderCursor();
      cmds.push({ type: "drop", x: pt.x, y: pt.y, gesture: "index" });
    }
    eng._prevFired = { ...eng.state };
    return cmds;
  }

  function screenPointUnderCursor() {
    const el = cursorRef.current;
    if (!el) return { x: -1, y: -1 };
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
      el.style.transform,
    );
    if (!m) return { x: -1, y: -1 };
    return { x: parseFloat(m[1]) + 26, y: parseFloat(m[2]) + 26 };
  }

  function scrollToNextSection() {
    const box = scrollRef.current;
    if (!box) return;
    const secs = [...box.querySelectorAll("[data-air-section]")];
    const cur = secs.findIndex(
      (section) =>
        section.offsetTop - 6 <= box.scrollTop &&
        section.offsetTop + section.offsetHeight > box.scrollTop + 6,
    );
    const next = secs[cur + 1];
    if (!next) {
      toast("Already at the last question", "info");
      return;
    }
    undoStack.current.push({ type: "scroll", prev: box.scrollTop });
    box.scrollTo({ top: next.offsetTop - 4, behavior: "smooth" });
    toast("Scrolled to next section ↓", "info");
  }

  function scrollToPreviousSection() {
    const box = scrollRef.current;
    if (!box) return;
    const secs = [...box.querySelectorAll("[data-air-section]")];
    const cur = secs.findIndex(
      (section) =>
        section.offsetTop - 6 <= box.scrollTop &&
        section.offsetTop + section.offsetHeight > box.scrollTop + 6,
    );
    const previous = secs[cur - 1];
    if (!previous) {
      toast("Already at the first section", "info");
      return;
    }
    undoStack.current.push({ type: "scroll", prev: box.scrollTop });
    box.scrollTo({ top: previous.offsetTop - 4, behavior: "smooth" });
    toast("Scrolled to previous section ↑", "info");
  }

  function changeSlide(direction) {
    setSlideIndex((index) =>
      Math.min(TEACHER_SLIDES.length - 1, Math.max(0, index + direction)),
    );
  }

  function changeUploadedSlide(direction) {
    setMaterialSlideIndex((index) =>
      Math.min(materialSlides.length - 1, Math.max(0, index + direction)),
    );
  }

  function changePdfPage(direction) {
    setMaterialPageIndex((index) =>
      Math.min(materialPageCount, Math.max(1, index + direction)),
    );
  }

  function changePresentation(direction) {
    if (teacherMaterial?.isPdf && materialPageCount) {
      changePdfPage(direction);
    } else if (materialSlides.length > 0) {
      changeUploadedSlide(direction);
    } else {
      changeSlide(direction);
    }
  }

  let lastSigPush = 0;
  function updateSignalBars(ema, state) {
    const now = performance.now();
    if (now - lastSigPush < 100) return;
    lastSigPush = now;
    const th = thresholdsRef.current;
    setSigUI({
      index: ema.index,
      middle: ema.middle,
      ring: ema.ring,
      pinky: ema.pinky,
      idxTh: th.index,
      midTh: th.middle,
      ringTh: th.ring,
      pinkyTh: th.pinky,
      state: { ...state },
    });
  }

  // ---------- commands: handled in an effect that wires cmdFired ----------
  const handleCommand = useCallback(
    (cmd) => {
      if (pausedRef.current && cmd.kind !== "pause") return;
      if (cmd.kind === "next") {
        cmd = { ...cmd, type: "next" };
      } else if (cmd.kind === "previous") {
        cmd = { ...cmd, type: "previous" };
      } else if (cmd.kind === "pause") {
        cmd = { ...cmd, type: "pause" };
      }
      if (restTest.current.active) {
        restTest.current.fired += 1;
        toast(
          `Rest test: accidental activation #${restTest.current.fired} (NOT executed)`,
          "bad",
        );
        return;
      }
      if (activity.current.active) activity.current.fired += 1;
      cmdCount.current += 1;
      if (cmd.type === "grab") {
        const el = document
          .elementFromPoint(cmd.x, cmd.y)
          ?.closest("[data-air-label]");
        if (!el) return;
        const i = Number(el.dataset.airLabel);
        if (placed.current[i] != null) {
          toast("That label is already placed", "info");
          return;
        }
        undoStack.current.push({
          type: "drag",
          prev: { ...placed.current },
          label: i,
        });
        dragGhost.current = {
          label: i,
          x: cmd.x,
          y: cmd.y,
          ax: cmd.x,
          ay: cmd.y,
        };
        setStatus("Label grabbed — move cursor, pinch again to drop");
        toast("Grabbed label — pinch again to drop", "info");
      } else if (cmd.type === "drop") {
        const g = dragGhost.current;
        dragGhost.current = null;
        setDragTick((t) => t + 1);
        if (!g) return;
        const zoneEl = document
          .elementFromPoint(cmd.x, cmd.y)
          ?.closest("[data-air-zone]");
        if (!zoneEl) {
          toast("Dropped outside zone — nothing happened (Undo: Z)", "bad");
          return;
        }
        const zi = Number(zoneEl.dataset.airZone);
        const correct = DRAG.zones[zi].correct === g.label;
        undoStack.current.push({
          type: "drag",
          prev: { ...placed.current },
          label: g.label,
        });
        placed.current[g.label] = zi;
        zoneResults.current[zi] = correct;
        setTickUI({ ...zoneResults.current });
        if (correct) {
          toast("Dropped: correct ✓", "ok");
          activity.current.placed += 1;
          checkActivityDone();
        } else toast("Dropped: incorrect ✗", "bad");
      } else if (cmd.type === "next") {
        if (portalSession?.role === "teacher") {
          changePresentation(1);
        } else {
          scrollToNextSection();
        }
      } else if (cmd.type === "previous") {
        if (portalSession?.role === "teacher") {
          changePresentation(-1);
        } else {
          scrollToPreviousSection();
        }
      } else if (cmd.type === "pause") {
        togglePause();
      }
    },
    [
      toast,
      portalSession?.role,
      teacherMaterial?.isPdf,
      materialSlides.length,
      materialPageCount,
    ],
  );

  // selection (task 1) happens on release over an option, or grab over option = select
  function handleOptionSelect(questionIndex, optionIndex) {
    if (restTest.current.active) {
      restTest.current.fired++;
      toast(
        `Rest test: accidental activation #${restTest.current.fired}`,
        "bad",
      );
      return;
    }
    cmdCount.current += 1;
    if (activity.current.active) activity.current.fired += 1;
    undoStack.current.push({
      type: "select",
      prev: { ...selected.current },
    });
    selected.current = {
      ...selected.current,
      [questionIndex]: optionIndex,
    };
    setSelUI({ ...selected.current });
    if (optionIndex === quizQuestions[questionIndex].answer) {
      toast(`Question ${questionIndex + 1}: correct ✓`, "ok");
      activity.current.q1Done = quizQuestions.every(
        (_, index) => selected.current[index] === quizQuestions[index].answer,
      );
      checkActivityDone();
    } else {
      toast(
        `Question ${questionIndex + 1}: ${quizQuestions[questionIndex].options[optionIndex]}`,
        "bad",
      );
    }
  }

  useEffect(() => {
    cmdFired.current = (cmd) => {
      // intercept index pinch over MCQ options: treat as select
      if (cmd.type === "grab") {
        const el = document
          .elementFromPoint(cmd.x, cmd.y)
          ?.closest("[data-air-option]");
        if (el) {
          const i = Number(el.dataset.airOption);
          const q = Number(el.dataset.airQuestion || 0);
          if (restTest.current.active) {
            restTest.current.fired++;
            toast(
              `Rest test: accidental activation #${restTest.current.fired}`,
              "bad",
            );
            return;
          }
          handleOptionSelect(q, i);
          return;
        }
      }
      handleCommand(cmd);
    };
  }, [handleCommand, quizQuestions]);

  // cursor DOM update on selection for instant ring? (ring is per-frame in loop)

  const [dragTick, setDragTick] = useState(0); // forces redraw when dragGhost changes

  function checkActivityDone() {
    const a = activity.current;
    if (a.active && a.q1Done && Object.keys(placed.current).length >= 3) {
      a.active = false;
      const secs = (performance.now() - a.startedAt) / 1000;
      setActivityInfo(
        `Lesson complete in ${secs.toFixed(1)}s — ${a.fired} commands fired`,
      );
      setResults(
        saveResult({
          profile: activeProfile || "(none)",
          mode: useCalib ? "calibrated" : "default",
          test: "activity",
          value: `${secs.toFixed(1)}s / ${a.fired} cmds`,
        }),
      );
      toast("Lesson complete! 🎉", "ok");
    }
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        togglePause();
      }
      if (e.key.toLowerCase() === "z") undo();
      if (
        e.code === "ArrowRight" &&
        portalSession?.role === "teacher" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
      ) {
        e.preventDefault();
        changePresentation(1);
      }
      if (
        e.code === "ArrowLeft" &&
        portalSession?.role === "teacher" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
      ) {
        e.preventDefault();
        changePresentation(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [portalSession, teacherMaterial?.isPdf, materialSlides.length, materialPageCount]);

  function togglePause() {
    setPaused((p) => {
      const np = !p;
      pausedRef.current = np;
      if (np) {
        // cancel any drag in progress
        dragGhost.current = null;
        engineRef.current?.reset();
        setDragTick((t) => t + 1);
        setStatus("Recognition paused (drag cancelled)");
      } else setStatus("Recognition resumed");
      return np;
    });
  }

  function undo() {
    const u = undoStack.current.pop();
    if (!u) {
      toast("Nothing to undo", "info");
      return;
    }
    if (u.type === "select") {
      selected.current = u.prev;
      setSelUI(u.prev);
      toast("Undid selection", "info");
    } else if (u.type === "drag") {
      // remove that label's placement
      placed.current = { ...u.prev };
      zoneResults.current = {};
      for (const [li, zi] of Object.entries(placed.current)) {
        zoneResults.current[zi] = DRAG.zones[zi].correct === Number(li);
      }
      setTickUI({ ...zoneResults.current });
      setDragTick((t) => t + 1);
      toast("Undid label placement", "info");
    } else if (u.type === "scroll") {
      scrollRef.current?.scrollTo({ top: u.prev, behavior: "smooth" });
      toast("Undid scroll", "info");
    }
    if (activity.current.active)
      activity.current.placed = Object.keys(placed.current).length;
  }

  // ---------- profile / calibration saving ----------
  const saveCalib = useCallback(function saveCalib(thresholds) {
    if (!profileName.trim()) {
      toast("Enter a profile name first", "bad");
      return;
    }
    const p = saveProfile(profileName.trim(), { thresholds });
    setProfiles({ ...p });
    setActiveProfile(profileName.trim());
    setProfileSel(profileName.trim());
    engineRef.current?.setThresholds(thresholds);
  }, [profileName, activeProfile]);

  function startCalibration() {
    if (!videoRef.current || camStatus !== "on") {
      toast("Camera must be running to calibrate", "bad");
      return;
    }
    if (!profileName.trim()) { toast("Enter a profile name first", "bad"); return; }
    undoStack.current = [];
    calibCtl.start();
  }

  // wire calibration completion (hook fires a custom event with thresholds)
  useEffect(() => {
    const h = (e) => saveCalib(e.detail);
    window.addEventListener("airclass-calib-saved", h);
    return () => window.removeEventListener("airclass-calib-saved", h);
  }, [saveCalib]);

  // ---------- rest test ----------
  function startRestTest() {
    restTest.current = {
      active: true,
      fired: 0,
      doneAt: performance.now() + 30000,
    };
    setRestBanner(
      "REST TEST running — do nothing. Commands are counted but NOT executed.",
    );
    const iv = setInterval(() => {
      if (performance.now() >= restTest.current.doneAt) {
        clearInterval(iv);
        restTest.current.active = false;
        setRestBanner("");
        const f = restTest.current.fired;
        setResults(
          saveResult({
            profile: activeProfile || "(none)",
            mode: useCalib ? "calibrated" : "default",
            test: "rest-30s",
            value: `${f} accidental`,
          }),
        );
        toast(
          `Rest test done: ${f} accidental activations`,
          f === 0 ? "ok" : "bad",
        );
      }
    }, 500);
  }

  function startActivity() {
    selected.current = {};
    placed.current = {};
    zoneResults.current = {};
    setTickUI({});
    undoStack.current = [];
    cmdCount.current = 0;
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    activity.current = {
      active: true,
      startedAt: performance.now(),
      fired: 0,
      q1Done: false,
      placed: 0,
    };
    setSelUI({});
    setActivityInfo("Activity running… timer started");
    setResults(
      saveResult({
        profile: activeProfile || "(none)",
        mode: useCalib ? "calibrated" : "default",
        test: "activity-start",
        value: "started",
      }),
    );
    toast("Activity started — timer running ⏱", "ok");
  }

  // ---------- thresholds display ----------
  const th = getThresholds();
  const activeMaterialIndex = teacherMaterial?.isPdf
    ? materialPageIndex - 1
    : materialSlideIndex;
  const showPageQuiz =
    portalSession?.role === "teacher" &&
    teacherMaterial?.id === quizMaterialId;
  const allQuizEntries = quizQuestions.map((question, index) => ({
    question,
    index,
  }));
  const visibleQuizEntries = showPageQuiz
    ? allQuizEntries.filter(
        ({ question }) => question.sourceIndex === activeMaterialIndex,
      )
    : allQuizEntries;

  if (!portalSession) {
    return <PortalEntry onEnter={setPortalSession} />;
  }

  return (
    <div className="app" ref={appRef}>
      <header className="topbar">
        <div className="logo">AC</div>
        <div>
          <h1>AirClass</h1>
          <div className="tag">
            {portalSession.role === "teacher"
              ? `Teacher portal · ${portalSession.name}${portalSession.className ? ` · ${portalSession.className}` : ""}`
              : `Student portal · ${portalSession.name}${portalSession.className ? ` · ${portalSession.className}` : ""}`}
          </div>
        </div>
        <div className={`cam-status ${camStatus}`}>
          {camStatus === "on"
            ? "● Camera live"
            : camStatus === "err"
              ? "● Camera error"
              : "● Starting…"}
        </div>
        <button
          className="portal-exit"
          onClick={leavePortal}
          type="button"
        >
          Switch portal
        </button>
      </header>

      {camError && (
        <div className="card" style={{ borderLeft: "4px solid var(--danger)" }}>
          ⚠️ {camError}
        </div>
      )}
      {restBanner && <div className="test-banner">{restBanner}</div>}

      <div className="layout">
        {/* ---------------- LEFT: lesson ---------------- */}
        <div>
          {portalSession.role === "teacher" && (
            <section className="card teacher-deck" aria-label="Teaching slides">
              <div className="deck-topline">
                <span className="entry-eyebrow">TEACHER PRESENTATION</span>
                <span>
                  SLIDE {slideIndex + 1} / {TEACHER_SLIDES.length}
                </span>
              </div>
              <div className="deck-progress">
                <span
                  style={{
                    width: `${((slideIndex + 1) / TEACHER_SLIDES.length) * 100}%`,
                  }}
                />
              </div>
              <div className="deck-content">
                <h2>{TEACHER_SLIDES[slideIndex].title}</h2>
                <p>{TEACHER_SLIDES[slideIndex].body}</p>
                <div className="teacher-prompt">
                  <strong>Teaching prompt</strong>
                  <span>{TEACHER_SLIDES[slideIndex].prompt}</span>
                </div>
              </div>
              <div className="deck-controls">
                <button
                  disabled={slideIndex === 0}
                  onClick={() => changeSlide(-1)}
                  type="button"
                >
                  ← Previous slide
                </button>
                <button
                  className="primary"
                  disabled={slideIndex === TEACHER_SLIDES.length - 1}
                  onClick={() => changeSlide(1)}
                  type="button"
                >
                  Next slide →
                </button>
              </div>
              <p className="deck-hint">
                Middle pinch: next · Ring pinch: previous · ← / → also work.
              </p>
            </section>
          )}
          {portalSession.role === "teacher" && (
            <section className="card material-card">
              <div className="material-heading">
                <div>
                  <h2>Share a lesson file</h2>
                  <p>
                    Add a PDF or PowerPoint to present alongside your class.
                  </p>
                </div>
                <span className="material-badge">TEACHER ONLY</span>
              </div>
              <label className="upload-button">
                <span>＋ Choose PDF or PowerPoint</span>
                <input
                  accept=".pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                  onChange={uploadTeachingMaterial}
                  type="file"
                />
              </label>
              {teacherMaterial && (
                <div className="material-file">
                  <div className="material-file-info">
                    <span className="file-type">
                      {teacherMaterial.isPdf ? "PDF" : "PPT"}
                    </span>
                    <strong>{teacherMaterial.file.name}</strong>
                    <span>
                      {(teacherMaterial.file.size / (1024 * 1024)).toFixed(1)}{" "}
                      MB
                    </span>
                  </div>
                  <a
                    className="material-download"
                    download={teacherMaterial.file.name}
                    href={teacherMaterial.url}
                  >
                    Download
                  </a>
                  <button
                    onClick={() => {
                      uploadRequestRef.current += 1;
                      URL.revokeObjectURL(teacherMaterial.url);
                      materialUrlRef.current = null;
                      setTeacherMaterial(null);
                      setMaterialSlides([]);
                      setMaterialPageCount(0);
                      setMaterialPageIndex(1);
                      setQuizStatus("File removed. The current quiz is unchanged.");
                    }}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              )}
              {teacherMaterial?.isPdf ? (
                <>
                  <div className="presentation-toolbar">
                    <span>PDF presentation</span>
                    <button onClick={toggleMaterialFullscreen} type="button">
                      ⛶ Present full screen
                    </button>
                  </div>
                  <div
                    className="material-presentation pdf-presentation"
                    ref={materialPreviewRef}
                  >
                    <div className="pdf-presentation-controls">
                      <button
                        disabled={materialPageIndex <= 1}
                        onClick={() => changePresentation(-1)}
                        type="button"
                      >
                        ← Previous page
                      </button>
                      <span>
                        Page {materialPageIndex} of {materialPageCount}
                      </span>
                      <button
                        disabled={materialPageIndex >= materialPageCount}
                        onClick={() => changePresentation(1)}
                        type="button"
                      >
                        Next page →
                      </button>
                    </div>
                    <iframe
                      className="pdf-preview"
                      src={`${teacherMaterial.url}#page=${materialPageIndex}`}
                      title={`Preview of ${teacherMaterial.file.name}`}
                    />
                  </div>
                </>
              ) : teacherMaterial && materialSlides.length > 0 ? (
                <>
                  <div className="presentation-toolbar">
                    <span>
                      Slide {materialSlideIndex + 1} of {materialSlides.length}
                    </span>
                    <button onClick={toggleMaterialFullscreen} type="button">
                      ⛶ Present full screen
                    </button>
                  </div>
                  <div
                    className="material-presentation slide-presentation"
                    ref={materialPreviewRef}
                  >
                    <article className="imported-slide">
                      <span>
                        {teacherMaterial.file.name} · SLIDE{" "}
                        {materialSlideIndex + 1}
                      </span>
                      <p>{materialSlides[materialSlideIndex]}</p>
                    </article>
                    <div className="imported-slide-controls">
                      <button
                        disabled={materialSlideIndex === 0}
                        onClick={() => changePresentation(-1)}
                        type="button"
                      >
                        ← Previous
                      </button>
                      <button
                        className="primary"
                        disabled={
                          materialSlideIndex >= materialSlides.length - 1
                        }
                        onClick={() => changePresentation(1)}
                        type="button"
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                  <p className="presentation-format-note">
                    This browser preview shows slide text. For original
                    PowerPoint layouts, pictures, and diagrams, export the
                    presentation to PDF and upload that instead.
                  </p>
                </>
              ) : teacherMaterial ? (
                <div className="powerpoint-note">
                  {teacherMaterial.file.name.toLowerCase().endsWith(".ppt")
                    ? "This older .ppt file is ready to download, but its slides cannot be read in the browser. Save it as .pptx or PDF for presentation and quiz generation."
                    : "Reading the PowerPoint slides… If they contain no readable text, save the presentation as PDF and upload that version."}
                </div>
              ) : (
                <div className="upload-empty">
                  <span className="upload-empty-icon">▤</span>
                  <strong>No file added yet</strong>
                  <span>PDF files preview here. PPT/PPTX files stay local.</span>
                </div>
              )}
              {showPageQuiz && (
                <p className="material-quiz-link" role="status">
                  <strong>
                    Quiz for {teacherMaterial.isPdf ? "page" : "slide"}{" "}
                    {activeMaterialIndex + 1}:
                  </strong>{" "}
                  {visibleQuizEntries[0]?.question.question ??
                    "No readable quiz question was generated for this page or slide."}
                </p>
              )}
              <label className="field speaker-notes">
                Presenter notes
                <textarea
                  onChange={(event) => setSpeakerNotes(event.target.value)}
                  placeholder="Add your teaching notes, questions, or reminders…"
                  rows={4}
                  value={speakerNotes}
                />
              </label>
              <p className="material-privacy">
                How to use: choose a PDF or PPTX, press Present full screen,
                then use the page/slide buttons or finger pinches. Each page or
                slide advances with its matching quiz question. Add reminders
                in Presenter notes. Files and notes stay in this browser and
                clear when switching portals.
              </p>
              {quizStatus && (
                <p className="quiz-status" role="status">
                  {quizStatus}
                </p>
              )}
            </section>
          )}
          <div className="card">
            <h2>
              {portalSession.role === "teacher"
                ? "Class activity — Photosynthesis"
                : "Your lesson — Photosynthesis"}
            </h2>
            <div className="section-nav">
              <div
                className={
                  "section-nav-dot" +
                  (quizQuestions.every(
                    (question, index) =>
                      selUI?.[index] === question.answer,
                  )
                    ? " done"
                    : "")
                }
              >
                1
              </div>
              <div className="section-nav-dot">2</div>
              <div
                className={
                  "section-nav-dot" +
                  (Object.keys(placed.current).length >= 3 ? " done" : "")
                }
              >
                3
              </div>
              {activityInfo && (
                <div style={{ marginLeft: "auto", fontWeight: 700 }}>
                  <span className="big-timer">{activityInfo}</span>
                </div>
              )}
            </div>
            <div className="lesson-scroll" ref={scrollRef}>
              <div className="section" data-air-section="0">
                <TaskScroll onNext={scrollToNextSection} />
              </div>
              <div className="section" data-air-section="1">
                <TaskSelect
                  questions={visibleQuizEntries.map(
                    ({ question }) => question,
                  )}
                  questionIndexes={visibleQuizEntries.map(({ index }) => index)}
                  selected={selUI}
                  targetIndex={-1}
                  onSelect={handleOptionSelect}
                />
                {showPageQuiz && visibleQuizEntries.length === 0 && (
                  <p className="material-quiz-empty">
                    No readable quiz question was generated for this page or
                    slide.
                  </p>
                )}
                {quizSource && (
                  <p className="document-quiz-source">
                    Quiz questions created from <strong>{quizSource}</strong>
                  </p>
                )}
              </div>
              <div className="section" data-air-section="2">
                <TaskDrag
                  placed={placed.current}
                  results={tickUI}
                  targetLabel={dragGhost.current?.label ?? -1}
                  targetZone={-1}
                  dragging={
                    dragGhost.current
                      ? { dx: dragGhost.current.x, dy: dragGhost.current.y }
                      : null
                  }
                />
              </div>
            </div>
          </div>
          {dragGhost.current && (
            <div
              className="drag-ghost"
              style={{ left: dragGhost.current.x, top: dragGhost.current.y }}
            >
              {DRAG.labels[dragGhost.current.label]}
            </div>
          )}
        </div>

        {/* ---------------- RIGHT: control panel ---------------- */}
        <div>
          <div className="card portal-guide">
            <h2>
              {portalSession.role === "teacher"
                ? "Teacher quick guide"
                : "How to use your lesson"}
            </h2>
            {portalSession.role === "teacher" ? (
              <ol>
                <li>Use Previous / Next slide or ← / → to present.</li>
                <li>
                  With a PDF/PPTX uploaded, middle/ring pinches change the page
                  or slide and its matching quiz question.
                </li>
                <li>
                  Pinch one fingertip to your thumb while keeping two other
                  fingers open. A closed fist is ignored.
                </li>
                <li>
                  Pinch thumb + index on both hands, hold, then spread or bring
                  your hands together to zoom.
                </li>
                <li>Pinky pinch pauses/resumes; green is correct, red is a retry.</li>
                <li>Upload PDF/PPTX to present full screen and create a page- or slide-linked quiz.</li>
                <li>Open-hand swipe: hold an open hand still, then move up/down to scroll or left/right to change slides.</li>
              </ol>
            ) : (
              <ol>
                <li>Move your index finger to point at an answer.</li>
                <li>Pinch thumb + index to choose, or click an answer.</li>
                <li>Keep other fingers open; a closed fist is ignored.</li>
                <li>
                  Pinch thumb + index on both hands, hold, then spread or bring
                  your hands together to zoom.
                </li>
                <li>Green means correct; red means try another answer.</li>
                <li>Middle goes forward; ring goes back through lesson parts.</li>
                <li>Pinky pinch pauses/resumes gesture controls.</li>
              </ol>
            )}
            <p className="hint">
              Camera is optional for mouse use. Gestures work after camera
              permission is allowed.
            </p>
          </div>
          <div className="card">
            <h2>Camera preview</h2>
            <div className="video-wrap">
              <video ref={videoRef} className="preview" playsInline muted />
              <canvas ref={canvasRef} className="overlay" />
            </div>
            {cameraDevices.length > 1 && (
              <label className="field camera-select">
                Camera source
                <select value={cameraId} onChange={handleCameraChange}>
                  {cameraDevices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="status-msg">{status}</div>
            <div className="zoom-control">
              <div className="zoom-control-heading">
                <span>Page zoom</span>
                <strong>{zoomLevel}%</strong>
              </div>
              <div className="zoom-control-actions">
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => adjustWebpageZoom(-10)}
                >
                  −
                </button>
                <button type="button" onClick={resetWebpageZoom}>
                  Reset
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => adjustWebpageZoom(10)}
                >
                  +
                </button>
              </div>
              <div className="hint">{zoomStatus}</div>
              <div className="hint">
                Zoom is limited to 70–160%. Reset returns the page to 100%.
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Profile & calibration</h2>
            <label className="field">
              Profile name
              <input
                type="text"
                value={profileName}
                placeholder="e.g. Aisha (small range)"
                onChange={(e) => setProfileName(e.target.value)}
              />
            </label>
            <div className="row">
              <button
                className="warn"
                onClick={startCalibration}
                disabled={camStatus !== "on"}
              >
                🎯 Calibrate this profile
              </button>
              <button
                onClick={() => {
                  if (profileName.trim()) {
                    const p = saveProfile(profileName.trim(), {
                      thresholds: null,
                    });
                    setProfiles({ ...p });
                    setActiveProfile(profileName.trim());
                    toast(
                      `Profile "${profileName.trim()}" saved (default thresholds)`,
                      "ok",
                    );
                  } else toast("Enter a profile name", "bad");
                }}
              >
                Save profile (default)
              </button>
              <button
                onClick={() => {
                  if (!profileName.trim()) return;
                  deleteProfile(profileName.trim());
                  setProfiles(loadProfiles());
                  toast("Profile deleted", "info");
                }}
              >
                Delete
              </button>
            </div>
            <label className="field" style={{ marginTop: 10 }}>
              Saved profiles
              <select
                value={profileSel}
                onChange={(e) => {
                  setProfileSel(e.target.value);
                  setActiveProfile(e.target.value);
                  if (e.target.value)
                    toast(`Profile "${e.target.value}" selected`, "ok");
                }}
              >
                <option value="">— none —</option>
                {Object.keys(profiles).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="field"
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={useCalib}
                onChange={(e) => {
                  setUseCalib(e.target.checked);
                  if (e.target.checked && !profiles[activeProfile]?.thresholds)
                    toast("This profile has no calibration saved yet", "bad");
                  else
                    toast(
                      e.target.checked
                        ? "Using CALIBRATED thresholds"
                        : "Using DEFAULT thresholds",
                      "info",
                    );
                }}
              />
              Use calibrated thresholds (off = default)
            </label>
            <div className="status-msg calib">
              {calibCtl.calibStatus || "Calibration status appears here."}
            </div>
            {calibCtl.calib && (
              <button style={{ marginTop: 8 }} onClick={calibCtl.cancel}>
                Cancel calibration
              </button>
            )}
            {activeProfile && profiles[activeProfile]?.thresholds && (
              <div className="hint">
                Calibrated: index start{" "}
                {profiles[activeProfile].thresholds.index.start.toFixed(2)} /
                end {profiles[activeProfile].thresholds.index.end.toFixed(2)} ·
                middle start{" "}
                  {profiles[activeProfile].thresholds.middle.start.toFixed(2)} ·
                  ring start{" "}
                  {profiles[activeProfile].thresholds.ring?.start?.toFixed(2) ??
                    "default"}{" "}
                  · pinky start{" "}
                  {profiles[activeProfile].thresholds.pinky?.start?.toFixed(2) ??
                    "default"}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Control</h2>
            <div className="btn-row">
              <button
                className={paused ? "warn" : "primary"}
                onClick={togglePause}
              >
                {paused ? "▶ Resume" : "⏸ Pause"}
                <span className="kbd">Space</span>
              </button>
              <button onClick={undo}>
                ↩ Undo<span className="kbd">Z</span>
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Live signal (why did it fire?)</h2>
            <SignalBar
              name="Index pinch"
              v={sigUI.index}
              th={sigUI.idxTh}
              state={sigUI.state.index}
              cls="index"
            />
            <SignalBar
              name="Middle pinch"
              v={sigUI.middle}
              th={sigUI.midTh}
              state={sigUI.state.middle}
              cls="middle"
            />
            <SignalBar
              name="Ring pinch"
              v={sigUI.ring}
              th={sigUI.ringTh}
              state={sigUI.state.ring}
              cls="ring"
            />
            <SignalBar
              name="Pinky pinch"
              v={sigUI.pinky}
              th={sigUI.pinkyTh}
              state={sigUI.state.pinky}
              cls="pinky"
            />
            <div className="hint">
              White marker = start threshold (fire), grey = end threshold
              (stop). Bar below white = gesture detected.
            </div>
          </div>

          <div className="card">
            <h2>Tests</h2>
            <div className="btn-row">
              <button className="primary" onClick={startActivity}>
                ▶ Start activity
              </button>
              <button className="danger" onClick={startRestTest}>
                🧪 30-second rest test
              </button>
            </div>
            <div className="hint">
              Activity: resets lesson + timer; logs completion time & commands.
              Rest test: counts accidental activations (not executed).
            </div>
          </div>

          <div className="card">
            <h2>Results</h2>
            <table className="results">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Mode</th>
                  <th>Test</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {results.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--muted)" }}>
                      No results yet — calibrate two profiles, run activity &
                      rest tests.
                    </td>
                  </tr>
                )}
                {results
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <tr key={i}>
                      <td>{r.profile}</td>
                      <td>{r.mode}</td>
                      <td>{r.test}</td>
                      <td>{r.value}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="btn-row">
              <button onClick={() => setResults(clearResults())}>
                Clear results
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Gestures</h2>
            <div className="hint">
              👆 <strong>Index pinch</strong> (thumb + index): select option ·
              grab/drop label.
              <br />
              🤞 <strong>Middle pinch</strong> (thumb + middle): scroll to next
              section.
              <br />
              🤘 <strong>Ring pinch</strong> (thumb + ring): previous slide or
              section.
              <br />
              🤙 <strong>Pinky pinch</strong> (thumb + pinky): pause/resume.
              <br />
              🖐️ <strong>Open-hand swipe</strong> (all 5 fingers open, hold
              ~0.4s): move hand up/down to scroll the page, left/right to change
              pages or slides.
              <br />
              Pinch one fingertip to your thumb while keeping at least two other
              fingers open. Closed fists are ignored. Calibrate all four
              pinches; hold about 0.25 seconds to fire, or use the mouse.
              <br />
              To zoom, pinch thumb + index on both hands, hold briefly, then move
              your hands apart or together. Release both pinches to return to
              normal gestures.
            </div>
          </div>
        </div>
      </div>

      {/* cursor */}
      <div id="air-cursor" ref={cursorRef} style={{ opacity: 0 }}>
        <svg width="52" height="52" viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="10" fill="rgba(52,209,191,.9)" />
          <circle
            className="ring"
            cx="26"
            cy="26"
            r="20"
            fill="none"
            stroke="rgba(52,209,191,.35)"
            strokeWidth="4"
          />
        </svg>
      </div>

      <div className="toast-zone">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function SignalBar({ name, v, th, state, cls }) {
  const pct = Math.min(100, Math.max(0, v * 100));
  return (
    <div className="signal">
      <div className="sig-label">
        <span>{name}</span>
        <span>
          {state} · {v.toFixed(2)}
        </span>
      </div>
      <div className="sig-track">
        <div className={`sig-fill ${cls}`} style={{ width: `${pct}%` }} />
        <div
          className="sig-mark start"
          style={{ left: `${th.start * 100}%` }}
        />
        <div className="sig-mark end" style={{ left: `${th.end * 100}%` }} />
      </div>
    </div>
  );
}
