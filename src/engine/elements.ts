// Granulab element registry — elements are DATA, not code (DESIGN.md pillar 2).
// Behaviors are a fixed set of composable primitives; an element is a parameter bundle.
// Adding an element = adding an entry here. The Custom Element Maker (M3) writes these.

export const E = {
  EMPTY: 0,
  WALL: 1,
  POWDER: 2,
  WATER: 3,
  OIL: 4,
  FIRE: 5,
  GAS: 6,
  STEAM: 7,
  SEED: 8,
  VINE: 9,
  GUNPOWDER: 10,
  ACID: 11,
  STONE: 12,
  SALT: 13,
  SEAWATER: 14,
  MAGMA: 15,
  ICE: 16,
  SNOW: 17,
  NITRO: 18,
  BOMB: 19,
  METAL: 20,
  TORCH: 21,
  FUSE: 22,
  VIRUS: 23,
  ANT: 24,
  MERCURY: 25,
  SPARK: 26,
  CLONE: 27,
  FAN: 28,
  SAND: 29,
  MUD: 30,
  GLASS: 31,
  SUPERBALL: 32,
  BIRD: 33,
  CLOUD: 34,
  LASER: 35,
  THUNDER: 36,
  FIREWORKS: 37,
  ROCKET: 38,
  STICK: 39, // player body pixels (render overlay only, never simulated)
  BALL: 40, // rigid-object footprints — stamped/cleared by ObjectSystem each tick
  BOX: 41,
  WHEEL: 42,
  PUMP: 43, // fluid conductor: absorbs liquids/gas, tokens walk the pump line
  BUBBLE: 44, // ring footprint of the bubble object (ObjectSystem)
  // ---- M4.5 chemistry set ----
  SOAPY: 45, // floats on water; strong wind whips it into bubble objects
  LYE: 46, // caustic powder: + oil = soap, + acid = salt (neutralization)
  HYDROGEN: 47, // electrolysis / acid-on-metal product; flashes, burns to steam
  CHLORINE: 48, // heavy toxic gas: pools low, kills plants and critters
  SODA: 49, // bicarbonate: + acid = CO2 fizz, decomposes to CO2 when heated
  CO2: 50, // heavy gas: pours, pools, smothers fire; vines photosynthesize it
  OXYGEN: 51, // accelerant: fire spreads into it
  RUST: 52, // crumbled metal — seawater corrodes metal into this
  CEMENT: 53, // powder that sets to stone on water contact
  // ---- M5a recipe shelf ----
  CHARCOAL: 54, // slow-ember fuel; + saltpeter = gunpowder
  SALTPETER: 55, // oxidizer half of the gunpowder recipe
  SULFUR: 56, // burns readily; enriches gunpowder
  LIMESTONE: 57, // kiln it (460° — sustained fire/magma) into lime
  LIME: 58, // floats out of the melt; + water = cement, + CO2 = limestone again
  ALUMINUM: 59, // + rust = thermite
  THERMITE: 60, // inert until 550° — then it IS magma
  GLYCERIN: 61, // + acid = nitro (nitration)
  ALCOHOL: 62, // light flammable liquid, clean fast burn
  // ---- M5b devices ----
  CANNON: 63, // aimed by pen stroke; sparked = launches its breech load
  DETECTOR: 64, // memorizes first touch, then sparks whenever it's touched again
  VALVE: 65, // drop-gate: solid until sparked, then passes material down 24 ticks
  HEATER: 66, // pure heat plate (no flame)
  COOLER: 67, // pure cold plate
  FILTER: 68, // mesh: gases pass through, liquids and powders don't
} as const;

// Behavior primitives (dispatch codes for the hot loop)
export const B = {
  NONE: 0, // static: wall, ice, metal, fuse, fan
  POWDER: 1, // falls, slides diagonally, sinks through lighter fluids
  LIQUID: 2, // falls + lateral dispersion (magma = liquid + hot flag)
  GAS: 3, // rises + lateral dispersion, optional lifespan
  FIRE: 4, // burns, ignites, rises, dies
  VINE: 5, // static but grows upward while it has life
  EMITTER: 6, // torch: static, spawns fire above
  SPARK: 7, // travels through metal as a pulse
  CLONE: 8, // memorizes first contact, then replicates it
  ANT: 9, // living powder: tunnels sideways through powders
  VIRUS: 10, // converts neighbors, then dies
  METAL: 11, // static conductor with a refractory cooldown after a spark passes
  SUPERBALL: 12, // powder that bounces back up on landing
  BIRD: 13, // flying walker: stays airborne, avoids ground
  CLOUD: 14, // floats in place, grows from steam, rains
  LASER: 15, // straight ray, 3 cells/tick, passes glass, ignites on hit
  THUNDER: 16, // bolt: drops fast, blasts on impact, sparks metal
  ROCKET: 17, // lit fireworks: climbs with a fire trail, bursts
  PUMP: 18, // absorbs adjacent fluids; tokens travel the line, eject at ends
  CANNON: 19, // sparked: launches breech material ballistically from the muzzle
  DETECTOR: 20, // clone-style memory; emits free sparks when its species touches
  VALVE: 21, // sparked: open drop-gate for a short while, else solid
  FILTER: 22, // passes gases (light up, heavy down), blocks everything else
} as const;

export interface ElementDef {
  id: number;
  name: string;
  color: string;
  behavior: number;
  density: number; // heavier displaces lighter (255 = immovable)
  disperse: number; // lateral scan distance for liquids/gases
  flammable: number; // 0-255 chance per hot-contact tick
  burnLife: number; // fire lifetime when this element ignites
  life0: number; // initial life value when spawned
  explodeR: number; // >0: ignition triggers a blast of this radius
  hot: boolean; // ignites flammables on contact
  melts: number; // legacy contact-melt target (superseded by the temp field)
  device: boolean; // palette grouping: devices vs substances
  // ---- M3 temperature field ----
  temp0: number; // spawn temperature, °C (painted into the heat field)
  pump: number; // 0-1: how strongly the element drives the field toward temp0
  hotAt: number; // T above this transforms the cell...
  hotTo: number; // ...into this element (0 = no hot transition)
  coldAt: number; // T below this transforms the cell...
  coldTo: number; // ...into this element (0 = no cold transition)
  ignitesAt: number; // T above this auto-ignites (uses flammable pathway)
}

const def = (d: Partial<ElementDef> & { id: number; name: string; color: string }): ElementDef => ({
  behavior: B.NONE,
  density: 0,
  disperse: 0,
  flammable: 0,
  burnLife: 30,
  life0: 0,
  explodeR: 0,
  hot: false,
  melts: 0,
  device: false,
  temp0: 20,
  pump: 0,
  hotAt: 0,
  hotTo: 0,
  coldAt: 0,
  coldTo: 0,
  ignitesAt: 0,
  ...d,
});

export const ELEMENTS: ElementDef[] = [
  def({ id: E.EMPTY, name: "Empty", color: "#0b0d10" }),
  def({ id: E.WALL, name: "Wall", color: "#5c6169", density: 255 }),
  def({ id: E.POWDER, name: "Powder", color: "#cfb47c", behavior: B.POWDER, density: 60, flammable: 15, burnLife: 20 }),
  def({ id: E.WATER, name: "Water", color: "#3a76e8", behavior: B.LIQUID, density: 30, disperse: 5, hotAt: 100, hotTo: E.STEAM, coldAt: -3, coldTo: E.ICE }),
  def({ id: E.OIL, name: "Oil", color: "#6e5b23", behavior: B.LIQUID, density: 20, disperse: 3, flammable: 40, burnLife: 70, ignitesAt: 340 }),
  def({ id: E.FIRE, name: "Fire", color: "#ff7a1a", behavior: B.FIRE, density: 1, life0: 40, hot: true, temp0: 600, pump: 0.25 }),
  def({ id: E.GAS, name: "Gas", color: "#9fe07a", behavior: B.GAS, density: 2, disperse: 3, flammable: 220, burnLife: 12, ignitesAt: 280 }),
  def({ id: E.STEAM, name: "Steam", color: "#b9c7d4", behavior: B.GAS, density: 1, disperse: 4, life0: 180, temp0: 110, pump: 0.06, coldAt: 35, coldTo: E.WATER }),
  def({ id: E.SEED, name: "Seed", color: "#7ac74f", behavior: B.POWDER, density: 55, flammable: 30, burnLife: 40 }),
  def({ id: E.VINE, name: "Vine", color: "#3f9b2f", behavior: B.VINE, density: 255, flammable: 70, burnLife: 50, life0: 36 }),
  def({ id: E.GUNPOWDER, name: "Gunpowder", color: "#4a4a52", behavior: B.POWDER, density: 58, flammable: 255, explodeR: 6, ignitesAt: 300 }),
  def({ id: E.ACID, name: "Acid", color: "#b8e33c", behavior: B.LIQUID, density: 28, disperse: 4, life0: 80 }),
  def({ id: E.STONE, name: "Stone", color: "#8d8478", behavior: B.POWDER, density: 90 }),
  def({ id: E.SALT, name: "Salt", color: "#e8e4da", behavior: B.POWDER, density: 55 }),
  def({ id: E.SEAWATER, name: "Seawater", color: "#3aa0c8", behavior: B.LIQUID, density: 32, disperse: 5, hotAt: 102, hotTo: E.STEAM }),
  def({ id: E.MAGMA, name: "Magma", color: "#e25822", behavior: B.LIQUID, density: 40, disperse: 2, hot: true, temp0: 1000, pump: 0.08, coldAt: 350, coldTo: E.STONE }),
  def({ id: E.ICE, name: "Ice", color: "#a8d8f0", density: 255, temp0: -25, pump: 0.05, hotAt: 2, hotTo: E.WATER }),
  def({ id: E.SNOW, name: "Snow", color: "#eef4f8", behavior: B.POWDER, density: 40, temp0: -8, pump: 0.03, hotAt: 1, hotTo: E.WATER }),
  def({ id: E.NITRO, name: "Nitro", color: "#7fae3e", behavior: B.LIQUID, density: 35, disperse: 3, flammable: 255, explodeR: 8, ignitesAt: 240 }),
  def({ id: E.BOMB, name: "Bomb", color: "#5a3038", behavior: B.POWDER, density: 60, flammable: 255, explodeR: 12, device: true }),
  def({ id: E.METAL, name: "Metal", color: "#8a929e", behavior: B.METAL, density: 255, device: true }),
  def({ id: E.TORCH, name: "Torch", color: "#d0582a", behavior: B.EMITTER, density: 255, hot: true, device: true, temp0: 700, pump: 0.3 }),
  def({ id: E.FUSE, name: "Fuse", color: "#b08050", density: 255, flammable: 140, burnLife: 25, device: true }),
  def({ id: E.VIRUS, name: "Virus", color: "#c05ac0", behavior: B.VIRUS, density: 55, life0: 120 }),
  def({ id: E.ANT, name: "Ant", color: "#2e2620", behavior: B.ANT, density: 60, flammable: 120, burnLife: 15 }),
  def({ id: E.MERCURY, name: "Mercury", color: "#b8bcc8", behavior: B.LIQUID, density: 120, disperse: 4 }),
  def({ id: E.SPARK, name: "Spark", color: "#ffe94a", behavior: B.SPARK, density: 255, life0: 4, hot: true, device: true, temp0: 180, pump: 0.04 }),
  def({ id: E.CLONE, name: "Clone", color: "#d8c850", behavior: B.CLONE, density: 255, device: true }),
  def({ id: E.FAN, name: "Fan", color: "#7ab8c8", density: 255, device: true }),
  def({ id: E.SAND, name: "Sand", color: "#d9a95f", behavior: B.POWDER, density: 62, hotAt: 700, hotTo: E.GLASS }),
  def({ id: E.MUD, name: "Mud", color: "#7a5c38", behavior: B.LIQUID, density: 70, disperse: 1 }),
  def({ id: E.GLASS, name: "Glass", color: "#b8d4dc", density: 255 }),
  def({ id: E.SUPERBALL, name: "Superball", color: "#e84a9a", behavior: B.SUPERBALL, density: 60 }),
  def({ id: E.BIRD, name: "Bird", color: "#e8e8f0", behavior: B.BIRD, density: 50, flammable: 100, burnLife: 15 }),
  def({ id: E.CLOUD, name: "Cloud", color: "#d8dde4", behavior: B.CLOUD, density: 255 }),
  def({ id: E.LASER, name: "Laser", color: "#ff2a2a", behavior: B.LASER, density: 1, device: true }),
  def({ id: E.THUNDER, name: "Thunder", color: "#f0f04a", behavior: B.THUNDER, density: 1 }),
  def({ id: E.FIREWORKS, name: "Fireworks", color: "#c04a68", behavior: B.POWDER, density: 55, flammable: 255, device: true, ignitesAt: 400 }),
  def({ id: E.ROCKET, name: "Rocket", color: "#ff9a4a", behavior: B.ROCKET, density: 1, life0: 30 }),
  def({ id: E.STICK, name: "Stick", color: "#181a1e", density: 255 }),
  def({ id: E.BALL, name: "Ball", color: "#c25a3a", density: 255, device: true }),
  def({ id: E.BOX, name: "Box", color: "#9a7d4e", density: 255, device: true }),
  def({ id: E.WHEEL, name: "Wheel", color: "#6e7682", density: 255, device: true }),
  def({ id: E.PUMP, name: "Pump", color: "#3f8f83", behavior: B.PUMP, density: 255, device: true }),
  def({ id: E.BUBBLE, name: "Bubble", color: "#d8c2ec", density: 255, device: true }),
  // ---- M4.5 chemistry set ----
  def({ id: E.SOAPY, name: "Soapy", color: "#e0a8c8", behavior: B.LIQUID, density: 22, disperse: 4 }),
  def({ id: E.LYE, name: "Lye", color: "#e6e2c8", behavior: B.POWDER, density: 55 }),
  def({ id: E.HYDROGEN, name: "Hydrogen", color: "#c8d8f8", behavior: B.GAS, density: 1, disperse: 4, flammable: 255, burnLife: 8, ignitesAt: 480 }),
  def({ id: E.CHLORINE, name: "Chlorine", color: "#b0b832", behavior: B.LIQUID, density: 5, disperse: 5 }),
  def({ id: E.SODA, name: "Soda", color: "#efe9d6", behavior: B.POWDER, density: 55, hotAt: 250, hotTo: E.CO2 }),
  def({ id: E.CO2, name: "CO2", color: "#6a7078", behavior: B.LIQUID, density: 3, disperse: 6 }),
  def({ id: E.OXYGEN, name: "Oxygen", color: "#c8f0e8", behavior: B.GAS, density: 2, disperse: 3 }),
  def({ id: E.RUST, name: "Rust", color: "#a05628", behavior: B.POWDER, density: 58 }),
  def({ id: E.CEMENT, name: "Cement", color: "#a8a49c", behavior: B.POWDER, density: 60 }),
  // ---- M5a recipe shelf ----
  def({ id: E.CHARCOAL, name: "Charcoal", color: "#33302c", behavior: B.POWDER, density: 45, flammable: 90, burnLife: 120 }),
  def({ id: E.SALTPETER, name: "Saltpeter", color: "#d8d2e8", behavior: B.POWDER, density: 55 }),
  def({ id: E.SULFUR, name: "Sulfur", color: "#e8d44a", behavior: B.POWDER, density: 50, flammable: 200, burnLife: 30, ignitesAt: 260 }),
  def({ id: E.LIMESTONE, name: "Limestone", color: "#cfc9b8", behavior: B.POWDER, density: 80, hotAt: 460, hotTo: E.LIME }),
  def({ id: E.LIME, name: "Lime", color: "#f4f0e2", behavior: B.POWDER, density: 36 }),
  def({ id: E.ALUMINUM, name: "Aluminum", color: "#cdd4dc", behavior: B.POWDER, density: 56 }),
  def({ id: E.THERMITE, name: "Thermite", color: "#7a4a3a", behavior: B.POWDER, density: 62, hotAt: 550, hotTo: E.MAGMA }),
  def({ id: E.GLYCERIN, name: "Glycerin", color: "#d8c8a0", behavior: B.LIQUID, density: 33, disperse: 2 }),
  def({ id: E.ALCOHOL, name: "Alcohol", color: "#c8e0d8", behavior: B.LIQUID, density: 18, disperse: 5, flammable: 230, burnLife: 25, ignitesAt: 300 }),
  // ---- M5b devices ----
  def({ id: E.CANNON, name: "Cannon", color: "#5a6472", behavior: B.CANNON, density: 255, device: true }),
  def({ id: E.DETECTOR, name: "Detector", color: "#c8a03e", behavior: B.DETECTOR, density: 255, device: true }),
  def({ id: E.VALVE, name: "Valve", color: "#8a6a9e", behavior: B.VALVE, density: 255, device: true }),
  def({ id: E.HEATER, name: "Heater", color: "#d86a3a", density: 255, device: true, temp0: 400, pump: 0.25 }),
  def({ id: E.COOLER, name: "Cooler", color: "#5a9ad8", density: 255, device: true, temp0: -60, pump: 0.25 }),
  def({ id: E.FILTER, name: "Filter", color: "#7a8a78", behavior: B.FILTER, density: 255, device: true }),
];

// Flat parallel arrays for the hot loop (no object property lookups per cell).
export const N_IDS = 128;
export const BEHAVIOR = new Uint8Array(N_IDS);
export const DENSITY = new Uint8Array(N_IDS);
export const DISPERSE = new Uint8Array(N_IDS);
export const FLAMMABLE = new Uint8Array(N_IDS);
export const BURNLIFE = new Uint8Array(N_IDS);
export const LIFE0 = new Uint8Array(N_IDS);
export const EXPLODE_R = new Uint8Array(N_IDS);
export const HOT = new Uint8Array(N_IDS);
export const MELTS = new Uint8Array(N_IDS);
export const TEMP0 = new Int16Array(N_IDS);
export const HEAT_PUMP = new Float32Array(N_IDS);
export const HOT_AT = new Int16Array(N_IDS);
export const HOT_TO = new Uint8Array(N_IDS);
export const COLD_AT = new Int16Array(N_IDS);
export const COLD_TO = new Uint8Array(N_IDS);
export const IGNITES_AT = new Int16Array(N_IDS);
// THERMAL[id] = 1 if the element pumps heat/cold or has any temperature transition
export const THERMAL = new Uint8Array(N_IDS);
// Palette as flat RGB floats for the shader uniform (vec3[N_IDS]); filled by applyDef
export const PALETTE = new Float32Array(N_IDS * 3);

function applyDef(el: ElementDef): void {
  BEHAVIOR[el.id] = el.behavior;
  DENSITY[el.id] = el.density;
  DISPERSE[el.id] = el.disperse;
  FLAMMABLE[el.id] = el.flammable;
  BURNLIFE[el.id] = el.burnLife;
  LIFE0[el.id] = el.life0;
  EXPLODE_R[el.id] = el.explodeR;
  HOT[el.id] = el.hot ? 1 : 0;
  MELTS[el.id] = el.melts;
  TEMP0[el.id] = el.temp0;
  HEAT_PUMP[el.id] = el.pump;
  HOT_AT[el.id] = el.hotTo !== 0 ? el.hotAt : 32767;
  HOT_TO[el.id] = el.hotTo;
  COLD_AT[el.id] = el.coldTo !== 0 ? el.coldAt : -32768;
  COLD_TO[el.id] = el.coldTo;
  IGNITES_AT[el.id] = el.ignitesAt > 0 ? el.ignitesAt : 32767;
  THERMAL[el.id] = el.pump > 0 || el.hotTo !== 0 || el.coldTo !== 0 || el.ignitesAt > 0 ? 1 : 0;
  const n = parseInt(el.color.slice(1), 16);
  PALETTE[el.id * 3] = ((n >> 16) & 255) / 255;
  PALETTE[el.id * 3 + 1] = ((n >> 8) & 255) / 255;
  PALETTE[el.id * 3 + 2] = (n & 255) / 255;
}

for (const el of ELEMENTS) applyDef(el);

// ---- Custom Element Maker (M4) -----------------------------------------
// User-authored elements are the same parameter bundles as built-ins.
export interface CustomSpec {
  name: string;
  color: string;
  state: "powder" | "liquid" | "gas" | "static";
  density?: number;
  flammable?: number;
  explodeR?: number;
  temp0?: number;
  pump?: number;
  hotAt?: number;
  hotTo?: number;
  coldAt?: number;
  coldTo?: number;
  ignitesAt?: number;
  // contact reactions: -1 in becomeSelf/becomeOther means "stays itself"
  reactions?: Array<{ with: number; becomeSelf: number; becomeOther: number; p: number }>;
}

export function registerElement(spec: CustomSpec): number | null {
  const id = ELEMENTS.length;
  if (id >= N_IDS) return null;
  const behavior =
    spec.state === "powder" ? B.POWDER :
    spec.state === "liquid" ? B.LIQUID :
    spec.state === "gas" ? B.GAS : B.NONE;
  const el = def({
    id,
    name: String(spec.name).slice(0, 12) || `Custom${id}`,
    color: /^#[0-9a-f]{6}$/i.test(spec.color) ? spec.color : "#c0c0c0",
    behavior,
    density: spec.state === "static" ? 255 : Math.max(1, Math.min(200, spec.density ?? 60)),
    disperse: spec.state === "liquid" ? 4 : spec.state === "gas" ? 3 : 0,
    flammable: Math.max(0, Math.min(255, spec.flammable ?? 0)),
    burnLife: 40,
    explodeR: Math.max(0, Math.min(16, spec.explodeR ?? 0)),
    temp0: spec.temp0 ?? 20,
    pump: Math.max(0, Math.min(0.35, spec.pump ?? 0)),
    hotAt: spec.hotAt ?? 0,
    hotTo: spec.hotTo ?? 0,
    coldAt: spec.coldAt ?? 0,
    coldTo: spec.coldTo ?? 0,
    ignitesAt: spec.ignitesAt ?? 0,
  });
  ELEMENTS.push(el);
  applyDef(el);
  if (spec.reactions) {
    for (const r of spec.reactions) {
      if (r.with > E.WALL && r.with < ELEMENTS.length) {
        const newA = r.becomeSelf === -1 ? id : Math.max(0, Math.min(ELEMENTS.length - 1, r.becomeSelf));
        const newB = r.becomeOther === -1 ? r.with : Math.max(0, Math.min(ELEMENTS.length - 1, r.becomeOther));
        react(id, r.with, newA, newB, Math.max(1, Math.min(255, r.p || 60)));
      }
    }
  }
  return id;
}

// ---- contact reaction table (the Dan-Ball wiki reaction table, data-driven) ----
// REACT[a * N_IDS + b] packs: prob(0-255) << 16 | newA << 8 | newB.
// "a touches b → a becomes newA, b becomes newB, with probability prob/256 per tick."
export const REACT = new Uint32Array(N_IDS * N_IDS);
const react = (a: number, b: number, newA: number, newB: number, prob: number): void => {
  REACT[a * N_IDS + b] = (prob << 16) | (newA << 8) | newB;
  REACT[b * N_IDS + a] = (prob << 16) | (newB << 8) | newA; // symmetric, roles swapped
  HAS_REACT[a] = 1;
  HAS_REACT[b] = 1;
};

// HAS_REACT[id] = 1 if the element appears in any reaction — lets the hot loop
// skip the reaction roll entirely for inert elements (big perf win).
export const HAS_REACT = new Uint8Array(N_IDS);

react(E.SALT, E.WATER, E.EMPTY, E.SEAWATER, 60); // salt dissolves
react(E.MAGMA, E.WATER, E.STONE, E.STEAM, 220); // magma quenches
react(E.MAGMA, E.SEAWATER, E.STONE, E.STEAM, 220);
react(E.MAGMA, E.STONE, E.MAGMA, E.MAGMA, 3); // magma slowly melts stone
react(E.MAGMA, E.METAL, E.MAGMA, E.MAGMA, 2); // ...and metal
react(E.WATER, E.ICE, E.ICE, E.ICE, 1); // ice creeps through still water
react(E.ANT, E.WATER, E.EMPTY, E.WATER, 200); // ants drown
react(E.ANT, E.SEAWATER, E.EMPTY, E.SEAWATER, 200);
react(E.SAND, E.WATER, E.MUD, E.EMPTY, 12); // wet sand muddies
react(E.MUD, E.FIRE, E.SAND, E.FIRE, 30); // fire dries mud back to sand
react(E.MUD, E.MAGMA, E.SAND, E.MAGMA, 60);
react(E.STEAM, E.CLOUD, E.CLOUD, E.CLOUD, 120); // clouds grow from steam
react(E.BIRD, E.WATER, E.EMPTY, E.WATER, 200); // birds drown too

// ---- M4.5 chemistry set --------------------------------------------------
react(E.LYE, E.OIL, E.SOAPY, E.SOAPY, 40); // saponification: fat + lye = soap
react(E.LYE, E.ACID, E.SALT, E.WATER, 180); // neutralization
react(E.ACID, E.METAL, E.HYDROGEN, E.METAL, 30); // hydrogen evolution
react(E.WATER, E.SPARK, E.HYDROGEN, E.SPARK, 200); // electrolysis
react(E.SEAWATER, E.SPARK, E.CHLORINE, E.SPARK, 200); // chlor-alkali process
react(E.SODA, E.ACID, E.CO2, E.WATER, 220); // bicarbonate fizz
react(E.FIRE, E.CO2, E.EMPTY, E.CO2, 220); // CO2 smothers fire
react(E.VINE, E.CO2, E.VINE, E.OXYGEN, 25); // photosynthesis
react(E.OXYGEN, E.FIRE, E.FIRE, E.FIRE, 180); // pure O2 feeds the flame
react(E.FIRE, E.HYDROGEN, E.FIRE, E.STEAM, 60); // combustion product is water
react(E.CHLORINE, E.VINE, E.CHLORINE, E.EMPTY, 120); // defoliant
react(E.CHLORINE, E.ANT, E.CHLORINE, E.EMPTY, 160); // toxic to critters
react(E.CHLORINE, E.BIRD, E.CHLORINE, E.EMPTY, 160);
react(E.CHLORINE, E.WATER, E.ACID, E.WATER, 2); // chlorine water turns acidic
// (metal rusting lives in doMetalCool: seawater + AIR at the waterline only —
// a table row ate submerged electrodes and tanks in seconds)
react(E.CEMENT, E.WATER, E.STONE, E.EMPTY, 60); // cement sets, absorbing water
react(E.HYDROGEN, E.CHLORINE, E.ACID, E.ACID, 40); // H2+Cl2 = acid factory
react(E.LYE, E.CO2, E.SODA, E.EMPTY, 60); // lye scrubs CO2 into carbonate
react(E.RUST, E.HYDROGEN, E.METAL, E.STEAM, 40); // hydrogen smelts rust back
react(E.SALT, E.SNOW, E.EMPTY, E.WATER, 30); // road salt melts snow...
react(E.SALT, E.ICE, E.EMPTY, E.WATER, 15); // ...and ice
react(E.CHLORINE, E.VIRUS, E.CHLORINE, E.EMPTY, 200); // bleach disinfects
react(E.CHLORINE, E.SEED, E.CHLORINE, E.EMPTY, 120); // herbicide
react(E.METAL, E.MERCURY, E.MERCURY, E.MERCURY, 1); // slow amalgamation

// ---- M5a recipe shelf ------------------------------------------------------
react(E.SALTPETER, E.CHARCOAL, E.GUNPOWDER, E.GUNPOWDER, 50); // the recipe
react(E.SULFUR, E.GUNPOWDER, E.GUNPOWDER, E.GUNPOWDER, 20); // sulfur enriches
react(E.LIME, E.WATER, E.CEMENT, E.EMPTY, 80); // slaking
react(E.LIME, E.CO2, E.LIMESTONE, E.EMPTY, 40); // carbonation closes the cycle
react(E.ALUMINUM, E.RUST, E.THERMITE, E.THERMITE, 50); // thermite mix
react(E.GLYCERIN, E.ACID, E.NITRO, E.NITRO, 25); // nitration

