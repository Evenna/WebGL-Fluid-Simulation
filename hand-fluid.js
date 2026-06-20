/**
 * Hand Gesture → WebGL Fluid Control
 * Uses MediaPipe Hands to track fingertips and drive fluid splats
 * Each extended fingertip becomes an independent fluid pointer
 */

(function () {
  // ─── Config ─────────────────────────────────────────────────────────────────
  const FINGER_TIPS  = [4, 8, 12, 16, 20];   // thumb, index, middle, ring, pinky
  const SMOOTHING    = 0.45;   // position lerp (0=raw, higher=smoother but laggy)
  const MIN_MOVE     = 0.002;  // minimum normalised movement to emit splat
  const PTR_ID_BASE  = 100;    // offset so hand pointers don't clash with mouse

  // ─── State ───────────────────────────────────────────────────────────────────
  // key = "handIdx_fingerIdx"  →  { id, x, y, prevX, prevY, active, color }
  const fingerState = {};
  let videoEl       = null;
  let overlayCanvas = null;
  let overlayCtx    = null;
  let handsModel    = null;
  let mpCamera      = null;
  let cameraActive  = false;
  let statusEl      = null;

  // ─── UI ─────────────────────────────────────────────────────────────────────
  function buildUI () {
    statusEl = document.createElement('div');
    Object.assign(statusEl.style, {
      position: 'fixed', bottom: '20px', left: '20px',
      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(10px)',
      border: '1px solid rgba(255,255,255,0.18)',
      color: '#fff', fontFamily: 'monospace', fontSize: '13px',
      padding: '8px 16px', borderRadius: '10px', zIndex: '9999',
      cursor: 'pointer', userSelect: 'none', transition: 'border-color 0.3s',
    });
    statusEl.textContent = '📷 启用手势控制';
    statusEl.addEventListener('click', toggleCamera);
    document.body.appendChild(statusEl);

    // Small mirrored video preview
    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    Object.assign(videoEl.style, {
      position: 'fixed', bottom: '68px', left: '20px',
      width: '200px', height: '150px', borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.2)',
      objectFit: 'cover', display: 'none', zIndex: '9998',
      transform: 'scaleX(-1)',
    });
    document.body.appendChild(videoEl);

    // Overlay canvas for skeleton — same position, same size as preview
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width  = 640;
    overlayCanvas.height = 480;
    Object.assign(overlayCanvas.style, {
      position: 'fixed', bottom: '68px', left: '20px',
      width: '200px', height: '150px', borderRadius: '10px',
      display: 'none', zIndex: '9999', pointerEvents: 'none',
    });
    overlayCtx = overlayCanvas.getContext('2d');
    document.body.appendChild(overlayCanvas);
  }

  // ─── Camera toggle ───────────────────────────────────────────────────────────
  async function toggleCamera () {
    cameraActive ? stopCamera() : await startCamera();
  }

  async function startCamera () {
    statusEl.textContent = '⏳ 加载中…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      });
      videoEl.srcObject = stream;
      await new Promise(r => { videoEl.onloadedmetadata = r; });
      videoEl.style.display    = 'block';
      overlayCanvas.style.display = 'block';
      cameraActive = true;
      statusEl.textContent  = '✋ 手势识别中 (点击关闭)';
      statusEl.style.borderColor = 'rgba(48,209,88,0.7)';
      await initMediaPipe();
    } catch (e) {
      console.error('[HandFluid]', e);
      statusEl.textContent = '❌ 摄像头失败: ' + e.message;
    }
  }

  function stopCamera () {
    if (mpCamera) { try { mpCamera.stop(); } catch(_) {} mpCamera = null; }
    if (handsModel) { try { handsModel.close(); } catch(_) {} handsModel = null; }
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    videoEl.style.display       = 'none';
    overlayCanvas.style.display = 'none';
    cameraActive = false;
    statusEl.textContent       = '📷 启用手势控制';
    statusEl.style.borderColor = 'rgba(255,255,255,0.18)';
    // Release all hand pointers
    releaseAllFingers();
    overlayCtx.clearRect(0, 0, 640, 480);
  }

  // ─── MediaPipe init ──────────────────────────────────────────────────────────
  async function initMediaPipe () {
    // Load scripts sequentially if not present
    if (typeof window.Hands === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    }
    if (typeof window.Camera === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
    }

    handsModel = new window.Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
    });
    handsModel.setOptions({
      maxNumHands:            2,
      modelComplexity:        1,
      minDetectionConfidence: 0.65,
      minTrackingConfidence:  0.55,
    });
    handsModel.onResults(onHandResults);

    // MediaPipe Camera util drives the frame loop
    mpCamera = new window.Camera(videoEl, {
      onFrame: async () => {
        if (cameraActive && handsModel) {
          await handsModel.send({ image: videoEl });
        }
      },
      width: 640, height: 480,
    });
    mpCamera.start();
    console.log('[HandFluid] MediaPipe started');
  }

  function loadScript (src) {
    return new Promise((resolve, reject) => {
      // Avoid double-loading
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s    = document.createElement('script');
      s.src      = src;
      s.onload   = resolve;
      s.onerror  = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  // ─── Per-frame results ───────────────────────────────────────────────────────
  function onHandResults (results) {
    overlayCtx.clearRect(0, 0, 640, 480);

    // Collect which keys are seen this frame
    const seenKeys = new Set();

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      results.multiHandLandmarks.forEach((landmarks, handIdx) => {
        const extended = getExtendedFingers(landmarks);
        drawSkeleton(landmarks);

        extended.forEach(fingerIdx => {
          const key  = `${handIdx}_${fingerIdx}`;
          const tip  = landmarks[FINGER_TIPS[fingerIdx]];
          // Flip X so left/right matches the mirrored preview
          const fx = 1.0 - tip.x;
          const fy = tip.y;

          seenKeys.add(key);
          drawFingertipDot(tip, fingerIdx);

          if (!fingerState[key]) {
            // First frame for this finger — register it
            fingerState[key] = {
              id:      PTR_ID_BASE + handIdx * 5 + fingerIdx,
              x:  fx, y:  fy,
              prevX: fx, prevY: fy,
              active: true,
              fresh:  true,          // will call pointerDown this tick
              color:  FLUID_COLORS[fingerIdx % 5],
            };
          } else {
            const s  = fingerState[key];
            s.prevX  = s.x;
            s.prevY  = s.y;
            s.x      = s.x * SMOOTHING + fx * (1 - SMOOTHING);
            s.y      = s.y * SMOOTHING + fy * (1 - SMOOTHING);
            s.active = true;
            s.fresh  = false;
          }
        });
      });
    }

    // Release any finger not seen this frame
    Object.keys(fingerState).forEach(key => {
      if (!seenKeys.has(key)) {
        releaseFingerKey(key);
      }
    });

    // Apply to fluid engine every frame
    injectIntoFluid();
  }

  // ─── Finger extension detection ──────────────────────────────────────────────
  function getExtendedFingers (lm) {
    const extended = [];
    // Thumb: tip x far from wrist x
    if (Math.abs(lm[4].x - lm[0].x) > 0.07) extended.push(0);
    // Other 4 fingers: tip y clearly above PIP joint (image y flipped)
    const pipJoints = [6, 10, 14, 18];
    for (let i = 1; i <= 4; i++) {
      if (lm[FINGER_TIPS[i]].y < lm[pipJoints[i - 1]].y - 0.025) {
        extended.push(i);
      }
    }
    return extended;
  }

  // ─── Fluid pointer injection ─────────────────────────────────────────────────
  function injectIntoFluid () {
    if (!window.fluidCanvas || !window.updatePointerDownData) return;
    const fc  = window.fluidCanvas;
    const pts = window.pointers;

    Object.values(fingerState).forEach(fs => {
      if (!fs.active) return;

      const posX = fs.x * fc.width;
      const posY = fs.y * fc.height;
      let   ptr  = pts.find(p => p.id === fs.id);

      if (fs.fresh) {
        // New finger — allocate pointer and call Down
        if (!ptr) {
          ptr = new window.pointerPrototype();
          pts.push(ptr);
        }
        window.updatePointerDownData(ptr, fs.id, posX, posY);
        ptr.color = fs.color;
      } else {
        // Continuing finger — only emit Move if it actually moved
        if (!ptr) return;
        const dx = Math.abs(fs.x - fs.prevX);
        const dy = Math.abs(fs.y - fs.prevY);
        if (dx > MIN_MOVE || dy > MIN_MOVE) {
          window.updatePointerMoveData(ptr, posX, posY);
        }
      }
    });
  }

  function releaseFingerKey (key) {
    const fs = fingerState[key];
    if (!fs) return;
    const ptr = window.pointers && window.pointers.find(p => p.id === fs.id);
    if (ptr && window.updatePointerUpData) window.updatePointerUpData(ptr);
    delete fingerState[key];
  }

  function releaseAllFingers () {
    Object.keys(fingerState).forEach(releaseFingerKey);
  }

  // ─── Drawing ─────────────────────────────────────────────────────────────────
  const OVERLAY_COLORS = ['#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF', '#C77DFF'];
  const FLUID_COLORS   = [
    { r: 0.30, g: 0.04, b: 0.04 },
    { r: 0.28, g: 0.28, b: 0.02 },
    { r: 0.02, g: 0.30, b: 0.06 },
    { r: 0.02, g: 0.10, b: 0.35 },
    { r: 0.25, g: 0.02, b: 0.35 },
  ];

  const CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
  ];

  function drawSkeleton (lm) {
    const ctx = overlayCtx, W = 640, H = 480;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth   = 1.5;
    CONNECTIONS.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo((1 - lm[a].x) * W, lm[a].y * H);
      ctx.lineTo((1 - lm[b].x) * W, lm[b].y * H);
      ctx.stroke();
    });
    lm.forEach(p => {
      ctx.beginPath();
      ctx.arc((1 - p.x) * W, p.y * H, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fill();
    });
    ctx.restore();
  }

  function drawFingertipDot (lm, fingerIdx) {
    const ctx   = overlayCtx;
    const W = 640, H = 480;
    const x     = (1 - lm.x) * W;
    const y     = lm.y * H;
    const color = OVERLAY_COLORS[fingerIdx % 5];
    ctx.save();
    // Glow ring
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    // Core dot
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle   = color;
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.restore();
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }

})();
