// WASM engine adapter — instantiates asm/engine.ts (built to asm/build/
// engine.wasm) and exposes a DROP-IN replacement for World: the full surface
// the app touches (main.ts / objects.ts / player.ts / renderer.ts): W, H,
// species/shade/life views, step, paint, clear, serialize/deserialize (.grn
// byte-format compatible), fillWindTex/fillTempTex/fillGlowTex, fxPower,
// frame, dots, activeChunkCount, rng, blastQueue/bubbleQueue (real JS arrays
// that ObjectSystem drains with .length = 0), losClear, rawSet, windAt.
//
// Registry tables (flat typed arrays from elements.ts) are COPIED into WASM
// memory here at init — the AS module never re-derives them. The module
// preallocates everything in init() so memory never grows afterwards; views
// are still re-derived defensively if the backing buffer ever detaches.
//
// QUEUE SEMANTICS: the JS arrays are the authority. Before each step()/paint()
// the adapter syncs their lengths into WASM so the engine's caps (96 blast
// entries / 32 bubbles) see accumulated, undrained length exactly like TS;
// after the call it appends only the NEW entries. `.length = 0` drains work
// exactly as on World.

import {
  E, N_IDS, BEHAVIOR, DENSITY, DISPERSE, FLAMMABLE, BURNLIFE, LIFE0,
  EXPLODE_R, REACT, REACT_DT, HAS_REACT, CONDUCTS, HEAT_PUMP,
  TEMP0, HOT_AT, HOT_TO, COLD_AT, COLD_TO, IGNITES_AT, THERMAL,
  PH, CONDUCT_IDX, CONDUCTOR_IDS, PRESSURIZES,
  HEAT_COND, SELF_OXIDIZING, REACT_BYPRODUCT,
} from "./elements";
import { Rng } from "./rng";

const WSHIFT = 2; // wind cell = 4x4 sim cells (mirrors world.ts)
const TSHIFT = 1; // temperature cell = 2x2 sim cells

// mirrors the module-level HYST table in world.ts (settle-hysteresis liquids)
const HYST = new Uint8Array(N_IDS);
HYST[E.WATER] = HYST[E.SEAWATER] = HYST[E.OIL] = HYST[E.MERCURY] = HYST[E.MUD] = HYST[E.NITRO] = 1;
// M5i: heavy gases no longer sleep — a sleeping pool vanishes from the
// pressure census, and a calm propane room MUST still pressurize
HYST[E.SOAPY] = 1;

interface EngineExports {
  memory: WebAssembly.Memory;
  init(w: number, h: number, seed: number): void;
  paint(x: number, y: number, id: number, aux: number): void;
  step(): void;
  getFrame(): number;
  getDots(): number;
  getRngDraws(): number;
  getRngState(): number;
  activeChunkCount(): number;
  activeCurPtr(): number;
  activeNextPtr(): number;
  dbgResetSites(): void;
  dbgSite(k: number): number;
  dbgSeqEnable(): void;
  dbgSeqDisable(): void;
  dbgSeqLen(): number;
  dbgSeqPtr(): number;
  dbgValLen(): number;
  dbgValPtr(): number;
  speciesPtr(): number;
  shadePtr(): number;
  lifePtr(): number;
  clockPtr(): number;
  behaviorPtr(): number;
  densityPtr(): number;
  dispersePtr(): number;
  flammablePtr(): number;
  burnlifePtr(): number;
  life0Ptr(): number;
  explodeRPtr(): number;
  hasReactPtr(): number;
  conductsPtr(): number;
  hystPtr(): number;
  heatPumpPtr(): number;
  reactPtr(): number;
  reactDtPtr(): number;
  temp0Ptr(): number;
  hotAtPtr(): number;
  hotToPtr(): number;
  coldAtPtr(): number;
  coldToPtr(): number;
  ignitesAtPtr(): number;
  thermalPtr(): number;
  phPtr(): number;
  conductIdxPtr(): number;
  conductorIdsPtr(): number;
  cosTabPtr(): number;
  sinTabPtr(): number;
  getFxPower(): number;
  blastQueuePtr(): number;
  blastQueueLen(): number;
  bubbleQueuePtr(): number;
  bubbleQueueLen(): number;
  drainQueues(): void;
  syncQueueLens(blastLen: number, bubbleLen: number): void;
  windVxPtr(): number;
  windVyPtr(): number;
  glowPtr(): number;
  tempPtr(): number;
  pressurizesPtr(): number;
  pressPtr(): number;
  heatCondPtr(): number;
  selfOxidizingPtr(): number;
  reactByproductPtr(): number;
  airPtr(): number;
  rawSet(x: number, y: number, id: number, shade: number): void;
  losClear(x0: number, y0: number, x1: number, y1: number): number;
  clearAll(): void;
  postLoad(): void;
}

/** decode an AssemblyScript string (UTF-16, byte length at ptr-4) for abort() */
function asString(mem: WebAssembly.Memory | null, ptr: number): string {
  if (!mem || !ptr) return "";
  const len = new Uint32Array(mem.buffer)[(ptr - 4) >>> 2] >>> 1;
  return String.fromCharCode(...new Uint16Array(mem.buffer, ptr, len));
}

export class WasmWorld {
  readonly W: number;
  readonly H: number;
  readonly WX: number;
  readonly WY: number;
  readonly TW: number;
  readonly TH: number;
  /** resolves once the module is instantiated, tables copied, views built */
  readonly ready: Promise<void>;

  /** host-side rng for player/objects (World exposes its sim rng for these).
   *  NOTE: this stream is SEPARATE from the WASM engine's internal sim rng —
   *  gameplay-fine, but cross-mode (TS vs WASM) replays of object/player
   *  behavior will differ. The sim itself is bit-exact either way. */
  readonly rng: Rng;

  /** blasts as (cx, cy, r) triplets; ObjectSystem drains with .length = 0 */
  readonly blastQueue: number[] = [];
  /** soapy cells whipped into bubbles; ObjectSystem drains with .length = 0 */
  readonly bubbleQueue: number[] = [];

  species!: Uint8Array;
  shade!: Uint8Array;
  life!: Uint8Array;
  clock!: Uint8Array;
  private windVx!: Float32Array;
  private windVy!: Float32Array;
  private glowV!: Float32Array;
  private tempV!: Float32Array;
  /** M5i pressure field view (WX x WY) — QA + parity read it */
  press!: Float32Array;
  /** M5k breathable-air field view (WX x WY), 1 = open atmosphere */
  air!: Float32Array;

  private ex!: EngineExports;
  private mem: WebAssembly.Memory | null = null;
  private buf: ArrayBuffer | null = null;

  constructor(wasmBytes: BufferSource, w: number, h: number, seed = 0xc0ffee) {
    this.W = w;
    this.H = h;
    this.WX = w >> WSHIFT;
    this.WY = h >> WSHIFT;
    this.TW = w >> TSHIFT;
    this.TH = h >> TSHIFT;
    this.rng = new Rng(seed);
    this.ready = this.instantiate(wasmBytes, w, h, seed);
  }

  private async instantiate(wasmBytes: BufferSource, w: number, h: number, seed: number): Promise<void> {
    const imports = {
      env: {
        abort: (msg: number, file: number, line: number, col: number): never => {
          throw new Error(
            `wasm engine abort: ${asString(this.mem, msg)} (${asString(this.mem, file)}:${line}:${col})`,
          );
        },
      },
    };
    const { instance } = await WebAssembly.instantiate(wasmBytes as ArrayBuffer, imports);
    this.ex = instance.exports as unknown as EngineExports;
    this.mem = this.ex.memory;
    this.ex.init(w, h, seed >>> 0);
    this.copyTables();
    this.refreshViews();
  }

  /** Re-push the registry tables after a live edit (the element tuning panel).
   *  Exactly the copy init already does, run again — the sim reads these tables
   *  every tick, so nothing else has to change for a tweak to take effect. */
  refreshTables(): void {
    this.copyTables();
  }

  /** copy the elements.ts registry tables into WASM memory (init contract) */
  private copyTables(): void {
    const buf = this.ex.memory.buffer;
    const u8 = new Uint8Array(buf);
    u8.set(BEHAVIOR, this.ex.behaviorPtr());
    u8.set(DENSITY, this.ex.densityPtr());
    u8.set(DISPERSE, this.ex.dispersePtr());
    u8.set(FLAMMABLE, this.ex.flammablePtr());
    u8.set(BURNLIFE, this.ex.burnlifePtr());
    u8.set(LIFE0, this.ex.life0Ptr());
    u8.set(EXPLODE_R, this.ex.explodeRPtr());
    u8.set(HAS_REACT, this.ex.hasReactPtr());
    u8.set(CONDUCTS, this.ex.conductsPtr());
    u8.set(HYST, this.ex.hystPtr());
    new Float32Array(buf).set(HEAT_PUMP, this.ex.heatPumpPtr() >>> 2);
    new Uint32Array(buf).set(REACT, this.ex.reactPtr() >>> 2);
    new Int16Array(buf).set(REACT_DT, this.ex.reactDtPtr() >>> 1);
    // stage 2: temperature registry
    const i16 = new Int16Array(buf);
    i16.set(TEMP0, this.ex.temp0Ptr() >>> 1);
    i16.set(HOT_AT, this.ex.hotAtPtr() >>> 1);
    i16.set(COLD_AT, this.ex.coldAtPtr() >>> 1);
    i16.set(IGNITES_AT, this.ex.ignitesAtPtr() >>> 1);
    u8.set(HOT_TO, this.ex.hotToPtr());
    u8.set(COLD_TO, this.ex.coldToPtr());
    u8.set(THERMAL, this.ex.thermalPtr());
    // stage 4: conduction + litmus registry
    u8.set(PH, this.ex.phPtr());
    u8.set(PRESSURIZES, this.ex.pressurizesPtr());
    // M5k: per-material conduction, self-oxidising fuels, third products
    new Float32Array(buf).set(HEAT_COND, this.ex.heatCondPtr() >>> 2);
    u8.set(SELF_OXIDIZING, this.ex.selfOxidizingPtr());
    u8.set(REACT_BYPRODUCT, this.ex.reactByproductPtr());
    u8.set(CONDUCT_IDX, this.ex.conductIdxPtr());
    u8.set(Uint8Array.from(CONDUCTOR_IDS), this.ex.conductorIdsPtr());
    // fan trig tables: 256 quantized angles, computed HERE with the host's
    // Math.cos/sin so WASM fan beams match the TS engine bit-for-bit
    const cos = new Float64Array(buf, this.ex.cosTabPtr(), 256);
    const sin = new Float64Array(buf, this.ex.sinTabPtr(), 256);
    for (let k = 0; k < 256; k++) {
      const ang = (k / 256) * Math.PI * 2; // exact expression from stepWind
      cos[k] = Math.cos(ang);
      sin[k] = Math.sin(ang);
    }
  }

  /** (re)build the typed-array views; safe to call if memory ever grew */
  private refreshViews(): void {
    const buf = this.ex.memory.buffer;
    this.buf = buf;
    const n = this.W * this.H;
    this.species = new Uint8Array(buf, this.ex.speciesPtr(), n);
    this.shade = new Uint8Array(buf, this.ex.shadePtr(), n);
    this.life = new Uint8Array(buf, this.ex.lifePtr(), n);
    this.clock = new Uint8Array(buf, this.ex.clockPtr(), n);
    this.windVx = new Float32Array(buf, this.ex.windVxPtr(), this.WX * this.WY);
    this.windVy = new Float32Array(buf, this.ex.windVyPtr(), this.WX * this.WY);
    this.glowV = new Float32Array(buf, this.ex.glowPtr(), this.WX * this.WY);
    this.tempV = new Float32Array(buf, this.ex.tempPtr(), this.TW * this.TH);
    this.press = new Float32Array(buf, this.ex.pressPtr(), this.WX * this.WY);
    this.air = new Float32Array(buf, this.ex.airPtr(), this.WX * this.WY);
  }

  /** views detach if wasm memory grows (it shouldn't — fixed preallocation) */
  private checkViews(): void {
    if (this.buf !== this.ex.memory.buffer) this.refreshViews();
  }

  /** push JS queue lengths into WASM (cap authority) — see header */
  private syncQueues(): void {
    this.ex.syncQueueLens(this.blastQueue.length, this.bubbleQueue.length);
  }

  /** append entries the engine pushed beyond the pre-call lengths */
  private collectQueues(b0: number, u0: number): void {
    const bLen = this.ex.blastQueueLen();
    if (bLen > b0) {
      const v = new Int32Array(this.ex.memory.buffer, this.ex.blastQueuePtr(), bLen);
      for (let k = b0; k < bLen; k++) this.blastQueue.push(v[k]);
    }
    const uLen = this.ex.bubbleQueueLen();
    if (uLen > u0) {
      const v = new Int32Array(this.ex.memory.buffer, this.ex.bubbleQueuePtr(), uLen);
      for (let k = u0; k < uLen; k++) this.bubbleQueue.push(v[k]);
    }
  }

  paint(x: number, y: number, id: number, aux?: number): void {
    this.syncQueues(); // painting fire onto an explosive can blast
    const b0 = this.blastQueue.length;
    const u0 = this.bubbleQueue.length;
    this.ex.paint(x, y, id, aux === undefined ? -1 : aux);
    this.collectQueues(b0, u0);
    this.checkViews();
  }

  step(): void {
    this.syncQueues();
    const b0 = this.blastQueue.length;
    const u0 = this.bubbleQueue.length;
    this.ex.step();
    this.collectQueues(b0, u0);
    this.checkViews();
  }

  /** direct cell write for rigid-object footprints — bypasses paint rules */
  rawSet(x: number, y: number, id: number, shade = 170): void {
    this.ex.rawSet(x, y, id, shade);
  }

  /** straight line from the blast center, walls block */
  losClear(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.ex.losClear(x0, y0, x1, y1) !== 0;
  }

  windAt(x: number, y: number): [number, number] {
    const wi = (y >> WSHIFT) * this.WX + (x >> WSHIFT);
    return [this.windVx[wi], this.windVy[wi]];
  }

  /** pressure at a cell (mirrors World.pressAt — ObjectSystem reads opposite
   *  faces of an object and rides the difference) */
  pressAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return 0;
    return this.press[(y >> WSHIFT) * this.WX + (x >> WSHIFT)];
  }

  /** oxygen left where this cell stands (mirrors World.airAt) */
  airAt(x: number, y: number): number {
    return this.air[(y >> WSHIFT) * this.WX + (x >> WSHIFT)];
  }

  /** fill an RG byte buffer (128-centered) for the air-view shader */
  fillWindTex(buf: Uint8Array): void {
    const vx = this.windVx;
    const vy = this.windVy;
    for (let i = 0; i < vx.length; i++) {
      buf[i * 2] = Math.max(0, Math.min(255, 128 + vx[i] * 14)) | 0;
      buf[i * 2 + 1] = Math.max(0, Math.min(255, 128 + vy[i] * 14)) | 0;
    }
  }

  /** encode temp for the thermography shader: byte = (T + 60) * 0.18 */
  fillTempTex(buf: Uint8Array): void {
    const t = this.tempV;
    for (let i = 0; i < t.length; i++) {
      buf[i] = Math.max(0, Math.min(255, (t[i] + 60) * 0.18)) | 0;
    }
  }

  /** encode the reaction glow for the "rx" background shader */
  fillGlowTex(buf: Uint8Array): void {
    const g = this.glowV;
    for (let i = 0; i < g.length; i++) {
      buf[i] = Math.min(255, g[i] * 96) | 0;
    }
  }

  clear(): void {
    this.ex.clearAll();
    this.blastQueue.length = 0; // World.clear() empties blastQueue only
  }

  /** RLE snapshot of species+life (shade regenerates on load) — byte-format
   *  identical to World.serialize(): round-trips with existing .grn saves */
  serialize(): Uint8Array {
    const rle = (arr: Uint8Array): number[] => {
      const out: number[] = [];
      let v = arr[0];
      let run = 1;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] === v && run < 65535) run++;
        else {
          out.push(v, run & 255, run >> 8);
          v = arr[i];
          run = 1;
        }
      }
      out.push(v, run & 255, run >> 8);
      return out;
    };
    const s = rle(this.species);
    const l = rle(this.life);
    const buf = new Uint8Array(12 + s.length + l.length);
    buf.set([0x47, 0x52, 0x4e, 0x31]); // "GRN1"
    buf[4] = this.W & 255; buf[5] = this.W >> 8;
    buf[6] = this.H & 255; buf[7] = this.H >> 8;
    buf[8] = s.length & 255; buf[9] = (s.length >> 8) & 255;
    buf[10] = (s.length >> 16) & 255; buf[11] = (s.length >> 24) & 255;
    buf.set(s, 12);
    buf.set(l, 12 + s.length);
    return buf;
  }

  deserialize(buf: Uint8Array): boolean {
    if (buf[0] !== 0x47 || buf[1] !== 0x52 || buf[2] !== 0x4e || buf[3] !== 0x31) return false;
    if ((buf[4] | (buf[5] << 8)) !== this.W || (buf[6] | (buf[7] << 8)) !== this.H) return false;
    const sLen = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
    const unrle = (from: number, to: number, target: Uint8Array): void => {
      let w = 0;
      for (let p = from; p < to; p += 3) {
        const v = buf[p];
        const run = buf[p + 1] | (buf[p + 2] << 8);
        target.fill(v, w, w + run);
        w += run;
      }
    };
    unrle(12, 12 + sLen, this.species);
    unrle(12 + sLen, buf.length, this.life);
    // recount dots, regen shade (consumes engine rng like TS), wake all
    // chunks, rebuild fans, re-seed heat pumps
    this.ex.postLoad();
    return true;
  }

  get frame(): number {
    return this.ex.getFrame();
  }

  get dots(): number {
    return this.ex.getDots();
  }

  /** total rng next() calls since init — parity instrumentation */
  get rngDraws(): number {
    return this.ex.getRngDraws() >>> 0;
  }

  /** decaying blast magnitude for render feedback (flash + screen shake) */
  get fxPower(): number {
    return this.ex.getFxPower();
  }

  get rngState(): number {
    return this.ex.getRngState() >>> 0;
  }

  activeChunkCount(): number {
    return this.ex.activeChunkCount();
  }

  /** debug: live view of the active-chunk map (ceil(W/32) x ceil(H/32)) */
  activeCurView(): Uint8Array {
    const n = Math.ceil(this.W / 32) * Math.ceil(this.H / 32);
    return new Uint8Array(this.ex.memory.buffer, this.ex.activeCurPtr(), n);
  }

  activeNextView(): Uint8Array {
    const n = Math.ceil(this.W / 32) * Math.ceil(this.H / 32);
    return new Uint8Array(this.ex.memory.buffer, this.ex.activeNextPtr(), n);
  }

  dbgResetSites(): void {
    this.ex.dbgResetSites();
  }

  /** debug: per-site rng draw counters (see asm/engine.ts dbgSite) */
  dbgSites(): number[] {
    const out: number[] = [];
    for (let k = 0; k < 6; k++) out.push(this.ex.dbgSite(k));
    return out;
  }

  dbgSeqEnable(): void {
    this.ex.dbgSeqEnable();
  }

  dbgSeqDisable(): void {
    this.ex.dbgSeqDisable();
  }

  /** debug: ordered rng-draw log entries, packed site<<28 | y<<14 | x */
  dbgSeq(): Uint32Array {
    const len = this.ex.dbgSeqLen();
    return new Uint32Array(this.ex.memory.buffer.slice(0), this.ex.dbgSeqPtr(), len);
  }

  /** debug: every rngNext() value drawn while the seq log was enabled */
  dbgVals(): Float64Array {
    const len = this.ex.dbgValLen();
    return new Float64Array(this.ex.memory.buffer.slice(0), this.ex.dbgValPtr(), len);
  }
}
