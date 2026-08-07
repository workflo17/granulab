// Headless perf bench + determinism oracle for the engine hot loop.
// Rebuilds the "pathological 211k double-pool" scene (two stacked immiscible
// pools that churn against each other) with a fixed seed, times world.step()
// across phases, and prints an FNV-1a grid hash — any engine port (WASM/worker)
// must reproduce these hashes tick-for-tick before it ships.
//
// Run:  npx esbuild tools/bench.ts --bundle --format=esm --outfile=tools/bench.mjs && node tools/bench.mjs
import { World } from "../src/engine/world";
import { ELEMENTS } from "../src/engine/elements";

const W = 1280;
const H = 720;
const byName = (name: string): number => ELEMENTS.find((d) => d.name === name)!.id;

const world = new World(W, H, 0xc0ffee);
const R = (name: string, x0: number, y0: number, x1: number, y1: number): void => {
  const id = byName(name);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.paint(x, y, id);
};

// basin walls + floor, then ~211k liquid cells in alternating 6-row bands of
// oil (light) and seawater (dense): every band density-swaps through every
// other band, so the whole basin churns at peak load for hundreds of ticks —
// the historical worst case (liquid churn + reaction roll on water)
R("Wall", 20, 700, 1260, 712);
R("Wall", 20, 340, 32, 700);
R("Wall", 1248, 340, 1260, 700);
for (let band = 0; band < 29; band++) {
  const y0 = 442 + band * 6;
  R(band % 2 === 0 ? "Seawater" : "Oil", 33, y0, 1247, y0 + 5);
}
const dots0 = world.dots;

const fnv = (): string => {
  let h = 0x811c9dc5;
  const mix = (b: number): void => {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  };
  for (let i = 0; i < world.species.length; i++) mix(world.species[i]);
  for (let i = 0; i < world.life.length; i++) mix(world.life[i]);
  return (h >>> 0).toString(16).padStart(8, "0");
};

const phase = (label: string, ticks: number): void => {
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) world.step();
  const ms = (performance.now() - t0) / ticks;
  console.log(
    `${label.padEnd(18)} ${ms.toFixed(2).padStart(6)} ms/tick   frame=${world.frame} dots=${world.dots} hash=${fnv()}`,
  );
};

console.log(`bench: ${dots0} cells painted (${world.dots} dots)`);
phase("churn 0-100", 100);
phase("churn 100-300", 200);
phase("mixing 300-600", 300);
phase("settling 600-900", 300);
phase("settled 900-1100", 200);

// behavior zoo: a compact scene touching most engine branches — movement,
// reactions, fire/thermal, phase transitions, wind, conduction, explosions,
// ballistics — so a port can't pass the churn bench by accident
world.clear();
R("Wall", 100, 600, 900, 612);
R("Wall", 100, 400, 112, 600);
R("Wall", 888, 400, 900, 600);
R("Powder", 150, 420, 300, 500);
R("Water", 400, 450, 600, 560);
R("Salt", 430, 420, 470, 440);
R("Ice", 610, 560, 700, 598);
R("Wood", 150, 560, 260, 598);
world.paint(200, 559, byName("Fire"));
R("Magma", 750, 420, 800, 450);
R("Metal", 300, 410, 700, 412);
world.paint(300, 410, byName("Spark"));
R("Gas", 700, 500, 780, 540);
for (let y = 520; y <= 540; y++) for (let x = 130, e = 0; x <= 138; x++, e++) world.paint(x, y, byName("Fan"), 0);
R("Nitro", 820, 560, 850, 580);
world.paint(835, 559, byName("Fire"));
R("Sand", 500, 300, 560, 360);
console.log(`zoo: ${world.dots} dots`);
phase("zoo 0-200", 200);
phase("zoo 200-400", 200);
