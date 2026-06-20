/**
 * Hand Gesture → WebGL Fluid
 * MediaPipe Hands → fingertip positions → fluid splats
 * Attaches to the original PavelDoGreat fluid via window.pointers / window.fluidCanvas
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const FINGER_TIPS  = [4, 8, 12, 16, 20];   // thumb, index, middle, ring, pinky
  const SMOOTHING    = 0.5;
  const MIN_MOVE     = 0.002;
  const PTR_ID_BASE  = 100;

  // Bright fluid colors for each finger
  const FLUID_COLORS = [
    { r: 1.0, g: 0.2, b: 0.1 },   // red   – thumb
    { r: 0.1, g: 0.7, b: 1.0 },   // cyan  – index
    { r: 0.2, g: 1.0, b: 0.3 },   // green – middle
    { r: 0.8, g: 0.1, b: 1.0 },   // purple– ring
    { r: 1.0, g: 0.6, b: 0.0 },   // orange– pinky
  ];

  // ── State ───────────────────────────────────────────────────────────────────
  const fingerState = {};   // key → { id, x, y, prevX, prevY, active, fresh, color }
  let videoEl       = null;
  let previewCanvas = null;
  let previewCtx    = null;
  let handsModel    = null;
  let mpCamera      = null;
  let cameraActive  = false;
  let statusEl      = null;

  // ── Boot ────────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', buildUI);
  // Also try immediately in case DOM is already ready
  if (document.readyState !== 'loading') buildUI();

  // ── UI ──────────────────────────────────────────────────────────────────────
  function buildUI () {
    if (statusEl) return;   // already built

    statusEl = document.createElement('div');
    Object.assign(statusEl.style, {
      position: 'fixed', bottom: '20px', left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.65)',
      backdropFilter: 'blur(12px)',
      border: '1px solid rgba(255,255,255,0.18)',
      color: '#fff', fontFamily: 'system-ui, sans-serif', fontSize: '14px',
      padding: '9px 22px', borderRadius: '24px', zIndex: '9999',
      cursor: 'pointer', userSelect: 'none',
      transition: 'border-color 0.3s, background 0.3s',
      whiteSpace: 'nowrap',
    });
    statusEl.textContent = '📷 开启手势控制';
    statusEl.addEventListener('click', () => cameraActive ? stopCamera() : startCamera());
    document.body.appendChild(statusEl);

    // Hidden video element for webcam feed
    videoEl = document.createElement('video');
    videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true;
    videoEl.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:0;left:0;';
    document.body.appendChild(videoEl);

    // Small mirrored preview + skeleton overlay
    previewCanvas = document.createElement('canvas');
    previewCanvas.width  = 320; previewCanvas.height = 240;
    Object.assign(previewCanvas.style, {
      position: 'fixed', bottom: '66px', left: '20px',
      width: '160px', height: '120px',
      borderRadius: '10px', display: 'none', zIndex: '9998',
      border: '1px solid rgba(255,255,255,0.15)',
      transform: 'scaleX(-1)',
      pointerEvents: 'none',
    });
    previewCtx = previewCanvas.getContext('2d');
    document.body.appendChild(previewCanvas);
  }

  // ── Camera ──────────────────────────────────────────────────────────────────
  async function startCamera () {
    setStatus('⏳ 加载中…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
      videoEl.srcObject = stream;
      await new Promise(r => { videoEl.onloadedmetadata = r; });
      videoEl.play();
      cameraActive = true;
      previewCanvas.style.display = 'block';
      setStatus('✋ 手势识别中  ·  点击关闭', 'rgba(48,209,88,0.6)');
      await initMediaPipe();
    } catch (e) {
      setStatus('❌ ' + e.message);
    }
  }

  function stopCamera () {
    if (mpCamera)   { try { mpCamera.stop(); }   catch (_) {} mpCamera   = null; }
    if (handsModel) { try { handsModel.close(); } catch (_) {} handsModel = null; }
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    cameraActive = false;
    previewCanvas.style.display = 'none';
    releaseAllFingers();
    previewCtx.clearRect(0, 0, 320, 240);
    setStatus('📷 开启手势控制', 'rgba(255,255,255,0.18)');
  }

  function setStatus (text, borderColor) {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (borderColor) statusEl.style.borderColor = borderColor;
  }

  // ── MediaPipe Hands ──────────────────────────────────────────────────────────
  async function initMediaPipe () {
    const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240';

    // Load scripts if not already present
    await loadScript(`${CDN}/hands.js`);
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js');

    handsModel = new Hands({
      locateFile: f => `${CDN}/${f}`,
    });
    handsModel.setOptions({
      maxNumHands:           2,
      modelComplexity:       1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence:  0.5,
    });
    handsModel.onResults(onHandResults);

    mpCamera = new Camera(videoEl, {
      onFrame: async () => { if (cameraActive) await handsModel.send({ image: videoEl }); },
      width: 640, height: 480,
    });
    mpCamera.start();
  }

  function loadScript (src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── Hand results → finger state ──────────────────────────────────────────────
  function onHandResults (results) {
    // Draw preview
    previewCtx.clearRect(0, 0, 320, 240);
    previewCtx.drawImage(videoEl, 0, 0, 320, 240);

    const seenKeys = new Set();

    if (results.multiHandLandmarks) {
      results.multiHandLandmarks.forEach((landmarks, handIdx) => {
        const extended = getExtendedFingers(landmarks);
        drawSkeleton(landmarks, extended);

        extended.forEach(fingerIdx => {
          const key = `${handIdx}_${fingerIdx}`;
          const tip = landmarks[FINGER_TIPS[fingerIdx]];
          // Mirror X so hand matches visual feedback
          const fx = 1.0 - tip.x;
          const fy = tip.y;

          seenKeys.add(key);

          if (!fingerState[key]) {
            fingerState[key] = {
              id:    PTR_ID_BASE + handIdx * 5 + fingerIdx,
              x: fx, y: fy,
              prevX: fx, prevY: fy,
              active: true,
              fresh:  true,
              color:  FLUID_COLORS[fingerIdx % 5],
            };
          } else {
            const s = fingerState[key];
            s.prevX = s.x; s.prevY = s.y;
            s.x = s.x * SMOOTHING + fx * (1 - SMOOTHING);
            s.y = s.y * SMOOTHING + fy * (1 - SMOOTHING);
            s.active = true;
            s.fresh  = false;
          }
        });
      });
    }

    // Release fingers no longer visible
    Object.keys(fingerState).forEach(key => {
      if (!seenKeys.has(key)) releaseFingerKey(key);
    });

    injectIntoFluid();
  }

  // ── Fluid injection ──────────────────────────────────────────────────────────
  function injectIntoFluid () {
    if (!window.fluidCanvas || !window.updatePointerMoveData) return;
    const fc  = window.fluidCanvas;
    const pts = window.pointers;

    Object.values(fingerState).forEach(fs => {
      if (!fs.active) return;
      const posX = fs.x * fc.width;
      const posY = fs.y * fc.height;

      let ptr = pts.find(p => p.id === fs.id);

      if (fs.fresh) {
        if (!ptr) {
          ptr = new window.pointerPrototype();
          pts.push(ptr);
        }
        window.updatePointerDownData(ptr, fs.id, posX, posY);
        ptr.color = fs.color;
      } else {
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
    if (window.pointers && window.updatePointerUpData) {
      const ptr = window.pointers.find(p => p.id === fs.id);
      if (ptr) window.updatePointerUpData(ptr);
    }
    delete fingerState[key];
  }

  function releaseAllFingers () {
    Object.keys(fingerState).forEach(releaseFingerKey);
  }

  // ── Finger extension detection ────────────────────────────────────────────────
  function getExtendedFingers (lm) {
    const ext = [];
    // Thumb: tip far from wrist in X
    if (Math.abs(lm[4].x - lm[0].x) > 0.07) ext.push(0);
    // Fingers 1-4: tip above PIP joint in Y (lower Y = higher on screen)
    const joints = [[8,6],[12,10],[16,14],[20,18]];
    joints.forEach(([tip, pip], i) => {
      if (lm[tip].y < lm[pip].y - 0.02) ext.push(i + 1);
    });
    return ext;
  }

  // ── Preview skeleton drawing ──────────────────────────────────────────────────
  const CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
  ];
  const TIP_COLORS = ['#FF6B6B','#4DC8FF','#6BFF7A','#C77DFF','#FFB347'];

  function drawSkeleton (lm, extended) {
    const W = 320, H = 240;
    const ctx = previewCtx;
    // Bones
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth   = 1.5;
    CONNECTIONS.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(lm[a].x * W, lm[a].y * H);
      ctx.lineTo(lm[b].x * W, lm[b].y * H);
      ctx.stroke();
    });
    // Fingertip dots (only extended)
    extended.forEach(fi => {
      const tip = lm[FINGER_TIPS[fi]];
      ctx.beginPath();
      ctx.arc(tip.x * W, tip.y * H, 5, 0, Math.PI * 2);
      ctx.fillStyle = TIP_COLORS[fi];
      ctx.fill();
    });
  }

})();
