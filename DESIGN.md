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
> M4 QUEUE: multiple reaction rows per element, remaining BG modes
> (blur/shade/aura/light/toon/mesh/track), pump/bubble tools, minimap, upload
> gallery, wheel spin visual, WASM hot loop (perf ceiling).
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
