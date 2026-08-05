# Powder Game Research Dossier

Research pass 2026-08-04 for **Granulab** — a next-generation version of
Dan-Ball's Powder Game with more options. Companion doc: [DESIGN.md](DESIGN.md).

## 1. The original: Powder Game (Dan-Ball, ver9.8)

Classic 2D falling-sand physics sandbox, originally Java applet (2007), later HTML5.
Its identity = **wind/air-pressure simulation + element reactions + stickman players +
community sharing**. Any successor must keep these recognisable features.

### Canvas & controls
- Play field ~**400×300 dots** (120,000 cells). Powder Game 2: 496×280 (138,880), wider.
- Pen sizes 0–9 (keyboard shortcuts), free line / straight line / lock / paint draw modes.
- Left AND right mouse button each carry a selected tool (two-tool workflow).
- Space = start/stop, Enter = frame-step, speed control, scale/zoom, grid toggle, minimap.

### Elements (~40 in ver9.8)
Powder, Water, Fire, Seed, Gunpowder, Ice/Snow, Superball, Oil, Stone, Magma, Virus,
Nitro, Torch, Gas, Soapy, Thunder, Metal, Laser, Acid, Vine, Salt, Seawater, Glass,
Bird, Mercury, Spark, Fuse, Cloud, Fireworks, Ant, Bomb, Steam.

Objects/pseudo-elements: **Wheel, Box, Ball, Block, Clone, Text**.

### Tools
Fan (continuous directional wind — the signature tool), Drag, Bubble, Pump
(liquid/gas transport), Create, Erase, Clear, Copy/Paste.

### States of matter (the wiki's taxonomy)
- **Powder-type**: falls straight down, affected by wind/drag/gravity, does NOT flow
  (powder, seed, gunpowder, snow, superball, fireworks, stone, virus, bomb, salt,
  spark, ant, bird).
- **Liquid**: flows laterally (water, seawater, oil, magma, nitro, mercury, acid, soapy).
- **Gas/energy**: rises or propagates (gas, steam, cloud, fire, thunder, laser, spark).
- **Static/solid**: block, metal, glass, ice, fuse, torch, vine, clone.

### Reactions (the depth layer)
A full pairwise **reaction table** exists on the Dan-Ball wiki. Signature ones:
salt+water→seawater, seed+water→vine growth, fire+gunpowder→explosion, acid dissolves
most solids, virus converts what it touches then dies, ant tunnels through powder,
laser reflects/refracts off certain elements, magma melts stone/metal, cloud floats and
holds rain, mercury is dense + laser-reflective, thunder ignites and pushes air.

### Players (unique-to-Powder-Game feature)
- **Player** stickman: arrow-key controllable; his head TAKES THE ATTRIBUTE of elements
  touched (fire head shoots fire, superball head bounces, etc.).
- **Fighter**: AI-driven combat variant of the stickman.

### Background render modes (14 — a distinctive "options" feature already)
none, air (pressure zones: green=high, blue=low), line (streamlines), blur, shade,
aura, light (additive), toon, mesh (wind as lines), gray, track (trajectory),
dark, TG (thermography), silhouette.

### Community
Upload with save codes, daily upload limits, voting (1 vote per work, not your own).
The sharing/voting loop is a core reason it lived for 15+ years.

### Powder Game 2 differences (their own "next gen" — lessons)
- Full engine **rewrite** because the original couldn't support new features.
- Wider screen, stronger **fluid-dynamics focus**.
- Added sand (distinct from powder), mud (sand+water), fish; magma renamed lava.
- Regressions fans noticed: fan restricted to 45° increments, some reactions simplified.
- Lesson: the rewrite unlocked features, but PG1 stayed popular — don't lose feel/options.

## 2. State of the art (what "next generation" means in 2026)

### The Powder Toy — depth benchmark (C++/SDL, open source)
- **258 elements**; simulates **air pressure + velocity field, heat, Newtonian gravity**.
- Full electronics: conductors, semiconductors, switches → players build working CPUs.
- **Lua scripting API** for automation and mods; huge save browser.
- Takeaway: per-cell temperature + pressure fields + electricity = the depth ceiling.

### Sandboxels — breadth benchmark (R74n, pure JS, in-browser)
- **500+ elements, thousands of reactions**; per-element density, temperature response,
  conductivity; cooking/chemistry themes; **JS mod system** (drop-in .js mods).
- Takeaway: data-driven element definitions are what make "more options" cheap.

### Sandspiel — feel/performance benchmark (Max Bittker)
- **Rust→WASM** cell simulation + **GPU (WebGL) fluid simulation** (adapted from
  PavelDoGreat/WebGL-Fluid-Simulation) coupled to the CA; JS for UI/social.
- Wind/fluid running on GPU is why it feels silky. Small WASM binary (~84KB, -O3).
- Takeaway: hybrid CPU-CA + GPU-fluid is the modern equivalent of Dan-Ball's air sim.

### Noita "Falling Everything" — engineering benchmark (GDC 2019, Petri Purho)
- World split into **64×64 chunks, each with a dirty rect**; only dirty pixels update.
- **Multithreaded** chunk updates (checkerboard scheduling to avoid races); an
  update-counter per pixel prevents double-updating when a pixel crosses chunks.
- **Rigid bodies**: marching squares over pixel groups → Box2D bodies made of pixels
  (this is the modern version of Powder Game's Wheel/Box/Ball objects).
- Takeaway: chunks + dirty rects + checkerboard threading = how you go big.

## 3. Competitive gap = our opportunity

| | Powder Game | Powder Toy | Sandboxels | Sandspiel |
|---|---|---|---|---|
| Wind/air field | ✅ signature | ✅ | ⚠️ weak | ✅ GPU |
| Temperature field | ❌ (flags only) | ✅ | ✅ | ❌ |
| Electricity | ⚠️ (metal+spark) | ✅ full | ✅ | ❌ |
| Stickman players | ✅ unique | ❌ | ❌ | ❌ |
| Rigid-body objects | ✅ wheel/box/ball | ⚠️ | ❌ | ❌ |
| BG render modes | ✅ 14 modes | ⚠️ few | ❌ | ❌ |
| Custom elements/mods | ❌ | ✅ Lua | ✅ JS mods | ❌ |
| Sharing/community | ✅ | ✅ | ⚠️ | ✅ |
| Touch/mobile | ⚠️ | ⚠️ | ✅ | ✅ |

**Nobody combines**: Powder Game's wind + players + objects + BG modes with Powder Toy's
temperature/electricity depth, Sandboxels' data-driven breadth/modding, and
sandspiel/Noita's performance engineering. That combination IS the next-gen version.

## Sources
- https://dan-ball.jp/en/javagame/dust/ (official, feature inventory)
- https://danball.fandom.com/wiki/Powder_Game and /wiki/Powder_Game_Reaction_Table
- https://danball.fandom.com/wiki/Comparison_of_Powder_Game_and_Powder_Game_2
- https://github.com/The-Powder-Toy/The-Powder-Toy
- https://github.com/R74nCom/sandboxels
- https://github.com/MaxBittker/sandspiel + https://maxbittker.com/making-sandspiel/
- Noita GDC 2019 "Exploring the Tech and Design of Noita" (falling-everything engine)
