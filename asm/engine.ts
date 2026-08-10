// AssemblyScript port of src/engine/world.ts — STAGE 1 (movement) +
// STAGE 2 (thermal transitions).
//
// PARITY DOCTRINE: this file is ported by REACHABILITY, not by feature. Every
// code path the oracle scenes can reach is ported EXACTLY — including rng
// draws whose results go unused. Stage 1: movement (powder/liquid, contact
// reactions, settle hysteresis, chunk gating). Stage 2: the temperature field
// (pumpHeat, stepTemp diffusion + hot/cold phase pass), gas movement (steam),
// and magma's hotContact4 scan. Stage 3: fire (doFire incl. smoke billow),
// the flammable/ignition pathways, and acid corrosion. Stage 4: everything
// else — explosions (explode/coalesceCharge/losClear + blastQueue/fxPower),
// ballistics (doBallistic), all devices (fan/clone/torch/pump/valve/detector/
// filter/cannon/laser/thunder), spark conduction + doMetalCool, rockets,
// soap bubbles, and the critter behaviors. ZERO abort() traps remain: every
// code path reachable from a paintable element is ported. Out-of-tick-loop
// surfaces (rawSet, serialize/deserialize, clear, fill*Tex) are not ported —
// they are host-side conveniences, not sim semantics.
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
const E_WATER: i32 = 3;
const E_FIRE: i32 = 5;
const E_STEAM: i32 = 7;
const E_SEED: i32 = 8;
const E_VINE: i32 = 9;
const E_ACID: i32 = 11;
const E_SALT: i32 = 13;
const E_SEAWATER: i32 = 14;
const E_MAGMA: i32 = 15;
const E_METAL: i32 = 20;
const E_VIRUS: i32 = 23;
const E_ANT: i32 = 24;
const E_SPARK: i32 = 26;
const E_CLONE: i32 = 27;
const E_FAN: i32 = 28;
const E_GLASS: i32 = 31;
const E_LASER: i32 = 35;
const E_THUNDER_ID: i32 = 36;
const E_FIREWORKS: i32 = 37;
const E_ROCKET: i32 = 38;
const E_STICK: i32 = 39;
const E_SUPERBALL: i32 = 32;
const E_PUMP: i32 = 43;
const E_SOAPY: i32 = 45;
const E_CHLORINE: i32 = 48;
const E_CO2: i32 = 50;
const E_RUST: i32 = 52;
const E_CANNON: i32 = 63;
const E_DETECTOR: i32 = 64;
const E_LITMUS: i32 = 69;
const E_COPPER: i32 = 74;
const E_GOLD: i32 = 75;
const E_TUNGSTEN: i32 = 76;
const E_VERDIGRIS: i32 = 77;
const E_SMOKE: i32 = 78;
const E_MAGNESIA: i32 = 81;
const E_SALTPETER: i32 = 55;
const E_LIMESTONE: i32 = 57;
const E_LIME: i32 = 58;

// static direction tables (World.OCT_DX/OCT_DY, DX4/DY4/OPP4, PREF4 flattened)
const OCT_DX = memory.data<i32>([1, 1, 0, -1, -1, -1, 0, 1]);
const OCT_DY = memory.data<i32>([0, 1, 1, 1, 0, -1, -1, -1]);
const DX4 = memory.data<i32>([1, -1, 0, 0]);
const DY4 = memory.data<i32>([0, 0, 1, -1]);
const OPP4 = memory.data<i32>([1, 0, 3, 2]);
// hop preference per travel direction: straight, the two perpendiculars, back
const PREF4 = memory.data<i32>([0, 2, 3, 1, 1, 2, 3, 0, 2, 0, 1, 3, 3, 0, 1, 2]);
// trySprout scan: below, above, left, right
const SPROUT_DX = memory.data<i32>([0, 0, -1, 1]);
const SPROUT_DY = memory.data<i32>([1, -1, 0, 0]);
// @ts-ignore: decorator
@inline function tbl(p: usize, k: i32): i32 { return load<i32>(p + (<usize>k << 2)); }

/** ECMAScript Math.round (round half toward +Infinity) — WASM/AS rounding
 *  intrinsics use nearest-even, which diverges on exact .5 boundaries */
// @ts-ignore: decorator
@inline function jsRound(x: f64): f64 {
  const f = Math.floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

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
// State is a pure u32 with wrapping add — matches TS, whose next() masks with
// `>>> 0` every draw. (Historical: TS once accumulated in an unbounded f64,
// which rounds past 2^53 (~4.92M draws) and forced this port to emulate the
// rounding; both engines were fixed together to textbook mulberry32.)

let rngS: u32 = 0;
let rngDraws: u32 = 0; // parity instrumentation: total next() calls

function rngNext(): f64 {
  rngDraws++;
  rngS += 0x6d2b79f5; // u32 wrapping add, same as TS `(s + 0x6d2b79f5) >>> 0`
  let t: u32 = rngS;
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
  return rngS;
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
// stage 2: temperature registry tables
let temp0P: usize = 0; // i16
let hotAtP: usize = 0; // i16 (32767 = no hot transition)
let hotToP: usize = 0; // u8
let coldAtP: usize = 0; // i16 (-32768 = no cold transition)
let coldToP: usize = 0; // u8
let ignitesAtP: usize = 0; // i16 (32767 = never)
let thermalP: usize = 0; // u8
// stage 4: conduction + litmus registry, fan trig tables (loader-filled from
// JS Math.cos/sin so the 256 quantized fan angles match V8 bit-for-bit)
let phP: usize = 0; // u8
let conductIdxP: usize = 0; // u8
let conductorIdsP: usize = 0; // u8 [4]
let cosTabP: usize = 0; // f64 [256]
let sinTabP: usize = 0; // f64 [256]
// stage 4: fans list, blast machinery, entity queues (World.fans/blastStack/
// blastQueue/bubbleQueue)
let fansP: usize = 0; // i32 [8192]
let blastStackP: usize = 0; // i32 [8192]
let blastQP: usize = 0; // i32 [96] as (cx, cy, r) triplets
let blastQLen: i32 = 0;
let bubbleQP: usize = 0; // i32 [32] cell indices
let bubbleQLen: i32 = 0;

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
@inline function BURNLIFE(id: i32): i32 { return u8At(burnlifeP, id); }
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
// @ts-ignore: decorator
@inline function TEMP0(id: i32): i32 { return <i32>load<i16>(temp0P + (<usize>id << 1)); }
// @ts-ignore: decorator
@inline function HOT_AT(id: i32): i32 { return <i32>load<i16>(hotAtP + (<usize>id << 1)); }
// @ts-ignore: decorator
@inline function HOT_TO(id: i32): i32 { return u8At(hotToP, id); }
// @ts-ignore: decorator
@inline function COLD_AT(id: i32): i32 { return <i32>load<i16>(coldAtP + (<usize>id << 1)); }
// @ts-ignore: decorator
@inline function COLD_TO(id: i32): i32 { return u8At(coldToP, id); }
// @ts-ignore: decorator
@inline function IGNITES_AT(id: i32): i32 { return <i32>load<i16>(ignitesAtP + (<usize>id << 1)); }
// @ts-ignore: decorator
@inline function THERMAL(id: i32): i32 { return u8At(thermalP, id); }
// @ts-ignore: decorator
@inline function PH(id: i32): i32 { return u8At(phP, id); }
// @ts-ignore: decorator
@inline function CONDUCT_IDX(id: i32): i32 { return u8At(conductIdxP, id); }
// @ts-ignore: decorator
@inline function CONDUCTOR_IDS(k: i32): i32 { return u8At(conductorIdsP, k); }

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
  temp0P = allocZ(N_IDS << 1);
  hotAtP = allocZ(N_IDS << 1);
  hotToP = allocZ(N_IDS);
  coldAtP = allocZ(N_IDS << 1);
  coldToP = allocZ(N_IDS);
  ignitesAtP = allocZ(N_IDS << 1);
  thermalP = allocZ(N_IDS);
  phP = allocZ(N_IDS);
  conductIdxP = allocZ(N_IDS);
  conductorIdsP = allocZ(4);
  cosTabP = allocZ(256 << 3);
  sinTabP = allocZ(256 << 3);
  fansP = allocZ(8192 << 2);
  blastStackP = allocZ(8192 << 2);
  blastQP = allocZ(96 << 2);
  blastQLen = 0;
  bubbleQP = allocZ(32 << 2);
  bubbleQLen = 0;
  rngS = seed; // constructor does `seed >>> 0` — loader passes u32
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
export function temp0Ptr(): usize { return temp0P; }
export function hotAtPtr(): usize { return hotAtP; }
export function hotToPtr(): usize { return hotToP; }
export function coldAtPtr(): usize { return coldAtP; }
export function coldToPtr(): usize { return coldToP; }
export function ignitesAtPtr(): usize { return ignitesAtP; }
export function thermalPtr(): usize { return thermalP; }
export function phPtr(): usize { return phP; }
export function conductIdxPtr(): usize { return conductIdxP; }
export function conductorIdsPtr(): usize { return conductorIdsP; }
export function cosTabPtr(): usize { return cosTabP; }
export function sinTabPtr(): usize { return sinTabP; }
export function getFxPower(): f64 { return fxPower; }
export function blastQueuePtr(): usize { return blastQP; }
export function blastQueueLen(): i32 { return blastQLen; }
export function bubbleQueuePtr(): usize { return bubbleQP; }
export function bubbleQueueLen(): i32 { return bubbleQLen; }
/** ObjectSystem drains the queues every tick in the game; the parity harness
 *  drains both engines after comparing so the caps stay in lockstep */
export function drainQueues(): void {
  blastQLen = 0;
  bubbleQLen = 0;
}

/** the adapter's JS arrays are the queue authority (ObjectSystem drains them
 *  with .length = 0); before each step/paint the adapter pushes the current
 *  JS lengths back in so the caps (96/32) see accumulated, undrained length */
export function syncQueueLens(blastLen: i32, bubbleLen: i32): void {
  blastQLen = blastLen < 0 ? 0 : blastLen > 96 ? 96 : blastLen;
  bubbleQLen = bubbleLen < 0 ? 0 : bubbleLen > 32 ? 32 : bubbleLen;
}

// pointers + dims for the adapter's field views (fill*Tex, windAt)
export function windVxPtr(): usize { return windVxP; }
export function windVyPtr(): usize { return windVyP; }
export function glowPtr(): usize { return glowP; }
export function tempPtr(): usize { return tempP; }

/** direct cell write for rigid-object footprints — bypasses paint rules */
export function rawSet(x: i32, y: i32, id: i32, shadeV: i32): void {
  const i = y * W + x;
  const old = species(i);
  if (old === id) return;
  if (old !== E_EMPTY && old !== E_WALL) dots--;
  if (id !== E_EMPTY && id !== E_WALL) dots++;
  speciesSet(i, id);
  shadeSet(i, shadeV);
  lifeSet(i, 0);
  vx8Set(i, 0);
  vy8Set(i, 0);
  wake(x, y);
}

/** mirror of World.clear() — resets grids/fields/fans/dots; deliberately does
 *  NOT touch frame, fxPower, wind/glow tick counters, rng, or bubbleQueue
 *  (the TS method leaves those too; the adapter clears its JS blastQueue) */
export function clearAll(): void {
  const n = W * H;
  memory.fill(speciesP, 0, <usize>n);
  memory.fill(shadeP, 0, <usize>n);
  memory.fill(lifeP, 0, <usize>n);
  memory.fill(clockP, 0, <usize>n);
  memory.fill(vx8P, 0, <usize>n);
  memory.fill(vy8P, 0, <usize>n);
  memory.fill(activeCurP, 1, <usize>(chunksX * chunksY));
  memory.fill(activeNextP, 1, <usize>(chunksX * chunksY));
  const wn = WXg * WYg;
  for (let i = 0; i < wn; i++) {
    f32Set(windVxP, i, 0);
    f32Set(windVyP, i, 0);
    f32Set(glowP, i, 0);
  }
  const tn = TWg * THg;
  for (let i = 0; i < tn; i++) f32Set(tempP, i, AMBIENT);
  memory.fill(thermalCurP, 0, <usize>(chunksX * chunksY));
  memory.fill(thermalNextP, 0, <usize>(chunksX * chunksY));
  fansLen = 0;
  blastQLen = 0; // adapter also empties its JS blastQueue (World.clear does)
  dots = 0;
}

/** mirror of the tail of World.deserialize(): the adapter unRLEs species+life
 *  into the views, then this recounts dots, regenerates shade (CONSUMES RNG —
 *  one byte per non-empty cell, same as TS), wakes all chunks, rebuilds the
 *  fan list, and re-seeds heat pumps */
export function postLoad(): void {
  const n = W * H;
  memory.fill(clockP, 0, <usize>n);
  memory.fill(vx8P, 0, <usize>n);
  memory.fill(vy8P, 0, <usize>n);
  memory.fill(activeCurP, 1, <usize>(chunksX * chunksY));
  memory.fill(activeNextP, 1, <usize>(chunksX * chunksY));
  fansLen = 0;
  dots = 0;
  const tn = TWg * THg;
  for (let i = 0; i < tn; i++) f32Set(tempP, i, AMBIENT);
  memory.fill(thermalCurP, 0, <usize>(chunksX * chunksY));
  memory.fill(thermalNextP, 0, <usize>(chunksX * chunksY));
  for (let i = 0; i < n; i++) {
    const id = species(i);
    if (id !== E_EMPTY) shadeSet(i, rngByte());
    if (id !== E_EMPTY && id !== E_WALL) dots++;
    if (id === E_FAN && fansLen < 8192) {
      store<i32>(fansP + (<usize>fansLen << 2), i);
      fansLen++;
    }
    if (HEAT_PUMP(id) > 0) {
      pumpHeat(i % W, i / W, <f64>TEMP0(id), 0.6);
    }
  }
}
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

// draw-sequence log: packs site(8b) | y(12b) | x(12b) per rng draw
// (stage 3 outgrew 4-bit site codes; grids up to 4096x4096 still fit)
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
  store<u32>(dbgSeqP + (<usize>dbgSeqLen_ << 2), <u32>((site << 24) | (y << 12) | x));
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
  // sparks track wire-born-ness in shade bit 0 (painted onto a conductor =
  // wire) and which conductor they were in bits 1-2
  if (id === E_SPARK) {
    shadeSet(i, CONDUCTS(old) > 0
      ? (shade(i) & 0xf8) | 1 | (CONDUCT_IDX(old) << 1)
      : shade(i) & 0xfe);
  }
  lifeSet(i, aux >= 0 ? aux : LIFE0(id));
  vx8Set(i, 0);
  vy8Set(i, 0);
  if (id === E_FAN && fansLen < 8192) {
    store<i32>(fansP + (<usize>fansLen << 2), i);
    fansLen++;
  }
  if (HEAT_PUMP(id) > 0) pumpHeat(x, y, <f64>TEMP0(id), 0.6); // seed the heat field
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
  // fan beams
  if (fansLen === 0) return;
  const stride = fansLen > MAX_FAN_BEAMS ? (fansLen + MAX_FAN_BEAMS - 1) / MAX_FAN_BEAMS : 1;
  const phase = frame % stride;
  let write = 0;
  for (let k = 0; k < fansLen; k++) {
    const i = load<i32>(fansP + (<usize>k << 2));
    if (species(i) !== E_FAN) continue; // erased — drop from list
    store<i32>(fansP + (<usize>write << 2), i);
    write++;
    if (k % stride !== phase) continue;
    const fx = (i % W) >> WSHIFT;
    const fy = (i / W) >> WSHIFT;
    // ang = (life/256) * PI * 2 — 256 quantized angles, cos/sin from the
    // loader-filled tables so they match V8's Math bit-for-bit
    const lb = life(i);
    const dx = load<f64>(cosTabP + (<usize>lb << 3));
    const dy = load<f64>(sinTabP + (<usize>lb << 3));
    for (let t = 1; t <= FAN_BEAM; t++) {
      const wx = <i32>jsRound(<f64>fx + dx * <f64>t);
      const wy = <i32>jsRound(<f64>fy + dy * <f64>t);
      if (wx < 0 || wy < 0 || wx >= WXg || wy >= WYg) break;
      const sx = (wx << WSHIFT) + 2;
      const sy = (wy << WSHIFT) + 2;
      if (species(sy * W + sx) === E_WALL) break;
      const p = 2.0 * (1.0 - <f64>t / <f64>FAN_BEAM) * <f64>stride;
      const wi = wy * WXg + wx;
      f32Set(windVxP, wi, max(-8.0, min(8.0, f32At(windVxP, wi) + dx * p)));
      f32Set(windVyP, wi, max(-8.0, min(8.0, f32At(windVyP, wi) + dy * p)));
      if ((t & 1) === 0) wake(sx, sy);
    }
  }
  fansLen = write;
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

/** drive the heat field at a sim cell toward `target` with strength k */
function pumpHeat(x: i32, y: i32, target: f64, k: f64): void {
  const tx = x >> TSHIFT;
  const ty = y >> TSHIFT;
  const ti = ty * TWg + tx;
  // TS: this.temp[ti] += (target - this.temp[ti]) * k — f32 load, f64 math,
  // f32 store
  const cur = f32At(tempP, ti);
  f32Set(tempP, ti, cur + (target - cur) * k);
  markThermalCoarse(tx, ty);
}

function stepTemp(): void {
  const swapP = thermalCurP;
  thermalCurP = thermalNextP;
  thermalNextP = swapP;
  memory.fill(thermalNextP, 0, <usize>(chunksX * chunksY));
  const cur = thermalCurP;
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) {
      if (!u8At(cur, cy * chunksX + cx)) continue;
      const tx0 = cx << 4;
      const ty0 = cy << 4;
      const tx1 = min(tx0 + 16, TWg);
      const ty1 = min(ty0 + 16, THg);
      for (let ty = ty0; ty < ty1; ty++) {
        const row = ty * TWg;
        for (let tx = tx0; tx < tx1; tx++) {
          const i = row + tx;
          // diffuse (in-place, clamped neighbors) + drift toward ambient.
          // t stays an f64 local (TS computes in doubles); only the store to
          // the Float32Array rounds — later comparisons use the UNROUNDED t.
          const l = tx > 0 ? f32At(tempP, i - 1) : AMBIENT;
          const r = tx < TWg - 1 ? f32At(tempP, i + 1) : AMBIENT;
          const u = ty > 0 ? f32At(tempP, i - TWg) : AMBIENT;
          const d = ty < THg - 1 ? f32At(tempP, i + TWg) : AMBIENT;
          let t = f32At(tempP, i) * 0.72 + (l + r + u + d) * 0.07;
          t += (AMBIENT - t) * 0.004;
          f32Set(tempP, i, t);
          if (t > AMBIENT + 2 || t < AMBIENT - 2) markThermalCoarse(tx, ty);
          else continue; // thermally boring cell: skip the phase scan
          // phase pass over this coarse cell's 2x2 sim cells
          const sx0 = tx << TSHIFT;
          const sy0 = ty << TSHIFT;
          for (let sy = sy0; sy < sy0 + 2; sy++) {
            const sRow = sy * W;
            for (let sx = sx0; sx < sx0 + 2; sx++) {
              const si = sRow + sx;
              const id = species(si);
              if (!THERMAL(id)) continue;
              // pump at most once per coarse cell so dense blocks don't overpower
              if (HEAT_PUMP(id) > 0 && sx === sx0 && sy === sy0) {
                const tg = <f64>TEMP0(id);
                const curT = f32At(tempP, i); // post-diffusion f32, not t
                f32Set(tempP, i, curT + (tg - curT) * HEAT_PUMP(id));
              }
              if (t >= <f64>IGNITES_AT(id)) {
                dbgLog(26, sx, sy);
                if (rngByte() < 60) {
                  if (id === E_FIREWORKS) {
                    set(si, sx, sy, E_ROCKET, LIFE0(E_ROCKET) + rngInt(16));
                  } else if (EXPLODE_R(id) > 0) {
                    explode(sx, sy, EXPLODE_R(id));
                  } else {
                    set(si, sx, sy, E_FIRE, BURNLIFE(id));
                  }
                  continue;
                }
              }
              if (t >= <f64>HOT_AT(id)) {
                const p = min(220.0, (t - <f64>HOT_AT(id)) * 6.0);
                dbgLog(11, sx, sy);
                if (<f64>rngByte() < p) {
                  const to = HOT_TO(id);
                  set(si, sx, sy, to, LIFE0(to));
                  dbgLog(12, sx, sy);
                  shadeSet(si, rngByte());
                }
              } else if (t <= <f64>COLD_AT(id)) {
                const p = min(180.0, (<f64>COLD_AT(id) - t) * 3.0);
                dbgLog(13, sx, sy);
                if (<f64>rngByte() < p) {
                  const to = COLD_TO(id);
                  set(si, sx, sy, to, LIFE0(to));
                  dbgLog(14, sx, sy);
                  shadeSet(si, rngByte());
                }
              }
            }
          }
        }
      }
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
  dbgLog(42, x, y);
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
    if (nx >= 0 && ny >= 0 && nx < W && species(ny * W + nx) === E_EMPTY) {
      dbgLog(42, x, y);
      if (rngByte() < 200) {
        swap(i, ny * W + nx, x, y, nx, ny);
        return true;
      }
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
  if (HEAT_PUMP(id) > 0) pumpHeat(x, y, <f64>TEMP0(id), HEAT_PUMP(id));
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

/** litmus indicator: sample the first pH-bearing neighbor into the shade
 *  byte (the shader renders litmus by shade as an indicator ramp), then
 *  fall like any powder */
function doLitmus(i: i32, x: i32, y: i32): void {
  for (let k = 0; k < 4; k++) {
    const nx = x + tbl(DX4, k);
    const ny = y + tbl(DY4, k);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const p = PH(species(ny * W + nx));
    if (p !== 255) {
      if (shade(i) !== p) {
        shadeSet(i, p);
        wake(x, y);
      }
      break;
    }
  }
  doPowder(i, x, y, E_LITMUS);
}

/** integrate a flying grain: gravity + drag, walk its velocity vector,
 *  punch through fluids with damping, transfer momentum on hard impact.
 *  Velocity is fixed-point x16; below one cell/tick it hands back to the
 *  normal behavior pass. */
function doBallistic(i: i32, x: i32, y: i32, id: i32): void {
  const b = BEHAVIOR(id);
  if (b !== B_POWDER && b !== B_LIQUID && b !== B_SUPERBALL && b !== B_VIRUS && b !== B_ANT) {
    vx8Set(i, 0);
    vy8Set(i, 0);
    return; // static/gas/energy cells don't carry ballistic velocity
  }
  let vx = vx8(i);
  let vy = max(-120, min(120, vy8(i) + 3)); // gravity
  vx = (vx * 31) >> 5; // light drag (~3%/tick)
  const adx = vx < 0 ? -vx : vx;
  const ady = vy < 0 ? -vy : vy;
  const n = (adx > ady ? adx : ady) >> 4;
  if (n === 0) {
    vx8Set(i, 0);
    vy8Set(i, 0);
    wake(x, y); // back to normal falling next tick
    return;
  }
  const sx = vx > 0 ? 1 : -1;
  const sy = vy > 0 ? 1 : -1;
  let cx = x;
  let cy = y;
  let ci = i;
  let err = 0;
  for (let s = 0; s < n; s++) {
    let nx = cx;
    let ny = cy;
    if (adx >= ady) {
      nx += sx;
      err += ady;
      if (err >= adx) { ny += sy; err -= adx; }
    } else {
      ny += sy;
      err += adx;
      if (err >= ady) { nx += sx; err -= ady; }
    }
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
      vx = 0; vy = 0;
      break;
    }
    const j = ny * W + nx;
    const o = species(j);
    const ob = BEHAVIOR(o);
    if (o === E_EMPTY || ob === B_FIRE) {
      // fire is hot air, not an obstacle — debris flies THROUGH the fireball
      swap(ci, j, cx, cy, nx, ny);
      ci = j; cx = nx; cy = ny;
      continue;
    }
    if ((ob === B_LIQUID || ob === B_GAS) && DENSITY(id) > DENSITY(o)) {
      // punch through fluid, losing half the speed per cell (splash drag)
      swap(ci, j, cx, cy, nx, ny);
      ci = j; cx = nx; cy = ny;
      vx = vx / 2;
      vy = vy / 2;
      continue;
    }
    // hard impact into a movable target
    if ((ob === B_POWDER || ob === B_SUPERBALL) && (adx > 24 || ady > 24)) {
      const tvx = vx8(j);
      const tvy = vy8(j);
      const tv = (tvx < 0 ? -tvx : tvx) + (tvy < 0 ? -tvy : tvy);
      if (tv > 24) {
        // the target is already flying the same blast — hold formation and
        // retry next tick; whole columns launch coherently instead of
        // grinding their momentum away against each other
        break;
      }
      // resting target: spring-chain — hand over most, keep pushing
      vx8Set(j, (vx * 7) / 8);
      vy8Set(j, (vy * 7) / 8);
      wake(nx, ny);
      vx = vx / 2;
      vy = vy / 2;
    } else {
      vx = 0; vy = 0;
    }
    break;
  }
  vx8Set(ci, vx);
  vy8Set(ci, vy);
  wake(cx, cy);
}

/** sparked cannon: consume one movable cell at the breech (opposite the
 *  aim), launch it from the muzzle at ~5.6 cells/tick */
function doCannon(i: i32, x: i32, y: i32): void {
  let sparked = false;
  for (let k = 0; k < 4; k++) {
    const nx = x + tbl(DX4, k);
    const ny = y + tbl(DY4, k);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (species(ny * W + nx) === E_SPARK) { sparked = true; break; }
  }
  if (!sparked) return;
  wake(x, y);
  const d = ((life(i) + 16) >> 5) & 7; // pen-stroke angle byte -> 8-dir
  const dx = tbl(OCT_DX, d);
  const dy = tbl(OCT_DY, d);
  let mx = x + dx;
  let my = y + dy;
  while (mx >= 0 && my >= 0 && mx < W && my < H && species(my * W + mx) === E_CANNON) {
    mx += dx; my += dy;
  }
  if (mx < 0 || my < 0 || mx >= W || my >= H || species(my * W + mx) !== E_EMPTY) return;
  let bx = x - dx;
  let by = y - dy;
  while (bx >= 0 && by >= 0 && bx < W && by < H && species(by * W + bx) === E_CANNON) {
    bx -= dx; by -= dy;
  }
  // breech suction: reach across a small gap so hoppers keep feeding
  let gap = 0;
  while (gap < 4 && bx >= 0 && by >= 0 && bx < W && by < H && species(by * W + bx) === E_EMPTY) {
    bx -= dx; by -= dy; gap++;
  }
  if (bx < 0 || by < 0 || bx >= W || by >= H) return;
  const bi = by * W + bx;
  const load_ = species(bi);
  const lb = BEHAVIOR(load_);
  if (lb !== B_POWDER && lb !== B_LIQUID && lb !== B_SUPERBALL) return;
  const mi = my * W + mx;
  const keepLife = life(bi);
  const keepShade = shade(bi);
  set(mi, mx, my, load_, keepLife);
  shadeSet(mi, keepShade);
  vx8Set(mi, dx * 90);
  vy8Set(mi, dy * 90 - 4);
  set(bi, bx, by, E_EMPTY, 0);
}

/** detector: memorizes the first substance that touches it (wires and
 *  devices excluded); afterwards emits free sparks whenever that substance
 *  is in contact — the chemical→electrical sensor */
function doDetector(i: i32, x: i32, y: i32): void {
  if (life(i) === 0) {
    for (let k = 0; k < 4; k++) {
      const nx = x + tbl(DX4, k);
      const ny = y + tbl(DY4, k);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const o = species(ny * W + nx);
      if (o !== E_EMPTY && o !== E_WALL && o !== E_CLONE && o !== E_FAN &&
          o !== E_DETECTOR && o !== E_METAL && o !== E_SPARK && o !== E_STICK) {
        lifeSet(i, o);
        break;
      }
    }
    wake(x, y); // stay alert until primed
    return;
  }
  let touching = false;
  for (let k = 0; k < 4; k++) {
    const nx = x + tbl(DX4, k);
    const ny = y + tbl(DY4, k);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (species(ny * W + nx) === life(i)) { touching = true; break; }
  }
  if (!touching) return;
  wake(x, y);
  dbgLog(38, x, y);
  if (rngByte() >= 40) return; // pulse rate limit
  for (let k = 0; k < 4; k++) {
    const nx = x + tbl(DX4, k);
    const ny = y + tbl(DY4, k);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (species(j) === E_EMPTY) {
      set(j, nx, ny, E_SPARK, LIFE0(E_SPARK));
      dbgLog(38, x, y);
      shadeSet(j, rngByte() & 0xfe); // free spark, not wire-born
      return;
    }
  }
}

/** valve: solid drop-gate; a spark opens it for 24 ticks, during which
 *  material directly above falls through to the cell below */
function doValve(i: i32, x: i32, y: i32): void {
  for (let k = 0; k < 4; k++) {
    const nx = x + tbl(DX4, k);
    const ny = y + tbl(DY4, k);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (species(ny * W + nx) === E_SPARK) { lifeSet(i, 24); break; }
  }
  if (life(i) === 0) return;
  lifeSet(i, life(i) - 1);
  wake(x, y);
  if (y === 0 || y + 1 >= H) return;
  const above = i - W;
  const below = i + W;
  const o = species(above);
  const ob = BEHAVIOR(o);
  if ((ob === B_POWDER || ob === B_LIQUID || ob === B_SUPERBALL) && species(below) === E_EMPTY) {
    const keepLife = life(above);
    const keepShade = shade(above);
    set(below, x, y + 1, o, keepLife);
    shadeSet(below, keepShade);
    set(above, x, y - 1, E_EMPTY, 0);
  }
}

/** filter mesh: light gases pass upward, heavy gases (CO2/chlorine) pass
 *  downward; liquids and powders are blocked */
function doFilter(i: i32, x: i32, y: i32): void {
  if (y === 0 || y + 1 >= H) return;
  const above = i - W;
  const below = i + W;
  if (BEHAVIOR(species(below)) === B_GAS && species(above) === E_EMPTY) {
    const o = species(below);
    const keepLife = life(below);
    const keepShade = shade(below);
    set(above, x, y - 1, o, keepLife);
    shadeSet(above, keepShade);
    set(below, x, y + 1, E_EMPTY, 0);
    return;
  }
  const oa = species(above);
  if ((oa === E_CO2 || oa === E_CHLORINE) && species(below) === E_EMPTY) {
    const keepLife = life(above);
    const keepShade = shade(above);
    set(below, x, y + 1, oa, keepLife);
    shadeSet(below, keepShade);
    set(above, x, y - 1, E_EMPTY, 0);
  }
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
  if (id === E_ACID && doCorrode(i, x, y)) return;
  if (id === E_MAGMA) hotContact4(x, y);
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
  if (LIFE0(id) > 0) {
    if (life(i) === 0) {
      // TS: `id === E.STEAM && byte() < 77` — byte drawn only for steam
      let toWater = false;
      if (id === E_STEAM) {
        dbgLog(6, x, y);
        toWater = rngByte() < 77;
      }
      if (toWater) {
        set(i, x, y, E_WATER, 0);
        dbgLog(7, x, y);
        shadeSet(i, rngByte());
      } else {
        set(i, x, y, E_EMPTY, 0);
      }
      return;
    }
    lifeSet(i, life(i) - 1);
    wake(x, y);
  }
  if (tryWindPush(i, x, y, 0.35)) return;
  if (y - 1 >= 0) {
    dbgLog(8, x, y);
    if (rngByte() < 200) {
      const up = i - W;
      dbgLog(9, x, y);
      const dx = rngInt(3) - 1;
      const nx = x + dx;
      if (nx >= 0 && nx < W && species(up + dx) === E_EMPTY) {
        swap(i, up + dx, x, y, nx, y - 1);
        return;
      }
      if (species(up) === E_EMPTY) {
        swap(i, up, x, y, x, y - 1);
        return;
      }
    }
  }
  dbgLog(10, x, y);
  const dir = rngBool() ? 1 : -1;
  const nx = x + dir;
  if (nx >= 0 && nx < W && species(i + dir) === E_EMPTY) {
    swap(i, i + dir, x, y, nx, y);
  }
}

/** ignite/melt scan over 4 neighbors — shared by magma, torch, spark */
function hotContact4(x: i32, y: i32): void {
  for (let k = 0; k < 4; k++) {
    const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
    const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    const o = species(j);
    const fl = FLAMMABLE(o);
    if (fl > 0) {
      dbgLog(22, x, y);
      if (rngByte() < fl) {
        if (o === E_FIREWORKS) {
          set(j, nx, ny, E_ROCKET, LIFE0(E_ROCKET) + rngInt(16));
        } else if (EXPLODE_R(o) > 0) {
          explode(nx, ny, EXPLODE_R(o));
        } else {
          set(j, nx, ny, E_FIRE, BURNLIFE(o));
          dbgLog(23, x, y);
          shadeSet(j, rngByte());
        }
      }
    }
  }
}

function doFire(i: i32, x: i32, y: i32): void {
  if (life(i) === 0) {
    set(i, x, y, E_EMPTY, 0);
    return;
  }
  lifeSet(i, life(i) - 1);
  wake(x, y);
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= W) continue;
      const j = ny * W + nx;
      const o = species(j);
      if (o === E_WATER || o === E_SEAWATER) {
        dbgLog(15, x, y);
        if (rngByte() < 77) set(j, nx, ny, E_STEAM, LIFE0(E_STEAM));
        set(i, x, y, E_EMPTY, 0);
        return;
      }
      const fl = FLAMMABLE(o);
      if (fl > 0) {
        dbgLog(16, x, y);
        if (rngByte() < fl) {
          if (o === E_FIREWORKS) {
            set(j, nx, ny, E_ROCKET, LIFE0(E_ROCKET) + rngInt(16));
          } else if (EXPLODE_R(o) > 0) {
            explode(nx, ny, EXPLODE_R(o));
          } else {
            set(j, nx, ny, E_FIRE, BURNLIFE(o));
            dbgLog(17, x, y);
            shadeSet(j, rngByte());
          }
        }
      }
    }
  }
  if (tryWindPush(i, x, y, 0.3)) return;
  if (y - 1 >= 0) {
    dbgLog(18, x, y);
    if (rngByte() < 150) {
      dbgLog(19, x, y);
      const dx = rngInt(3) - 1;
      const nx = x + dx;
      if (nx >= 0 && nx < W && species(i - W + dx) === E_EMPTY) {
        swap(i, i - W + dx, x, y, nx, y - 1);
        return;
      }
    }
  }
  // billow smoke: burning things smudge the sky
  if (y - 1 >= 0) {
    dbgLog(20, x, y);
    if (rngByte() < 7 && species(i - W) === E_EMPTY) {
      set(i - W, x, y - 1, E_SMOKE, LIFE0(E_SMOKE));
      dbgLog(21, x, y);
      shadeSet(i - W, rngByte());
    }
  }
}

function doVine(i: i32, x: i32, y: i32): void {
  if (life(i) === 0) return;
  dbgLog(35, x, y);
  if (rngByte() < 40) {
    dbgLog(35, x, y);
    const dx = rngInt(3) - 1;
    const nx = x + dx;
    const ny = y - 1;
    if (nx >= 0 && nx < W && ny >= 0) {
      const j = ny * W + nx;
      if (species(j) === E_EMPTY) {
        set(j, nx, ny, E_VINE, life(i) - 1);
        dbgLog(35, x, y);
        shadeSet(j, rngByte());
      } else {
        lifeSet(i, 0);
      }
    }
  }
  wake(x, y);
}

function doEmitter(i: i32, x: i32, y: i32): void {
  hotContact4(x, y);
  dbgLog(29, x, y);
  if (rngByte() < 60) {
    dbgLog(29, x, y);
    const dx = rngInt(3) - 1;
    const nx = x + dx;
    const ny = y - 1;
    if (nx >= 0 && nx < W && ny >= 0) {
      const j = ny * W + nx;
      if (species(j) === E_EMPTY) {
        set(j, nx, ny, E_FIRE, LIFE0(E_FIRE));
        dbgLog(29, x, y);
        shadeSet(j, rngByte());
      }
    }
  }
  wake(x, y); // torches never sleep
}

function doSpark(i: i32, x: i32, y: i32): void {
  hotContact4(x, y);
  let metalNear = false;
  for (let k = 0; k < 4; k++) {
    const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
    const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    const o = species(j);
    if (CONDUCTS(o) > 0) {
      metalNear = true;
      // refractory metal (life > 0, still cooling) can't re-spark — keeps the
      // pulse a thin traveling dot instead of saturating the whole wire
      if (life(j) === 0) {
        dbgLog(27, x, y);
        if (rngByte() < 250) {
          set(j, nx, ny, E_SPARK, LIFE0(E_SPARK));
          // wire-born + remember WHICH conductor this cell restores to
          dbgLog(27, x, y);
          shadeSet(j, (rngByte() & 0xf8) | 1 | (CONDUCT_IDX(o) << 1));
        }
      }
    } else if (o === E_SPARK) metalNear = true;
  }
  if (life(i) === 0) {
    // only wire-born sparks restore to their conductor — a free spark that
    // dies next to a wire must not weld a stub onto it (entombs pulsers)
    const wireborn = metalNear && (shade(i) & 1) === 1;
    if (wireborn) {
      const cid = CONDUCTOR_IDS((shade(i) >> 1) & 3);
      set(i, x, y, cid, CONDUCTS(cid));
    } else {
      set(i, x, y, E_EMPTY, 0);
    }
    return;
  }
  lifeSet(i, life(i) - 1);
  wake(x, y);
}

function doClone(i: i32, x: i32, y: i32): void {
  if (life(i) === 0) {
    // memorize the first touching element
    for (let k = 0; k < 4; k++) {
      const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
      const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const o = species(ny * W + nx);
      if (o !== E_EMPTY && o !== E_WALL && o !== E_CLONE && o !== E_FAN) {
        lifeSet(i, o);
        break;
      }
    }
  } else {
    dbgLog(28, x, y);
    if (rngByte() < 40) {
      dbgLog(28, x, y);
      const k = rngInt(4);
      const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
      const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
        const j = ny * W + nx;
        if (species(j) === E_EMPTY) {
          const cid = life(i);
          set(j, nx, ny, cid, LIFE0(cid));
          dbgLog(28, x, y);
          shadeSet(j, cid === E_SPARK ? rngByte() & 0xfe : rngByte());
        }
      }
    }
  }
  wake(x, y); // clones never sleep
}

/** doAnt's digInto closure: walk into empty, or tunnel through a powder */
function antDigInto(i: i32, x: i32, y: i32, j: i32, nx: i32, ny: i32): bool {
  const o = species(j);
  if (o === E_EMPTY) {
    swap(i, j, x, y, nx, ny);
    return true;
  }
  if (BEHAVIOR(o) === B_POWDER && o !== E_ANT) {
    // tunnel: consume the grain, leave a gap behind
    set(j, nx, ny, E_ANT, life(i));
    shadeSet(j, shade(i));
    set(i, x, y, E_EMPTY, 0);
    return true;
  }
  return false;
}

function doAnt(i: i32, x: i32, y: i32): void {
  // gravity first
  if (y + 1 < H && species(i + W) === E_EMPTY) {
    swap(i, i + W, x, y, x, y + 1);
    return;
  }
  let dir = life(i) === 1 ? 1 : -1;
  dbgLog(30, x, y);
  if (rngByte() < 12) {
    dir = -dir;
    lifeSet(i, dir === 1 ? 1 : 0);
  }
  const nx = x + dir;
  if (nx >= 0 && nx < W) {
    // occasionally dig downward, else walk/dig ahead, else climb
    if (y + 1 < H) {
      dbgLog(30, x, y);
      if (rngByte() < 25 && antDigInto(i, x, y, i + W + dir, nx, y + 1)) return;
    }
    if (antDigInto(i, x, y, i + dir, nx, y)) return;
    if (y - 1 >= 0 && antDigInto(i, x, y, i - W + dir, nx, y - 1)) return;
  }
  lifeSet(i, life(i) === 1 ? 0 : 1); // blocked: turn around
  wake(x, y);
}

function doVirus(i: i32, x: i32, y: i32): void {
  if (life(i) === 0) {
    set(i, x, y, E_EMPTY, 0);
    return;
  }
  lifeSet(i, life(i) - 1);
  dbgLog(31, x, y);
  const k = rngInt(4);
  const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
  const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
  const nx = x + dx;
  const ny = y + dy;
  if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
    const j = ny * W + nx;
    const o = species(j);
    if (o !== E_EMPTY && o !== E_WALL && o !== E_VIRUS && o !== E_CLONE && o !== E_FAN) {
      dbgLog(31, x, y);
      if (rngByte() < 50) {
        set(j, nx, ny, E_VIRUS, LIFE0(E_VIRUS));
        dbgLog(31, x, y);
        shadeSet(j, rngByte());
      }
    }
  }
  wake(x, y);
  // falls like powder
  if (y + 1 < H && sinksInto(E_VIRUS, i + W)) {
    swap(i, i + W, x, y, x, y + 1);
  }
}

function trySprout(i: i32, x: i32, y: i32): bool {
  for (let k = 0; k < 4; k++) {
    const nx = x + tbl(SPROUT_DX, k);
    const ny = y + tbl(SPROUT_DY, k);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = k === 0 ? i + W : k === 1 ? i - W : k === 2 ? i - 1 : i + 1;
    if (species(j) === E_WATER) {
      set(j, nx, ny, E_EMPTY, 0);
      set(i, x, y, E_VINE, LIFE0(E_VINE));
      return true;
    }
  }
  return false;
}

function doCorrode(i: i32, x: i32, y: i32): bool {
  if (life(i) === 0) {
    set(i, x, y, E_EMPTY, 0);
    return true;
  }
  dbgLog(24, x, y);
  const k = rngInt(4);
  const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
  const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
  const j = ny * W + nx;
  const o = species(j);
  // the water family is corrosion-proof so neutralization products survive,
  // and gases bubble through acid unharmed (CO2/chlorine are liquid-encoded)
  if (o === E_WATER || o === E_SEAWATER || o === E_SALT) return false;
  if (o === E_SALTPETER) return false; // nitrate salt resists its own acid
  if (BEHAVIOR(o) === B_GAS || o === E_CO2 || o === E_CHLORINE) return false;
  if (o === E_LITMUS) return false; // the instrument survives to show pH 1
  if (o === E_GOLD || o === E_COPPER || o === E_TUNGSTEN) return false; // noble
  // MgO dissolving in acid IS the antacid reaction — let the REACT row do it
  // (salt + water, acid consumed) instead of corrosion deleting the powder
  if (o === E_MAGNESIA) return false;
  // same rule for the lime family: dissolving in acid IS their REACT row
  // (salt + water / marble fizz, acid consumed) — not free corrosion
  if (o === E_LIME || o === E_LIMESTONE) return false;
  if (o !== E_EMPTY && o !== E_WALL && o !== E_ACID && o !== E_FIRE) {
    dbgLog(25, x, y);
    if (rngByte() < 60) {
      set(j, nx, ny, E_EMPTY, 0);
      lifeSet(i, life(i) - 1);
      wake(x, y);
      return true;
    }
  }
  return false;
}

/** PG rule: soapy hit by a strong wind turns into a bubble (object) */
function trySoapBubble(i: i32, x: i32, y: i32): bool {
  const wi = (y >> WSHIFT) * WXg + (x >> WSHIFT);
  const wvx = f32At(windVxP, wi);
  const wvy = f32At(windVyP, wi);
  const m = (wvx < 0 ? -wvx : wvx) + (wvy < 0 ? -wvy : wvy);
  if (m < 2.5 || bubbleQLen >= 32) return false;
  dbgLog(43, x, y);
  if (rngByte() >= 10) return false;
  set(i, x, y, E_EMPTY, 0);
  store<i32>(bubbleQP + (<usize>bubbleQLen << 2), i);
  bubbleQLen++;
  return true;
}

/** metal cooling after a spark passed — refractory period, then conductive again */
function doMetalCool(i: i32, x: i32, y: i32): void {
  if (life(i) > 0) {
    lifeSet(i, life(i) - 1);
    wake(x, y);
  }
  // waterline corrosion: needs BOTH seawater and air — submerged electrodes
  // and tank bottoms are safe, the splash zone slowly crumbles. Iron rusts,
  // copper patinas green; gold and tungsten never corrode.
  const me = species(i);
  const corrodesTo = me === E_METAL ? E_RUST : me === E_COPPER ? E_VERDIGRIS : 0;
  if (corrodesTo !== 0) {
    dbgLog(40, x, y);
    if (rngByte() < 3) {
      let sea = false;
      let air = false;
      for (let k = 0; k < 4; k++) {
        const nx = x + tbl(DX4, k);
        const ny = y + tbl(DY4, k);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const o = species(ny * W + nx);
        if (o === E_SEAWATER) sea = true;
        else if (o === E_EMPTY) air = true;
      }
      if (sea && air) {
        dbgLog(40, x, y);
        if (rngByte() < 24) {
          set(i, x, y, corrodesTo, 0);
          dbgLog(40, x, y);
          shadeSet(i, rngByte());
        }
      }
    }
  }
}

function doSuperball(i: i32, x: i32, y: i32): void {
  if (life(i) > 0) {
    // rising phase of a bounce
    lifeSet(i, life(i) - 1);
    if (y - 1 >= 0 && species(i - W) === E_EMPTY) {
      swap(i, i - W, x, y, x, y - 1);
    } else {
      lifeSet(i, 0);
    }
    wake(x, y);
    return;
  }
  if (y + 1 >= H) {
    dbgLog(34, x, y);
    lifeSet(i, 8 + rngInt(8));
    wake(x, y);
    return;
  }
  const below = i + W;
  if (sinksInto(E_SUPERBALL, below)) {
    swap(i, below, x, y, x, y + 1);
    return;
  }
  if (BEHAVIOR(species(below)) !== B_GAS) {
    dbgLog(34, x, y);
    lifeSet(i, 8 + rngInt(8)); // landed: bounce back up
    wake(x, y);
  }
}

function doBird(i: i32, x: i32, y: i32): void {
  wake(x, y); // birds never sleep
  let dirx = (life(i) & 1) === 1 ? 1 : -1;
  dbgLog(32, x, y);
  if (rngByte() < 8) {
    dirx = -dirx;
    lifeSet(i, life(i) ^ 1);
  }
  dbgLog(32, x, y);
  let dy = rngInt(3) - 1;
  // ground avoidance: climb when something solid is within 2 cells below
  const nearGround =
    (y + 1 < H && species(i + W) !== E_EMPTY) || (y + 2 < H && species(i + 2 * W) !== E_EMPTY);
  if (nearGround) dy = -1;
  const nx = x + dirx;
  const ny = y + dy;
  if (nx >= 0 && ny >= 0 && nx < W && ny < H && species(ny * W + nx) === E_EMPTY) {
    swap(i, ny * W + nx, x, y, nx, ny);
    return;
  }
  if (nx >= 0 && nx < W && species(i + dirx) === E_EMPTY) {
    swap(i, i + dirx, x, y, nx, y);
    return;
  }
  lifeSet(i, life(i) ^ 1); // blocked: turn around
}

function doCloud(i: i32, x: i32, y: i32): void {
  // floats in place; occasionally rains itself out
  dbgLog(33, x, y);
  if (rngByte() < 3 && y + 1 < H) {
    const below = i + W;
    if (species(below) === E_EMPTY) {
      set(below, x, y + 1, E_WATER, 0);
      dbgLog(33, x, y);
      shadeSet(below, rngByte());
      dbgLog(33, x, y);
      if (rngByte() < 80) {
        set(i, x, y, E_EMPTY, 0);
        return;
      }
    }
  }
  wake(x, y);
}

/** life packs direction in bits 5-7; beams fly until they hit or leave the grid */
function doLaser(i: i32, x: i32, y: i32): void {
  const lf = life(i);
  const d = lf >>> 5;
  const dx = tbl(OCT_DX, d);
  const dy = tbl(OCT_DY, d);
  let cx = x;
  let cy = y;
  let ci = i;
  set(ci, cx, cy, E_EMPTY, 0);
  for (let hop = 0; hop < 3; hop++) {
    let nx = cx + dx;
    let ny = cy + dy;
    // glass is transparent to lasers
    while (nx >= 0 && ny >= 0 && nx < W && ny < H && species(ny * W + nx) === E_GLASS) {
      nx += dx;
      ny += dy;
    }
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
    const j = ny * W + nx;
    const o = species(j);
    if (o === E_EMPTY) {
      cx = nx;
      cy = ny;
      ci = j;
      continue;
    }
    if (o === E_FIREWORKS) {
      dbgLog(39, x, y);
      set(j, nx, ny, E_ROCKET, LIFE0(E_ROCKET) + rngInt(16));
    } else if (EXPLODE_R(o) > 0) explode(nx, ny, EXPLODE_R(o));
    else if (FLAMMABLE(o) > 0) set(j, nx, ny, E_FIRE, BURNLIFE(o));
    else pumpHeat(nx, ny, 900, 0.5); // laser heat melts/boils via the field
    return; // hit something: beam ends
  }
  set(ci, cx, cy, E_LASER, lf);
}

function doThunder(i: i32, x: i32, y: i32): void {
  let cy = y;
  let ci = i;
  set(ci, x, cy, E_EMPTY, 0);
  for (let s = 0; s < 6; s++) {
    if (cy + 1 >= H) return; // grounded off-screen
    const j = ci + W;
    const o = species(j);
    if (o === E_EMPTY) {
      ci = j;
      cy++;
      continue;
    }
    if (CONDUCTS(o) > 0) {
      set(j, x, cy + 1, E_SPARK, LIFE0(E_SPARK));
      shadeSet(j, (shade(j) & 0xf8) | 1 | (CONDUCT_IDX(o) << 1));
    } else explode(x, cy + 1, 4);
    return;
  }
  set(ci, x, cy, E_THUNDER_ID, 0);
}

function doRocket(i: i32, x: i32, y: i32): void {
  wake(x, y);
  if (life(i) === 0 || y - 1 < 0) {
    explode(x, y, 6);
    return;
  }
  lifeSet(i, life(i) - 1);
  dbgLog(36, x, y);
  const dx = rngInt(3) - 1;
  const nx = x + dx;
  const j = (y - 1) * W + nx;
  if (nx >= 0 && nx < W && species(j) === E_EMPTY) {
    swap(i, j, x, y, nx, y - 1);
    dbgLog(36, x, y);
    if (rngByte() < 150) {
      dbgLog(36, x, y);
      const fl = 12 + rngInt(10);
      set(i, x, y, E_FIRE, fl);
      dbgLog(36, x, y);
      shadeSet(i, rngByte());
    }
    return;
  }
  if (species(i - W) !== E_EMPTY) explode(x, y, 6); // nose blocked
}

/** pump: life holds the carried species (full byte — ids can exceed 63);
 *  the travel direction lives in the shade byte's low 2 bits (a ±3/255 tint,
 *  invisible). Adjacent liquids/gases are absorbed; the token walks the pump
 *  line with momentum (one hop per tick) and ejects where the line ends —
 *  one clear dot beyond the pump so it can't instantly re-enter. */
function doPump(i: i32, x: i32, y: i32): void {
  const carried = life(i);
  if (carried === 0) {
    for (let k = 0; k < 4; k++) {
      const nx = x + tbl(DX4, k);
      const ny = y + tbl(DY4, k);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      const b = BEHAVIOR(species(j));
      if (b === B_LIQUID || b === B_GAS) {
        lifeSet(i, species(j));
        shadeSet(i, (shade(i) & 0xfc) | tbl(OPP4, k));
        set(j, nx, ny, E_EMPTY, 0);
        wake(x, y);
        return;
      }
    }
    return; // idle pump: its chunk may sleep
  }
  const prefBase = (shade(i) & 3) << 2;
  for (let p = 0; p < 4; p++) {
    const d = tbl(PREF4, prefBase + p);
    const nx = x + tbl(DX4, d);
    const ny = y + tbl(DY4, d);
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (species(j) === E_PUMP && life(j) === 0) {
      lifeSet(j, carried);
      shadeSet(j, (shade(j) & 0xfc) | d);
      lifeSet(i, 0);
      clockSet(j, stamp); // one hop per tick
      wake(nx, ny);
      wake(x, y);
      return;
    }
  }
  // line ends here: eject into the world, preferring the travel direction
  for (let p = 0; p < 4; p++) {
    const d = tbl(PREF4, prefBase + p);
    const dx = tbl(DX4, d);
    const dy = tbl(DY4, d);
    const n1x = x + dx;
    const n1y = y + dy;
    if (n1x < 0 || n1y < 0 || n1x >= W || n1y >= H) continue;
    if (species(n1y * W + n1x) !== E_EMPTY) continue;
    const n2x = n1x + dx;
    const n2y = n1y + dy;
    const far = n2x >= 0 && n2y >= 0 && n2x < W && n2y < H && species(n2y * W + n2x) === E_EMPTY;
    const ex = far ? n2x : n1x;
    const ey = far ? n2y : n1y;
    const j = ey * W + ex;
    set(j, ex, ey, carried, LIFE0(carried));
    dbgLog(37, x, y);
    shadeSet(j, rngByte());
    lifeSet(i, 0);
    wake(x, y);
    return;
  }
  wake(x, y); // stuck holding fluid: stay awake until space frees up
}

/** straight line from the blast center, walls block — this is what makes a
 *  wall barrel a CANNON: the pressure only travels up the open bore.
 *  Exported: ObjectSystem uses it for blast shielding via the adapter. */
export function losClear(x0: i32, y0: i32, x1: i32, y1: i32): bool {
  const dx = x1 > x0 ? x1 - x0 : x0 - x1;
  const dy = y1 > y0 ? y1 - y0 : y0 - y1;
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (x !== x1 || y !== y1) {
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (species(y * W + x) === E_WALL && !(x === x1 && y === y1)) return false;
  }
  return true;
}

/** consume the whole CONNECTED explosive charge at the blast site and
 *  return its yield — one keg, one unified boom. Mass makes the bang. */
function coalesceCharge(cx: i32, cy: i32): i32 {
  const start = cy * W + cx;
  if (EXPLODE_R(species(start)) === 0) return 0;
  let sp = 0;
  let yieldSum = 0;
  store<i32>(blastStackP, start);
  sp++;
  let pops = 0;
  while (sp > 0 && pops < 4000) {
    sp--;
    const i = load<i32>(blastStackP + (<usize>sp << 2));
    const id = species(i);
    if (EXPLODE_R(id) === 0) continue;
    pops++;
    yieldSum += EXPLODE_R(id);
    const x = i % W;
    const y = i / W;
    set(i, x, y, E_EMPTY, 0); // consumed as propellant (marks visited)
    if (x + 1 < W && sp < 8188) { store<i32>(blastStackP + (<usize>sp << 2), i + 1); sp++; }
    if (x > 0 && sp < 8188) { store<i32>(blastStackP + (<usize>sp << 2), i - 1); sp++; }
    if (y + 1 < H && sp < 8188) { store<i32>(blastStackP + (<usize>sp << 2), i + W); sp++; }
    if (y > 0 && sp < 8188) { store<i32>(blastStackP + (<usize>sp << 2), i - W); sp++; }
  }
  return yieldSum;
}

function explode(cx: i32, cy: i32, r: i32): void {
  // the bigger the charge, the bigger the boom: connected explosive mass
  // scales the blast radius (sqrt law), up to a screen-shaking cap
  const charge = coalesceCharge(cx, cy);
  if (charge > 0) r = min(46, r + <i32>Math.floor(Math.sqrt(<f64>charge) * 0.9));
  if (<f64>r > fxPower) fxPower = <f64>r;
  if (blastQLen < 96) {
    store<i32>(blastQP + (<usize>blastQLen << 2), cx);
    store<i32>(blastQP + (<usize>(blastQLen + 1) << 2), cy);
    store<i32>(blastQP + (<usize>(blastQLen + 2) << 2), r);
    blastQLen += 3;
  }
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      const o = species(i);
      if (o === E_WALL) continue;
      if (!losClear(cx, cy, x, y)) continue; // shielded by walls
      // heavy rubble and solid metal mostly survive the fireball — blasts
      // mangle metal, they don't vaporize it (gold statues outlive sieges)
      const tough = (BEHAVIOR(o) === B_POWDER && DENSITY(o) >= 70) || BEHAVIOR(o) === B_METAL;
      dbgLog(41, cx, cy);
      if (rngByte() < (tough ? 45 : 200)) {
        dbgLog(41, cx, cy);
        const fl = 10 + rngInt(30);
        set(i, x, y, E_FIRE, fl);
        dbgLog(41, cx, cy);
        shadeSet(i, rngByte());
      }
    }
  }
  // debris shockwave: movable material near the blast is thrown outward in
  // ballistic arcs (the fire core above already consumed most of the inside)
  const R2 = r * 2 + 4;
  const r2out = R2 * R2;
  for (let dy = -R2; dy <= R2; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -R2; dx <= R2; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2out || d2 === 0) continue;
      const x = cx + dx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      const b = BEHAVIOR(species(i));
      if (b !== B_POWDER && b !== B_LIQUID && b !== B_SUPERBALL) continue;
      if (!losClear(cx, cy, x, y)) continue; // walls shield the debris too
      const d = Math.sqrt(<f64>d2);
      const mag = 170.0 * (1.0 - d / <f64>R2) + 22.0; // up to ~12 cells/tick at the core
      vx8Set(i, max(-126, min(126, <i32>((<f64>dx / d) * mag))));
      vy8Set(i, max(-126, min(126, <i32>((<f64>dy / d) * mag) - 22))); // loft
      wake(x, y);
    }
  }
  // heat flash
  const tr = (r >> TSHIFT) + 2;
  const tcx = cx >> TSHIFT;
  const tcy = cy >> TSHIFT;
  for (let dy = -tr; dy <= tr; dy++) {
    const ty = tcy + dy;
    if (ty < 0 || ty >= THg) continue;
    for (let dx = -tr; dx <= tr; dx++) {
      const tx = tcx + dx;
      if (tx < 0 || tx >= TWg) continue;
      const d = Math.sqrt(<f64>(dx * dx + dy * dy));
      if (d > <f64>tr) continue;
      const ti = ty * TWg + tx;
      f32Set(tempP, ti, f32At(tempP, ti) + 260.0 * (1.0 - d / <f64>tr));
      markThermalCoarse(tx, ty);
    }
  }
  // radial wind impulse
  windTicks = 240;
  const rw = (r >> WSHIFT) + 2;
  const wcx = cx >> WSHIFT;
  const wcy = cy >> WSHIFT;
  for (let dy = -rw; dy <= rw; dy++) {
    const wy = wcy + dy;
    if (wy < 0 || wy >= WYg) continue;
    for (let dx = -rw; dx <= rw; dx++) {
      const wx = wcx + dx;
      if (wx < 0 || wx >= WXg) continue;
      let d = Math.sqrt(<f64>(dx * dx + dy * dy));
      if (d === 0) d = 1; // TS: Math.sqrt(...) || 1
      if (d > <f64>rw) continue;
      const s = (9.0 * (1.0 - d / <f64>rw)) / d;
      const wi = wy * WXg + wx;
      f32Set(windVxP, wi, max(-8.0, min(8.0, f32At(windVxP, wi) + <f64>dx * s)));
      f32Set(windVyP, wi, max(-8.0, min(8.0, f32At(windVyP, wi) + <f64>dy * s)));
    }
  }
}
