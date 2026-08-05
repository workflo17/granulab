import "./style.css";
import { World } from "./engine/world";
import { Player, Fighter } from "./engine/player";
import { ObjectSystem } from "./engine/objects";
import { Renderer } from "./render/renderer";
import { Ui, TOOL_PLAYER, TOOL_FIGHTER } from "./ui/ui";
import { E, ELEMENTS, registerElement, type CustomSpec } from "./engine/elements";

const GRID_W = 1280;
const GRID_H = 720;

// custom elements persist per-browser and register before the UI builds
const CUSTOM_KEY = "granulab-custom";
const customSpecs: CustomSpec[] = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
const customIds: number[] = [];
for (const s of customSpecs) {
  const id = registerElement(s);
  if (id !== null) customIds.push(id);
}

const world = new World(GRID_W, GRID_H);
const player = new Player();
const objects = new ObjectSystem(world);
const fighters: Fighter[] = [];
const keys = { left: false, right: false, up: false };
const root = document.getElementById("app")!;

/** one full simulation tick: cells, rigid objects, stickmen */
function simTick(): void {
  world.step();
  objects.update();
  player.update(world, keys);
  for (const f of fighters) f.update(world, f.think(world, player));
}

// ---- save / load ---------------------------------------------------------
const toB64 = (buf: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
const fromB64 = (b64: string): Uint8Array => {
  const s = atob(b64);
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  return buf;
};
const QUICK_KEY = "granulab-quick";

// combined snapshot: [u32 worldLen][world GRN1][objects block]; legacy raw GRN1 loads too
function saveAll(): Uint8Array {
  const w = world.serialize();
  const o = objects.serialize();
  const buf = new Uint8Array(4 + w.length + o.length);
  buf[0] = w.length & 255; buf[1] = (w.length >> 8) & 255;
  buf[2] = (w.length >> 16) & 255; buf[3] = (w.length >> 24) & 255;
  buf.set(w, 4);
  buf.set(o, 4 + w.length);
  return buf;
}
function loadAll(buf: Uint8Array): boolean {
  fighters.length = 0;
  if (buf[0] === 0x47 && buf[1] === 0x52 && buf[2] === 0x4e) {
    objects.clear();
    return world.deserialize(buf); // legacy world-only save
  }
  const wLen = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
  if (4 + wLen > buf.length) return false;
  const ok = world.deserialize(buf.subarray(4, 4 + wLen));
  if (ok) objects.deserialize(buf.subarray(4 + wLen));
  return ok;
}

// share codes: deflate + base64, no backend needed
async function deflateBuf(buf: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([buf]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function inflateBuf(buf: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const CODE_PREFIX = "GLAB1.";
async function sceneCode(): Promise<string> {
  return CODE_PREFIX + toB64(await deflateBuf(saveAll()));
}
async function loadSceneCode(code: string): Promise<boolean> {
  const t = code.trim();
  if (!t.startsWith(CODE_PREFIX)) return false;
  try {
    return loadAll(await inflateBuf(fromB64(t.slice(CODE_PREFIX.length))));
  } catch {
    return false;
  }
}
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".grn";
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const ok = loadAll(new Uint8Array(await f.arrayBuffer()));
  if (!ok) alert("Not a Granulab scene for this grid size.");
  fileInput.value = "";
});

let renderer: Renderer;
const ui = new Ui(root, {
  onStep: () => { ui.setPaused(true); stepOnce(); },
  onClear: () => { world.clear(); player.remove(); objects.clear(); fighters.length = 0; },
  onFit: () => renderer.fit(),
  onBgMode: (m: number) => { renderer.mode = m; },
  onSave: () => localStorage.setItem(QUICK_KEY, toB64(saveAll())),
  onLoad: () => {
    const b64 = localStorage.getItem(QUICK_KEY);
    if (b64) loadAll(fromB64(b64));
  },
  onExport: () => {
    const blob = new Blob([saveAll()], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "granulab-scene.grn";
    a.click();
    URL.revokeObjectURL(a.href);
  },
  onImport: () => fileInput.click(),
  onCopyCode: async () => {
    const code = await sceneCode();
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      prompt("Copy this scene code:", code);
    }
  },
  onPasteCode: async () => {
    const code = prompt("Paste a scene code:");
    if (code && !(await loadSceneCode(code))) alert("Not a valid Granulab scene code.");
  },
  onCreateElement: createCustomElement,
});

function createCustomElement(spec: CustomSpec): number | null {
  const id = registerElement(spec);
  if (id === null) {
    alert("Element limit reached (21 custom slots).");
    return null;
  }
  customSpecs.push(spec);
  customIds.push(id);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSpecs));
  renderer.refreshPalette();
  ui.addElementButton(id);
  ui.bind("L", id);
  return id;
}

const canvas = document.getElementById("dish") as HTMLCanvasElement;
renderer = new Renderer(canvas, GRID_W, GRID_H);
for (const id of customIds) ui.addElementButton(id); // persisted customs
const bgHash = location.hash.match(/bg=(\d)/); // shot harness can pick a BG mode
if (bgHash) renderer.mode = parseInt(bgHash[1]);

// ---- canvas sizing -------------------------------------------------------
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    renderer.fit();
  }
}
new ResizeObserver(resize).observe(canvas);
resize();

// ---- painting ------------------------------------------------------------
let strokeAngle = 0; // byte angle of the current pen stroke — fans blow this way

function stamp(cx: number, cy: number, r: number, id: number): void {
  const aux = id === E.FAN ? strokeAngle : undefined;
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) world.paint(cx + dx, cy + dy, id, aux);
    }
  }
}

function stampLine(x0: number, y0: number, x1: number, y1: number, r: number, id: number): void {
  const dist = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 2)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stamp(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), r, id);
  }
}

function toCanvasPx(e: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  return { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
}

let painting = -1; // element id being painted, -2 = none
let lastCell: { x: number; y: number } | null = null;
let panning = false;
let panStart = { x: 0, y: 0, px: 0, py: 0 };

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const px = toCanvasPx(e);
  if (e.button === 1) {
    panning = true;
    panStart = { x: renderer.pan.x, y: renderer.pan.y, px: px.x, py: px.y };
    e.preventDefault();
    return;
  }
  const tool = e.button === 2 ? ui.state.toolR : ui.state.toolL;
  const c = renderer.toCell(px.x, px.y);
  if (tool === TOOL_PLAYER) {
    player.place(c.x, c.y);
    return;
  }
  if (tool === TOOL_FIGHTER) {
    if (fighters.length < 8) {
      const f = new Fighter();
      f.place(c.x, c.y);
      fighters.push(f);
    }
    return;
  }
  if (tool === E.BALL || tool === E.BOX || tool === E.WHEEL) {
    objects.spawnId(tool, c.x, c.y);
    return;
  }
  painting = tool;
  if (tool === E.EMPTY) objects.removeAt(c.x, c.y);
  if (ui.state.penMode === "free") {
    stamp(c.x, c.y, ui.state.pen, painting);
  }
  lastCell = c;
});
canvas.addEventListener("pointermove", (e) => {
  const px = toCanvasPx(e);
  const c = renderer.toCell(px.x, px.y);
  ui.setPos(c.x >= 0 && c.x < GRID_W && c.y >= 0 && c.y < GRID_H ? c.x : -1, c.y);
  if (panning) {
    renderer.pan.x = panStart.x + (px.x - panStart.px);
    renderer.pan.y = panStart.y + (px.y - panStart.py);
    return;
  }
  if (painting >= 0 && lastCell && ui.state.penMode === "free") {
    const ddx = c.x - lastCell.x;
    const ddy = c.y - lastCell.y;
    if (ddx * ddx + ddy * ddy >= 4) {
      strokeAngle = (Math.round((Math.atan2(ddy, ddx) / (Math.PI * 2)) * 256) + 256) & 255;
    }
    if (painting === E.EMPTY) objects.removeAt(c.x, c.y);
    stampLine(lastCell.x, lastCell.y, c.x, c.y, ui.state.pen, painting);
    lastCell = c;
  }
  lastHover = c;
});
let lastHover: { x: number; y: number } | null = null;
canvas.addEventListener("pointerup", () => {
  // line/rect pens stamp on release, from the press cell to the release cell
  if (painting >= 0 && lastCell && lastHover && ui.state.penMode !== "free") {
    const a = lastCell;
    const b = lastHover;
    const ddx = b.x - a.x;
    const ddy = b.y - a.y;
    if (ddx * ddx + ddy * ddy >= 4) {
      strokeAngle = (Math.round((Math.atan2(ddy, ddx) / (Math.PI * 2)) * 256) + 256) & 255;
    }
    if (ui.state.penMode === "line") {
      stampLine(a.x, a.y, b.x, b.y, ui.state.pen, painting);
    } else {
      const id = painting;
      const aux = id === E.FAN ? strokeAngle : undefined;
      for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
        for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
          world.paint(x, y, id, aux);
        }
      }
    }
  }
  painting = -1;
  lastCell = null;
  panning = false;
});
canvas.addEventListener("pointercancel", () => { painting = -1; lastCell = null; panning = false; });

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const px = toCanvasPx(e);
  renderer.zoomAt(px.x, px.y, Math.pow(1.0015, -e.deltaY));
}, { passive: false });

// ---- keyboard ------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "ArrowLeft") { keys.left = true; e.preventDefault(); }
  else if (e.code === "ArrowRight") { keys.right = true; e.preventDefault(); }
  else if (e.code === "ArrowUp") { keys.up = true; e.preventDefault(); }
  else if (e.code === "Space") { e.preventDefault(); ui.setPaused(!ui.state.paused); }
  else if (e.code === "Enter") { ui.setPaused(true); stepOnce(); }
  else if (e.key >= "1" && e.key <= "9") ui.setPen([1, 2, 4, 6, 8, 12, 16, 24, 32][parseInt(e.key) - 1]);
  else if (e.key === "0") ui.setPen(48);
});
window.addEventListener("keyup", (e) => {
  if (e.code === "ArrowLeft") keys.left = false;
  else if (e.code === "ArrowRight") keys.right = false;
  else if (e.code === "ArrowUp") keys.up = false;
});

// ---- loop ----------------------------------------------------------------
let acc = 0;
let selfChecked = false;
let shotDone = false;
let lastT = performance.now();
let fpsEma = 60;
let tickEma = 0;
let statTimer = 0;

function stepOnce(): void {
  const t0 = performance.now();
  simTick();
  tickEma = tickEma * 0.9 + (performance.now() - t0) * 0.1;
}

function frame(now: number): void {
  const dt = Math.min(100, now - lastT);
  lastT = now;
  fpsEma = fpsEma * 0.95 + (1000 / Math.max(1, dt)) * 0.05;

  if (!ui.state.paused) {
    acc += (dt / (1000 / 60)) * ui.state.speed;
    let n = 0;
    while (acc >= 1 && n < 8) { stepOnce(); acc--; n++; }
    if (acc > 8) acc = 0; // dropped frames: don't spiral
  }

  const overlays = [];
  const pp = player.patch(world);
  if (pp) overlays.push(pp);
  for (const f of fighters) {
    const fp = f.patch(world);
    if (fp) overlays.push(fp);
  }
  renderer.draw(
    world.species, world.shade,
    (buf) => world.fillWindTex(buf),
    (buf) => world.fillTempTex(buf),
    now / 1000, overlays,
  );
  if (!selfChecked && world.frame > 30) {
    selfChecked = true;
    const gl = canvas.getContext("webgl2")!;
    const px = new Uint8Array(4);
    gl.readPixels((canvas.width / 2) | 0, (canvas.height / 2) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    console.log(`[granulab-selfcheck] glErr=${gl.getError()} centerPx=${px[0]},${px[1]},${px[2]} dots=${world.dots} frame=${world.frame} zoom=${renderer.zoom.toFixed(3)} canvas=${canvas.width}x${canvas.height}`);
  }
  // QA shot: #demo&shot=NAME posts the settled scene to the dev-server shot sink
  if (!shotDone && world.frame > 760 && location.hash.includes("shot=")) {
    shotDone = true;
    const name = location.hash.split("shot=")[1] ?? "demo";
    fetch("/__shot?name=" + name, { method: "POST", body: canvas.toDataURL("image/png") })
      .then(() => console.log("[granulab-shot] saved " + name));
  }

  statTimer += dt;
  if (statTimer > 250) {
    statTimer = 0;
    ui.setStats(fpsEma, tickEma, world.dots, world.activeChunkCount());
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- QA / debug API (used by automated verification and future replays) --
declare global {
  interface Window { granulab: Record<string, unknown>; }
}
const byName = (name: string): number => {
  const el = ELEMENTS.find((d) => d.name.toLowerCase() === name.toLowerCase());
  return el ? el.id : E.POWDER;
};
// #demo: reproducible showcase scene (also used by headless screenshot QA)
function demoScene(): void {
  world.clear();
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 40, 640, 1240, 652);
  R("Wall", 40, 420, 52, 652);
  R("Wall", 1228, 420, 1240, 652);
  R("Wall", 420, 520, 620, 530);
  R("Powder", 80, 200, 360, 380);
  R("Water", 660, 200, 1000, 340);
  R("Oil", 700, 120, 900, 170);
  R("Seed", 460, 300, 580, 306);
  R("Water", 440, 400, 600, 440);
  R("Gas", 1050, 560, 1150, 620);
  // M2: magma drips into the pool (stone + steam), a fan blows the dune's crest,
  // a spark pulse travels a metal wire, salt dissolves into seawater
  R("Magma", 980, 60, 1060, 90);
  R("Salt", 820, 100, 860, 116);
  R("Metal", 100, 100, 400, 104);
  world.paint(100, 100, byName("Spark"));
  const fan = byName("Fan");
  for (let y = 470; y <= 500; y++) for (let x = 70; x <= 78; x++) world.paint(x, y, fan, 0); // blow right
  // M2b toys: raining cloud, bouncing superballs, birds, endless fireworks, stickman
  R("Cloud", 150, 70, 330, 86);
  R("Ice", 700, 616, 780, 638); // cold pole for the thermography view
  R("Superball", 470, 120, 490, 130);
  for (const [bx, by] of [[880, 140], [930, 170], [980, 120]]) world.paint(bx, by, byName("Bird"), 1);
  R("Clone", 626, 626, 628, 636); // remembers fireworks, feeds the launcher
  R("Fireworks", 630, 628, 646, 636);
  R("Torch", 648, 630, 650, 636);
  player.place(560, 400);
  // rigid objects: ball bounces on the terrace, wheel rolls down the dune, box rests
  objects.spawn("ball", 540, 200);
  objects.spawn("wheel", 300, 100);
  objects.spawn("box", 740, 300);
  const fighter = new Fighter();
  fighter.place(460, 300);
  fighters.push(fighter);
  if (location.hash.includes("shot=")) {
    // shot harness: settle synchronously so the capture gate is reached fast
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  // pre-settle in slices so the first paint isn't blocked for seconds on slow GPUs
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 700 && performance.now() - t0 < 24) { world.step(); settled++; }
    if (settled < 700) requestAnimationFrame(settle);
  };
  settle();
}
if (location.hash.startsWith("#demo")) demoScene();

window.granulab = {
  demo: demoScene,
  player,
  fighters,
  objects,
  spawnFighter: (x: number, y: number) => { const f = new Fighter(); f.place(x, y); fighters.push(f); return f; },
  createElement: createCustomElement,
  code: sceneCode,
  loadCode: loadSceneCode,
  keys,
  save: () => toB64(saveAll()),
  restore: (b64: string) => loadAll(fromB64(b64)),
  world,
  renderer,
  ui,
  paint: (name: string, x: number, y: number, r = 4) => stamp(x, y, r, byName(name)),
  rect: (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  },
  tick: (n = 1) => { for (let i = 0; i < n; i++) simTick(); },
  pause: (p: boolean) => ui.setPaused(p),
  count: (name: string) => {
    const id = byName(name);
    let c = 0;
    for (let i = 0; i < world.species.length; i++) if (world.species[i] === id) c++;
    return c;
  },
  stats: () => ({ fps: fpsEma, tickMs: tickEma, dots: world.dots, chunks: world.activeChunkCount(), frame: world.frame }),
};
