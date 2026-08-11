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

/** stage-4 devices+weapons zoo — the final coverage pass. Fixture laws from
 *  DESIGN.md: boxed igniters, wire-before-liquid, 1-wide top-lit fireworks
 *  tubes, clone+spark primers, hopper-fed cannon (rangeScene-proven
 *  geometry). Every remaining engine subsystem fires: explosions+coalesce,
 *  ballistic debris, cannon, conduction through a magma bath, fan wind +
 *  saltation + soap bubbles, pump line, fireworks/rockets, detector+valve,
 *  laser through glass, thunder onto metal and stone, waterline corrosion,
 *  torch, heater, and a critter box (ant/virus/bird/superball/cloud/seed/
 *  filter/litmus). */
function buildDeviceZoo(paint: PaintFn): void {
  rect(paint, "Wall", 30, 690, 1250, 700); // the range floor
  // 1) gunpowder charge, fire-adjacent igniter, boxed for LOS confinement
  rect(paint, "Wall", 60, 640, 62, 689);
  rect(paint, "Wall", 118, 640, 120, 689);
  rect(paint, "Gunpowder", 63, 668, 117, 689);
  rect(paint, "Fire", 80, 664, 90, 667);
  // 2) sentry cannon: perch, hopper, cannon block aimed east, clone+spark
  rect(paint, "Wall", 166, 477, 234, 479);
  rect(paint, "Wall", 166, 434, 168, 477);
  rect(paint, "Wall", 184, 434, 186, 466);
  rect(paint, "Sand", 169, 438, 183, 476);
  for (let y = 468; y <= 476; y++) for (let x = 188; x <= 196; x++) paint(x, y, byName("Cannon"), 0);
  paint(192, 467, byName("Clone"));
  paint(193, 467, byName("Spark"));
  rect(paint, "Stone", 280, 664, 300, 689); // berm downrange
  // 3) spark pulse: copper -> tungsten U through a magma bath -> copper
  rect(paint, "Wall", 360, 664, 362, 689);
  rect(paint, "Wall", 438, 664, 440, 689);
  rect(paint, "Copper", 320, 650, 399, 650); // wire before liquid
  rect(paint, "Tungsten", 400, 650, 400, 685);
  rect(paint, "Tungsten", 401, 685, 409, 685);
  rect(paint, "Tungsten", 410, 650, 410, 685);
  rect(paint, "Copper", 411, 650, 470, 650);
  rect(paint, "Magma", 363, 672, 437, 689); // fills around the tungsten U
  paint(318, 650, byName("Clone")); // pulser: clone memorizes the primer spark
  paint(319, 650, byName("Spark")); // primer (touches clone AND wire)
  // 4) fan column blowing east over a soapy pool (bubbles + wind push);
  //    a sand blob falls through the beam for powder saltation
  rect(paint, "Wall", 500, 640, 502, 689); // mast
  for (let y = 676; y <= 686; y++) paint(503, y, byName("Fan"), 0);
  rect(paint, "Soapy", 504, 682, 590, 689);
  rect(paint, "Wall", 592, 668, 594, 689);
  rect(paint, "Sand", 520, 600, 540, 610);
  // 5) pump line (painted before the water) lifting a tank over a wall
  rect(paint, "Pump", 660, 640, 660, 688);
  rect(paint, "Pump", 661, 640, 690, 640);
  rect(paint, "Pump", 690, 641, 690, 660);
  rect(paint, "Wall", 640, 660, 642, 689);
  rect(paint, "Wall", 678, 660, 680, 689);
  rect(paint, "Water", 643, 668, 677, 689); // fills around the pump column
  rect(paint, "Heater", 712, 684, 716, 689); // boils some of the ejected pool
  // 6) fireworks battery: 1-wide TOP-LIT column in a wall tube
  rect(paint, "Wall", 754, 640, 755, 689);
  rect(paint, "Wall", 757, 640, 758, 689);
  rect(paint, "Fireworks", 756, 650, 756, 689);
  paint(756, 649, byName("Fire")); // light from above
  // 7) detector+valve: sand tube gated by a valve over a detector slab; a
  //    cloud rains water that pools against the slab (primes it), the slab's
  //    sparks fill the gap row under the valve and open it
  rect(paint, "Cloud", 800, 620, 824, 624);
  rect(paint, "Wall", 810, 630, 811, 677);
  rect(paint, "Wall", 813, 630, 814, 677);
  rect(paint, "Sand", 812, 640, 812, 676);
  paint(812, 677, byName("Valve"));
  rect(paint, "Detector", 810, 679, 814, 680); // gap row y=678 for the sparks
  // 8) laser through glass into wood; thunder onto metal and stone;
  //    waterline corrosion (iron -> rust, copper -> verdigris)
  rect(paint, "Glass", 900, 620, 920, 622);
  rect(paint, "Wood", 895, 660, 925, 689);
  for (let x = 905; x <= 910; x++) paint(x, 600, byName("Laser"), 64); // aimed down
  // waterline corrosion tank: metal+copper combs standing in seawater (many
  // waterline cells); a sealed unprimed clone in the same chunk keeps the
  // chunk awake forever (zero draws) so doMetalCool keeps rolling
  rect(paint, "Wall", 930, 676, 932, 689);
  // stub tops sit flush AT the waterline (y=684): air above, sea beside —
  // a column that pokes through the surface never has both on one cell
  rect(paint, "Metal", 934, 684, 934, 689);
  rect(paint, "Metal", 936, 684, 936, 689);
  rect(paint, "Metal", 938, 684, 938, 689);
  rect(paint, "Metal", 940, 684, 940, 689);
  rect(paint, "Metal", 942, 684, 942, 689);
  rect(paint, "Copper", 946, 684, 946, 689);
  rect(paint, "Copper", 948, 684, 948, 689);
  rect(paint, "Copper", 950, 684, 950, 689);
  rect(paint, "Copper", 952, 684, 952, 689);
  rect(paint, "Copper", 954, 684, 954, 689);
  rect(paint, "Seawater", 933, 684, 959, 689); // fills the gaps between stubs
  rect(paint, "Wall", 960, 676, 962, 689);
  // the chunk-waker: wall ring with an unprimed clone sealed inside
  rect(paint, "Wall", 944, 673, 948, 673);
  rect(paint, "Wall", 944, 677, 948, 677);
  rect(paint, "Wall", 944, 674, 944, 676);
  rect(paint, "Wall", 948, 674, 948, 676);
  paint(946, 675, byName("Clone"));
  // thunder onto a metal pad (sparks it) and onto stone (blasts it)
  rect(paint, "Metal", 976, 686, 996, 689);
  paint(986, 400, byName("Thunder"));
  rect(paint, "Torch", 1000, 684, 1004, 689);
  rect(paint, "Stone", 1008, 684, 1016, 689);
  paint(1012, 400, byName("Thunder"));
  // 9) critter box: ants, virus, birds, superballs, cloud rain, seeds,
  //    filter mesh over gas, litmus into an acid dish
  rect(paint, "Wall", 1020, 560, 1022, 689);
  rect(paint, "Wall", 1230, 560, 1232, 689);
  rect(paint, "Powder", 1030, 670, 1090, 689);
  rect(paint, "Ant", 1045, 660, 1055, 664);
  rect(paint, "Virus", 1080, 640, 1084, 643);
  rect(paint, "Bird", 1120, 600, 1123, 602);
  rect(paint, "Superball", 1140, 580, 1144, 583);
  rect(paint, "Cloud", 1150, 565, 1200, 572);
  rect(paint, "Seed", 1160, 640, 1165, 644);
  rect(paint, "Filter", 1100, 650, 1110, 650);
  rect(paint, "Gas", 1102, 655, 1108, 660);
  rect(paint, "Litmus", 1210, 640, 1216, 646);
  rect(paint, "Wall", 1200, 676, 1202, 689);
  rect(paint, "Acid", 1203, 682, 1226, 689);
}

/** M5i pressure oracle: sealed glass boiler (water+heater), sealed fermenter
 *  (sugar/yeast stripes -> CO2), walled propane room with a glass window lit
 *  by fire painted in the AIR above the pool (paint fills empty only — never
 *  into the pool). Structure is Wall/Glass only — STONE IS A POWDER, a stone
 *  room collapses. */
function buildPressure(paint: PaintFn): void {
  rect(paint, "Wall", 30, 690, 1250, 700); // floor
  // 1) sealed glass boiler: heater bed under water inside a glass shell —
  //    steam + heat pressurize until the glass ruptures into thrown shards
  rect(paint, "Glass", 100, 596, 104, 689);
  rect(paint, "Glass", 196, 596, 200, 689);
  rect(paint, "Glass", 105, 592, 195, 596);
  rect(paint, "Heater", 105, 684, 195, 689);
  rect(paint, "Water", 105, 640, 195, 683);
  // 2) sealed fermenter: wall box, sugar/yeast stripes ferment CO2 that
  //    pressurizes but cannot burst the walls (containment hold)
  rect(paint, "Wall", 300, 600, 304, 689);
  rect(paint, "Wall", 396, 600, 400, 689);
  rect(paint, "Wall", 305, 596, 395, 600);
  for (let k = 0; k < 8; k++) {
    rect(paint, k % 2 === 0 ? "Sugar" : "Yeast", 305, 650 + k * 5, 395, 654 + k * 5);
  }
  // 3) propane room with a glass window; the vapor cloud is lit by fire
  //    painted in the air above the pool — the burn pressurizes the room and
  //    blows the window out
  rect(paint, "Wall", 500, 586, 504, 689);
  rect(paint, "Wall", 505, 582, 639, 586);
  rect(paint, "Wall", 640, 586, 644, 619);
  rect(paint, "Glass", 640, 620, 644, 660);
  rect(paint, "Wall", 640, 661, 644, 689);
  rect(paint, "Propane", 505, 660, 639, 689);
  rect(paint, "Fire", 560, 655, 580, 659); // flush with the pool: contact lights it
  // 4) ice vault: steam pressure bursts the ice walls into thrown snow
  //    (rupture's ICE branch has no p>3 gate — ice is the weaker vessel)
  rect(paint, "Ice", 800, 620, 806, 689);
  rect(paint, "Ice", 894, 620, 900, 689);
  rect(paint, "Ice", 807, 614, 893, 620);
  rect(paint, "Heater", 807, 684, 893, 689);
  rect(paint, "Water", 807, 650, 893, 683);
  // 5) M5k AIR: two identical wood fires, one sealed and one vented. The
  //    sealed box has no path to the world edge, so its own exhaust starves
  //    the flame and it smothers to smoke; the vented twin has a chimney to
  //    open sky and keeps burning. Fire is painted ONTO the wood (the only
  //    deterministic ignition), and both boxes sit on the shared floor.
  rect(paint, "Wall", 950, 596, 1100, 600); // sealed: unbroken roof
  rect(paint, "Wall", 950, 600, 954, 689);
  rect(paint, "Wall", 1096, 600, 1100, 689);
  rect(paint, "Charcoal", 960, 672, 1090, 689); // long-burning bed
  rect(paint, "Fire", 970, 670, 1080, 671); // lit in the cavity above the fuel
  rect(paint, "Wall", 1120, 596, 1168, 600); // vented: roof with a chimney gap
  rect(paint, "Wall", 1182, 596, 1240, 600);
  rect(paint, "Wall", 1120, 600, 1124, 689);
  rect(paint, "Wall", 1236, 600, 1240, 689);
  rect(paint, "Charcoal", 1130, 672, 1230, 689);
  rect(paint, "Fire", 1140, 670, 1225, 671);
}

/** M5h+M5i shelf zoo: paints EVERY element id 90-101 in an exercising
 *  arrangement — the shelves landed after the stage gates and had no oracle
 *  coverage. Iodine sublimation/deposition cycle, LN2 flash-freezing a pool
 *  and boiling to nitrogen, dry ice sealed (pressure-bursts its flask into
 *  shards) and open, gallium melting onto aluminum (embrittlement), cinnabar
 *  roasting to mercury+SO2, ammonia sealed over acid (saltpeter), a methane
 *  pocket found by flame, and a propane pool lit from above. */
function buildShelf(paint: PaintFn): void {
  rect(paint, "Wall", 30, 690, 1250, 700); // floor
  // 1) iodine: heater bed sublimates the pile; a cooler floor section catches
  //    the dense vapor (liquid-encoded, pools sideways) and re-deposits it
  rect(paint, "Wall", 60, 640, 62, 689);
  rect(paint, "Wall", 178, 640, 180, 689);
  rect(paint, "Heater", 63, 684, 145, 689);
  rect(paint, "Cooler", 150, 684, 177, 689);
  rect(paint, "Iodine", 70, 670, 140, 683);
  rect(paint, "Iodine gas", 100, 645, 130, 655); // painted vapor puff (id 92)
  // 2) LN2 floats on a water pool: flash-freezes it, boils off to nitrogen
  rect(paint, "Wall", 220, 640, 222, 689);
  rect(paint, "Wall", 338, 640, 340, 689);
  rect(paint, "Water", 223, 660, 337, 689);
  rect(paint, "Liq. N2", 223, 645, 337, 655);
  rect(paint, "Nitrogen", 250, 610, 290, 620); // painted N2 puff (id 98)
  // 3) dry ice sealed (glass flask: CO2 pressure bursts it into shards) + open
  rect(paint, "Glass", 380, 620, 382, 689);
  rect(paint, "Glass", 438, 620, 440, 689);
  rect(paint, "Glass", 380, 618, 440, 620);
  rect(paint, "Dry ice", 383, 650, 437, 688);
  rect(paint, "Dry ice", 470, 660, 520, 689);
  rect(paint, "Shards", 480, 640, 500, 650); // painted shards rain (id 101)
  // 4) gallium on aluminum over an embedded warm plate (slab-carve-then-embed)
  rect(paint, "Wall", 560, 660, 562, 689);
  rect(paint, "Wall", 658, 660, 660, 689);
  rect(paint, "Aluminum", 563, 675, 657, 689);
  rect(paint, "Gallium", 580, 660, 640, 674);
  rect(paint, "Molten Ga", 600, 650, 620, 655); // painted melt drop (id 96)
  for (let y = 690; y <= 694; y++) for (let x = 570; x <= 650; x++) paint(x, y, 0);
  rect(paint, "Heater", 570, 690, 650, 694);
  // 5) cinnabar roasted by a torch: mercury pools, SO2 chokes off
  rect(paint, "Cinnabar", 700, 670, 760, 689);
  rect(paint, "Torch", 761, 684, 766, 688);
  // 6) ammonia sealed over an acid pool: nitric synthesis -> saltpeter
  rect(paint, "Wall", 820, 618, 900, 620);
  rect(paint, "Wall", 820, 620, 822, 689);
  rect(paint, "Wall", 898, 620, 900, 689);
  rect(paint, "Acid", 823, 670, 897, 689);
  rect(paint, "Ammonia", 823, 630, 897, 660);
  // 7) methane pocket under a gallery roof, found by a rising flame
  rect(paint, "Wall", 940, 600, 1060, 606);
  rect(paint, "Wall", 940, 606, 946, 689);
  rect(paint, "Wall", 1054, 606, 1060, 689);
  rect(paint, "Methane", 950, 608, 1050, 640);
  rect(paint, "Fire", 990, 645, 1010, 650);
  // 8) propane pool lit from above (flush fire: contact ignition)
  rect(paint, "Wall", 1100, 640, 1102, 689);
  rect(paint, "Wall", 1198, 640, 1200, 689);
  rect(paint, "Propane", 1103, 665, 1197, 689);
  rect(paint, "Fire", 1140, 660, 1160, 664);

  // ---- M5j surfaces (ids 102-105), on the free upper deck (y 470-560) so
  // every station above stays exactly as it was. SLICK/BOUNCE are host-side
  // (ObjectSystem) and never enter world.step, so nothing to cover there.
  // 9) marble kiln: a walled magma tank cooks the marble slab above it past
  //    460 through the field (no REACT row exists for marble+magma)
  rect(paint, "Wall", 60, 470, 64, 560);
  rect(paint, "Wall", 196, 470, 200, 560);
  rect(paint, "Wall", 65, 558, 195, 560);
  rect(paint, "Magma", 65, 522, 195, 557);
  rect(paint, "Marble", 65, 505, 195, 521);
  // 10) marble fizz: acid poured around marble pillars -> salt + CO2
  rect(paint, "Wall", 240, 520, 244, 560);
  rect(paint, "Wall", 356, 520, 360, 560);
  rect(paint, "Wall", 245, 558, 355, 560);
  rect(paint, "Marble", 260, 530, 268, 557);
  rect(paint, "Marble", 300, 530, 308, 557);
  rect(paint, "Marble", 330, 530, 338, 557);
  rect(paint, "Acid", 245, 538, 355, 557); // fills around the pillars
  // 11) rubber block lit in place (paint fire ONTO it) -> dirty burn to smoke
  rect(paint, "Wall", 400, 558, 520, 560);
  rect(paint, "Rubber", 420, 530, 500, 557);
  rect(paint, "Fire", 440, 530, 470, 532);
  // 12) vulcanisation: sulfur poured onto a rubber slab cures it to vulcanite
  rect(paint, "Wall", 560, 558, 680, 560);
  rect(paint, "Rubber", 570, 540, 670, 557);
  rect(paint, "Sulfur", 570, 518, 670, 538);
  // 13) graphite burning to CO2 (fire painted onto the pile)
  rect(paint, "Wall", 720, 558, 840, 560);
  rect(paint, "Graphite", 740, 535, 820, 557);
  rect(paint, "Fire", 760, 535, 790, 537);
  // 14) graphite under an oxygen pocket: slow carbon burn with no flame
  rect(paint, "Wall", 880, 500, 884, 560);
  rect(paint, "Wall", 996, 500, 1000, 560);
  rect(paint, "Wall", 885, 498, 995, 500);
  rect(paint, "Wall", 885, 558, 995, 560);
  rect(paint, "Graphite", 890, 540, 990, 557);
  rect(paint, "Oxygen", 890, 505, 990, 538);
  // 15) vulcanite bumper in a fire (flammable 8: it resists, then chars)
  rect(paint, "Wall", 1040, 558, 1160, 560);
  rect(paint, "Vulcanite", 1060, 535, 1140, 557);
  rect(paint, "Fire", 1080, 535, 1110, 537);
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
/** FNV-1a over a Float32Array's raw bytes (M5i pressure-field comparison) */
function fnvF32(f: Float32Array): string {
  const b = new Uint8Array(f.buffer, f.byteOffset, f.length * 4);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

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

function arrEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** drain both engines' entity queues — the harness stands in for ObjectSystem,
 *  using the exact app-side idiom (`.length = 0`) on both engines' JS arrays */
function drainQueues(ts: World, wasm: WasmWorld): void {
  ts.blastQueue.length = 0;
  ts.bubbleQueue.length = 0;
  wasm.blastQueue.length = 0;
  wasm.bubbleQueue.length = 0;
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
  drainQueues(ts, wasm);
  for (let t = 0; t < tick - 1; t++) {
    ts.step();
    wasm.step();
    if ((t + 1) % CHECK_EVERY === 0) drainQueues(ts, wasm); // main-run schedule
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
  // [method, index of the x argument] — hotContact4/explode are (x|cx, y|cy, ..),
  // the rest (i, x, y, ..)
  const patchDefs: Array<[string, number]> = [
    ["updateCell", 1], ["doPowder", 1], ["doLiquid", 1], ["doGas", 1],
    ["doFire", 1], ["doCorrode", 1], ["hotContact4", 0],
    ["doSpark", 1], ["doClone", 1], ["doEmitter", 1], ["doAnt", 1],
    ["doVirus", 1], ["doBird", 1], ["doCloud", 1], ["doSuperball", 1],
    ["doVine", 1], ["doRocket", 1], ["doPump", 1], ["doDetector", 1],
    ["doLaser", 1], ["doMetalCool", 1], ["trySoapBubble", 1],
    ["tryWindPush", 1], ["explode", 0], ["rupture", 0],
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
      const m = ln.match(
        /(updateCell|doPowder|doLiquid|doGas|tryWindPush|paint|stepTemp|doFire|hotContact4|doCorrode|doSpark|doClone|doEmitter|doAnt|doVirus|doBird|doCloud|doSuperball|doVine|doRocket|doPump|doDetector|doValve|doCannon|doLaser|doThunder|doFilter|doLitmus|doMetalCool|trySoapBubble|explode|rupture)/,
      );
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
    "spark", "clone", "emitter", "ant", "virus", "bird", "cloud", "superball",
    "vine", "rocket", "pump", "detector", "laser", "metalCool", "explode",
    "windPush", "soapBubble", "rupture",
  ];
  const siteFnNames = [
    "doSpark", "doClone", "doEmitter", "doAnt", "doVirus", "doBird", "doCloud",
    "doSuperball", "doVine", "doRocket", "doPump", "doDetector", "doLaser",
    "doMetalCool", "explode", "tryWindPush", "trySoapBubble", "rupture",
  ];
  const siteFn = (code: number): string =>
    code <= 1 ? "updateCell" : code <= 3 ? "doPowder" : code <= 5 ? "doLiquid" :
    code <= 10 ? "doGas" : code <= 14 ? "stepTemp" : code <= 21 ? "doFire" :
    code <= 23 ? "hotContact4" : code <= 25 ? "doCorrode" : code === 26 ? "stepTemp" :
    siteFnNames[code - 27] ?? "?";
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
    pre.blastQueue.length = 0;
    pre.bubbleQueue.length = 0;
    for (let t = 0; t < tick - 1; t++) {
      pre.step();
      if ((t + 1) % CHECK_EVERY === 0) {
        pre.blastQueue.length = 0;
        pre.bubbleQueue.length = 0;
      }
    }
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
  drainQueues(ts, wasm);
  for (let t = 0; t < failTick; t++) {
    ts.step();
    wasm.step();
    const atCheckpoint = (t + 1) % CHECK_EVERY === 0;
    const qDiverged =
      !arrEq(ts.blastQueue, wasm.blastQueue) || !arrEq(ts.bubbleQueue, wasm.bubbleQueue);
    const fxDiverged = ts.fxPower !== wasm.fxPower;
    if (atCheckpoint) drainQueues(ts, wasm); // main-run schedule
    if (t + 1 <= lastGood) continue; // fast-forward through the known-good span
    if (qDiverged || fxDiverged) {
      console.log(
        `  FIRST DIVERGENCE tick=${t + 1}: ${qDiverged ? "queues" : ""}${fxDiverged ? " fxPower" : ""} (ts fx=${ts.fxPower} wasm fx=${wasm.fxPower})`,
      );
      await forensic(build, t + 1, 0, 0);
      return;
    }
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
  const buildOk =
    hb0 === hw0 && tsDraws() === wasm.rngDraws && ts.dots === wasm.dots &&
    arrEq(ts.blastQueue, wasm.blastQueue) && arrEq(ts.bubbleQueue, wasm.bubbleQueue) &&
    ts.fxPower === wasm.fxPower;
  console.log(
    `build     hash ts=${hb0} wasm=${hw0}  draws ts=${tsDraws()} wasm=${wasm.rngDraws}  dots ts=${ts.dots} wasm=${wasm.dots}  ${buildOk ? "PASS" : "FAIL"}`,
  );
  drainQueues(ts, wasm);
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
    const wq = wasm.blastQueue;
    const wu = wasm.bubbleQueue;
    const qOk = arrEq(ts.blastQueue, wq) && arrEq(ts.bubbleQueue, wu);
    const fxOk = ts.fxPower === wasm.fxPower;
    // M5i/M5k: pressure AND air fields compared byte-exact on every scene
    const pt = fnvF32(ts.press);
    const pw = fnvF32(wasm.press);
    const at = fnvF32(ts.air);
    const aw = fnvF32(wasm.air);
    const ok = ht === hw && dt === dw && qOk && fxOk && pt === pw && at === aw;
    console.log(
      `tick ${String(tick).padStart(4)}  hash ts=${ht} wasm=${hw}  draws ts=${dt} wasm=${dw}  ` +
        `blastQ ${ts.blastQueue.length}/${wq.length} bubbleQ ${ts.bubbleQueue.length}/${wu.length} ` +
        `fx ${ts.fxPower.toFixed(3)}/${wasm.fxPower.toFixed(3)}  press ${pt}/${pw}  air ${at}/${aw}  ${ok ? "PASS" : "FAIL"}`,
    );
    if (!ok) {
      if (!qOk) {
        console.log(`  blastQ  ts=[${ts.blastQueue.join(",")}] wasm=[${wq.join(",")}]`);
        console.log(`  bubbleQ ts=[${ts.bubbleQueue.join(",")}] wasm=[${wu.join(",")}]`);
      }
      await hunt(build, lastGood, tick);
      return false;
    }
    drainQueues(ts, wasm); // stand-in for ObjectSystem, keeps caps in lockstep
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

/** fifth gate: .grn serialize round-trip — a snapshot taken from a mid-run TS
 *  World must deserialize into BOTH a fresh TS World and a fresh WasmWorld
 *  and stay bit-exact for 100 more ticks (proves postLoad semantics + byte
 *  format compatibility with existing saves/share codes) */
async function roundTrip(): Promise<boolean> {
  console.log(`\nserialize round-trip: fire zoo, 100 ticks, snapshot, +100 ticks in both engines`);
  const src = new World(W, H, SEED);
  buildFireZoo((x, y, id, aux) => src.paint(x, y, id, aux));
  for (let t = 0; t < 100; t++) src.step();
  const snap = src.serialize();
  console.log(`  snapshot: ${snap.length} bytes (src hash ${fnv(src.species, src.life)})`);

  const { world: ts, draws: tsDraws } = makeTs();
  const wasm = await makeWasm();
  const okTs = ts.deserialize(snap);
  const okWasm = wasm.deserialize(snap);
  const h0t = fnv(ts.species, ts.life);
  const h0w = fnv(wasm.species, wasm.life);
  const loadOk = okTs && okWasm && h0t === h0w && tsDraws() === wasm.rngDraws && ts.dots === wasm.dots;
  console.log(
    `  load      hash ts=${h0t} wasm=${h0w}  draws ts=${tsDraws()} wasm=${wasm.rngDraws}  dots ts=${ts.dots} wasm=${wasm.dots}  ${loadOk ? "PASS" : "FAIL"}`,
  );
  if (!loadOk) return false;
  let all = true;
  for (let c = 1; c <= 2; c++) {
    for (let t = 0; t < 50; t++) {
      ts.step();
      wasm.step();
    }
    const ht = fnv(ts.species, ts.life);
    const hw = fnv(wasm.species, wasm.life);
    const ok = ht === hw && tsDraws() === wasm.rngDraws &&
      arrEq(ts.blastQueue, wasm.blastQueue) && ts.fxPower === wasm.fxPower;
    console.log(
      `  +${String(c * 50).padStart(3)}      hash ts=${ht} wasm=${hw}  draws ts=${tsDraws()} wasm=${wasm.rngDraws}  ${ok ? "PASS" : "FAIL"}`,
    );
    drainQueues(ts, wasm);
    all = all && ok;
  }
  console.log(`  round-trip: ${all ? "PASS" : "FAIL"}`);
  return all;
}

/** latency gate: the app pattern (build, tick, mid-run clear()+repaint, keep
 *  ticking) must never produce a pathological single step in node. Catches
 *  per-tick allocation creep, WASM memory growth, and algorithmic blowups.
 *  (The 8/10 browser "multi-second step" reports were OS starvation of a
 *  HIDDEN tab's background-priority renderer under host CPU load — a pure-JS
 *  spin loop bursts identically there; engine exonerated by a 4-quadrant
 *  wasm/JS x contention/quiet matrix. This gate pins the engine-side
 *  contract regardless.) */
async function latencyGate(): Promise<boolean> {
  console.log(`\nlatency gate: pressure scene, 1200 ticks incl. mid-run clear()+repaint`);
  const wasm = await makeWasm();
  buildPressure((x, y, id, aux) => wasm.paint(x, y, id, aux));
  let maxMs = 0;
  let maxAt = 0;
  let sum = 0;
  for (let t = 1; t <= 1200; t++) {
    if (t === 600) {
      wasm.clear();
      buildPressure((x, y, id, aux) => wasm.paint(x, y, id, aux)); // app cycle
    }
    const t0 = performance.now();
    wasm.step();
    const ms = performance.now() - t0;
    sum += ms;
    if (ms > maxMs) {
      maxMs = ms;
      maxAt = t;
    }
    wasm.blastQueue.length = 0; // ObjectSystem stand-in
    wasm.bubbleQueue.length = 0;
  }
  const ok = maxMs < 60;
  console.log(
    `  1200 ticks: avg ${(sum / 1200).toFixed(2)} ms/step, max ${maxMs.toFixed(1)} ms at tick ${maxAt} (limit 60ms)  ${ok ? "PASS" : "FAIL"}`,
  );
  return ok;
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
  await sceneBench("devzoo", buildDeviceZoo);
  await sceneBench("pressure", buildPressure);
} else {
  const ok1 = await parityRun("stage-1 movement", buildStage1);
  const ok2 = ok1 && (await parityRun("stage-2 thermal", buildThermal));
  const ok3 = ok2 && (await parityRun("stage-3 fire zoo", buildFireZoo));
  const ok4 = ok3 && (await parityRun("stage-4 device zoo", buildDeviceZoo));
  const ok5 = ok4 && (await roundTrip());
  const ok6 = ok5 && (await parityRun("M5i pressure", buildPressure));
  const ok7 = ok6 && (await parityRun("M5h+M5i shelf zoo", buildShelf));
  const ok8 = ok7 && (await latencyGate());
  if (ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8) {
    await churnBench();
    await sceneBench("thermal", buildThermal);
    await sceneBench("firezoo", buildFireZoo);
    await sceneBench("devzoo", buildDeviceZoo);
    await sceneBench("pressure", buildPressure);
  } else {
    process.exitCode = 1;
  }
}
