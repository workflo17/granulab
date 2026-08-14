# Granulab

**Play it: https://granulab-workflo17.vercel.app**

A falling-sand powder game in the Dan-Ball lineage: paint elements into a 1280×720
world and watch them interact. 63 element ids, and 21 of those are blank slots for
elements you invent yourself in the in-game maker.

What's simulated:

- A half-resolution temperature field covers the world. Fire, magma, torches and
  sparks pump heat in; ice and snow pull it out. Every phase change is registry
  data, not special-case code: ice melts, water boils, steam condenses into clouds
  that rain, sand turns to glass at magma contact, and a hot enough wall will
  detonate the nitro on the other side of it.
- Contact chemistry (salt + water, acid, virus, clone) comes from a data-driven
  reaction table.
- A quarter-resolution wind field carries fan beams, saltating sand, and explosion
  shockwaves.
- Rigid objects: balls bounce, boxes stack, wheels read the slope under each rim
  and roll downhill, bubbles float up. Powders pile on top of all of them.
- A playable stickman (arrow keys). His head absorbs the last element it touched:
  a fire head burns things, a superball head jumps higher, a bird head floats. A
  fighter AI will chase you around the sandbox.
- Custom elements are full citizens: the maker dialog sets state, density,
  flammability, thermal profile, and up to six reaction rows, and they persist in
  localStorage.
- A whole scene compresses to a share code of roughly 280 characters you can paste
  in chat. There are no accounts and no backend.

## Run it locally

```
npm install
npm run dev
```

`npm run build` compiles the AssemblyScript core and bundles with Vite.

## How it's built

TypeScript + Vite, WebGL rendering, and a sim core written twice: once in
TypeScript and once in AssemblyScript compiled to WASM. The WASM engine is the
default; `npm run parity` proves the two engines produce bit-identical worlds, and
`?engine=ts` switches back if you want to compare. Background modes include a
thermography view, so you can watch the heat field itself.

## Feedback

If something behaves in a way that surprises you, or the UI loses you somewhere,
[an issue](https://github.com/workflo17/granulab/issues/new) is welcome. "I
expected X and got Y" is plenty.
