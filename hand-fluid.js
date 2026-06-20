/**
 * Hand Gesture → Webcam Warp
 * 手势搅动摄像头画面本身（液化扭曲效果）
 * 原理：维护一个2D位移场，手指划过时写入速度，每帧用位移场偏移UV采样摄像头画面
 * 完全不改原始fluid dye/display，warpCanvas覆盖在流体canvas之上
 */
(function () {
  // ─── Config ──────────────────────────────────────────────────────────────
  const FINGER_TIPS = [4, 8, 12, 16, 20];
  const SMOOTHING   = 0.5;
  const MIN_MOVE    = 0.002;
  const PTR_ID_BASE = 100;

  // 扭曲参数
  const GRID_W      = 64;
  const GRID_H      = 48;
  const WARP_FORCE  = 30;    // 手指施加的扭曲强度
  const WARP_DECAY  = 0.90;  // 每帧衰减系数
  const WARP_RADIUS = 6;     // 影响半径（格数）
  const DISP_SCALE  = 25;    // 位移场 → 像素偏移 放大倍数

  // ─── State ───────────────────────────────────────────────────────────────
  const fingerState = {};
  let videoEl       = null;
  let overlayCanvas = null;
  let overlayCtx    = null;
  let warpCanvas    = null;
  let warpCtx       = null;
  let tmpCanvas     = null;   // 用于drawImage中转
  let tmpCtx        = null;
  let handsModel    = null;
  let mpCamera      = null;
  let cameraActive  = false;
  let statusEl      = null;
  let animId        = null;

  // 位移场：每格[dx, dy]
  const dispX = new Float32Array(GRID_W * GRID_H);
  const dispY = new Float32Array(GRID_W * GRID_H);

  // ─── UI ──────────────────────────────────────────────────────────────────
  function buildUI () {
    statusEl = document.createElement('div');
    Object.assign(statusEl.style, {
      position: 'fixed', bottom: '20px', left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 18px', borderRadius: '20px',
      background: 'rgba(0,0,0,0.55)',
      border: '1.5px solid rgba(255,255,255,0.18)',
      color: '#fff', fontSize: '14px', cursor: 'pointer',
      zIndex: '9999', userSelect: 'none',
      backdropFilter: 'blur(8px)',
    });
    statusEl.textContent = '📷 启用手势控制';
    statusEl.addEventListener('click', () => cameraActive ? stopCamera() : startCamera());
    document.body.appendChild(statusEl);

    videoEl = document.createElement('video');
    videoEl.setAttribute('autoplay', ''); videoEl.setAttribute('playsinline', ''); videoEl.setAttribute('muted', '');
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);

    // 骨架预览（右下角小窗）
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = 320; overlayCanvas.height = 240;
    Object.assign(overlayCanvas.style, {
      position: 'fixed', bottom: '60px', right: '14px',
      width: '160px', height: '120px',
      borderRadius: '8px', display: 'none', zIndex: '9998',
      opacity: '0.85', pointerEvents: 'none',
      border: '1px solid rgba(255,255,255,0.15)',
    });
    overlayCtx = overlayCanvas.getContext('2d');
    document.body.appendChild(overlayCanvas);

    // 扭曲显示层：全屏覆盖在流体之上
    warpCanvas = document.createElement('canvas');
    Object.assign(warpCanvas.style, {
      position: 'fixed', top: '0', left: '0',
      width: '100%', height: '100%',
      zIndex: '1', pointerEvents: 'none', display: 'none',
    });
    document.body.appendChild(warpCanvas);
    warpCtx = warpCanvas.getContext('2d');

    // 临时canvas，用于逐行位移
    tmpCanvas = document.createElement('canvas');
    tmpCtx    = tmpCanvas.getContext('2d');
  }

  // ─── Camera ──────────────────────────────────────────────────────────────
  async function startCamera () {
    statusEl.textContent = '⏳ 加载中…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      videoEl.srcObject = stream;
      await new Promise(r => { videoEl.onloadedmetadata = r; });
      videoEl.play();
      cameraActive = true;
      overlayCanvas.style.display = 'block';
      warpCanvas.style.display    = 'block';
      statusEl.textContent        = '✋ 手势识别中 (点击关闭)';
      statusEl.style.borderColor  = 'rgba(48,209,88,0.7)';
      onResize();
      window.addEventListener('resize', onResize);
      startRenderLoop();
      await initMediaPipe();
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
    }
  }

  function stopCamera () {
    if (mpCamera)   { try { mpCamera.stop(); }   catch(_){} mpCamera   = null; }
    if (handsModel) { try { handsModel.close(); } catch(_){} handsModel = null; }
    if (videoEl.srcObject) { videoEl.srcObject.getTracks().forEach(t => t.stop()); videoEl.srcObject = null; }
    cameraActive = false;
    overlayCanvas.style.display = 'none';
    warpCanvas.style.display    = 'none';
    statusEl.textContent        = '📷 启用手势控制';
    statusEl.style.borderColor  = 'rgba(255,255,255,0.18)';
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    window.removeEventListener('resize', onResize);
    dispX.fill(0); dispY.fill(0);
    releaseAllFingers();
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  function onResize () {
    warpCanvas.width  = window.innerWidth;
    warpCanvas.height = window.innerHeight;
    tmpCanvas.width   = window.innerWidth;
    tmpCanvas.height  = window.innerHeight;
  }

  // ─── Render loop: warp webcam画面 ─────────────────────────────────────────
  function startRenderLoop () {
    function loop () {
      if (!cameraActive) return;
      animId = requestAnimationFrame(loop);
      if (videoEl.readyState < 2) return;
      renderWarpedVideo();
    }
    animId = requestAnimationFrame(loop);
  }

  function renderWarpedVideo () {
    const W = warpCanvas.width;
    const H = warpCanvas.height;

    // 先把webcam原始帧（镜像X）画到 tmpCanvas
    tmpCtx.save();
    tmpCtx.translate(W, 0); tmpCtx.scale(-1, 1);
    tmpCtx.drawImage(videoEl, 0, 0, W, H);
    tmpCtx.restore();

    // 用位移场逐列绘制到 warpCanvas
    // 按列切片：每列宽度 = W/GRID_W，按dispX/dispY偏移
    warpCtx.clearRect(0, 0, W, H);

    const colW = W / GRID_W;
    const rowH = H / GRID_H;

    for (let gc = 0; gc < GRID_W; gc++) {
      for (let gr = 0; gr < GRID_H; gr++) {
        const gi   = gr * GRID_W + gc;
        const dx   = dispX[gi] * DISP_SCALE;
        const dy   = dispY[gi] * DISP_SCALE;

        const sx   = gc * colW;
        const sy   = gr * rowH;

        // 从 tmpCanvas 取源区域（偏移反方向取，实现位移）
        const srcX = sx - dx;
        const srcY = sy - dy;

        warpCtx.drawImage(
          tmpCanvas,
          srcX, srcY, colW, rowH,   // 源：偏移后的位置
          sx,   sy,   colW, rowH    // 目标：原位
        );
      }
    }

    // 衰减位移场
    for (let i = 0; i < dispX.length; i++) {
      dispX[i] *= WARP_DECAY;
      dispY[i] *= WARP_DECAY;
    }
  }

  // ─── MediaPipe ───────────────────────────────────────────────────────────
  async function initMediaPipe () {
    if (typeof window.Hands === 'undefined')
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    if (typeof window.Camera === 'undefined')
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
    handsModel = new window.Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
    handsModel.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.65, minTrackingConfidence: 0.55 });
    handsModel.onResults(onHandResults);
    mpCamera = new window.Camera(videoEl, {
      onFrame: async () => { if (cameraActive && handsModel) await handsModel.send({ image: videoEl }); },
      width: 640, height: 480,
    });
    mpCamera.start();
    console.log('[HandFluid] started');
  }

  function loadScript (src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ─── Hand results ─────────────────────────────────────────────────────────
  function onHandResults (results) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const seenKeys = new Set();

    if (results.multiHandLandmarks) {
      results.multiHandLandmarks.forEach((lm, hi) => {
        drawSkeleton(lm);
        getExtendedFingers(lm).forEach(fi => {
          const key = `${hi}_${fi}`;
          const tip = lm[FINGER_TIPS[fi]];
          const fx  = 1.0 - tip.x;
          const fy  = tip.y;
          seenKeys.add(key);
          drawDot(tip, fi);

          if (!fingerState[key]) {
            fingerState[key] = { x: fx, y: fy, prevX: fx, prevY: fy, id: PTR_ID_BASE + hi*5 + fi, fresh: true, active: true };
          } else {
            const s = fingerState[key];
            s.prevX = s.x; s.prevY = s.y;
            s.x = s.x * SMOOTHING + fx * (1 - SMOOTHING);
            s.y = s.y * SMOOTHING + fy * (1 - SMOOTHING);
            s.active = true; s.fresh = false;
          }
        });
      });
    }
    Object.keys(fingerState).forEach(k => { if (!seenKeys.has(k)) releaseFingerKey(k); });
    driveFluid();
  }

  // ─── Drive fluid + dispField ──────────────────────────────────────────────
  function driveFluid () {
    if (!window.fluidCanvas) return;
    const fc  = window.fluidCanvas;
    const pts = window.pointers;

    Object.values(fingerState).forEach(fs => {
      if (!fs.active) return;
      const dx = fs.x - fs.prevX;
      const dy = fs.y - fs.prevY;
      const posX = fs.x * fc.width;
      const posY = fs.y * fc.height;

      // pointer（颜色极暗，只推velocity不显色）
      let ptr = pts && pts.find(p => p.id === fs.id);
      if (fs.fresh) {
        if (!ptr) { ptr = new window.pointerPrototype(); pts.push(ptr); }
        window.updatePointerDownData(ptr, fs.id, posX, posY);
        ptr.color = { r: 0, g: 0, b: 0 };
      } else if (Math.abs(dx) > MIN_MOVE || Math.abs(dy) > MIN_MOVE) {
        if (ptr) {
          window.updatePointerMoveData(ptr, posX, posY);
          ptr.color = { r: 0, g: 0, b: 0 };
        }
        // 写位移场
        writeDispField(fs.x, fs.y, dx, dy);
      }
    });
  }

  function writeDispField (fx, fy, dx, dy) {
    const cx = Math.round(fx * GRID_W);
    const cy = Math.round(fy * GRID_H);
    for (let gy = Math.max(0, cy - WARP_RADIUS); gy < Math.min(GRID_H, cy + WARP_RADIUS + 1); gy++) {
      for (let gx = Math.max(0, cx - WARP_RADIUS); gx < Math.min(GRID_W, cx + WARP_RADIUS + 1); gx++) {
        const dist = Math.hypot(gx - cx, gy - cy);
        if (dist > WARP_RADIUS) continue;
        const w  = (1 - dist / WARP_RADIUS) ** 2;
        const gi = gy * GRID_W + gx;
        dispX[gi] += dx * WARP_FORCE * w;
        dispY[gi] += dy * WARP_FORCE * w;
      }
    }
  }

  // ─── Finger extension ─────────────────────────────────────────────────────
  function getExtendedFingers (lm) {
    const ext = [];
    if (Math.abs(lm[4].x - lm[0].x) > 0.07) ext.push(0);
    [6, 10, 14, 18].forEach((pip, i) => {
      if (lm[FINGER_TIPS[i + 1]].y < lm[pip].y - 0.025) ext.push(i + 1);
    });
    return ext;
  }

  function releaseFingerKey (key) {
    const fs  = fingerState[key];
    if (!fs) return;
    const ptr = window.pointers && window.pointers.find(p => p.id === fs.id);
    if (ptr && window.updatePointerUpData) window.updatePointerUpData(ptr);
    delete fingerState[key];
  }
  function releaseAllFingers () { Object.keys(fingerState).forEach(releaseFingerKey); }

  // ─── Draw skeleton ────────────────────────────────────────────────────────
  const OC = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#C77DFF'];
  const CONNS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];

  function drawSkeleton (lm) {
    const W = overlayCanvas.width, H = overlayCanvas.height;
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    overlayCtx.lineWidth   = 1.5;
    CONNS.forEach(([a, b]) => {
      overlayCtx.beginPath();
      overlayCtx.moveTo((1-lm[a].x)*W, lm[a].y*H);
      overlayCtx.lineTo((1-lm[b].x)*W, lm[b].y*H);
      overlayCtx.stroke();
    });
  }

  function drawDot (tip, fi) {
    const W = overlayCanvas.width, H = overlayCanvas.height;
    const x = (1 - tip.x) * W, y = tip.y * H;
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 6, 0, Math.PI*2);
    overlayCtx.strokeStyle = OC[fi % 5]; overlayCtx.lineWidth = 2;
    overlayCtx.globalAlpha = 0.9; overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 3, 0, Math.PI*2);
    overlayCtx.fillStyle = OC[fi % 5]; overlayCtx.fill();
    overlayCtx.globalAlpha = 1;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', buildUI);
  else
    buildUI();
})();
