const VERT = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uVideo;
uniform vec2 uResolution;
uniform float uCellSize;
uniform vec2 uOffset;
uniform float uStagger;
uniform float uMinRadius;
uniform float uMaxRadius;
uniform float uRadiusResponse;
uniform float uMinStroke;
uniform float uMaxStroke;
uniform float uStrokeCurve;
uniform float uSolidThreshold;
uniform float uGap;
uniform float uSoftness;
uniform float uBlackPoint;
uniform float uWhitePoint;
uniform float uBrightness;
uniform float uContrast;
uniform float uGamma;
uniform float uInvert;
uniform vec3 uLumWeights;
uniform vec3 uInk;
uniform vec3 uPaper;

out vec4 fragColor;

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  float cell = max(uCellSize, 1.0);
  vec2 local = pixel - uOffset;
  float row = floor(local.y / cell);
  float rowShift = mod(row, 2.0) * uStagger * cell;
  vec2 shifted = local - vec2(rowShift, 0.0);
  vec2 cellIndex = floor(shifted / cell);
  vec2 center = uOffset + vec2(rowShift, 0.0) + (cellIndex + 0.5) * cell;
  vec2 centerGL = vec2(center.x, uResolution.y - center.y);

  vec2 uv = vec2(center.x / uResolution.x, 1.0 - center.y / uResolution.y);
  vec3 color = texture(uVideo, clamp(uv, 0.0, 1.0)).rgb;

  float lum = dot(color, uLumWeights);
  float range = max(uWhitePoint - uBlackPoint, 0.0001);
  lum = clamp((lum - uBlackPoint) / range, 0.0, 1.0);
  lum = clamp((lum - 0.5) * uContrast + 0.5 + uBrightness, 0.0, 1.0);
  lum = pow(max(lum, 0.0), max(uGamma, 0.001));
  if (uInvert > 0.5) lum = 1.0 - lum;

  float t = pow(clamp(lum, 0.0, 1.0), max(uStrokeCurve, 0.001));
  float radiusT = clamp(t * uRadiusResponse, 0.0, 1.0);
  float outer = max(mix(uMinRadius, uMaxRadius, radiusT) * cell - uGap, 0.0);
  float stroke = mix(uMinStroke, uMaxStroke, t);
  float inner = lum >= uSolidThreshold - 0.0005 ? 0.0 : max(outer - stroke, 0.0);

  float d = length(gl_FragCoord.xy - centerGL);
  float aa = max(fwidth(d), 0.6) * max(uSoftness, 0.2);
  float disk = smoothstep(aa, -aa, d - outer);
  float mask = 0.0;
  if (outer > 0.0) {
    mask = inner <= 0.001 ? disk : clamp(disk - smoothstep(aa, -aa, d - inner), 0.0, 1.0);
  }

  fragColor = vec4(mix(uPaper, uInk, mask), 1.0);
}
`;

function hexToRgb(hex) {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  const n = Number.parseInt(value, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || "Shader compile failed");
  }
  return shader;
}

export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  if (!gl) throw new Error("WebGL2 is required for the dither renderer.");

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.uniform1i(gl.getUniformLocation(program, "uVideo"), 0);

  const frameCanvas = document.createElement("canvas");
  const frameCtx = frameCanvas.getContext("2d", { alpha: false });

  const loc = (name) => gl.getUniformLocation(program, name);
  const uniforms = {
    resolution: loc("uResolution"),
    cellSize: loc("uCellSize"),
    offset: loc("uOffset"),
    stagger: loc("uStagger"),
    minRadius: loc("uMinRadius"),
    maxRadius: loc("uMaxRadius"),
    radiusResponse: loc("uRadiusResponse"),
    minStroke: loc("uMinStroke"),
    maxStroke: loc("uMaxStroke"),
    strokeCurve: loc("uStrokeCurve"),
    solidThreshold: loc("uSolidThreshold"),
    gap: loc("uGap"),
    softness: loc("uSoftness"),
    blackPoint: loc("uBlackPoint"),
    whitePoint: loc("uWhitePoint"),
    brightness: loc("uBrightness"),
    contrast: loc("uContrast"),
    gamma: loc("uGamma"),
    invert: loc("uInvert"),
    lumWeights: loc("uLumWeights"),
    ink: loc("uInk"),
    paper: loc("uPaper"),
  };

  let texW = 0;
  let texH = 0;

  function resize(width, height) {
    const w = Math.max(2, width - (width % 2));
    const h = Math.max(2, height - (height % 2));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw(video, params, sync = false) {
    if (!video || video.readyState < 2 || !video.videoWidth) return false;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (frameCanvas.width !== width || frameCanvas.height !== height) {
      frameCanvas.width = width;
      frameCanvas.height = height;
    }
    frameCtx.drawImage(video, 0, 0, width, height);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      if (width !== texW || height !== texH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frameCanvas);
        texW = width;
        texH = height;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frameCanvas);
      }
    } catch {
      return false;
    }

    const sum = params.lumR + params.lumG + params.lumB;
    const weights =
      sum > 0.0001
        ? [params.lumR / sum, params.lumG / sum, params.lumB / sum]
        : [0.2126, 0.7152, 0.0722];
    const ink = hexToRgb(params.ink);
    const paper = hexToRgb(params.paper);

    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.cellSize, params.cellSize);
    gl.uniform2f(uniforms.offset, params.offsetX, params.offsetY);
    gl.uniform1f(uniforms.stagger, params.stagger);
    gl.uniform1f(uniforms.minRadius, params.minRadius);
    gl.uniform1f(uniforms.maxRadius, params.maxRadius);
    gl.uniform1f(uniforms.radiusResponse, params.radiusResponse);
    gl.uniform1f(uniforms.minStroke, params.minStroke);
    gl.uniform1f(uniforms.maxStroke, params.maxStroke);
    gl.uniform1f(uniforms.strokeCurve, params.strokeCurve);
    gl.uniform1f(uniforms.solidThreshold, params.solidThreshold);
    gl.uniform1f(uniforms.gap, params.gap);
    gl.uniform1f(uniforms.softness, params.softness);
    gl.uniform1f(uniforms.blackPoint, params.blackPoint);
    gl.uniform1f(uniforms.whitePoint, params.whitePoint);
    gl.uniform1f(uniforms.brightness, params.brightness);
    gl.uniform1f(uniforms.contrast, params.contrast);
    gl.uniform1f(uniforms.gamma, params.gamma);
    gl.uniform1f(uniforms.invert, params.invert ? 1 : 0);
    gl.uniform3f(uniforms.lumWeights, weights[0], weights[1], weights[2]);
    gl.uniform3f(uniforms.ink, ink[0], ink[1], ink[2]);
    gl.uniform3f(uniforms.paper, paper[0], paper[1], paper[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (sync) gl.finish();
    return true;
  }

  resize(1280, 720);
  return { draw, resize, canvas };
}
