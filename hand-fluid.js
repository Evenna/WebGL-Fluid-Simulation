/**
 * Hand Gesture → Webcam Liquid Warp
 * WebGL方案：velocity场扭曲webcam画面 + 彩色流体染色叠加
 * warpCanvas全屏覆盖，用自定义shader实现liquid效果
 */
(function () {
  // ─── Config ──────────────────────────────────────────────────────────────
  const FINGER_TIPS = [4, 8, 12, 16, 20];
  const SMOOTHING   = 0.4;
  const MIN_MOVE    = 0.001;
  const PTR_ID_BASE = 100;

  // 液化参数
  const SPLAT_FORCE  = 8000;   // velocity splat强度
  const SPLAT_RADIUS = 0.4;    // splat半径（越大范围越广）
  const COLOR_MIX    = 0.35;   // 彩色流体叠加强度（0=纯视频 1=纯流体色）

  // 手指颜色（亮色，染色用）
  const FINGER_COLORS = [
    { r: 0.8, g: 0.2, b: 1.0 },   // 紫
    { r: 0.0, g: 0.8, b: 1.0 },   // 青
    { r: 1.0, g: 0.3, b: 0.1 },   // 橙红
    { r: 0.1, g: 1.0, b: 0.4 },   // 绿
    { r: 1.0, g: 0.8, b: 0.0 },   // 黄
  ];

  // ─── State ───────────────────────────────────────────────────────────────
  const fingerState = {};
  let videoEl       = null;
  let overlayCanvas = null;
  let overlayCtx    = null;
  let warpCanvas    = null;
  let warpGL        = null;      // WebGL context for warpCanvas
  let handsModel    = null;
  let mpCamera      = null;
  let cameraActive  = false;
  let statusEl      = null;
  let animId        = null;

  // WebGL resources for warp shader
  let warpProgram   = null;
  let webcamTex     = null;
  let quadBuf       = null;
  let warpUniforms  = {};

  // 位移累积场（传给warp shader）
  // 用两个pingpong framebuffer做速度场扩散
  let velFBO        = null;   // {read, write} double buffer
  let velProgram    = null;   // advection/splat shader for vel field
  const velRes      = 128;    // velocity field resolution

  // ─── UI ──────────────────────────────────────────────────────────────────
  function buildUI () {
    statusEl = document.createElement('div');
    Object.assign(statusEl.style, {
      position: 'fixed', bottom: '20px', left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 20px', borderRadius: '20px',
      background: 'rgba(0,0,0,0.6)',
      border: '1.5px solid rgba(255,255,255,0.2)',
      color: '#fff', fontSize: '14px', cursor: 'pointer',
      zIndex: '9999', userSelect: 'none',
      backdropFilter: 'blur(10px)',
    });
    statusEl.textContent = '📷 启用手势控制';
    statusEl.addEventListener('click', () => cameraActive ? stopCamera() : startCamera());
    document.body.appendChild(statusEl);

    videoEl = document.createElement('video');
    videoEl.setAttribute('autoplay',''); videoEl.setAttribute('playsinline',''); videoEl.setAttribute('muted','');
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);

    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = 320; overlayCanvas.height = 240;
    Object.assign(overlayCanvas.style, {
      position: 'fixed', bottom: '60px', right: '14px',
      width: '160px', height: '120px', borderRadius: '8px',
      display: 'none', zIndex: '9998', opacity: '0.8',
      pointerEvents: 'none',
      border: '1px solid rgba(255,255,255,0.12)',
    });
    overlayCtx = overlayCanvas.getContext('2d');
    document.body.appendChild(overlayCanvas);

    // warpCanvas：WebGL，全屏
    warpCanvas = document.createElement('canvas');
    Object.assign(warpCanvas.style, {
      position: 'fixed', top:'0', left:'0',
      width:'100%', height:'100%',
      zIndex:'1', pointerEvents:'none', display:'none',
    });
    document.body.appendChild(warpCanvas);
    initWarpGL();
  }

  // ─── WebGL warp renderer ──────────────────────────────────────────────────
  function initWarpGL () {
    warpGL = warpCanvas.getContext('webgl', { alpha: false, antialias: false });
    const gl = warpGL;
    if (!gl) return;

    // 全屏quad
    quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1, 1,-1, -1,1, 1,1
    ]), gl.STATIC_DRAW);

    // webcam texture
    webcamTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, webcamTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // 速度场 FBO pair
    velFBO = createDoubleFBO(gl, velRes, velRes);

    // velocity advection + decay program
    velProgram = createProgram(gl, VERT_SRC, VEL_ADVECT_SRC);

    // warp display program
    warpProgram = createProgram(gl, VERT_SRC, WARP_DISPLAY_SRC);
    warpUniforms = {
      uWebcam:    gl.getUniformLocation(warpProgram, 'uWebcam'),
      uVelocity:  gl.getUniformLocation(warpProgram, 'uVelocity'),
      uWarpScale: gl.getUniformLocation(warpProgram, 'uWarpScale'),
      uColorMix:  gl.getUniformLocation(warpProgram, 'uColorMix'),
      aPos:       gl.getAttribLocation(warpProgram,  'aPos'),
    };
  }

  // vertex shader（共用）
  const VERT_SRC = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main () {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  // velocity field advection + decay
  const VEL_ADVECT_SRC = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform float uDecay;
    void main () {
      vec2 v = texture2D(uVelocity, vUv).xy;
      gl_FragColor = vec4(v * uDecay, 0.0, 1.0);
    }
  `;

  // warp display：用velocity场偏移UV采样webcam
  const WARP_DISPLAY_SRC = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uWebcam;
    uniform sampler2D uVelocity;
    uniform float uWarpScale;
    uniform float uColorMix;

    // 色相→RGB
    vec3 hue2rgb (float h) {
      h = fract(h);
      float r = abs(h*6.0 - 3.0) - 1.0;
      float g = 2.0 - abs(h*6.0 - 2.0);
      float b = 2.0 - abs(h*6.0 - 4.0);
      return clamp(vec3(r,g,b), 0.0, 1.0);
    }

    void main () {
      // 镜像X（自拍镜像）
      vec2 uv = vec2(1.0 - vUv.x, vUv.y);

      // 读velocity场
      vec2 vel = texture2D(uVelocity, vUv).xy;
      float speed = length(vel);

      // 用velocity偏移UV采样webcam（液化效果）
      vec2 warpedUv = uv - vel * uWarpScale;
      vec3 cam = texture2D(uWebcam, warpedUv).rgb;

      // 速度大的地方叠加彩色（速度方向决定色相）
      float hue = atan(vel.y, vel.x) / 6.2832 + 0.5;
      vec3 fluidColor = hue2rgb(hue) * 1.2;
      float colorAmt = clamp(speed * 80.0, 0.0, 1.0) * uColorMix;

      vec3 result = mix(cam, fluidColor, colorAmt);
      gl_FragColor = vec4(result, 1.0);
    }
  `;

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
    releaseAllFingers();
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    // 清空velocity场
    if (warpGL && velFBO) {
      clearFBO(warpGL, velFBO.read);
      clearFBO(warpGL, velFBO.write);
    }
  }

  function onResize () {
    warpCanvas.width  = window.innerWidth;
    warpCanvas.height = window.innerHeight;
    if (warpGL) warpGL.viewport(0, 0, warpCanvas.width, warpCanvas.height);
  }

  // ─── Render loop ─────────────────────────────────────────────────────────
  function startRenderLoop () {
    function loop () {
      if (!cameraActive) return;
      animId = requestAnimationFrame(loop);
      if (videoEl.readyState < 2) return;
      stepVelocity();
      renderWarp();
    }
    animId = requestAnimationFrame(loop);
  }

  function stepVelocity () {
    // advection: vel field自我扩散 + 衰减
    const gl = warpGL;
    gl.viewport(0, 0, velRes, velRes);
    gl.useProgram(velProgram);
    const uVel   = gl.getUniformLocation(velProgram, 'uVelocity');
    const uDecay = gl.getUniformLocation(velProgram, 'uDecay');
    const aPos   = gl.getAttribLocation(velProgram,  'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(uVel, 0);
    gl.uniform1f(uDecay, 0.97);   // 速度场衰减（高=消散慢，液体感强）
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velFBO.read.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, velFBO.write.fbo);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // swap
    const tmp = velFBO.read; velFBO.read = velFBO.write; velFBO.write = tmp;
  }

  function renderWarp () {
    const gl = warpGL;
    const W  = warpCanvas.width;
    const H  = warpCanvas.height;
    gl.viewport(0, 0, W, H);

    // 上传webcam帧
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, webcamTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, videoEl);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(warpProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(warpUniforms.aPos);
    gl.vertexAttribPointer(warpUniforms.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, webcamTex);
    gl.uniform1i(warpUniforms.uWebcam, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, velFBO.read.tex);
    gl.uniform1i(warpUniforms.uVelocity, 1);

    gl.uniform1f(warpUniforms.uWarpScale, 0.25);
    gl.uniform1f(warpUniforms.uColorMix,  COLOR_MIX);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ─── Splat velocity into velFBO ───────────────────────────────────────────
  const SPLAT_SRC = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform vec2 uPoint;
    uniform vec2 uVelocity;
    uniform float uRadius;
    void main () {
      vec2 p    = vUv - uPoint;
      float d   = exp(-dot(p,p) / uRadius);
      vec2 base = texture2D(uTarget, vUv).xy;
      gl_FragColor = vec4(base + uVelocity * d, 0.0, 1.0);
    }
  `;
  let splatProgram2 = null;

  function getSplatProgram () {
    if (!splatProgram2) splatProgram2 = createProgram(warpGL, VERT_SRC, SPLAT_SRC);
    return splatProgram2;
  }

  function splatVelocity (fx, fy, dvx, dvy) {
    const gl = warpGL;
    const sp = getSplatProgram();
    gl.viewport(0, 0, velRes, velRes);
    gl.useProgram(sp);
    const aPos = gl.getAttribLocation(sp, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velFBO.read.tex);
    gl.uniform1i(gl.getUniformLocation(sp, 'uTarget'), 0);
    gl.uniform2f(gl.getUniformLocation(sp, 'uPoint'), fx, 1.0 - fy);  // Y flip
    gl.uniform2f(gl.getUniformLocation(sp, 'uVelocity'), dvx * SPLAT_FORCE, -dvy * SPLAT_FORCE);
    gl.uniform1f(gl.getUniformLocation(sp, 'uRadius'), SPLAT_RADIUS * SPLAT_RADIUS * 0.01);
    gl.bindFramebuffer(gl.FRAMEBUFFER, velFBO.write.fbo);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const tmp = velFBO.read; velFBO.read = velFBO.write; velFBO.write = tmp;
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
  }

  function loadScript (src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ─── Hand results ─────────────────────────────────────────────────────────
  function onHandResults (results) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const seen = new Set();
    if (results.multiHandLandmarks) {
      results.multiHandLandmarks.forEach((lm, hi) => {
        drawSkeleton(lm);
        getExtendedFingers(lm).forEach(fi => {
          const key = `${hi}_${fi}`;
          const tip = lm[FINGER_TIPS[fi]];
          const fx  = 1.0 - tip.x;
          const fy  = tip.y;
          seen.add(key);
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
    Object.keys(fingerState).forEach(k => { if (!seen.has(k)) releaseFingerKey(k); });
    driveVelocity();
  }

  function driveVelocity () {
    // 同时驱动原始fluid（保留流体效果）和warp velocity场
    if (!window.fluidCanvas) return;
    const fc  = window.fluidCanvas;
    const pts = window.pointers;

    Object.values(fingerState).forEach(fs => {
      if (!fs.active) return;
      const dx  = fs.x - fs.prevX;
      const dy  = fs.y - fs.prevY;
      const fi  = parseInt((fs.id - PTR_ID_BASE) % 5);
      const col = FINGER_COLORS[fi] || FINGER_COLORS[0];

      // 原始fluid pointer（彩色，产生流体染色效果）
      let ptr = pts && pts.find(p => p.id === fs.id);
      if (fs.fresh) {
        if (!ptr) { ptr = new window.pointerPrototype(); pts.push(ptr); }
        window.updatePointerDownData(ptr, fs.id, fs.x * fc.width, fs.y * fc.height);
        ptr.color = col;
      } else if (Math.abs(dx) > MIN_MOVE || Math.abs(dy) > MIN_MOVE) {
        if (ptr) {
          window.updatePointerMoveData(ptr, fs.x * fc.width, fs.y * fc.height);
          ptr.color = col;
        }
        // warp velocity splat
        splatVelocity(fs.x, fs.y, dx, dy);
      }
    });
  }

  // ─── Finger extension ─────────────────────────────────────────────────────
  function getExtendedFingers (lm) {
    const ext = [];
    if (Math.abs(lm[4].x - lm[0].x) > 0.07) ext.push(0);
    [6, 10, 14, 18].forEach((pip, i) => {
      if (lm[FINGER_TIPS[i+1]].y < lm[pip].y - 0.025) ext.push(i+1);
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

  // ─── GL helpers ───────────────────────────────────────────────────────────
  function createProgram (gl, vsrc, fsrc) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsrc); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsrc); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
      console.error('[WarpGL] shader err:', gl.getShaderInfoLog(fs));
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    return p;
  }

  function createFBOTex (gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  function createDoubleFBO (gl, w, h) {
    return { read: createFBOTex(gl, w, h), write: createFBOTex(gl, w, h) };
  }

  function clearFBO (gl, fbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ─── Draw skeleton ─────────────────────────────────────────────────────────
  const OC    = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#C77DFF'];
  const CONNS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];

  function drawSkeleton (lm) {
    const W = overlayCanvas.width, H = overlayCanvas.height;
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.5)'; overlayCtx.lineWidth = 1.5;
    CONNS.forEach(([a,b]) => {
      overlayCtx.beginPath();
      overlayCtx.moveTo((1-lm[a].x)*W, lm[a].y*H);
      overlayCtx.lineTo((1-lm[b].x)*W, lm[b].y*H);
      overlayCtx.stroke();
    });
  }
  function drawDot (tip, fi) {
    const W = overlayCanvas.width, H = overlayCanvas.height;
    const x = (1-tip.x)*W, y = tip.y*H;
    overlayCtx.beginPath(); overlayCtx.arc(x, y, 6, 0, Math.PI*2);
    overlayCtx.strokeStyle = OC[fi%5]; overlayCtx.lineWidth = 2;
    overlayCtx.globalAlpha = 0.9; overlayCtx.stroke();
    overlayCtx.beginPath(); overlayCtx.arc(x, y, 3, 0, Math.PI*2);
    overlayCtx.fillStyle = OC[fi%5]; overlayCtx.fill();
    overlayCtx.globalAlpha = 1;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', buildUI);
  else
    buildUI();
})();
