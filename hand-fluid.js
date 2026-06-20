/**
 * Hand Gesture → WebGL Fluid Control  +  Webcam Background
 * Pointer logic = v1 原版不动
 * 新增：webcam texture 上传到 WebGL，作为流体背景
 */

(function () {
  // ─── Config ─────────────────────────────────────────────────────────────────
  const FINGER_TIPS  = [4, 8, 12, 16, 20];
  const SMOOTHING    = 0.45;
  const MIN_MOVE     = 0.002;
  const PTR_ID_BASE  = 100;
  const COLOR_BOOST  = 1.2;    // webcam pixel → fluid color multiplier

  // ─── State ───────────────────────────────────────────────────────────────────
  const fingerState = {};
  let videoEl       = null;
  let overlayCanvas = null;
  let overlayCtx    = null;
  let handsModel    = null;
  let mpCamera      = null;
  let cameraActive  = false;
  let statusEl      = null;
  // webcam texture
  let webcamTex     = null;
  let sampleCanvas  = null;
  let sampleCtx     = null;

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

    // Overlay canvas for skeleton
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

    // Offscreen canvas for pixel color sampling
    sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 128; sampleCanvas.height = 96;
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
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
      // ── 初始化 webcam → dye 注入钩子 ──
      initWebcamTexture();
      window._webcamUpdateDye = injectWebcamIntoDye;
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
    window._webcamTexture   = null;
    window._webcamUpdateDye = null;
    // Release all hand pointers
    releaseAllFingers();
    overlayCtx.clearRect(0, 0, 640, 480);
  }

  // ─── Webcam → dye 注入 ────────────────────────────────────────────────────
  // 每帧把 webcam 画面用 copyProgram blit 进 dye buffer
  // 手势只产生 velocity 扰动，流体引擎用 velocity 扭曲 dye（即摄像头画面）

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

  function injectWebcamIntoDye () {
    if (!cameraActive || !webcamTex || videoEl.readyState < 2) return;
    const gl  = window._fluidGL;
    const dye = window._fluidDye && window._fluidDye();
    const cp  = window._fluidCopyProgram && window._fluidCopyProgram();
    const blit = window._fluidBlit;
    if (!gl || !dye || !cp || !blit) return;

    // 1. 把 video 帧画到 offscreen canvas，做镜像X + 翻转Y
    //    注意：sampleCanvas 尺寸固定 128×96，不要每帧改 width/height（改了会清空）
    const sw = sampleCanvas.width;
    const sh = sampleCanvas.height;
    sampleCtx.save();
    // 先上下翻转
    sampleCtx.translate(0, sh);
    sampleCtx.scale(1, -1);
    // 再左右镜像
    sampleCtx.translate(sw, 0);
    sampleCtx.scale(-1, 1);
    sampleCtx.drawImage(videoEl, 0, 0, sw, sh);
    sampleCtx.restore();

    // 2. 上传 canvas 到 webcamTex（UNSIGNED_BYTE RGB，独立 texture）
    gl.bindTexture(gl.TEXTURE_2D, webcamTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // 已在canvas里翻了
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, sampleCanvas);

    // 3. 用 copyProgram 把 webcamTex blit 进 dye.write（FBO，HALF_FLOAT格式）
    //    copyShader 原样采样，不做额外变换
    gl.disable(gl.BLEND);
    cp.bind();
    // attach webcamTex 到 slot 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, webcamTex);
    gl.uniform1i(cp.uniforms.uTexture, 0);
    blit(dye.write);
    dye.swap();
  }

  // ── 从摄像头像素采样颜色（新增）────────────────────────────────────────────
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
      const r = d[0] / 255, g = d[1] / 255, b = d[2] / 255;
      // 背景亮度：亮背景用暗色，暗背景用亮色
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let fr, fg, fb;
      if (lum > 0.5) {
        // 亮背景 → 极暗，避免曝光
        fr = r * 0.25;
        fg = g * 0.25;
        fb = b * 0.25;
      } else {
        // 暗背景 → 适当亮，有流体感
        fr = Math.max(r, 0.08) * COLOR_BOOST;
        fg = Math.max(g, 0.08) * COLOR_BOOST;
        fb = Math.max(b, 0.08) * COLOR_BOOST;
      }
      return { r: fr, g: fg, b: fb };
    } catch (_) { return null; }
  }

  // ─── MediaPipe init ──────────────────────────────────────────────────────────
  async function initMediaPipe () {
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
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s    = document.createElement('script');
      s.src      = src;
      s.onload   = resolve;
      s.onerror  = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  // ─── Per-frame results ── v1 原版逻辑，只加了 sampleWebcamColor ────────────
  function onHandResults (results) {
    overlayCtx.clearRect(0, 0, 640, 480);

    const seenKeys = new Set();

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      results.multiHandLandmarks.forEach((landmarks, handIdx) => {
        const extended = getExtendedFingers(landmarks);
        drawSkeleton(landmarks);

        extended.forEach(fingerIdx => {
          const key  = `${handIdx}_${fingerIdx}`;
          const tip  = landmarks[FINGER_TIPS[fingerIdx]];
          const fx = 1.0 - tip.x;
          const fy = tip.y;

          seenKeys.add(key);
          drawFingertipDot(tip, fingerIdx);

          if (!fingerState[key]) {
            fingerState[key] = {
              id:      PTR_ID_BASE + handIdx * 5 + fingerIdx,
              x:  fx, y:  fy,
              prevX: fx, prevY: fy,
              active: true,
              fresh:  true,
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

    Object.keys(fingerState).forEach(key => {
      if (!seenKeys.has(key)) {
        releaseFingerKey(key);
      }
    });

    injectIntoFluid();
  }

  // ─── Finger extension detection ── v1 原版 ──────────────────────────────────
  function getExtendedFingers (lm) {
    const extended = [];
    if (Math.abs(lm[4].x - lm[0].x) > 0.07) extended.push(0);
    const pipJoints = [6, 10, 14, 18];
    for (let i = 1; i <= 4; i++) {
      if (lm[FINGER_TIPS[i]].y < lm[pipJoints[i - 1]].y - 0.025) {
        extended.push(i);
      }
    }
    return extended;
  }

  // ─── Fluid pointer injection ── 只推 velocity，不注入颜色 ──────────────────
  function injectIntoFluid () {
    if (!window.fluidCanvas || !window._splatVelocityOnly) return;
    const fc = window.fluidCanvas;

    Object.values(fingerState).forEach(fs => {
      if (!fs.active) return;

      const x = fs.x;
      const y = fs.y;

      if (fs.fresh) {
        // 第一帧：注册 pointer（为了让 applyInputs 不报错），但不传颜色
        const pts = window.pointers;
        let ptr = pts && pts.find(p => p.id === fs.id);
        if (!ptr) {
          ptr = new window.pointerPrototype();
          pts.push(ptr);
        }
        window.updatePointerDownData(ptr, fs.id, x * fc.width, y * fc.height);
        // 颜色设成透明黑，让 dye splat 不影响画面
        ptr.color = { r: 0, g: 0, b: 0 };
      } else {
        const dx = fs.x - fs.prevX;
        const dy = fs.y - fs.prevY;
        if (Math.abs(dx) > MIN_MOVE || Math.abs(dy) > MIN_MOVE) {
          // 只推 velocity，不写 dye
          window._splatVelocityOnly(x, y, dx * 5000, -dy * 5000);
          // 同步更新 pointer（防止 applyInputs 走默认 splat）
          const pts = window.pointers;
          const ptr = pts && pts.find(p => p.id === fs.id);
          if (ptr) {
            window.updatePointerMoveData(ptr, x * fc.width, y * fc.height);
            ptr.color = { r: 0, g: 0, b: 0 };
          }
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

  // ─── Drawing ── v1 原版 ──────────────────────────────────────────────────────
  const OVERLAY_COLORS = ['#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF', '#C77DFF'];
  const FLUID_COLORS   = [
    { r: 0.28, g: 0.04, b: 0.04 },
    { r: 0.26, g: 0.22, b: 0.02 },
    { r: 0.02, g: 0.28, b: 0.08 },
    { r: 0.02, g: 0.08, b: 0.30 },
    { r: 0.22, g: 0.02, b: 0.30 },
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
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
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
