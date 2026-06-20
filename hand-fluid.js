/**
 * Hand Gesture → WebGL Fluid  +  Webcam Background  v4
 *
 * Root-cause fixes confirmed via browser console inspection:
 * 1. Y-flip done in shader (1.0-vUv.y), NOT in texImage2D — no UNPACK_FLIP_Y needed
 * 2. applyInputs() only checks p.moved — so we set ptr.moved=true directly every frame
 * 3. Color boosted ×12 to be visible in fluid engine
 */

(function () {
  const FINGER_TIPS = [4, 8, 12, 16, 20];
  const SMOOTHING   = 0.4;
  const MIN_MOVE    = 0.0005;
  const PTR_ID_BASE = 100;
  const COLOR_BOOST = 12.0;

  const fingerState = {};
  let videoEl       = null;
  let overlayCanvas = null;
  let overlayCtx    = null;
  let sampleCanvas  = null;
  let sampleCtx     = null;
  let handsModel    = null;
  let mpCamera      = null;
  let cameraActive  = false;
  let statusEl      = null;
  let webcamTex     = null;

  // ── UI ──────────────────────────────────────────────────────────────────────
  function buildUI () {
    statusEl = document.createElement('div');
    Object.assign(statusEl.style, {
      position: 'fixed', bottom: '20px', left: '20px',
      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(10px)',
      border: '1px solid rgba(255,255,255,0.18)',
      color: '#fff', fontFamily: 'monospace', fontSize: '13px',
      padding: '8px 16px', borderRadius: '10px', zIndex: '9999',
      cursor: 'pointer', userSelect: 'none',
    });
    statusEl.textContent = '📷 启用手势控制';
    statusEl.addEventListener('click', toggleCamera);
    document.body.appendChild(statusEl);

    videoEl = document.createElement('video');
    videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true;
    Object.assign(videoEl.style, {
      position: 'fixed', bottom: '68px', left: '20px',
      width: '200px', height: '150px', borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.2)',
      objectFit: 'cover', display: 'none', zIndex: '9998',
      transform: 'scaleX(-1)',
    });
    document.body.appendChild(videoEl);

    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = 640; overlayCanvas.height = 480;
    Object.assign(overlayCanvas.style, {
      position: 'fixed', bottom: '68px', left: '20px',
      width: '200px', height: '150px', borderRadius: '10px',
      display: 'none', zIndex: '9999', pointerEvents: 'none',
    });
    overlayCtx = overlayCanvas.getContext('2d');
    document.body.appendChild(overlayCanvas);

    sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 128; sampleCanvas.height = 96;
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  }

  // ── Camera ───────────────────────────────────────────────────────────────────
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
      videoEl.style.display = 'block';
      overlayCanvas.style.display = 'block';
      cameraActive = true;
      statusEl.textContent = '✋ 手势识别中 (点击关闭)';
      statusEl.style.borderColor = 'rgba(48,209,88,0.7)';
      initWebcamTexture();
      window._webcamUpdateDye = uploadWebcamTexture;
      await initMediaPipe();
    } catch (e) {
      console.error('[HandFluid]', e);
      statusEl.textContent = '❌ 摄像头失败: ' + e.message;
    }
  }

  function stopCamera () {
    if (mpCamera)   { try { mpCamera.stop();    } catch (_) {} mpCamera   = null; }
    if (handsModel) { try { handsModel.close(); } catch (_) {} handsModel = null; }
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    videoEl.style.display = 'none';
    overlayCanvas.style.display = 'none';
    cameraActive = false;
    statusEl.textContent = '📷 启用手势控制';
    statusEl.style.borderColor = 'rgba(255,255,255,0.18)';
    window._webcamTexture   = null;
    window._webcamUpdateDye = null;
    releaseAllFingers();
    overlayCtx.clearRect(0, 0, 640, 480);
  }

  // ── WebGL texture ────────────────────────────────────────────────────────────
  function initWebcamTexture () {
    const gl = window._fluidGL;
    if (!gl) return;
    if (!webcamTex) webcamTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, webcamTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    window._webcamTexture = webcamTex;
  }

  function uploadWebcamTexture () {
    if (!cameraActive || !webcamTex || videoEl.readyState < 2) return;
    const gl = window._fluidGL;
    if (!gl) return;
    // NO UNPACK_FLIP_Y — Y-flip handled in display shader (1.0 - vUv.y)
    gl.bindTexture(gl.TEXTURE_2D, webcamTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, videoEl);
  }

  // ── Color sampling ───────────────────────────────────────────────────────────
  function sampleWebcamColor (fx, fy) {
    if (!cameraActive || videoEl.readyState < 2) return null;
    try {
      const sw = sampleCanvas.width, sh = sampleCanvas.height;
      sampleCtx.save();
      sampleCtx.scale(-1, 1);
      sampleCtx.drawImage(videoEl, -sw, 0, sw, sh);
      sampleCtx.restore();
      const d = sampleCtx.getImageData(
        Math.max(0, Math.min(sw - 1, Math.round(fx * sw))),
        Math.max(0, Math.min(sh - 1, Math.round(fy * sh))),
        1, 1
      ).data;
      return { r: (d[0] / 255) * COLOR_BOOST, g: (d[1] / 255) * COLOR_BOOST, b: (d[2] / 255) * COLOR_BOOST };
    } catch (_) { return null; }
  }

  // ── MediaPipe ────────────────────────────────────────────────────────────────
  async function initMediaPipe () {
    if (!window.Hands)  await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    if (!window.Camera) await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');

    handsModel = new window.Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
    });
    handsModel.setOptions({ maxNumHands: 2, modelComplexity: 1,
      minDetectionConfidence: 0.65, minTrackingConfidence: 0.55 });
    handsModel.onResults(onHandResults);

    mpCamera = new window.Camera(videoEl, {
      onFrame: async () => { if (cameraActive && handsModel) await handsModel.send({ image: videoEl }); },
      width: 640, height: 480,
    });
    mpCamera.start();
    console.log('[HandFluid v4] started');
  }

  function loadScript (src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('load fail: ' + src));
      document.head.appendChild(s);
    });
  }

  // ── Hand results ─────────────────────────────────────────────────────────────
  function onHandResults (results) {
    overlayCtx.clearRect(0, 0, 640, 480);
    const seenKeys = new Set();

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      results.multiHandLandmarks.forEach((lm, handIdx) => {
        drawSkeleton(lm);
        getExtendedFingers(lm).forEach(fingerIdx => {
          const key = `${handIdx}_${fingerIdx}`;
          const tip = lm[FINGER_TIPS[fingerIdx]];
          const fx  = 1.0 - tip.x;
          const fy  = tip.y;
          seenKeys.add(key);
          drawFingertipDot(tip, fingerIdx);
          const cam = sampleWebcamColor(fx, fy);
          if (!fingerState[key]) {
            fingerState[key] = { id: PTR_ID_BASE + handIdx * 5 + fingerIdx,
              x: fx, y: fy, prevX: fx, prevY: fy, active: true, fresh: true,
              color: cam || FLUID_COLORS[fingerIdx % 5] };
          } else {
            const s = fingerState[key];
            s.prevX = s.x; s.prevY = s.y;
            s.x = s.x * SMOOTHING + fx * (1 - SMOOTHING);
            s.y = s.y * SMOOTHING + fy * (1 - SMOOTHING);
            s.active = true; s.fresh = false;
            if (cam) s.color = cam;
          }
        });
      });
    }

    Object.keys(fingerState).forEach(k => { if (!seenKeys.has(k)) releaseFingerKey(k); });
    injectIntoFluid();
  }

  function getExtendedFingers (lm) {
    const ext = [];
    if (Math.abs(lm[4].x - lm[0].x) > 0.07) ext.push(0);
    [6, 10, 14, 18].forEach((pip, i) => {
      if (lm[FINGER_TIPS[i + 1]].y < lm[pip].y - 0.025) ext.push(i + 1);
    });
    return ext;
  }

  // ── Fluid injection ──────────────────────────────────────────────────────────
  function injectIntoFluid () {
    if (!window.fluidCanvas || !window.updatePointerDownData) return;
    const fc  = window.fluidCanvas;
    const pts = window.pointers;

    Object.values(fingerState).forEach(fs => {
      if (!fs.active) return;
      const posX = fs.x * fc.width;
      const posY = fs.y * fc.height;
      let ptr = pts.find(p => p.id === fs.id);

      if (fs.fresh) {
        if (!ptr) { ptr = new window.pointerPrototype(); pts.push(ptr); }
        window.updatePointerDownData(ptr, fs.id, posX, posY);
        ptr.color = fs.color;
        fs.fresh = false;
      } else {
        if (!ptr) return;
        const dx = fs.x - fs.prevX;
        const dy = fs.y - fs.prevY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > MIN_MOVE) {
          // updatePointerMoveData sets moved=true only if deltaX/Y != 0
          window.updatePointerMoveData(ptr, posX, posY);
          // Force moved=true in case delta rounds to 0
          ptr.moved = true;
          ptr.color = fs.color;
        }
      }
    });
  }

  function releaseFingerKey (k) {
    const fs = fingerState[k];
    if (!fs) return;
    const ptr = window.pointers && window.pointers.find(p => p.id === fs.id);
    if (ptr && window.updatePointerUpData) window.updatePointerUpData(ptr);
    delete fingerState[k];
  }
  function releaseAllFingers () { Object.keys(fingerState).forEach(releaseFingerKey); }

  // ── Draw helpers ─────────────────────────────────────────────────────────────
  const OVERLAY_COLORS = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#C77DFF'];
  const FLUID_COLORS = [
    {r:3.0,g:0.4,b:0.4},{r:2.8,g:2.8,b:0.2},{r:0.2,g:3.0,b:0.6},
    {r:0.2,g:1.0,b:3.5},{r:2.5,g:0.2,b:3.5},
  ];
  const CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
  ];

  function drawSkeleton (lm) {
    const W = 640, H = 480;
    overlayCtx.save();
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    overlayCtx.lineWidth = 1.5;
    CONNECTIONS.forEach(([a,b]) => {
      overlayCtx.beginPath();
      overlayCtx.moveTo((1-lm[a].x)*W, lm[a].y*H);
      overlayCtx.lineTo((1-lm[b].x)*W, lm[b].y*H);
      overlayCtx.stroke();
    });
    lm.forEach(p => {
      overlayCtx.beginPath();
      overlayCtx.arc((1-p.x)*W, p.y*H, 2.5, 0, Math.PI*2);
      overlayCtx.fillStyle = 'rgba(255,255,255,0.75)';
      overlayCtx.fill();
    });
    overlayCtx.restore();
  }

  function drawFingertipDot (lm, i) {
    const W = 640, H = 480, x = (1-lm.x)*W, y = lm.y*H, c = OVERLAY_COLORS[i%5];
    overlayCtx.save();
    overlayCtx.beginPath(); overlayCtx.arc(x,y,11,0,Math.PI*2);
    overlayCtx.strokeStyle=c; overlayCtx.lineWidth=2.5; overlayCtx.globalAlpha=0.85; overlayCtx.stroke();
    overlayCtx.beginPath(); overlayCtx.arc(x,y,5,0,Math.PI*2);
    overlayCtx.fillStyle=c; overlayCtx.globalAlpha=1; overlayCtx.fill();
    overlayCtx.restore();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', buildUI)
    : buildUI();

})();
