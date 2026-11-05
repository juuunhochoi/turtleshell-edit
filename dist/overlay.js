(() => {
  if (window.__postureFlowOverlayLoaded) return;
  window.__postureFlowOverlayLoaded = true;
  let canvas = document.getElementById("postureflow-overlay");
  if (!canvas) return;
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl) return;

  const vertex = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // 경고성 색상을 완전히 제거하고, 순수하게 가볍고 부드럽게 어두워지기만 하는 프래그먼트 셰이더
  const fragment = `
    precision mediump float;
    uniform float u_score;
    void main() {
      // u_score(0~1)에 비례하여 은은한 어두움 적용 (최대 투명도를 낮춰 부담스럽지 않게 조절)
      float alpha = u_score * 0.3; 
      vec3 darkTint = vec3(0.0, 0.0, 0.0); // 순수 검은색 기반 그림자
      
      gl_FragColor = vec4(darkTint, alpha);
    }
  `;

  function shader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("TurtleShell shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  const vs = shader(gl.VERTEX_SHADER, vertex);
  const fs = shader(gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return;
  const program = gl.createProgram();
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const scoreLoc = gl.getUniformLocation(program, "u_score");
  let target = 0, current = 0, previousFrameTime = 0;
  let animationFrameId = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    scheduleDraw();
  }
  resize();
  window.addEventListener("resize", resize);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "POSTUREFLOW_CONTENT" || event.data.type !== "RENDER") return;
    const nextTarget = event.data.active
      ? Math.max(0, Math.min(1, Number(event.data.score) || 0))
      : 0;
    if (Math.abs(nextTarget - target) > 0.001) {
      target = nextTarget;
      scheduleDraw();
    }
  });

  function scheduleDraw() {
    if (animationFrameId === null) animationFrameId = requestAnimationFrame(draw);
  }

  function draw(now) {
    animationFrameId = null;
    const elapsedMs = previousFrameTime ? Math.min(50, now - previousFrameTime) : 16;
    previousFrameTime = now;
    const responseMs = target > current ? 100 : 80;
    const smoothing = 1 - Math.exp(-elapsedMs / responseMs);
    current += (target - current) * smoothing;

    // 블러 강도를 과하지 않고 은은하게 수정 (최대 6px)
    const MAX_BLUR_PX = 6; 
    const currentBlur = current * MAX_BLUR_PX;

    if (current > 0.005) {
      canvas.style.backdropFilter = `blur(${currentBlur.toFixed(2)}px)`;
      canvas.style.webkitBackdropFilter = canvas.style.backdropFilter;
      canvas.style.pointerEvents = 'none';
    } else {
      canvas.style.backdropFilter = 'none';
      canvas.style.webkitBackdropFilter = 'none';
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (current > 0.005) {
      gl.uniform1f(scoreLoc, current);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (Math.abs(target - current) > 0.002) scheduleDraw();
    else current = target;
  }
})();
