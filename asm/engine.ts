// AssemblyScript port of src/engine/world.ts — STAGE 1 (movement scene).
//
// PARITY DOCTRINE: this file is ported by REACHABILITY, not by feature. Every
// code path the stage-1 scene (walls + powders + sand + water pool + oil layer
// + possible sand+water "Mudding" reaction, uniform ambient temperature, no
// fans/fire/devices) can reach is ported EXACTLY — including rng draws whose
// results go unused. Every branch the scene cannot reach traps loudly via
// abort() so accidental entry fails fast instead of silently diverging.
//
// Structure and function names mirror world.ts one-to-one so future stages
// diff cleanly. Registry tables (BEHAVIOR, DENSITY, REACT, ...) are COPIED
// into WASM memory by the JS loader (src/engine/world-wasm.ts) after init();
// they are never re-derived here.
//
// Numeric semantics notes (the usual divergence traps):
// - TS computes in f64 everywhere; `| 0` truncates. Ported as f64 locals with
//   <i32> truncation exactly where TS coerces.
// - Float32Array loads promote f32 -> f64; stores round f64 -> f32. Ported as
//   load<f32> -> f64 math -> store<f32>.
// - Rng state is u32 with wrapping add/mul (Math.imul == wrapping i32/u32 mul).

const CHUNK: i32 = 32;
const CHUNK_SHIFT: i32 = 5;

// liquids that calm down and sleep when nothing around them changes — the
// HYST table itself is data copied in by the loader (mirrors world.ts HYST)
const SETTLE: i32 = 6; // ticks of stillness before a liquid cell stops dispersing
const MARGIN: i32 = 2; // changes this close to a chunk border wake the neighbor
const WSHIFT: i32 = 2; // wind cell = 4x4 sim cells
const FAN_BEAM: i32 = 64; // beam length in wind cells (unreachable: no fans in stage 1)
const MAX_FAN_BEAMS: i32 = 512; // unreachable: no fans in stage 1
const TSHIFT: i32 = 1; // temperature cell = 2x2 sim cells
const AMBIENT: f64 = 20; // °C — the field drifts back here and sleeps

const N_IDS: i32 = 128;

// element ids referenced by ported control flow (values mirror elements.ts E)
const E_EMPTY: i32 = 0;
const E_WALL: i32 = 1;
const E_FIRE: i32 = 5;
const E_SEED: i32 = 8;
const E_ACID: i32 = 11;
const E_MAGMA: i32 = 15;
const E_SPARK: i32 = 26;
const E_FAN: i32 = 28;
const E_SOAPY: i32 = 45;

// behavior codes (mirror elements.ts B)
const B_POWDER: i32 = 1;
const B_LIQUID: i32 = 2;
const B_GAS: i32 = 3;
const B_FIRE: i32 = 4;
const B_VINE: i32 = 5;
const B_EMITTER: i32 = 6;
const B_SPARK: i32 = 7;
const B_CLONE: i32 = 8;
const B_ANT: i32 = 9;
const B_VIRUS: i32 = 10;
const B_METAL: i32 = 11;
const B_SUPERBALL: i32 = 12;
const B_BIRD: i32 = 13;
const B_CLOUD: i32 = 14;
const B_LASER: i32 = 15;
const B_THUNDER: i32 = 16;
const B_ROCKET: i32 = 17;
const B_PUMP: i32 = 18;
const B_CANNON: i32 = 19;
const B_DETECTOR: i32 = 20;
const B_VALVE: i32 = 21;
const B_FILTER: i32 = 22;
const B_LITMUS: i32 = 23;

// ---- Rng (src/engine/rng.ts, mulberry32) -----------------------------------
// PARITY-CRITICAL: in TS, `this.s += 0x6d2b79f5` accumulates in an UNBOUNDED
// JS f64 — it is never masked to 32 bits. The i32 ops read ToUint32(s), which
// equals pure u32 wrapping ONLY while s < 2^53 (~4.92M draws from seed
// 0xc0ffee). Beyond that the f64 addition ROUNDS (s snaps to even spacing),
// and the draw stream departs from textbook mulberry32. A "clean" u32-state
// port diverges at exactly draw 4,917,861 — found the hard way at tick 136 of
// the stage-1 scene. So the state here is f64, added like JS adds, and only
// truncated to u32 bits where TS coerces.

let rngSF: f64 = 0; // JS-number state: unbounded, rounds above 2^53 like TS
let rngDraws: u32 = 0; // parity instrumentation: total next() calls

// @ts-ignore: decorator
@inline function toU32(x: f64): u32 {
  return <u32>(<u64>x); // ECMAScript ToUint32: trunc, then low 32 bits
}

function rngNext(): f64 {
  rngDraws++;
  rngSF += 1831565813.0; // 0x6d2b79f5 as an f64 add — rounding included
  let t: u32 = toU32(rngSF);
  t = (t ^ (t >>> 15)) * (t | 1); // Math.imul == wrapping 32-bit multiply
  t ^= t + (t ^ (t >>> 7)) * (t | 61); // f64 add then ToInt32 == wrapping add
  const v = <f64>(t ^ (t >>> 14)) / 4294967296.0;
  if (dbgSeqOn && dbgValLen_ < DBG_SEQ_CAP) {
    store<f64>(dbgValP + (<usize>dbgValLen_ << 3), v);
    dbgValLen_++;
  }
  return v;
}

function rngByte(): i32 {
  return <i32>(rngNext() * 256.0); // (next() * 256) | 0
}

function rngInt(n: i32): i32 {
  return <i32>(rngNext() * <f64>n); // (next() * n) | 0
}

function rngBool(): bool {
  return rngNext() < 0.5;
}

export function getRngDraws(): u32 {
  return rngDraws;
}

export function getRngState(): u32 {
  return toU32(rngSF);
}

// ---- world state (World fields as module globals + raw memory regions) ----

let W: i32 = 0;
let H: i32 = 0;
let speciesP: usize = 0;
let shadeP: usize = 0;
let lifeP: usize = 0;
let clockP: usize = 0;
let vx8P: usize = 0; // Int8Array
let vy8P: usize = 0;

let chunksX: i32 = 0;
let chunksY: i32 = 0;
let activeCurP: usize = 0;
let activeNextP: usize = 0;

// wind field (quarter resolution)
let WXg: i32 = 0;
let WYg: i32 = 0;
let windVxP: usize = 0; // Float32Array
let windVyP: usize = 0;
let fansLen: i32 = 0; // stage 1: painting a FAN traps, so this stays 0

// reaction glow field (quarter res)
let glowP: usize = 0; // Float32Array
let glowTicks: i32 = 0;

// temperature field (half resolution), chunk-gated like the cell sim
let TWg: i32 = 0;
let THg: i32 = 0;
let tempP: usize = 0; // Float32Array
let thermalCurP: usize = 0;
let thermalNextP: usize = 0;

let frame: i32 = 0;
let dots: i32 = 0;
let fxPower: f64 = 0;

// registry tables (flat typed arrays copied in from elements.ts by the loader)
let behaviorP: usize = 0; // u8
let densityP: usize = 0; // u8
let disperseP: usize = 0; // u8
let flammableP: usize = 0; // u8
let burnlifeP: usize = 0; // u8
let life0P: usize = 0; // u8
let explodeRP: usize = 0; // u8
let hasReactP: usize = 0; // u8
let conductsP: usize = 0; // u8
let hystP: usize = 0; // u8 (world.ts module-level HYST)
let heatPumpP: usize = 0; // f32
let reactP: usize = 0; // u32 [N_IDS * N_IDS]
let reactCountP: usize = 0; // u32 [N_IDS * N_IDS]
let reactDtP: usize = 0; // i16 [N_IDS * N_IDS]

// ---- raw memory accessors --------------------------------------------------

// @ts-ignore: decorator
@inline function species(i: i32): i32 { return <i32>load<u8>(speciesP + <usize>i); }
// @ts-ignore: decorator
@inline function speciesSet(i: i32, v: i32): void { store<u8>(speciesP + <usize>i, <u8>v); }
// @ts-ignore: decorator
@inline function shade(i: i32): i32 { return <i32>load<u8>(shadeP + <usize>i); }
// @ts-ignore: decorator
@inline function shadeSet(i: i32, v: i32): void { store<u8>(shadeP + <usize>i, <u8>v); }
// @ts-ignore: decorator
@inline function life(i: i32): i32 { return <i32>load<u8>(lifeP + <usize>i); }
// @ts-ignore: decorator
@inline function lifeSet(i: i32, v: i32): void { store<u8>(lifeP + <usize>i, <u8>v); }
// @ts-ignore: decorator
@inline function clockAt(i: i32): i32 { return <i32>load<u8>(clockP + <usize>i); }
// @ts-ignore: decorator
@inline function clockSet(i: i32, v: i32): void { store<u8>(clockP + <usize>i, <u8>v); }
// @ts-ignore: decorator
@inline function vx8(i: i32): i32 { return <i32>load<i8>(vx8P + <usize>i); }
// @ts-ignore: decorator
@inline function vx8Set(i: i32, v: i32): void { store<i8>(vx8P + <usize>i, <i8>v); }
// @ts-ignore: decorator
@inline function vy8(i: i32): i32 { return <i32>load<i8>(vy8P + <usize>i); }
// @ts-ignore: decorator
@inline function vy8Set(i: i32, v: i32): void { store<i8>(vy8P + <usize>i, <i8>v); }
// @ts-ignore: decorator
@inline function u8At(p: usize, i: i32): i32 { return <i32>load<u8>(p + <usize>i); }
// @ts-ignore: decorator
@inline function u8Set(p: usize, i: i32, v: i32): void { store<u8>(p + <usize>i, <u8>v); }
// @ts-ignore: decorator
@inline function f32At(p: usize, i: i32): f64 { return <f64>load<f32>(p + (<usize>i << 2)); }
// @ts-ignore: decorator
@inline function f32Set(p: usize, i: i32, v: f64): void { store<f32>(p + (<usize>i << 2), <f32>v); }

// registry lookups
// @ts-ignore: decorator
@inline function BEHAVIOR(id: i32): i32 { return u8At(behaviorP, id); }
// @ts-ignore: decorator
@inline function DENSITY(id: i32): i32 { return u8At(densityP, id); }
// @ts-ignore: decorator
@inline function DISPERSE(id: i32): i32 { return u8At(disperseP, id); }
// @ts-ignore: decorator
@inline function FLAMMABLE(id: i32): i32 { return u8At(flammableP, id); }
// @ts-ignore: decorator
@inline function LIFE0(id: i32): i32 { return u8At(life0P, id); }
// @ts-ignore: decorator
@inline function EXPLODE_R(id: i32): i32 { return u8At(explodeRP, id); }
// @ts-ignore: decorator
@inline function HAS_REACT(id: i32): i32 { return u8At(hasReactP, id); }
// @ts-ignore: decorator
@inline function CONDUCTS(id: i32): i32 { return u8At(conductsP, id); }
// @ts-ignore: decorator
@inline function HYST(id: i32): i32 { return u8At(hystP, id); }
// @ts-ignore: decorator
@inline function HEAT_PUMP(id: i32): f64 { return f32At(heatPumpP, id); }
// @ts-ignore: decorator
@inline function REACT(k: i32): u32 { return load<u32>(reactP + (<usize>k << 2)); }
// @ts-ignore: decorator
@inline function REACT_DT(k: i32): i32 { return <i32>load<i16>(reactDtP + (<usize>k << 1)); }

// ---- init ------------------------------------------------------------------

function allocZ(bytes: i32): usize {
  const p = heap.alloc(<usize>bytes);
  memory.fill(p, 0, <usize>bytes);
  return p;
}

/** constructor(w, h, seed) — fixed preallocation; memory never grows after
 *  init, so the loader's views over WASM memory stay valid */
export function init(w: i32, h: i32, seed: u32): void {
  W = w;
  H = h;
  const n = w * h;
  speciesP = allocZ(n);
  shadeP = allocZ(n);
  lifeP = allocZ(n);
  clockP = allocZ(n);
  vx8P = allocZ(n);
  vy8P = allocZ(n);
  chunksX = (w + CHUNK - 1) / CHUNK; // Math.ceil(w / CHUNK)
  chunksY = (h + CHUNK - 1) / CHUNK;
  activeCurP = allocZ(chunksX * chunksY);
  activeNextP = allocZ(chunksX * chunksY);
  WXg = w >> WSHIFT;
  WYg = h >> WSHIFT;
  windVxP = allocZ((WXg * WYg) << 2);
  windVyP = allocZ((WXg * WYg) << 2);
  glowP = allocZ((WXg * WYg) << 2);
  TWg = w >> TSHIFT;
  THg = h >> TSHIFT;
  tempP = allocZ((TWg * THg) << 2);
  for (let i = 0, tn = TWg * THg; i < tn; i++) f32Set(tempP, i, AMBIENT);
  thermalCurP = allocZ(chunksX * chunksY);
  thermalNextP = allocZ(chunksX * chunksY);
  // registry tables — the loader copies elements.ts data in after init()
  behaviorP = allocZ(N_IDS);
  densityP = allocZ(N_IDS);
  disperseP = allocZ(N_IDS);
  flammableP = allocZ(N_IDS);
  burnlifeP = allocZ(N_IDS);
  life0P = allocZ(N_IDS);
  explodeRP = allocZ(N_IDS);
  hasReactP = allocZ(N_IDS);
  conductsP = allocZ(N_IDS);
  hystP = allocZ(N_IDS);
  heatPumpP = allocZ(N_IDS << 2);
  reactP = allocZ((N_IDS * N_IDS) << 2);
  reactCountP = allocZ((N_IDS * N_IDS) << 2);
  reactDtP = allocZ((N_IDS * N_IDS) << 1);
  rngSF = <f64>seed; // constructor does `seed >>> 0` — loader passes u32
  rngDraws = 0;
  frame = 0;
  dots = 0;
  stamp = 0;
  windTicks = 0;
  glowTicks = 0;
  fxPower = 0;
  fansLen = 0;
}

// pointer getters so the loader can build views / copy tables
export function speciesPtr(): usize { return speciesP; }
export function shadePtr(): usize { return shadeP; }
export function lifePtr(): usize { return lifeP; }
export function clockPtr(): usize { return clockP; }
export function behaviorPtr(): usize { return behaviorP; }
export function densityPtr(): usize { return densityP; }
export function dispersePtr(): usize { return disperseP; }
export function flammablePtr(): usize { return flammableP; }
export function burnlifePtr(): usize { return burnlifeP; }
export function life0Ptr(): usize { return life0P; }
export function explodeRPtr(): usize { return explodeRP; }
export function hasReactPtr(): usize { return hasReactP; }
export function conductsPtr(): usize { return conductsP; }
export function hystPtr(): usize { return hystP; }
export function heatPumpPtr(): usize { return heatPumpP; }
export function reactPtr(): usize { return reactP; }
export function reactDtPtr(): usize { return reactDtP; }
export function getFrame(): i32 { return frame; }
export function getDots(): i32 { return dots; }

export function activeChunkCount(): i32 {
  let c = 0;
  for (let i = 0, n = chunksX * chunksY; i < n; i++) c += u8At(activeCurP, i);
  return c;
}

export function activeCurPtr(): usize { return activeCurP; }
export function activeNextPtr(): usize { return activeNextP; }

// ---- parity forensics (tools/parity.ts hunt/forensic passes) ---------------
// Per-site rng draw counters + an optional per-draw (site, cell) and value
// log. This is how the f64-rng-state divergence was found; future stages'
// parity hunts will want it. Costs one predictable branch per draw when off.
let cntReactInt: i32 = 0; // updateCell rk = rng.int(4)
let cntReactByte: i32 = 0; // updateCell reaction probability roll
let cntPowder90: i32 = 0; // doPowder sink-through-fluid 90-roll
let cntPowderDir: i32 = 0; // doPowder diagonal dir bool
let cntLiquidDir: i32 = 0; // doLiquid diagonal dir bool
let cntLiquidDisp: i32 = 0; // doLiquid dispersion dir bool
export function dbgResetSites(): void {
  cntReactInt = 0; cntReactByte = 0; cntPowder90 = 0;
  cntPowderDir = 0; cntLiquidDir = 0; cntLiquidDisp = 0;
}
export function dbgSite(k: i32): i32 {
  if (k === 0) return cntReactInt;
  if (k === 1) return cntReactByte;
  if (k === 2) return cntPowder90;
  if (k === 3) return cntPowderDir;
  if (k === 4) return cntLiquidDir;
  return cntLiquidDisp;
}

// draw-sequence log: packs site(4b) | y(14b) | x(14b) per rng draw
let dbgSeqP: usize = 0;
let dbgSeqLen_: i32 = 0;
let dbgSeqOn: bool = false;
const DBG_SEQ_CAP: i32 = 1 << 17;
// parallel value log: every rngNext() result while enabled (f64 each)
let dbgValP: usize = 0;
let dbgValLen_: i32 = 0;
export function dbgSeqEnable(): void {
  if (dbgSeqP === 0) dbgSeqP = heap.alloc(<usize>(DBG_SEQ_CAP << 2));
  if (dbgValP === 0) dbgValP = heap.alloc(<usize>(DBG_SEQ_CAP << 3));
  dbgSeqLen_ = 0;
  dbgValLen_ = 0;
  dbgSeqOn = true;
}
export function dbgSeqDisable(): void {
  dbgSeqOn = false;
}
export function dbgSeqLen(): i32 { return dbgSeqLen_; }
export function dbgSeqPtr(): usize { return dbgSeqP; }
export function dbgValLen(): i32 { return dbgValLen_; }
export function dbgValPtr(): usize { return dbgValP; }
// @ts-ignore: decorator
@inline function dbgLog(site: i32, x: i32, y: i32): void {
  if (!dbgSeqOn || dbgSeqLen_ >= DBG_SEQ_CAP) return;
  store<u32>(dbgSeqP + (<usize>dbgSeqLen_ << 2), <u32>((site << 28) | (y << 14) | x));
  dbgSeqLen_++;
}

// ---- chunk bookkeeping -------------------------------------------------

function wake(x: i32, y: i32): void {
  const cx = x >> CHUNK_SHIFT;
  const cy = y >> CHUNK_SHIFT;
  const cw = chunksX;
  u8Set(activeNextP, cy * cw + cx, 1);
  const lx = x & (CHUNK - 1);
  const ly = y & (CHUNK - 1);
  if (lx < MARGIN && cx > 0) u8Set(activeNextP, cy * cw + cx - 1, 1);
  if (lx >= CHUNK - MARGIN && cx < cw - 1) u8Set(activeNextP, cy * cw + cx + 1, 1);
  if (ly < MARGIN && cy > 0) u8Set(activeNextP, (cy - 1) * cw + cx, 1);
  if (ly >= CHUNK - MARGIN && cy < chunksY - 1) u8Set(activeNextP, (cy + 1) * cw + cx, 1);
  // also keep it live for the current pass so cascades continue this frame
  u8Set(activeCurP, cy * cw + cx, 1);
}

// ---- cell mutation (all writes go through these) -----------------------

/** Paint/spawn a cell. Elements only fill EMPTY; WALL and EMPTY overwrite.
 *  `aux` overrides the initial life value (-1 = undefined in the TS surface). */
export function paint(x: i32, y: i32, id: i32, aux: i32): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  const old = species(i);
  if (id === old && id !== E_FAN) return;
  // elements fill empty cells only; wall/erase overwrite; spark conducts onto
  // metal; fire painted onto a flammable ignites it in place
  const replaceable =
    old === E_EMPTY || id === E_EMPTY || id === E_WALL ||
    (id === E_SPARK && CONDUCTS(old) > 0) ||
    (id === E_FIRE && FLAMMABLE(old) > 0);
  if (!replaceable) return;
  if (id === E_FIRE && old !== E_EMPTY && EXPLODE_R(old) > 0) {
    explode(x, y, EXPLODE_R(old)); // traps: stage 1 has no explosives
    return;
  }
  if (old !== E_EMPTY && old !== E_WALL) dots--;
  if (id !== E_EMPTY && id !== E_WALL) dots++;
  speciesSet(i, id);
  shadeSet(i, rngByte()); // paint consumes rng for shade — parity-critical
  // sparks track wire-born-ness in shade bit 0 — unreachable in stage 1
  if (id === E_SPARK) {
    abort("paint: SPARK shade branch not ported (stage 1)");
  }
  lifeSet(i, aux >= 0 ? aux : LIFE0(id));
  vx8Set(i, 0);
  vy8Set(i, 0);
  if (id === E_FAN) {
    abort("paint: FAN not ported (stage 1)"); // fans list + wind beams unported
  }
  if (HEAT_PUMP(id) > 0) pumpHeat(x, y, 0, 0.6); // traps: no heat-pump elements
  wake(x, y);
  // painting unsettles adjacent calm liquids so pools react to edits
  for (let k = 0; k < 4; k++) {
    const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
    const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (HYST(species(j)) !== 0) lifeSet(j, 0);
  }
}

function set(i: i32, x: i32, y: i32, id: i32, lifeVal: i32): void {
  const old = species(i);
  if (old !== E_EMPTY && old !== E_WALL) dots--;
  if (id !== E_EMPTY && id !== E_WALL) dots++;
  speciesSet(i, id);
  lifeSet(i, lifeVal);
  vx8Set(i, 0);
  vy8Set(i, 0);
  clockSet(i, stamp);
  wake(x, y);
}

function swap(i: i32, j: i32, xi: i32, yi: i32, xj: i32, yj: i32): void {
  let t = species(i); speciesSet(i, species(j)); speciesSet(j, t);
  t = shade(i); shadeSet(i, shade(j)); shadeSet(j, t);
  t = life(i); lifeSet(i, life(j)); lifeSet(j, t);
  t = vx8(i); vx8Set(i, vx8(j)); vx8Set(j, t);
  t = vy8(i); vy8Set(i, vy8(j)); vy8Set(j, t);
  clockSet(i, stamp);
  clockSet(j, stamp);
  wake(xi, yi);
  wake(xj, yj);
}

// ---- wind field --------------------------------------------------------

let windTicks: i32 = 0; // wind sim runs only while energy is in the field

function stepWind(): void {
  if (fansLen === 0 && windTicks === 0) return; // stage-1 fast path: always taken
  if (fansLen > 0) windTicks = 240;
  else windTicks--;
  // decay + one cheap in-place diffusion pass (interior only) — mirrored for
  // structure; unreachable in stage 1 (no fans, no explosions => windTicks 0)
  for (let y = 1; y < WYg - 1; y++) {
    const r = y * WXg;
    for (let x = 1; x < WXg - 1; x++) {
      const i = r + x;
      f32Set(windVxP, i, f32At(windVxP, i) * 0.78 +
        (f32At(windVxP, i - 1) + f32At(windVxP, i + 1) + f32At(windVxP, i - WXg) + f32At(windVxP, i + WXg)) * 0.05);
      f32Set(windVyP, i, f32At(windVyP, i) * 0.78 +
        (f32At(windVyP, i - 1) + f32At(windVyP, i + 1) + f32At(windVyP, i - WXg) + f32At(windVyP, i + WXg)) * 0.05);
    }
  }
  // fan beams — no fans can exist in stage 1 (paint traps on FAN)
  if (fansLen === 0) return;
  abort("stepWind: fan beams not ported (stage 1)");
}

// ---- temperature field -------------------------------------------------

function markThermalCoarse(tx: i32, ty: i32): void {
  const cx = tx >> 4; // 16 coarse cells per 32-sim-cell chunk
  const cy = ty >> 4;
  const cw = chunksX;
  u8Set(thermalNextP, cy * cw + cx, 1);
  u8Set(thermalCurP, cy * cw + cx, 1);
  if ((tx & 15) === 0 && cx > 0) u8Set(thermalNextP, cy * cw + cx - 1, 1);
  if ((tx & 15) === 15 && cx < cw - 1) u8Set(thermalNextP, cy * cw + cx + 1, 1);
  if ((ty & 15) === 0 && cy > 0) u8Set(thermalNextP, (cy - 1) * cw + cx, 1);
  if ((ty & 15) === 15 && cy < chunksY - 1) u8Set(thermalNextP, (cy + 1) * cw + cx, 1);
}

/** drive the heat field at a sim cell toward `target` with strength k —
 *  unreachable in stage 1 (no heat-pump elements, no lasers) */
function pumpHeat(x: i32, y: i32, target: f64, k: f64): void {
  abort("pumpHeat: not ported (stage 1: uniform ambient temperature)");
}

function stepTemp(): void {
  // chunk-gate swap runs every tick exactly like TS; with a uniform-ambient
  // scene no thermal chunk is ever marked, so the per-chunk body is
  // unreachable — entering it means the scene violated stage-1 assumptions
  const swapP = thermalCurP;
  thermalCurP = thermalNextP;
  thermalNextP = swapP;
  memory.fill(thermalNextP, 0, <usize>(chunksX * chunksY));
  const cur = thermalCurP;
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) {
      if (!u8At(cur, cy * chunksX + cx)) continue;
      abort("stepTemp: active thermal chunk — diffusion/phase pass not ported (stage 1)");
    }
  }
}

/** wind shove for mobile cells; returns true if the cell moved. With a zero
 *  wind field m < 0.5 always short-circuits BEFORE any rng draw (parity). */
function tryWindPush(i: i32, x: i32, y: i32, k: f64): bool {
  const wi = (y >> WSHIFT) * WXg + (x >> WSHIFT);
  const wx = f32At(windVxP, wi);
  const wy = f32At(windVyP, wi);
  const m = (wx < 0 ? -wx : wx) + (wy < 0 ? -wy : wy);
  if (m < 0.5) return false;
  if (rngNext() >= m * k) return false;
  let dx: i32 = wx > 0.4 ? 1 : wx < -0.4 ? -1 : 0;
  let dy: i32 = wy > 0.4 ? 1 : wy < -0.4 ? -1 : 0;
  if (dx === 0 && dy === 0) return false;
  let nx = x + dx;
  let ny = y + dy;
  if (nx >= 0 && ny >= 0 && nx < W && ny < H && species(ny * W + nx) === E_EMPTY) {
    swap(i, ny * W + nx, x, y, nx, ny);
    return true;
  }
  if (dx !== 0 && dy !== 0) {
    nx = x + dx;
    if (nx >= 0 && nx < W && species(y * W + nx) === E_EMPTY) {
      swap(i, y * W + nx, x, y, nx, y);
      return true;
    }
  }
  // saltation: horizontal wind lofts surface grains up-and-over obstacles
  if (dx !== 0) {
    nx = x + dx;
    ny = y - 1;
    if (nx >= 0 && ny >= 0 && nx < W && species(ny * W + nx) === E_EMPTY && rngByte() < 200) {
      swap(i, ny * W + nx, x, y, nx, ny);
      return true;
    }
  }
  return false;
}

// ---- the tick ----------------------------------------------------------

let stamp: i32 = 0;

export function step(): void {
  frame++;
  stamp = frame & 0xff;
  const t = activeCurP;
  activeCurP = activeNextP;
  activeNextP = t;
  memory.fill(activeNextP, 0, <usize>(chunksX * chunksY));

  stepWind();
  stepTemp();
  if (fxPower > 0.3) fxPower *= 0.88;
  else fxPower = 0;
  if (glowTicks > 0) {
    glowTicks--;
    for (let i = 0, gn = WXg * WYg; i < gn; i++) {
      const g = f32At(glowP, i);
      if (g !== 0) f32Set(glowP, i, g > 0.02 ? g * 0.94 : 0);
    }
  }

  const cur = activeCurP;
  const st = stamp;
  const ltrFrame = (frame & 1) === 0;

  for (let y = H - 1; y >= 0; y--) {
    const cy = y >> CHUNK_SHIFT;
    const rowChunk = cy * chunksX;
    const rowBase = y * W;
    const ltr = ltrFrame !== ((y & 1) === 1);
    if (ltr) {
      for (let cx = 0; cx < chunksX; cx++) {
        if (!u8At(cur, rowChunk + cx)) continue;
        const x0 = cx << CHUNK_SHIFT;
        const x1 = min(x0 + CHUNK, W);
        for (let x = x0; x < x1; x++) {
          const i = rowBase + x;
          const id = species(i);
          if (id <= E_WALL || clockAt(i) === st) continue;
          updateCell(i, x, y, id);
        }
      }
    } else {
      for (let cx = chunksX - 1; cx >= 0; cx--) {
        if (!u8At(cur, rowChunk + cx)) continue;
        const x0 = cx << CHUNK_SHIFT;
        const x1 = min(x0 + CHUNK, W);
        for (let x = x1 - 1; x >= x0; x--) {
          const i = rowBase + x;
          const id = species(i);
          if (id <= E_WALL || clockAt(i) === st) continue;
          updateCell(i, x, y, id);
        }
      }
    }
  }
}

function updateCell(i: i32, x: i32, y: i32, id: i32): void {
  // ballistic grains fly instead of falling — nothing sets vx8/vy8 in stage 1
  // (no explosions/cannons), so entry here means divergence: trap
  if ((vx8(i) | vy8(i)) !== 0) {
    doBallistic(i, x, y, id);
    return;
  }
  // mobile heat/cold sources drive the temperature field from their behavior
  if (HEAT_PUMP(id) > 0) pumpHeat(x, y, 0, HEAT_PUMP(id)); // traps (stage 1)
  // contact reaction (data-driven table): scan the 4-neighborhood for the
  // first reactive partner, starting at a random side so symmetric contacts
  // stay unbiased. Ported in full — the rk draw happens for every HAS_REACT
  // cell every tick, and a failed roll still wakes the cell (parity-critical).
  if (HAS_REACT(id) !== 0 && BEHAVIOR(id) !== B_SPARK) {
    cntReactInt++;
    dbgLog(0, x, y);
    const rk = rngInt(4);
    for (let s = 0; s < 4; s++) {
      const k = (rk + s) & 3;
      const rdx = k === 0 ? 1 : k === 1 ? -1 : 0;
      const rdy = k === 2 ? 1 : k === 3 ? -1 : 0;
      const rx = x + rdx;
      const ry = y + rdy;
      if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
      const j = ry * W + rx;
      const r = REACT(id * N_IDS + species(j));
      if (r === 0) continue;
      cntReactByte++;
      dbgLog(1, x, y);
      if (<u32>rngByte() < (r >>> 16)) {
        const pb = species(j);
        const pk = id < pb ? id * N_IDS + pb : pb * N_IDS + id;
        store<u32>(reactCountP + (<usize>pk << 2), load<u32>(reactCountP + (<usize>pk << 2)) + 1);
        const gi = (y >> WSHIFT) * WXg + (x >> WSHIFT);
        if (f32At(glowP, gi) < 4) f32Set(glowP, gi, f32At(glowP, gi) + 1);
        glowTicks = 240;
        // thermochemistry: exo/endothermic reactions drive the heat field —
        // stage-1's only reachable reaction (Mudding) has dT 0, so the write
        // below never runs; if it did, stepTemp would trap next tick
        const dT = REACT_DT(pk);
        if (dT !== 0) {
          const tx = x >> TSHIFT;
          const ty = y >> TSHIFT;
          f32Set(tempP, ty * TWg + tx, f32At(tempP, ty * TWg + tx) + <f64>dT);
          markThermalCoarse(tx, ty);
        }
        const newA = <i32>((r >>> 8) & 255);
        const newB = <i32>(r & 255);
        set(i, x, y, newA, LIFE0(newA));
        set(j, rx, ry, newB, LIFE0(newB));
        return;
      }
      wake(x, y); // reactive contact stays awake until it resolves
      break; // one roll per tick
    }
  }
  switch (BEHAVIOR(id)) {
    case B_POWDER: doPowder(i, x, y, id); break;
    case B_LIQUID: doLiquid(i, x, y, id); break;
    case B_GAS: doGas(i, x, y, id); break;
    case B_FIRE: doFire(i, x, y); break;
    case B_VINE: doVine(i, x, y); break;
    case B_EMITTER: doEmitter(i, x, y); break;
    case B_SPARK: doSpark(i, x, y); break;
    case B_CLONE: doClone(i, x, y); break;
    case B_ANT: doAnt(i, x, y); break;
    case B_VIRUS: doVirus(i, x, y); break;
    case B_METAL: doMetalCool(i, x, y); break;
    case B_SUPERBALL: doSuperball(i, x, y); break;
    case B_BIRD: doBird(i, x, y); break;
    case B_CLOUD: doCloud(i, x, y); break;
    case B_LASER: doLaser(i, x, y); break;
    case B_THUNDER: doThunder(i, x, y); break;
    case B_ROCKET: doRocket(i, x, y); break;
    case B_PUMP: doPump(i, x, y); break;
    case B_CANNON: doCannon(i, x, y); break;
    case B_DETECTOR: doDetector(i, x, y); break;
    case B_VALVE: doValve(i, x, y); break;
    case B_FILTER: doFilter(i, x, y); break;
    case B_LITMUS: doLitmus(i, x, y); break;
  }
}

// ---- stage-1 UNREACHABLE behaviors: loud traps, names kept for diffing ----

function doLitmus(i: i32, x: i32, y: i32): void {
  abort("doLitmus: not ported (stage 1)");
}

function doBallistic(i: i32, x: i32, y: i32, id: i32): void {
  abort("doBallistic: not ported (stage 1 — nothing sets vx8/vy8)");
}

function doCannon(i: i32, x: i32, y: i32): void {
  abort("doCannon: not ported (stage 1)");
}

function doDetector(i: i32, x: i32, y: i32): void {
  abort("doDetector: not ported (stage 1)");
}

function doValve(i: i32, x: i32, y: i32): void {
  abort("doValve: not ported (stage 1)");
}

function doFilter(i: i32, x: i32, y: i32): void {
  abort("doFilter: not ported (stage 1)");
}

// ---- movement behaviors (ported exactly) ----------------------------------

/** can `id` displace the occupant of cell j by falling into it? */
function sinksInto(id: i32, j: i32): bool {
  const o = species(j);
  if (o === E_EMPTY) return true;
  const b = BEHAVIOR(o);
  return (b === B_LIQUID || b === B_GAS) && DENSITY(id) > DENSITY(o);
}

function doPowder(i: i32, x: i32, y: i32, id: i32): void {
  if (tryWindPush(i, x, y, 0.35)) return;
  if (id === E_SEED && trySprout(i, x, y)) return; // trySprout traps (no seeds)
  if (y + 1 >= H) return;
  const below = i + W;
  if (sinksInto(id, below)) {
    if (species(below) === E_EMPTY) {
      swap(i, below, x, y, x, y + 1);
    } else {
      cntPowder90++;
      dbgLog(2, x, y);
      if (rngByte() < 90) swap(i, below, x, y, x, y + 1);
      else wake(x, y);
    }
    return;
  }
  cntPowderDir++;
  dbgLog(3, x, y);
  const dir = rngBool() ? 1 : -1;
  for (let k = 0; k < 2; k++) {
    const dx = k === 0 ? dir : -dir;
    const nx = x + dx;
    if (nx < 0 || nx >= W) continue;
    const j = below + dx;
    if (sinksInto(id, j) && species(i + dx) === E_EMPTY) {
      swap(i, j, x, y, nx, y + 1);
      return;
    }
  }
}

function doLiquid(i: i32, x: i32, y: i32, id: i32): void {
  const hyst = HYST(id);
  if (id === E_SOAPY && trySoapBubble(i, x, y)) return; // traps (no soapy)
  if (tryWindPush(i, x, y, 0.08)) return;
  if (id === E_ACID && doCorrode(i, x, y)) return; // traps (no acid)
  if (id === E_MAGMA) hotContact4(x, y); // traps (no magma)
  if (y + 1 < H) {
    const below = i + W;
    if (sinksInto(id, below)) {
      swap(i, below, x, y, x, y + 1);
      if (hyst) lifeSet(below, 0);
      return;
    }
    cntLiquidDir++;
    dbgLog(4, x, y);
    const dir = rngBool() ? 1 : -1;
    for (let k = 0; k < 2; k++) {
      const dx = k === 0 ? dir : -dir;
      const nx = x + dx;
      if (nx < 0 || nx >= W) continue;
      if (sinksInto(id, below + dx) && species(i + dx) === E_EMPTY) {
        swap(i, below + dx, x, y, nx, y + 1);
        if (hyst) lifeSet(below + dx, 0);
        return;
      }
    }
  }
  // settled-liquid hysteresis: a calm cell stops dispersing and goes to sleep
  if (hyst && life(i) > SETTLE) return;
  const disp = DISPERSE(id);
  cntLiquidDisp++;
  dbgLog(5, x, y);
  const dir = rngBool() ? 1 : -1;
  let moved = 0;
  let from = i;
  let fx = x;
  for (let s = 0; s < disp; s++) {
    const nx = fx + dir;
    if (nx < 0 || nx >= W) break;
    const j = from + dir;
    if (species(j) !== E_EMPTY) break;
    swap(from, j, fx, y, nx, y);
    from = j;
    fx = nx;
    moved++;
  }
  if (moved > 0) {
    if (hyst) lifeSet(from, 0);
    return;
  }
  const nx = x - dir;
  if (nx >= 0 && nx < W && species(i - dir) === E_EMPTY) {
    swap(i, i - dir, x, y, nx, y);
    if (hyst) lifeSet(i - dir, 0);
    return;
  }
  // nothing moved: count toward settling, stay briefly awake, then sleep
  if (hyst) {
    if (life(i) < 200) lifeSet(i, life(i) + 1);
    if (life(i) <= SETTLE) wake(x, y);
  }
}

function doGas(i: i32, x: i32, y: i32, id: i32): void {
  abort("doGas: not ported (stage 1 — no gases spawn)");
}

/** ignite/melt scan over 4 neighbors — shared by magma, torch, spark */
function hotContact4(x: i32, y: i32): void {
  abort("hotContact4: not ported (stage 1)");
}

function doFire(i: i32, x: i32, y: i32): void {
  abort("doFire: not ported (stage 1)");
}

function doVine(i: i32, x: i32, y: i32): void {
  abort("doVine: not ported (stage 1)");
}

function doEmitter(i: i32, x: i32, y: i32): void {
  abort("doEmitter: not ported (stage 1)");
}

function doSpark(i: i32, x: i32, y: i32): void {
  abort("doSpark: not ported (stage 1)");
}

function doClone(i: i32, x: i32, y: i32): void {
  abort("doClone: not ported (stage 1)");
}

function doAnt(i: i32, x: i32, y: i32): void {
  abort("doAnt: not ported (stage 1)");
}

function doVirus(i: i32, x: i32, y: i32): void {
  abort("doVirus: not ported (stage 1)");
}

function trySprout(i: i32, x: i32, y: i32): bool {
  abort("trySprout: not ported (stage 1)");
  return false;
}

function doCorrode(i: i32, x: i32, y: i32): bool {
  abort("doCorrode: not ported (stage 1)");
  return false;
}

/** PG rule: soapy hit by a strong wind turns into a bubble (object) */
function trySoapBubble(i: i32, x: i32, y: i32): bool {
  abort("trySoapBubble: not ported (stage 1)");
  return false;
}

function doMetalCool(i: i32, x: i32, y: i32): void {
  abort("doMetalCool: not ported (stage 1)");
}

function doSuperball(i: i32, x: i32, y: i32): void {
  abort("doSuperball: not ported (stage 1)");
}

function doBird(i: i32, x: i32, y: i32): void {
  abort("doBird: not ported (stage 1)");
}

function doCloud(i: i32, x: i32, y: i32): void {
  abort("doCloud: not ported (stage 1)");
}

function doLaser(i: i32, x: i32, y: i32): void {
  abort("doLaser: not ported (stage 1)");
}

function doThunder(i: i32, x: i32, y: i32): void {
  abort("doThunder: not ported (stage 1)");
}

function doRocket(i: i32, x: i32, y: i32): void {
  abort("doRocket: not ported (stage 1)");
}

function doPump(i: i32, x: i32, y: i32): void {
  abort("doPump: not ported (stage 1)");
}

function losClear(x0: i32, y0: i32, x1: i32, y1: i32): bool {
  abort("losClear: not ported (stage 1)");
  return false;
}

function coalesceCharge(cx: i32, cy: i32): i32 {
  abort("coalesceCharge: not ported (stage 1)");
  return 0;
}

function explode(cx: i32, cy: i32, r: i32): void {
  abort("explode: not ported (stage 1 — no explosives in scene)");
}
