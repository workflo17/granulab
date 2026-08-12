// App-layer regression suite — the half of the codebase the parity gates do not
// cover. tools/parity.ts proves the two engines agree; this proves the things
// built ON them still behave: save formats, hostile input, the flow physics
// people notice, and the reaction data the UI teaches from.
//
// Every case here exists because something shipped broken. The Lab Notebook was
// dead on the default engine for three days, every dialog sat in the top-left
// corner since M4, a demo you were already in could not be restarted, and a
// sixteen-byte payload froze the tab — all found by hand, none by a machine.
//
// Runs headless in node: `npm run test:app`. The cases that need a real DOM live
// in the in-page suite instead (window.granulab.selftest()), because standing up
// a browser is a dependency this project has so far done without.

import { World } from "../src/engine/world";
import { E, ELEMENTS, HOT_TO, COLD_TO, N_IDS } from "../src/engine/elements";
import { allRecipes } from "../src/ui/ui";

const W = 1280;
const H = 720;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const idOf = (name: string): number => {
  const el = ELEMENTS.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!el) throw new Error(`no element named ${name}`);
  return el.id;
};

function fill(w: World, name: string, x0: number, y0: number, x1: number, y1: number): void {
  const id = idOf(name);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.paint(x, y, id);
}

function gridHash(w: World): string {
  let h = 2166136261;
  const s = w.species;
  for (let i = 0; i < s.length; i++) {
    h ^= s[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function count(w: World, id: number): number {
  let n = 0;
  for (let i = 0; i < w.species.length; i++) if (w.species[i] === id) n++;
  return n;
}

// ---- save format ----------------------------------------------------------
section("save format");
{
  const w = new World(W, H);
  fill(w, "Sand", 100, 100, 500, 400);
  fill(w, "Water", 600, 200, 900, 500);
  fill(w, "Wall", 50, 600, 1200, 620);
  const before = { hash: gridHash(w), dots: w.dots };
  const bytes = w.serialize();
  const w2 = new World(W, H);
  const ok = w2.deserialize(bytes);
  check("a scene round-trips through serialize/deserialize", ok);
  check("round trip is byte-identical", gridHash(w2) === before.hash, `${gridHash(w2)} vs ${before.hash}`);
  check("dot count survives the round trip", w2.dots === before.dots, `${w2.dots} vs ${before.dots}`);
}

// ---- hostile input --------------------------------------------------------
// A pasted share code, or any scene from the public gallery, arrives here as
// raw bytes. An unvalidated length field used to spin the main thread for
// fourteen seconds and then report success.
section("hostile input");
{
  const w = new World(W, H);
  const header = (sLen: number): Uint8Array => {
    const b = new Uint8Array(12);
    b[0] = 0x47; b[1] = 0x52; b[2] = 0x4e; b[3] = 0x31; // GRN1
    b[4] = W & 255; b[5] = W >> 8;
    b[6] = H & 255; b[7] = H >> 8;
    b[8] = sLen & 255; b[9] = (sLen >> 8) & 255; b[10] = (sLen >> 16) & 255; b[11] = (sLen >>> 24) & 255;
    return b;
  };
  const t0 = Date.now();
  const huge = w.deserialize(header(2147483647));
  const ms = Date.now() - t0;
  check("a length field larger than the buffer is refused", huge === false);
  check("and refused immediately, not after a long spin", ms < 50, `${ms}ms`);
  check("a negative length is refused", w.deserialize(header(-1)) === false);
  check("a truncated body is refused", w.deserialize(header(9_000_000)) === false);
  check("wrong magic bytes are refused", w.deserialize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === false);
  const wrongSize = header(0);
  wrongSize[4] = 64; // claims a 64-wide grid
  check("a scene for a different grid size is refused", w.deserialize(wrongSize) === false);
}

// ---- liquids find their level ---------------------------------------------
// Before M5m the body of a pool could not move at all: only the exposed surface
// crept outward, so a poured column kept its mound forever.
section("liquid flow");
{
  const w = new World(W, H);
  fill(w, "Wall", 200, 600, 1000, 620);
  fill(w, "Wall", 200, 300, 210, 620);
  fill(w, "Wall", 990, 300, 1000, 620);
  fill(w, "Water", 560, 320, 640, 599);
  const water = idOf("Water");
  const surface = (): { wet: number; uneven: number } => {
    const tops: number[] = [];
    for (let x = 220; x <= 980; x += 10) {
      for (let y = 0; y < H; y++) {
        if (w.species[y * W + x] === water) { tops.push(y); break; }
      }
    }
    return { wet: tops.length, uneven: tops.length ? Math.max(...tops) - Math.min(...tops) : -1 };
  };
  for (let i = 0; i < 2400; i++) w.step();
  const s = surface();
  check("a poured column spreads across the whole tank", s.wet === 77, `${s.wet}/77 columns wet`);
  check("and its surface is levelling, not standing as a mound", s.uneven < 60, `${s.uneven} cells out of level`);
  for (let i = 0; i < 2400; i++) w.step();
  const s2 = surface();
  check("levelling keeps going rather than stalling", s2.uneven < s.uneven, `${s.uneven} -> ${s2.uneven}`);
}

// ---- containers hold ------------------------------------------------------
// The flow change must not let liquid walk through a wall.
section("containment");
{
  const w = new World(W, H);
  fill(w, "Wall", 300, 300, 500, 310);
  fill(w, "Wall", 300, 500, 500, 510);
  fill(w, "Wall", 300, 300, 310, 510);
  fill(w, "Wall", 490, 300, 500, 510);
  fill(w, "Water", 311, 320, 489, 499);
  const water = idOf("Water");
  const before = count(w, water);
  for (let i = 0; i < 2000; i++) w.step();
  let escaped = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (w.species[y * W + x] === water && (x < 311 || x > 489 || y < 311 || y > 509)) escaped++;
    }
  }
  check("a sealed vessel loses nothing", escaped === 0, `${escaped} cells escaped`);
  check("and holds every drop it started with", count(w, water) === before, `${count(w, water)} vs ${before}`);
}

// ---- reaction data --------------------------------------------------------
// The UI teaches chemistry straight out of these tables, so a malformed row is
// a lesson that is wrong rather than a crash.
section("reaction table");
{
  const recipes = allRecipes();
  check("the index is not empty", recipes.length > 50, `${recipes.length} rows`);

  const pairs = new Set(recipes.map((r) => `${Math.min(r.a, r.b)}:${Math.max(r.a, r.b)}`));
  check("every unordered pair appears exactly once", pairs.size === recipes.length,
    `${pairs.size} pairs across ${recipes.length} rows`);

  const zero = recipes.filter((r) => r.p === 0);
  check("no row has a zero chance of firing", zero.length === 0, zero.map((r) => r.name).join(", "));

  const inert = recipes.filter((r) => r.newA === r.a && r.newB === r.b && r.extra === 0);
  check("no row costs a roll and changes nothing", inert.length === 0, inert.map((r) => r.name).join(", "));

  const badId = recipes.filter((r) =>
    [r.a, r.b, r.newA, r.newB, r.extra].some((id) => id < 0 || id >= N_IDS || (id !== E.EMPTY && !ELEMENTS[id])));
  check("every reactant and product is a real element", badId.length === 0, badId.map((r) => r.name).join(", "));

  const unnamed = recipes.filter((r) => !r.name || r.name.trim() === "");
  check("every row carries a name", unnamed.length === 0);

  // the datasheet's "made from" is this scan run backwards; if it finds nothing
  // for a product, the card goes blank and the player is told nothing
  const madeBy = (id: number): number =>
    recipes.filter((r) => (r.newA === id && r.a !== id) || (r.newB === id && r.b !== id) || r.extra === id).length +
    ELEMENTS.filter((el) => HOT_TO[el.id] === id || COLD_TO[el.id] === id).length;
  for (const name of ["Bleach", "Thermite", "Glass", "Salt", "Steam", "Lime", "Gunpowder"]) {
    const id = idOf(name);
    check(`${name} can be traced back to something that makes it`, madeBy(id) > 0);
  }
}

// ---- reactions actually fire ----------------------------------------------
section("chemistry runs");
{
  const w = new World(W, H);
  fill(w, "Wall", 300, 500, 700, 520);
  fill(w, "Soda", 320, 460, 680, 499);
  fill(w, "Acid", 320, 400, 680, 459);
  const co2 = idOf("CO2");
  for (let i = 0; i < 300; i++) w.step();
  check("acid on soda fizzes off CO2", count(w, co2) > 100, `${count(w, co2)} cells`);
}

// ---- report ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
