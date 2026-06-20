/**
 * Hand Gesture → WebGL Fluid Control
 * Uses MediaPipe Hands to track fingertips and drive fluid splats
 * Each extended fingertip becomes an independent fluid pointer
 */

(function () {
  // ─── Config ─────────────────────────────────────────────────────────────────
  const FINGER_TIPS = [4, 8, 12, 16, 20]; // thumb, index, middle, ring, pinky
  const FINGER_BASES = [2, 5, 9, 13, 17]; // used to check if finger is extended
  const SMOOTHING = 0.5;       // lerp smoothing (0=raw, 1=frozen)
  const MIN_MOVE = 0.003;      // minimum movement to trigger splat
  const HAND_POINTER_ID_BASE = 100; // offset to avoid clash with mouse pointers

  // ─── State ───────────────────────────────────────────────────────────────────
  const fingerState = {}; // keyed by fingerId = handIdx * 5 + fingerIdx
  let videoEl = null;
  let overlayCanvas = null;
  let overlayCtx = null;
  let handsModel = null;
  let cameraActive = false;
  let statusEl = null;

  // ─── Expose hook for fluid engine ───────────────────────────────────────────
  // We inject into window so script.js can read it (no modifications to script.js needed)
  window._handFluid = { fingerState };

  // ─── UI ─────────────────────────────────────────────────────────────────────
  function buildUI() {
    // Status badge
    statusEl = document.createElement('div');
    statusEl.id = 'hf-status';
    Object.assign(statusEl.style, {
      position: 'fixed', bottom: '20px', left: '20px',
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255,255,255,0.15)',
      color: '#fff', fontFamily: 'monospace', fontSize: '13px',
      padding: '8px 14px', borderRadius: '8px', zIndex: '999',
      cursor: 'pointer', userSelect: 'none',
      transition: 'all 0.2s',
    });
    statusEl.textContent = '📷 启用手势控制';
    statusEl.addEventListener('click', toggleCamera);
    document.body.appendChild(statusEl);

    // Hidden video
    videoEl = document.createElement('video');
    videoEl.id = 'hf-video';
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    Object.assign(videoEl.style, {
      position: 'fixed', bottom: '70px', left: '20px',
      width: '200px', height: '150px',
      borderRadius: '10px', border: '1px solid rgba(255,255,255,0.2)',
      objectFit: 'cover', display: 'none', zIndex: '998',
      transform: 'scaleX(-1)', // mirror
    });
    document.body.appendChild(videoEl);

    // Overlay canvas for skeleton drawing (mirrored, same size as video preview)
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'hf-overlay';
    Object.assign(overlayCanvas.style, {
      position: 'fixed', bottom: '70px', left: '20px',
      width: '200px', height: '150px',
      borderRadius: '10px', display: 'none', zIndex: '999',
      pointerEvents: 'none',
    });
    overlayCanvas.width = 640;
    overlayCanvas.height = 480;
    overlayCtx = overlayCanvas.getContext('2d');
    document.body.appendChild(overlayCanvas);
  }

  // ─── Camera toggle ───────────────────────────────────────────────────────────
  async function toggleCamera() {
    if (cameraActive) {
      stopCamera();
    } else {
      await startCamera();
    }
  }

  async function startCamera() {
    statusEl.textContent = '⏳ 加载中...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
      videoEl.srcObject = stream;
      videoEl.style.display = 'block';
      overlayCanvas.style.display = 'block';
      cameraActive = true;
      statusEl.textContent = '✋ 手势识别中 (点击关闭)';
      statusEl.style.borderColor = 'rgba(48,209,88,0.6)';
      await initMediaPipe();
    } catch (e) {
      statusEl.textContent = '❌ 摄像头权限被拒';
      console.error('[HandFluid] Camera error:', e);
    }
  }

  function stopCamera() {
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    videoEl.style.display = 'none';
    overlayCanvas.style.display = 'none';
    cameraActive = false;
    statusEl.textContent = '📷 启用手势控制';
    statusEl.style.borderColor = 'rgba(255,255,255,0.15)';
    // Clear all hand pointers
    Object.keys(fingerState).forEach(k => {
      fingerState[k].active = false;
    });
    if (overlayCtx) overlayCtx.clearRect(0, 0, 640, 480);
  }

  // ─── MediaPipe init ──────────────────────────────────────────────────────────
  async function initMediaPipe() {
    // Load MediaPipe Hands via CDN if not already loaded
    if (typeof Hands === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/hands.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1640029074/camera_utils.js');
    }

    handsModel = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`
    });

    handsModel.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.6,
    });

    handsModel.onResults(onHandResults);

    // Use MediaPipe Camera util for proper frame loop
    const camera = new Camera(videoEl, {
      onFrame: async () => {
        if (cameraActive) await handsModel.send({ image: videoEl });
      },
      width: 640,
      height: 480,
    });
    camera.start();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ─── Hand results handler ────────────────────────────────────────────────────
  function onHandResults(results) {
    overlayCtx.clearRect(0, 0, 640, 480);

    // Mark all fingers inactive this frame, will re-activate below
    Object.keys(fingerState).forEach(k => {
      fingerState[k].active = false;
    });

    if (!results.multiHandLandmarks) return;

    results.multiHandLandmarks.forEach((landmarks, handIdx) => {
      const extended = getExtendedFingers(landmarks);

      drawSkeleton(landmarks, extended);

      extended.forEach(fingerIdx => {
        const tipLm = landmarks[FINGER_TIPS[fingerIdx]];
        // MediaPipe coords: x/y in [0,1], x=0 is LEFT of mirrored image
        // Canvas coord: we need to map to fluid canvas (also 0-1 normalized)
        // MediaPipe x is already mirrored relative to selfie view → use as-is
        const fx = 1.0 - tipLm.x; // flip x to match natural hand direction
        const fy = tipLm.y;

        const id = handIdx * 5 + fingerIdx;
        const key = String(id);

        if (!fingerState[key]) {
          fingerState[key] = {
            id: HAND_POINTER_ID_BASE + id,
            x: fx, y: fy,
            prevX: fx, prevY: fy,
            active: true,
            color: generateFingerColor(fingerIdx),
            justActivated: true,
          };
        } else {
          const s = fingerState[key];
          s.prevX = s.x;
          s.prevY = s.y;
          // Smooth movement
          s.x = s.x * SMOOTHING + fx * (1 - SMOOTHING);
          s.y = s.y * SMOOTHING + fy * (1 - SMOOTHING);
          s.active = true;
          s.justActivated = false;
        }

        // Draw fingertip dot on overlay
        drawFingertipDot(tipLm, fingerIdx);
      });
    });

    // Apply to fluid
    injectIntoFluid();
  }

  // ─── Check which fingers are extended ───────────────────────────────────────
  function getExtendedFingers(landmarks) {
    const extended = [];
    for (let i = 0; i < 5; i++) {
      const tip = landmarks[FINGER_TIPS[i]];
      const base = landmarks[FINGER_BASES[i]];
      const mid = landmarks[FINGER_TIPS[i] - 1];

      let isExtended;
      if (i === 0) {
        // Thumb: compare x distance
        const wrist = landmarks[0];
        isExtended = Math.abs(tip.x - wrist.x) > 0.08;
      } else {
        // Other fingers: tip higher than mid joint (y axis flipped in image space)
        isExtended = tip.y < mid.y - 0.02;
      }
      if (isExtended) extended.push(i);
    }
    return extended;
  }

  // ─── Inject finger positions into fluid pointers ─────────────────────────────
  function injectIntoFluid() {
    // Access the fluid's global pointers and functions
    if (typeof window.updatePointerDownData === 'undefined') return;
    const fc = window.fluidCanvas;
    const pts = window.pointers;
    const PtrProto = window.pointerPrototype;

    Object.values(fingerState).forEach(fs => {
      const posX = fs.x * fc.width;
      const posY = fs.y * fc.height;

      // Find or create pointer for this finger
      let ptr = pts.find(p => p.id === fs.id);

      if (fs.active) {
        if (!ptr || fs.justActivated) {
          if (!ptr) {
            ptr = new PtrProto();
            pts.push(ptr);
          }
          window.updatePointerDownData(ptr, fs.id, posX, posY);
          ptr.color = fs.color;
        } else {
          const dx = Math.abs(fs.x - fs.prevX);
          const dy = Math.abs(fs.y - fs.prevY);
          if (dx > MIN_MOVE || dy > MIN_MOVE) {
            window.updatePointerMoveData(ptr, posX, posY);
          }
        }
      } else {
        if (ptr) {
          window.updatePointerUpData(ptr);
          ptr.id = -999; // orphan it
        }
      }
    });
  }

  // ─── Drawing helpers ─────────────────────────────────────────────────────────
  const FINGER_COLORS_OVERLAY = [
    '#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF', '#C77DFF'
  ];

  const FINGER_FLUID_COLORS = [
    { r: 0.3, g: 0.05, b: 0.05 },
    { r: 0.3, g: 0.3, b: 0.02 },
    { r: 0.02, g: 0.3, b: 0.05 },
    { r: 0.02, g: 0.1, b: 0.35 },
    { r: 0.25, g: 0.02, b: 0.35 },
  ];

  function generateFingerColor(fingerIdx) {
    return FINGER_FLUID_COLORS[fingerIdx % 5];
  }

  const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],         // thumb
    [0,5],[5,6],[6,7],[7,8],         // index
    [0,9],[9,10],[10,11],[11,12],    // middle
    [0,13],[13,14],[14,15],[15,16],  // ring
    [0,17],[17,18],[18,19],[19,20],  // pinky
    [5,9],[9,13],[13,17],            // palm
  ];

  function drawSkeleton(landmarks, extendedFingers) {
    const ctx = overlayCtx;
    const W = 640, H = 480;

    // Draw connections
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.5;
    HAND_CONNECTIONS.forEach(([a, b]) => {
      const la = landmarks[a], lb = landmarks[b];
      ctx.beginPath();
      ctx.moveTo((1 - la.x) * W, la.y * H);
      ctx.lineTo((1 - lb.x) * W, lb.y * H);
      ctx.stroke();
    });

    // Draw all joints
    landmarks.forEach((lm, i) => {
      ctx.beginPath();
      ctx.arc((1 - lm.x) * W, lm.y * H, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fill();
    });
  }

  function drawFingertipDot(lm, fingerIdx) {
    const ctx = overlayCtx;
    const W = 640, H = 480;
    const x = (1 - lm.x) * W;
    const y = lm.y * H;
    const color = FINGER_COLORS_OVERLAY[fingerIdx % 5];

    // Glow ring
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Core dot
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }

})();
