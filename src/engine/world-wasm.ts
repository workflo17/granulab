// WASM engine loader — instantiates asm/engine.ts (built to asm/build/engine.wasm)
// and exposes the subset of World's surface the stage-1 parity harness needs:
// { ready, species/shade/life views, paint(x,y,id,aux?), step(), frame, dots }.
//
// Registry tables (flat typed arrays from elements.ts) are COPIED into WASM
// memory here at init — the AS module never re-derives them. The module
// preallocates everything in init() so memory never grows afterwards; views
// are still re-derived defensively if the backing buffer ever detaches.

import {
  E, N_IDS, BEHAVIOR, DENSITY, DISPERSE, FLAMMABLE, BURNLIFE, LIFE0,
  EXPLODE_R, REACT, REACT_DT, HAS_REACT, CONDUCTS, HEAT_PUMP,
  TEMP0, HOT_AT, HOT_TO, COLD_AT, COLD_TO, IGNITES_AT, THERMAL,
} from "./elements";

// mirrors the module-level HYST table in world.ts (settle-hysteresis liquids)
const HYST = new Uint8Array(N_IDS);
HYST[E.WATER] = HYST[E.SEAWATER] = HYST[E.OIL] = HYST[E.MERCURY] = HYST[E.MUD] = HYST[E.NITRO] = 1;
HYST[E.SOAPY] = HYST[E.CO2] = HYST[E.CHLORINE] = 1; // heavy gases pool + sleep too

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
  /** resolves once the module is instantiated, tables copied, views built */
  readonly ready: Promise<void>;

  species!: Uint8Array;
  shade!: Uint8Array;
  life!: Uint8Array;
  clock!: Uint8Array;

  private ex!: EngineExports;
  private mem: WebAssembly.Memory | null = null;
  private buf: ArrayBuffer | null = null;

  constructor(wasmBytes: BufferSource, w: number, h: number, seed = 0xc0ffee) {
    this.W = w;
    this.H = h;
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
  }

  /** views detach if wasm memory grows (it shouldn't — fixed preallocation) */
  private checkViews(): void {
    if (this.buf !== this.ex.memory.buffer) this.refreshViews();
  }

  paint(x: number, y: number, id: number, aux?: number): void {
    this.ex.paint(x, y, id, aux === undefined ? -1 : aux);
    this.checkViews();
  }

  step(): void {
    this.ex.step();
    this.checkViews();
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
