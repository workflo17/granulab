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
> M5g SHIPPED 8/07 — REACTIVE SHELF III (owner ask "more elements, accurate
> chemistry"; 11 elements, ids 79-89, customs from 90; 27 REACT rows, ALL
> registry data — bench oracle hashes unchanged, proof it's additive):
> SODIUM (density 28: FLOATS on water 30, sinks under oil 20 = real alkali
> storage; +water→lye+H2 ΔT+70 routinely crosses H2's 480° autoignition —
> the pool detonates its own gas, verified 451 Na → 451 lye exact);
> MAGNESIUM (ignites 470°, 200-tick white ember = the thermite match;
> +steam→magnesia+H2 verified 65:65 — never hose a Mg fire); MAGNESIA
> (antacid: +acid→salt+water; needed a doCorrode exemption — the REACT row
> must do the dissolving so acid is CONSUMED, else corrosion deletes the
> antacid for free); PHOSPHORUS (ignitesAt 34° pyrophoric — safe under
> water, 369/369 survive; flashes near any heat); PEROXIDE (rust/metal
> catalyze O2 evolution, catalyst survives; +soapy = elephant toothpaste);
> SUGAR (dissolves, chars at 190° through a real thermal gradient,
> +saltpeter = rocket candy, +YEAST → alcohol+CO2 fermentation closing the
> carbon cycle with photosynthesis); CARBIDE (+water→acetylene+lime, the
> miner's lamp, feeds the lime cycle); ACETYLENE (welding flame ΔT+120,
> 11,372-cell pocket verified); SO2 (off burning sulfur; +cloud→acid rain
> — cloud cells become falling acid, 1,515 SO2 fully absorbed; fumigates
> ants/birds, smogs vines); BLEACH (lye+chlorine→hypochlorite; +acid =
> "Never mix: Cl2 release", 1,281 bleach → 1,200 chlorine, the household
> hazard). QA lesson re-learned: paint() fills EMPTY only — pour the pool
> AROUND the stored reagent, not after it.
>
> WASM STAGE 1 LANDED 8/07: asm/engine.ts (AssemblyScript) ports the scan +
> powder/liquid movement + always-on subsystems; tools/parity.ts gate =
> 10/10 checkpoints BIT-EXACT over 500 ticks (grid hashes AND 52.4M rng
> draw counts), churn bench 7.6ms vs 13ms TS (1.7x). Unreached branches
> are named traps — any scene touching fire/gas/devices aborts loudly by
> design. NOT wired into the app yet (harness-only; game still runs TS).
> PARITY SUBTLETY that cost a day: TS Rng.s is an UNBOUNDED f64 (`s +=`
> never masked) — past 2^53 (draw ~4.9M) the add rounds and TS stops being
> textbook mulberry32; the port must emulate ToUint32-on-f64, not pure u32.
> Run: `npm run parity` (or `node tools/parity.mjs --bench-only` for
> honest timings — in-process instrumentation inflates TS ~2x otherwise).
> NEXT STAGES: (2) thermal transitions, (3) full react roll, (4) fire/
> devices/blasts/ballistics — each widens the oracle scene set; then wire
> world-wasm.ts behind a feature flag in main.ts.
>
> #ALCHEMY DEMO shipped 8/07 (demo picker "alchemy"): nine self-running M5g
> stations — sodium dripper popping its own H2 over the pool, elephant-
> toothpaste cylinder (4,250 O2), carbide lamp with a permanent acetylene
> flame, rocket-candy mill (938 grains — NO stove near the mill, a heat
> plate ignites the product as it forms), brewery+greenhouse carbon loop
> (2,047 alcohol 1:1 CO2), never-mix cabinet with a chlorine→lye→bleach
> recovery chute, magnesium pyre whose skirt reaches the splash zone
> (steam strips it to magnesia+H2 while it burns), phosphorus vault (dry
> shelf flashes off a warm pipe, the 585-cell underwater sample sleeps),
> SO2 fan-lofted into a cloud raining acid on vines. QA LESSON (cost a
> server restart): Vite's dev transform STRIPS COMMENTS — stale-guard
> fetches must grep for CODE literals, never comment text.
>
> RNG U32 FIX 8/07: Rng.s now masks every draw (`(s + 0x6d2b79f5) >>> 0`)
> — the unbounded-f64 state above (PARITY SUBTLETY) rounded past 2^53
> (~4.9M draws) and silently left textbook mulberry32. asm/engine.ts
> dropped its ToUint32-on-f64 emulation for pure u32 in the SAME change;
> parity re-ran 10/10 BIT-EXACT on BOTH oracle scenes after rebasing onto
> stage 2 (movement 51.8M draws, thermal 13.8M — each crosses the 2^53
> boundary between ticks 100-150 and stays green). ORACLE IMPACT: churn
> bench hashes
> UNCHANGED (e009494c / a884374c — churn never reaches 4.9M draws); zoo
> hashes re-baselined 08d3646e→87d46d8a, 40700818→1523c51e; stage-1
> checkpoint hashes from tick 150 on are new. Share codes/saves
> unaffected (GRN1 snapshots grid bytes, no rng state) — but seed-based
> REPLAY determinism breaks for long scenes: any recording made pre-fix
> diverges from a post-fix replay once it crosses ~4.9M draws (no replay
> system ships yet, so this costs nothing today).
>
> WASM STAGES 2-4 LANDED 8/07-08: asm/engine.ts now covers ALL of
> world.step — thermal (stage 2), fire + firing reactions + corrosion
> (stage 3), explosions/ballistics/devices/conduction/critters (stage 4).
> Gate: FOUR oracle scenes, each 10/10 checkpoints bit-exact on grid
> hashes AND rng draw counts AND (stage 4) blastQueue/bubbleQueue
> contents + fxPower. Zero abort() traps remain. Perf: churn 12.5→7.0,
> thermal/fire/device zoos ~2x. Fan angles use LOADER-COMPUTED cos/sin
> tables (host Math, bit-for-bit with V8). NOT PORTED (host-side, outside
> the tick loop): rawSet/serialize/clear/fill*Tex — needed for the real
> game loop. REMAINING: wire world-wasm.ts into main.ts behind a feature
> flag (ObjectSystem stamping via rawSet, per-tick queue draining,
> QA parity toggle), then ship.
>
> WASM WIRED INTO THE GAME 8/08: WasmWorld adapter (drop-in World surface:
> rawSet/losClear/queues-as-authoritative-JS-arrays/fxPower/fill*Tex/RLE
> serialize byte-compatible with .grn + share codes/postLoad; 5th parity
> gate = TS snapshot loads into both engines, bit-exact +100 ticks).
> main.ts boots via top-level await: ?engine=wasm (or localStorage
> granulab-engine=wasm) → fetch hashed .wasm asset, fall back to TS on
> failure; granulab.engine reports which is live. Build = asm:build then
> vite build (target es2022 for TLA — app already needs CompressionStream
> so no browser-support change). IN-GAME A/B VERIFIED: same painted scene
> (fire+reactions+movement), 300 ticks → identical dots 54,788 and species
> hash c77ccdf0 on both engines; doom+alchemy run on WASM; save/load +
> share codes round-trip; BG modes clean; in-browser churn peak ~14.5ms
> WASM (cold) vs 24-84ms TS. DEFAULT stays TS until the flag has soaked —
> flip by making "wasm" the fallback default in makeWorld. NOTE: objects/
> player draw from a host-side rng stream in WASM mode (sim itself is
> bit-exact; cross-mode replays with critters differ). Dev after pulling
> engine changes: npm run asm:build once.
>
> ENGINE DEFAULT FLIPPED TO WASM 8/08 (owner "flip it"): makeWorld now
> defaults to the WASM engine; ?engine=ts (or localStorage
> granulab-engine=ts) forces the TS engine, and any WASM boot failure
> still auto-falls back to TS with a console warn.
>
> M5h SHIPPED 8/08 — REACTIVE SHELF IV (9 elements, ids 90-98, customs
> from 99; first data milestone shipped ON the WASM engine — registry
> tables flow into WASM at init, so pure-data chemistry needs no engine
> work): AMMONIA (+acid→saltpeter = RENEWABLE GUNPOWDER loop — needed
> saltpeter corrosion-exempt (nitrate resists its own acid, both engines);
> +vine fertilizer), IODINE⇄IODINE VAPOR (sublimes 184°, violet dense gas
> deposits back at 45°), CINNABAR (roasts to mercury: +fire→Hg+SO2, and a
> +torch row — torches never EMIT fire cells, contact rows must name
> TORCH as partner for burner setups), LIQ. N2 (floats at density 24,
> flash-froze a 4,598-cell pool, boils to NITROGEN gas that fades —
> life0 fade is generic for gases, only steam's water roll is special),
> GALLIUM⇄MOLTEN GA (melts at 30° hand-warmth, embrittles aluminum to
> dust), DRY ICE (-78° powder sublimating into the CO2 blanket),
> lime family acid rows (Neutralization + Marble fizz — lime/limestone
> corrosion-exempt like magnesia, exemptions mirrored in asm/engine.ts,
> all five parity gates re-run green). QA: one-row air gap = no gas
> contact ever (again); products falling into acid get corroded unless
> exempted — check every row whose product lands in the reagent pool.
>
> #CRYO DEMO + DRAMA UPGRADES shipped 8/08: seven M5h stations (ammonia
> batch reactor snowing saltpeter, gunpowder pop pit w/ clone drip,
> LN2 glacier-calving lake breathing against a heater patch, iodine lava
> lamp, gallium bridge sabotage, cinnabar smelter + roofed sulfur burner
> + fan-lofted SO2 smog/rain, dry-ice-vs-pyre battle). Doom: dry-ice
> glacier on the volcano flank → lava sublimates a CO2 flood into the
> burning town. Range: sodium depth-charge tank (recurring H2 flash-
> bangs). FIXTURE LAWS LEARNED THE HARD WAY: (1) powder/liquid clone
> primers FALL without a ledge under the primer cell; (2) a clone whose
> only open face floods with liquid is smothered — batch reactors beat
> injectors inside tanks; (3) LN2 exists only in BULK: droplets/streams
> boil the tick they meet warm air, so pour glaciers, never drips;
> (4) full-width heaters pre-warm pools absolutely — size the heater to
> the battle you want; (5) torches never EMIT fire: SO2 needs burning
> sulfur, roofed so collapsing ore can't bury it.
>
> M5i SHIPPED 8/10 — PRESSURE: quarter-res overpressure field. Trapped gas
> + heat build it (ideal-gas-ish target, FIRE counts as hot gas — enclosed
> burns blow rooms), it vents through openings as WIND (connectivity to
> the zero-pressure borders, NOT local leakage), and past the breaking
> point it SHATTERS containers: glass→thrown SHARDS, ice→snow; stone/wall
> hold (that's what makes them pressure vessels). Rupture sweeps the
> vessel SKIN (solid cells never pressurize themselves). Blast
> overpressure spikes the field. Census is INCREMENTAL at the 4 species-
> write sites (active-chunk scans miss calm pools — structurally-inactive
> chunks, not just hysteresis); heavy gases no longer settle-sleep.
> Gas-free scenes pay ZERO (churn bench byte-identical e009494c/a884374c);
> zoo re-baselined ebaf9770/3f57b1b3. New: PROPANE (pooling LPG), METHANE
> (firedamp), SHARDS + vapor-cloud/firedamp/marsh-gas/laceration rows.
> #BOILER demo: 5 stations failing by overpressure (bursting boiler
> geyser, tank-farm BLEVE chain t70, firedamp mine, carboy cellar,
> dry-ice flask bomb). WASM mirrored bit-exact: SEVEN parity gates incl.
> a pressure scene and an M5h+M5i SHELF ZOO painting every id 90-101
> (coverage lesson: "registry data flows automatically" was assumed and
> never gated — every new element now needs oracle coverage), press field
> compared as raw bytes each checkpoint, plus a LATENCY gate (1200 ticks
> w/ mid-run clear+repaint, max 5ms). QA LESSONS: in-app cross-engine
> A/B is NOT bit-comparable (separate host rng for objects/player +
> per-page probe history) — bit-compare via the harness only; multi-
> second "hangs" in hidden panes are OS tab-throttling under machine
> load (pure-JS control bursts identically) — time on a quiet machine.
>
> PRESSURE DOES WORK (owner ask 8/11 "walls should hold pressure and only
> release on openings so projectiles can be made"): (1) CONTAINMENT — flow
> is gated by the open fraction of the SHARED BOUNDARY between coarse
> cells, not block-average solidity. A 1-cell wall spanning the seam now
> seals completely; it used to leak 75% (a 4x4 block with a 1-cell wall
> reads only 25% solid), which is why nothing could hold a charge.
> Verified: sealed vessel holds 5.2 with ZERO outside. Powders still leak
> (a sand plug is not a pressure vessel). (2) FORCE — gradient->wind
> 0.15->0.5, clamp 1.5->8 (the blast wind cap); steep gradients (|rx|+|ry|
> > 3 = a vent or muzzle) LAUNCH loose matter ballistically via vx8/vy8,
> deterministically, no rng; RIGID OBJECTS sample pressAt on OPPOSITE
> FACES and ride the difference — a stamped object is a barrier to the
> field (density 255), so a ball in a bore is a real piston. Objects
> previously felt NOTHING from pressure or wind (only blast impulse) —
> that was the "little hop". Verified on WASM: powder cannon 357 cells;
> shot 110 cells up the bore (beyond blast reach) rises 112 at 9.7 c/t on
> pressure alone; PNEUMATIC steam cannon 69 cells with no explosive.
> BORE GOTCHA (cost a debug round, and is the likely cause of any
> "cannon only hops"): ball r=7, so a bore under ~16 cells WEDGES the
> shot — it oscillates ±8 vy at a fixed y and never moves.
> Zoo re-baselined 0df5e3db/2ae46e85; churn byte-identical (gas-free
> scenes still pay zero). Mirrored bit-exact; seven parity gates + the
> latency gate green, and the WASM engine replays the whole 1,500-tick
> bench sequence phase-for-phase.
>
> #CANNON DEMO shipped 8/11 (demo picker "pressure guns"): six stations, all
> driven by the pressure field — PNEUMATIC MORTAR (sealed steam chamber, no
> explosive anywhere: 82-cell lob), POWDER CANNON (358), OPEN vs CAPPED twins
> on staggered fuses (open barrel fires its 356-cell shot; the capped twin has
> nowhere to vent and bursts its glass lid at ~t250, 75 shards), STEAM FOUNTAIN
> (clone re-drips the boiler forever, so it keeps throwing its sand charge),
> JET VENT (one nozzle carved through the wall; everything escapes there as a
> working jet), FLAT SHOT (213 cells across the range into the keep).
> FIXTURE LAWS EARNED HERE: (1) fuse burns ~0.1 cell/tick — one shared 380-cell
> train never reaches the far guns; give each gun its own short fuse and
> stagger by LENGTH; (2) the breech floor must be the range slab itself, or
> the fuse painted at y+1 lands inside wall and no-ops (paint fills EMPTY);
> (3) a cap 250 cells up a bore never sees the charge's pressure — capped
> demos need STUBBY barrels; (4) a flat shot at y≈615 sails clean over crates
> resting on the floor, and stacked boxes lock each other in place via their
> stamped footprints (the ball rebounds, nothing scatters) — use terrain as a
> backstop, not object stacks; (5) packed powder slugs still jam in a bore
> (M5b lesson holds) — ball shot, not sand columns.
>
> M5j SHIPPED 8/11 — SURFACES + THINGS ACTUALLY ROLL (owner ask: "walls
> smooth so things can roll and move on them, not stopped by jagged
> corners"). THE REAL BUG was not the walls: when a grounded object's
> vertical substep collided, the loop `break`s — so ANYTHING resting on a
> solid floor advanced ~1 cell/tick no matter how fast it was rolling
> (ball on ice: 131 cells in 120 ticks while holding vx 7.8). Powder
> floors looked faster only because the object sinks in and never trips
> that break. Now the vertical march stops but the horizontal substeps
> still spend: ice 948 / marble 926 / wall 843 / stone 761 in the same
> 120 ticks. STEP-UP: a blocked horizontal move now tries lifting 1-3
> cells before rebounding, so a one-cell lip is a pebble, not a wall
> (verified crossing 2, 3 and 6-cell jags; jagged tracks never stall).
> PER-SURFACE FEEL (data tables in elements.ts, read host-side by
> ObjectSystem — no engine change, no parity impact): SLICK[id] cancels
> friction loss (ice .95, marble .85, graphite .8, glass .7, metals .55,
> WALL .45 so the default building block is a usable track, stone .2),
> BOUNCE[id] multiplies restitution (vulcanite 1.9, rubber 1.6,
> superball 1.8, sand .45, mud .3, tar .15 — verified rebound heights).
> 4 ELEMENTS (ids 102-105, customs from 106): MARBLE (slick track stone,
> kilns to lime at 460, acid-fizzes like limestone), RUBBER (grippy
> bumper, burns dirty to smoke), GRAPHITE (dry-lubricant powder, burns to
> CO2), VULCANITE (rubber cured with sulfur — the bounciest surface).
> Bench hashes UNCHANGED (e009494c/a884374c/0df5e3db/2ae46e85) and all
> seven parity gates green: the shelf is additive and the fix is
> host-side. Regressions checked: cannons still fire 357, boxes stack,
> wheel rolls 568 downhill, nothing tunnels through floors.
>
> M5k SHIPPED 8/11 — REALISM AUDIT PASS (owner asked for an audit, then "do
> it all"). Ten measured gaps; nine closed, one deferred with a reason.
> ENGINE: (1) AIR FIELD — breathable oxygen per coarse cell, refilled from
> the world edge through the same edgeOpen gates pressure uses; fire draws
> 0.025/cell/tick and smothers below 0.25. Same room, two ways: sealed
> air 0.33 / 38 flame cells, open 0.55 / 71. SELF_OXIDIZING exempts
> gunpowder/fuse/nitro/thermite/fireworks/magnesium/phosphorus — they
> carry their own oxidiser, which is WHY a fuse burns sealed in a floor
> slab; without that exemption oxygen gating broke every fuse and killed
> the cannon demo. (2) HEAT BY MATERIAL — conduction rate is
> min(k_self, k_neighbour) per direction (resistances in series). Copper
> bar carries a torch 404 near / 30 at 75 cells; rubber 51 / ambient.
> AIR had been as conductive as a solid, which is why every hot bar bled
> sideways before heat could travel. (3) EVAPORATION below boiling when
> open air sits above. (4) Combustion emits CO2 and leaves exhaust.
> (5) REACT_BYPRODUCT — a third product vented to a free neighbour, so
> electrolysis yields its oxygen and chlor-alkali its lye. NOTE: making
> the spark itself become O2 silently broke spark propagation through
> submerged wires (the chem cells went dead) — byproducts keep the
> electrical system intact.
> DATA: sea ice (seawater coldAt -6), real calcination 825 / silica 1100 /
> lava 1150, heavier mercury 200 (sinks through stone) / iodine / cinnabar
> / gallium, nitro is not an acid.
> DEFERRED with reason: ice buoyancy — ice is an immovable solid, and
> floating it needs a movable-solid behaviour class, not a tuning change.
> Density still caps at ~6.7x water (255 reserved for immovable).
> COST: fire scenes roughly doubled in tick cost on both engines; latency
> gate max 20.8ms (was ~9) against a 60ms limit, so headroom is now ~3x.
> stepAir runs the whole interior loop whenever ANY fire exists and calls
> edgeOpen 4x per cell — the obvious optimisation target.
> Churn bench byte-identical (gas/fire-free path untouched); zoo
> re-baselined bbbcedfa/611f5992; stage-1 movement hash unchanged as the
> control. Seven parity gates now also pin the AIR field byte-for-byte.
>
> STEPAIR FAST PATH 8/11: full air surrounded by full air has nothing to
> exchange (almost every cell in almost every scene), so bail BEFORE the
> four edgeOpen scans that were the whole cost of the pass; recovered
> cells snap to exactly 1 and drop out of the active set. Latency gate max
> 27.4 → 6.0ms, fire scenes ~25-35% cheaper on both engines, churn
> untouched. In-app measurement: 56,113 of 57,600 coarse cells sit at
> exactly 1.0, which is the small active set the bail is designed to
> leave. LOAD-BEARING CONSTANT: the 0.9995 snap threshold. At 0.98 a room
> recovers faster than fire drains it and suffocation stops working
> entirely (sealed and open both read 0.94 air) — do not round it, and it
> now lives in BOTH world.ts and asm/engine.ts, so the two must move
> together. Zoo re-baselined 0c621fb6/9f694342; stage-1 and stage-2 hashes
> unchanged (no fire, so stepAir early-outs and provably cannot touch
> them). REMAINING COST: a lone torch still adds ~1.4ms in an empty world
> because its deficit stays active and spreads; bounding that wants
> chunk-gated activity like the thermal field, which pressure could share.
>
> M5l SHIPPED 8/11 — THE "DO IT ALL" BATCH (four host-side wins live, plus
> the last realism gap):
> (1) CUSTOM ELEMENTS NOW SURVIVE SHARING (was a real defect: saves store
> element IDs while specs lived only in localStorage, so a shared scene
> loaded as whatever YOUR id 106 was). Save format v2 = ["GLC2"][u32
> customLen][specs JSON][v1 body]; only the customs the scene actually
> uses travel. On load the scene ADOPTS them — identical local element
> reused, else a fresh id — then the grid is rewritten to match. Verified
> both ways: fresh browser adopts and keeps 11,800 cells; a browser whose
> own element holds 106 puts the incoming one at 107 and remaps. v1 and
> legacy GRN1 still load.
> (2) UNDO, 24 deep, Ctrl+Z or the transport button. Snapshots are save
> bytes (no new format), one per STROKE not per cell; also clear, quick-
> load, demo loads, object placement, gallery loads.
> (3) GALLERY THUMBNAILS + DELETE-YOUR-OWN. ~2.5KB webp from the minimap
> sampler. SECURITY: delete auth is an HMAC DERIVED server-side from the
> blob credential — the first draft stored the token in a public blob
> whose URL was guessable straight from the listing, i.e. anyone could
> delete anything. Never store the token.
> (4) VIDEO CAPTURE: MediaRecorder on the live canvas at 30fps → .webm,
> so clips show exactly what was on screen including hand-painting.
> (5) ICE FLOATS — closes the last audit gap. New B.FLOATER behavior:
> rigid (no slumping/dispersion) but Archimedean — settles through air and
> lighter matter, rises through denser. Ice goes from immovable to density
> 28 vs water 30 (the real 0.92 ratio). Submerged block climbs 600→556
> toward the surface; a sheet on land still rests on the floor. SIDE
> EFFECT worth knowing: ice is no longer a barrier() so ice-walled vessels
> no longer hold pressure/air. Ice behavior now lives in THREE places
> (registry data, doFloater, rupture's ice→snow) — change them together.
> Churn bench byte-identical throughout; zoo re-baselined 7e20f1b2/
> 2542d494. Stage-1 and stage-4 parity hashes unchanged (no ice) as the
> control that the change touches only ice and what it touches.
>
> BRUSH NIBS 8/11: the pen was always a disc; now round / square / diamond
> / ring / spray, because walls want a square, funnels a diamond, vessels
> a ring, and scattered powder a spray. Verified geometrically at r=10:
> round 317 (pi r^2), square 441 (21^2, corner filled), diamond 221,
> ring 124, spray ~27% scatter.
>
> CHUNK-GATED stepAir TRIED AND REJECTED 8/11 (negative result, recorded so
> nobody retries it blind). Implemented an active bounding window over the
> depleted region: it tracked correctly (3,072 cells of 56,604 interior,
> containing all 2,473 depleted cells) but measured WITHIN NOISE of the
> plain early-out — A/B on the same machine: windowed torch 2.84ms / big
> fire 17.5ms, stashed 2.60 / 15.2. The earlier "1.4ms torch" figure was a
> SHORTER RUN, not a faster build: cost grows with elapsed time because a
> persistent flame's deficit keeps diffusing outward, so any measurement
> must state its tick count. Tried bounding the spread by healing shallow
> deficits (>0.7) toward full — that broke suppression outright (sealed and
> open rooms both back to 1.0 air), the SAME trap as the 0.98 snap: a local
> rule cannot tell "connected to outside" from "sealed", so it invents air
> inside a closed room. Bounding this properly needs real connectivity
> (periodic flood fill from the borders), which is a design, not a tweak.
> Reverted; the shipped early-out stands.
>
> WORKER FEASIBILITY SPIKE 8/11 — shared memory REJECTED, copy-transfer is
> the design. Findings, so the next attempt starts from the right place:
> (1) AssemblyScript CAN build shared memory: asconfig `sharedMemory` +
> `maximumMemory` + `importMemory`, and it needs `enable: ["threads"]`
> (error AS108 otherwise). The adapter must then CREATE the memory and
> pass it as an `env.memory` import instead of reading `exports.memory`.
> Verified: it compiles and links.
> (2) BUT a module compiled with shared memory can ONLY accept shared
> memory (LinkError: "mismatch in shared state of memory"). That makes
> cross-origin isolation MANDATORY for the WASM engine, which is the
> DEFAULT engine in production — so a header problem would take the whole
> sim down, not just the worker.
> (3) And isolation fights the gallery: COEP require-corp blocks the
> cross-origin Vercel Blob scene fetches unless those responses carry CORP.
> COEP credentialless avoids that but Safari does not support it.
> (4) So if this is built, use COPY-TRANSFER instead: the worker owns an
> UNSHARED engine, and after each tick copies species+shade into a spare
> pair of buffers and transfers them (transfer is O(1); the memcpy is
> ~0.2ms against a 7-15ms tick), with main transferring them back. No
> headers, no isolation, works everywhere. ObjectSystem and Player must
> move INTO the worker with it (they need synchronous per-tick grid
> access), their positions ride along with the frame, and the QA API plus
> every scene builder become async/batched — that is the real cost, and it
> is a milestone, not a patch.
> Reverted the spike; production still runs the unshared build.
>
> INTERFACE PASS 8/11 (owner ask: UI/UX upgrade; engine untouched — no src/engine,
> asm or parity edits, so every bench hash and all seven gates stand where M5j
> left them):
> (1) LIVE BRUSH PREVIEW. A 2D overlay canvas (#nibcanvas, z-index 1 under the
> minimap) traces the exact footprint of the next dab in the held element's
> colour: round/square/diamond/ring as real geometry, spray dashed because it
> scatters, a centre cross once the nib is bigger than the cursor, and the
> pending line or rect while a line/rect stroke is being dragged. Rigid-object
> tools preview their true radius (ball 7 / box 8 / wheel 9 / bubble 4, mirrored
> host-side from KIND_R) — which is the "bore under ~16 cells wedges the shot"
> lesson made visible before you drop it. Redraw is dirty-rect only.
> VERIFIED by pixel probe: r=20 span 43px against an expected 41 + stroke, the
> square inks its corner (alpha 31 = the 12% wash) where the diamond and disc
> read 0, the ring's hole is empty where the disc's is filled, the stroke RGB
> equals the held element's swatch exactly, rect preview spans the 201×201 =
> 40,401 cells the release then paints, and nothing is painted while dragging.
> (2) CELL PROBE in the status bar. Element, temperature, O₂, overpressure and
> pH for the cell under the pointer — the four fields that could previously only
> be seen as full-screen shaders. Temperature is decoded from the renderer's
> byte field (bucket centre, ~5.6° steps) rather than a new engine surface, so
> WasmWorld needs no tempAt; modes 0/1/5 already fill that buffer every frame
> and the other modes refill at most 12 Hz. VERIFIED against engine values:
> lye pH 13, water pH 7, magma 1148°, ambient 20.6°, a torch sealed in a wall
> room 51° / O₂ 78% while open air holds 100%, and press 7.2 against a raw
> pressAt of 7.23 in the #boiler scene.
> (3) ELEMENT FILTER + RECENT RAIL. "/" or the sticky box at the top of the
> palette filters by element name OR rail name ("metals" → the 10 metals),
> folds empty rails away, counts matches, and Esc clears then blurs. A RECENT
> rail keeps the last 8 bound elements MRU-ordered in localStorage
> (granulab-recent) — an id can now own two buttons, so `buttons` is a
> Map<number, HTMLButtonElement[]> and selection marking walks both.
> (4) TRANSPORT REGROUPED: five hairline-separated clusters (Run / Edit / Pen /
> View / Scene), 20 controls down to 14 on the face, with files, share codes,
> slots, gallery and video folded into a "scene ▾" menu (outside-click and Esc
> close it, Esc returns focus to the trigger). Recording keeps a visible stop
> button with its elapsed clock on the face — a capture you cannot see is one
> you forget to stop. Fits 1024px: the wordmark goes at 1240, then the selects
> ellipsis at 1150.
> (5) REDO, paired with undo on the same 24-deep ring (Ctrl+Shift+Z / Ctrl+Y);
> a fresh edit drops the abandoned branch. VERIFIED bit-exact by grid hash
> across undo→undo→redo→redo, by button and by key.
> (6) SIX NAMED SAVE SLOTS (granulab-slots) with minimap thumbnails, replacing
> the single quicksave, which migrates into slot 1 rather than being orphaned.
> Round-trip verified exact at 211,451 dots including a rigid object.
> (7) CONTROLS PANEL behind "?" / F1, and a first-run card that names the three
> things that get someone painting and offers to load a demo (granulab-intro).
> A11Y PASS (Vercel Web Interface Guidelines). Fixed: every dialog was pinned to
> the top-left because `* { margin: 0 }` kills the UA's `margin: auto` — a bug
> since M4; --dim raised #7d828a → #868c95 so the whole chrome clears 4.5:1
> (worst case now 5.25); the focus ring moved off --accent-l to a fixed --focus
> (#e7e9ee), because holding Charcoal made the accent #33302c and the ring
> invisible; a skip link ahead of the 110-button palette; h1/h2/h3 hierarchy;
> aria-labelledby on all four dialogs; aria-labels on the reaction-row selects,
> gallery inputs and every × button; aria-pressed on palette buttons; confirm
> before either destructive delete (slot and gallery upload); prefers-reduced-
> motion now also kills the blast SCREEN SHAKE in renderer.ts (the flash stays —
> same information, no vestibular cost); local-time dates via Intl instead of
> toISOString, which dated an 11pm save as tomorrow; the reagent card is no
> longer aria-live (it rewrote 30 rows per click); touch-action, overscroll
> containment, tabular-nums, translate="no" on element names, theme-color.
> ACCEPTED DEVIATIONS: lowercase control labels (the instrument voice beats the
> guideline's Title Case), no list virtualisation for the palette (110 tiny
> buttons, and the filter is the real fix), ISO-ish date shape.
> QA NOTE (new, and it cost the first probe attempt): a Browser pane that is not
> displayed composites nothing, so ResizeObserver never fires and the canvas
> stays 0×0 — window.granulab now exposes `resize` and `drawPreview` so QA can
> drive the two frame-side jobs synchronously, exactly the way `tick(n)` already
> drives the sim.
>
> INTERFACE PASS 2 — "DO IT ALL" 8/11 (owner picked the whole proposal list). Nine
> shipped, six of them fixing things that were plainly broken:
> (1) DEMO RESTART. A native select fires no change event when you re-pick the
> option it already holds, and #demosel kept its value — so a scene you were
> already in could never be reloaded. It now snaps back to the placeholder.
> (2) CUSTOM ELEMENTS CAN BE EDITED AND DELETED (a "Manage…" entry in the CUSTOM
> rail). registerElement only appends, and unpicking a registry entry by hand
> means clearing two dozen flat arrays plus a row and a column of REACT — so
> instead the edit rewrites granulab-custom and RELOADS, which rebuilds the
> registry correctly by construction. The scene rides across in a raw v1
> snapshot (granulab-pending): NOT the v2 format, because v2 carries the custom
> specs and would re-adopt the very element you just changed or removed.
> BUG FOUND IN TESTING AND FIXED: deleting one invention slides every later one
> down an id, so the parked grid must be REMAPPED, not just have the deleted
> element erased — the first cut left Fizzite's 20,301 cells pointing at an id
> that no longer existed. Verified: delete the first of three, the other two
> keep every cell and the grid holds no phantom ids.
> (3) PAN WITHOUT A MIDDLE BUTTON. Held Space drags the view (a trackpad has no
> middle button at all); Space still toggles pause, decided on keyup, and only
> when the key was never used to drag. Shift+arrows pan, bare arrows still walk
> the stickman. +/- zoom, F fits, and the footer finally shows the zoom.
> (4) FILTER + ENTER binds the first match, so /thermite⏎ never touches a mouse.
> (5) TOASTS replace every alert(), the prompt() for share codes, and the
> silence after a successful copy. Share codes now get a real dialog, which also
> covers the clipboard-blocked case by showing the code to copy by hand.
> (6) DATASHEET CAPPED (Acid is 12 rows / 289px and had no max-height).
> (7) EYEDROPPER on Alt+click, either button. (8) LIVE MINIMAP: it was
> pointer-events:none; click or drag to move the view, with a viewport rectangle
> drawn on it. Verified the mapping cell-for-cell. (9) [ and ] step the pen size
> one at a time (keys 1-9 only reach nine of 48).
> PER-ELEMENT SLIDERS (DESIGN pillar 2, finally): a tune panel (T) over 14
> registry properties — density, spread, flammability, burn time, lifespan,
> blast radius, own temp, heat output, heat conduction, melting/freezing/ignition
> points, slipperiness, bounciness — gated so an element is only offered what
> means something for it. Tuning is keyed by element NAME (a deleted invention
> shifts ids), persists in granulab-tuning, and is APPLIED BEFORE the world is
> built so the WASM engine takes the tuned tables at init. Live edits need
> WasmWorld.refreshTables(), the ONLY engine-directory change in this pass: a
> public alias for the copy init already does, provably behaviour-neutral.
> VERIFIED ON WASM: drop Powder's density under water's and its settled mean row
> goes 477 -> 419 (it floats), reset puts it back to 477 exactly.
> ROVING TABINDEX: the palette was 119 tab stops, now one, with arrows/Home/End
> walking it (role=toolbar). COLOUR-BLIND ASSIST (scene → settings): letters on
> the palette swatches and a CVD-safe blue→teal→yellow pH ramp beside the
> red→green one, plus a minimap toggle and an engine picker that no longer needs
> a URL parameter.
> TOUCH + MOBILE: below 900px the palette becomes a slide-over drawer, the
> header scrolls sideways instead of dropping controls, and the probe sheds its
> optional channels. One finger paints; a second finger converts the stroke into
> a gesture (pinch zoom + two-finger pan) without smearing what it interrupted.
> At 375px the body overflowed by 1,002px until #app got minmax(0, 1fr) — a bare
> 1fr takes its min-content width from the toolbar.
> QA TRAPS (both cost real debugging time, both are the SAME family as the known
> rAF one): a Browser pane that is not displayed composites nothing, so (a) CSS
> TRANSITIONS NEVER ADVANCE — a drawer measured mid-transition reads as if the
> rule never applied, and the way to check is to set `transition: none` first;
> and (b) a stale-guard that greps for COMMENT text always reports stale, because
> Vite strips comments — grep a CODE literal (this is written down twice now).
> PARITY: all gates re-run green after the engine-directory edit — churn bench
> byte-identical (e009494c / a884374c), thermal / firezoo / devzoo / pressure all
> bit-exact TS vs WASM, shelf zoo 10/10 checkpoints, latency gate max 3.4ms
> against a 60ms limit.
>
> M4 QUEUE (still open): engine-in-a-worker via copy-transfer (above),
> stepAir spread-bounding via connectivity, dissolved-concentration
> channel, remaining BG modes (blur/shade/aura/light/mesh/track — partly
> obsoleted by the ambient overlays).
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
