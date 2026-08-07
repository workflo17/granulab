// WebGL2 renderer: sim state uploads as R8UI textures, palette + per-grain shade
// resolved in the fragment shader. BG modes are shader variants (uMode).

import { PALETTE, PH, N_IDS, E } from "../engine/elements";

export const BG_MODES = ["none", "air", "gray", "dark", "silhouet", "TG", "toon", "rx", "pH"] as const;

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D uSpecies;
uniform usampler2D uShade;
uniform sampler2D uWind;
uniform sampler2D uTemp;
uniform sampler2D uGlow;
uniform float uPh[${N_IDS}];
uniform vec3 uPalette[${N_IDS}];
uniform vec2 uCanvas;
uniform vec2 uGrid;
uniform vec2 uPan;
uniform float uZoom;
uniform float uTime;
uniform int uMode; // 0 none, 1 air, 2 gray, 3 dark, 4 silhouette, 5 thermography
uniform float uFlash; // blast flash 0..1
in vec2 vUv;
out vec4 frag;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// universal indicator ramp: pH 0 red -> 7 green -> 14 violet
vec3 phColor(float p) {
  vec3 c = mix(vec3(0.85, 0.12, 0.10), vec3(0.95, 0.55, 0.10), smoothstep(0.0, 3.5, p));
  c = mix(c, vec3(0.92, 0.88, 0.20), smoothstep(3.5, 5.5, p));
  c = mix(c, vec3(0.25, 0.75, 0.30), smoothstep(5.5, 7.5, p));
  c = mix(c, vec3(0.15, 0.55, 0.80), smoothstep(7.5, 10.0, p));
  c = mix(c, vec3(0.45, 0.25, 0.85), smoothstep(10.0, 14.0, p));
  return c;
}

// byte-encoded temp (T+60)*0.18 -> heat gradient
vec3 heatColor(float v) {
  vec3 c = mix(vec3(0.0, 0.08, 0.2), vec3(0.05, 0.2, 0.35), smoothstep(0.0, 0.06, v));
  c = mix(c, vec3(0.1, 0.55, 0.4), smoothstep(0.06, 0.16, v));
  c = mix(c, vec3(0.85, 0.85, 0.28), smoothstep(0.16, 0.32, v));
  c = mix(c, vec3(1.0, 0.45, 0.1), smoothstep(0.32, 0.55, v));
  c = mix(c, vec3(1.0, 0.15, 0.1), smoothstep(0.55, 0.75, v));
  c = mix(c, vec3(1.0, 1.0, 1.0), smoothstep(0.75, 1.0, v));
  return c;
}

void main() {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uCanvas;
  vec2 cellF = (px - uPan) / uZoom;
  if (cellF.x < 0.0 || cellF.y < 0.0 || cellF.x >= uGrid.x || cellF.y >= uGrid.y) {
    frag = vec4(0.027, 0.031, 0.039, 1.0);
    return;
  }
  ivec2 cell = ivec2(floor(cellF));
  uint id = texelFetch(uSpecies, cell, 0).r;
  if (uMode == 5) {
    // thermography: everything rendered by temperature; matter slightly brighter
    float v = texture(uTemp, cellF / uGrid).r;
    vec3 c = heatColor(v);
    if (id != 0u) c = c * 1.3 + vec3(0.06);
    frag = vec4(c, 1.0);
    return;
  }
  if (uMode == 8) {
    // pH view: aqueous chemistry on the universal indicator ramp
    if (id == 0u) { frag = vec4(0.03, 0.034, 0.042, 1.0); return; }
    float p8 = uPh[int(id)];
    uint sh8 = texelFetch(uShade, cell, 0).r;
    if (id == ${E.LITMUS}u && sh8 <= 14u) p8 = float(sh8);
    if (p8 > 14.5) {
      vec3 g8 = uPalette[id] * 0.18 + vec3(0.05);
      frag = vec4(vec3(dot(g8, vec3(0.299, 0.587, 0.114))), 1.0);
    } else {
      frag = vec4(phColor(p8), 1.0);
    }
    return;
  }
  if (uMode == 7) {
    // reaction glow: the world dimmed, chemistry burning green-white
    float gv = texture(uGlow, cellF / uGrid).r;
    uint sh7 = texelFetch(uShade, cell, 0).r;
    vec3 base = id == 0u
      ? vec3(0.03, 0.036, 0.046)
      : uPalette[id] * (0.82 + float(sh7) * 0.0014) * 0.22;
    vec3 g = vec3(0.25, 1.0, 0.72) * gv * 2.0 + vec3(0.95) * gv * gv * 1.4;
    frag = vec4(base + g, 1.0);
    return;
  }
  if (id == 0u) {
    vec3 bg = vec3(0.043, 0.051, 0.063);
    if (uMode == 1) {
      vec2 w = texture(uWind, cellF / uGrid).rg * 2.0 - 1.0; // 128-centered
      float speed = length(w) * 2.2;
      // direction-tinted airflow: rightward warm, leftward cool, vertical green
      bg += vec3(max(w.x, 0.0) * 1.4, speed * 0.55, max(-w.x, 0.0) * 1.4 + max(-w.y, 0.0) * 0.6) * min(speed, 0.85);
    }
    if (uMode == 0 || uMode == 1) {
      // ambient physics made visible: motes drift with the wind, hot air
      // shimmers orange, cold air frosts blue
      vec2 wv = texture(uWind, cellF / uGrid).rg * 2.0 - 1.0;
      float ws = length(wv);
      if (ws > 0.06) {
        vec2 dir = wv / max(ws, 1e-4);
        float mote = hash(floor((cellF - dir * uTime * (30.0 + 120.0 * ws)) / 3.0));
        bg += vec3(0.09, 0.11, 0.13) * step(0.82, mote) * min(ws * 1.5, 0.55);
      }
      float Tv = texture(uTemp, cellF / uGrid).r;
      float heat = smoothstep(0.099, 0.30, Tv);
      float frost = smoothstep(0.0565, 0.030, Tv);
      bg += vec3(0.22, 0.10, 0.03) * heat * (0.55 + 0.45 * hash(vec2(cell) + floor(uTime * 14.0)));
      bg += vec3(0.015, 0.05, 0.09) * frost;
    }
    bg += vec3(1.0, 0.82, 0.55) * uFlash * 0.45;
    frag = vec4(bg, 1.0);
    return;
  }
  uint shade = texelFetch(uShade, cell, 0).r;
  vec3 col = uPalette[id] * (0.82 + float(shade) * 0.0014);
  if (id == ${E.LITMUS}u && shade <= 14u) {
    col = phColor(float(shade)); // stained indicator paper
  }
  if (id == ${E.FIRE}u) {
    float f = hash(vec2(cell) + floor(uTime * 20.0));
    col = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.85, 0.3), f) * (0.8 + 0.4 * f);
  } else if (id == ${E.MAGMA}u) {
    float f = hash(vec2(cell) * 0.7 + floor(uTime * 6.0));
    col = mix(col, vec3(1.0, 0.75, 0.2), f * 0.35);
  } else if (uMode == 0 || uMode == 1) {
    // matter wears the temperature field: red-hot glow above ~250°, frost rime
    float Tv = texture(uTemp, cellF / uGrid).r;
    float emis = smoothstep(0.22, 0.75, Tv);
    float frost = smoothstep(0.0565, 0.030, Tv);
    col += vec3(1.0, 0.32, 0.06) * emis * 0.85;
    col = mix(col, vec3(0.72, 0.84, 1.0), frost * 0.28);
  }
  if (uMode == 2) {
    col = vec3(dot(col, vec3(0.299, 0.587, 0.114)));
  } else if (uMode == 3) {
    if (id != ${E.FIRE}u && id != ${E.MAGMA}u && id != ${E.SPARK}u) col *= 0.22;
  } else if (uMode == 4) {
    col = vec3(0.92);
  } else if (uMode == 6) {
    col = floor(col * 5.0 + 0.5) / 5.0; // toon: posterized bands
  }
  col += vec3(1.0, 0.82, 0.55) * uFlash * 0.6;
  frag = vec4(col, 1.0);
}`;

export class Renderer {
  private gl: WebGL2RenderingContext;
  private texSpecies: WebGLTexture;
  private texShade: WebGLTexture;
  private texWind: WebGLTexture;
  private texTemp: WebGLTexture;
  private texGlow: WebGLTexture;
  private glowBuf: Uint8Array;
  private tempW: number;
  private tempH: number;
  private tempBuf: Uint8Array;
  private uni: Record<string, WebGLUniformLocation | null> = {};
  private gridW: number;
  private gridH: number;
  private windW: number;
  private windH: number;
  private windBuf: Uint8Array;

  pan = { x: 0, y: 0 };
  zoom = 1;
  mode = 0;

  constructor(private canvas: HTMLCanvasElement, gridW: number, gridH: number) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.windW = gridW >> 2;
    this.windH = gridH >> 2;
    this.windBuf = new Uint8Array(this.windW * this.windH * 2);
    this.tempW = gridW >> 1;
    this.tempH = gridH >> 1;
    this.tempBuf = new Uint8Array(this.tempW * this.tempH);
    this.glowBuf = new Uint8Array(this.windW * this.windH);
    // preserveDrawingBuffer keeps the last frame grabbable for screenshots/capture
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true })!;
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;

    const prog = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VS],
      [gl.FRAGMENT_SHADER, FS],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("shader: " + gl.getShaderInfoLog(sh));
      }
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("link: " + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    for (const name of ["uSpecies", "uShade", "uWind", "uTemp", "uGlow", "uPalette", "uPh", "uCanvas", "uGrid", "uPan", "uZoom", "uTime", "uMode", "uFlash"]) {
      this.uni[name] = gl.getUniformLocation(prog, name);
    }
    gl.uniform3fv(this.uni.uPalette, PALETTE);
    gl.uniform1fv(this.uni.uPh, Float32Array.from(PH));
    gl.uniform2f(this.uni.uGrid, gridW, gridH);
    gl.uniform1i(this.uni.uSpecies, 0);
    gl.uniform1i(this.uni.uShade, 1);
    gl.uniform1i(this.uni.uWind, 2);
    gl.uniform1i(this.uni.uTemp, 3);
    gl.uniform1i(this.uni.uGlow, 4);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.texSpecies = this.makeTex(0, gl.R8UI, this.gridW, this.gridH, gl.NEAREST);
    this.texShade = this.makeTex(1, gl.R8UI, this.gridW, this.gridH, gl.NEAREST);
    this.texWind = this.makeTex(2, gl.RG8, this.windW, this.windH, gl.LINEAR);
    this.texTemp = this.makeTex(3, gl.R8, this.tempW, this.tempH, gl.LINEAR);
    this.texGlow = this.makeTex(4, gl.R8, this.windW, this.windH, gl.LINEAR);
  }

  private makeTex(unit: number, format: number, w: number, h: number, filter: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** re-upload the palette after registering custom elements */
  refreshPalette(): void {
    this.gl.uniform3fv(this.uni.uPalette, PALETTE);
    this.gl.uniform1fv(this.uni.uPh, Float32Array.from(PH));
  }

  fit(): void {
    const { canvas } = this;
    this.zoom = Math.min(canvas.width / this.gridW, canvas.height / this.gridH);
    this.pan.x = (canvas.width - this.gridW * this.zoom) / 2;
    this.pan.y = (canvas.height - this.gridH * this.zoom) / 2;
  }

  toCell(px: number, py: number): { x: number; y: number } {
    return {
      x: Math.floor((px - this.pan.x) / this.zoom),
      y: Math.floor((py - this.pan.y) / this.zoom),
    };
  }

  zoomAt(px: number, py: number, factor: number): void {
    const before = this.zoom;
    this.zoom = Math.min(32, Math.max(0.25, this.zoom * factor));
    const k = this.zoom / before;
    this.pan.x = px - (px - this.pan.x) * k;
    this.pan.y = py - (py - this.pan.y) * k;
  }

  draw(
    species: Uint8Array,
    shade: Uint8Array,
    fillWind: (buf: Uint8Array) => void,
    fillTemp: (buf: Uint8Array) => void,
    fillGlow: (buf: Uint8Array) => void,
    timeSec: number,
    fxPower = 0,
    overlays?: Array<{ x0: number; y0: number; w: number; h: number; species: Uint8Array; shade: Uint8Array }>,
  ): void {
    const gl = this.gl;
    const { canvas } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texSpecies);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gridW, this.gridH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, species);
    if (overlays) {
      for (const o of overlays) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, o.x0, o.y0, o.w, o.h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, o.species);
      }
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texShade);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gridW, this.gridH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, shade);
    if (overlays) {
      for (const o of overlays) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, o.x0, o.y0, o.w, o.h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, o.shade);
      }
    }
    if (this.mode <= 1) {
      // ambient overlays sample wind + temp in the normal view too
      fillWind(this.windBuf);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.texWind);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.windW, this.windH, gl.RG, gl.UNSIGNED_BYTE, this.windBuf);
    }
    if (this.mode <= 1 || this.mode === 5) {
      fillTemp(this.tempBuf);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.texTemp);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.tempW, this.tempH, gl.RED, gl.UNSIGNED_BYTE, this.tempBuf);
    }
    if (this.mode === 7) {
      fillGlow(this.glowBuf);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.texGlow);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.windW, this.windH, gl.RED, gl.UNSIGNED_BYTE, this.glowBuf);
    }
    gl.uniform2f(this.uni.uCanvas, canvas.width, canvas.height);
    // blast feedback: white-hot flash and a decaying screen shake
    const shake = Math.min(13, fxPower * 0.32);
    const sx = shake > 0.3 ? (Math.random() * 2 - 1) * shake : 0;
    const sy = shake > 0.3 ? (Math.random() * 2 - 1) * shake : 0;
    gl.uniform1f(this.uni.uFlash, Math.min(1, fxPower / 34));
    gl.uniform2f(this.uni.uPan, this.pan.x + sx, this.pan.y + sy);
    gl.uniform1f(this.uni.uZoom, this.zoom);
    gl.uniform1f(this.uni.uTime, timeSec);
    gl.uniform1i(this.uni.uMode, this.mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
