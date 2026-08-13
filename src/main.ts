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
    else if (name === "machines") machinesScene();
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
  const aux = id === E.FAN || id === E.CANNON || id === E.INVERTER ? strokeAngle : undefined;
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
      const aux = id === E.FAN || id === E.CANNON || id === E.INVERTER ? strokeAngle : undefined;
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
  // The front door: this is what "load a demo" gives a first-time visitor, so it
  // is staged as six vignettes along one floor rather than a heap of everything
  // at once. Each one does a single thing, continuously, with headroom above it
  // so the motion is legible from across the room.
  R("Wall", 20, 688, 1260, 704); // the bench everything stands on

  // 1) THE CASCADE — a header tank spills down three steps into a basin. Shows
  //    the liquid flow: each step fills, levels, and overtops the next.
  R("Wall", 40, 300, 60, 470);
  R("Wall", 40, 458, 210, 470);
  R("Wall", 190, 470, 210, 560);
  R("Wall", 60, 548, 210, 560);
  R("Wall", 40, 560, 60, 660);
  R("Wall", 40, 648, 250, 660);
  R("Wall", 236, 560, 250, 688); // basin wall
  R("Water", 61, 316, 189, 457);
  R("Clone", 45, 306, 55, 316); // keeps the header tank topped up for ever
  R("Water", 45, 318, 55, 318); // primer under the clone, on its own ledge

  // 2) THE DUNE — a fan drives sand across a shelf: saltation you can watch.
  const fan = byName("Fan");
  for (let y = 636, k = 0; y <= 664; y++, k++) {
    for (let x = 268; x <= 278; x++) world.paint(x, y, fan, 0); // angle 0 = blow right
  }
  R("Sand", 288, 520, 500, 687);

  // 3) THE FORGE — magma drips onto water: stone, steam and light, every second.
  R("Wall", 520, 610, 700, 622); // the anvil the drops land on
  R("Wall", 520, 622, 532, 688);
  R("Wall", 688, 622, 700, 688);
  R("Water", 533, 640, 687, 687);
  R("Wall", 576, 312, 600, 320); // the shelf the primer pool rests on
  R("Clone", 601, 300, 601, 311); // one cell wide: primed left, open right
  R("Magma", 593, 300, 600, 311); // the pool that primes the whole pillar height

  // 4) THE GREENHOUSE — vines climbing under glass, with birds over the top.
  R("Glass", 740, 520, 752, 688);
  R("Glass", 880, 520, 892, 688);
  R("Glass", 740, 512, 892, 520);
  R("Vine", 770, 660, 774, 687);
  R("Vine", 810, 668, 814, 687);
  R("Vine", 850, 654, 854, 687);
  R("Water", 753, 600, 879, 687);
  for (const [bx, by] of [[800, 200], [860, 260], [920, 170]]) world.paint(bx, by, byName("Bird"), 1);

  // 5) THE BATTERY — a one-wide firework column lit from the TOP, so every
  //    rocket leaves with a clear nose (a blocked nose detonates in the tube).
  R("Wall", 930, 600, 942, 688);
  R("Wall", 990, 600, 1002, 688);
  R("Clone", 966, 686, 966, 687);
  R("Fireworks", 966, 663, 966, 685);
  R("Torch", 967, 661, 970, 665);

  // 6) THE RAMP — a slope for the rigid objects, with a lip at the bottom so
  //    the ball comes to rest in view instead of rolling off the world.
  for (let s = 0; s <= 150; s++) {
    R("Marble", 1040 + s, 470 + ((s * 1.4) | 0), 1046 + s, 480 + ((s * 1.4) | 0));
  }
  R("Wall", 1240, 620, 1252, 688);

  // a beaker of acid over lye, left stratified on purpose: the stir tool is the
  // point, and the two only meet where you make them meet. WALL, not glass:
  // acid corrodes glass, and the glass version measured here dissolved 2,819 of
  // its own 5,430 cells in 600 ticks and took the acid down with it — an
  // exhibit that eats itself before anyone gets to stir it.
  R("Wall", 430, 300, 442, 470);
  R("Wall", 520, 300, 532, 470);
  R("Wall", 430, 458, 532, 470);
  R("Lye", 443, 400, 519, 457);
  R("Acid", 443, 330, 519, 399);

  R("Ice", 1100, 640, 1180, 687); // a cold corner for the thermography view
  R("Powder", 60, 60, 400, 240); // a dune of loose powder overhead, ready to fall
  player.place(620, 680);
  objects.spawn("ball", 1060, 430);
  objects.spawn("wheel", 320, 560);
  objects.spawn("box", 1180, 640);
  const fighter = new Fighter();
  fighter.place(660, 680);
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
// #chem: the chemistry lab bench. Six vignettes along one bench, each running a
// single loop continuously with room above it to be watched — the old bench put
// seven stations into the bottom ninety rows, which is a lot of chemistry
// happening where nobody can see it. The gunpowder mill (a colour change) and
// the soap geyser (no reaction at all) were cut to make room for the rest.
function chemScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 20, 688, 1260, 704); // the bench everything stands on

  // 1) THE GAS CELLS — two sealed vessels sharing a lid, each making a gas you
  //    can watch collect. LEFT: an iron block standing in acid, streaming
  //    hydrogen into the hood above it (the metal survives the row and only the
  //    acid is spent — 4,437 cells of iron still had 3,160 after 600 ticks).
  //    RIGHT: the chlor-alkali cell, a sparked gold electrode in brine, laying
  //    down chlorine as a yellow-green layer on the surface.
  //    THE TANK IS WALL, NOT GLASS, on two counts. Gas accumulating in a sealed
  //    vessel raises the overpressure until the skin ruptures, and glass
  //    ruptures into shards where wall holds — the glass build shed 199 shards
  //    in 400 ticks and then drained through its own breach. And acid corrodes
  //    glass outright: only wall is exempt.
  //    ELECTROLYSIS MAKES THE HYDROGEN HALF IMPOSSIBLE, which is why the left
  //    cell is a chemical generator instead: a spark IGNITES what it touches
  //    (hydrogen's flammability is 255), so a sparked cell burns its own
  //    product — measured, it climbed to 1,332 cells and then flashed to steam
  //    at t300 and never recovered. Gold, meanwhile, because iron would rust
  //    away at a seawater waterline.
  R("Wall", 34, 444, 232, 452);
  R("Wall", 34, 452, 40, 687);
  R("Wall", 226, 452, 232, 687);
  R("Wall", 130, 452, 136, 687); // the divider
  R("Metal", 60, 600, 110, 686); // the block the acid works on
  R("Acid", 41, 560, 129, 686); // poured AROUND it: paint fills empty only
  R("Gold", 140, 470, 142, 624); // dry riser down to the submerged bus
  R("Gold", 140, 620, 222, 624);
  world.paint(144, 470, byName("Clone"));
  world.paint(145, 470, byName("Spark")); // primer: the clone memorises it
  R("Seawater", 137, 560, 225, 686);

  // 2) THE FIZZ FOUNTAIN — acid drips a hundred cells onto a bicarbonate bed,
  //    the CO2 pours off the shelf into the well below, and a lye bed at the
  //    bottom scrubs it back to soda: the whole carbonate cycle in one frame,
  //    and contained, so the flood cannot roll into the neighbours.
  R("Wall", 250, 330, 258, 687);
  R("Wall", 432, 330, 440, 687);
  R("Wall", 258, 600, 390, 606); // the shelf; the drop is the gap at 391-431
  R("Wall", 384, 576, 390, 600); // AND ITS LIP. A powder bed with an open edge
  // does not stay on a shelf: without this the soda slumped straight over the
  // drop, buried the scrubber and left one undifferentiated bin of white. The
  // lip holds the solid and still lets the gas above it spill over.
  R("Soda", 259, 540, 383, 599);
  // THE BURETTE, and it is a gravity feed rather than the clone dripper this
  // started as, because ACID CORRODES CLONES: the alternating acid/clone row
  // dissolved its own emitters, 58 clones down to 8 by t300, and the station
  // quietly stopped. A wall tank draining through a slot in its own floor has
  // nothing to eat — wall is the one thing acid is exempt from — and it pours
  // a bright green stream a hundred cells down onto the bed, which is the part
  // of this reaction that reads at a glance (the CO2 it makes is dark grey).
  R("Wall", 296, 386, 302, 470);
  R("Wall", 348, 386, 354, 470);
  R("Wall", 302, 464, 322, 470);
  R("Wall", 325, 464, 348, 470); // the drain is the 2-cell slot at 323-324
  R("Acid", 303, 392, 347, 463);
  R("Lye", 259, 660, 431, 687); // the scrubber bed the flood lands on

  // 3) THE LIME KILN — a shaft with a magma bath at the bottom. Limestone rains
  //    two hundred cells into the melt, sinks (density 80 against magma's 40),
  //    calcines at depth, and comes back up as lime (36) floating on top.
  R("Wall", 458, 380, 466, 687);
  R("Wall", 640, 380, 648, 687);
  R("Magma", 467, 630, 639, 687);
  // two hoppers, because one 1-wide clone is a trickle and this wants a curtain
  const hopper = (cx: number) => {
    R("Wall", cx - 2, 448, cx + 1, 449); // rain hat keeps the primer seated
    R("Wall", cx - 2, 450, cx - 2, 455);
    R("Wall", cx - 1, 455, cx - 1, 455); // ledge — a powder primer falls without one
    R("Limestone", cx - 1, 450, cx - 1, 454); // primer face
    R("Clone", cx, 450, cx, 454); // open to the right: that is where it drips
  };
  hopper(516);
  hopper(584);

  // 4) THE THERMITE FORGE — the hearth stands on stub legs over a quench tank,
  //    so once the charge goes off the melt runs off both ends of the slab and
  //    falls a hundred cells into the water: stone, steam and light.
  R("Wall", 666, 560, 674, 687);
  R("Wall", 848, 560, 856, 687);
  R("Wall", 700, 470, 822, 478); // the hearth slab
  R("Wall", 700, 478, 706, 520); // stub legs, so the pour clears the tank rim
  R("Wall", 816, 478, 822, 520);
  R("Torch", 707, 458, 713, 469); // embedded at bed level: flames rise, contact lights
  R("Charcoal", 714, 458, 815, 469); // the ember bed a torch alone cannot replace
  R("Thermite", 720, 420, 802, 457);
  R("Water", 675, 600, 847, 686);

  // 5) THE GREENHOUSE — a tall glass house with a CO2 atmosphere at the floor
  //    and vines climbing up through it; the oxygen they fix accumulates under
  //    the roof and works its way down as a pale ceiling you can watch grow.
  //    The shell is wall for the same reason as the cell next door: vines
  //    growing inside a sealed house displace its atmosphere, the overpressure
  //    reached 1.48, and the glass version was shedding shards from t100.
  R("Wall", 874, 322, 1064, 330);
  R("Wall", 874, 330, 882, 687);
  R("Wall", 1056, 330, 1064, 687);
  R("Vine", 906, 640, 909, 687);
  R("Vine", 946, 652, 949, 687);
  R("Vine", 986, 636, 989, 687);
  R("Vine", 1026, 648, 1029, 687);
  R("CO2", 883, 640, 1055, 686); // a gas never settle-sleeps, so keep the dose sane

  // 6) THE TITRATION BEAKER — acid layered on lye and left that way on purpose.
  //    They only meet across the interface, which is what the stir tool is for:
  //    the same beaker stirred consumes about eight times the acid. The litmus
  //    grains have to be painted BEFORE the reagents (paint fills empty only),
  //    and they wear the pH of whatever they are sitting in, in every view mode.
  //    The beaker is WALL and not glass because ACID CORRODES GLASS: measured
  //    side by side over 600 ticks, a glass beaker loses 3,519 of its 5,400
  //    cells while the identical wall one loses none. Only wall is exempt.
  R("Wall", 1090, 460, 1098, 687);
  R("Wall", 1236, 460, 1244, 687);
  for (let y = 520; y <= 676; y += 14) {
    for (let x = 1104; x <= 1230; x += 13) R("Litmus", x, y, x + 1, y + 1);
  }
  R("Lye", 1099, 590, 1235, 687);
  R("Acid", 1099, 480, 1235, 589);

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

// #range: the weapons range. Six exhibits, and the thing they all needed was
// ROOM — ballistics is the one subsystem whose whole point is the flight, and
// every gun here used to fire across a strip a hundred rows deep. The sentry
// now shells from a tower with 300 cells of open range in front of it, the
// mortar throws its cap into empty sky, and the battery has somewhere to go.
function rangeScene(): void {
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
  R("Wall", 20, 688, 1260, 704); // the range floor

  // 1) THE SENTRY GUN — a hopper-fed cannon on a tower, clone-triggered,
  //    raining sand onto a castle downrange. THE CASTLE IS 150 CELLS AWAY, not
  //    the 190+ it used to stand at, because a thrown grain cannot go further
  //    than about 186: muzzle velocity is 5.6 c/t and drag takes 3% a tick, so
  //    the horizontal reach converges on 5.6/0.03 whatever the tower height —
  //    measured 184 from a deck at y=477 and 184 again from y=400. The old
  //    castle sat outside that and was never once hit.
  //    The hopper's inner wall stops short so the sand walks along the deck
  //    into the breech (suction reaches 4 cells) instead of burying the trigger.
  R("Wall", 66, 400, 134, 402); // the deck
  R("Wall", 66, 402, 72, 687); // legs, so the tower reads as a tower
  R("Wall", 128, 402, 134, 687);
  R("Wall", 66, 357, 68, 400); // hopper outer wall
  R("Wall", 84, 357, 86, 389); // hopper inner wall: stops short of the deck
  R("Sand", 69, 361, 83, 399); // the magazine
  for (let y = 391; y <= 399; y++) for (let x = 88; x <= 96; x++) world.paint(x, y, byName("Cannon"), 0);
  R("Wall", 84, 372, 112, 378); // a canopy over the breech, because the mortar
  // downrange rains its cap across the whole floor and a trigger with debris on
  // top of it stops emitting: without this the gun fired anywhere between 5 and
  // 133 rounds a run, and the suite caught it as a flaky gate
  world.paint(92, 390, byName("Clone"), byName("Spark")); // pre-programmed: a
  // clone painted with a species in its aux byte IS that emitter from tick one,
  // with no primer cell to fall, flood, corrode or expire before it is read
  // the castle, standing in the impact zone. WALL towers, not stone: stone is a
  // POWDER (density 90), and the stone-built castle slumped into two cones
  // inside a hundred ticks, stranding its glass caps in mid-air above the
  // rubble where nothing could ever hit them.
  // The near tower is capped with LOOSE POWDER rather than glass, because that
  // is the damage this range can actually show: a ballistic grain hands 7/8 of
  // its momentum into packed powder, so every hit splashes the cap, while glass
  // takes a sand strike without a mark (shards come from overpressure, not from
  // impact — the first build here shelled a glass cap 700 ticks for nothing).
  R("Wall", 176, 560, 202, 687);
  R("Powder", 176, 516, 202, 558); // the cap that answers back
  R("Wall", 206, 620, 250, 687); // the curtain wall between them
  R("Powder", 208, 590, 248, 618);
  R("Wall", 254, 560, 280, 687);
  R("Glass", 254, 524, 280, 558); // the far tower keeps its glass roof

  // 2) THE MORTAR — one big timed shot. The fuse runs in a tunnel under the
  //    pit floor (an open run gets cut by cap spill), the torch lights it by
  //    contact, and the stone cap goes up through 500 cells of nothing.
  R("Wall", 330, 640, 340, 687);
  R("Wall", 392, 640, 402, 680); // right wall stops short: the fuse tunnel
  R("Fuse", 392, 686, 402, 686); // ELEVEN CELLS, not the 74 this started with.
  // A fuse burn dies out stochastically and a long lead is a coin flip: the
  // 74-cell version failed in the suite with all 1,150 cells of charge intact,
  // having fired perfectly in the run before it. Short lead, torch behind it —
  // the same fix that took the doomsday magazine from 0 in 10 to 10 in 10.
  R("Bomb", 342, 664, 391, 687); // the charge sits against the fuse end
  R("Torch", 403, 682, 409, 687);
  R("Stone", 326, 600, 406, 662); // the cap it throws

  // 3) THE NITRO ANVIL — clones drip nitro onto a grate over a magma bath. At
  //    500° every drop goes off the moment it lands, so this is a detonation
  //    every few seconds, for ever, with the gravel banks it throws in view.
  //    The priming cell is SEALED against the clone face: loose nitro
  //    disperses away before the clone can memorise it.
  R("Wall", 470, 620, 480, 687);
  R("Wall", 610, 620, 620, 687);
  R("Magma", 481, 680, 609, 687);
  R("Wall", 481, 676, 609, 679); // the anvil
  R("Stone", 481, 640, 530, 675); // gravel banks, thrown on every shot
  R("Stone", 560, 640, 609, 675);
  R("Wall", 544, 419, 545, 419);
  R("Wall", 545, 420, 545, 421);
  R("Wall", 544, 421, 544, 421);
  world.paint(544, 420, byName("Nitro"));
  world.paint(543, 420, byName("Clone"));
  world.paint(542, 420, byName("Clone"));

  // 4) THE VAULT BREACH — thermite on an ember bed burns down through a metal
  //    lid and quenches in the tank underneath. The torch is EMBEDDED beside
  //    the bed at bed level: flames rise, so an igniter above it lights nothing.
  R("Metal", 660, 560, 840, 568); // the lid
  R("Metal", 660, 568, 670, 687);
  R("Metal", 830, 568, 840, 687);
  R("Water", 671, 600, 829, 687);
  R("Torch", 692, 548, 698, 558);
  R("Charcoal", 699, 548, 808, 558);
  R("Thermite", 710, 508, 796, 547);

  // 5) THE DEPTH-CHARGE TANK — a clone drips sodium into deep water. Each lump
  //    floats (density 28 against water's 30), tears the water apart into lye
  //    and hydrogen at +70°, and routinely crosses hydrogen's 480° autoignition
  //    — so the tank keeps detonating its own gas. WALL, not glass: the gas it
  //    makes bursts a glass tank, and a burst tank drains.
  R("Wall", 880, 460, 890, 687);
  R("Wall", 1000, 460, 1010, 687);
  R("Water", 891, 520, 999, 687);
  R("Wall", 936, 464, 941, 465); // rain hat
  R("Wall", 936, 466, 936, 473);
  R("Wall", 937, 473, 937, 473); // ledge — a powder primer falls without one
  R("Sodium", 937, 466, 937, 472); // primer face
  R("Clone", 938, 466, 938, 472);

  // 6) THE BALL MORTAR — the hand-built cannon the engine notes are proudest
  //    of: a wall barrel, a powder charge, and a rigid ball as the shot, which
  //    goes up around 200 cells and comes back down through the whole frame.
  //    THE BORE IS 18 WIDE because the ball is r=7 and anything under about 16
  //    WEDGES it — the shot then judders in place and never leaves. Packed
  //    powder slugs jam the same way, which is why the projectile is an object.
  //    (This replaced a fireworks battery, which measured anywhere between 4
  //    and 46 launches across identical builds — too stochastic to gate, and
  //    the sandbox already ships one.)
  R("Wall", 1140, 420, 1149, 687);
  R("Wall", 1168, 420, 1177, 687);
  R("Gunpowder", 1150, 656, 1167, 687);
  objects.spawn("ball", 1158, 640);
  // and NO FUSE AT ALL: a torch pocket carved into the slab, lighting the
  // charge through the breech floor. Two fuse trains were tried here first — a
  // 50-cell lead and then a 19-cell one backed by a torch — and both died out
  // partway, which is the stochastic burn failure this project has already been
  // bitten by twice. A torch only keeps re-lighting a neighbour while that
  // neighbour is still fuse; once it has burnt through there is nothing left to
  // relight. Contact ignition on the charge itself cannot fail.
  carve(1152, 688, 1164, 694);
  R("Torch", 1152, 688, 1164, 694);

  player.place(1040, 680);

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
  // THE MAGAZINE'S OWN IGNITER. The 233-cell train from the volcano's foot is
  // set dressing: measured, a run that long never arrives, and even a 12-cell
  // lead only fired 3 times in 5 — the burn dies out stochastically, which is
  // why this demo's centrepiece had been silent for days. A torch re-lights its
  // neighbour every tick, so backing a SHORT lead with one turns a coin flip
  // into 5 runs out of 5, at t≈63.
  carve(566, 691, 566, 693);
  R("Torch", 566, 691, 566, 693);
  R("Fuse", 600, 689, 600, 693);
  R("Fuse", 694, 661, 694, 693); // riser up between the vat legs
  R("Torch", 338, 684, 340, 688); // set dressing — ignition is direct:
  // the igniter must be BOXED: open-air fire rises away from a downward fuse
  // before it can light it, so sleeve the top of the riser in wall
  R("Wall", 341, 680, 343, 680);
  R("Wall", 341, 681, 341, 689);
  R("Wall", 343, 681, 343, 689);
  world.paint(342, 681, byName("Fire")); // trapped: can only burn downward

  // THE MOUNTAIN — a SOLID cone, not the pair of diagonal sticks this was.
  // The old volcano was two 4-cell-wide lines with a bowl between them: at any
  // distance it read as a wireframe triangle, and its "scree" was two small
  // heaps at the foot. Wall is free to stand still — an immovable solid never
  // updates — so the cone is filled, and only what happens ON it costs anything.
  const face = (y: number) => 180 + Math.round((y - 200) * 0.3); // the right slope
  for (let y = 200; y <= 690; y++) {
    const w = Math.round((y - 200) * 0.3);
    R("Wall", 180 - w, y, 180 + w, y);
  }
  R("Stone", 40, 640, 120, 660); // scree the flow can remobilise
  // the crater: a bowl carved back out of the summit, with a low notch on the
  // right so the melt overflows towards the town instead of pooling
  carve(150, 200, 214, 252);
  R("Wall", 150, 252, 214, 258); // the bowl floor the primer pool rests on
  carve(206, 214, 232, 252); // the outlet notch
  // THE VENT — one cell wide, pool against its left face, open air on its
  // right. A 2-wide pillar splits into a primed-but-blocked column and an
  // open-but-unprimed one, and a clone buried in its own pool is smothered.
  R("Clone", 185, 236, 185, 251);
  R("Magma", 177, 236, 184, 251); // primes the whole pillar height
  // A LAVA CHANNEL cut into the right flank, because a thin flow on a cold
  // slope freezes before it gets anywhere. Heaters every 60 rows keep it molten
  // the whole way down, and the groove keeps it in one bright line.
  for (let y = 253; y <= 686; y++) carve(face(y) - 20, y, face(y) - 4, y);
  for (let y = 290; y <= 660; y += 30) R("Heater", face(y) - 18, y, face(y) - 14, y + 3);
  carve(348, 696, 388, 697); // warm approach under the ground slab
  R("Heater", 348, 696, 388, 697);
  // DRY ICE on a ledge in the flank: the flow sublimates it into a CO2 flood
  // that rolls downslope into the burning town, a smother wave arriving at an
  // inferno. Carved into the cone rather than perched on a shelf in the air.
  carve(120, 470, 210, 520);
  R("Wall", 120, 520, 210, 526);
  R("Dry ice", 124, 480, 206, 519);

  // THE TOWN: three buildings instead of five, with walls you can see. The
  // magazine sits under the middle one, and its pit, fuse and igniter are
  // untouched from the build that finally fired 10 times out of 10.
  const house = (x0: number, w: number) => {
    R("Wood", x0, 600, x0 + 9, 689);
    R("Wood", x0 + w - 9, 600, x0 + w, 660); // right wall stops high = door gap
    R("Wood", x0, 590, x0 + w, 600); // roof
  };
  house(400, 92); house(536, 108); house(690, 78);
  R("Oil", 415, 660, 480, 689); // house 1: oil on the floor
  R("Wall", 546, 660, 548, 690); // magazine pit under house 2
  R("Wall", 602, 660, 604, 690);
  R("Wall", 549, 660, 573, 662); // pit roof, gap at 574-576 for the fuse
  R("Wall", 577, 660, 601, 662);
  R("Gunpowder", 549, 664, 601, 688); // ~1,300 cells: the big one
  R("Wax", 700, 640, 760, 689); // house 3: wax stock (melts, floods, burns)
  R("Tar", 492, 686, 528, 689);
  R("Tar", 640, 686, 684, 689);
  R("Gold", 526, 640, 540, 689); // the monument that outlives the siege

  // NITRO VAT on legs beside the town — radiant heat from the burning houses
  // sets it off, which chains the second mega-boom
  R("Wall", 782, 620, 792, 690);
  R("Wall", 838, 620, 848, 690);
  R("Wall", 792, 656, 809, 662); // tub floor, with the fuse gap at 810-812
  R("Wall", 813, 656, 838, 662);
  R("Fuse", 811, 640, 811, 662); // wick through the gap, into the charge
  R("Nitro", 793, 620, 837, 655);

  // THE LAKE: quenches whatever reaches it
  R("Wall", 880, 620, 890, 690);
  R("Wall", 1010, 620, 1020, 690);
  R("Water", 891, 640, 1009, 689);

  // THE FORTRESS: a solid keep with a battery on the roof, shelling LEFT into
  // the smoke. Stone is a powder and slumps, so the keep is wall.
  R("Wall", 1080, 420, 1180, 689);
  R("Wall", 1060, 400, 1200, 420); // the gun deck, overhanging both ways
  R("Wall", 1064, 350, 1070, 400); // hopper outer wall
  R("Wall", 1088, 350, 1094, 390); // hopper inner wall, stopping short
  R("Stone", 1071, 356, 1087, 399); // the shot supply
  for (let y = 391; y <= 399; y++) for (let x = 1096; x <= 1104; x++) {
    world.paint(x, y, byName("Cannon"), 128); // aimed LEFT, over the town
  }
  world.paint(1100, 390, byName("Clone"), byName("Spark")); // pre-programmed

  // sky, life, witness
  R("Cloud", 880, 130, 950, 140); // small: a 150-wide cloud rains a blue
  // curtain down the middle of the frame and upstages the mountain
  for (const [bx, by] of [[600, 300], [700, 360], [820, 280], [500, 400]]) {
    world.paint(bx, by, byName("Bird"), 1);
  }
  R("Ant", 900, 684, 960, 688);
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

// #alchemy: the reactive shelf, staged as six vignettes instead of nine
// stations. Cut in the restaging: the rocket-candy mill (milling is a colour
// change and reads as nothing), the phosphorus vault (a two-cell flash), and
// the acid-rain terrace, which the cryo works already does better with a fan
// and a cloud. What is left got the room the reactions needed.
function alchemyScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 20, 688, 1260, 704); // the bench

  // 1) THE SODIUM POOL — a clone drips alkali metal into deep water from well
  //    above the surface, so you watch each lump fall, float (density 28
  //    against water's 30 — real alkali-metal storage), and tear the water into
  //    lye and hydrogen at +70°, which routinely crosses hydrogen's 480°
  //    autoignition. The pool detonates its own gas, over and over.
  //    WALL, not glass: the hydrogen would burst a glass tank.
  R("Wall", 40, 430, 50, 687);
  R("Wall", 220, 430, 230, 687);
  R("Water", 51, 510, 219, 687);
  R("Wall", 130, 434, 135, 435); // rain hat keeps the primer seated
  R("Wall", 130, 436, 130, 443);
  R("Wall", 131, 443, 131, 443); // ledge — a powder primer falls without one
  R("Sodium", 131, 436, 131, 442); // primer face
  R("Clone", 132, 436, 132, 442); // open to the right: that is where it drips

  // 2) ELEPHANT TOOTHPASTE — rust catalyst bed, peroxide charge, soap cap, and
  //    an OPEN TOP: the whole point is the eruption, and a lid would both hide
  //    it and pressurise the tube. The catalyst survives the row, so it keeps
  //    working the peroxide down for as long as there is peroxide.
  R("Wall", 250, 380, 260, 687);
  R("Wall", 420, 380, 430, 687);
  R("Rust", 261, 664, 419, 687);
  R("Peroxide", 261, 592, 419, 663); // every cell of this becomes a gas that
  R("Soapy", 261, 552, 419, 591); // never settle-sleeps, so keep the dose sane

  // 3) THE CARBIDE LAMP — a clone drips carbide into water, the acetylene it
  //    makes rises through a throat in the roof, and the torch above the throat
  //    keeps it lit: a permanent flame jet, running on a miner's lamp reaction.
  //    (The lime it also makes sinks and banks up on the tank floor.)
  R("Wall", 450, 430, 460, 687);
  R("Wall", 610, 430, 620, 687);
  R("Water", 461, 560, 609, 687);
  R("Wall", 460, 430, 520, 436); // the roof, with its throat at 521-549
  R("Wall", 550, 430, 610, 436);
  R("Wall", 528, 444, 533, 445); // rain hat
  R("Wall", 528, 446, 528, 453);
  R("Wall", 529, 453, 529, 453); // ledge
  R("Carbide", 529, 446, 529, 452); // primer face
  R("Clone", 530, 446, 530, 452);
  R("Torch", 526, 408, 544, 424); // the lamp flame, above the gas gap

  // 4) THE BREWERY — sugar and yeast in interleaved beds so every grain has a
  //    partner to react with; the alcohol pools in the bottom of the vat and
  //    the CO2 goes up and out. Nothing that burns is anywhere near it, which
  //    matters: alcohol ignites at 300°.
  R("Wall", 640, 440, 650, 687);
  R("Wall", 820, 440, 830, 687);
  for (let i = 0; i < 8; i++) R(i % 2 ? "Sugar" : "Yeast", 651, 520 + i * 20, 819, 539 + i * 20);

  // 5) THE NEVER-MIX CABINET — acid into bleach is the household accident:
  //    chlorine comes off the tray, rolls down the cabinet, and a lye bed on
  //    the floor turns it back into bleach. The acid is a GRAVITY FEED, not a
  //    clone dripper, because acid corrodes clones and eats its own emitter.
  R("Wall", 850, 420, 860, 687);
  R("Wall", 1020, 420, 1030, 687);
  R("Wall", 861, 560, 990, 566); // the tray, with an open lip at the right
  R("Bleach", 861, 520, 984, 559);
  R("Wall", 900, 440, 906, 500); // the burette
  R("Wall", 940, 440, 946, 500);
  R("Wall", 906, 494, 918, 500);
  R("Wall", 921, 494, 940, 500); // its drain is the slot at 919-920
  R("Acid", 907, 446, 939, 493);
  R("Lye", 861, 660, 1019, 687); // the bed that recovers it

  // 6) THE MAGNESIUM PYRE — a white-hot ember bed on a grate just over water.
  //    The steam it raises strips the metal into magnesia and hydrogen, which
  //    is why you never hose a magnesium fire, and the spur slumping into the
  //    pool puts the reaction where it can be seen. The torch is EMBEDDED at
  //    bed level: flames rise, so an igniter above the bed lights nothing.
  R("Wall", 1050, 480, 1060, 687);
  R("Wall", 1240, 480, 1250, 687);
  R("Water", 1061, 620, 1239, 687);
  R("Wall", 1080, 610, 1220, 616); // the grate
  R("Torch", 1082, 596, 1090, 609);
  R("Magnesium", 1091, 566, 1210, 609);
  R("Magnesium", 1063, 618, 1078, 646); // the spur in the splash zone

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

// #cryo: the cryogenic works — six vignettes. The gallium bridge sabotage came
// out in the restaging: it is a one-shot, and a demo that has already run its
// one shot before you look at it is a photograph, not an exhibit.
function cryoScene(): void {
  world.clear();
  player.remove();
  objects.clear();
  fighters.length = 0;
  const R = (name: string, x0: number, y0: number, x1: number, y1: number) => {
    const id = byName(name);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
  };
  R("Wall", 20, 688, 1260, 704); // the works floor

  // 1) THE SALTPETER WORKS — a deep ammonia atmosphere pressed flush onto an
  //    acid pool. Saltpeter snows out of the boundary and drifts down through
  //    the acid for thousands of ticks: the renewable half of the gunpowder
  //    loop, running unattended. A clone injector cannot do this job — liquid
  //    floods the clone's only open face and smothers it — and the vessel is
  //    WALL because acid corrodes glass outright.
  R("Wall", 40, 420, 50, 687);
  R("Wall", 200, 420, 210, 687);
  R("Wall", 40, 412, 210, 420);
  R("Acid", 51, 560, 199, 687);
  R("Ammonia", 51, 421, 199, 559);

  // 2) THE POWDER PIT — a clone drips gunpowder onto an embedded torch in a
  //    stone pit. Every drop pops, for ever, and there are 400 empty rows above
  //    it now so the plume each pop throws is actually in frame.
  R("Stone", 250, 640, 420, 687);
  R("Wall", 262, 600, 272, 645); // pit walls carved into the pile
  R("Wall", 398, 600, 408, 645);
  R("Torch", 320, 628, 340, 640);
  R("Wall", 328, 494, 333, 495); // rain hat
  R("Wall", 328, 496, 328, 503);
  R("Wall", 329, 503, 329, 503); // ledge — a powder primer falls without one
  R("Gunpowder", 329, 496, 329, 502); // primer face
  R("Clone", 330, 496, 330, 502);

  // 3) THE CRYO LAKE — one massive cryogen dump freezes the surface, a heater
  //    patch melts it back from the floor, and the sheet breathes between ice
  //    and water from then on. LIQUID NITROGEN ONLY EXISTS IN BULK: a stream or
  //    a drip boils the tick it meets warm air, so this is poured, never fed.
  //    The heater is a small centre patch on purpose — a full-width one
  //    pre-warms the whole pool and the cryogen never gets a foothold.
  R("Wall", 440, 480, 450, 687);
  R("Wall", 660, 480, 670, 687);
  R("Heater", 530, 684, 580, 687);
  R("Water", 451, 540, 659, 683);
  R("Liq. N2", 500, 480, 610, 538);

  // 4) THE IODINE LAMP — a heater bed sublimates the crystals, the violet
  //    vapour climbs the chimney, the cooler-lined roof deposits it back as
  //    solid, and the crystals avalanche down onto the shelf and fall in again.
  //    A closed loop that needs nothing but the two plates.
  //    The chimney is WALL end to end: the vapour it traps pressurised a glass
  //    one and took 45 cells out of it in the first hundred ticks, and a
  //    chimney with a hole in it is a lamp that runs out of iodine. Nothing is
  //    lost by it — the frame is not what you are looking at.
  R("Wall", 690, 412, 850, 420);
  R("Wall", 690, 420, 700, 687);
  R("Wall", 840, 420, 850, 687);
  R("Heater", 701, 684, 839, 687);
  R("Iodine", 710, 640, 830, 683);
  R("Cooler", 701, 421, 839, 424);
  R("Wall", 740, 540, 800, 544); // the shelf the returning crystals pile on

  // 5) THE SMELTER — a torch bed roasts cinnabar and mercury rains through the
  //    grate into a pool below (density 200: it sinks through anything). Beside
  //    it a ROOFED sulfur burner makes SO2 — roofed because collapsing ore
  //    would otherwise bury the torch — and the flue fan lofts that dense gas
  //    up past the vines into the cloud, which rains acid back onto them.
  R("Wall", 870, 560, 880, 687);
  R("Wall", 1060, 560, 1070, 687);
  R("Wall", 886, 636, 1054, 640); // the grate the mercury drips through
  R("Torch", 890, 626, 906, 635);
  R("Cinnabar", 907, 590, 1000, 635);
  R("Wall", 1004, 620, 1040, 624); // burner roof
  R("Sulfur", 1008, 628, 1028, 635);
  R("Torch", 1030, 628, 1038, 635); // flush against the sulfur bed
  for (let y = 596; y <= 610; y++) {
    for (let x = 1044; x <= 1052; x++) world.paint(x, y, byName("Fan"), 192); // blow up
  }
  R("Vine", 1056, 520, 1059, 687);
  R("Cloud", 900, 430, 1040, 444);

  // 6) DRY ICE vs THE PYRE — the burning stack's own heat sublimates the ledge
  //    of dry ice above it, the CO2 flood drops onto the fire and smothers it,
  //    and the embedded torch lights it again. Neither side can win, which is
  //    the only way a fire exhibit runs for longer than its fuel.
  R("Wall", 1090, 688, 1250, 692);
  R("Wood", 1120, 620, 1220, 687);
  R("Torch", 1122, 676, 1130, 687); // embedded: relights after every smother
  R("Wall", 1100, 540, 1240, 546); // the ledge
  R("Dry ice", 1110, 500, 1230, 538);

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

// #boiler: the pressure works — five vessels, every one of them failing. This
// is the one scene where glass is the RIGHT material everywhere: rupture is the
// exhibit, and glass is what ruptures (into thrown shards) where wall holds.
// Restaged for height, because a vessel bursting is a vertical event and these
// used to burst into a ceiling eighty rows above them.
function boilerScene(): void {
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
  R("Wall", 20, 688, 1260, 704); // the plant floor

  // 1) THE BOILER — a clone-fed glass shell over a fierce heater. It bursts,
  //    vents its steam through the breach as a geyser, gets refilled by the
  //    clone, and does the whole thing again. The only self-repairing failure
  //    on the floor, and the reason the water feed is here at all.
  R("Glass", 60, 400, 70, 687);
  R("Glass", 230, 400, 240, 687);
  R("Glass", 60, 392, 240, 400);
  R("Heater", 110, 680, 190, 687); // half the floor: a full-width plate boils
  R("Water", 71, 560, 229, 679); // the shell dry faster than any feed refills it
  const feed = (cx: number) => {
    R("Wall", cx - 2, 404, cx + 1, 405); // rain hat
    R("Wall", cx - 2, 406, cx - 2, 413);
    R("Wall", cx - 1, 413, cx - 1, 413); // ledge — a liquid primer falls without one
    R("Water", cx - 1, 406, cx - 1, 412); // primer face
    R("Clone", cx, 406, cx, 412);
  };
  feed(110);
  feed(180);

  // 2) THE TANK FARM — three sealed propane tanks in a row. A heater embedded
  //    under the first slow-cooks it until thermal expansion pops the shell,
  //    the escaping vapour finds the pilot light between the tanks, and the
  //    fireball takes the row. The heater is carved INTO the floor slab: paint
  //    fills empty only, so it has to be cut in, not laid on.
  const tank = (x0: number, pilot: boolean) => {
    R("Glass", x0, 560, x0 + 10, 687);
    R("Glass", x0 + 90, 560, x0 + 100, 687);
    R("Glass", x0, 552, x0 + 100, 560);
    // the pilot goes IN, before the fill (paint fills empty only). Two outside
    // placements were measured first and neither ever lit: a floor-level flame
    // six cells from the tank, and one sitting on the lid. The tank does burst
    // — 963 cells of glass gone by t400 against 5.0 of overpressure — but a
    // heavy gas pools where it is and the breach never points at the flame.
    if (pilot) R("Torch", x0 + 40, 584, x0 + 60, 596);
    R("Propane", x0 + 11, 580, x0 + 89, 687);
  };
  tank(280, true); tank(400, false); tank(520, false);
  carve(282, 688, 378, 694); // the cooker spans the whole tank floor: a narrow
  R("Heater", 282, 688, 378, 694); // patch under a big tank never gets there
  // AND A CHAIN, which this row has claimed in its own comments since M5i and
  // never actually had: the neighbours only ever burst on their own clocks and
  // their vapour never met a flame. The crossover has to be at POOL LEVEL — a
  // duct across the tank tops carried nothing at all, because propane is a
  // heavy gas and sits on the floor of its vessel. Cut low, the three pools are
  // one pool, and the first tank's fire runs the whole row.
  const crossover = (xa: number, xb: number) => {
    carve(xa, 656, xb, 678); // through both shells and the gap between them
    R("Wall", xa, 650, xb, 656); // roofed, or the pool just pours out
    R("Wall", xa, 678, xb, 684);
  };
  crossover(370, 410);
  crossover(490, 530);

  // 3) THE FIREDAMP MINE — a gallery with a methane pocket under its roof, pit
  //    props leading in, and a miner's torch at the far end. The flame crawls
  //    up the timber into the gas. The ants are the shift.
  R("Wall", 650, 520, 900, 528); // roof
  R("Glass", 700, 520, 740, 528); // skylights, so the blast has something to do
  R("Glass", 820, 520, 860, 528);
  R("Wall", 650, 528, 662, 687);
  R("Wall", 888, 528, 900, 687);
  // The lamp hangs UNDER THE ROOF, in the pocket itself, and a clone at the far
  // end keeps feeding gas in: fill, flash, fill again. The first build put the
  // torch on the floor at the end of a line of pit props and trusted the fire
  // to climb — it never did. Wood chars, and char smothers its own flame, so a
  // timber fuse burns 34 cells' worth and stops 50 rows short of the gas.
  R("Torch", 872, 529, 886, 545);
  R("Methane", 668, 529, 871, 570);
  R("Wall", 663, 529, 663, 535); // the feeder, hard against the roof so the gas
  R("Methane", 664, 529, 664, 535); // primer cannot rise away from the clone
  R("Clone", 665, 529, 665, 535);
  R("Wood", 840, 620, 887, 687); // pit props
  R("Ant", 680, 676, 760, 687); // the shift

  // 4) THE CELLAR — carboys of three sizes, each fermenting on its own clock,
  //    so they let go one after another instead of all at once.
  const carboy = (x0: number, w: number, h: number) => {
    R("Glass", x0, 688 - h, x0 + 8, 687);
    R("Glass", x0 + w - 8, 688 - h, x0 + w, 687);
    R("Glass", x0, 680 - h, x0 + w, 688 - h);
    for (let i = 0; i < 6; i++) {
      R(i % 2 ? "Sugar" : "Yeast", x0 + 9, 688 - h + 20 + i * 12, x0 + w - 9, 688 - h + 31 + i * 12);
    }
  };
  carboy(930, 70, 150); carboy(1010, 90, 210); carboy(1110, 60, 120);

  // 5) THE DRY-ICE FLASK — a sealed flask, no flame anywhere near it. Room
  //    warmth alone sublimates the solid and the CO2 does the rest.
  R("Glass", 1180, 560, 1190, 687);
  R("Glass", 1240, 560, 1250, 687);
  R("Glass", 1180, 552, 1250, 560);
  R("Dry ice", 1191, 620, 1239, 687);

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

// #cannon: the pressure gunnery range. Five guns, all driven by the pressure
// field, all with 400 rows of sky over the muzzle — the point of a gun is where
// the shot goes, and these used to fire into a ceiling.
// EVERY BORE IS 18 WIDE because the ball is r=7 and anything under about 16
// WEDGES it: the shot then oscillates in place and never leaves the barrel.
// Ignition is a torch pocket carved into the slab under each charge, not a fuse
// train — fuse burns die out stochastically, and two of them died mid-run while
// this pass was being built.
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
  R("Wall", 20, 688, 1260, 704); // the range floor — also every gun's breech

  // a barrel: walls 15 wide, bore 18, breech on the slab itself. Painting the
  // charge at y+1 instead lands it inside the wall and silently no-ops.
  const barrel = (x0: number, topY: number) => {
    R("Wall", x0, topY, x0 + 14, 687);
    R("Wall", x0 + 33, topY, x0 + 47, 687);
  };
  const bore = (x0: number) => x0 + 23; // the centreline

  // 1) THE PNEUMATIC MORTAR — no explosive anywhere: a heater, a head of water,
  //    and the ball's own body sealing the bore. Boil it and the shot leaves.
  barrel(60, 260);
  R("Heater", 75, 684, 92, 687);
  R("Water", 75, 650, 92, 683);
  objects.spawn("ball", bore(60), 630);

  // 2) THE POWDER CANNON — the same barrel with a charge instead of a boiler,
  //    lit through the breech floor.
  barrel(200, 260);
  R("Gunpowder", 215, 650, 232, 687);
  objects.spawn("ball", bore(200), 630);
  carve(216, 688, 231, 694);
  R("Torch", 216, 688, 231, 694);

  // 3) THE STEAM FOUNTAIN — the only gun here that reloads itself: a clone
  //    re-drips water onto the hot plate, so the chamber keeps re-pressurising
  //    and keeps throwing its sand charge, for as long as you watch it.
  barrel(340, 260);
  R("Heater", 355, 684, 372, 687);
  R("Water", 355, 668, 372, 683);
  R("Sand", 355, 630, 372, 666); // the charge it throws, over and over
  R("Wall", 361, 588, 364, 589); // rain hat
  R("Wall", 361, 590, 361, 597);
  R("Wall", 362, 597, 362, 597); // ledge — a liquid primer falls without one
  R("Water", 362, 590, 362, 596); // primer face
  R("Clone", 363, 590, 363, 596);

  // 4) THE LESSON — identical charges, one barrel OPEN and one CAPPED, side by
  //    side and lit together. The open one fires its shot; the capped one has
  //    nowhere to vent and bursts its own lid. The cap is deliberately STUBBY:
  //    a lid 250 cells up a bore never sees the charge's pressure at all.
  barrel(480, 260);
  R("Gunpowder", 495, 650, 512, 687);
  objects.spawn("ball", bore(480), 630);
  carve(496, 688, 511, 694);
  R("Torch", 496, 688, 511, 694);

  R("Wall", 620, 600, 634, 687);
  R("Wall", 653, 600, 667, 687);
  R("Gunpowder", 635, 650, 652, 687);
  R("Glass", 635, 600, 652, 612); // the cap that has to give
  carve(636, 688, 651, 694);
  R("Torch", 636, 688, 651, 694);

  // 5) THE JET VENT — a sealed boiler with ONE nozzle punched through its wall.
  //    Everything it makes leaves there, as a working jet that sweeps the dune
  //    downrange all session. Pressure vents through openings by connectivity
  //    to the border, so one hole makes a beam and not a leak.
  R("Wall", 760, 480, 774, 687);
  R("Wall", 900, 480, 914, 687);
  R("Wall", 760, 472, 914, 480);
  R("Heater", 810, 684, 870, 687); // a narrower plate: a full-floor heater
  R("Water", 775, 600, 899, 683); // boils the shell dry and the jet dies with it
  const wfeed = (cx: number) => {
    R("Wall", cx - 2, 508, cx + 1, 509); // rain hat
    R("Wall", cx - 2, 510, cx - 2, 517);
    R("Wall", cx - 1, 517, cx - 1, 517); // ledge — a liquid primer falls without one
    R("Water", cx - 1, 510, cx - 1, 516); // primer face
    R("Clone", cx, 510, cx, 516);
  };
  wfeed(800);
  wfeed(870);
  carve(900, 652, 914, 660); // the nozzle: LOW, so the jet works along the dune
  // instead of over it, and NARROW, because the wind that launches loose matter
  // comes from a steep pressure gradient and a wide hole does not make one
  R("Sand", 920, 656, 1200, 687); // the dune, right up against the nozzle: at
  // 46 cells of standoff the jet only shifted 105 grains in 900 ticks
  R("Wall", 1230, 600, 1250, 687); // a backstop, so the sand has somewhere to go

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

// #machines: a PRODUCTION LINE, not a row of machines. Every other demo here is
// a set of exhibits standing side by side; this one is a single chain, and each
// stage exists because the stage before it fired. Silo -> ramp -> trip plate ->
// gun -> furnace, with the spill from the line feeding a bin whose level sensor
// reaches all the way back and shuts the silo down. Watch it left to right.
//
// WIRING LAWS, all of them earned by a stage of this line doing nothing:
//  - a VALVE opens only at the cell the spark touches, so the drip lands at the
//    WIRE'S END, not under the middle of the gate;
//  - a wire painted through existing structure is severed (paint fills empty),
//    so signal runs are CARVED first;
//  - diagonal is not connected, and a wire that stops one cell short is a wire
//    that stops;
//  - a detector emits into an EMPTY cell, so it needs a gap between it and its
//    wire — put the wire on the gap and the sensor goes silent;
//  - a sensor has to sit where the material actually lands, not where the
//    drawing says the pile should be;
//  - powders need a 1:1 slope to travel; at 0.6 they bank up and stop.
function machinesScene(): void {
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
  R("Wall", 20, 688, 1260, 704);

  // 1) THE SILO — a clock meters sand out. The gate opens at its right-hand end
  //    because that is the cell the wire touches, so the stream falls there.
  R("Wall", 80, 120, 86, 199);
  R("Wall", 140, 120, 146, 199);
  R("Valve", 87, 200, 139, 200);
  R("Sand", 87, 130, 139, 199);
  R("Copper", 140, 200, 180, 200);
  world.paint(181, 200, byName("Clock"), byName("Spark"));

  // 2) THE RAMP — 1:1, because a shallower one is just a shelf: at 0.6 the sand
  //    banked up at the head and the line never started.
  for (let s = 0; s <= 120; s++) R("Wall", 130 + s, 260 + s, 133 + s, 264 + s);

  // 3) THE TRIP PLATE — at the ramp's FOOT, where the sand actually arrives.
  //    Its spark gap is roofed and the wire starts one cell further on.
  R("Wall", 250, 390, 350, 396);
  world.paint(256, 389, byName("Detector"), byName("Sand"));
  R("Wall", 257, 388, 257, 388);
  R("Copper", 258, 389, 350, 389);
  R("Wall", 258, 388, 350, 388);
  carve(351, 390, 351, 396); // the conduit down to the gun, carved not painted
  R("Copper", 351, 389, 351, 453);
  R("Copper", 352, 453, 416, 453);

  // 4) THE GUN — every trip fires a round of powder downrange. The signal comes
  //    up through the deck INSIDE the barrel's own span, so it reaches the
  //    breech row; a wire alongside the deck never touches the cannon at all.
  R("Wall", 380, 450, 424, 452);
  carve(416, 450, 416, 452);
  R("Copper", 416, 450, 416, 452);
  R("Wall", 380, 407, 386, 450);
  R("Wall", 404, 407, 410, 439); // inner wall stops short: the powder walks in
  R("Gunpowder", 387, 411, 403, 449);
  for (let y = 441; y <= 449; y++) for (let x = 412; x <= 420; x++) {
    world.paint(x, y, byName("Cannon"), 0);
  }

  // 5) THE FURNACE — the bed the rounds land on. Contact ignition, so every
  //    shot that arrives goes off, and the line reads as a working gun.
  R("Wall", 470, 560, 640, 566);
  R("Torch", 480, 548, 630, 559);
  // and what the furnace is FOR: its heat runs a thermite hearth that pours
  // melt off both ends into the quench tank underneath
  R("Wall", 700, 470, 706, 520);
  R("Wall", 800, 470, 806, 520);
  R("Wall", 700, 520, 806, 526);
  R("Torch", 707, 508, 715, 519);
  R("Charcoal", 716, 508, 799, 519);
  R("Thermite", 720, 478, 790, 507);
  R("Wall", 660, 600, 666, 687);
  R("Wall", 860, 600, 866, 687);
  R("Water", 667, 630, 859, 687);

  // 6) THE SPILL BIN — the line is not tidy: what misses the plate falls past
  //    it, and this catches it. Its level sensor runs all the way back to the
  //    silo through an INVERTER, so the line shuts itself down when the waste
  //    bin fills. That return wire is the only thing here that runs right to
  //    left, and routing it is the fiddliest part of the whole scene: the first
  //    attempt went straight up through the ramp, where the copper stood on the
  //    slope as a DAM and stopped the line dead at 134 grains.
  R("Wall", 200, 620, 206, 687);
  R("Wall", 300, 620, 306, 687);
  world.paint(260, 640, byName("Detector"), byName("Sand"));
  R("Wall", 259, 639, 259, 639); // roof over the gap at (259,640)
  R("Copper", 207, 640, 258, 640);
  carve(200, 640, 206, 640); // conduit out through the bin wall
  R("Copper", 200, 640, 206, 640);
  // and home OVER THE TOP. Two earlier routes killed the line outright: one
  // went up through the ramp, where the copper stood on the slope as a dam
  // (134 grains and stop), and one ran along y=206, five cells under the
  // silo's own discharge, so the drip landed on the wire and packed back up
  // into the gate. A signal run is a solid wall as far as the material is
  // concerned — route it where nothing falls.
  R("Copper", 61, 640, 199, 640);
  R("Copper", 61, 110, 61, 640);
  R("Copper", 62, 110, 189, 110);
  R("Copper", 189, 111, 189, 199);
  world.paint(189, 200, byName("Inverter"), 128); // output LEFT, onto the bus
  R("Copper", 182, 200, 188, 200);

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

if (location.hash.startsWith("#demo")) demoScene();
else if (location.hash.startsWith("#chem")) chemScene();
else if (location.hash.startsWith("#range")) rangeScene();
else if (location.hash.startsWith("#doom")) doomScene();
else if (location.hash.startsWith("#alchemy")) alchemyScene();
else if (location.hash.startsWith("#cryo")) cryoScene();
else if (location.hash.startsWith("#boiler")) boilerScene();
else if (location.hash.startsWith("#cannon")) cannonScene();
else if (location.hash.startsWith("#machines")) machinesScene();

// ---- in-page self test ----------------------------------------------------
// The other half of the suite. tools/apptest.ts covers everything that runs
// without a DOM; these are the cases that need the real page — the wiring where
// this project's regressions have actually lived. Every one of them is a bug
// that shipped: dialogs pinned to the corner by a CSS reset, a demo that could
// not be reloaded, a notebook "clear" that rebuilt itself, a palette filter that
// forgot the arrow keys. Run it with granulab.selftest().
function selftest(): { passed: number; failed: number; failures: string[]; known: string[] } {
  const failures: string[] = [];
  const known: string[] = [];
  let passed = 0;
  const check = (name: string, cond: boolean, detail = ""): void => {
    if (cond) passed++;
    else failures.push(name + (detail ? ` — ${detail}` : ""));
  };
  // A defect we have found, measured and not yet fixed. It does not turn the
  // suite red — a permanently failing suite stops being read — but it is
  // reported every run, and the moment it starts passing the suite says so.
  const expectFail = (name: string, cond: boolean, detail = ""): void => {
    if (cond) failures.push(`${name} — NOW PASSES: delete the known-failure marker`);
    else known.push(name + (detail ? ` — ${detail}` : ""));
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

  // ---- the demos ---------------------------------------------------------
  // Eight showcase scenes, each encoding dozens of hard-won fixture laws, and
  // nothing guarded them — which is how the doomsday magazine came to be dead
  // for days without anyone noticing. One signature outcome each: not "does it
  // build" (it always did) but "does the thing it exists to show still happen".
  const runDemo = (name: string, ticks: number, build: () => void): void => {
    build();
    for (let i = 0; i < ticks; i++) simTick();
  };
  const n = (name: string): number => {
    const id = byName(name);
    let c = 0;
    for (let i = 0; i < world.species.length; i++) if (world.species[i] === id) c++;
    return c;
  };

  // counts inside one vignette's frame, so a gate measures the exhibit it names
  // rather than whatever else in the scene happens to make the same product
  const nIn = (name: string, x0: number, y0: number, x1: number, y1: number): number => {
    const id = byName(name);
    let c = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (world.species[y * GRID_W + x] === id) c++;
    return c;
  };

  runDemo("sandbox", 300, demoScene);
  check("the sandbox demo settles into a full scene", world.dots > 80_000, `${world.dots} dots`);
  // the beaker is the stir exhibit, and acid dissolves a GLASS one out from
  // under itself: 2,819 of 5,430 cells gone by t600, taking the acid with it
  check("sandbox: the stir beaker still holds its acid", nIn("Acid", 430, 300, 532, 470) > 2000,
    `${nIn("Acid", 430, 300, 532, 470)} acid in the beaker`);

  runDemo("chem", 600, chemScene);
  check("chem lab: the generator fills its hood with hydrogen", n("Hydrogen") > 1500, `${n("Hydrogen")}`);
  check("chem lab: the chlor-alkali cell lays down chlorine", n("Chlorine") > 1500, `${n("Chlorine")}`);
  check("chem lab: the fizz fountain floods its well with CO2",
    nIn("CO2", 250, 330, 440, 687) > 200, `${nIn("CO2", 250, 330, 440, 687)} in the well`);
  check("chem lab: the greenhouse photosynthesises oxygen", n("Oxygen") > 400, `${n("Oxygen")}`);
  check("chem lab: the kiln calcines lime", n("Lime") > 20, `${n("Lime")}`);
  check("chem lab: the thermite pour quenches into stone", n("Stone") > 300, `${n("Stone")}`);
  check("chem lab: the titration beaker is still stratified to be stirred",
    nIn("Acid", 1090, 460, 1244, 687) > 4000 && nIn("Lye", 1090, 460, 1244, 687) > 4000,
    `${nIn("Acid", 1090, 460, 1244, 687)} acid over ${nIn("Lye", 1090, 460, 1244, 687)} lye`);
  {
    // and the point of leaving it stratified: a glass rod is worth 8x the
    // interface. Same beaker, same tick count, stirred against the run above.
    const quiet = n("Salt");
    for (let pass = 0; pass < 10; pass++) for (let x = 1110; x <= 1225; x += 22) stir(x, 585, 24);
    for (let i = 0; i < 200; i++) simTick();
    const stirred = n("Salt");
    check("chem lab: stirring that beaker multiplies the neutralisation",
      stirred > quiet * 2, `${quiet} salt unstirred -> ${stirred} stirred`);
  }

  runDemo("range", 700, rangeScene);
  check("weapons range: the vault thermite lights", n("Magma") > 200, `${n("Magma")} magma`);
  // the threshold is low on purpose: a clone trigger fires on a random face at
  // a random tick, so this gun puts anywhere between 17 and 128 grains onto the
  // castle across identical runs, while a dead one manages 6 or fewer
  check("weapons range: the sentry gun reaches the castle",
    nIn("Sand", 150, 400, 320, 687) > 10, `${nIn("Sand", 150, 400, 320, 687)} grains downrange`);
  check("weapons range: the depth-charge tank tears water into hydrogen",
    n("Hydrogen") > 50, `${n("Hydrogen")}`);
  check("weapons range: the mortar throws its cap", n("Bomb") === 0 && n("Stone") > 1000,
    `${n("Bomb")} bomb left, ${n("Stone")} stone`);

  runDemo("alchemy", 600, alchemyScene);
  check("alchemy: the brewery ferments alcohol", n("Alcohol") > 400, `${n("Alcohol")}`);
  check("alchemy: elephant toothpaste evolves oxygen", n("Oxygen") > 1000, `${n("Oxygen")}`);
  check("alchemy: the never-mix cabinet releases chlorine", n("Chlorine") > 200, `${n("Chlorine")}`);
  check("alchemy: the carbide lamp keeps a flame", n("Acetylene") > 20 && n("Fire") > 50,
    `${n("Acetylene")} acetylene, ${n("Fire")} fire`);
  check("alchemy: steam strips the magnesium pyre", n("Magnesia") > 40, `${n("Magnesia")}`);

  runDemo("cryo", 600, cryoScene);
  check("cryo works: the LN2 lake freezes ice", n("Ice") > 400, `${n("Ice")}`);
  check("cryo works: the iodine lamp sublimes", n("Iodine gas") > 50, `${n("Iodine gas")}`);
  check("cryo works: the batch reactor snows saltpeter", n("Saltpeter") > 800, `${n("Saltpeter")}`);
  check("cryo works: the smelter roasts mercury out of cinnabar", n("Mercury") > 40, `${n("Mercury")}`);
  check("cryo works: the dry ice floods the pyre with CO2", n("CO2") > 400, `${n("CO2")}`);

  {
    boilerScene();
    const propane0 = n("Propane");
    const methane0 = n("Methane");
    let peakSteam = 0;
    for (let i = 0; i < 500; i++) { simTick(); peakSteam = Math.max(peakSteam, n("Steam")); }
    check("boiler room: overpressure bursts the vessels", n("Shards") > 100, `${n("Shards")} shards`);
    check("boiler room: the boiler geysers", peakSteam > 1000, `peak ${peakSteam} steam`);
    check("boiler room: the tank farm goes up",
      propane0 - n("Propane") > 3000, `${propane0} -> ${n("Propane")} propane`);
    check("boiler room: the firedamp pocket fires",
      n("Methane") < methane0 * 0.5, `${methane0} -> ${n("Methane")} methane`);
  }

  {
    cannonScene();
    let peak = 0;
    for (let i = 0; i < 900; i++) {
      simTick();
      for (const o of objects.list) peak = Math.max(peak, Math.hypot(o.vx, o.vy));
    }
    check("pressure guns: a shot is actually launched", peak > 3, `peak ${peak.toFixed(1)} c/t`);
    // the twins are the lesson: the open barrel fires, the capped one bursts
    check("pressure guns: the capped barrel bursts instead", n("Shards") > 5, `${n("Shards")} shards`);
  }

  {
    // the machines demo: the only scene here that runs on decisions rather than
    // on physics alone, so each gate asks whether a CONTROL path still works
    machinesScene();
    const silo = () => nIn("Sand", 87, 120, 139, 199);
    const silo0 = silo();
    let blastTicks = 0;
    for (let i = 0; i < 1200; i++) { simTick(); if (world.fxPower > 3) blastTicks++; }
    check("machines: the silo meters its load out", silo0 - silo() > 200,
      `${silo0 - silo()} grains released`);
    // THE END-TO-END GATE, and the reason it is one assertion rather than six:
    // a round only goes off at the furnace if the clock pulsed, the gate opened,
    // the ramp carried, the plate caught it, the sensor fired, the wire crossed
    // its carved conduit and the cannon took the shot. Any link breaks, no bang.
    check("machines: the whole line chains, silo through to the furnace",
      blastTicks > 20, `${blastTicks} ticks with a blast at the bed`);
    check("machines: the spill bin catches what the line drops",
      nIn("Sand", 207, 600, 299, 687) > 100, `${nIn("Sand", 207, 600, 299, 687)} in the bin`);
    check("machines: the thermite hearth pours", n("Magma") > 500, `${n("Magma")} magma`);
  }

  {
    doomScene();
    const before = n("Gunpowder");
    let peakFx = 0;
    for (let i = 0; i < 900; i++) { simTick(); peakFx = Math.max(peakFx, world.fxPower); }
    check("doomsday: the volcano erupts", n("Magma") > 60, `${n("Magma")} magma`);
    check("doomsday: the buried magazine detonates",
      n("Gunpowder") < before * 0.5 && peakFx > 8,
      `${before} -> ${n("Gunpowder")} gunpowder, peak blast ${Math.round(peakFx)}`);
  }

  world.clear();
  objects.clear();
  fighters.length = 0;
  player.remove();
  ui.bind("L", E.POWDER);
  ui.setPaused(wasPaused);
  const result = { passed, failed: failures.length, failures, known };
  console.log(`[granulab-selftest] ${passed} passed, ${failures.length} failed, ${known.length} known-failing`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  for (const k of known) console.log(`  known ${k}`);
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
  machines: machinesScene,
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
