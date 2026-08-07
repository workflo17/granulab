// Bit-exact parity harness: TS engine (src/engine/world.ts) vs WASM engine
// (asm/engine.ts via src/engine/world-wasm.ts) on the stage-1 movement scene,
// the stage-2 thermal zoo, and the stage-3 reaction+fire zoo.
//
// Builds the SAME scenes through both engines, runs 500 ticks each, and every
// 50 ticks compares (a) the FNV-1a hash over species+life (same hash as
// tools/bench.ts) and (b) cumulative rng draw counts. On first divergence it
// replays both engines from scratch to the last good checkpoint and steps
// tick-by-tick to find the first differing cell (tick, x, y, ts, wasm).
//
// After a full pass it re-runs bench.ts's 211k churn scene and the thermal
// zoo through both engines with timing, comparing hashes per phase.
//
// Run:  npm run parity
// (or)  npx asc --config asconfig.json --target release
//       npx esbuild tools/parity.ts --bundle --format=esm --platform=node --outfile=tools/parity.mjs
//       node tools/parity.mjs
import { readFileSync } from "node:fs";
import { World } from "../src/engine/world";
import { ELEMENTS } from "../src/engine/elements";
import { WasmWorld } from "../src/engine/world-wasm";

const W = 1280;
const H = 720;
const SEED = 0xc0ffee;
const TICKS = 500;
const CHECK_EVERY = 50;

const wasmBytes = readFileSync(new URL("../asm/build/engine.wasm", import.meta.url));
const byName = (name: string): number => ELEMENTS.find((d) => d.name === name)!.id;

// ---- engines ---------------------------------------------------------------

interface EngineLike {
  species: Uint8Array;
  life: Uint8Array;
  paint(x: number, y: number, id: number, aux?: number): void;
  step(): void;
  frame: number;
  dots: number;
}

/** TS world with an instrumented rng so we can compare draw counts */
function makeTs(): { world: World; draws: () => number } {
  const world = new World(W, H, SEED);
  let count = 0;
  const rng = world.rng as unknown as { next: () => number };
  const orig = rng.next.bind(rng);
  rng.next = () => {
    count++;
    return orig();
  };
  return { world, draws: () => count };
}

async function makeWasm(): Promise<WasmWorld> {
  const world = new WasmWorld(wasmBytes, W, H, SEED);
  await world.ready;
  return world;
}

// ---- scenes ----------------------------------------------------------------

type PaintFn = (x: number, y: number, id: number, aux?: number) => void;

function rect(paint: PaintFn, name: string, x0: number, y0: number, x1: number, y1: number): void {
  const id = byName(name);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) paint(x, y, id);
}

/** stage-1 movement scene: walls basin, water pool with an oil layer on top,
 *  powder piles and sand columns dropped in from above (sand+water can Mud) */
function buildStage1(paint: PaintFn): void {
  rect(paint, "Wall", 20, 700, 1260, 712); // floor
  rect(paint, "Wall", 20, 340, 32, 700); // left wall
  rect(paint, "Wall", 1248, 340, 1260, 700); // right wall
  rect(paint, "Water", 33, 620, 1247, 699); // pool
  rect(paint, "Oil", 33, 596, 1247, 619); // oil layer floats on top
  rect(paint, "Powder", 180, 420, 300, 480); // powder piles
  rect(paint, "Powder", 560, 380, 660, 460);
  rect(paint, "Sand", 900, 400, 1010, 470); // sand columns
  rect(paint, "Sand", 350, 300, 420, 360);
}

/** stage-2 thermal zoo: hot AND cold transitions with no reaction row needed
 *  to drive them. A walled magma tank boils a water pool through a thin lid
 *  (water->steam, steam rises/condenses/rains); a walled ice reservoir
 *  freezes a water pool through a 1-cell wall (water->ice, no water-ice
 *  contact at build time); a snow pile melts at its edges (snow->water) and
 *  meltwater can refreeze; a stone pile exercises the THERMAL=0 fast path;
 *  a free steam puff exercises doGas + condensation from tick 1.
 *  NOTE: transitions CREATE contact (frozen ice inside water, cooled stone
 *  inside magma), so Ice creep / Remelting rows can fire later — the generic
 *  stage-1 reaction machinery handles those bit-exactly. */
function buildThermal(paint: PaintFn): void {
  rect(paint, "Wall", 20, 700, 1260, 712); // floor
  rect(paint, "Wall", 20, 300, 32, 700); // left
  rect(paint, "Wall", 1248, 300, 1260, 700); // right
  // boiler: magma tank with a water pool on its lid (heat passes, matter doesn't)
  rect(paint, "Wall", 60, 556, 64, 699); // tank left wall
  rect(paint, "Wall", 196, 556, 200, 699); // tank right wall
  rect(paint, "Wall", 65, 618, 195, 619); // thin lid (one coarse temp row)
  rect(paint, "Magma", 65, 620, 195, 699); // magma below the lid
  rect(paint, "Water", 65, 560, 195, 617); // water above the lid -> boils
  // freezer: ice reservoir a 1-cell wall away from a water pool
  rect(paint, "Wall", 825, 596, 829, 699); // pool left wall
  rect(paint, "Water", 830, 600, 899, 699); // pool: freezes near the cold wall
  rect(paint, "Wall", 900, 556, 900, 699); // 1-cell separator
  rect(paint, "Ice", 901, 560, 1000, 699); // ice block pumps cold through it
  rect(paint, "Wall", 1001, 556, 1005, 699); // reservoir right wall
  // snow pile: edges melt (snow->water), meltwater can refreeze nearby
  rect(paint, "Snow", 500, 640, 620, 699);
  // inert stone pile (THERMAL=0 fast path) + a steam puff for doGas
  rect(paint, "Stone", 300, 660, 380, 699);
  rect(paint, "Steam", 400, 400, 460, 430);
}

/** stage-3 reaction+fire zoo: rows FIRE and fire BURNS. Stations: salt
 *  dissolution into a pool; a wood block charring under painted fire; an oil
 *  pool ignited from above; a sulfur pile burning to SO2; open magma+water
 *  quenching contact (plus charcoal dropped on the magma to exercise
 *  hotContact4's flammable branch); acid rained on a powder bed (doCorrode);
 *  sodium dropped into water (lye + hydrogen, +70C per event — hydrogen
 *  autoignites via stepTemp's ignitesAt branch). No explosives, no devices,
 *  no metals/spark. */
function buildFireZoo(paint: PaintFn): void {
  rect(paint, "Wall", 20, 700, 1260, 712); // floor
  rect(paint, "Wall", 20, 300, 32, 700); // left
  rect(paint, "Wall", 1248, 300, 1260, 700); // right
  // 1) dissolution: salt column dropped into a water pool
  rect(paint, "Wall", 60, 640, 64, 699);
  rect(paint, "Wall", 240, 640, 244, 699);
  rect(paint, "Water", 65, 650, 239, 699);
  rect(paint, "Salt", 120, 580, 180, 620);
  // 2) wood pyre: fire painted in the air above and directly onto the wood
  rect(paint, "Wood", 300, 660, 400, 699);
  rect(paint, "Fire", 320, 640, 380, 659); // air fire settles onto the block
  rect(paint, "Fire", 330, 660, 370, 661); // painted ONTO wood: ignites in place
  // 3) oil pool ignited from above
  rect(paint, "Wall", 430, 640, 434, 699);
  rect(paint, "Wall", 580, 640, 584, 699);
  rect(paint, "Oil", 435, 660, 579, 699);
  rect(paint, "Fire", 490, 650, 530, 659);
  // 4) sulfur pile burning to SO2
  rect(paint, "Sulfur", 640, 650, 700, 699);
  rect(paint, "Fire", 655, 644, 685, 649);
  // 5) quenching: magma in open contact with water; charcoal dropped on the
  // magma exercises hotContact4's flammable branch
  rect(paint, "Wall", 760, 620, 764, 699);
  rect(paint, "Wall", 940, 620, 944, 699);
  rect(paint, "Water", 765, 650, 850, 699);
  rect(paint, "Magma", 851, 640, 939, 699);
  rect(paint, "Charcoal", 900, 628, 939, 636);
  // 6) acid rained onto a powder bed (doCorrode)
  rect(paint, "Powder", 1000, 660, 1080, 699);
  rect(paint, "Acid", 1020, 600, 1060, 620);
  // 7) sodium dropped into water: lye + hydrogen, then H2 autoignition
  rect(paint, "Wall", 1120, 640, 1124, 699);
  rect(paint, "Wall", 1230, 640, 1234, 699);
  rect(paint, "Water", 1125, 655, 1229, 699);
  rect(paint, "Sodium", 1160, 600, 1190, 615);
  // 8) oil pan over a walled magma tank: no contact path exists, so the oil
  // can ONLY ignite via stepTemp's ignitesAt branch (field crosses 340C)
  rect(paint, "Wall", 600, 400, 604, 470);
  rect(paint, "Wall", 716, 400, 720, 470);
  rect(paint, "Wall", 605, 466, 715, 470); // tank bottom
  rect(paint, "Wall", 605, 430, 715, 431); // thin lid
  rect(paint, "Magma", 605, 432, 715, 465);
  rect(paint, "Oil", 605, 410, 715, 429);
}

/** bench.ts churn scene: 211k cells of alternating seawater/oil bands */
function buildChurn(paint: PaintFn): void {
  rect(paint, "Wall", 20, 700, 1260, 712);
  rect(paint, "Wall", 20, 340, 32, 700);
  rect(paint, "Wall", 1248, 340, 1260, 700);
  for (let band = 0; band < 29; band++) {
    const y0 = 442 + band * 6;
    rect(paint, band % 2 === 0 ? "Seawater" : "Oil", 33, y0, 1247, y0 + 5);
  }
}

// ---- comparison ------------------------------------------------------------

/** same FNV-1a as tools/bench.ts: species bytes then life bytes */
function fnv(species: Uint8Array, life: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < species.length; i++) {
    h ^= species[i];
    h = Math.imul(h, 0x01000193);
  }
  for (let i = 0; i < life.length; i++) {
    h ^= life[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface CellDiff {
  array: "species" | "life";
  x: number;
  y: number;
  ts: number;
  wasm: number;
}

function firstDiff(ts: EngineLike, wasm: EngineLike): CellDiff | null {
  for (let i = 0; i < ts.species.length; i++) {
    if (ts.species[i] !== wasm.species[i]) {
      return { array: "species", x: i % W, y: (i / W) | 0, ts: ts.species[i], wasm: wasm.species[i] };
    }
  }
  for (let i = 0; i < ts.life.length; i++) {
    if (ts.life[i] !== wasm.life[i]) {
      return { array: "life", x: i % W, y: (i / W) | 0, ts: ts.life[i], wasm: wasm.life[i] };
    }
  }
  return null;
}

/** forensic pass: replay to tick-1, then run the divergent tick with TS rng
 *  draws stack-tagged by call site and WASM per-site counters — the site whose
 *  tallies differ is the mis-ported draw */
async function forensic(
  build: (p: PaintFn) => void,
  tick: number,
  tx: number,
  ty: number,
): Promise<void> {
  console.log(`\nforensic: re-running tick ${tick} with draw-site attribution...`);
  const { world: ts } = makeTs();
  const wasm = await makeWasm();
  build((x, y, id, aux) => ts.paint(x, y, id, aux));
  build((x, y, id, aux) => wasm.paint(x, y, id, aux));
  for (let t = 0; t < tick - 1; t++) {
    ts.step();
    wasm.step();
  }
  // pre-tick state around the divergent cell (both engines identical here)
  dumpNeighborhood("pre species", ts.species, tx, ty, 5);
  dumpNeighborhood("pre life   ", ts.life, tx, ty, 5);
  dumpNeighborhood("pre clock  ", ts.clock, tx, ty, 5);
  // tag TS draws by call site (function name + bundle line) AND current cell,
  // tracked by wrapping the per-cell prototype methods (diagnosis only)
  const tsSeq: string[] = [];
  const tsCells: number[] = []; // packed y<<14|x per draw
  const curCell = { x: -1, y: -1 };
  const proto = World.prototype as unknown as Record<string, (...a: number[]) => unknown>;
  const patched: Array<[string, (...a: number[]) => unknown]> = [];
  // [method, index of the x argument] — hotContact4 is (x, y), the rest (i, x, y)
  const patchDefs: Array<[string, number]> = [
    ["updateCell", 1], ["doPowder", 1], ["doLiquid", 1], ["doGas", 1],
    ["doFire", 1], ["doCorrode", 1], ["hotContact4", 0],
  ];
  for (const [fn, xi] of patchDefs) {
    const origFn = proto[fn];
    patched.push([fn, origFn]);
    proto[fn] = function (this: World, ...args: number[]) {
      curCell.x = args[xi];
      curCell.y = args[xi + 1];
      return origFn.apply(this, args);
    };
  }
  const PROBE_X = 273;
  const PROBE_Y = 605;
  const probeIdx = PROBE_Y * W + PROBE_X;
  const probe: number[] = []; // species at the probe cell sampled at each ts draw
  const tsVals: number[] = []; // every rng value ts drew this tick
  const rng = ts.rng as unknown as { next: () => number };
  const orig = rng.next.bind(rng);
  rng.next = () => {
    const stack = new Error().stack ?? "";
    let tag = "?";
    for (const ln of stack.split("\n")) {
      const m = ln.match(/(updateCell|doPowder|doLiquid|doGas|tryWindPush|paint|stepTemp|doFire|hotContact4)/);
      if (m) {
        const lm = ln.match(/:(\d+):(\d+)\)?\s*$/);
        tag = `${m[1]}:${lm ? lm[1] : "?"}`;
        break;
      }
    }
    tsSeq.push(tag);
    tsCells.push((curCell.y << 12) | curCell.x);
    probe.push(ts.species[probeIdx]);
    const v = orig();
    tsVals.push(v);
    return v;
  };
  const w0 = wasm.rngDraws;
  wasm.dbgResetSites();
  wasm.dbgSeqEnable();
  ts.step();
  wasm.step();
  wasm.dbgSeqDisable();
  rng.next = orig;
  for (const [fn, origFn] of patched) proto[fn] = origFn;

  // map wasm site codes to the TS function that owns the draw; compare at
  // function-group level (per-line mapping breaks when not every site in a
  // function fires during the tick), plus cell identity where TS tracks it
  const labels = [
    "reactInt4", "reactByte", "powder90", "powderDir", "liquidDir", "liquidDisp",
    "gasDeath77", "gasDeathShade", "gasRise200", "gasRiseInt3", "gasDir",
    "tempHotRoll", "tempHotShade", "tempColdRoll", "tempColdShade",
    "fireExt77", "fireSpread", "fireShade", "fireRise150", "fireRiseInt3",
    "fireSmoke7", "fireSmokeShade", "hot4Roll", "hot4Shade",
    "corrodeInt4", "corrodeByte", "igniteRoll",
  ];
  const siteFn = (code: number): string =>
    code <= 1 ? "updateCell" : code <= 3 ? "doPowder" : code <= 5 ? "doLiquid" :
    code <= 10 ? "doGas" : code <= 14 ? "stepTemp" : code <= 21 ? "doFire" :
    code <= 23 ? "hotContact4" : code <= 25 ? "doCorrode" : "stepTemp";
  const tally = new Map<string, number>();
  for (const tag of tsSeq) tally.set(tag, (tally.get(tag) ?? 0) + 1);
  for (const [tag, n] of [...tally.entries()].sort()) {
    console.log(`  ts   ${tag.padEnd(20)} ${String(n).padStart(7)}`);
  }
  const wseq = wasm.dbgSeq();
  const wTally = new Map<string, number>();
  for (let i = 0; i < wseq.length; i++) {
    const lb = labels[wseq[i] >>> 24];
    wTally.set(lb, (wTally.get(lb) ?? 0) + 1);
  }
  for (const [lb, n] of [...wTally.entries()].sort()) {
    console.log(`  wasm ${lb.padEnd(20)} ${String(n).padStart(7)}`);
  }
  console.log(`  totals: ts=${tsSeq.length} wasm=${wasm.rngDraws - w0}`);

  // align the two draw sequences and report the first differing function/cell
  const nAlign = Math.min(tsSeq.length, wseq.length);
  let misAt = -1;
  for (let i = 0; i < nAlign; i++) {
    const tsFn = tsSeq[i].split(":")[0];
    const wFn = siteFn(wseq[i] >>> 24);
    const cellsComparable = wFn !== "stepTemp" && tsFn !== "stepTemp";
    if (tsFn !== wFn || (cellsComparable && tsCells[i] !== (wseq[i] & 0x00ffffff))) {
      misAt = i;
      break;
    }
  }
  // compare the raw rng VALUES drawn by both engines this tick
  const wvals = wasm.dbgVals();
  const nVals = Math.min(tsVals.length, wvals.length);
  let valMis = -1;
  for (let i = 0; i < nVals; i++) {
    if (tsVals[i] !== wvals[i]) {
      valMis = i;
      break;
    }
  }
  if (valMis >= 0) {
    console.log(`  FIRST VALUE MISMATCH at draw #${valMis}: ts=${tsVals[valMis]} wasm=${wvals[valMis]}`);
    console.log(`    ts  byte=${(tsVals[valMis] * 256) | 0}  wasm byte=${(wvals[valMis] * 256) | 0}`);
  } else {
    console.log(`  rng values identical for ${nVals} draws (ts=${tsVals.length} wasm=${wvals.length})`);
  }
  // when did the probed cell change value in TS (between which draws)?
  for (let k = 1; k < probe.length; k++) {
    if (probe[k] !== probe[k - 1]) {
      const tx = tsCells[k - 1] & 0xfff;
      const tyy = tsCells[k - 1] >>> 12;
      const tx2 = tsCells[k] & 0xfff;
      const ty2 = tsCells[k] >>> 12;
      console.log(
        `  ts probe (${PROBE_X},${PROBE_Y}): ${probe[k - 1]} -> ${probe[k]} between draw #${k - 1} (${tsSeq[k - 1]} @ ${tx},${tyy}) and #${k} (${tsSeq[k]} @ ${tx2},${ty2})`,
      );
    }
  }
  if (misAt >= 0) {
    console.log(`  first draw mismatch (function or cell) at draw #${misAt}:`);
    for (let i = Math.max(0, misAt - 10); i < Math.min(nAlign, misAt + 10); i++) {
      const w = wseq[i];
      const wx = w & 0xfff;
      const wy = (w >>> 12) & 0xfff;
      const tx = tsCells[i] & 0xfff;
      const tyy = tsCells[i] >>> 12;
      const mark = i === misAt ? " <-- MISMATCH" : "";
      console.log(
        `    #${i}  ts=${tsSeq[i]} @ (${tx},${tyy})  wasm=${labels[w >>> 24]} @ (${wx},${wy})${mark}`,
      );
    }
    const mw = wseq[misAt];
    const mx = mw & 0xfff;
    const my = (mw >>> 12) & 0xfff;
    console.log(`  mismatch cell neighborhood (pre-tick, engines identical):`);
    // note: these arrays are POST-tick now; re-derive pre-tick via a fresh replay
    const { world: pre } = makeTs();
    build((x, y, id, aux) => pre.paint(x, y, id, aux));
    for (let t = 0; t < tick - 1; t++) pre.step();
    dumpNeighborhood("pre species", pre.species, mx, my, 6);
    dumpNeighborhood("pre life   ", pre.life, mx, my, 6);
    dumpNeighborhood("pre clock  ", pre.clock, mx, my, 6);
    dumpNeighborhood("mid ts  (post)", ts.species, mx, my, 6);
    dumpNeighborhood("mid wasm(post)", wasm.species, mx, my, 6);
  } else {
    console.log(`  draw sequences agree for ${nAlign} draws (lengths ts=${tsSeq.length} wasm=${wseq.length})`);
  }
  const d = firstDiff(ts, wasm);
  if (d) {
    console.log(`  post-tick first diff: ${d.array}[x=${d.x},y=${d.y}] ts=${d.ts} wasm=${d.wasm}`);
    dumpNeighborhood("post ts  ", ts.species, tx, ty, 5);
    dumpNeighborhood("post wasm", wasm.species, tx, ty, 5);
  }
}

function dumpNeighborhood(label: string, arr: Uint8Array, cx: number, cy: number, r = 3): void {
  const rows: string[] = [];
  for (let y = cy - r; y <= cy + r; y++) {
    const cells: string[] = [];
    for (let x = cx - r; x <= cx + r; x++) {
      const v = x >= 0 && y >= 0 && x < W && y < H ? arr[y * W + x] : -1;
      cells.push(String(v).padStart(3));
    }
    rows.push(`    y=${String(y).padStart(4)}  ${cells.join(" ")}`);
  }
  console.log(`  ${label} species around (${cx},${cy}):\n${rows.join("\n")}`);
}

/** replay both engines from scratch to lastGood, then hunt tick-by-tick,
 *  comparing species/life/shade/clock, rng draw counts, and chunk activity */
async function hunt(
  build: (p: PaintFn) => void,
  lastGood: number,
  failTick: number,
): Promise<void> {
  console.log(`\nhunting first divergent cell between ticks ${lastGood} and ${failTick}...`);
  const { world: ts, draws: tsDraws } = makeTs();
  const wasm = await makeWasm();
  build((x, y, id, aux) => ts.paint(x, y, id, aux));
  build((x, y, id, aux) => wasm.paint(x, y, id, aux));
  const d0 = firstDiff(ts, wasm);
  if (d0) {
    console.log(`  DIVERGED AT BUILD (tick 0): ${d0.array}[${d0.x},${d0.y}] ts=${d0.ts} wasm=${d0.wasm}`);
    return;
  }
  for (let t = 0; t < failTick; t++) {
    ts.step();
    wasm.step();
    if (t + 1 <= lastGood) continue; // fast-forward through the known-good span
    const d = firstDiff(ts, wasm);
    const dDraws = tsDraws() - wasm.rngDraws;
    const dChunks = ts.activeChunkCount() - wasm.activeChunkCount();
    // compare the FULL active-chunk maps (cur AND next), not just counts
    const tsActive = (ts as unknown as { activeCur: Uint8Array }).activeCur;
    const wActive = wasm.activeCurView();
    const tsNext = (ts as unknown as { activeNext: Uint8Array }).activeNext;
    const wNext = wasm.activeNextView();
    let dActive = -1;
    let dNext = -1;
    for (let i = 0; i < tsActive.length; i++) {
      if (dActive < 0 && (tsActive[i] !== 0) !== (wActive[i] !== 0)) dActive = i;
      if (dNext < 0 && (tsNext[i] !== 0) !== (wNext[i] !== 0)) dNext = i;
    }
    let dShade = -1;
    let dClock = -1;
    const wShade = wasm.shade;
    const wClock = wasm.clock;
    for (let i = 0; i < ts.species.length; i++) {
      if (dShade < 0 && ts.shade[i] !== wShade[i]) dShade = i;
      if (dClock < 0 && ts.clock[i] !== wClock[i]) dClock = i;
      if (dShade >= 0 && dClock >= 0) break;
    }
    if (d || dDraws !== 0 || dChunks !== 0 || dShade >= 0 || dClock >= 0 || dActive >= 0 || dNext >= 0) {
      const chunksX = Math.ceil(W / 32);
      console.log(`  FIRST DIVERGENCE tick=${t + 1}:`);
      if (d) console.log(`    state: ${d.array}[x=${d.x},y=${d.y}] ts=${d.ts} wasm=${d.wasm}`);
      if (dDraws !== 0) console.log(`    rng draws: ts=${tsDraws()} wasm=${wasm.rngDraws} (ts-wasm=${dDraws})`);
      if (dChunks !== 0) console.log(`    active chunks: ts=${ts.activeChunkCount()} wasm=${wasm.activeChunkCount()}`);
      if (dActive >= 0)
        console.log(
          `    activeCur map differs at chunk (${dActive % chunksX},${(dActive / chunksX) | 0}): ts=${tsActive[dActive]} wasm=${wActive[dActive]}`,
        );
      if (dNext >= 0)
        console.log(
          `    activeNext map differs at chunk (${dNext % chunksX},${(dNext / chunksX) | 0}): ts=${tsNext[dNext]} wasm=${wNext[dNext]}`,
        );
      if (dShade >= 0) console.log(`    shade[${dShade % W},${(dShade / W) | 0}] ts=${ts.shade[dShade]} wasm=${wShade[dShade]}`);
      if (dClock >= 0) console.log(`    clock[${dClock % W},${(dClock / W) | 0}] ts=${ts.clock[dClock]} wasm=${wClock[dClock]}`);
      console.log(`    rng state: ts=${((ts.rng as unknown as { s: number }).s >>> 0).toString(16)} wasm=${wasm.rngState.toString(16)}`);
      if (d) {
        dumpNeighborhood("ts  ", ts.species, d.x, d.y);
        dumpNeighborhood("wasm", wasm.species, d.x, d.y);
      }
      await forensic(build, t + 1, d ? d.x : 0, d ? d.y : 0);
      return;
    }
  }
  console.log("  (no divergence found on replay — nondeterminism in the harness itself?)");
}

// ---- main ------------------------------------------------------------------

async function parityRun(label: string, build: (p: PaintFn) => void): Promise<boolean> {
  console.log(`parity: ${label} scene ${W}x${H} seed=0x${SEED.toString(16)} ticks=${TICKS}`);
  const { world: ts, draws: tsDraws } = makeTs();
  const wasm = await makeWasm();
  build((x, y, id, aux) => ts.paint(x, y, id, aux));
  build((x, y, id, aux) => wasm.paint(x, y, id, aux));

  const hb0 = fnv(ts.species, ts.life);
  const hw0 = fnv(wasm.species, wasm.life);
  const buildOk = hb0 === hw0 && tsDraws() === wasm.rngDraws && ts.dots === wasm.dots;
  console.log(
    `build     hash ts=${hb0} wasm=${hw0}  draws ts=${tsDraws()} wasm=${wasm.rngDraws}  dots ts=${ts.dots} wasm=${wasm.dots}  ${buildOk ? "PASS" : "FAIL"}`,
  );
  if (!buildOk) {
    await hunt(build, 0, 0);
    return false;
  }

  let lastGood = 0;
  let pass = 0;
  const checkpoints = TICKS / CHECK_EVERY;
  for (let c = 1; c <= checkpoints; c++) {
    for (let t = 0; t < CHECK_EVERY; t++) {
      ts.step();
      wasm.step();
    }
    const tick = c * CHECK_EVERY;
    const ht = fnv(ts.species, ts.life);
    const hw = fnv(wasm.species, wasm.life);
    const dt = tsDraws();
    const dw = wasm.rngDraws;
    const ok = ht === hw && dt === dw;
    console.log(
      `tick ${String(tick).padStart(4)}  hash ts=${ht} wasm=${hw}  draws ts=${dt} wasm=${dw}  ${ok ? "PASS" : "FAIL"}`,
    );
    if (!ok) {
      await hunt(build, lastGood, tick);
      return false;
    }
    lastGood = tick;
    pass++;
  }
  console.log(`parity: ${label}: ${pass}/${checkpoints} checkpoints PASS`);
  return true;
}

async function churnBench(): Promise<void> {
  console.log(`\nchurn bench (tools/bench.ts scene) — TS vs WASM, same phases:`);
  // uninstrumented TS world: rng draw-count wrapping costs ~2x at 50M draws
  const ts = new World(W, H, SEED);
  const wasm = await makeWasm();
  buildChurn((x, y, id, aux) => ts.paint(x, y, id, aux));
  buildChurn((x, y, id, aux) => wasm.paint(x, y, id, aux));
  console.log(`  painted: ts dots=${ts.dots} wasm dots=${wasm.dots}`);

  const phase = (label: string, ticks: number): void => {
    let t0 = performance.now();
    for (let i = 0; i < ticks; i++) ts.step();
    const tsMs = (performance.now() - t0) / ticks;
    t0 = performance.now();
    for (let i = 0; i < ticks; i++) wasm.step();
    const wasmMs = (performance.now() - t0) / ticks;
    const ht = fnv(ts.species, ts.life);
    const hw = fnv(wasm.species, wasm.life);
    console.log(
      `  ${label.padEnd(18)} ts ${tsMs.toFixed(2).padStart(6)} ms/tick   wasm ${wasmMs.toFixed(2).padStart(6)} ms/tick  (${(tsMs / wasmMs).toFixed(2)}x)  hash ts=${ht} wasm=${hw}  ${ht === hw ? "PASS" : "FAIL"}`,
    );
  };
  phase("churn 0-100", 100);
  phase("churn 100-300", 200);
  phase("mixing 300-600", 300);
  phase("settling 600-900", 300);
  phase("settled 900-1100", 200);
}

async function sceneBench(
  name: string,
  build: (p: PaintFn) => void,
): Promise<void> {
  console.log(`\n${name} bench — TS vs WASM, same phases:`);
  const ts = new World(W, H, SEED);
  const wasm = await makeWasm();
  build((x, y, id, aux) => ts.paint(x, y, id, aux));
  build((x, y, id, aux) => wasm.paint(x, y, id, aux));
  console.log(`  painted: ts dots=${ts.dots} wasm dots=${wasm.dots}`);

  const phase = (label: string, ticks: number): void => {
    let t0 = performance.now();
    for (let i = 0; i < ticks; i++) ts.step();
    const tsMs = (performance.now() - t0) / ticks;
    t0 = performance.now();
    for (let i = 0; i < ticks; i++) wasm.step();
    const wasmMs = (performance.now() - t0) / ticks;
    const ht = fnv(ts.species, ts.life);
    const hw = fnv(wasm.species, wasm.life);
    console.log(
      `  ${label.padEnd(18)} ts ${tsMs.toFixed(2).padStart(6)} ms/tick   wasm ${wasmMs.toFixed(2).padStart(6)} ms/tick  (${(tsMs / wasmMs).toFixed(2)}x)  hash ts=${ht} wasm=${hw}  ${ht === hw ? "PASS" : "FAIL"}`,
    );
  };
  phase(`${name} 0-100`, 100);
  phase(`${name} 100-300`, 200);
  phase(`${name} 300-500`, 200);
}

// --bench-only: skip the (instrumented) parity runs — the rng draw-count
// wrapper deopts V8's inline caches process-wide and inflates TS timings
if (process.argv.includes("--bench-only")) {
  await churnBench();
  await sceneBench("thermal", buildThermal);
  await sceneBench("firezoo", buildFireZoo);
} else {
  const ok1 = await parityRun("stage-1 movement", buildStage1);
  const ok2 = ok1 && (await parityRun("stage-2 thermal", buildThermal));
  const ok3 = ok2 && (await parityRun("stage-3 fire zoo", buildFireZoo));
  if (ok1 && ok2 && ok3) {
    await churnBench();
    await sceneBench("thermal", buildThermal);
    await sceneBench("firezoo", buildFireZoo);
  } else {
    process.exitCode = 1;
  }
}
