# Granulab — Design & Tech Plan

> STATUS 2026-08-04 (2): M1 + M2a SHIPPED & VERIFIED. Owner decisions locked:
> name=Granulab, M3 order = temperature first, grid = 1280×720, dark instrument UI.
>
> M2a delivered: 29 elements (adds stone, salt, seawater, magma, ice, snow, nitro,
> bomb, metal, torch, fuse, virus, ant, mercury, spark, clone, fan), data-driven
> contact REACTION TABLE, quarter-res WIND FIELD with free-angle fan beams +
> saltation + explosion impulses, spark/metal conduction, 5 BG shader modes
> (none/air/gray/dark/silhouette), fire-paint ignites flammables, QA shot harness
> (`#demo&shot=NAME` → POST /__shot → tools/shots/, because headless --screenshot
> composites WebGL black — use the harness, never trust a black canvas).
> All 9 M2 fixtures pass (salt→seawater, magma quench, ice melt, fan transport,
> spark travel, clone, virus, ant, nitro). Perf: idle 0.09ms, realistic scenes
> ~1ms, pathological 211k liquid bench ~18ms settled (reaction roll on water ~5ms,
> liquid churn rest) — 50+ FPS worst case, 60 in real scenes.
>
> M2b SHIPPED (same day): 40 element ids — adds sand, mud, glass, superball, bird,
> cloud (grows from steam, rains), laser (infinite ray, glass-transparent, 8-dir
> from pen stroke), thunder, fireworks→rocket chain, STICK. STICKMAN PLAYER done:
> arrow keys, walks/jumps/swims, 1-cell step-up, head absorbs touched element
> (fire/water/gas/acid/laser heads emit; superball head jumps higher; bird head
> floats), rendered as a texture patch, placed via Player tool. Liquid-settle
> hysteresis landed (settled bench 18.7→12.1ms; liquids sleep after 6 calm ticks,
> paint unsettles neighbors). Spark refractory landed (thin traveling pulse, metal
> cools 12 ticks). Save/load landed: RLE serialize (species+life), quicksave to
> localStorage + .grn export/import (~10KB typical). QA `tick()` routes through
> player.update — REMEMBER: raw world.step skips the player.
> Shot harness caveat: virtual-time-budget kills the page before the POST flushes —
> run headless WITHOUT budget, real-time, kill by PID after ~18s (see git history).
>
> M2c SHIPPED (same day): RIGID OBJECTS ball/box/wheel — entities that stamp their
> footprint into the grid each tick (powders pile on them; ball bounces 0.72 rest,
> boxes stack, wheel senses slope via ground-height raycast under each rim and
> rolls downhill; buoyancy in liquids; eraser removes them). FIGHTER AI stickman
> (chases player, jumps obstacles, purple plain head, same element-head powers).
> PEN MODES free/line/rect (stamp on release; stroke sets fan/laser direction).
> SHARE CODES: deflate(saveAll) → base64 clipboard string, ~282 chars for a scene
> — code/paste buttons, no backend. Combined save format [u32 len][GRN1][OB block]
> (legacy GRN1 loads). QA gotchas: probing ObjectSystem.collides while the object
> is STAMPED self-collides — unstamp first; diagonal circle-probes can't sense
> slope (both sides touch) — that's why groundY raycast exists.
>
> M3 SHIPPED: TEMPERATURE FIELD — half-res (640×360) heat grid, chunk-gated
> diffusion (idle 0.097ms, thermal chunks decay to 0 after sources die), hot/cold
> elements PUMP the field (fire 600°, magma 1000°, torch, spark, steam / ice -25°,
> snow), ALL phase transitions are registry data (hotAt/hotTo, coldAt/coldTo,
> ignitesAt): ice⇄water⇄steam, magma→stone, sand→glass at magma contact, radiant
> auto-ignition (nitro detonates through a wall). Contact-melt (MELTS) deleted —
> lasers now heat the field. TG thermography BG mode live (mode 5; `#demo&bg=5`).
> Balance lesson: dense cold blocks pump once per COARSE cell, not per sim cell,
> or ice overpowers torches; ice melts at 2° and survives ambient by self-pinning.
>
> M4 STARTED — CUSTOM ELEMENT MAKER SHIPPED: "+ New…" dialog in the CUSTOM rail →
> registerElement() fills the same flat arrays as built-ins (ids 43-63, 21 slots),
> persists to localStorage `granulab-custom`, palette re-uploads live. Verified:
> user-authored cryogenic powder froze 4,360 water cells via the temp field.
> PERF TRUTH (fresh page, no JIT poisoning): pathological 211k double-pool bench
> ~25ms settled — the earlier 12.1 reading was a lucky JIT state; typical scenes
> 0.7-1.5ms. Ceiling fix remains the WASM/worker port.
>
> M4.2 SHIPPED: CUSTOM REACTIONS in the Maker — the dialog's "reacts with /
> self becomes / partner becomes / chance" row writes real REACT table entries
> (becomeSelf/becomeOther -1 = unchanged, 0 = vanish). Verified: user-authored
> "Alchemite" transmuted water→metal 1:1 while consuming itself, exactly per its
> reaction row. Custom elements are now full citizens: state, density, fire,
> explosions, thermal profile, AND chemistry.
>
> M4.3 SHIPPED: toon BG mode (7th), corner minimap (1/8-scale, 200ms), MULTIPLE
> REACTION ROWS in the Maker (+ row / × delete, up to 6; rows reset per open).
> Verified: 2-row element transmuted water→metal AND oil→stone in one sim.
> GOTCHA: the embedded Claude browser NEVER fires dialog "close" events (dropped
> task — even on a fresh dialog) — the Maker now creates on form "submit" +
> e.submitter instead; never hang app logic off dialog close.
>
> M4.4 SHIPPED: PUMP + BUBBLE (last two classic tools). Pump = fluid conductor
> per Dan-Ball semantics: absorbs adjacent liquids/gas, token walks the pump
> line with momentum (life = species | dir<<6, one hop/tick), ejects at line
> ends one clear dot out; mass-conservation verified (water+tokens == painted).
> Bubble = 4th rigid object: hollow ring r4, buoyant, wind-shoved to ±2.5 c/t,
> pops on walls/objects/border, ring BECOMES any element dot it touches.
> Heat-pump array renamed HEAT_PUMP (E.PUMP took the name). Custom element ids
> now start at 45 (19 slots) — pre-M4.4 saves with customs at 43/44 will load
> those cells as pump/bubble.
>
> M4.5 SHIPPED — CHEMISTRY SET: 9 reagents (ids 45-53: Soapy, Lye, Hydrogen,
> Chlorine, Soda, CO2, Oxygen, Rust, Cement; customs now start at 54, 10 slots)
> + 26 new REACT rows forming closed loops: saponification (lye+oil), acid+lye
> neutralization→salt+water→brine, electrolysis (spark+water→H2, +seawater→Cl2),
> acid factory (H2+Cl2→2 acid), soda fizz + lye CO2-scrubber (a full CO2 cycle),
> H2 smelts rust→metal+steam (self-passivating metal crust!), photosynthesis
> (vine+CO2→O2), CO2 fire blanket, O2 flash-burn, road salt melts snow/ice,
> chlorine defoliant/insecticide/disinfectant, mercury amalgam, cement→stone.
> Soapy + strong wind → real bubble objects (world.bubbleQueue → ObjectSystem).
> ENGINE FIXES: (1) react roll now scans the 4-neighborhood for the first
> reactive partner (rotating start) — the old blind single-pick let static
> interfaces fall asleep mid-reaction and stall forever; slow rows halved to
> compensate the ~4x rate gain. (2) doCorrode exempts the water family AND all
> gases — acid was eating its own reaction products (CO2 fizz, H2 evolution).
> Verified stoichiometry: soda fizz exactly 1:1:1; pump conserves mass.
> PHYSICS NOTES: gases never descend, so stacked gas fixtures need contact or
> stirring (that's real buoyancy — a 1-cell gap = permanent separation); acid
> fully consumes itself into H2 over bare metal (use glass/wall containers).
>
> M5a SHIPPED — REAGENT SHELF II + CHEM DEMO + RECIPE HUD:
> N_IDS 64→128 (pump cargo = full life byte, direction moved to shade bits 0-1;
> customs now start at 63, 65 slots). 9 recipe reagents (ids 54-62): Charcoal,
> Saltpeter, Sulfur, Limestone, Lime, Aluminum, Thermite, Glycerin, Alcohol.
> Recipes: saltpeter+charcoal→gunpowder (+sulfur enriches), aluminum+rust→
> thermite (hotAt 550 → IS magma; charcoal ember bed = the reliable igniter,
> torch alone won't — a magma droplet quenches first), limestone kilns at 460
> (sinks into the melt, lime density 36 floats back out as crust), lime+water→
> cement / lime+CO2→limestone (closed lime cycle), glycerin+acid→nitro.
> REAGENT DATASHEET HUD: bottom-left card auto-generated from REACT + thermal
> registry for the held element (customs self-document); demo picker in the
> transport (sandbox / chem lab). #chem scene: 7 self-running stations —
> electrolysis + chlor-alkali cells (clone-spark pulser on a wire), gunpowder
> mill, thermite forge over a quench pool, lime kiln, soda-acid fizz whose CO2
> overflow smothers torches, greenhouse (vine CO2→O2 under glass), soap geyser.
> ENGINE FIXES earned by the demo: (1) sparks no longer drive the react roll
> (a reacting spark returned before doSpark and pinned at liquid surfaces);
> (2) spark cooled to 180°/0.04 pump — 400° sparks DISTILLED brine and the
> chlor-alkali cell electrolyzed the fresh condensate (real desalination,
> wrong product); ignition unaffected (hotContact4 is contact, not field);
> (3) only WIRE-BORN sparks (shade bit 0) restore to metal on death — free
> sparks welded stubs onto wires and entombed clone pulsers after one shot;
> (4) metal rusting moved from the REACT table into doMetalCool as a waterline
> rule (needs seawater AND air) — a table row ate submerged electrodes in
> seconds; tanks and deep wiring are now safe, splash zones crumble.
> M5b SHIPPED — BALLISTICS + DEVICES: per-grain velocity layer (vx8/vy8
> Int8 x16 fixed-point — the DESIGN's original `vel` arrays, finally built):
> flying grains integrate gravity + 3% drag, Bresenham-walk their vector,
> punch through fluids at half speed, and hand 7/8 momentum into packed
> powder on impact (shockwaves travel through piles). Explosions now THROW:
> the fire core spares dense rubble (density≥70 mostly survives) and a
> radial shockwave (R = 2r+4, up to ~7.9 c/t + loft) launches everything
> movable — bomb under a stone cap = 111-cell mortar plume. Velocity is
> transient (not serialized). CANNON (aim = pen stroke, like fan): sparked,
> it consumes one movable cell at the breech (suction reaches 4 cells for
> hoppers) and launches it at 5.6 c/t; verified contraption: walled hopper +
> clone trigger = 89 shots/600 ticks at 92-cell range. DEVICES all verified:
> DETECTOR (clone-style memory, emits free sparks while its species touches
> — 0 false positives), VALVE (spark opens a drop-gate 24 ticks), HEATER/
> COOLER (registry-only heat plates; cooler froze a full pool), FILTER
> (gases pass — light up, CO2/chlorine down; zero powder leakage).
> FIXTURE LESSON (cost 3 debug rounds): paint() fills EMPTY only — charge
> before cap, wire before liquid, and NOTHING falls unless something holds
> it; a "dead device" is usually a buried trigger or a collapsed feed.
>
> WEAPONS RANGE DEMO shipped (#range / demo picker): five live exhibits —
> elevated sentry gun shelling a castle (hopper+cannon+clone trigger), fuse-
> timed mortar (fuse in a ROOFED floor tunnel — cap spill severed an open
> run), nitro thunder pit (clones drip nitro onto a grate over magma; sealed
> wall pocket holds the priming nitro or it disperses away), thermite vault
> breach (torch EMBEDDED at bed level — flames rise, contact ignites), and a
> fireworks battery as a 1-wide TOP-LIT column (any nose-blocked rocket
> detonates: blocks and tubes both self-destruct; light from above, feed
> from below). All five verified live at 60fps.
> M5c SHIPPED — WATCH THE REACTIONS: REACT_COUNT per-pair counters + 39 rows
> now carry proper names (Saponification, Chlor-alkali process, Nitration…).
> LAB NOTEBOOK ("log" button): live discovery feed — first fire of a pair
> prepends an entry (name, swatch formula, running count, rate/s); pairs
> never seen in this browser flash NEW (persisted granulab-seen-rx); closed
> panel badges "log N". BG mode 7 "rx glow": quarter-res reaction field
> (reactions pump it, 0.94 decay, gated like wind) rendered as green-white
> glow over the dimmed world. QA NOTE: bare import("/src/engine/elements.ts")
> probes in the page get a DUPLICATE module instance under Vite dev (static
> tables match, runtime counters read zero) — verify counters through the
> app's own UI, not import probes.
> M5d (ΔT half) SHIPPED — THERMOCHEMISTRY: REACT_DT per-row heat, pumped into
> the temp field at the reaction site; datasheet card shows +N°/−N° tags.
> 17 rows tuned: slaking +120 (the pit BOILS — peak 257° with steam),
> neutralization +90, hydrogen burn +100, acid synthesis +80, nitration +45
> — which makes big nitration batches THERMALLY RUN AWAY past nitro's 240°
> ignition and self-detonate (verified: 2,673-cell batch blew at t45), the
> real nitroglycerin-plant hazard, fully emergent. Endotherms: dissolution
> −2 (−8 froze the pool solid — self-pinning ice feedback), de-icing −6,
> fizz −15, fire suppression −20.
>
> M5d pH SHIPPED: per-element pH in the registry (acid 1, nitro 2, chlorine
> water 3, mud/glycerin 6, water 7, seawater 8, soda 9, soapy 10, lime 12,
> lye 13; 255 = n/a), shown as a "pH N" flag on the datasheet card. BG mode
> 8 "pH" renders aqueous chemistry on the universal-indicator ramp (red→
> green→violet; non-aqueous matter as dim gray). LITMUS element (id 69):
> indicator powder that samples the first pH-bearing neighbor into its
> SHADE byte and wears that indicator color in EVERY view mode — sprinkle
> it into a beaker and read the pH. Corrosion-exempt (acid dissolved the
> instrument before it could show red). Verified: acid 1 / water 7 /
> seawater 8 / lye-contact 13, all 231 grains surviving the acid bath.
> Still open from M5d: dissolved-state concentration channel.
>
> M5f SHIPPED — METALS FAMILY, NEW MEDIUMS, GROUPED PALETTE (78 ids, customs
> from 78): CONDUCTOR FAMILY — CONDUCTS[] = per-metal refractory (iron 12,
> copper 8 = fast clock lines, gold 10, tungsten 16); sparks remember their
> conductor in shade bits 1-2 and restore it (a pulsed copper wire stays
> copper). Distinct chemistry: iron rusts at the seawater waterline, COPPER
> patinas to VERDIGRIS (roasts back in fire), GOLD is untouchable except by
> mercury (amalgam), TUNGSTEN conducts THROUGH magma baths (verified pulse
> crossing a lava pool — lava-proof wiring). Acid can't eat Cu/Au/W.
> MEDIUMS: WOOD chars to charcoal (char quenches its own flame; charcoal
> flammable 40 — harvest by QUENCHING the burn like a real kiln: burn 350
> ticks + flood = same char, 82% wood saved; wood→char→+saltpeter→gunpowder
> chain verified), WAX⇄TALLOW reversible melt at 62°/45° (thermal storage,
> candle fuel), TAR (viscous, long burn, traps ants/birds — took 246/246).
> PALETTE: registry `group` field → rails SOLIDS/LIQUIDS/GASES/METALS/
> REAGENTS/LIFE & ENERGY/DEVICES/CUSTOM/TOOLS (derived from behavior when
> unset; STICK hidden — it had been a paintable ghost since M2b).
> - M5e BALANCE & SCALE: mass-conservation audit per row, rate tuning pass,
>   WASM hot loop when reaction load meets the 211k-cell ceiling.
>
> AMBIENT FIELD VISUALS shipped (owner ask 8/05): the invisible physics now
> shows in the NORMAL view (modes 0-1) — wind renders as motes drifting with
> the flow (blast shockwaves visible), hot air shimmers orange, matter above
> ~250° glows red-hot (heated tungsten bars!), sub-zero zones frost blue and
> rime the matter. Wind+temp textures now upload every frame in modes ≤1.
> WHEEL SPIN visual done: rolling spokes + bright rim (angle += vx/r on
> ground contact). QA TRAP (new): the pane throttles rAF when not displayed —
> wall-clock waits tick NOTHING; always verify with synchronous g.tick(n).
>
> BUILDABLE CANNONS shipped (owner ask 8/05: "explosion inside a cannon
> shoots something out"): (1) explosions now respect WALLS via losClear —
> Bresenham line-of-sight from the blast center gates the fire core, the
> debris shockwave, AND object impulses, so a wall barrel channels ALL the
> energy up the open bore (bystander ball outside the barrel: zero impulse);
> (2) explosions finally push RIGID OBJECTS (world.blastQueue → ObjectSystem
> impulse, R = 2r+4, LOS-gated; object speed cap raised 4→9). VERIFIED: a
> hand-built wall barrel + gunpowder charge + Ball = 7.8 c/t muzzle velocity,
> 157 cells straight up, or 380-cell horizontal range off a rampart.
> KNOWN PHYSICS: packed CELL slugs jam (impulse dissipates through lossy
> cell-to-cell transfer — no sustained gas pressure); use a Ball as the shot
> or loose gravel as a blunderbuss spray. Impact transfer now keeps half the
> flyer's speed (spring-chain), which livens piles but can't fix slugs.
>
> PHYSICS TUNE (owner ask 8/05): explosions hit harder — debris mag 110→150
> (+20 base), object impulse 9→16, wind burst 6→9; hand-built cannon now
> launches 197 cells vertical (was 157). BALLS ROLL: same groundY slope
> sensing as wheels (0.12 accel) + rotation with a marker-dot visual —
> verified 327 cells down a 26° incline. NOTE: slope sensing spans ±4 cells,
> so terrain flatter than that per-step reads as flat (a ball mid-step on a
> wide staircase correctly sits still).
>
> CHARGE COALESCING + BLAST FIXES (owner ask 8/05 "the more explosive the
> bigger the boom"): detonation flood-consumes the whole CONNECTED charge
> (cap 4000 cells) and scales ONE unified blast radius by sqrt(yield), cap
> R=46 — a magazine goes up as a screen-shaker, not a crackling chain.
> Ladder verified: 1 cell=508 grains launched, keg=3k, barrel=5k (cap).
> Cannon: 11.8 c/t muzzle, 333-cell launch. TWO layered bugs found under
> "weak explosions": (1) upward columns self-jammed against the bottom-up
> scan — flyers now HOLD FORMATION when their target is also flying (columns
> unzip from the top; grapeshot 6→87 escaping the bore); (2) THE BIG ONE:
> the fire core blankets the blast radius and ballistic grains treated FIRE
> AS A WALL — every launched grain froze ~8 cells into its own fireball.
> Fire is hot air now (debris flies through). Mortar plume 7→132 cells,
> scatter 236. Object impulse 20, obj cap 12 c/t, debris to ±126 (7.9 c/t).
>
> DOOMSDAY DEMO shipped (#doom / demo picker): erupting volcano (1-wide clone
> pillar vent: primer pool on one face, open air on the other — 2-wide
> pillars split into primed-but-blocked + open-but-unprimed; pool-buried
> clones are smothered), heated lava channel in the mountain (thin flows
> freeze on cold slopes), wooden town w/ oil house + wax house + tar lanes,
> gold monument (survives 100%), buried 1,300-cell magazine on a slab-carved
> fuse (magazine boom ~t475), det-line #2 from the pit to a nitro vat via a
> tub-floor wick (chain boom ~t675), lake, fortress cannon shelling left.
> HARD-WON FUSE RULES: (1) wall paint OVERWRITES fuse — slab first, carve,
> then fuse; (2) an open-air fire RISES away before lighting a downward
> fuse — box the igniter in wall; (3) fire painted onto a fuse ignites in
> place = the only deterministic ignition. Metals now ~82% survive blast
> fire cores (mangled, not vaporized). QA: verify against a stale-guard
> fetch — three phantom failures this session were stale Vite pages.
>
> DRAMA PASS shipped (owner ask 8/06): SMOKE element (id 78) — every fire
> billows drifting, wind-blown smoke (7/256 per fire cell per tick, life
> 140); big blasts now FLASH the screen white-hot and SHAKE the view
> (world.fxPower = blast R, 0.88 decay -> uFlash uniform + render-side pan
> jitter, never sim-side); ambient heat glow doubled. Burning towns smudge
> the sky, magazines feel like magazines.
>
> UPLOAD GALLERY shipped 8/07 (the community loop): "gallery" transport
> button → dialog (upload the current scene with name/author, browse, one-
> click load; author persists to granulab-author). Backend: /api/gallery
> Vercel serverless fn over VERCEL BLOB (store granulab-gallery /
> store_S4DknqyzyERwtANx, connected to the project — BLOB_READ_WRITE_TOKEN
> in all envs, provisioned via the REST API with the CLI token). Design:
> name/author are base64url-encoded INTO THE BLOB PATHNAME
> (scenes/<ts36>.<b64u name>.<b64u author>.json) so GET is one list() call
> with zero per-blob fetches; clients fetch the public blob URL directly on
> load. Vite dev twin (galleryDev plugin) mirrors the exact routes/shapes
> over tools/gallery-store/ — the gallery QAs fully on the dev server.
> Community strings render via textContent only (never innerHTML — XSS);
> upload acts on submit + e.submitter and keeps the dialog open (M4.3
> close-event rule). QA: exact 36,772-dot upload→clear→load round-trip,
> both programmatic and through real button clicks; traversal/method/
> validation probes 404/405/400. ALSO: dev server honors PORT env now
> (launch.json autoPort — worktree sessions get a free port; bare
> `npm run dev` still 4870), TS 5.9 generic-Uint8Array Blob casts fixed.
>
> WASM GROUNDWORK 8/07: tools/bench.ts is the headless ORACLE any engine
> port must match — rebuilds the 211k double-pool churn (banded seawater/
> oil, peak load for ~100 ticks) plus a behavior ZOO (fire/wood, salt
> dissolution, ice vs magma, spark conduction, fan wind, nitro detonation),
> times each phase and FNV-1a-hashes species+life; two runs = identical
> hashes. PERF TRUTH v3 (node, fresh V8): peak churn ~13ms/tick, NOT 25 —
> the 25ms reading was JIT-poisoned browser state; settled pools sleep to
> 0.03ms. FRAME LOOP now sheds SIM STEPS, not frames: 14ms wall-clock
> budget in the catch-up loop (first step always runs) — pathological
> scene went 6 steps/286ms per frame → 1 step (verified synchronously;
> a hidden pane fires zero rAF, the known trap). PORT PLAN (no cargo on
> this box → AssemblyScript): port by RNG-REACHABILITY, not by feature —
> every stage must consume the identical rng stream, so stage 1 = the
> scan + movement + every always-on roll the oracle scene reaches, with
> loud traps on unreached branches; stages widen the oracle scene set.
>
> M4 QUEUE (still open): remaining BG modes (blur/shade/aura/light/mesh/
> track — partly obsoleted by the ambient overlays), WASM port itself.
> Run: `npm run dev` → :4870. QA API on `window.granulab`.

Next-generation Powder Game: keep every recognisable Dan-Ball feature, add the depth
and options the 2026 state of the art proved out. Research basis: [RESEARCH.md](RESEARCH.md).

## Product pillars

1. **It IS Powder Game** — wind/fan, the classic ~40 elements and their reactions,
   stickman Player/Fighter, wheel/box/ball objects, BG render modes, two-button pen,
   frame-step. Feature parity before novelty (a named product = its features).
2. **More options** — the ask. Delivered three ways:
   - **Per-cell fields** the original never had: temperature + conductivity everywhere.
   - **Per-element option sliders**: gravity, flammability, viscosity, lifespan tweakable live.
   - **Custom Element Maker**: users compose new elements from properties + reaction
     rules in-UI, save and share them (nobody in the genre has this without code mods).
3. **Modern feel** — 60 FPS at 4–8× the original resolution, GPU wind, zoom/pan,
   touch support, undo, gif/replay export, local saves + share codes.

## Platform decision

**Web-first, TypeScript now, WASM-ready.** Rationale: instant shareability (the
community loop is core DNA), your existing deploy stack, and the proven ceiling —
sandspiel/Sandboxels show browser is enough. Not Unity/Unreal: cell simulation is a
typed-array problem, not an engine problem; a game object per grain would collapse.

- Sim core in TS against flat typed arrays, written so the hot loop can port to
  Rust/WASM if profiling demands it (sandspiel's path).
- Render: WebGL2 — sim state uploaded as a texture each frame, palette/effects in a
  fragment shader (this makes the 14 BG modes nearly free — they're just shaders).
- Wind/air: GPU fluid solver (PavelDoGreat-style) sampled by the CPU CA, sandspiel-style.

## Architecture (game-developer skill applied)

### Cell state — Structure-of-Arrays, no objects, no per-frame allocation
```
species:  Uint8Array   // element id, 0 = empty
temp:     Float32Array // °C-ish scalar, diffused each tick
life:     Uint8Array   // fuse timers, virus decay, vine growth stage
vel:      Int8Array ×2 // grain velocity for arcs/tosses (Noita-style)
clock:    Uint8Array   // updated-this-frame counter (prevents double-moves)
```

### Update loop
- Fixed timestep (accumulator), rendering interpolated — frame-rate independent.
- Bottom-up scan, **alternating left/right per row per frame** (kills directional bias).
- **32×32 chunks with dirty rects** (Noita): settled sand costs zero. This is the
  single biggest perf lever — most of a mature scene is asleep.
- Deterministic seeded RNG (mulberry32). Same seed + same inputs = same run —
  enables replays, share-code verification, and headless regression tests
  (same discipline as vivarium's determinism-verify).

### Data-driven elements (the "more options" engine)
Elements are **data, not code** — one registry file, hot-reloadable:
```ts
{
  id: "GUNPOWDER", state: "powder", density: 3, color: [...],
  flammable: 0.9, conducts: 0, meltAt: null, boilAt: null,
  reactions: [{ with: "FIRE", becomes: "EXPLOSION", p: 1.0 }],
}
```
Behaviors (fall, flow, rise, burn, conduct, grow, tunnel) are a fixed set of composable
primitives; an element is a bundle of parameters. Consequences:
- adding element #41–#200 is a data entry, not an engine change;
- the Custom Element Maker is just a form that writes a registry entry;
- mods = JSON/JS files that append to the registry (Sandboxels' proven model);
- balance lives in data files, never hardcoded (skill constraint).

### Objects & players
- Wheel/Box/Ball/Player as entities above the grid, colliding against cells.
  v1: circle/AABB vs. cell collision (Powder Game fidelity doesn't need Box2D).
  v2 option: marching-squares → rigid bodies for arbitrary pixel-built objects (Noita).
- Player keeps the signature rule: head absorbs the attribute of touched elements.
- Object pooling for particles/entities from day one; zero allocation in the tick loop.

### Performance budget (MUST hit)
| Grid | Cells | Target |
|---|---|---|
| 400×300 (parity) | 120k | 60 FPS with full fields, easy in TS |
| 800×450 (default) | 360k | 60 FPS via dirty-rect chunks |
| 1280×720 (max) | 921k | 60 FPS = WASM port of hot loop and/or worker checkerboarding |

Profile every milestone (performance.now() per system + Chrome tracing); if tick
> 8ms at default grid, port the scan loop to WASM before adding features.

## Feature parity checklist (must-ship, from RESEARCH.md)
- [ ] All ~40 classic elements + the wiki reaction table as regression fixtures
- [ ] Fan/wind (free-angle, not PG2's 45° regression), drag, bubble, pump, clone, text
- [ ] Two-button tool binding, pen sizes, line/lock/paint modes
- [ ] Start/stop, frame-step, speed, scale, grid, minimap
- [ ] 14 BG modes as shaders (air pressure view, thermography, silhouette, ...)
- [ ] Player + Fighter stickmen with element-head behavior
- [ ] Wheel, box, ball, block objects
- [ ] Save/load codes + upload/vote loop (start: localStorage + shareable URL codes)

## Next-gen additions (the "more options")
1. Temperature field + phase transitions (ice⇄water⇄steam from one melt/boil datum)
2. Electricity: conductors, insulators, switches, sources (Powder Toy's killer depth)
3. Custom Element Maker + mod loader (registry entries, shareable)
4. Per-element live sliders (gravity, wind response, flammability, viscosity)
5. Bigger canvas + zoom/pan + touch; undo/redo (chunk snapshots make this cheap)
6. Replay export (deterministic input log → gif/webm)
7. Community v2: gallery with thumbnails, remixing (load someone's save, edit, re-share)

## Milestones
- **M1 — Engine proof (weekend)**: grid + chunks + 10 elements (powder, water, wall,
  fire, oil, gas, steam, seed, gunpowder, acid), WebGL renderer, pen, space/enter,
  60 FPS at 800×450. Exit test: sand piles, water pools, oil floats and burns.
- **M2 — Parity**: all 40 elements passing reaction-table fixtures, wind/fan + GPU air
  view, objects, stickman, BG modes, save codes.
- **M3 — Next-gen**: temperature, electricity, Custom Element Maker, mod loader, sharing.
- **M4 — Polish**: touch/mobile, undo, replays, gallery, perf pass (WASM if needed).

## Open questions for the owner
- Name? ("Powder Next" is a working title.)
- M3 priority order: temperature first (my recommendation — it multiplies existing
  elements) vs. electricity first vs. Element Maker first?
- Community backend (uploads/votes) needs hosting eventually — Vercel + KV is enough
  to start; defer until M3.
