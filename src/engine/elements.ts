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
  LITMUS: 69, // indicator powder: takes the color of the pH it touches
  // ---- M5f metals & mediums ----
  WOOD: 70, // building material; fire chars it into charcoal
  WAX: 71, // melts at 62° into tallow; tallow refreezes — thermal storage
  TALLOW: 72, // molten wax: slow candle fuel
  TAR: 73, // viscous, sticky, burns long; traps critters
  COPPER: 74, // fast conductor (refractory 8); waterline-patinas to verdigris
  GOLD: 75, // noble: nothing corrodes it — only mercury takes it
  TUNGSTEN: 76, // conducts and shrugs off magma: lava-proof wiring
  VERDIGRIS: 77, // green copper patina; roasts back to copper
  SMOKE: 78, // fires billow it; drifts with the wind, fades out
  // ---- M5g reactive shelf III ----
  SODIUM: 79, // alkali metal: floats on water and detonates its own hydrogen; store under oil
  MAGNESIUM: 80, // ignites at 470° and burns as a long white-hot ember — the thermite match
  MAGNESIA: 81, // MgO: refractory white powder; mildly basic (antacid)
  PHOSPHORUS: 82, // white P: pyrophoric above 34° — store it under water
  PEROXIDE: 83, // H2O2: rust/metal catalyze O2 evolution; + soap = elephant toothpaste
  SUGAR: 84, // dissolves, caramel-chars at 190°; + saltpeter = rocket candy, + yeast = ferment
  YEAST: 85, // ferments sugar into alcohol + CO2
  CARBIDE: 86, // CaC2: + water = acetylene + lime (the miner's lamp)
  ACETYLENE: 87, // hottest common fuel gas — the welding flame
  SO2: 88, // choking dense gas off burning sulfur; seeds acid rain
  BLEACH: 89, // hypochlorite: disinfects; NEVER mix with acid (chlorine release)
  // ---- M5h reactive shelf IV ----
  AMMONIA: 90, // base gas: + acid = saltpeter (renewable gunpowder), fertilizes vines
  IODINE: 91, // sublimes at 184° into violet vapor; antiseptic
  IODINE_V: 92, // dense violet vapor; deposits back to crystals on cool surfaces
  CINNABAR: 93, // HgS vermilion ore: roasts into mercury + SO2
  LN2: 94, // liquid nitrogen: floats on water, flash-freezes, boils off at -180°
  GALLIUM: 95, // metal that melts at 30° — hand-warmth liquefies it
  LGALLIUM: 96, // molten gallium; embrittles aluminum to dust, refreezes at 25°
  DRYICE: 97, // solid CO2 at -78°: sublimates into the fire-blanket gas
  NITROGEN: 98, // boiled-off N2: inert, disperses back into the air
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
  LITMUS: 23, // falls like powder, samples neighbor pH into its shade byte
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
  ph: number; // 0-14 acidity for aqueous chemistry; 255 = not applicable
  group: string; // palette rail; "" = derived from behavior/device
  conducts: number; // >0: carries spark pulses; value = refractory ticks
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
  ph: 255,
  group: "",
  conducts: 0,
  ...d,
});

export const ELEMENTS: ElementDef[] = [
  def({ id: E.EMPTY, name: "Empty", color: "#0b0d10" }),
  def({ id: E.WALL, name: "Wall", color: "#5c6169", density: 255 }),
  def({ id: E.POWDER, name: "Powder", color: "#cfb47c", behavior: B.POWDER, density: 60, flammable: 15, burnLife: 20 }),
  def({ id: E.WATER, name: "Water", color: "#3a76e8", behavior: B.LIQUID, density: 30, disperse: 5, hotAt: 100, hotTo: E.STEAM, coldAt: -3, coldTo: E.ICE, ph: 7 }),
  def({ id: E.OIL, name: "Oil", color: "#6e5b23", behavior: B.LIQUID, density: 20, disperse: 3, flammable: 40, burnLife: 70, ignitesAt: 340 }),
  def({ id: E.FIRE, name: "Fire", color: "#ff7a1a", behavior: B.FIRE, density: 1, life0: 40, hot: true, temp0: 600, pump: 0.25, group: "LIFE & ENERGY" }),
  def({ id: E.GAS, name: "Gas", color: "#9fe07a", behavior: B.GAS, density: 2, disperse: 3, flammable: 220, burnLife: 12, ignitesAt: 280 }),
  def({ id: E.STEAM, name: "Steam", color: "#b9c7d4", behavior: B.GAS, density: 1, disperse: 4, life0: 180, temp0: 110, pump: 0.06, coldAt: 35, coldTo: E.WATER }),
  def({ id: E.SEED, name: "Seed", color: "#7ac74f", behavior: B.POWDER, density: 55, flammable: 30, burnLife: 40, group: "LIFE & ENERGY" }),
  def({ id: E.VINE, name: "Vine", color: "#3f9b2f", behavior: B.VINE, density: 255, flammable: 70, burnLife: 50, life0: 36, group: "LIFE & ENERGY" }),
  def({ id: E.GUNPOWDER, name: "Gunpowder", color: "#4a4a52", behavior: B.POWDER, density: 58, flammable: 255, explodeR: 6, ignitesAt: 300, group: "REAGENTS" }),
  def({ id: E.ACID, name: "Acid", color: "#b8e33c", behavior: B.LIQUID, density: 28, disperse: 4, life0: 80, ph: 1 }),
  def({ id: E.STONE, name: "Stone", color: "#8d8478", behavior: B.POWDER, density: 90 }),
  def({ id: E.SALT, name: "Salt", color: "#e8e4da", behavior: B.POWDER, density: 55, group: "REAGENTS" }),
  def({ id: E.SEAWATER, name: "Seawater", color: "#3aa0c8", behavior: B.LIQUID, density: 32, disperse: 5, hotAt: 102, hotTo: E.STEAM, ph: 8 }),
  def({ id: E.MAGMA, name: "Magma", color: "#e25822", behavior: B.LIQUID, density: 40, disperse: 2, hot: true, temp0: 1000, pump: 0.08, coldAt: 350, coldTo: E.STONE }),
  def({ id: E.ICE, name: "Ice", color: "#a8d8f0", density: 255, temp0: -25, pump: 0.05, hotAt: 2, hotTo: E.WATER }),
  def({ id: E.SNOW, name: "Snow", color: "#eef4f8", behavior: B.POWDER, density: 40, temp0: -8, pump: 0.03, hotAt: 1, hotTo: E.WATER }),
  def({ id: E.NITRO, name: "Nitro", color: "#7fae3e", behavior: B.LIQUID, density: 35, disperse: 3, flammable: 255, explodeR: 8, ignitesAt: 240, ph: 2 }),
  def({ id: E.BOMB, name: "Bomb", color: "#5a3038", behavior: B.POWDER, density: 60, flammable: 255, explodeR: 12, device: true }),
  def({ id: E.METAL, name: "Metal", color: "#8a929e", behavior: B.METAL, density: 255, conducts: 12, group: "METALS" }),
  def({ id: E.TORCH, name: "Torch", color: "#d0582a", behavior: B.EMITTER, density: 255, hot: true, device: true, temp0: 700, pump: 0.3 }),
  def({ id: E.FUSE, name: "Fuse", color: "#b08050", density: 255, flammable: 140, burnLife: 25, device: true }),
  def({ id: E.VIRUS, name: "Virus", color: "#c05ac0", behavior: B.VIRUS, density: 55, life0: 120, group: "LIFE & ENERGY" }),
  def({ id: E.ANT, name: "Ant", color: "#2e2620", behavior: B.ANT, density: 60, flammable: 120, burnLife: 15, group: "LIFE & ENERGY" }),
  def({ id: E.MERCURY, name: "Mercury", color: "#b8bcc8", behavior: B.LIQUID, density: 120, disperse: 4 }),
  def({ id: E.SPARK, name: "Spark", color: "#ffe94a", behavior: B.SPARK, density: 255, life0: 4, hot: true, device: true, temp0: 180, pump: 0.04 }),
  def({ id: E.CLONE, name: "Clone", color: "#d8c850", behavior: B.CLONE, density: 255, device: true }),
  def({ id: E.FAN, name: "Fan", color: "#7ab8c8", density: 255, device: true }),
  def({ id: E.SAND, name: "Sand", color: "#d9a95f", behavior: B.POWDER, density: 62, hotAt: 700, hotTo: E.GLASS }),
  def({ id: E.MUD, name: "Mud", color: "#7a5c38", behavior: B.LIQUID, density: 70, disperse: 1, ph: 6 }),
  def({ id: E.GLASS, name: "Glass", color: "#b8d4dc", density: 255 }),
  def({ id: E.SUPERBALL, name: "Superball", color: "#e84a9a", behavior: B.SUPERBALL, density: 60, group: "LIFE & ENERGY" }),
  def({ id: E.BIRD, name: "Bird", color: "#e8e8f0", behavior: B.BIRD, density: 50, flammable: 100, burnLife: 15, group: "LIFE & ENERGY" }),
  def({ id: E.CLOUD, name: "Cloud", color: "#d8dde4", behavior: B.CLOUD, density: 255, group: "LIFE & ENERGY" }),
  def({ id: E.LASER, name: "Laser", color: "#ff2a2a", behavior: B.LASER, density: 1, device: true }),
  def({ id: E.THUNDER, name: "Thunder", color: "#f0f04a", behavior: B.THUNDER, density: 1, group: "LIFE & ENERGY" }),
  def({ id: E.FIREWORKS, name: "Fireworks", color: "#c04a68", behavior: B.POWDER, density: 55, flammable: 255, device: true, ignitesAt: 400, group: "LIFE & ENERGY" }),
  def({ id: E.ROCKET, name: "Rocket", color: "#ff9a4a", behavior: B.ROCKET, density: 1, life0: 30 }),
  def({ id: E.STICK, name: "Stick", color: "#181a1e", density: 255, group: "HIDDEN" }),
  def({ id: E.BALL, name: "Ball", color: "#c25a3a", density: 255, device: true }),
  def({ id: E.BOX, name: "Box", color: "#9a7d4e", density: 255, device: true }),
  def({ id: E.WHEEL, name: "Wheel", color: "#6e7682", density: 255, device: true }),
  def({ id: E.PUMP, name: "Pump", color: "#3f8f83", behavior: B.PUMP, density: 255, device: true }),
  def({ id: E.BUBBLE, name: "Bubble", color: "#d8c2ec", density: 255, device: true }),
  // ---- M4.5 chemistry set ----
  def({ id: E.SOAPY, name: "Soapy", color: "#e0a8c8", behavior: B.LIQUID, density: 22, disperse: 4, ph: 10 }),
  def({ id: E.LYE, name: "Lye", color: "#e6e2c8", behavior: B.POWDER, density: 55, ph: 13, group: "REAGENTS" }),
  def({ id: E.HYDROGEN, name: "Hydrogen", color: "#c8d8f8", behavior: B.GAS, density: 1, disperse: 4, flammable: 255, burnLife: 8, ignitesAt: 480 }),
  def({ id: E.CHLORINE, name: "Chlorine", color: "#b0b832", behavior: B.LIQUID, density: 5, disperse: 5, ph: 3 }),
  def({ id: E.SODA, name: "Soda", color: "#efe9d6", behavior: B.POWDER, density: 55, hotAt: 250, hotTo: E.CO2, ph: 9, group: "REAGENTS" }),
  def({ id: E.CO2, name: "CO2", color: "#6a7078", behavior: B.LIQUID, density: 3, disperse: 6 }),
  def({ id: E.OXYGEN, name: "Oxygen", color: "#c8f0e8", behavior: B.GAS, density: 2, disperse: 3 }),
  def({ id: E.RUST, name: "Rust", color: "#a05628", behavior: B.POWDER, density: 58, group: "METALS" }),
  def({ id: E.CEMENT, name: "Cement", color: "#a8a49c", behavior: B.POWDER, density: 60, group: "REAGENTS" }),
  // ---- M5a recipe shelf ----
  def({ id: E.CHARCOAL, name: "Charcoal", color: "#33302c", behavior: B.POWDER, density: 45, flammable: 40, burnLife: 120, group: "REAGENTS" }),
  def({ id: E.SALTPETER, name: "Saltpeter", color: "#d8d2e8", behavior: B.POWDER, density: 55, group: "REAGENTS" }),
  def({ id: E.SULFUR, name: "Sulfur", color: "#e8d44a", behavior: B.POWDER, density: 50, flammable: 200, burnLife: 30, ignitesAt: 260, group: "REAGENTS" }),
  def({ id: E.LIMESTONE, name: "Limestone", color: "#cfc9b8", behavior: B.POWDER, density: 80, hotAt: 460, hotTo: E.LIME }),
  def({ id: E.LIME, name: "Lime", color: "#f4f0e2", behavior: B.POWDER, density: 36, ph: 12, group: "REAGENTS" }),
  def({ id: E.ALUMINUM, name: "Aluminum", color: "#cdd4dc", behavior: B.POWDER, density: 56, group: "METALS" }),
  def({ id: E.THERMITE, name: "Thermite", color: "#7a4a3a", behavior: B.POWDER, density: 62, hotAt: 550, hotTo: E.MAGMA, group: "METALS" }),
  def({ id: E.GLYCERIN, name: "Glycerin", color: "#d8c8a0", behavior: B.LIQUID, density: 33, disperse: 2, ph: 6 }),
  def({ id: E.ALCOHOL, name: "Alcohol", color: "#c8e0d8", behavior: B.LIQUID, density: 18, disperse: 5, flammable: 230, burnLife: 25, ignitesAt: 300, ph: 7 }),
  // ---- M5b devices ----
  def({ id: E.CANNON, name: "Cannon", color: "#5a6472", behavior: B.CANNON, density: 255, device: true }),
  def({ id: E.DETECTOR, name: "Detector", color: "#c8a03e", behavior: B.DETECTOR, density: 255, device: true }),
  def({ id: E.VALVE, name: "Valve", color: "#8a6a9e", behavior: B.VALVE, density: 255, device: true }),
  def({ id: E.HEATER, name: "Heater", color: "#d86a3a", density: 255, device: true, temp0: 400, pump: 0.25 }),
  def({ id: E.COOLER, name: "Cooler", color: "#5a9ad8", density: 255, device: true, temp0: -60, pump: 0.25 }),
  def({ id: E.FILTER, name: "Filter", color: "#7a8a78", behavior: B.FILTER, density: 255, device: true }),
  def({ id: E.LITMUS, name: "Litmus", color: "#b8a8d0", behavior: B.LITMUS, density: 50, group: "REAGENTS" }),
  // ---- M5f metals & mediums ----
  def({ id: E.WOOD, name: "Wood", color: "#7a5a33", density: 255, flammable: 12, burnLife: 80 }),
  def({ id: E.WAX, name: "Wax", color: "#e8dcc0", density: 255, hotAt: 62, hotTo: E.TALLOW }),
  def({ id: E.TALLOW, name: "Tallow", color: "#e0d0a8", behavior: B.LIQUID, density: 21, disperse: 2, coldAt: 45, coldTo: E.WAX, flammable: 25, burnLife: 120 }),
  def({ id: E.TAR, name: "Tar", color: "#26221e", behavior: B.LIQUID, density: 25, disperse: 1, flammable: 35, burnLife: 160, ignitesAt: 380 }),
  def({ id: E.COPPER, name: "Copper", color: "#c87f4a", behavior: B.METAL, density: 255, conducts: 8, group: "METALS" }),
  def({ id: E.GOLD, name: "Gold", color: "#e8c34a", behavior: B.METAL, density: 255, conducts: 10, group: "METALS" }),
  def({ id: E.TUNGSTEN, name: "Tungsten", color: "#4a5058", behavior: B.METAL, density: 255, conducts: 16, group: "METALS" }),
  def({ id: E.VERDIGRIS, name: "Verdigris", color: "#5aa88a", behavior: B.POWDER, density: 57, group: "METALS" }),
  def({ id: E.SMOKE, name: "Smoke", color: "#33363c", behavior: B.GAS, density: 1, disperse: 3, life0: 140 }),
  // ---- M5g reactive shelf III (density 28 < water 30: sodium FLOATS on the
  // pool it attacks, but sinks under oil 20 — real alkali-metal storage) ----
  def({ id: E.SODIUM, name: "Sodium", color: "#d8d4c0", behavior: B.POWDER, density: 28, group: "REAGENTS" }),
  def({ id: E.MAGNESIUM, name: "Magnesium", color: "#c4ccd8", behavior: B.POWDER, density: 58, flammable: 160, burnLife: 200, ignitesAt: 470, group: "REAGENTS" }),
  def({ id: E.MAGNESIA, name: "Magnesia", color: "#f0eee6", behavior: B.POWDER, density: 60, ph: 10, group: "REAGENTS" }),
  def({ id: E.PHOSPHORUS, name: "Phosphorus", color: "#e8e2a8", behavior: B.POWDER, density: 45, flammable: 255, burnLife: 60, ignitesAt: 34, group: "REAGENTS" }),
  def({ id: E.PEROXIDE, name: "Peroxide", color: "#d4e8ea", behavior: B.LIQUID, density: 31, disperse: 4, ph: 5 }),
  def({ id: E.SUGAR, name: "Sugar", color: "#f2f0ea", behavior: B.POWDER, density: 40, flammable: 30, burnLife: 60, hotAt: 190, hotTo: E.CHARCOAL, ignitesAt: 350, group: "REAGENTS" }),
  def({ id: E.YEAST, name: "Yeast", color: "#d8c8a0", behavior: B.POWDER, density: 35, group: "REAGENTS" }),
  def({ id: E.CARBIDE, name: "Carbide", color: "#686c74", behavior: B.POWDER, density: 75, group: "REAGENTS" }),
  def({ id: E.ACETYLENE, name: "Acetylene", color: "#c8b8d8", behavior: B.GAS, density: 1, disperse: 4, flammable: 255, burnLife: 18, ignitesAt: 305 }),
  def({ id: E.SO2, name: "SO2", color: "#a8a468", behavior: B.LIQUID, density: 4, disperse: 5 }),
  def({ id: E.BLEACH, name: "Bleach", color: "#e6f0d8", behavior: B.LIQUID, density: 31, disperse: 4, ph: 12 }),
  // ---- M5h reactive shelf IV ----
  def({ id: E.AMMONIA, name: "Ammonia", color: "#c0d8c0", behavior: B.GAS, density: 1, disperse: 4, ph: 11 }),
  def({ id: E.IODINE, name: "Iodine", color: "#5a4668", behavior: B.POWDER, density: 65, hotAt: 184, hotTo: E.IODINE_V, group: "REAGENTS" }),
  // iodine vapor is far denser than air — chlorine-pattern dense gas that pools
  def({ id: E.IODINE_V, name: "Iodine gas", color: "#9a6ab8", behavior: B.LIQUID, density: 6, disperse: 4, coldAt: 45, coldTo: E.IODINE }),
  def({ id: E.CINNABAR, name: "Cinnabar", color: "#b84a3a", behavior: B.POWDER, density: 90, group: "REAGENTS" }),
  // 0.81 g/cm3: LN2 floats ON the pool it flash-freezes, then boils away
  def({ id: E.LN2, name: "Liq. N2", color: "#bcd8e8", behavior: B.LIQUID, density: 24, disperse: 5, temp0: -196, pump: 0.3, hotAt: -180, hotTo: E.NITROGEN }),
  def({ id: E.GALLIUM, name: "Gallium", color: "#b8c0c8", behavior: B.POWDER, density: 75, hotAt: 30, hotTo: E.LGALLIUM, group: "METALS" }),
  def({ id: E.LGALLIUM, name: "Molten Ga", color: "#c8ccd0", behavior: B.LIQUID, density: 74, disperse: 3, coldAt: 25, coldTo: E.GALLIUM, group: "METALS" }),
  def({ id: E.DRYICE, name: "Dry ice", color: "#dce8ec", behavior: B.POWDER, density: 60, temp0: -78, pump: 0.25, hotAt: -60, hotTo: E.CO2, group: "REAGENTS" }),
  def({ id: E.NITROGEN, name: "Nitrogen", color: "#c6ccd2", behavior: B.GAS, density: 1, disperse: 4, life0: 200 }),
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
export const PH = new Uint8Array(N_IDS).fill(255);
// conductor family: CONDUCTS = refractory ticks (0 = insulator); a spark on a
// wire remembers which conductor it was via CONDUCT_IDX (2 bits in shade)
export const CONDUCTS = new Uint8Array(N_IDS);
export const CONDUCT_IDX = new Uint8Array(N_IDS);
export const CONDUCTOR_IDS = [E.METAL, E.COPPER, E.GOLD, E.TUNGSTEN];
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
  PH[el.id] = el.ph;
  CONDUCTS[el.id] = el.conducts;
  THERMAL[el.id] = el.pump > 0 || el.hotTo !== 0 || el.coldTo !== 0 || el.ignitesAt > 0 ? 1 : 0;
  const n = parseInt(el.color.slice(1), 16);
  PALETTE[el.id * 3] = ((n >> 16) & 255) / 255;
  PALETTE[el.id * 3 + 1] = ((n >> 8) & 255) / 255;
  PALETTE[el.id * 3 + 2] = (n & 255) / 255;
}

for (const el of ELEMENTS) applyDef(el);
CONDUCTOR_IDS.forEach((id, k) => { CONDUCT_IDX[id] = k; });

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
// M5c observability: per-pair fire counters (canonical low*N+high key) and the
// proper names shown in the Lab Notebook when a reaction is first discovered
export const REACT_COUNT = new Uint32Array(N_IDS * N_IDS);
export const REACT_NAME: Record<number, string> = {};
// M5d thermochemistry: heat released (+) or absorbed (-) at the reaction site,
// pumped straight into the temperature field (canonical pair key)
export const REACT_DT = new Int16Array(N_IDS * N_IDS);
export const pairKey = (a: number, b: number): number =>
  a < b ? a * N_IDS + b : b * N_IDS + a;
const react = (a: number, b: number, newA: number, newB: number, prob: number, name?: string, dT?: number): void => {
  REACT[a * N_IDS + b] = (prob << 16) | (newA << 8) | newB;
  REACT[b * N_IDS + a] = (prob << 16) | (newB << 8) | newA; // symmetric, roles swapped
  HAS_REACT[a] = 1;
  HAS_REACT[b] = 1;
  if (name) REACT_NAME[pairKey(a, b)] = name;
  if (dT) REACT_DT[pairKey(a, b)] = dT;
};

// HAS_REACT[id] = 1 if the element appears in any reaction — lets the hot loop
// skip the reaction roll entirely for inert elements (big perf win).
export const HAS_REACT = new Uint8Array(N_IDS);

react(E.SALT, E.WATER, E.EMPTY, E.SEAWATER, 60, "Dissolution", -2); // salt dissolves
react(E.MAGMA, E.WATER, E.STONE, E.STEAM, 220, "Quenching"); // magma quenches
react(E.MAGMA, E.SEAWATER, E.STONE, E.STEAM, 220, "Quenching");
react(E.MAGMA, E.STONE, E.MAGMA, E.MAGMA, 3, "Remelting"); // magma slowly melts stone
react(E.MAGMA, E.METAL, E.MAGMA, E.MAGMA, 2, "Foundry melt"); // ...and metal
react(E.WATER, E.ICE, E.ICE, E.ICE, 1, "Ice creep"); // ice creeps through still water
react(E.ANT, E.WATER, E.EMPTY, E.WATER, 200); // ants drown
react(E.ANT, E.SEAWATER, E.EMPTY, E.SEAWATER, 200);
react(E.SAND, E.WATER, E.MUD, E.EMPTY, 12, "Mudding"); // wet sand muddies
react(E.MUD, E.FIRE, E.SAND, E.FIRE, 30, "Kiln drying"); // fire dries mud back to sand
react(E.MUD, E.MAGMA, E.SAND, E.MAGMA, 60, "Kiln drying");
react(E.STEAM, E.CLOUD, E.CLOUD, E.CLOUD, 120, "Cloud seeding"); // clouds grow from steam
react(E.BIRD, E.WATER, E.EMPTY, E.WATER, 200); // birds drown too

// ---- M4.5 chemistry set --------------------------------------------------
react(E.LYE, E.OIL, E.SOAPY, E.SOAPY, 40, "Saponification", 25); // saponification: fat + lye = soap
react(E.LYE, E.ACID, E.SALT, E.WATER, 180, "Neutralization", 90); // neutralization
react(E.ACID, E.METAL, E.HYDROGEN, E.METAL, 30, "Hydrogen evolution", 10); // hydrogen evolution
react(E.WATER, E.SPARK, E.HYDROGEN, E.SPARK, 200, "Electrolysis"); // electrolysis
react(E.SEAWATER, E.SPARK, E.CHLORINE, E.SPARK, 200, "Chlor-alkali process"); // chlor-alkali process
react(E.SODA, E.ACID, E.CO2, E.WATER, 220, "Carbonation fizz", -15); // bicarbonate fizz
react(E.FIRE, E.CO2, E.EMPTY, E.CO2, 220, "Fire suppression", -20); // CO2 smothers fire
react(E.VINE, E.CO2, E.VINE, E.OXYGEN, 25, "Photosynthesis"); // photosynthesis
react(E.OXYGEN, E.FIRE, E.FIRE, E.FIRE, 180, "Oxygen flare", 60); // pure O2 feeds the flame
react(E.FIRE, E.HYDROGEN, E.FIRE, E.STEAM, 60, "Hydrogen burn", 100); // combustion product is water
react(E.CHLORINE, E.VINE, E.CHLORINE, E.EMPTY, 120, "Defoliation"); // defoliant
react(E.CHLORINE, E.ANT, E.CHLORINE, E.EMPTY, 160, "Fumigation"); // toxic to critters
react(E.CHLORINE, E.BIRD, E.CHLORINE, E.EMPTY, 160, "Fumigation");
react(E.CHLORINE, E.WATER, E.ACID, E.WATER, 2, "Chlorination"); // chlorine water turns acidic
// (metal rusting lives in doMetalCool: seawater + AIR at the waterline only —
// a table row ate submerged electrodes and tanks in seconds)
react(E.CEMENT, E.WATER, E.STONE, E.EMPTY, 60, "Concrete set", 15); // cement sets, absorbing water
react(E.HYDROGEN, E.CHLORINE, E.ACID, E.ACID, 40, "Acid synthesis", 80); // H2+Cl2 = acid factory
react(E.LYE, E.CO2, E.SODA, E.EMPTY, 60, "Carbon scrubbing", 40); // lye scrubs CO2 into carbonate
react(E.RUST, E.HYDROGEN, E.METAL, E.STEAM, 40, "Smelting", 50); // hydrogen smelts rust back
react(E.SALT, E.SNOW, E.EMPTY, E.WATER, 30, "De-icing", -6); // road salt melts snow...
react(E.SALT, E.ICE, E.EMPTY, E.WATER, 15, "De-icing", -6); // ...and ice
react(E.CHLORINE, E.VIRUS, E.CHLORINE, E.EMPTY, 200, "Disinfection"); // bleach disinfects
react(E.CHLORINE, E.SEED, E.CHLORINE, E.EMPTY, 120, "Herbicide"); // herbicide
react(E.METAL, E.MERCURY, E.MERCURY, E.MERCURY, 1, "Amalgamation"); // slow amalgamation

// ---- M5a recipe shelf ------------------------------------------------------
react(E.SALTPETER, E.CHARCOAL, E.GUNPOWDER, E.GUNPOWDER, 50, "Gunpowder milling"); // the recipe
react(E.SULFUR, E.GUNPOWDER, E.GUNPOWDER, E.GUNPOWDER, 20, "Powder enrichment"); // sulfur enriches
react(E.LIME, E.WATER, E.CEMENT, E.EMPTY, 80, "Slaking", 120); // slaking
react(E.LIME, E.CO2, E.LIMESTONE, E.EMPTY, 40, "Carbonation", 30); // carbonation closes the cycle
react(E.ALUMINUM, E.RUST, E.THERMITE, E.THERMITE, 50, "Thermite mixing"); // thermite mix
react(E.GLYCERIN, E.ACID, E.NITRO, E.NITRO, 25, "Nitration", 45); // nitration

// ---- M5f metals & mediums ---------------------------------------------------
react(E.WOOD, E.FIRE, E.CHARCOAL, E.EMPTY, 60, "Charring"); // char smothers its flame
react(E.TAR, E.ANT, E.TAR, E.EMPTY, 80, "Tar pit");
react(E.TAR, E.BIRD, E.TAR, E.EMPTY, 80, "Tar pit");
react(E.MAGMA, E.COPPER, E.MAGMA, E.MAGMA, 2, "Foundry melt");
react(E.MERCURY, E.GOLD, E.MERCURY, E.MERCURY, 2, "Gold amalgam");
react(E.VERDIGRIS, E.FIRE, E.COPPER, E.FIRE, 20, "Patina roasting");

// ---- M5g reactive shelf III -------------------------------------------------
// 2Na + 2H2O -> 2NaOH + H2, violently exothermic; the +70° pump routinely
// crosses hydrogen's 480° autoignition, so the pool detonates its own gas
react(E.SODIUM, E.WATER, E.LYE, E.HYDROGEN, 200, "Alkali metal + water", 70);
react(E.SODIUM, E.SEAWATER, E.LYE, E.HYDROGEN, 200, "Alkali metal + water", 70);
react(E.SODIUM, E.CHLORINE, E.SALT, E.SALT, 120, "Direct chlorination", 50); // 2Na + Cl2 -> 2NaCl
react(E.MAGNESIUM, E.STEAM, E.MAGNESIA, E.HYDROGEN, 120, "Steam on magnesium", 60); // why you never hose a Mg fire
react(E.MAGNESIUM, E.WATER, E.MAGNESIA, E.HYDROGEN, 2, "Slow hydrolysis", 10); // cold water: barely
react(E.MAGNESIUM, E.ACID, E.SALT, E.HYDROGEN, 120, "Acid on magnesium", 40); // Mg + 2HCl -> MgCl2 + H2
react(E.MAGNESIA, E.ACID, E.SALT, E.WATER, 220, "Antacid", 20); // MgO neutralizes — fast, so
// the salt+water row beats doCorrode (else the acid "eats" the antacid for free)
// H2O2 disproportionates on catalytic surfaces (Fe2O3, metal) — catalyst survives
react(E.PEROXIDE, E.RUST, E.OXYGEN, E.RUST, 220, "Catalytic decomposition", 30);
react(E.PEROXIDE, E.METAL, E.OXYGEN, E.METAL, 15, "Catalytic decomposition", 30);
react(E.PEROXIDE, E.SOAPY, E.OXYGEN, E.SOAPY, 120, "Elephant toothpaste", 15); // O2 through soap = foam
react(E.PEROXIDE, E.VIRUS, E.WATER, E.EMPTY, 200, "Disinfection");
react(E.SUGAR, E.WATER, E.EMPTY, E.WATER, 30, "Dissolution", -1);
react(E.SUGAR, E.SALTPETER, E.GUNPOWDER, E.GUNPOWDER, 40, "Rocket candy"); // KNO3 + sucrose propellant
react(E.SUGAR, E.YEAST, E.ALCOHOL, E.CO2, 8, "Fermentation", 2); // slow; feeds the carbon cycle
react(E.CARBIDE, E.WATER, E.ACETYLENE, E.LIME, 200, "Carbide lamp", 15); // CaC2 + 2H2O -> C2H2 + Ca(OH)2
react(E.FIRE, E.ACETYLENE, E.FIRE, E.FIRE, 220, "Welding flame", 120); // hottest common fuel gas
react(E.SULFUR, E.FIRE, E.SO2, E.FIRE, 80, "Sulfur burn", 30); // burning sulfur chokes the room
react(E.SO2, E.WATER, E.ACID, E.WATER, 4, "Acid rain"); // slow sulfurous acid
react(E.SO2, E.CLOUD, E.EMPTY, E.ACID, 40, "Acid rain"); // scrubbed cloud rains acid
react(E.SO2, E.ANT, E.SO2, E.EMPTY, 120, "Fumigation");
react(E.SO2, E.BIRD, E.SO2, E.EMPTY, 120, "Fumigation");
react(E.SO2, E.VINE, E.SO2, E.EMPTY, 60, "Acid smog"); // forest death
react(E.LYE, E.CHLORINE, E.BLEACH, E.EMPTY, 60, "Hypochlorite synthesis", 15); // Cl2 + 2NaOH -> NaOCl
react(E.BLEACH, E.ACID, E.CHLORINE, E.WATER, 180, "Never mix: Cl2 release", 10); // the household hazard
react(E.BLEACH, E.VIRUS, E.WATER, E.EMPTY, 220, "Disinfection");
react(E.BLEACH, E.VINE, E.BLEACH, E.EMPTY, 40, "Defoliation");

// ---- M5h reactive shelf IV --------------------------------------------------
react(E.AMMONIA, E.ACID, E.SALTPETER, E.WATER, 120, "Nitric synthesis", 30); // renewable gunpowder loop
react(E.AMMONIA, E.VINE, E.VINE, E.VINE, 10, "Fertilizer"); // nitrogen feeds the canopy
react(E.IODINE, E.VIRUS, E.IODINE, E.EMPTY, 200, "Antiseptic");
react(E.CINNABAR, E.FIRE, E.MERCURY, E.SO2, 60, "Ore roasting"); // HgS + O2 -> Hg + SO2
react(E.CINNABAR, E.TORCH, E.MERCURY, E.TORCH, 20, "Ore roasting"); // roast over a burner
react(E.LGALLIUM, E.ALUMINUM, E.LGALLIUM, E.POWDER, 80, "Embrittlement"); // Ga wicks into Al grain boundaries
react(E.LIME, E.ACID, E.SALT, E.WATER, 200, "Neutralization", 25); // CaO + 2HCl -> CaCl2 + H2O
react(E.LIMESTONE, E.ACID, E.SALT, E.CO2, 160, "Marble fizz", 5); // the geologist's acid test

