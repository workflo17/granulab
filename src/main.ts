import "./style.css";
import { World } from "./engine/world";
import { WasmWorld } from "./engine/world-wasm";
import wasmUrl from "../asm/build/engine.wasm?url";
import { Player, Fighter } from "./engine/player";
import { ObjectSystem } from "./engine/objects";
import { Renderer } from "./render/renderer";
import { Ui, readJson, TOOL_PLAYER, TOOL_FIGHTER, TOOL_STIR, type GalleryScene } from "./ui/ui";
import {
  E, B, N_IDS, BEHAVIOR, ELEMENTS, PALETTE, registerElement, type CustomSpec,
  DENSITY, DISPERSE, FLAMMABLE, BURNLIFE, LIFE0, EXPLODE_R, TEMP0, HEAT_PUMP,
  HOT_AT, HOT_TO, COLD_AT, COLD_TO, IGNITES_AT, HEAT_COND, SLICK, BOUNCE,
} from "./engine/elements";

const GRID_W = 1280;
const GRID_H = 720;

// custom elements persist per-browser and register before the UI builds.
// Capture the base id FIRST: everything at or above it is user-invented and
// therefore has to travel inside a shared scene rather than being assumed.
const FIRST_CUSTOM_ID = ELEMENTS.length;
const CUSTOM_KEY = "granulab-custom";
const customSpecs: CustomSpec[] = readJson<CustomSpec[]>(CUSTOM_KEY, [], Array.isArray);
const customIds: number[] = [];
for (const s of customSpecs) {
  const id = registerElement(s);
  if (id !== null) customIds.push(id);
}

// ---- element tuning ------------------------------------------------------
// DESIGN pillar 2 promised per-element sliders — gravity, flammability,
// viscosity, lifespan — live. The registry is flat arrays the sim reads every
// tick, so a tweak IS the edit; the only extra work is re-pushing the tables to
// the WASM engine, which copies them at init. Tuning is keyed by element NAME,
// because a deleted invention slides every later id down.
interface Tunable {
  key: string;
  label: string;
  arr: Uint8Array | Int16Array | Float32Array;
  min: number;
  max: number;
  step: number;
  /** only offer it where it means something (a melting point on stone does not) */
  when?: (id: number) => boolean;
}
const TUNABLES: Tunable[] = [
  { key: "density", label: "density", arr: DENSITY, min: 1, max: 255, step: 1 },
  { key: "disperse", label: "spread", arr: DISPERSE, min: 0, max: 16, step: 1 },
  { key: "flammable", label: "flammability", arr: FLAMMABLE, min: 0, max: 255, step: 1 },
  { key: "burnLife", label: "burn time", arr: BURNLIFE, min: 0, max: 255, step: 1 },
  { key: "life0", label: "lifespan", arr: LIFE0, min: 0, max: 255, step: 1 },
  { key: "explodeR", label: "blast radius", arr: EXPLODE_R, min: 0, max: 16, step: 1 },
  { key: "temp0", label: "own temp °C", arr: TEMP0, min: -273, max: 1500, step: 1 },
  { key: "heatPump", label: "heat output", arr: HEAT_PUMP, min: 0, max: 0.35, step: 0.01 },
  { key: "heatCond", label: "conducts heat", arr: HEAT_COND, min: 0, max: 1, step: 0.01 },
  { key: "hotAt", label: "melts at °C", arr: HOT_AT, min: -273, max: 1500, step: 5, when: (id) => HOT_TO[id] !== 0 },
  { key: "coldAt", label: "freezes at °C", arr: COLD_AT, min: -273, max: 1500, step: 5, when: (id) => COLD_TO[id] !== 0 },
  { key: "ignitesAt", label: "ignites at °C", arr: IGNITES_AT, min: 0, max: 1500, step: 5, when: (id) => IGNITES_AT[id] < 32767 },
  { key: "slick", label: "slipperiness", arr: SLICK, min: 0, max: 1, step: 0.05 },
  { key: "bounce", label: "bounciness", arr: BOUNCE, min: 0, max: 2, step: 0.05 },
];
const TUNE_KEY = "granulab-tuning";
/** every tunable's shipped value, captured before any override lands */
const TUNE_DEFAULTS = new Map(TUNABLES.map((t) => [t.key, Array.from(t.arr)]));
const tuning: Record<string, Record<string, number>> = readJson(TUNE_KEY, {});

const idOfName = (name: string): number =>
  ELEMENTS.findIndex((el) => el.name === name);

function applyTuning(): void {
  for (const [name, props] of Object.entries(tuning)) {
    const id = idOfName(name);
    if (id < 0) continue;
    for (const t of TUNABLES) {
      const v = props[t.key];
      if (v !== undefined) t.arr[id] = v;
    }
  }
}
// before the world is built, so the WASM engine takes the tuned tables at init
applyTuning();

// ---- engine select: ?engine=wasm|ts beats localStorage granulab-engine ----
// The WASM engine is bit-exact with the TS one (tools/parity.ts, 5 gates) and
// ~2x faster in the hot phases; TS remains the default until it has soaked.
const engineChoice =
  new URLSearchParams(location.search).get("engine") ??
  localStorage.getItem("granulab-engine") ?? "wasm"; // default flipped 8/08 post-soak
let engineActive = "ts";
async function makeWorld(): Promise<World> {
  if (engineChoice === "wasm") {
    try {
      const bytes = await (await fetch(wasmUrl)).arrayBuffer();
      const ww = new WasmWorld(bytes, GRID_W, GRID_H);
      await ww.ready;
      engineActive = "wasm";
      console.log("[granulab] WASM engine active");
      // WasmWorld mirrors World's public surface exactly; World's private
      // fields block nominal assignability, hence the cast
      return ww as unknown as World;
    } catch (err) {
      console.warn("[granulab] WASM engine unavailable, using TS engine", err);
    }
  }
  return new World(GRID_W, GRID_H);
}
const world = await makeWorld();
const player = new Player();
const objects = new ObjectSystem(world);
const fighters: Fighter[] = [];
const keys = { left: false, right: false, up: false };
const root = document.getElementById("app")!;

// The renderer throws if WebGL2 is missing, but it is built ~300 lines after the
// UI is — so without this check the toolbar, palette and footer all appear and
// then every control that touches the renderer throws on click: a dead lab that
// looks alive. Check before anything is drawn, and say what happened.
if (!(() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } })()) {
  root.innerHTML = `<div class="fatal">
    <h1>Granulab needs WebGL2</h1>
    <p>This browser cannot give the page a WebGL2 canvas, and the simulation is drawn entirely on
      one. Nothing here will work without it.</p>
    <p>Usually that means hardware acceleration is switched off, or the browser is a few versions
      behind. Turning acceleration back on in the browser's settings, or updating it, fixes it.</p>
  </div>`;
  throw new Error("[granulab] WebGL2 unavailable — halted before building the UI");
}

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

// Combined snapshot. v2 = ["GLC2"][u32 customLen][custom JSON][u32 worldLen]
// [world GRN1][objects block]; v1 = [u32 worldLen][world][objects]; legacy raw
// GRN1 also loads. The custom block is what makes a shared scene carry its own
// chemistry: without it a scene painted with someone's invented element loads
// as whatever YOUR id 106 happens to be, which is usually nothing.
const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const rd32 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function saveAll(): Uint8Array {
  const w = world.serialize();
  const o = objects.serialize();
  // only the customs this scene actually uses travel with it
  const used = new Set<number>();
  for (let i = 0; i < world.species.length; i++) {
    const id = world.species[i];
    if (id >= FIRST_CUSTOM_ID) used.add(id);
  }
  const carried = customIds
    .map((id, k) => ({ id, spec: customSpecs[k] }))
    .filter((c) => used.has(c.id) && c.spec);
  const cJson = new TextEncoder().encode(carried.length ? JSON.stringify(carried) : "");
  const head = [0x47, 0x4c, 0x43, 0x32, ...u32(cJson.length)];
  const buf = new Uint8Array(head.length + cJson.length + 4 + w.length + o.length);
  buf.set(head, 0);
  buf.set(cJson, head.length);
  let p = head.length + cJson.length;
  buf.set(u32(w.length), p);
  buf.set(w, p + 4);
  buf.set(o, p + 4 + w.length);
  return buf;
}

/** adopt the scene's custom elements, reusing an identical local one where it
 *  exists and registering a fresh id otherwise, then rewrite the grid so the
 *  cells point at whatever id they ended up with here */
/** how many NEW elements one incoming scene may add to your permanent list.
 *  There are only ~22 slots, and a scene carrying a dozen used to fill them
 *  silently, one "Created X" toast at a time, and leave your pen holding the
 *  last of them. A scene that genuinely needs more than this is not a scene. */
const MAX_ADOPT = 6;

function adoptCustoms(json: string): void {
  let carried: { id: number; spec: CustomSpec }[];
  try {
    carried = JSON.parse(json);
  } catch {
    return;
  }
  if (!Array.isArray(carried)) return;
  const remap = new Map<number, number>();
  let adopted = 0;
  let refused = 0;
  for (const c of carried) {
    if (!c || typeof c.id !== "number" || !c.spec) continue;
    const sig = JSON.stringify(c.spec);
    const existing = customSpecs.findIndex((s) => JSON.stringify(s) === sig);
    let local = existing >= 0 ? customIds[existing] : -1;
    if (local < 0) {
      // over the ceiling, or out of slots: blank those cells rather than let
      // them read as whatever element happens to hold that id here
      const made = adopted < MAX_ADOPT ? registerAndPersist(c.spec) : null;
      if (made === null) {
        refused++;
        remap.set(c.id, E.EMPTY);
        continue;
      }
      adopted++;
      local = made;
    }
    if (local !== c.id) remap.set(c.id, local);
  }
  if (adopted > 0) {
    ui.toast(`Adopted ${adopted} element${adopted === 1 ? "" : "s"} from this scene`);
  }
  if (refused > 0) {
    ui.toast(`${refused} more element${refused === 1 ? " was" : "s were"} left out — those cells are empty.`, "err");
  }
  if (remap.size === 0) return;
  const sp = world.species;
  for (let i = 0; i < sp.length; i++) {
    const to = remap.get(sp[i]);
    if (to !== undefined) sp[i] = to;
  }
}

function loadAll(buf: Uint8Array): boolean {
  fighters.length = 0;
  if (buf[0] === 0x47 && buf[1] === 0x52 && buf[2] === 0x4e) {
    objects.clear();
    return world.deserialize(buf); // legacy world-only save
  }
  let customJson = "";
  let p = 0;
  if (buf[0] === 0x47 && buf[1] === 0x4c && buf[2] === 0x43 && buf[3] === 0x32) {
    const cLen = rd32(buf, 4);
    if (8 + cLen > buf.length) return false;
    if (cLen > 0) customJson = new TextDecoder().decode(buf.subarray(8, 8 + cLen));
    p = 8 + cLen;
  }
  const wLen = rd32(buf, p);
  if (p + 4 + wLen > buf.length) return false;
  const ok = world.deserialize(buf.subarray(p + 4, p + 4 + wLen));
  if (ok) {
    if (customJson) adoptCustoms(customJson);
    objects.deserialize(buf.subarray(p + 4 + wLen));
  }
  return ok;
}

// share codes: deflate + base64, no backend needed
async function deflateBuf(buf: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([buf as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function inflateBuf(buf: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([buf as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
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
// ---- video capture --------------------------------------------------------
// The "gif/replay export" pillar, done the way a browser actually can: record
// the live canvas. Recording the canvas rather than replaying a seed means it
// captures exactly what the user saw, hand-painting included.
let recorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recStart = 0;

function recordingSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof canvas.captureStream === "function";
}

function startRecording(): boolean {
  if (recorder || !recordingSupported()) return false;
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  try {
    recorder = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime } : undefined);
  } catch {
    recorder = null;
    return false;
  }
  recChunks = [];
  recStart = performance.now();
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder?.mimeType || "video/webm" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `granulab-${Date.now().toString(36)}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    recorder = null;
    recChunks = [];
    ui.setRecording(false, 0);
  };
  recorder.start(1000);
  ui.setRecording(true, 0);
  return true;
}

function stopRecording(): void {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

function toggleRecording(): boolean {
  if (recorder) { stopRecording(); return false; }
  return startRecording();
}

// ---- undo -----------------------------------------------------------------
// A sandbox where one stray click can wreck an hour of building needs a way
// back. Snapshots are the same bytes as a save, so this costs no new format.
const UNDO_MAX = 24;
const undoStack: Uint8Array[] = [];
const redoStack: Uint8Array[] = [];
let undoArmed = true; // one snapshot per stroke, not per painted cell

function pushUndo(): void {
  if (!undoArmed) return;
  undoArmed = false;
  undoStack.push(saveAll());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0; // a fresh edit abandons the branch you undid away from
  ui.setHistory(undoStack.length, redoStack.length);
}
/** call when a stroke/action finishes so the next one snapshots again */
function armUndo(): void {
  undoArmed = true;
}
/** step the history one way; redo is just the same ring run backwards */
function stepHistory(from: Uint8Array[], to: Uint8Array[]): boolean {
  const snap = from.pop();
  if (!snap) { ui.setHistory(undoStack.length, redoStack.length); return false; }
  to.push(saveAll());
  if (to.length > UNDO_MAX) to.shift();
  loadAll(snap);
  ui.setHistory(undoStack.length, redoStack.length);
  return true;
}
const undo = (): boolean => stepHistory(undoStack, redoStack);
const redo = (): boolean => stepHistory(redoStack, undoStack);

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".grn";
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const ok = loadAll(new Uint8Array(await f.arrayBuffer()));
  ui.toast(ok ? `Opened ${f.name}` : "That file is not a Granulab scene for this grid size.", ok ? "ok" : "err");
  fileInput.value = "";
});

// ---- save slots ----------------------------------------------------------
// One quicksave was fine while a scene took a minute to build. Builders keep
// several going, so six named slots live in localStorage, each with the same
// thumbnail the gallery uses.
const SLOT_KEY = "granulab-slots";
const SLOT_COUNT = 6;
type Slot = { name: string; when: number; data: string; thumb?: string } | null;

function readSlots(): Slot[] {
  let slots: Slot[] = readJson<Slot[]>(SLOT_KEY, [], Array.isArray);
  slots.length = SLOT_COUNT;
  for (let i = 0; i < SLOT_COUNT; i++) if (!slots[i]?.data) slots[i] = null;
  // carry the old single quicksave into slot 1 rather than orphaning it
  const quick = localStorage.getItem(QUICK_KEY);
  if (quick && !slots.some((s) => s)) slots[0] = { name: "quicksave", when: Date.now(), data: quick };
  return slots;
}

function writeSlots(slots: Slot[]): void {
  try {
    localStorage.setItem(SLOT_KEY, JSON.stringify(slots));
  } catch {
    ui.toast("This browser is out of local storage. Delete a slot and try again.", "err");
  }
  pushSlotsToUi(slots);
}

function pushSlotsToUi(slots: Slot[]): void {
  ui.setSlots(slots.map((s) => (s ? { name: s.name, when: s.when, size: s.data.length, thumb: s.thumb } : null)));
}

// ---- settings ------------------------------------------------------------
const SET_KEY = "granulab-settings";
const settings: { cvd: boolean; minimap: boolean; engine: string; telemetry: boolean } = {
  cvd: false, minimap: true, telemetry: true, engine: engineChoice,
  ...readJson<Record<string, unknown>>(SET_KEY, {}),
};

/** the TS engine reads the registry arrays directly; the WASM one holds a copy */
function refreshEngineTables(): void {
  (world as unknown as { refreshTables?: () => void }).refreshTables?.();
}

function pushTunablesToUi(): void {
  const id = ui.state.toolL;
  const el = ELEMENTS[id];
  if (!el || id <= E.WALL) { ui.setTunables(null); return; }
  ui.setTunables({
    name: el.name,
    color: el.color,
    tuned: !!tuning[el.name],
    rows: TUNABLES.filter((t) => !t.when || t.when(id)).map((t) => ({
      key: t.key,
      label: t.label,
      min: t.min,
      max: t.max,
      step: t.step,
      value: t.arr[id],
      isDefault: t.arr[id] === TUNE_DEFAULTS.get(t.key)![id],
    })),
  });
}

let renderer: Renderer;
const ui = new Ui(root, {
  onStep: () => { ui.setPaused(true); stepOnce(); },
  onClear: () => { pushUndo(); armUndo(); world.clear(); player.remove(); objects.clear(); fighters.length = 0; },
  onUndo: () => { if (!undo()) ui.toast("Nothing left to undo", "err"); },
  onRedo: () => { if (!redo()) ui.toast("Nothing to redo", "err"); },
  onRecord: () => {
    if (!recordingSupported()) {
      ui.toast("This browser cannot record the canvas.", "err");
      return;
    }
    ui.toast(toggleRecording() ? "Recording — press stop to download the clip" : "Recording saved");
  },
  onFit: () => { renderer.fit(); ui.setZoom(renderer.zoom); },
  onBgMode: (m: number) => { renderer.mode = m; },
  onSlotSave: (i: number, name: string) => {
    const slots = readSlots();
    slots[i] = { name, when: Date.now(), data: toB64(saveAll()), thumb: sceneThumb() };
    writeSlots(slots);
    ui.toast(`Saved "${name}" to slot ${i + 1}`);
  },
  onSlotLoad: (i: number) => {
    const slot = readSlots()[i];
    if (!slot) return;
    pushUndo();
    armUndo();
    loadAll(fromB64(slot.data));
    ui.toast(`Loaded "${slot.name}"`);
  },
  onSlotDelete: (i: number) => {
    const slots = readSlots();
    const gone = slots[i]?.name;
    slots[i] = null;
    writeSlots(slots);
    ui.toast(`Deleted "${gone ?? `slot ${i + 1}`}"`);
  },
  onExport: () => {
    ui.toast("Exported granulab-scene.grn");
    const blob = new Blob([saveAll() as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
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
      ui.toast(`Share code copied — ${code.length} characters`);
    } catch {
      // clipboard blocked (no gesture, no permission): hand the code over anyway
      ui.showCode(code);
    }
  },
  onPasteCode: () => ui.askCode(),
  onCodeEntered: async (code: string) => {
    if (!code.trim()) return;
    pushUndo();
    armUndo();
    const ok = await loadSceneCode(code);
    ui.toast(ok ? "Scene loaded from code" : "That is not a Granulab scene code.", ok ? "ok" : "err");
  },
  onSetting: (key: "cvd" | "minimap" | "engine" | "telemetry", value: boolean | string) => {
    settings[key] = value as never;
    localStorage.setItem(SET_KEY, JSON.stringify(settings));
    if (key === "cvd") renderer.cvd = !!value;
    else if (key === "minimap") mini.hidden = !value;
    else if (key === "engine") {
      localStorage.setItem("granulab-engine", String(value));
      ui.toast("Engine switched — reload to run on it");
    }
  },
  onKeyPaintToggle: () => keyPaintSet(!keyPaint),
  onHighlight: (id: number) => { renderer.highlight = id; },
  onTuneOpen: () => pushTunablesToUi(),
  onTune: (key: string, value: number) => {
    const id = ui.state.toolL;
    const el = ELEMENTS[id];
    const t = TUNABLES.find((x) => x.key === key);
    if (!el || !t) return;
    t.arr[id] = value;
    (tuning[el.name] ??= {})[key] = value;
    localStorage.setItem(TUNE_KEY, JSON.stringify(tuning));
    refreshEngineTables();
  },
  onTuneReset: (all: boolean) => {
    const el = ELEMENTS[ui.state.toolL];
    for (const name of all ? Object.keys(tuning) : el ? [el.name] : []) {
      const id = idOfName(name);
      if (id >= 0) for (const t of TUNABLES) t.arr[id] = TUNE_DEFAULTS.get(t.key)![id];
      delete tuning[name];
    }
    localStorage.setItem(TUNE_KEY, JSON.stringify(tuning));
    refreshEngineTables();
    pushTunablesToUi();
    ui.toast(all ? "All elements back to their shipped values" : `${el?.name ?? "Element"} reset`);
  },
  onSaveElement: (index: number, spec: CustomSpec) => {
    if (index < 0) { createCustomElement(spec); return; }
    const next = customSpecs.slice();
    next[index] = spec;
    rebuildCustoms(next, null);
  },
  onDeleteElement: (index: number) => {
    const next = customSpecs.slice();
    next.splice(index, 1);
    rebuildCustoms(next, customIds[index] ?? null);
  },
  onGalleryOpen: () => { void refreshGallery(); },
  onGalleryUpload: (name: string, author: string) => { void uploadToGallery(name, author); },
  onGalleryLoad: (scene) => { pushUndo(); armUndo(); void loadFromGallery(scene.url); },
  onGalleryDelete: (stamp: string) => { void deleteFromGallery(stamp); },
  onDemo: (name: string) => {
    pushUndo();
    armUndo();
    world.clear();
    player.remove();
    objects.clear();
    fighters.length = 0;
    if (name === "sandbox") demoScene();
    else if (name === "chem") chemScene();
    else if (name === "range") rangeScene();
    else if (name === "doom") doomScene();
    else if (name === "alchemy") alchemyScene();
    else if (name === "cryo") cryoScene();
    else if (name === "boiler") boilerScene();
    else if (name === "cannon") cannonScene();
  },
});

// ---- scene gallery (backend: /api/gallery — Vercel Blob in prod, a
// filesystem twin under the Vite dev server; same routes and shapes) --------
const AUTHOR_KEY = "granulab-author";
const thumbCache = new Map<string, string>();

async function refreshGallery(): Promise<void> {
  try {
    const r = await fetch("/api/gallery");
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    // the list needs thumbnails, which live in each scene blob, so fetch the
    // ones we do not have yet and let the rest fill in as they arrive
    const scenes = (j.scenes ?? []) as GalleryScene[];
    for (const sc of scenes) sc.owned = !!owned[sc.stamp];
    ui.setGalleryScenes(scenes, Number(j.total ?? scenes.length));
    const total = Number(j.total ?? scenes.length);
    void Promise.all(scenes.slice(0, 24).map(async (sc) => {
      if (thumbCache.has(sc.stamp)) { sc.thumb = thumbCache.get(sc.stamp); return; }
      try {
        const d = await (await fetch(sc.url)).json();
        if (d.thumb) { thumbCache.set(sc.stamp, d.thumb); sc.thumb = d.thumb; }
      } catch { /* a missing thumbnail is not worth failing the list over */ }
    })).then(() => ui.setGalleryScenes(scenes, total));
  } catch {
    ui.setGalleryScenes(null);
  }
}

/** tokens for scenes THIS browser uploaded — what lets it delete them later */
const OWNED_KEY = "granulab-owned";
const owned: Record<string, string> = readJson(OWNED_KEY, {});

/** a small picture of the scene, drawn from the same sampler as the minimap */
function sceneThumb(): string {
  drawMinimap();
  return mini.toDataURL("image/webp", 0.7);
}

async function uploadToGallery(name: string, author: string): Promise<boolean> {
  localStorage.setItem(AUTHOR_KEY, author);
  ui.setGalleryStatus("uploading…");
  try {
    const code = await sceneCode();
    const r = await fetch("/api/gallery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, author, code, thumb: sceneThumb() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    if (j.stamp && j.token) {
      owned[j.stamp] = j.token;
      localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
    }
    ui.setGalleryStatus("uploaded ✓ — it's live in the list");
    void refreshGallery();
    return true;
  } catch (err) {
    ui.setGalleryStatus(`upload failed: ${(err as Error).message}`, true);
    return false;
  }
}

async function deleteFromGallery(stamp: string): Promise<boolean> {
  const token = owned[stamp];
  if (!token) return false;
  ui.setGalleryStatus("deleting…");
  try {
    const r = await fetch("/api/gallery", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stamp, token }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    delete owned[stamp];
    localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
    ui.setGalleryStatus("deleted");
    void refreshGallery();
    return true;
  } catch (err) {
    ui.setGalleryStatus(`delete failed: ${(err as Error).message}`, true);
    return false;
  }
}

async function loadFromGallery(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (!(await loadSceneCode(String(j.code ?? "")))) throw new Error("bad code");
    return true;
  } catch {
    ui.toast("Could not load that scene.", "err");
    return false;
  }
}

// ---- rebuilding the invented-element list --------------------------------
// registerElement only ever appends, and unpicking a registry entry by hand
// means clearing two dozen flat arrays plus a row and a column of the reaction
// table — easy to get subtly wrong, and wrong here means a corrupted element.
// A fresh boot builds the list correctly by construction, so edits and deletes
// rewrite localStorage and reload, carrying the scene across in a raw v1
// snapshot (no custom block: ids must land on the freshly-registered list, not
// re-adopt the very spec that was just changed or removed).
const PENDING_KEY = "granulab-pending";

function saveRaw(): Uint8Array {
  const w = world.serialize();
  const o = objects.serialize();
  const buf = new Uint8Array(4 + w.length + o.length);
  buf.set(u32(w.length), 0);
  buf.set(w, 4);
  buf.set(o, 4 + w.length);
  return buf;
}

function rebuildCustoms(next: CustomSpec[], eraseId: number | null): void {
  // Removing one entry slides every later invention down an id, so the parked
  // grid has to be rewritten to the ids the next boot will hand out — erasing
  // the deleted element alone left the ones after it pointing at nothing.
  const remap = new Map<number, number>();
  for (let j = 0; j < next.length; j++) {
    const old = customSpecs.indexOf(next[j]);
    const oldId = old >= 0 ? customIds[old] : -1;
    const newId = FIRST_CUSTOM_ID + j;
    if (oldId >= 0 && oldId !== newId) remap.set(oldId, newId);
  }
  const sp = world.species;
  for (let i = 0; i < sp.length; i++) {
    const id = sp[i];
    if (id === eraseId) sp[i] = E.EMPTY;
    else {
      const to = remap.get(id);
      if (to !== undefined) sp[i] = to;
    }
  }
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  try {
    localStorage.setItem(PENDING_KEY, toB64(saveRaw()));
  } catch {
    /* a scene too big to park is not worth blocking the edit over */
  }
  location.reload();
}

/** register + persist, with none of the "you just made this" ceremony — the
 *  path a shared scene takes when it brings its own chemistry along */
function registerAndPersist(spec: CustomSpec): number | null {
  const id = registerElement(spec);
  if (id === null) return null;
  customSpecs.push(spec);
  customIds.push(id);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customSpecs));
  } catch {
    ui.toast("Out of local storage — this element will not survive a reload.", "err");
  }
  renderer.refreshPalette();
  ui.addElementButton(id);
  ui.setCustomElements(customSpecs);
  return id;
}

function createCustomElement(spec: CustomSpec): number | null {
  const id = registerAndPersist(spec);
  if (id === null) {
    ui.toast("No custom element slots left — delete one first.", "err");
    return null;
  }
  ui.bind("L", id);
  ui.toast(`Created ${spec.name}`);
  return id;
}

const canvas = document.getElementById("dish") as HTMLCanvasElement;
renderer = new Renderer(canvas, GRID_W, GRID_H);
ui.setGalleryAuthor(localStorage.getItem(AUTHOR_KEY) ?? "");
pushSlotsToUi(readSlots());
ui.setCustomElements(customSpecs);
ui.setSettings({ ...settings, engine: engineActive });
renderer.cvd = settings.cvd;
// a rebuild parked the scene one reload ago; put it back and drop the key
const pending = localStorage.getItem(PENDING_KEY);
if (pending) {
  localStorage.removeItem(PENDING_KEY);
  try { loadAll(fromB64(pending)); } catch { /* a bad park is not worth a boot failure */ }
}
// a first-time visitor meets a blank grid and 106 elements; say the three
// things that get them painting, once, and never again
if (!localStorage.getItem("granulab-intro") && location.hash === "") ui.showIntro();
for (const id of customIds) ui.addElementButton(id); // persisted customs
const bgHash = location.hash.match(/bg=(\d)/); // shot harness can pick a BG mode
if (bgHash) renderer.mode = parseInt(bgHash[1]);

// ---- minimap: 1/8-scale overview in the corner ---------------------------
const MINI_W = GRID_W / 8;
const MINI_H = GRID_H / 8;
const mini = document.createElement("canvas");
mini.id = "minimap";
mini.width = MINI_W;
mini.height = MINI_H;
canvas.parentElement!.appendChild(mini);
const miniCtx = mini.getContext("2d")!;
const miniImg = miniCtx.createImageData(MINI_W, MINI_H);
let miniTimer = 0;

function drawMinimap(): void {
  const d = miniImg.data;
  const sp = world.species;
  for (let my = 0; my < MINI_H; my++) {
    const rowBase = my * 8 * GRID_W;
    for (let mx = 0; mx < MINI_W; mx++) {
      // sample the 8x8 block: first non-empty of 4 spread probes
      let id = sp[rowBase + mx * 8];
      if (id === 0) id = sp[rowBase + 4 * GRID_W + mx * 8 + 4];
      if (id === 0) id = sp[rowBase + 2 * GRID_W + mx * 8 + 6];
      if (id === 0) id = sp[rowBase + 6 * GRID_W + mx * 8 + 2];
      const o = (my * MINI_W + mx) * 4;
      if (id === 0) {
        d[o] = 11; d[o + 1] = 13; d[o + 2] = 16;
      } else {
        d[o] = PALETTE[id * 3] * 255;
        d[o + 1] = PALETTE[id * 3 + 1] * 255;
        d[o + 2] = PALETTE[id * 3 + 2] * 255;
      }
      d[o + 3] = 255;
    }
  }
  miniCtx.putImageData(miniImg, 0, 0);
  // where you are looking, so the minimap is a map and not just a thumbnail
  const x0 = -renderer.pan.x / renderer.zoom / 8;
  const y0 = -renderer.pan.y / renderer.zoom / 8;
  const w = canvas.width / renderer.zoom / 8;
  const h = canvas.height / renderer.zoom / 8;
  if (w < MINI_W - 0.5 || h < MINI_H - 0.5) {
    miniCtx.strokeStyle = "rgba(0,0,0,0.7)";
    miniCtx.lineWidth = 2;
    miniCtx.strokeRect(x0, y0, w, h);
    miniCtx.strokeStyle = "#e7e9ee";
    miniCtx.lineWidth = 1;
    miniCtx.strokeRect(x0, y0, w, h);
  }
}

// the minimap was inert; once you are zoomed in it is the fastest way across
// the grid, so clicking or dragging it centres the view on that spot
function miniLookAt(e: PointerEvent): void {
  const r = mini.getBoundingClientRect();
  const cx = ((e.clientX - r.left) / r.width) * GRID_W;
  const cy = ((e.clientY - r.top) / r.height) * GRID_H;
  renderer.pan.x = canvas.width / 2 - cx * renderer.zoom;
  renderer.pan.y = canvas.height / 2 - cy * renderer.zoom;
  drawMinimap();
}
mini.addEventListener("pointerdown", (e) => {
  mini.setPointerCapture(e.pointerId);
  miniLookAt(e);
  e.preventDefault();
  e.stopPropagation();
});
mini.addEventListener("pointermove", (e) => {
  if (e.buttons & 1) miniLookAt(e);
});
mini.addEventListener("contextmenu", (e) => e.preventDefault());
mini.hidden = !settings.minimap;

// ---- brush preview -------------------------------------------------------
// The pen carries five nib shapes and a size from 1 to 48, and a crosshair
// showed none of it — you found out what a dab covered by committing it. This
// 2D layer traces the exact footprint of the next dab on top of the glass.
const nibCanvas = document.createElement("canvas");
nibCanvas.id = "nibcanvas";
canvas.parentElement!.appendChild(nibCanvas);
const nibCtx = nibCanvas.getContext("2d")!;
let nibDirty: { x: number; y: number; w: number; h: number } | null = null;
let hoverCell: { x: number; y: number } | null = null;

// ---- canvas sizing -------------------------------------------------------
let viewDpr = 1; // device px per CSS px, so overlay strokes keep their weight
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  viewDpr = dpr;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    nibCanvas.width = w;
    nibCanvas.height = h;
    nibDirty = null;
    renderer.fit();
    ui.setZoom(renderer.zoom);
  }
}
new ResizeObserver(resize).observe(canvas);
resize();

// ---- painting ------------------------------------------------------------
let strokeAngle = 0; // byte angle of the current pen stroke — fans blow this way

// Brush shapes. A round nib is wrong for most of what people build here:
// walls and tanks want a square, funnels and slopes want a diamond, and
// scattering powder wants a spray rather than a solid disc.
function stamp(cx: number, cy: number, r: number, id: number): void {
  const aux = id === E.FAN || id === E.CANNON ? strokeAngle : undefined;
  const shape = ui.state.penShape;
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      let inside: boolean;
      switch (shape) {
        case "square": inside = true; break;
        case "diamond": inside = Math.abs(dx) + Math.abs(dy) <= r; break;
        case "spray": inside = dx * dx + dy * dy <= r2 && world.rng.byte() < 70; break;
        case "ring": {
          const d2 = dx * dx + dy * dy;
          const inner = r > 2 ? (r - 2) * (r - 2) : 0;
          inside = d2 <= r2 && d2 >= inner;
          break;
        }
        default: inside = dx * dx + dy * dy <= r2;
      }
      if (inside) world.paint(cx + dx, cy + dy, id, aux);
    }
  }
}

// ---- stirring -------------------------------------------------------------
// Two liquids poured into a beaker stratify by density and only ever react
// across the thin interface between them; gases separated by a single row of
// air never touch at all. Real chemistry has a glass rod for exactly this, and
// the sim had no way to agitate anything.
//
// A stir is a PERMUTATION of the movable matter under the brush: pick a cell,
// pick a neighbour a couple of cells away, and if both are things that can flow
// (or empty space), exchange them. Nothing is created or destroyed — the dot
// count is identical before and after — and the container itself is untouched,
// because walls, glass, metal and every device are B.NONE and never qualify.
const MIXABLE = new Uint8Array(N_IDS);
for (let id = 0; id < N_IDS; id++) {
  const b = BEHAVIOR[id];
  // fire and sparks carry timers and conductor bits in `life`, which a raw
  // write would clear — leave the energetic species out of it
  MIXABLE[id] = b === B.POWDER || b === B.LIQUID || b === B.GAS ? 1 : 0;
}
MIXABLE[E.EMPTY] = 1; // swapping with a bubble of air is what makes it churn

function stir(cx: number, cy: number, r: number): void {
  const r2 = r * r;
  const area = Math.max(1, Math.round(Math.PI * r2));
  const swaps = Math.max(2, Math.round(area * 0.4));
  const sp = world.species;
  const sh = world.shade;
  for (let n = 0; n < swaps; n++) {
    // a cell somewhere in the disc, and a partner a short hop away: local
    // exchanges read as stirring, whereas long-range ones read as teleporting
    const ax = cx + world.rng.int(r * 2 + 1) - r;
    const ay = cy + world.rng.int(r * 2 + 1) - r;
    const dx = ax - cx;
    const dy = ay - cy;
    if (dx * dx + dy * dy > r2) continue;
    const bx = ax + world.rng.int(5) - 2;
    const by = ay + world.rng.int(5) - 2;
    if (ax < 0 || ay < 0 || ax >= GRID_W || ay >= GRID_H) continue;
    if (bx < 0 || by < 0 || bx >= GRID_W || by >= GRID_H) continue;
    const ia = ay * GRID_W + ax;
    const ib = by * GRID_W + bx;
    if (ia === ib) continue;
    const a = sp[ia];
    const b = sp[ib];
    if (a === b) continue;
    if (!MIXABLE[a] || !MIXABLE[b]) continue;
    const as = sh[ia];
    const bs = sh[ib];
    world.rawSet(ax, ay, b, bs);
    world.rawSet(bx, by, a, as);
  }
}

function stirLine(x0: number, y0: number, x1: number, y1: number, r: number): void {
  const dist = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 2)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stir(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), r);
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

// ---- touch: one finger paints, two fingers move the view ------------------
// Painting already works through pointer events, but a touch screen has no
// wheel and no middle button, so without this you can paint and never navigate.
const touches = new Map<number, { x: number; y: number }>();
let pinch: { dist: number; cx: number; cy: number } | null = null;

function pinchState(): { dist: number; cx: number; cy: number } | null {
  if (touches.size < 2) return null;
  const [a, b] = [...touches.values()];
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  };
}

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") {
    const px0 = toCanvasPx(e);
    touches.set(e.pointerId, px0);
    if (touches.size === 2) {
      // the second finger converts the stroke in progress into a gesture
      painting = -1;
      lastCell = null;
      armUndo();
      pinch = pinchState();
      return;
    }
  }
  canvas.setPointerCapture(e.pointerId);
  const px = toCanvasPx(e);
  // Middle-drag is the only pan a three-button mouse needs; a trackpad has no
  // middle button at all, so held Space drags the view the way every other
  // canvas tool does.
  if (e.button === 1 || spaceHeld) {
    panning = true;
    spaceDragged = true;
    panStart = { x: renderer.pan.x, y: renderer.pan.y, px: px.x, py: px.y };
    e.preventDefault();
    return;
  }
  const c = renderer.toCell(px.x, px.y);
  hoverCell = c;
  // eyedropper: take what is already there instead of hunting the rails for it
  if (e.altKey) {
    e.preventDefault();
    if (c.x >= 0 && c.y >= 0 && c.x < GRID_W && c.y < GRID_H) {
      const id = world.species[c.y * GRID_W + c.x];
      ui.bind(e.button === 2 ? "R" : "L", id);
      ui.toast(`Picked up ${id === E.EMPTY ? "Erase" : ELEMENTS[id].name}`);
    }
    return;
  }
  const tool = e.button === 2 ? ui.state.toolR : ui.state.toolL;
  if (tool === TOOL_PLAYER) {
    pushUndo();
    armUndo();
    player.place(c.x, c.y);
    return;
  }
  if (tool === TOOL_FIGHTER) {
    if (fighters.length < 8) {
      const f = new Fighter();
      f.place(c.x, c.y);
      fighters.push(f);
    } else {
      ui.toast("Eight fighters is the limit.", "err");
    }
    return;
  }
  if (tool === E.BALL || tool === E.BOX || tool === E.WHEEL || tool === E.BUBBLE) {
    pushUndo();
    armUndo();
    const had = objects.list.length;
    objects.spawnId(tool, c.x, c.y);
    if (objects.list.length === had) ui.toast("That is all the objects the scene will hold (64).", "err");
    return;
  }
  painting = tool;
  pushUndo();
  if (tool === TOOL_STIR) {
    stir(c.x, c.y, ui.state.pen);
    lastCell = c;
    return;
  }
  if (tool === E.EMPTY) objects.removeAt(c.x, c.y);
  if (ui.state.penMode === "free") {
    stamp(c.x, c.y, ui.state.pen, painting);
  }
  lastCell = c;
});
canvas.addEventListener("pointermove", (e) => {
  const px = toCanvasPx(e);
  if (e.pointerType === "touch" && touches.has(e.pointerId)) {
    touches.set(e.pointerId, px);
    if (pinch) {
      const now = pinchState();
      if (now) {
        renderer.zoomAt(now.cx, now.cy, now.dist / Math.max(1, pinch.dist));
        renderer.pan.x += now.cx - pinch.cx;
        renderer.pan.y += now.cy - pinch.cy;
        ui.setZoom(renderer.zoom);
        pinch = now;
      }
      return;
    }
  }
  const c = renderer.toCell(px.x, px.y);
  probe(c);
  if (panning) {
    renderer.pan.x = panStart.x + (px.x - panStart.px);
    renderer.pan.y = panStart.y + (px.y - panStart.py);
    return;
  }
  if (panning) return;
  if (painting === TOOL_STIR && lastCell) {
    stirLine(lastCell.x, lastCell.y, c.x, c.y, ui.state.pen);
    lastCell = c;
    hoverCell = c;
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
  hoverCell = c;
});
canvas.addEventListener("pointerleave", () => {
  // a stroke keeps its anchor: pointer capture goes on delivering moves off the
  // canvas, and the release still has to commit a line/rect from somewhere
  if (painting < 0 && !panning) { hoverCell = null; probe(null); }
});
canvas.addEventListener("pointerup", (e) => {
  if (e.pointerType === "touch") {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (touches.size >= 1) { painting = -1; lastCell = null; return; } // still gesturing
  }
  // line/rect pens stamp on release, from the press cell to the release cell
  if (painting >= 0 && lastCell && hoverCell && ui.state.penMode !== "free") {
    const a = lastCell;
    const b = hoverCell;
    const ddx = b.x - a.x;
    const ddy = b.y - a.y;
    if (ddx * ddx + ddy * ddy >= 4) {
      strokeAngle = (Math.round((Math.atan2(ddy, ddx) / (Math.PI * 2)) * 256) + 256) & 255;
    }
    if (ui.state.penMode === "line") {
      stampLine(a.x, a.y, b.x, b.y, ui.state.pen, painting);
    } else {
      const id = painting;
      const aux = id === E.FAN || id === E.CANNON ? strokeAngle : undefined;
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
  armUndo();
});
canvas.addEventListener("pointercancel", (e) => {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
  painting = -1;
  lastCell = null;
  panning = false;
});

// ---- cell probe ----------------------------------------------------------
// Temperature, breathable air, overpressure and pH are computed for every cell
// and could only ever be seen as full-screen shaders. Read them out for the one
// cell the pointer is on. Temperature comes from the renderer's byte field so
// the readout needs no engine surface of its own.
const legendCounts = new Uint32Array(N_IDS);
let tempFilledAt = 0;
function probe(c: { x: number; y: number } | null): void {
  if (!c || c.x < 0 || c.y < 0 || c.x >= GRID_W || c.y >= GRID_H) { ui.setProbe(null); return; }
  // modes 0/1/5 refill the field every frame anyway; the rest would otherwise
  // pay a full-field pass per pointermove, so cap those at ~12 Hz
  if (!renderer.tempCurrent && performance.now() - tempFilledAt > 80) {
    tempFilledAt = performance.now();
    renderer.refreshTemp((buf) => world.fillTempTex(buf));
  }
  ui.setProbe({
    x: c.x, y: c.y,
    id: world.species[c.y * GRID_W + c.x],
    temp: renderer.tempAt(c.x, c.y),
    air: world.airAt(c.x, c.y),
    press: world.pressAt(c.x, c.y),
  });
}

// ---- brush preview drawing -----------------------------------------------
// Rigid objects stamp a fixed footprint (mirrors KIND_R in engine/objects.ts).
// Seeing it before you drop it is what stops a ball being placed in a bore too
// narrow to ever let it move.
const OBJ_R: Record<number, number> = { [E.BALL]: 7, [E.BOX]: 8, [E.WHEEL]: 9, [E.BUBBLE]: 4 };

function nibInk(tool: number): string {
  if (tool === TOOL_STIR) return "#9ec8d0";
  if (tool === TOOL_PLAYER) return "#ffe94a";
  if (tool === TOOL_FIGHTER) return "#c05ac0";
  if (tool === E.EMPTY) return "#e7e9ee"; // erase has no colour of its own
  return ELEMENTS[tool]?.color ?? "#e7e9ee";
}

/** trace one dab's silhouette — the same predicate stamp() fills with */
function traceNib(cx: number, cy: number, r: number, z: number, shape: string): void {
  const R = (r + 0.5) * z; // the dab spans cells -r..+r inclusive
  switch (shape) {
    case "square":
      nibCtx.rect(cx - R, cy - R, R * 2, R * 2);
      break;
    case "diamond":
      nibCtx.moveTo(cx, cy - R);
      nibCtx.lineTo(cx + R, cy);
      nibCtx.lineTo(cx, cy + R);
      nibCtx.lineTo(cx - R, cy);
      nibCtx.closePath();
      break;
    case "ring": {
      nibCtx.arc(cx, cy, R, 0, Math.PI * 2);
      const inner = (r - 2.5) * z;
      if (inner > 1) { nibCtx.moveTo(cx + inner, cy); nibCtx.arc(cx, cy, inner, 0, Math.PI * 2); }
      break;
    }
    default:
      nibCtx.arc(cx, cy, R, 0, Math.PI * 2);
  }
}

function drawBrushPreview(): void {
  if (nibDirty) {
    nibCtx.clearRect(nibDirty.x, nibDirty.y, nibDirty.w, nibDirty.h);
    nibDirty = null;
  }
  if (!hoverCell || panning) return;
  const { x: hx, y: hy } = hoverCell;
  if (hx < -64 || hy < -64 || hx > GRID_W + 64 || hy > GRID_H + 64) return;
  const tool = painting >= 0 ? painting : ui.state.toolL;
  const z = renderer.zoom;
  const s = viewDpr;
  const px = (cx: number): number => renderer.pan.x + (cx + 0.5) * z;
  const py = (cy: number): number => renderer.pan.y + (cy + 0.5) * z;
  const x = px(hx);
  const y = py(hy);
  const ink = nibInk(tool);
  const objR = OBJ_R[tool];
  // a stir has no nib shape: it agitates the whole disc
  const shape = objR !== undefined || tool === TOOL_STIR ? "round" : ui.state.penShape;
  const r = objR ?? (tool === TOOL_PLAYER || tool === TOOL_FIGHTER ? 2 : ui.state.pen);
  const mode = objR !== undefined || tool === TOOL_PLAYER || tool === TOOL_FIGHTER || tool === TOOL_STIR
    ? "free" : ui.state.penMode;
  const dragging = painting >= 0 && lastCell !== null && mode !== "free";

  let x0 = x, y0 = y, x1 = x, y1 = y;
  nibCtx.save();
  nibCtx.lineJoin = "round";
  nibCtx.beginPath();
  if (dragging && mode === "rect") {
    // rect fills cell-by-cell at 1-cell resolution — the pen size does not
    // apply, so the preview is the exact span between the two corners
    const ax = px(Math.min(lastCell!.x, hx)) - z / 2;
    const ay = py(Math.min(lastCell!.y, hy)) - z / 2;
    const bx = px(Math.max(lastCell!.x, hx)) + z / 2;
    const by = py(Math.max(lastCell!.y, hy)) + z / 2;
    nibCtx.rect(ax, ay, bx - ax, by - ay);
    x0 = ax; y0 = ay; x1 = bx; y1 = by;
  } else {
    traceNib(x, y, r, z, shape);
    const R = (r + 0.5) * z;
    x0 = x - R; y0 = y - R; x1 = x + R; y1 = y + R;
    if (dragging) {
      traceNib(px(lastCell!.x), py(lastCell!.y), r, z, shape);
      x0 = Math.min(x0, px(lastCell!.x) - R); y0 = Math.min(y0, py(lastCell!.y) - R);
      x1 = Math.max(x1, px(lastCell!.x) + R); y1 = Math.max(y1, py(lastCell!.y) + R);
    }
  }
  nibCtx.globalAlpha = 0.12;
  nibCtx.fillStyle = ink;
  nibCtx.fill("evenodd");
  nibCtx.globalAlpha = 1;
  nibCtx.setLineDash(shape === "spray" ? [5 * s, 5 * s] : []);
  nibCtx.strokeStyle = "rgba(0,0,0,0.72)"; // legible over ice, glass and flash
  nibCtx.lineWidth = 3.4 * s;
  nibCtx.stroke();
  nibCtx.strokeStyle = ink;
  nibCtx.lineWidth = 1.4 * s;
  nibCtx.stroke();
  nibCtx.setLineDash([]);
  if (dragging && mode === "line") {
    nibCtx.beginPath();
    nibCtx.moveTo(px(lastCell!.x), py(lastCell!.y));
    nibCtx.lineTo(x, y);
    nibCtx.strokeStyle = "rgba(0,0,0,0.72)";
    nibCtx.lineWidth = 3 * s;
    nibCtx.stroke();
    nibCtx.strokeStyle = ink;
    nibCtx.lineWidth = 1 * s;
    nibCtx.stroke();
  }
  // a big nib loses its centre; a small one is its own centre mark
  if ((r + 0.5) * z > 7 * s && !dragging) {
    const arm = 3.5 * s;
    nibCtx.beginPath();
    nibCtx.moveTo(x - arm, y); nibCtx.lineTo(x + arm, y);
    nibCtx.moveTo(x, y - arm); nibCtx.lineTo(x, y + arm);
    nibCtx.strokeStyle = ink;
    nibCtx.lineWidth = 1 * s;
    nibCtx.stroke();
  }
  nibCtx.restore();
  const pad = 4 * s;
  const cx0 = Math.max(0, Math.floor(x0 - pad));
  const cy0 = Math.max(0, Math.floor(y0 - pad));
  const cx1 = Math.min(nibCanvas.width, Math.ceil(x1 + pad));
  const cy1 = Math.min(nibCanvas.height, Math.ceil(y1 + pad));
  if (cx1 > cx0 && cy1 > cy0) nibDirty = { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const px = toCanvasPx(e);
  // a trackpad pinch arrives as ctrl+wheel, and it needs a finer step than a
  // mouse notch or the zoom lurches
  renderer.zoomAt(px.x, px.y, Math.pow(e.ctrlKey ? 1.008 : 1.0015, -e.deltaY));
  ui.setZoom(renderer.zoom);
}, { passive: false });

/** zoom about the middle of the view, for the keyboard and the zoom buttons */
function zoomStep(factor: number): void {
  renderer.zoomAt(canvas.width / 2, canvas.height / 2, factor);
  ui.setZoom(renderer.zoom);
}
function panBy(dx: number, dy: number): void {
  renderer.pan.x += dx;
  renderer.pan.y += dy;
}

// ---- keyboard painting ----------------------------------------------------
// Everything else on the page could be driven from the keyboard; the canvas —
// the whole point of the app — could not be touched without a pointer. K puts a
// cursor on the grid that the brush preview and the cell probe both follow, so
// the same nib, size and shape apply. Arrows move it, Enter dabs, Escape leaves.
let keyPaint = false;
let keyCursor = { x: GRID_W >> 1, y: GRID_H >> 1 };

function keyPaintSet(on: boolean): void {
  keyPaint = on;
  ui.setKeyPaint(on);
  if (on) {
    keyCursor = hoverCell
      ? { x: Math.max(0, Math.min(GRID_W - 1, hoverCell.x)), y: Math.max(0, Math.min(GRID_H - 1, hoverCell.y)) }
      : keyCursor;
    hoverCell = { ...keyCursor };
    probe(hoverCell);
    canvas.focus();
    ui.toast("Keyboard painting on — arrows move, Enter paints, Esc leaves");
  } else {
    ui.toast("Keyboard painting off");
  }
}

/** move the keyboard cursor; Shift is a fine step, plain is a coarse one */
function keyCursorMove(dx: number, dy: number, fine: boolean): void {
  const step = fine ? 1 : Math.max(2, ui.state.pen);
  keyCursor.x = Math.max(0, Math.min(GRID_W - 1, keyCursor.x + dx * step));
  keyCursor.y = Math.max(0, Math.min(GRID_H - 1, keyCursor.y + dy * step));
  hoverCell = { ...keyCursor };
  probe(hoverCell);
}

function keyPaintDab(side: "L" | "R"): void {
  const tool = side === "L" ? ui.state.toolL : ui.state.toolR;
  if (tool === TOOL_PLAYER) { pushUndo(); armUndo(); player.place(keyCursor.x, keyCursor.y); return; }
  if (tool === TOOL_FIGHTER) {
    if (fighters.length < 8) { const f = new Fighter(); f.place(keyCursor.x, keyCursor.y); fighters.push(f); }
    else ui.toast("Eight fighters is the limit.", "err");
    return;
  }
  pushUndo();
  if (tool === TOOL_STIR) { stir(keyCursor.x, keyCursor.y, ui.state.pen); armUndo(); return; }
  if (tool === E.BALL || tool === E.BOX || tool === E.WHEEL || tool === E.BUBBLE) {
    const had = objects.list.length;
    objects.spawnId(tool, keyCursor.x, keyCursor.y);
    if (objects.list.length === had) ui.toast("That is all the objects the scene will hold (64).", "err");
  } else {
    if (tool === E.EMPTY) objects.removeAt(keyCursor.x, keyCursor.y);
    stamp(keyCursor.x, keyCursor.y, ui.state.pen, tool);
  }
  armUndo();
}

// ---- keyboard ------------------------------------------------------------
// Space does double duty: held it is the pan modifier, tapped it is play/pause.
// Which one it was is only knowable on release, so the toggle waits for keyup
// and only fires if the key was never used to drag.
let spaceHeld = false;
let spaceDragged = false;
const PAN_STEP = 90;

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement) return;
  const arrow = e.code === "ArrowLeft" || e.code === "ArrowRight" || e.code === "ArrowUp" || e.code === "ArrowDown";
  // keyboard painting owns the arrows while it is on, so the stickman and the
  // view keep theirs the rest of the time
  if (keyPaint) {
    if (arrow) {
      e.preventDefault();
      keyCursorMove(e.code === "ArrowRight" ? 1 : e.code === "ArrowLeft" ? -1 : 0,
        e.code === "ArrowDown" ? 1 : e.code === "ArrowUp" ? -1 : 0, e.shiftKey);
      return;
    }
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      keyPaintDab(e.shiftKey ? "R" : "L");
      return;
    }
    if (e.code === "Escape") { e.preventDefault(); keyPaintSet(false); return; }
  }
  if (e.key === "k" || e.key === "K") { e.preventDefault(); keyPaintSet(!keyPaint); return; }
  if (arrow && e.shiftKey) {
    // shift+arrows drive the view; bare arrows still drive the stickman
    e.preventDefault();
    panBy(e.code === "ArrowLeft" ? PAN_STEP : e.code === "ArrowRight" ? -PAN_STEP : 0,
      e.code === "ArrowUp" ? PAN_STEP : e.code === "ArrowDown" ? -PAN_STEP : 0);
    return;
  }
  if (e.code === "ArrowLeft") { keys.left = true; e.preventDefault(); }
  else if (e.code === "ArrowRight") { keys.right = true; e.preventDefault(); }
  else if (e.code === "ArrowUp") { keys.up = true; e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") { e.preventDefault(); redo(); }
  else if (e.key === "?" || e.code === "F1") { e.preventDefault(); ui.openHelp(); }
  else if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) spaceDragged = false;
    spaceHeld = true;
    canvas.style.cursor = "grab";
  }
  else if (e.code === "Enter") { ui.setPaused(true); stepOnce(); }
  else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomStep(1.25); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomStep(1 / 1.25); }
  else if (e.key === "f" || e.key === "F") { renderer.fit(); ui.setZoom(renderer.zoom); }
  else if (e.key === "t" || e.key === "T") { e.preventDefault(); ui.openTune(); }
  else if (e.key === "[") ui.setPen(ui.state.pen - 1);
  else if (e.key === "]") ui.setPen(ui.state.pen + 1);
  else if (e.key >= "1" && e.key <= "9") ui.setPen([1, 2, 4, 6, 8, 12, 16, 24, 32][parseInt(e.key) - 1]);
  else if (e.key === "0") ui.setPen(48);
  else if (e.key === "/") { e.preventDefault(); ui.focusFilter(); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "ArrowLeft") keys.left = false;
  else if (e.code === "ArrowRight") keys.right = false;
  else if (e.code === "ArrowUp") keys.up = false;
  else if (e.code === "Space") {
    spaceHeld = false;
    canvas.style.cursor = "";
    if (!spaceDragged) ui.setPaused(!ui.state.paused);
    spaceDragged = false;
  }
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
    // wall-clock budget: on pathological scenes shed sim steps, not frames —
    // the first step always runs, so worst case is one step over budget
    const budget = performance.now() + 14;
    while (acc >= 1 && n < 8 && performance.now() < budget) { stepOnce(); acc--; n++; }
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
    (buf) => world.fillGlowTex(buf),
    now / 1000, world.fxPower, overlays,
  );
  drawBrushPreview();
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

  miniTimer += dt;
  if (miniTimer > 200) {
    miniTimer = 0;
    drawMinimap();
  }
  statTimer += dt;
  if (statTimer > 250) {
    ui.setStats(fpsEma, tickEma, world.dots, world.activeChunkCount());
    if (recorder) ui.setRecording(true, (performance.now() - recStart) / 1000);
    // the WASM engine tallies reactions in its own memory; pull them across
    // before the notebook diffs them (the TS engine writes REACT_COUNT direct)
    (world as unknown as { syncReactCounts?: () => void }).syncReactCounts?.();
    ui.refreshNotebook(statTimer);
    probe(hoverCell); // the fields keep moving even when the pointer does not
    ui.setEmpty(world.dots === 0 && objects.list.length === 0 && !player.alive);
    if (ui.legendVisible()) {
      legendCounts.fill(0);
      const sp = world.species;
      let total = 0;
      for (let i = 0; i < sp.length; i++) {
        const id = sp[i];
        if (id !== E.EMPTY) { legendCounts[id]++; total++; }
      }
      ui.setLegend(legendCounts, total);
    }
    statTimer = 0;
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
// #chem: the chemistry lab bench — every reaction loop running live, unattended
function chemScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 30, 690, 1250, 700); // the bench

  // 1) electrolysis cells: a clone pulser sparks a submerged wire — pulses are
  //    transient so the reaction beats the boil (sustained sparks just make steam)
  const cell = (x0: number, x1: number, liquid: string) => {
    R("Wall", x0, 600, x0 + 2, 690);
    R("Wall", x1 - 2, 600, x1, 690);
    R("Metal", x0 + 4, 618, x0 + 4, 686); // dry riser
    R("Metal", x0 + 4, 686, x1 - 5, 686); // submerged run
    R(liquid, x0 + 5, 648, x1 - 3, 685);
    world.paint(x0 + 6, 618, byName("Clone"));
    world.paint(x0 + 7, 618, byName("Spark")); // primer: clone memorizes spark
  };
  cell(40, 118, "Water"); // bubbles hydrogen
  cell(128, 206, "Seawater"); // pools chlorine

  // 2) gunpowder mill: saltpeter raining onto a charcoal shelf
  R("Wall", 230, 640, 350, 642);
  R("Charcoal", 240, 628, 340, 638);
  R("Saltpeter", 262, 590, 318, 618);

  // 3) thermite forge: torch -> ember bed -> thermite -> magma melts the beam
  //    and quenches in the pool below (stone + steam)
  R("Wall", 380, 655, 382, 690);
  R("Wall", 538, 655, 540, 690);
  R("Water", 383, 668, 537, 688);
  R("Metal", 390, 640, 530, 646);
  R("Charcoal", 400, 630, 520, 638);
  R("Thermite", 435, 610, 485, 628);
  R("Torch", 392, 630, 398, 638);

  // 4) lime kiln: limestone sinks into the magma bath, calcines at depth, and
  //    the lighter lime floats back up as a white crust on the melt
  R("Wall", 560, 600, 562, 690);
  R("Wall", 678, 600, 680, 690);
  R("Magma", 563, 650, 677, 688);
  R("Limestone", 580, 612, 660, 645);

  // 5) fizz basin: clone-dripped acid on soda; CO2 overflows the low lip and
  //    smothers the torches downstream
  R("Wall", 700, 640, 702, 690);
  R("Wall", 826, 656, 828, 690);
  R("Soda", 703, 674, 825, 688);
  for (let x = 730, k = 0; x <= 800; x++, k++) {
    world.paint(x, 610, byName(k % 3 === 0 ? "Acid" : "Clone"));
  }
  R("Torch", 850, 682, 856, 688);
  R("Torch", 880, 682, 886, 688);

  // 6) greenhouse: vines photosynthesize the CO2 atmosphere into oxygen
  R("Glass", 900, 600, 902, 690);
  R("Glass", 1000, 600, 1002, 690);
  R("Glass", 900, 598, 1002, 600);
  R("Vine", 930, 640, 932, 688);
  R("Vine", 950, 650, 952, 688);
  R("Vine", 970, 636, 972, 688);
  R("CO2", 903, 656, 999, 688);

  // 7) soap geyser: a fan at the pool floor blows straight up — bubbles launch
  //    into open sky instead of smearing into a side wall
  R("Wall", 1020, 650, 1022, 690);
  R("Wall", 1128, 650, 1130, 690);
  for (let y = 678; y <= 686; y++) {
    for (let x = 1070; x <= 1076; x++) world.paint(x, y, byName("Fan"), 192); // angle 192 = up
  }
  R("Soapy", 1023, 664, 1127, 688); // fills around the fan

  if (location.hash.includes("shot=")) {
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 300 && performance.now() - t0 < 24) { simTick(); settled++; }
    if (settled < 300) requestAnimationFrame(settle);
  };
  settle();
}

// #range: the weapons range — M5b ballistics running as five live exhibits
function rangeScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 30, 690, 1250, 700); // the range floor

  // 1) SENTRY GUN: elevated hopper-fed cannon, clone-triggered, shelling the
  //    castle downrange — shots arc off the perch and rain onto the towers
  R("Wall", 66, 477, 134, 479); // perch
  R("Wall", 66, 434, 68, 477); // hopper left wall
  R("Wall", 84, 434, 86, 466); // hopper right wall (keeps sand off the barrel)
  R("Sand", 69, 438, 83, 476);
  for (let y = 468; y <= 476; y++) for (let x = 88; x <= 96; x++) world.paint(x, y, byName("Cannon"), 0); // aimed right
  world.paint(92, 467, byName("Clone"));
  world.paint(93, 467, byName("Spark")); // primer
  // the castle: stone towers, glass caps, a powder keep
  R("Stone", 280, 636, 292, 688);
  R("Glass", 280, 626, 292, 634);
  R("Powder", 298, 656, 338, 688);
  R("Stone", 344, 636, 356, 688);
  R("Glass", 344, 626, 356, 634);

  // 2) MORTAR: the fuse runs in a sheltered tunnel under the pit — torch
  //    contact lights it, it burns left beneath the wall to the charge.
  //    One big timed shot; relight with the fire pen.
  R("Wall", 520, 660, 524, 690);
  R("Wall", 576, 660, 580, 684); // right wall stops short: fuse tunnel below
  R("Fuse", 526, 687, 595, 687); // the whole run, floor-sheltered
  R("Bomb", 526, 676, 574, 688); // charge sits on the fuse
  R("Wall", 581, 685, 595, 685); // roof over the fuse alley — cap spill can't cut it
  R("Torch", 596, 684, 600, 688); // touches the fuse end -> contact ignition
  R("Stone", 516, 640, 584, 674); // the cap

  // 3) NITRO THUNDER: clones drip nitro onto a grate over a magma bath —
  //    500°+ at the anvil, every drop detonates and flings the gravel banks
  R("Wall", 680, 654, 682, 690);
  R("Wall", 798, 654, 800, 690);
  R("Magma", 684, 683, 796, 688);
  R("Wall", 684, 680, 796, 682); // grate: the detonation anvil
  R("Stone", 684, 664, 724, 678); // gravel banks
  R("Stone", 756, 664, 796, 678);
  // sealed priming cell: nitro locked against the clone face
  R("Wall", 746, 349, 747, 349);
  R("Wall", 747, 350, 747, 351);
  R("Wall", 746, 351, 746, 351);
  world.paint(746, 350, byName("Nitro"));
  world.paint(745, 350, byName("Clone"));
  world.paint(744, 350, byName("Clone"));

  // 4) THERMITE VAULT BREACH: torch embedded at bed level lights the embers;
  //    the melt burns through the lid and quenches in the tank (steam burst)
  R("Metal", 850, 640, 1000, 646); // lid
  R("Metal", 850, 646, 856, 690);
  R("Metal", 994, 646, 1000, 690);
  R("Water", 858, 660, 992, 688);
  R("Torch", 875, 630, 879, 638); // beside the bed, touching it
  R("Charcoal", 880, 630, 970, 638);
  R("Thermite", 900, 610, 950, 628);

  // 6) SODIUM DEPTH CHARGES: a clone dripper feeds alkali metal into a deep
  //    tank — each lump floats, boils off hydrogen, and the heat sets it off:
  //    recurring flash-bangs in the water column
  R("Wall", 1150, 560, 1152, 690);
  R("Wall", 1238, 560, 1240, 690);
  R("Water", 1153, 590, 1237, 688);
  R("Clone", 1190, 566, 1190, 570);
  R("Sodium", 1189, 566, 1189, 570); // primer face
  R("Wall", 1188, 564, 1191, 565);
  R("Wall", 1188, 566, 1188, 571);

  // 5) FIREWORKS BATTERY: a 1-wide column lit from the TOP so every rocket
  //    launches with a clear nose (blocks and tubes both self-destruct — a
  //    nose-blocked rocket detonates); the clone refills from the base
  R("Clone", 1100, 688, 1100, 689);
  R("Fireworks", 1100, 664, 1100, 687);
  R("Torch", 1101, 662, 1104, 666);

  player.place(220, 680);

  if (location.hash.includes("shot=")) {
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 60 && performance.now() - t0 < 24) { simTick(); settled++; }
    if (settled < 60) requestAnimationFrame(settle);
  };
  settle();
}

// #doom: the disaster reel — an erupting volcano, a doomed wooden town, a
// buried magazine on a long fuse, a nitro chain, and a fortress shelling
// through the smoke. Everything self-runs on physics and one torch.
function doomScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };

  // THE GROUND SLAB first, then CARVE the fuse trench through it (wall paint
  // overwrites everything — embedding means slab, carve, then fuse)
  R("Wall", 30, 690, 1250, 700);
  const carve = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, E.EMPTY);
  };
  carve(342, 694, 575, 694); // the long run under the town
  carve(575, 688, 575, 693); // riser into the magazine
  carve(342, 686, 342, 693); // riser to the torch at the volcano's foot
  carve(600, 694, 694, 694); // det-line #2: magazine pit -> under the vat
  carve(600, 690, 600, 693);
  carve(694, 690, 694, 693);
  R("Fuse", 342, 694, 575, 694);
  R("Fuse", 575, 688, 575, 693);
  R("Fuse", 342, 682, 342, 693);
  R("Fuse", 600, 694, 694, 694); // det-line #2 begins inside the pit
  R("Fuse", 600, 689, 600, 693);
  R("Fuse", 694, 661, 694, 693); // riser up between the vat legs
  R("Torch", 338, 684, 340, 688); // set dressing — ignition is direct:
  // the igniter must be BOXED: open-air fire rises away from a downward fuse
  // before it can light it, so sleeve the top of the riser in wall
  R("Wall", 341, 680, 343, 680);
  R("Wall", 341, 681, 341, 689);
  R("Wall", 343, 681, 343, 689);
  world.paint(342, 681, byName("Fire")); // trapped: can only burn downward

  // VOLCANO: wall-core slopes (lava-proof bed) dressed in stone, crater bowl
  // with clone-magma emitters; the right lip is lower so the flow aims at town
  for (let s = 0; s < 130; s++) {
    R("Wall", 170 - s, 264 + s * 3.28 | 0, 173 - s, (266 + s * 3.28) | 0); // left flank
    R("Wall", 197 + s * 1.3 | 0, 264 + s * 3.28 | 0, (200 + s * 1.3) | 0, (266 + s * 3.28) | 0); // right flank
  }
  R("Wall", 168, 250, 171, 264); // left lip (taller)
  R("Wall", 196, 258, 199, 264); // right lip (lower -> overflow right)
  // a heated channel inside the mountain keeps the flow molten all the way
  // down (cold slopes freeze a thin lava stream before it gets anywhere)
  for (let s = 6; s <= 124; s += 8) {
    const hx = ((197 + s * 1.3) | 0) - 6;
    const hy = ((264 + s * 3.28) | 0) + 1;
    R("Heater", hx, hy, hx + 2, hy + 2);
  }
  carve(348, 696, 388, 697); // warm approach under the ground slab
  R("Heater", 348, 696, 388, 697);
  R("Wall", 171, 276, 196, 278); // crater floor
  // the vent: a ONE-wide clone pillar — primer pool against its left face,
  // open air on its right, so every clone both primes AND has room to emit
  // (2-wide pillars split into a primed-but-blocked column and an open-but-
  // unprimed one; pool-buried clones are smothered entirely)
  R("Clone", 180, 266, 180, 275);
  R("Magma", 172, 266, 179, 275); // pool primes the full pillar height
  R("Stone", 120, 400, 168, 420); // loose scree the flow will remobilize
  R("Stone", 205, 380, 260, 400);

  // THE TOWN: five wooden houses (3-thick shells, door gaps), oil in #2,
  // the powder magazine under #3, wax stock in #4, tar lanes between all
  const house = (x0: number) => {
    R("Wood", x0, 640, x0 + 2, 689);
    R("Wood", x0 + 47, 640, x0 + 49, 668); // right wall stops high = door gap
    R("Wood", x0, 636, x0 + 49, 639); // roof
  };
  house(390); house(470); house(550); house(630); house(710);
  R("Oil", 475, 680, 515, 688); // house 2: oil on the floor
  R("Wall", 546, 660, 548, 690); // magazine pit under house 3
  R("Wall", 602, 660, 604, 690);
  R("Wall", 549, 660, 573, 662); // pit roof, gap at 574-576 for the fuse
  R("Wall", 577, 660, 601, 662);
  R("Gunpowder", 549, 664, 601, 688); // ~1,300 cells: the big one
  R("Wax", 635, 664, 675, 688); // house 4: wax stock (melts, floods, burns)
  R("Tar", 442, 686, 468, 689);
  R("Tar", 522, 686, 548, 689);
  R("Tar", 605, 686, 628, 689);
  R("Tar", 682, 686, 708, 689);
  R("Gold", 526, 660, 540, 689); // the monument that outlives the siege

  // NITRO VAT on legs between houses 4 and 5 — heat from the burning town
  // sets it off (radiant ignition), chaining the second mega-boom
  R("Wall", 682, 640, 684, 690);
  R("Wall", 706, 640, 708, 690);
  R("Wall", 684, 658, 693, 660); // tub floor, with a fuse gap at 694-695
  R("Wall", 696, 658, 706, 660);
  R("Fuse", 694, 642, 694, 660); // wick through the gap, into the charge
  R("Nitro", 685, 642, 705, 657);

  // THE LAKE: quenches whatever reaches it
  R("Wall", 810, 655, 812, 690);
  R("Wall", 948, 655, 950, 690);
  R("Water", 813, 660, 947, 688);

  // THE FORTRESS: stone keep, cannon battery on top raining stones LEFT
  R("Stone", 1090, 380, 1130, 688);
  R("Wall", 1085, 370, 1135, 378); // battlement cap the stones rest on
  R("Wall", 1050, 358, 1135, 360); // gun deck
  R("Wall", 1054, 300, 1056, 338); // hopper left wall (clears the barrel)
  R("Wall", 1079, 300, 1081, 356); // hopper right wall
  for (let y = 340; y <= 348; y++) for (let x = 1058; x <= 1066; x++) {
    world.paint(x, y, byName("Cannon"), 128); // aimed LEFT
  }
  R("Stone", 1067, 310, 1078, 356); // breech feed + supply column
  world.paint(1061, 339, byName("Clone")); // trigger on the barrel top
  world.paint(1062, 339, byName("Spark")); // primer

  // DRY-ICE GLACIER on the volcano's right flank: the lava flow sublimates it
  // into a CO2 flood that rolls downslope into the burning town — a visible
  // smother wave fighting the inferno it arrives at
  R("Dry ice", 260, 440, 330, 470);
  R("Wall", 254, 472, 336, 474); // bench the glacier sits on

  // sky, life, witness
  R("Cloud", 840, 62, 990, 74);
  for (const [bx, by] of [[600, 200], [700, 260], [820, 180], [500, 300]]) {
    world.paint(bx, by, byName("Bird"), 1);
  }
  R("Ant", 860, 684, 900, 688);
  player.place(880, 680);

  if (location.hash.includes("shot=")) {
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 40 && performance.now() - t0 < 24) { simTick(); settled++; }
    if (settled < 40) requestAnimationFrame(settle);
  };
  settle();
}

// #alchemy: the M5g showcase — nine self-running chemistry stations
function alchemyScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 30, 690, 1250, 700); // the bench

  // 1) SODIUM DROP: 1-wide clone pillar (primer on its left face, open right)
  // drips alkali metal into the pool — floats, skitters, pops its own hydrogen
  R("Wall", 40, 600, 42, 690);
  R("Wall", 168, 600, 170, 690);
  R("Water", 43, 640, 167, 688);
  R("Clone", 100, 560, 100, 566);
  R("Sodium", 99, 560, 99, 566); // primer column against the left face
  R("Wall", 98, 558, 101, 559); // rain hat keeps the primer seated
  R("Wall", 98, 560, 98, 567);

  // 2) ELEPHANT TOOTHPASTE: glass cylinder, rust catalyst bed, peroxide
  // charge, soap cap — O2 erupts through the pink
  R("Glass", 200, 540, 202, 690);
  R("Glass", 288, 540, 290, 690);
  R("Rust", 203, 680, 287, 688);
  R("Peroxide", 203, 630, 287, 679);
  R("Soapy", 203, 610, 287, 629);

  // 3) CARBIDE LAMP: clone drips carbide into water; acetylene rises the
  // chimney into an embedded torch = permanent flame jet
  R("Wall", 320, 600, 322, 690);
  R("Wall", 438, 600, 440, 690);
  R("Water", 323, 650, 437, 688);
  R("Clone", 380, 610, 380, 614);
  R("Carbide", 379, 610, 379, 614); // primer face
  R("Wall", 378, 608, 381, 609);
  R("Wall", 378, 610, 378, 615);
  R("Wall", 360, 598, 376, 600); // chimney throat, gap at 377-384
  R("Wall", 385, 598, 400, 600);
  R("Torch", 382, 590, 386, 596); // the lamp flame, above the gas gap

  // 4) ROCKET CANDY MILL: sugar/saltpeter layers milling to gunpowder;
  // heater shelf caramel-chars the overspill into charcoal (more fuel)
  R("Wall", 460, 660, 570, 662);
  for (let i = 0; i < 5; i++) R(i % 2 ? "Sugar" : "Saltpeter", 470, 630 + i * 6, 560, 635 + i * 6);
  // no stove here: any heat plate ignites the product as it mills (found the
  // hard way — 940 grains of rocket candy went up before t900)

  // 5) BREWERY + GREENHOUSE: yeast/sugar vat ferments; CO2 rises through the
  // neck into a glass conservatory where vines fix it back to oxygen
  R("Wall", 590, 620, 592, 690);
  R("Wall", 708, 620, 710, 690);
  for (let i = 0; i < 6; i++) R(i % 2 ? "Sugar" : "Yeast", 593, 652 + i * 6, 707, 657 + i * 6);
  R("Glass", 590, 560, 592, 620);
  R("Glass", 708, 560, 710, 620);
  R("Glass", 590, 558, 710, 560);
  R("Vine", 620, 600, 622, 618);
  R("Vine", 660, 606, 662, 618);
  R("Wall", 593, 618, 640, 620); // vat lid with a CO2 gap at 641-659
  R("Wall", 660, 618, 707, 620);

  // 6) NEVER-MIX CABINET: clone drips acid into the bleach tray; chlorine
  // runs down the chute into a lye bed and turns back into bleach
  R("Wall", 730, 600, 732, 690);
  R("Wall", 858, 600, 860, 690);
  R("Wall", 733, 640, 810, 642); // upper tray, open lip at the right
  R("Bleach", 733, 620, 805, 638);
  R("Clone", 760, 604, 760, 608);
  R("Acid", 759, 604, 759, 608); // primer face
  R("Wall", 758, 602, 761, 603);
  R("Wall", 758, 604, 758, 609);
  R("Lye", 733, 680, 857, 688); // scrubber bed on the cabinet floor

  // 7) MAGNESIUM PYRE over a water pool: embers boil it, steam strips the
  // metal into magnesia + hydrogen — never hose a magnesium fire
  R("Wall", 880, 620, 882, 690);
  R("Wall", 998, 620, 1000, 690);
  R("Water", 883, 660, 997, 688);
  R("Wall", 900, 652, 980, 654); // grate just over the waterline
  R("Magnesium", 906, 636, 974, 650); // big pile: skirt cells reach the splash zone
  R("Magnesium", 890, 656, 902, 668); // and a spur slumping into the pool itself
  R("Torch", 908, 644, 912, 650); // embedded at bed level — contact ignition

  // 8) PHOSPHORUS VAULT: white P safe under water beside the pyre's warmth;
  // the dry shelf sample flashes on its own
  R("Glass", 1010, 630, 1012, 690);
  R("Glass", 1078, 630, 1080, 690);
  R("Phosphorus", 1013, 680, 1077, 688);
  R("Water", 1013, 640, 1077, 679);
  R("Wall", 1010, 620, 1080, 622); // dry shelf above the tank
  R("Phosphorus", 1030, 612, 1060, 618);
  R("Heater", 1064, 612, 1067, 618); // a warm pipe: pyrophoric P flashes, tank P sleeps

  // 9) ACID RAIN: embedded torch keeps the sulfur bed smoldering; the fan
  // column lofts SO2 into the cloud, which rains acid on the vine terrace
  R("Wall", 1100, 660, 1240, 662);
  R("Sulfur", 1130, 640, 1210, 658);
  R("Torch", 1122, 650, 1128, 658);
  for (let y = 630; y <= 638; y++) {
    for (let x = 1216, e = 0; x <= 1222; x++, e++) world.paint(x, y, byName("Fan"), 192); // blow up
  }
  R("Cloud", 1140, 540, 1230, 552);
  R("Vine", 1150, 680, 1152, 688);
  R("Vine", 1180, 674, 1182, 688);
  R("Vine", 1210, 678, 1212, 688);

  if (location.hash.includes("shot=")) {
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 120 && performance.now() - t0 < 24) { simTick(); settled++; }
    if (settled < 120) requestAnimationFrame(settle);
  };
  settle();
}

// #cryo: the M5h works — cryogenics, sublimation, and the renewable-powder plant
function cryoScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 30, 690, 1250, 700); // the works floor

  // 1) SALTPETER WORKS: a clone at the tank floor bubbles ammonia up through
  // the acid column; saltpeter snows out and drifts to the floor — the
  // renewable half of the gunpowder loop, running unattended
  R("Glass", 40, 540, 42, 690);
  R("Glass", 198, 540, 200, 690);
  R("Glass", 40, 538, 200, 540);
  // batch reactor: a deep ammonia atmosphere pressed flush onto the acid —
  // saltpeter snows out for thousands of ticks. (Clone injectors don't work
  // here: liquid floods the clone's only open face and smothers it.)
  R("Acid", 43, 620, 197, 660);
  R("Ammonia", 43, 541, 197, 619);

  // 2) POWDER POPS: a clone drip feeds gunpowder onto an embedded torch in a
  // stone pit — recurring pops with the full blast drama pass
  R("Stone", 230, 660, 350, 688);
  R("Wall", 236, 640, 238, 660); // pit walls carved into the pile
  R("Wall", 342, 640, 344, 660);
  R("Torch", 284, 654, 292, 658);
  R("Clone", 288, 610, 288, 612);
  R("Gunpowder", 287, 610, 287, 612); // primer face
  R("Wall", 286, 608, 289, 609);
  R("Wall", 286, 610, 286, 613);
  R("Wall", 287, 613, 287, 613); // ledge: powder primers fall without one

  // 3) CRYO LAKE: LN2 dripper freezes the surface while a heater melts from
  // the floor — a breathing ice sheet, fighting itself forever
  R("Wall", 380, 560, 382, 690);
  R("Wall", 558, 560, 560, 690);
  R("Heater", 455, 686, 485, 688); // small center patch — a full-width heater
  R("Water", 383, 600, 557, 685);  // pre-warms the pool and the cryogen never wins
  // LN2 only survives in BULK (thin streams and droplets boil the tick they
  // meet warm air — clone drippers can't work). One massive cryogen dump at
  // t0 freezes the sheet; the heater floor melts it back from below and the
  // lake breathes between ice and water from then on
  R("Liq. N2", 440, 560, 500, 590);

  // 4) IODINE LAMP: heater bed sublimates the crystals; violet vapor climbs
  // the glass chimney, deposits on the cooler-lined shelf, and the crystals
  // avalanche back down — a purple lava lamp
  R("Glass", 590, 480, 592, 690);
  R("Glass", 698, 480, 700, 690);
  R("Glass", 590, 478, 700, 480);
  R("Heater", 593, 686, 697, 688);
  R("Iodine", 600, 660, 690, 684);
  R("Cooler", 593, 481, 697, 483);
  R("Glass", 620, 540, 670, 542); // mid shelf the returning crystals pile on

  // 5) GALLIUM SABOTAGE: a warm pipe melts the gallium block; the molten
  // metal wicks into the aluminum bridge, embrittles it to dust, and the
  // stone load comes down
  R("Stone", 730, 600, 750, 688); // left pier
  R("Stone", 860, 600, 880, 688); // right pier
  R("Aluminum", 750, 596, 860, 604); // the bridge span
  R("Stone", 780, 560, 830, 594); // the load
  R("Gallium", 760, 586, 776, 594); // block resting on the span
  R("Heater", 758, 594, 778, 595); // warm plate directly under the block

  // 6) SMELTER + SMOG: torch bed roasts cinnabar; mercury rains through the
  // grate and pools; the SO2 climbs past a vine trellis (acid smog) toward
  // the cloud, which rains acid back down
  R("Wall", 910, 600, 912, 690);
  R("Wall", 1058, 600, 1060, 690);
  R("Wall", 916, 660, 1054, 662); // grate the mercury drips through
  R("Torch", 920, 654, 930, 658);
  R("Cinnabar", 920, 630, 1000, 652);
  // roofed sulfur burner: collapsing ore can't bury it; the flue fan lofts
  // the dense SO2 up past the vine trellis toward the cloud
  R("Wall", 1004, 648, 1036, 650); // burner roof
  R("Sulfur", 1008, 654, 1026, 658);
  R("Torch", 1028, 654, 1034, 658); // flush against the sulfur bed
  for (let y = 636; y <= 644; y++) {
    for (let x = 1042, e = 0; x <= 1048; x++, e++) world.paint(x, y, byName("Fan"), 192); // blow up
  }
  R("Vine", 1050, 610, 1052, 688);
  R("Cloud", 940, 480, 1040, 492);

  // 7) DRY ICE vs PYRE: the burning stack's own heat sublimates the ledge of
  // dry ice above it; the CO2 flood smothers the fire, the torch relights it
  R("Wall", 1090, 690, 1240, 692);
  R("Wood", 1130, 640, 1200, 688);
  R("Torch", 1132, 682, 1136, 688); // embedded: relights after every smother
  R("Wall", 1120, 600, 1210, 602); // the ledge
  R("Dry ice", 1126, 580, 1204, 598);

  if (location.hash.includes("shot=")) {
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 120 && performance.now() - t0 < 24) { simTick(); settled++; }
    if (settled < 120) requestAnimationFrame(settle);
  };
  settle();
}

// #boiler: the M5i pressure works — everything here fails by overpressure
function boilerScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 30, 690, 1250, 700); // the plant floor

  // 1) THE BOILER: clone-fed water over a fierce heater in a glass shell —
  // it bursts, vents as a steam geyser through the breach, re-seals... never
  R("Glass", 60, 540, 62, 690);
  R("Glass", 198, 540, 200, 690);
  R("Glass", 60, 538, 200, 540);
  R("Heater", 63, 684, 197, 688);
  R("Water", 63, 620, 197, 683);
  R("Clone", 130, 560, 130, 562);
  R("Water", 129, 560, 129, 562); // primer
  R("Wall", 128, 558, 131, 559);
  R("Wall", 128, 560, 128, 563);
  R("Wall", 129, 563, 129, 563); // ledge

  // 2) TANK FARM: three sealed propane tanks; a torch slow-cooks the first —
  // thermal expansion pops it, the vapor cloud finds the flame, and the
  // fireball chains down the row
  const tank = (x0: number) => {
    R("Glass", x0, 600, x0 + 2, 690);
    R("Glass", x0 + 58, 600, x0 + 60, 690);
    R("Glass", x0, 598, x0 + 60, 600);
    R("Propane", x0 + 3, 640, x0 + 57, 688);
  };
  tank(240); tank(320); tank(400);
  // the slow cooker: carve the plant floor under tank 1 and embed a heater —
  // thermal expansion pops the shell, the escaping vapor finds the hot plate
  for (let y = 690; y <= 694; y++) for (let x = 250; x <= 290; x++) world.paint(x, y, E.EMPTY);
  R("Heater", 250, 690, 290, 694);
  R("Torch", 305, 684, 311, 688); // pilot light between tanks 1 and 2:
  // the breach vapor drifts over it, and the fireball takes the row

  // 3) FIREDAMP MINE: a wall gallery with a methane pocket under its roof and
  // glass skylights; the miner's torch flame crawls in and finds the gas
  R("Wall", 520, 560, 760, 566); // roof
  R("Glass", 560, 560, 590, 566); // skylight 1
  R("Glass", 680, 560, 710, 566); // skylight 2
  R("Wall", 520, 566, 526, 690);
  R("Wall", 754, 566, 760, 690);
  R("Methane", 530, 568, 750, 600);
  R("Torch", 730, 682, 736, 688);
  R("Wood", 700, 660, 750, 688); // pit props: fuel path toward the pocket
  R("Ant", 560, 684, 620, 688); // the doomed shift

  // 4) FERMENTATION CELLAR: carboys of different sizes pop on their own clocks
  const carboy = (x0: number, w: number, h: number) => {
    R("Glass", x0, 690 - h, x0 + 2, 690);
    R("Glass", x0 + w - 2, 690 - h, x0 + w, 690);
    R("Glass", x0, 688 - h, x0 + w, 690 - h);
    for (let i = 0; i < 4; i++) {
      R(i % 2 ? "Sugar" : "Yeast", x0 + 3, 690 - Math.floor(h / 2) + i * 5, x0 + w - 3, 690 - Math.floor(h / 2) + i * 5 + 4);
    }
  };
  carboy(820, 50, 80); carboy(890, 70, 110); carboy(980, 40, 60);

  // 5) DRY-ICE BOMB: a sealed flask of dry ice — room warmth sublimates it,
  // CO2 pressure does the rest (no flame anywhere near it)
  R("Glass", 1080, 620, 1082, 690);
  R("Glass", 1138, 620, 1140, 690);
  R("Glass", 1080, 618, 1140, 620);
  R("Dry ice", 1083, 660, 1137, 688);

  if (location.hash.includes("shot=")) {
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 60 && performance.now() - t0 < 24) { simTick(); settled++; }
    if (settled < 60) requestAnimationFrame(settle);
  };
  settle();
}

// #cannon: the pressure gunnery range — every gun here is driven by the
// pressure field. Bores are 18 wide because a ball is r=7: a narrower bore
// WEDGES the shot and it just judders in place.
function cannonScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  const carve = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, E.EMPTY);
  };
  R("Wall", 20, 690, 1260, 700); // the range floor — also every gun's breech

  // 1) PNEUMATIC MORTAR — no explosive anywhere: a sealed steam chamber, and
  // the ball's own body sealing the bore. Boil it and the shot leaves.
  R("Wall", 40, 300, 54, 689);
  R("Wall", 73, 300, 87, 689);
  R("Heater", 55, 686, 72, 689);
  R("Water", 55, 668, 72, 685);
  objects.spawn("ball", 63, 650);

  // 2) POWDER CANNON — the same barrel with a charge instead of a boiler
  R("Wall", 150, 300, 164, 689);
  R("Wall", 183, 300, 197, 689);
  R("Gunpowder", 165, 668, 182, 689);
  objects.spawn("ball", 173, 650);

  // 3) STEAM FOUNTAIN — self-running: a clone re-drips water onto the plate,
  // so the chamber keeps re-pressurising and keeps throwing its sand charge
  R("Wall", 260, 300, 274, 689);
  R("Wall", 293, 300, 307, 689);
  R("Heater", 275, 686, 292, 689);
  R("Water", 275, 672, 292, 685);
  R("Sand", 275, 644, 292, 670); // the charge it throws, over and over
  R("Clone", 281, 610, 281, 612); // re-feeds the boiler forever
  R("Water", 280, 610, 280, 612);
  R("Wall", 279, 608, 282, 609);
  R("Wall", 279, 610, 279, 613);
  R("Wall", 280, 613, 280, 613); // ledge — liquid primers fall without one

  // 4) THE LESSON: identical charges, one barrel OPEN and one CAPPED. The
  // open one fires its shot; the capped one has nowhere to vent and bursts.
  R("Wall", 380, 420, 394, 689);
  R("Wall", 413, 420, 427, 689);
  R("Gunpowder", 395, 668, 412, 689);
  objects.spawn("ball", 404, 650);

  // the capped twin is deliberately STUBBY: a cap 250 cells up the bore never
  // sees the charge's pressure, so the lid sits just above the powder
  R("Wall", 470, 636, 484, 689);
  R("Wall", 503, 636, 517, 689);
  R("Gunpowder", 485, 668, 502, 689);
  R("Glass", 485, 636, 502, 644); // the cap that has to give

  // Each powder gun gets its OWN fuse under the floor, cut to a different
  // length so the range fires in sequence (fuse burns ~0.1 cell/tick, so a
  // shared 380-cell train would never reach the far guns). Carve the tunnel
  // through the slab FIRST, then embed the fuse — wall paint overwrites it —
  // and light it with fire painted ON the fuse end: an open-air flame rises
  // away instead of burning downward.
  const fuseRun = (gunX: number, len: number) => {
    carve(gunX - len, 694, gunX, 694);
    carve(gunX, 690, gunX, 693);
    R("Fuse", gunX - len, 694, gunX, 694);
    R("Fuse", gunX, 690, gunX, 693);
    world.paint(gunX - len, 694, byName("Fire"));
  };
  fuseRun(173, 12); // powder cannon fires first
  fuseRun(404, 30); // the open barrel next
  fuseRun(494, 48); // the capped one last — it bursts instead of firing

  // 5) JET VENT — a boiler with one small side opening: everything escapes
  // through that hole as a working jet that sweeps the loose sand downrange
  R("Wall", 580, 560, 594, 689);
  R("Wall", 660, 560, 674, 689);
  R("Wall", 580, 556, 674, 560);
  R("Heater", 595, 686, 659, 689);
  R("Water", 595, 640, 659, 685);
  carve(660, 596, 674, 604); // the nozzle, punched through the right wall
  R("Sand", 700, 676, 900, 689); // the dune the jet works on

  // 6) FLAT SHOT — a short horizontal bore that rockets its ball the length of
  // the range into the keep. (A packed powder slug jams in a bore instead of
  // spraying — the M5b lesson — so the shot is a ball; and a flat shot at
  // y≈615 sails clean over anything resting on the floor.)
  R("Wall", 950, 600, 1020, 604);
  R("Wall", 950, 623, 1020, 627);
  R("Wall", 946, 600, 950, 627); // breech plate
  R("Gunpowder", 951, 605, 975, 622);
  objects.spawn("ball", 990, 613);
  world.paint(955, 613, byName("Fire"));
  R("Stone", 1210, 540, 1250, 689); // the keep it all ends against
  R("Glass", 1210, 520, 1250, 538);

  if (location.hash.includes("shot=")) {
    for (let i = 0; i < 770; i++) simTick();
    return;
  }
  let settled = 0;
  const settle = () => {
    const t0 = performance.now();
    while (settled < 40 && performance.now() - t0 < 24) { simTick(); settled++; }
    if (settled < 40) requestAnimationFrame(settle);
  };
  settle();
}

if (location.hash.startsWith("#demo")) demoScene();
else if (location.hash.startsWith("#chem")) chemScene();
else if (location.hash.startsWith("#range")) rangeScene();
else if (location.hash.startsWith("#doom")) doomScene();
else if (location.hash.startsWith("#alchemy")) alchemyScene();
else if (location.hash.startsWith("#cryo")) cryoScene();
else if (location.hash.startsWith("#boiler")) boilerScene();
else if (location.hash.startsWith("#cannon")) cannonScene();

// ---- in-page self test ----------------------------------------------------
// The other half of the suite. tools/apptest.ts covers everything that runs
// without a DOM; these are the cases that need the real page — the wiring where
// this project's regressions have actually lived. Every one of them is a bug
// that shipped: dialogs pinned to the corner by a CSS reset, a demo that could
// not be reloaded, a notebook "clear" that rebuilt itself, a palette filter that
// forgot the arrow keys. Run it with granulab.selftest().
function selftest(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;
  const check = (name: string, cond: boolean, detail = ""): void => {
    if (cond) passed++;
    else failures.push(name + (detail ? ` — ${detail}` : ""));
  };
  const wasPaused = ui.state.paused;
  ui.setPaused(true);
  resize();
  const q = <T extends Element>(sel: string): T => document.querySelector<T>(sel)!;
  const fillRect = (name: string, x0: number, y0: number, x1: number, y1: number): void => {
    const id = ELEMENTS.find((d) => d.name === name)!.id;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };

  // FIRST, before the suite touches anything: filtering and binding both rebuild
  // the roving tabindex, so measuring this later only ever proves that the test
  // repaired it. Check the state the app was actually left in.
  const tabbable = [...document.querySelectorAll<HTMLElement>("#rails .el")].filter((b) => b.tabIndex === 0);
  check("the palette is a single tab stop, not 110", tabbable.length === 1, `${tabbable.length} stops`);

  // dialogs must sit where a modal belongs; `* { margin: 0 }` once pinned every
  // one of them to the top-left corner and nobody noticed for a milestone
  for (const id of ["eldialog", "gallerydialog", "slotdialog", "helpdialog", "codedialog", "setdialog", "tunedialog", "rxdialog", "customdialog"]) {
    const d = document.getElementById(id) as HTMLDialogElement | null;
    if (!d) { check(`${id} exists`, false); continue; }
    d.showModal();
    const r = d.getBoundingClientRect();
    // centred MEANS the margins match, whatever the viewport is; an absolute
    // "left > 20" only passes on a window big enough, which is not the property
    const wantLeft = (window.innerWidth - r.width) / 2;
    check(`${id} is centred, not pinned to a corner`,
      Math.abs(r.left - wantLeft) < 4, `left ${Math.round(r.left)}, expected ${Math.round(wantLeft)}`);
    check(`${id} is labelled for assistive tech`, !!d.getAttribute("aria-labelledby"));
    d.close();
  }

  // a native select fires no change event for the option it already holds, so
  // the picker has to snap back or a scene can never be restarted
  const demosel = q<HTMLSelectElement>("#demosel");
  world.clear();
  demosel.value = "chem";
  demosel.dispatchEvent(new Event("change", { bubbles: true }));
  check("loading a demo fills the grid", world.dots > 1000, `${world.dots} dots`);
  check("the demo picker snaps back so the same scene can reload", demosel.value === "");

  // palette filter: names, rails and properties
  const filter = q<HTMLInputElement>("#elfilter");
  const type = (v: string): void => { filter.value = v; filter.dispatchEvent(new Event("input", { bubbles: true })); };
  const shown = (): string[] =>
    [...document.querySelectorAll('#rails .palette:not([data-rail="recent"]) .el:not([hidden])')]
      .map((b) => (b.textContent ?? "").trim());
  type("sand");
  check("the filter finds an element by name", shown().includes("Sand"));
  type("metals");
  check("the filter finds a whole rail", shown().length > 3 && shown().includes("Copper"));
  type("conducts");
  const conductors = shown();
  check("the filter answers a property question", conductors.length > 0 && conductors.every((n) => ["Metal", "Copper", "Gold", "Tungsten"].includes(n)), conductors.join(","));
  type("zzzz");
  check("no matches says so", !q<HTMLElement>("#norail").hidden);
  type("");

  // keyboard painting: the canvas has to be usable without a pointer at all
  world.clear();
  ui.bind("L", E.POWDER);
  const key = (code: string, opts: KeyboardEventInit = {}): void => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, key: opts.key ?? code, bubbles: true, cancelable: true, ...opts }));
  };
  key("KeyK", { key: "k" });
  check("K turns keyboard painting on", keyPaint);
  const cursor0 = { ...keyCursor };
  key("ArrowRight");
  check("arrows move the cursor by a nib", keyCursor.x - cursor0.x === Math.max(2, ui.state.pen));
  key("Enter");
  check("Enter lays down a dab", world.dots > 0, `${world.dots} dots`);
  check("and it lands under the cursor", world.species[keyCursor.y * GRID_W + keyCursor.x] === E.POWDER);
  key("Escape", { key: "Escape" });
  check("Escape leaves the mode", !keyPaint);

  // stirring is a permutation: it may rearrange a beaker but never invent or
  // destroy anything, and it must leave the container itself alone
  world.clear();
  objects.clear();
  const glass = ELEMENTS.find((d) => d.name === "Glass")!.id;
  for (let y = 300; y <= 560; y++) for (const x of [500, 700]) world.paint(x, y, glass);
  for (let y = 400; y <= 540; y++) for (let x = 501; x < 700; x++) world.paint(x, y, E.WATER);
  for (let y = 340; y <= 399; y++) for (let x = 501; x < 700; x++) world.paint(x, y, ELEMENTS.find((d) => d.name === "Oil")!.id);
  const dotsBefore = world.dots;
  let glassBefore = 0;
  for (let i = 0; i < world.species.length; i++) if (world.species[i] === glass) glassBefore++;
  for (let n = 0; n < 8; n++) for (let x = 520; x <= 680; x += 24) stir(x, 450, 26);
  let glassAfter = 0;
  for (let i = 0; i < world.species.length; i++) if (world.species[i] === glass) glassAfter++;
  check("stirring conserves every dot", world.dots === dotsBefore, `${world.dots} vs ${dotsBefore}`);
  check("stirring leaves the container standing", glassAfter === glassBefore, `${glassAfter} vs ${glassBefore}`);

  // the lab panel's header once overflowed its own width by 68px, and the
  // legend has to tell you what a loaded scene is actually made of
  {
    const nb = q<HTMLElement>("#notebook");
    const wasHidden = nb.hidden;
    nb.hidden = false;
    const head = nb.querySelector<HTMLElement>(".nb-head")!;
    const nbTools = q<HTMLElement>("#nbtools");
    check("the lab panel header fits inside the panel", head.scrollWidth <= head.clientWidth,
      `${head.scrollWidth} in ${head.clientWidth}`);
    check("and so does its tool row", nbTools.scrollWidth <= nbTools.clientWidth);
    q<HTMLButtonElement>("#tab-legend").click();
    check("the contents tab hides the reaction tools", nbTools.hidden && q<HTMLElement>("#nbrows").hidden);
    world.clear();
    fillRect("Sand", 100, 100, 300, 200);
    fillRect("Water", 400, 100, 600, 200);
    legendCounts.fill(0);
    let total = 0;
    for (let i = 0; i < world.species.length; i++) {
      const id = world.species[i];
      if (id !== E.EMPTY) { legendCounts[id]++; total++; }
    }
    ui.setLegend(legendCounts, total);
    const names = [...document.querySelectorAll("#nblegend .lg-name")].map((n) => n.textContent);
    check("the legend lists what is on the grid", names.includes("Sand") && names.includes("Water"), names.join(","));
    q<HTMLButtonElement>("#tab-rx").click();
    nb.hidden = wasHidden;
  }

  // an empty grid should invite rather than sit there
  world.clear();
  objects.clear();
  player.remove();
  ui.setEmpty(true);
  check("an empty grid says what to do with it", !q<HTMLElement>("#emptyhint").hidden);
  fillRect("Sand", 10, 10, 20, 20);
  ui.setEmpty(world.dots === 0);
  check("and the invitation goes the moment anything is painted", q<HTMLElement>("#emptyhint").hidden);

  // the pointer reflects the tool it is holding
  const cursorFor = (id: number): string => {
    ui.bind("L", id);
    return document.documentElement.dataset.tool ?? "";
  };
  check("stir has its own pointer", cursorFor(TOOL_STIR) === "stir");
  check("placement has its own pointer", cursorFor(TOOL_PLAYER) === "place");
  check("erase has its own pointer", cursorFor(E.EMPTY) === "erase");
  check("painting keeps the crosshair", cursorFor(E.POWDER) === "paint");

  // the datasheet has to answer "how do I make this", not just "what does it do"
  const bleach = ELEMENTS.find((d) => d.name === "Bleach");
  if (bleach) {
    ui.bind("L", bleach.id);
    const card = q<HTMLElement>("#reagent");
    check("the datasheet says where an element comes from",
      !card.hidden && (card.textContent ?? "").includes("made from"));
  }

  // storage that cannot be parsed must not be able to stop the app booting
  check("a corrupt storage value is survivable", (() => {
    try {
      localStorage.setItem("granulab-selftest-probe", "{not json");
      const v = readJson("granulab-selftest-probe", { ok: true });
      localStorage.removeItem("granulab-selftest-probe");
      return (v as { ok?: boolean }).ok === true;
    } catch { return false; }
  })());

  world.clear();
  objects.clear();
  ui.bind("L", E.POWDER);
  ui.setPaused(wasPaused);
  const result = { passed, failed: failures.length, failures };
  console.log(`[granulab-selftest] ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  return result;
}

window.granulab = {
  selftest,
  engine: engineActive,
  demo: demoScene,
  chem: chemScene,
  range: rangeScene,
  doom: doomScene,
  alchemy: alchemyScene,
  cryo: cryoScene,
  boiler: boilerScene,
  cannon: cannonScene,
  player,
  fighters,
  objects,
  spawnFighter: (x: number, y: number) => { const f = new Fighter(); f.place(x, y); fighters.push(f); return f; },
  createElement: createCustomElement,
  drawMinimap,
  code: sceneCode,
  loadCode: loadSceneCode,
  undo,
  redo,
  undoDepth: () => undoStack.length,
  redoDepth: () => redoStack.length,
  slots: readSlots,
  record: toggleRecording,
  recording: () => !!recorder,
  galleryList: () => fetch("/api/gallery").then((r) => r.json()),
  galleryUpload: uploadToGallery,
  galleryLoad: loadFromGallery,
  keys,
  save: () => toB64(saveAll()),
  restore: (b64: string) => loadAll(fromB64(b64)),
  world,
  renderer,
  ui,
  paint: (name: string, x: number, y: number, r = 4) => stamp(x, y, r, byName(name)),
  stir,
  rect: (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  },
  tick: (n = 1) => { for (let i = 0; i < n; i++) simTick(); },
  // rAF is throttled whenever the pane is not displayed, so QA drives the two
  // frame-side jobs synchronously the same way tick() drives the sim
  resize,
  drawPreview: drawBrushPreview,
  hover: () => hoverCell,
  pause: (p: boolean) => ui.setPaused(p),
  count: (name: string) => {
    const id = byName(name);
    let c = 0;
    for (let i = 0; i < world.species.length; i++) if (world.species[i] === id) c++;
    return c;
  },
  stats: () => ({ fps: fpsEma, tickMs: tickEma, dots: world.dots, chunks: world.activeChunkCount(), frame: world.frame }),
};
