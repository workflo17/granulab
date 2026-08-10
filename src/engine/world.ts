// Granulab world: flat typed arrays, bottom-up alternating scan, 32x32 dirty chunks,
// quarter-res wind field driven by fan beams. Zero allocation in the tick loop.

import {
  E, B, N_IDS, BEHAVIOR, DENSITY, DISPERSE, FLAMMABLE, BURNLIFE, LIFE0,
  EXPLODE_R, HOT, REACT, HAS_REACT, REACT_COUNT, REACT_DT, PH,
  CONDUCTS, CONDUCT_IDX, CONDUCTOR_IDS,
  TEMP0, HEAT_PUMP, HOT_AT, HOT_TO, COLD_AT, COLD_TO, IGNITES_AT, THERMAL,
  PRESSURIZES,
} from "./elements";
import { Rng } from "./rng";

const CHUNK = 32;
const CHUNK_SHIFT = 5;

// liquids that calm down and sleep when nothing around them changes
// (acid/magma excluded: their life byte is a corrosion budget / they must stay hot)
const HYST = new Uint8Array(N_IDS);
HYST[E.WATER] = HYST[E.SEAWATER] = HYST[E.OIL] = HYST[E.MERCURY] = HYST[E.MUD] = HYST[E.NITRO] = 1;
// M5i: heavy gases no longer sleep — a sleeping pool vanishes from the
// pressure census, and a calm propane room MUST still pressurize. (CO2 and
// chlorine kept their sleep before pressure existed; gases don't settle now.)
HYST[E.SOAPY] = 1;
const SETTLE = 6; // ticks of stillness before a liquid cell stops dispersing
const MARGIN = 2; // changes this close to a chunk border wake the neighbor
const WSHIFT = 2; // wind cell = 4x4 sim cells
const FAN_BEAM = 64; // beam length in wind cells (256 sim px)
const MAX_FAN_BEAMS = 512; // per tick, stride over the list beyond this
const TSHIFT = 1; // temperature cell = 2x2 sim cells
const AMBIENT = 20; // °C — the field drifts back here and sleeps

export class World {
  readonly W: number;
  readonly H: number;
  readonly species: Uint8Array;
  readonly shade: Uint8Array; // per-grain color variation, travels with the grain
  readonly life: Uint8Array; // fuse timers, burn life, fan angle, clone memory
  readonly clock: Uint8Array; // frame stamp — prevents double-updating moved cells
  // ballistic grain velocity, fixed-point x16 (Noita-style arcs); transient —
  // not serialized, zeroed on load. Nonzero = the cell flies instead of falling.
  readonly vx8: Int8Array;
  readonly vy8: Int8Array;

  readonly chunksX: number;
  readonly chunksY: number;
  private activeCur: Uint8Array;
  private activeNext: Uint8Array;

  // wind field (quarter resolution)
  readonly WX: number;
  readonly WY: number;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  private fans: number[] = []; // cell indices of painted fans (lazy-validated)

  // reaction glow field (quarter res, shares the wind grid dims): reactions
  // light it up, it fades — the "rx" background mode renders it
  readonly glow: Float32Array;
  private glowTicks = 0;

  // M5i pressure field (quarter res, wind grid dims): trapped gas + heat build
  // overpressure; it vents through openings as wind, and past the breaking
  // point it SHATTERS containers. Transient — never serialized, zeroed on load.
  readonly press: Float32Array;
  // exact per-coarse-cell gas census, maintained INCREMENTALLY at the four
  // species-write sites (set/paint/rawSet/swap) — an active-chunk scan missed
  // calm pools whose chunks had gone structurally inactive
  private pgas: Int16Array;
  private pressTicks = 0;
  private gasDots = 0; // world total of PRESSURIZES cells — system skips when 0

  // temperature field (half resolution), chunk-gated like the cell sim
  readonly TW: number;
  readonly TH: number;
  readonly temp: Float32Array;
  private thermalCur: Uint8Array;
  private thermalNext: Uint8Array;

  readonly rng: Rng;
  frame = 0;
  dots = 0; // non-empty, non-wall cell count
  /** soapy cells whipped off by wind this tick — ObjectSystem drains these
   *  into bubble objects (the world can't spawn entities itself) */
  readonly bubbleQueue: number[] = [];
  /** blasts this tick as (cx, cy, r) triplets — ObjectSystem turns them into
   *  impulses on balls/boxes/wheels (a cannonball on a charge must launch) */
  readonly blastQueue: number[] = [];
  /** decaying blast magnitude for render feedback (flash + screen shake) */
  fxPower = 0;

  constructor(w: number, h: number, seed = 0xc0ffee) {
    this.W = w;
    this.H = h;
    const n = w * h;
    this.species = new Uint8Array(n);
    this.shade = new Uint8Array(n);
    this.life = new Uint8Array(n);
    this.clock = new Uint8Array(n);
    this.vx8 = new Int8Array(n);
    this.vy8 = new Int8Array(n);
    this.chunksX = Math.ceil(w / CHUNK);
    this.chunksY = Math.ceil(h / CHUNK);
    this.activeCur = new Uint8Array(this.chunksX * this.chunksY);
    this.activeNext = new Uint8Array(this.chunksX * this.chunksY);
    this.WX = w >> WSHIFT;
    this.WY = h >> WSHIFT;
    this.vx = new Float32Array(this.WX * this.WY);
    this.vy = new Float32Array(this.WX * this.WY);
    this.glow = new Float32Array(this.WX * this.WY);
    this.press = new Float32Array(this.WX * this.WY);
    this.pgas = new Int16Array(this.WX * this.WY);
    this.TW = w >> TSHIFT;
    this.TH = h >> TSHIFT;
    this.temp = new Float32Array(this.TW * this.TH).fill(AMBIENT);
    this.thermalCur = new Uint8Array(this.chunksX * this.chunksY);
    this.thermalNext = new Uint8Array(this.chunksX * this.chunksY);
    this.rng = new Rng(seed);
  }

  // ---- chunk bookkeeping -------------------------------------------------

  private wake(x: number, y: number): void {
    const cx = x >> CHUNK_SHIFT;
    const cy = y >> CHUNK_SHIFT;
    const cw = this.chunksX;
    this.activeNext[cy * cw + cx] = 1;
    const lx = x & (CHUNK - 1);
    const ly = y & (CHUNK - 1);
    if (lx < MARGIN && cx > 0) this.activeNext[cy * cw + cx - 1] = 1;
    if (lx >= CHUNK - MARGIN && cx < cw - 1) this.activeNext[cy * cw + cx + 1] = 1;
    if (ly < MARGIN && cy > 0) this.activeNext[(cy - 1) * cw + cx] = 1;
    if (ly >= CHUNK - MARGIN && cy < this.chunksY - 1) this.activeNext[(cy + 1) * cw + cx] = 1;
    // also keep it live for the current pass so cascades continue this frame
    this.activeCur[cy * cw + cx] = 1;
  }

  activeChunkCount(): number {
    let c = 0;
    for (let i = 0; i < this.activeCur.length; i++) c += this.activeCur[i];
    return c;
  }

  // ---- cell mutation (all writes go through these) -----------------------

  /** Paint/spawn a cell. Elements only fill EMPTY; WALL and EMPTY overwrite.
   *  `aux` overrides the initial life value (fan angle byte). */
  paint(x: number, y: number, id: number, aux?: number): void {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = y * this.W + x;
    const old = this.species[i];
    if (id === old && id !== E.FAN) return;
    // elements fill empty cells only; wall/erase overwrite; spark conducts onto
    // metal; fire painted onto a flammable ignites it in place
    const replaceable =
      old === E.EMPTY || id === E.EMPTY || id === E.WALL ||
      (id === E.SPARK && CONDUCTS[old] > 0) ||
      (id === E.FIRE && FLAMMABLE[old] > 0);
    if (!replaceable) return;
    if (id === E.FIRE && old !== E.EMPTY && EXPLODE_R[old] > 0) {
      this.explode(x, y, EXPLODE_R[old]);
      return;
    }
    if (old !== E.EMPTY && old !== E.WALL) this.dots--;
    if (id !== E.EMPTY && id !== E.WALL) this.dots++;
    const gd = PRESSURIZES[id] - PRESSURIZES[old];
    if (gd !== 0) {
      this.gasDots += gd;
      this.pgas[(y >> WSHIFT) * this.WX + (x >> WSHIFT)] += gd;
    }
    this.species[i] = id;
    this.shade[i] = this.rng.byte();
    // sparks track wire-born-ness in shade bit 0 (painted onto a conductor =
    // wire) and which conductor they were in bits 1-2
    if (id === E.SPARK) {
      this.shade[i] = CONDUCTS[old] > 0
        ? (this.shade[i] & 0xf8) | 1 | (CONDUCT_IDX[old] << 1)
        : this.shade[i] & 0xfe;
    }
    this.life[i] = aux !== undefined ? aux : LIFE0[id];
    this.vx8[i] = 0;
    this.vy8[i] = 0;
    if (id === E.FAN && this.fans.length < 8192) this.fans.push(i);
    if (HEAT_PUMP[id] > 0) this.pumpHeat(x, y, TEMP0[id], 0.6); // seed the heat field
    this.wake(x, y);
    // painting unsettles adjacent calm liquids so pools react to edits
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
      const j = ny * this.W + nx;
      if (HYST[this.species[j]]) this.life[j] = 0;
    }
  }

  /** direct cell write for rigid-object footprints — bypasses paint rules */
  rawSet(x: number, y: number, id: number, shade = 170): void {
    const i = y * this.W + x;
    const old = this.species[i];
    if (old === id) return;
    if (old !== E.EMPTY && old !== E.WALL) this.dots--;
    if (id !== E.EMPTY && id !== E.WALL) this.dots++;
    const gd = PRESSURIZES[id] - PRESSURIZES[old];
    if (gd !== 0) {
      this.gasDots += gd;
      this.pgas[(y >> WSHIFT) * this.WX + (x >> WSHIFT)] += gd;
    }
    this.species[i] = id;
    this.shade[i] = shade;
    this.life[i] = 0;
    this.vx8[i] = 0;
    this.vy8[i] = 0;
    this.wake(x, y);
  }

  private set(i: number, x: number, y: number, id: number, lifeVal: number): void {
    const old = this.species[i];
    if (old !== E.EMPTY && old !== E.WALL) this.dots--;
    if (id !== E.EMPTY && id !== E.WALL) this.dots++;
    const gd = PRESSURIZES[id] - PRESSURIZES[old];
    if (gd !== 0) {
      this.gasDots += gd;
      this.pgas[(y >> WSHIFT) * this.WX + (x >> WSHIFT)] += gd;
    }
    this.species[i] = id;
    this.life[i] = lifeVal;
    this.vx8[i] = 0;
    this.vy8[i] = 0;
    this.clock[i] = this.stamp;
    this.wake(x, y);
  }

  private swap(i: number, j: number, xi: number, yi: number, xj: number, yj: number): void {
    const s = this.species;
    const sh = this.shade;
    const lf = this.life;
    const vx = this.vx8;
    const vy = this.vy8;
    let t = s[i]; s[i] = s[j]; s[j] = t;
    t = sh[i]; sh[i] = sh[j]; sh[j] = t;
    t = lf[i]; lf[i] = lf[j]; lf[j] = t;
    t = vx[i]; vx[i] = vx[j]; vx[j] = t;
    t = vy[i]; vy[i] = vy[j]; vy[j] = t;
    this.clock[i] = this.stamp;
    this.clock[j] = this.stamp;
    // gas grains carry their census entry between coarse cells
    const gi = PRESSURIZES[s[i]] - PRESSURIZES[s[j]];
    if (gi !== 0) {
      const ci = (yi >> WSHIFT) * this.WX + (xi >> WSHIFT);
      const cj = (yj >> WSHIFT) * this.WX + (xj >> WSHIFT);
      if (ci !== cj) {
        this.pgas[ci] += gi;
        this.pgas[cj] -= gi;
      }
    }
    this.wake(xi, yi);
    this.wake(xj, yj);
  }

  // ---- wind field --------------------------------------------------------

  private windTicks = 0; // wind sim runs only while energy is in the field

  /** solid fraction of a coarse cell (0..1): static matter blocks pressure
   *  flow; powder piles leak, like gas seeping through gravel */
  private solidFrac(wi: number): number {
    const wx = wi % this.WX;
    const wy = (wi / this.WX) | 0;
    const x0 = wx << WSHIFT;
    const y0 = wy << WSHIFT;
    let s = 0;
    for (let dy = 0; dy < 4; dy++) {
      const row = (y0 + dy) * this.W + x0;
      for (let dx = 0; dx < 4; dx++) {
        const id = this.species[row + dx];
        if (id !== 0 && (DENSITY[id] === 255 || BEHAVIOR[id] === B.NONE)) s++;
      }
    }
    return s / 16;
  }

  /** M5i: trapped gas + heat build overpressure; it vents through openings as
   *  wind and SHATTERS glass/ice containers past the breaking point */
  private stepPressure(): void {
    if (this.gasDots === 0 && this.pressTicks === 0) return; // gas-free scene: free
    const { WX, WY, press } = this;
    const pcount = this.pgas; // exact census, maintained at the write sites
    if (this.gasDots > 0) this.pressTicks = 240;
    else this.pressTicks--;

    const T = this.temp;
    const { vx, vy } = this;
    for (let y = 1; y < WY - 1; y++) {
      const r = y * WX;
      for (let x = 1; x < WX - 1; x++) {
        const i = r + x;
        const cnt = pcount[i];
        let p = press[i];
        if (cnt === 0 && p === 0) continue;
        if (cnt > 0) {
          // ideal-gas-ish: occupancy x temperature drives the target
          const t = T[((y << WSHIFT) >> TSHIFT) * this.TW + ((x << WSHIFT) >> TSHIFT)];
          const target = cnt * 0.5 * (1 + Math.max(0, t) * 0.004);
          p += (target - p) * 0.15; // fast fill: burns outrun slow pressure
        }
        // openness-gated exchange with neighbors; sealed rooms hold, leaks vent
        const open = 1 - this.solidFrac(i);
        const oL = Math.min(open, 1 - this.solidFrac(i - 1));
        const oR = Math.min(open, 1 - this.solidFrac(i + 1));
        const oU = Math.min(open, 1 - this.solidFrac(i - WX));
        const oD = Math.min(open, 1 - this.solidFrac(i + WX));
        p += ((press[i - 1] - p) * oL + (press[i + 1] - p) * oR +
              (press[i - WX] - p) * oU + (press[i + WX] - p) * oD) * 0.25;
        // venting is CONNECTIVITY, not local openness: open terrain drains to
        // the zero-pressure borders through diffusion; sealed rooms hold
        p *= cnt > 0 ? 0.999 : 0.985;
        p = p > 12 ? 12 : p;
        press[i] = p > 0.01 || p < -0.01 ? p : 0;
        // the gradient becomes wind: vents whistle, ruptures blast
        const gx = (press[i - 1] - press[i + 1]) * 0.15;
        const gy = (press[i - WX] - press[i + WX]) * 0.15;
        if (gx > 0.05 || gx < -0.05) vx[i] += gx > 1.5 ? 1.5 : gx < -1.5 ? -1.5 : gx;
        if (gy > 0.05 || gy < -0.05) vy[i] += gy > 1.5 ? 1.5 : gy < -1.5 ? -1.5 : gy;
        if (p > 2.2) this.rupture(x, y, i, p);
      }
    }
    if (this.pressTicks > 0) this.windTicks = Math.max(this.windTicks, 2);
  }

  /** overpressured coarse cell: glass shatters into thrown shards, ice bursts
   *  into snow; stone and wall hold (that's what makes them pressure vessels).
   *  Pressure pushes ON the container walls, so the sweep covers this coarse
   *  cell AND its four neighbors — the vessel skin never pressurizes itself
   *  (it's solid, so the openness gate keeps the field out of it) */
  private rupture(wx: number, wy: number, wi: number, p: number): void {
    const { W, WX, WY } = this;
    let broke = false;
    const sweep = (cx: number, cy: number): void => {
      const x0 = cx << WSHIFT;
      const y0 = cy << WSHIFT;
      for (let dy = 0; dy < 4; dy++) {
        const y = y0 + dy;
        const row = y * W + x0;
        for (let dx = 0; dx < 4; dx++) {
          const i = row + dx;
          const id = this.species[i];
          if (id === E.GLASS && p > 3 && this.rng.byte() < 40) {
            this.set(i, x0 + dx, y, E.SHARDS, 0);
            this.shade[i] = this.rng.byte();
            this.vx8[i] = ((this.rng.byte() - 128) / 3) | 0;
            this.vy8[i] = -(this.rng.byte() >> 3);
            broke = true;
          } else if (id === E.ICE && this.rng.byte() < 50) {
            this.set(i, x0 + dx, y, E.SNOW, 0);
            this.vx8[i] = ((this.rng.byte() - 128) / 4) | 0;
            this.vy8[i] = -(this.rng.byte() >> 4);
            broke = true;
          }
        }
      }
    };
    sweep(wx, wy);
    if (wx > 0) sweep(wx - 1, wy);
    if (wx < WX - 1) sweep(wx + 1, wy);
    if (wy > 0) sweep(wx, wy - 1);
    if (wy < WY - 1) sweep(wx, wy + 1);
    if (broke) {
      this.press[wi] = p * 0.55; // the burst vents
      this.wake(wx << WSHIFT, wy << WSHIFT);
      this.wake((wx << WSHIFT) + 3, (wy << WSHIFT) + 3);
    }
  }

  private stepWind(): void {
    if (this.fans.length === 0 && this.windTicks === 0) return;
    if (this.fans.length > 0) this.windTicks = 240;
    else this.windTicks--;
    const { vx, vy, WX, WY } = this;
    // decay + one cheap in-place diffusion pass (interior only)
    for (let y = 1; y < WY - 1; y++) {
      const r = y * WX;
      for (let x = 1; x < WX - 1; x++) {
        const i = r + x;
        vx[i] = vx[i] * 0.78 + (vx[i - 1] + vx[i + 1] + vx[i - WX] + vx[i + WX]) * 0.05;
        vy[i] = vy[i] * 0.78 + (vy[i - 1] + vy[i + 1] + vy[i - WX] + vy[i + WX]) * 0.05;
      }
    }
    // fan beams
    const fans = this.fans;
    if (fans.length === 0) return;
    const stride = fans.length > MAX_FAN_BEAMS ? Math.ceil(fans.length / MAX_FAN_BEAMS) : 1;
    const phase = this.frame % stride;
    let write = 0;
    for (let k = 0; k < fans.length; k++) {
      const i = fans[k];
      if (this.species[i] !== E.FAN) continue; // erased — drop from list
      fans[write++] = i;
      if (k % stride !== phase) continue;
      const fx = (i % this.W) >> WSHIFT;
      const fy = ((i / this.W) | 0) >> WSHIFT;
      const ang = (this.life[i] / 256) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      for (let t = 1; t <= FAN_BEAM; t++) {
        const wx = Math.round(fx + dx * t);
        const wy = Math.round(fy + dy * t);
        if (wx < 0 || wy < 0 || wx >= this.WX || wy >= this.WY) break;
        const sx = (wx << WSHIFT) + 2;
        const sy = (wy << WSHIFT) + 2;
        if (this.species[sy * this.W + sx] === E.WALL) break;
        const p = 2.0 * (1 - t / FAN_BEAM) * stride;
        const wi = wy * this.WX + wx;
        this.vx[wi] = Math.max(-8, Math.min(8, this.vx[wi] + dx * p));
        this.vy[wi] = Math.max(-8, Math.min(8, this.vy[wi] + dy * p));
        if ((t & 1) === 0) this.wake(sx, sy);
      }
    }
    fans.length = write;
  }

  // ---- temperature field -------------------------------------------------

  private markThermalCoarse(tx: number, ty: number): void {
    const cx = tx >> 4; // 16 coarse cells per 32-sim-cell chunk
    const cy = ty >> 4;
    const cw = this.chunksX;
    this.thermalNext[cy * cw + cx] = 1;
    this.thermalCur[cy * cw + cx] = 1;
    if ((tx & 15) === 0 && cx > 0) this.thermalNext[cy * cw + cx - 1] = 1;
    if ((tx & 15) === 15 && cx < cw - 1) this.thermalNext[cy * cw + cx + 1] = 1;
    if ((ty & 15) === 0 && cy > 0) this.thermalNext[(cy - 1) * cw + cx] = 1;
    if ((ty & 15) === 15 && cy < this.chunksY - 1) this.thermalNext[(cy + 1) * cw + cx] = 1;
  }

  /** drive the heat field at a sim cell toward `target` with strength k */
  pumpHeat(x: number, y: number, target: number, k: number): void {
    const tx = x >> TSHIFT;
    const ty = y >> TSHIFT;
    const ti = ty * this.TW + tx;
    this.temp[ti] += (target - this.temp[ti]) * k;
    this.markThermalCoarse(tx, ty);
  }

  tempAt(x: number, y: number): number {
    return this.temp[(y >> TSHIFT) * this.TW + (x >> TSHIFT)];
  }

  thermalChunkCount(): number {
    let c = 0;
    for (let i = 0; i < this.thermalCur.length; i++) c += this.thermalCur[i];
    return c;
  }

  /** encode temp for the thermography shader: byte = (T + 60) * 0.18 */
  fillTempTex(buf: Uint8Array): void {
    const t = this.temp;
    for (let i = 0; i < t.length; i++) {
      buf[i] = Math.max(0, Math.min(255, (t[i] + 60) * 0.18)) | 0;
    }
  }

  private stepTemp(): void {
    const swap = this.thermalCur;
    this.thermalCur = this.thermalNext;
    this.thermalNext = swap;
    this.thermalNext.fill(0);
    const { temp, TW, TH, chunksX, chunksY, species, W } = this;
    const cur = this.thermalCur;
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        if (!cur[cy * chunksX + cx]) continue;
        const tx0 = cx << 4;
        const ty0 = cy << 4;
        const tx1 = Math.min(tx0 + 16, TW);
        const ty1 = Math.min(ty0 + 16, TH);
        for (let ty = ty0; ty < ty1; ty++) {
          const row = ty * TW;
          for (let tx = tx0; tx < tx1; tx++) {
            const i = row + tx;
            // diffuse (in-place, clamped neighbors) + drift toward ambient
            const l = tx > 0 ? temp[i - 1] : AMBIENT;
            const r = tx < TW - 1 ? temp[i + 1] : AMBIENT;
            const u = ty > 0 ? temp[i - TW] : AMBIENT;
            const d = ty < TH - 1 ? temp[i + TW] : AMBIENT;
            let t = temp[i] * 0.72 + (l + r + u + d) * 0.07;
            t += (AMBIENT - t) * 0.004;
            temp[i] = t;
            if (t > AMBIENT + 2 || t < AMBIENT - 2) this.markThermalCoarse(tx, ty);
            else continue; // thermally boring cell: skip the phase scan
            // phase pass over this coarse cell's 2x2 sim cells
            const sx0 = tx << TSHIFT;
            const sy0 = ty << TSHIFT;
            for (let sy = sy0; sy < sy0 + 2; sy++) {
              const sRow = sy * W;
              for (let sx = sx0; sx < sx0 + 2; sx++) {
                const si = sRow + sx;
                const id = species[si];
                if (!THERMAL[id]) continue;
                // pump at most once per coarse cell so dense blocks don't overpower
                if (HEAT_PUMP[id] > 0 && sx === sx0 && sy === sy0) {
                  const tg = TEMP0[id];
                  temp[i] += (tg - temp[i]) * HEAT_PUMP[id];
                }
                if (t >= IGNITES_AT[id] && this.rng.byte() < 60) {
                  if (id === E.FIREWORKS) this.set(si, sx, sy, E.ROCKET, LIFE0[E.ROCKET] + this.rng.int(16));
                  else if (EXPLODE_R[id] > 0) this.explode(sx, sy, EXPLODE_R[id]);
                  else this.set(si, sx, sy, E.FIRE, BURNLIFE[id]);
                  continue;
                }
                if (t >= HOT_AT[id]) {
                  const p = Math.min(220, (t - HOT_AT[id]) * 6);
                  if (this.rng.byte() < p) {
                    const to = HOT_TO[id];
                    this.set(si, sx, sy, to, LIFE0[to]);
                    this.shade[si] = this.rng.byte();
                  }
                } else if (t <= COLD_AT[id]) {
                  const p = Math.min(180, (COLD_AT[id] - t) * 3);
                  if (this.rng.byte() < p) {
                    const to = COLD_TO[id];
                    this.set(si, sx, sy, to, LIFE0[to]);
                    this.shade[si] = this.rng.byte();
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /** encode the reaction glow for the "rx" background shader */
  fillGlowTex(buf: Uint8Array): void {
    const g = this.glow;
    for (let i = 0; i < g.length; i++) {
      buf[i] = Math.min(255, g[i] * 96) | 0;
    }
  }

  windAt(x: number, y: number): [number, number] {
    const wi = (y >> WSHIFT) * this.WX + (x >> WSHIFT);
    return [this.vx[wi], this.vy[wi]];
  }

  /** fill an RG byte buffer (128-centered) for the air-view shader */
  fillWindTex(buf: Uint8Array): void {
    const { vx, vy } = this;
    for (let i = 0; i < vx.length; i++) {
      buf[i * 2] = Math.max(0, Math.min(255, 128 + vx[i] * 14)) | 0;
      buf[i * 2 + 1] = Math.max(0, Math.min(255, 128 + vy[i] * 14)) | 0;
    }
  }

  /** wind shove for mobile cells; returns true if the cell moved */
  private tryWindPush(i: number, x: number, y: number, k: number): boolean {
    const wi = (y >> WSHIFT) * this.WX + (x >> WSHIFT);
    const wx = this.vx[wi];
    const wy = this.vy[wi];
    const m = (wx < 0 ? -wx : wx) + (wy < 0 ? -wy : wy);
    if (m < 0.5) return false;
    if (this.rng.next() >= m * k) return false;
    let dx = wx > 0.4 ? 1 : wx < -0.4 ? -1 : 0;
    let dy = wy > 0.4 ? 1 : wy < -0.4 ? -1 : 0;
    if (dx === 0 && dy === 0) return false;
    const { W, H, species } = this;
    let nx = x + dx;
    let ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < H && species[ny * W + nx] === E.EMPTY) {
      this.swap(i, ny * W + nx, x, y, nx, ny);
      return true;
    }
    if (dx !== 0 && dy !== 0) {
      nx = x + dx;
      if (nx >= 0 && nx < W && species[y * W + nx] === E.EMPTY) {
        this.swap(i, y * W + nx, x, y, nx, y);
        return true;
      }
    }
    // saltation: horizontal wind lofts surface grains up-and-over obstacles
    if (dx !== 0) {
      nx = x + dx;
      ny = y - 1;
      if (nx >= 0 && ny >= 0 && nx < W && species[ny * W + nx] === E.EMPTY && this.rng.byte() < 200) {
        this.swap(i, ny * W + nx, x, y, nx, ny);
        return true;
      }
    }
    return false;
  }

  // ---- the tick ----------------------------------------------------------

  private stamp = 0;

  step(): void {
    this.frame++;
    this.stamp = this.frame & 0xff;
    const t = this.activeCur;
    this.activeCur = this.activeNext;
    this.activeNext = t;
    this.activeNext.fill(0);

    this.stepWind();
    this.stepPressure();
    this.stepTemp();
    if (this.fxPower > 0.3) this.fxPower *= 0.88;
    else this.fxPower = 0;
    if (this.glowTicks > 0) {
      this.glowTicks--;
      const g = this.glow;
      for (let i = 0; i < g.length; i++) {
        if (g[i] !== 0) g[i] = g[i] > 0.02 ? g[i] * 0.94 : 0;
      }
    }

    const { W, H, species, clock, chunksX } = this;
    const cur = this.activeCur;
    const stamp = this.stamp;
    const ltrFrame = (this.frame & 1) === 0;

    for (let y = H - 1; y >= 0; y--) {
      const cy = y >> CHUNK_SHIFT;
      const rowChunk = cy * chunksX;
      const rowBase = y * W;
      const ltr = ltrFrame !== ((y & 1) === 1);
      if (ltr) {
        for (let cx = 0; cx < chunksX; cx++) {
          if (!cur[rowChunk + cx]) continue;
          const x0 = cx << CHUNK_SHIFT;
          const x1 = Math.min(x0 + CHUNK, W);
          for (let x = x0; x < x1; x++) {
            const i = rowBase + x;
            const id = species[i];
            if (id <= E.WALL || clock[i] === stamp) continue;
            this.updateCell(i, x, y, id);
          }
        }
      } else {
        for (let cx = chunksX - 1; cx >= 0; cx--) {
          if (!cur[rowChunk + cx]) continue;
          const x0 = cx << CHUNK_SHIFT;
          const x1 = Math.min(x0 + CHUNK, W);
          for (let x = x1 - 1; x >= x0; x--) {
            const i = rowBase + x;
            const id = species[i];
            if (id <= E.WALL || clock[i] === stamp) continue;
            this.updateCell(i, x, y, id);
          }
        }
      }
    }
  }

  private updateCell(i: number, x: number, y: number, id: number): void {
    // ballistic grains fly instead of falling (explosion debris, cannon shots)
    if ((this.vx8[i] | this.vy8[i]) !== 0) {
      this.doBallistic(i, x, y, id);
      return;
    }
    // mobile heat/cold sources drive the temperature field from their behavior
    if (HEAT_PUMP[id] > 0) this.pumpHeat(x, y, TEMP0[id], HEAT_PUMP[id]);
    // contact reaction (data-driven table): scan the 4-neighborhood for the
    // first reactive partner, starting at a random side so symmetric contacts
    // stay unbiased. A blind single-neighbor roll let static interfaces go to
    // sleep between misses and stall slow reactions forever (found via the
    // M4.5 chemistry set). Inert elements skip everything — the fast path.
    // Sparks never drive the roll: a reacting spark returns before doSpark and
    // pins at a liquid surface forever — the liquid's own scan electrolyzes.
    if (HAS_REACT[id] && BEHAVIOR[id] !== B.SPARK) {
      const rk = this.rng.int(4);
      for (let s = 0; s < 4; s++) {
        const k = (rk + s) & 3;
        const rdx = k === 0 ? 1 : k === 1 ? -1 : 0;
        const rdy = k === 2 ? 1 : k === 3 ? -1 : 0;
        const rx = x + rdx;
        const ry = y + rdy;
        if (rx < 0 || ry < 0 || rx >= this.W || ry >= this.H) continue;
        const j = ry * this.W + rx;
        const r = REACT[id * N_IDS + this.species[j]];
        if (r === 0) continue;
        if (this.rng.byte() < r >>> 16) {
          const pb = this.species[j];
          const pk = id < pb ? id * N_IDS + pb : pb * N_IDS + id;
          REACT_COUNT[pk]++;
          const gi = (y >> WSHIFT) * this.WX + (x >> WSHIFT);
          if (this.glow[gi] < 4) this.glow[gi] += 1;
          this.glowTicks = 240;
          // thermochemistry: exo/endothermic reactions drive the heat field
          const dT = REACT_DT[pk];
          if (dT !== 0) {
            const tx = x >> TSHIFT;
            const ty = y >> TSHIFT;
            this.temp[ty * this.TW + tx] += dT;
            this.markThermalCoarse(tx, ty);
          }
          const newA = (r >>> 8) & 255;
          const newB = r & 255;
          this.set(i, x, y, newA, LIFE0[newA]);
          this.set(j, rx, ry, newB, LIFE0[newB]);
          return;
        }
        this.wake(x, y); // reactive contact stays awake until it resolves
        break; // one roll per tick
      }
    }
    switch (BEHAVIOR[id]) {
      case B.POWDER: this.doPowder(i, x, y, id); break;
      case B.LIQUID: this.doLiquid(i, x, y, id); break;
      case B.GAS: this.doGas(i, x, y, id); break;
      case B.FIRE: this.doFire(i, x, y); break;
      case B.VINE: this.doVine(i, x, y); break;
      case B.EMITTER: this.doEmitter(i, x, y); break;
      case B.SPARK: this.doSpark(i, x, y); break;
      case B.CLONE: this.doClone(i, x, y); break;
      case B.ANT: this.doAnt(i, x, y); break;
      case B.VIRUS: this.doVirus(i, x, y); break;
      case B.METAL: this.doMetalCool(i, x, y); break;
      case B.SUPERBALL: this.doSuperball(i, x, y); break;
      case B.BIRD: this.doBird(i, x, y); break;
      case B.CLOUD: this.doCloud(i, x, y); break;
      case B.LASER: this.doLaser(i, x, y); break;
      case B.THUNDER: this.doThunder(i, x, y); break;
      case B.ROCKET: this.doRocket(i, x, y); break;
      case B.PUMP: this.doPump(i, x, y); break;
      case B.CANNON: this.doCannon(i, x, y); break;
      case B.DETECTOR: this.doDetector(i, x, y); break;
      case B.VALVE: this.doValve(i, x, y); break;
      case B.FILTER: this.doFilter(i, x, y); break;
      case B.LITMUS: this.doLitmus(i, x, y); break;
    }
  }

  /** litmus indicator: sample the first pH-bearing neighbor into the shade
   *  byte (the shader renders litmus by shade as an indicator ramp), then
   *  fall like any powder */
  private doLitmus(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    for (let k = 0; k < 4; k++) {
      const nx = x + World.DX4[k];
      const ny = y + World.DY4[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const p = PH[species[ny * W + nx]];
      if (p !== 255) {
        if (this.shade[i] !== p) {
          this.shade[i] = p;
          this.wake(x, y);
        }
        break;
      }
    }
    this.doPowder(i, x, y, E.LITMUS);
  }

  /** integrate a flying grain: gravity + drag, walk its velocity vector,
   *  punch through fluids with damping, transfer momentum on hard impact.
   *  Velocity is fixed-point x16; below one cell/tick it hands back to the
   *  normal behavior pass. */
  private doBallistic(i: number, x: number, y: number, id: number): void {
    const b = BEHAVIOR[id];
    if (b !== B.POWDER && b !== B.LIQUID && b !== B.SUPERBALL && b !== B.VIRUS && b !== B.ANT) {
      this.vx8[i] = 0;
      this.vy8[i] = 0;
      return; // static/gas/energy cells don't carry ballistic velocity
    }
    let vx = this.vx8[i];
    let vy = Math.max(-120, Math.min(120, this.vy8[i] + 3)); // gravity
    vx = (vx * 31) >> 5; // light drag (~3%/tick)
    const adx = vx < 0 ? -vx : vx;
    const ady = vy < 0 ? -vy : vy;
    const n = (adx > ady ? adx : ady) >> 4;
    if (n === 0) {
      this.vx8[i] = 0;
      this.vy8[i] = 0;
      this.wake(x, y); // back to normal falling next tick
      return;
    }
    const sx = vx > 0 ? 1 : -1;
    const sy = vy > 0 ? 1 : -1;
    const { W, H, species } = this;
    let cx = x;
    let cy = y;
    let ci = i;
    let err = 0;
    for (let s = 0; s < n; s++) {
      let nx = cx;
      let ny = cy;
      if (adx >= ady) {
        nx += sx;
        err += ady;
        if (err >= adx) { ny += sy; err -= adx; }
      } else {
        ny += sy;
        err += adx;
        if (err >= ady) { nx += sx; err -= ady; }
      }
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
        vx = 0; vy = 0;
        break;
      }
      const j = ny * W + nx;
      const o = species[j];
      const ob = BEHAVIOR[o];
      if (o === E.EMPTY || ob === B.FIRE) {
        // fire is hot air, not an obstacle — debris flies THROUGH the fireball
        this.swap(ci, j, cx, cy, nx, ny);
        ci = j; cx = nx; cy = ny;
        continue;
      }
      if ((ob === B.LIQUID || ob === B.GAS) && DENSITY[id] > DENSITY[o]) {
        // punch through fluid, losing half the speed per cell (splash drag)
        this.swap(ci, j, cx, cy, nx, ny);
        ci = j; cx = nx; cy = ny;
        vx = (vx / 2) | 0;
        vy = (vy / 2) | 0;
        continue;
      }
      // hard impact into a movable target
      if ((ob === B.POWDER || ob === B.SUPERBALL) && (adx > 24 || ady > 24)) {
        const tv = Math.abs(this.vx8[j]) + Math.abs(this.vy8[j]);
        if (tv > 24) {
          // the target is already flying the same blast — hold formation and
          // retry next tick; whole columns launch coherently instead of
          // grinding their momentum away against each other
          break;
        }
        // resting target: spring-chain — hand over most, keep pushing
        this.vx8[j] = (vx * 7 / 8) | 0;
        this.vy8[j] = (vy * 7 / 8) | 0;
        this.wake(nx, ny);
        vx = (vx / 2) | 0;
        vy = (vy / 2) | 0;
      } else {
        vx = 0; vy = 0;
      }
      break;
    }
    this.vx8[ci] = vx;
    this.vy8[ci] = vy;
    this.wake(cx, cy);
  }

  /** sparked cannon: consume one movable cell at the breech (opposite the
   *  aim), launch it from the muzzle at ~5.6 cells/tick */
  private doCannon(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    let sparked = false;
    for (let k = 0; k < 4; k++) {
      const nx = x + World.DX4[k];
      const ny = y + World.DY4[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (species[ny * W + nx] === E.SPARK) { sparked = true; break; }
    }
    if (!sparked) return;
    this.wake(x, y);
    const d = ((this.life[i] + 16) >> 5) & 7; // pen-stroke angle byte -> 8-dir
    const dx = World.OCT_DX[d];
    const dy = World.OCT_DY[d];
    let mx = x + dx;
    let my = y + dy;
    while (mx >= 0 && my >= 0 && mx < W && my < H && species[my * W + mx] === E.CANNON) {
      mx += dx; my += dy;
    }
    if (mx < 0 || my < 0 || mx >= W || my >= H || species[my * W + mx] !== E.EMPTY) return;
    let bx = x - dx;
    let by = y - dy;
    while (bx >= 0 && by >= 0 && bx < W && by < H && species[by * W + bx] === E.CANNON) {
      bx -= dx; by -= dy;
    }
    // breech suction: reach across a small gap so hoppers keep feeding
    let gap = 0;
    while (gap < 4 && bx >= 0 && by >= 0 && bx < W && by < H && species[by * W + bx] === E.EMPTY) {
      bx -= dx; by -= dy; gap++;
    }
    if (bx < 0 || by < 0 || bx >= W || by >= H) return;
    const bi = by * W + bx;
    const load = species[bi];
    const lb = BEHAVIOR[load];
    if (lb !== B.POWDER && lb !== B.LIQUID && lb !== B.SUPERBALL) return;
    const mi = my * W + mx;
    const keepLife = this.life[bi];
    const keepShade = this.shade[bi];
    this.set(mi, mx, my, load, keepLife);
    this.shade[mi] = keepShade;
    this.vx8[mi] = dx * 90;
    this.vy8[mi] = dy * 90 - 4;
    this.set(bi, bx, by, E.EMPTY, 0);
  }

  /** detector: memorizes the first substance that touches it (wires and
   *  devices excluded); afterwards emits free sparks whenever that substance
   *  is in contact — the chemical→electrical sensor */
  private doDetector(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    if (this.life[i] === 0) {
      for (let k = 0; k < 4; k++) {
        const nx = x + World.DX4[k];
        const ny = y + World.DY4[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const o = species[ny * W + nx];
        if (o !== E.EMPTY && o !== E.WALL && o !== E.CLONE && o !== E.FAN &&
            o !== E.DETECTOR && o !== E.METAL && o !== E.SPARK && o !== E.STICK) {
          this.life[i] = o;
          break;
        }
      }
      this.wake(x, y); // stay alert until primed
      return;
    }
    let touching = false;
    for (let k = 0; k < 4; k++) {
      const nx = x + World.DX4[k];
      const ny = y + World.DY4[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (species[ny * W + nx] === this.life[i]) { touching = true; break; }
    }
    if (!touching) return;
    this.wake(x, y);
    if (this.rng.byte() >= 40) return; // pulse rate limit
    for (let k = 0; k < 4; k++) {
      const nx = x + World.DX4[k];
      const ny = y + World.DY4[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (species[j] === E.EMPTY) {
        this.set(j, nx, ny, E.SPARK, LIFE0[E.SPARK]);
        this.shade[j] = this.rng.byte() & 0xfe; // free spark, not wire-born
        return;
      }
    }
  }

  /** valve: solid drop-gate; a spark opens it for 24 ticks, during which
   *  material directly above falls through to the cell below */
  private doValve(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    for (let k = 0; k < 4; k++) {
      const nx = x + World.DX4[k];
      const ny = y + World.DY4[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (species[ny * W + nx] === E.SPARK) { this.life[i] = 24; break; }
    }
    if (this.life[i] === 0) return;
    this.life[i]--;
    this.wake(x, y);
    if (y === 0 || y + 1 >= H) return;
    const above = i - W;
    const below = i + W;
    const o = species[above];
    const ob = BEHAVIOR[o];
    if ((ob === B.POWDER || ob === B.LIQUID || ob === B.SUPERBALL) && species[below] === E.EMPTY) {
      const keepLife = this.life[above];
      const keepShade = this.shade[above];
      this.set(below, x, y + 1, o, keepLife);
      this.shade[below] = keepShade;
      this.set(above, x, y - 1, E.EMPTY, 0);
    }
  }

  /** filter mesh: light gases pass upward, heavy gases (CO2/chlorine) pass
   *  downward; liquids and powders are blocked */
  private doFilter(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    if (y === 0 || y + 1 >= H) return;
    const above = i - W;
    const below = i + W;
    if (BEHAVIOR[species[below]] === B.GAS && species[above] === E.EMPTY) {
      const o = species[below];
      const keepLife = this.life[below];
      const keepShade = this.shade[below];
      this.set(above, x, y - 1, o, keepLife);
      this.shade[above] = keepShade;
      this.set(below, x, y + 1, E.EMPTY, 0);
      return;
    }
    const oa = species[above];
    if ((oa === E.CO2 || oa === E.CHLORINE) && species[below] === E.EMPTY) {
      const keepLife = this.life[above];
      const keepShade = this.shade[above];
      this.set(below, x, y + 1, oa, keepLife);
      this.shade[below] = keepShade;
      this.set(above, x, y - 1, E.EMPTY, 0);
    }
  }

  /** can `id` displace the occupant of cell j by falling into it? */
  private sinksInto(id: number, j: number): boolean {
    const o = this.species[j];
    if (o === E.EMPTY) return true;
    const b = BEHAVIOR[o];
    return (b === B.LIQUID || b === B.GAS) && DENSITY[id] > DENSITY[o];
  }

  private doPowder(i: number, x: number, y: number, id: number): void {
    const { W, H } = this;
    if (this.tryWindPush(i, x, y, 0.35)) return;
    if (id === E.SEED && this.trySprout(i, x, y)) return;
    if (y + 1 >= H) return;
    const below = i + W;
    if (this.sinksInto(id, below)) {
      if (this.species[below] === E.EMPTY || this.rng.byte() < 90) {
        this.swap(i, below, x, y, x, y + 1);
      } else {
        this.wake(x, y);
      }
      return;
    }
    const dir = this.rng.bool() ? 1 : -1;
    for (let k = 0; k < 2; k++) {
      const dx = k === 0 ? dir : -dir;
      const nx = x + dx;
      if (nx < 0 || nx >= W) continue;
      const j = below + dx;
      if (this.sinksInto(id, j) && this.species[i + dx] === E.EMPTY) {
        this.swap(i, j, x, y, nx, y + 1);
        return;
      }
    }
  }

  private doLiquid(i: number, x: number, y: number, id: number): void {
    const { W, H } = this;
    const hyst = HYST[id];
    if (id === E.SOAPY && this.trySoapBubble(i, x, y)) return;
    if (this.tryWindPush(i, x, y, 0.08)) return;
    if (id === E.ACID && this.doCorrode(i, x, y)) return;
    if (id === E.MAGMA) this.hotContact4(x, y);
    if (y + 1 < H) {
      const below = i + W;
      if (this.sinksInto(id, below)) {
        this.swap(i, below, x, y, x, y + 1);
        if (hyst) this.life[below] = 0;
        return;
      }
      const dir = this.rng.bool() ? 1 : -1;
      for (let k = 0; k < 2; k++) {
        const dx = k === 0 ? dir : -dir;
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        if (this.sinksInto(id, below + dx) && this.species[i + dx] === E.EMPTY) {
          this.swap(i, below + dx, x, y, nx, y + 1);
          if (hyst) this.life[below + dx] = 0;
          return;
        }
      }
    }
    // settled-liquid hysteresis: a calm cell stops dispersing and goes to sleep
    if (hyst && this.life[i] > SETTLE) return;
    const disp = DISPERSE[id];
    const dir = this.rng.bool() ? 1 : -1;
    let moved = 0;
    let from = i;
    let fx = x;
    for (let s = 0; s < disp; s++) {
      const nx = fx + dir;
      if (nx < 0 || nx >= W) break;
      const j = from + dir;
      if (this.species[j] !== E.EMPTY) break;
      this.swap(from, j, fx, y, nx, y);
      from = j;
      fx = nx;
      moved++;
    }
    if (moved > 0) {
      if (hyst) this.life[from] = 0;
      return;
    }
    const nx = x - dir;
    if (nx >= 0 && nx < W && this.species[i - dir] === E.EMPTY) {
      this.swap(i, i - dir, x, y, nx, y);
      if (hyst) this.life[i - dir] = 0;
      return;
    }
    // nothing moved: count toward settling, stay briefly awake, then sleep
    if (hyst) {
      if (this.life[i] < 200) this.life[i]++;
      if (this.life[i] <= SETTLE) this.wake(x, y);
    }
  }

  private doGas(i: number, x: number, y: number, id: number): void {
    const { W } = this;
    if (LIFE0[id] > 0) {
      if (this.life[i] === 0) {
        if (id === E.STEAM && this.rng.byte() < 77) {
          this.set(i, x, y, E.WATER, 0);
          this.shade[i] = this.rng.byte();
        } else {
          this.set(i, x, y, E.EMPTY, 0);
        }
        return;
      }
      this.life[i]--;
      this.wake(x, y);
    }
    if (this.tryWindPush(i, x, y, 0.35)) return;
    if (y - 1 >= 0 && this.rng.byte() < 200) {
      const up = i - W;
      const dx = this.rng.int(3) - 1;
      const nx = x + dx;
      if (nx >= 0 && nx < W && this.species[up + dx] === E.EMPTY) {
        this.swap(i, up + dx, x, y, nx, y - 1);
        return;
      }
      if (this.species[up] === E.EMPTY) {
        this.swap(i, up, x, y, x, y - 1);
        return;
      }
    }
    const dir = this.rng.bool() ? 1 : -1;
    const nx = x + dir;
    if (nx >= 0 && nx < W && this.species[i + dir] === E.EMPTY) {
      this.swap(i, i + dir, x, y, nx, y);
    }
  }

  /** ignite/melt scan over 4 neighbors — shared by magma, torch, spark */
  private hotContact4(x: number, y: number): void {
    const { W, H, species } = this;
    for (let k = 0; k < 4; k++) {
      const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
      const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      const o = species[j];
      const fl = FLAMMABLE[o];
      if (fl > 0 && this.rng.byte() < fl) {
        if (o === E.FIREWORKS) this.set(j, nx, ny, E.ROCKET, LIFE0[E.ROCKET] + this.rng.int(16));
        else if (EXPLODE_R[o] > 0) this.explode(nx, ny, EXPLODE_R[o]);
        else {
          this.set(j, nx, ny, E.FIRE, BURNLIFE[o]);
          this.shade[j] = this.rng.byte();
        }
      }
    }
  }

  private doFire(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    if (this.life[i] === 0) {
      this.set(i, x, y, E.EMPTY, 0);
      return;
    }
    this.life[i]--;
    this.wake(x, y);
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        const j = ny * W + nx;
        const o = species[j];
        if (o === E.WATER || o === E.SEAWATER) {
          if (this.rng.byte() < 77) this.set(j, nx, ny, E.STEAM, LIFE0[E.STEAM]);
          this.set(i, x, y, E.EMPTY, 0);
          return;
        }
        const fl = FLAMMABLE[o];
        if (fl > 0 && this.rng.byte() < fl) {
          if (o === E.FIREWORKS) this.set(j, nx, ny, E.ROCKET, LIFE0[E.ROCKET] + this.rng.int(16));
          else if (EXPLODE_R[o] > 0) this.explode(nx, ny, EXPLODE_R[o]);
          else {
            this.set(j, nx, ny, E.FIRE, BURNLIFE[o]);
            this.shade[j] = this.rng.byte();
          }
        }
      }
    }
    if (this.tryWindPush(i, x, y, 0.3)) return;
    if (y - 1 >= 0 && this.rng.byte() < 150) {
      const dx = this.rng.int(3) - 1;
      const nx = x + dx;
      if (nx >= 0 && nx < W && species[i - W + dx] === E.EMPTY) {
        this.swap(i, i - W + dx, x, y, nx, y - 1);
        return;
      }
    }
    // billow smoke: burning things smudge the sky
    if (y - 1 >= 0 && this.rng.byte() < 7 && species[i - W] === E.EMPTY) {
      this.set(i - W, x, y - 1, E.SMOKE, LIFE0[E.SMOKE]);
      this.shade[i - W] = this.rng.byte();
    }
  }

  private doVine(i: number, x: number, y: number): void {
    if (this.life[i] === 0) return;
    if (this.rng.byte() < 40) {
      const dx = this.rng.int(3) - 1;
      const nx = x + dx;
      const ny = y - 1;
      if (nx >= 0 && nx < this.W && ny >= 0) {
        const j = ny * this.W + nx;
        if (this.species[j] === E.EMPTY) {
          this.set(j, nx, ny, E.VINE, this.life[i] - 1);
          this.shade[j] = this.rng.byte();
        } else {
          this.life[i] = 0;
        }
      }
    }
    this.wake(x, y);
  }

  private doEmitter(i: number, x: number, y: number): void {
    this.hotContact4(x, y);
    if (this.rng.byte() < 60) {
      const dx = this.rng.int(3) - 1;
      const nx = x + dx;
      const ny = y - 1;
      if (nx >= 0 && nx < this.W && ny >= 0) {
        const j = ny * this.W + nx;
        if (this.species[j] === E.EMPTY) {
          this.set(j, nx, ny, E.FIRE, LIFE0[E.FIRE]);
          this.shade[j] = this.rng.byte();
        }
      }
    }
    this.wake(x, y); // torches never sleep
  }

  private doSpark(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    this.hotContact4(x, y);
    let metalNear = false;
    for (let k = 0; k < 4; k++) {
      const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
      const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      const o = species[j];
      if (CONDUCTS[o] > 0) {
        metalNear = true;
        // refractory metal (life > 0, still cooling) can't re-spark — keeps the
        // pulse a thin traveling dot instead of saturating the whole wire
        if (this.life[j] === 0 && this.rng.byte() < 250) {
          this.set(j, nx, ny, E.SPARK, LIFE0[E.SPARK]);
          // wire-born + remember WHICH conductor this cell restores to
          this.shade[j] = (this.rng.byte() & 0xf8) | 1 | (CONDUCT_IDX[o] << 1);
        }
      } else if (o === E.SPARK) metalNear = true;
    }
    if (this.life[i] === 0) {
      // only wire-born sparks restore to their conductor — a free spark that
      // dies next to a wire must not weld a stub onto it (entombs pulsers)
      const wireborn = metalNear && (this.shade[i] & 1) === 1;
      if (wireborn) {
        const cid = CONDUCTOR_IDS[(this.shade[i] >> 1) & 3];
        this.set(i, x, y, cid, CONDUCTS[cid]);
      } else {
        this.set(i, x, y, E.EMPTY, 0);
      }
      return;
    }
    this.life[i]--;
    this.wake(x, y);
  }

  private doClone(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    if (this.life[i] === 0) {
      // memorize the first touching element
      for (let k = 0; k < 4; k++) {
        const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
        const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const o = species[ny * W + nx];
        if (o !== E.EMPTY && o !== E.WALL && o !== E.CLONE && o !== E.FAN) {
          this.life[i] = o;
          break;
        }
      }
    } else if (this.rng.byte() < 40) {
      const k = this.rng.int(4);
      const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
      const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
        const j = ny * W + nx;
        if (species[j] === E.EMPTY) {
          const cid = this.life[i];
          this.set(j, nx, ny, cid, LIFE0[cid]);
          this.shade[j] = cid === E.SPARK ? this.rng.byte() & 0xfe : this.rng.byte();
        }
      }
    }
    this.wake(x, y); // clones never sleep
  }

  private doAnt(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    // gravity first
    if (y + 1 < H && species[i + W] === E.EMPTY) {
      this.swap(i, i + W, x, y, x, y + 1);
      return;
    }
    let dir = this.life[i] === 1 ? 1 : -1;
    if (this.rng.byte() < 12) {
      dir = -dir;
      this.life[i] = dir === 1 ? 1 : 0;
    }
    const digInto = (j: number, nx: number, ny: number): boolean => {
      const o = species[j];
      if (o === E.EMPTY) {
        this.swap(i, j, x, y, nx, ny);
        return true;
      }
      if (BEHAVIOR[o] === B.POWDER && o !== E.ANT) {
        // tunnel: consume the grain, leave a gap behind
        this.set(j, nx, ny, E.ANT, this.life[i]);
        this.shade[j] = this.shade[i];
        this.set(i, x, y, E.EMPTY, 0);
        return true;
      }
      return false;
    };
    const nx = x + dir;
    if (nx >= 0 && nx < W) {
      // occasionally dig downward, else walk/dig ahead, else climb
      if (y + 1 < H && this.rng.byte() < 25 && digInto(i + W + dir, nx, y + 1)) return;
      if (digInto(i + dir, nx, y)) return;
      if (y - 1 >= 0 && digInto(i - W + dir, nx, y - 1)) return;
    }
    this.life[i] = this.life[i] === 1 ? 0 : 1; // blocked: turn around
    this.wake(x, y);
  }

  private doVirus(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    if (this.life[i] === 0) {
      this.set(i, x, y, E.EMPTY, 0);
      return;
    }
    this.life[i]--;
    const k = this.rng.int(4);
    const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
    const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
      const j = ny * W + nx;
      const o = species[j];
      if (o !== E.EMPTY && o !== E.WALL && o !== E.VIRUS && o !== E.CLONE && o !== E.FAN && this.rng.byte() < 50) {
        this.set(j, nx, ny, E.VIRUS, LIFE0[E.VIRUS]);
        this.shade[j] = this.rng.byte();
      }
    }
    this.wake(x, y);
    // falls like powder
    if (y + 1 < H && this.sinksInto(E.VIRUS, i + W)) {
      this.swap(i, i + W, x, y, x, y + 1);
    }
  }

  private trySprout(i: number, x: number, y: number): boolean {
    const { W, H, species } = this;
    const dirs = [i + W, i - W, i - 1, i + 1];
    const dxs = [0, 0, -1, 1];
    const dys = [1, -1, 0, 0];
    for (let k = 0; k < 4; k++) {
      const nx = x + dxs[k];
      const ny = y + dys[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (species[dirs[k]] === E.WATER) {
        this.set(dirs[k], nx, ny, E.EMPTY, 0);
        this.set(i, x, y, E.VINE, LIFE0[E.VINE]);
        return true;
      }
    }
    return false;
  }

  private doCorrode(i: number, x: number, y: number): boolean {
    if (this.life[i] === 0) {
      this.set(i, x, y, E.EMPTY, 0);
      return true;
    }
    const k = this.rng.int(4);
    const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
    const dy = k === 2 ? 1 : k === 3 ? -1 : 0;
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) return false;
    const j = ny * this.W + nx;
    const o = this.species[j];
    // the water family is corrosion-proof so neutralization products survive,
    // and gases bubble through acid unharmed (CO2/chlorine are liquid-encoded)
    if (o === E.WATER || o === E.SEAWATER || o === E.SALT) return false;
    if (o === E.SALTPETER) return false; // nitrate salt resists its own acid
    if (BEHAVIOR[o] === B.GAS || o === E.CO2 || o === E.CHLORINE) return false;
    if (o === E.LITMUS) return false; // the instrument survives to show pH 1
    if (o === E.GOLD || o === E.COPPER || o === E.TUNGSTEN) return false; // noble
    // MgO dissolving in acid IS the antacid reaction — let the REACT row do it
    // (salt + water, acid consumed) instead of corrosion deleting the powder
    if (o === E.MAGNESIA) return false;
    // same rule for the lime family: dissolving in acid IS their REACT row
    // (salt + water / marble fizz, acid consumed) — not free corrosion
    if (o === E.LIME || o === E.LIMESTONE) return false;
    if (o !== E.EMPTY && o !== E.WALL && o !== E.ACID && o !== E.FIRE && this.rng.byte() < 60) {
      this.set(j, nx, ny, E.EMPTY, 0);
      this.life[i]--;
      this.wake(x, y);
      return true;
    }
    return false;
  }

  /** PG rule: soapy hit by a strong wind turns into a bubble (object) */
  private trySoapBubble(i: number, x: number, y: number): boolean {
    const wi = (y >> WSHIFT) * this.WX + (x >> WSHIFT);
    const m = Math.abs(this.vx[wi]) + Math.abs(this.vy[wi]);
    if (m < 2.5 || this.bubbleQueue.length >= 32) return false;
    if (this.rng.byte() >= 10) return false;
    this.set(i, x, y, E.EMPTY, 0);
    this.bubbleQueue.push(i);
    return true;
  }

  /** metal cooling after a spark passed — refractory period, then conductive again */
  private doMetalCool(i: number, x: number, y: number): void {
    if (this.life[i] > 0) {
      this.life[i]--;
      this.wake(x, y);
    }
    // waterline corrosion: needs BOTH seawater and air — submerged electrodes
    // and tank bottoms are safe, the splash zone slowly crumbles. Iron rusts,
    // copper patinas green; gold and tungsten never corrode.
    const me = this.species[i];
    const corrodesTo = me === E.METAL ? E.RUST : me === E.COPPER ? E.VERDIGRIS : 0;
    if (corrodesTo !== 0 && this.rng.byte() < 3) {
      const { W, H, species } = this;
      let sea = false;
      let air = false;
      for (let k = 0; k < 4; k++) {
        const nx = x + World.DX4[k];
        const ny = y + World.DY4[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const o = species[ny * W + nx];
        if (o === E.SEAWATER) sea = true;
        else if (o === E.EMPTY) air = true;
      }
      if (sea && air && this.rng.byte() < 24) {
        this.set(i, x, y, corrodesTo, 0);
        this.shade[i] = this.rng.byte();
      }
    }
  }

  private doSuperball(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    if (this.life[i] > 0) {
      // rising phase of a bounce
      this.life[i]--;
      if (y - 1 >= 0 && species[i - W] === E.EMPTY) {
        this.swap(i, i - W, x, y, x, y - 1);
      } else {
        this.life[i] = 0;
      }
      this.wake(x, y);
      return;
    }
    if (y + 1 >= H) {
      this.life[i] = 8 + this.rng.int(8);
      this.wake(x, y);
      return;
    }
    const below = i + W;
    if (this.sinksInto(E.SUPERBALL, below)) {
      this.swap(i, below, x, y, x, y + 1);
      return;
    }
    if (BEHAVIOR[species[below]] !== B.GAS) {
      this.life[i] = 8 + this.rng.int(8); // landed: bounce back up
      this.wake(x, y);
    }
  }

  private doBird(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    this.wake(x, y); // birds never sleep
    let dirx = (this.life[i] & 1) === 1 ? 1 : -1;
    if (this.rng.byte() < 8) {
      dirx = -dirx;
      this.life[i] ^= 1;
    }
    let dy = this.rng.int(3) - 1;
    // ground avoidance: climb when something solid is within 2 cells below
    const nearGround =
      (y + 1 < H && species[i + W] !== E.EMPTY) || (y + 2 < H && species[i + 2 * W] !== E.EMPTY);
    if (nearGround) dy = -1;
    const nx = x + dirx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < W && ny < H && species[ny * W + nx] === E.EMPTY) {
      this.swap(i, ny * W + nx, x, y, nx, ny);
      return;
    }
    if (nx >= 0 && nx < W && species[i + dirx] === E.EMPTY) {
      this.swap(i, i + dirx, x, y, nx, y);
      return;
    }
    this.life[i] ^= 1; // blocked: turn around
  }

  private doCloud(i: number, x: number, y: number): void {
    // floats in place; occasionally rains itself out
    if (this.rng.byte() < 3 && y + 1 < this.H) {
      const below = i + this.W;
      if (this.species[below] === E.EMPTY) {
        this.set(below, x, y + 1, E.WATER, 0);
        this.shade[below] = this.rng.byte();
        if (this.rng.byte() < 80) {
          this.set(i, x, y, E.EMPTY, 0);
          return;
        }
      }
    }
    this.wake(x, y);
  }

  private static readonly OCT_DX = [1, 1, 0, -1, -1, -1, 0, 1];
  private static readonly OCT_DY = [0, 1, 1, 1, 0, -1, -1, -1];

  /** life packs direction in bits 5-7; beams fly until they hit or leave the grid */
  private doLaser(i: number, x: number, y: number): void {
    const lf = this.life[i];
    const d = lf >>> 5;
    const dx = World.OCT_DX[d];
    const dy = World.OCT_DY[d];
    let cx = x;
    let cy = y;
    let ci = i;
    this.set(ci, cx, cy, E.EMPTY, 0);
    for (let hop = 0; hop < 3; hop++) {
      let nx = cx + dx;
      let ny = cy + dy;
      // glass is transparent to lasers
      while (nx >= 0 && ny >= 0 && nx < this.W && ny < this.H && this.species[ny * this.W + nx] === E.GLASS) {
        nx += dx;
        ny += dy;
      }
      if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) return;
      const j = ny * this.W + nx;
      const o = this.species[j];
      if (o === E.EMPTY) {
        cx = nx;
        cy = ny;
        ci = j;
        continue;
      }
      if (o === E.FIREWORKS) this.set(j, nx, ny, E.ROCKET, LIFE0[E.ROCKET] + this.rng.int(16));
      else if (EXPLODE_R[o] > 0) this.explode(nx, ny, EXPLODE_R[o]);
      else if (FLAMMABLE[o] > 0) this.set(j, nx, ny, E.FIRE, BURNLIFE[o]);
      else this.pumpHeat(nx, ny, 900, 0.5); // laser heat melts/boils via the field
      return; // hit something: beam ends
    }
    this.set(ci, cx, cy, E.LASER, lf);
  }

  private doThunder(i: number, x: number, y: number): void {
    let cy = y;
    let ci = i;
    this.set(ci, x, cy, E.EMPTY, 0);
    for (let s = 0; s < 6; s++) {
      if (cy + 1 >= this.H) return; // grounded off-screen
      const j = ci + this.W;
      const o = this.species[j];
      if (o === E.EMPTY) {
        ci = j;
        cy++;
        continue;
      }
      if (CONDUCTS[o] > 0) {
        this.set(j, x, cy + 1, E.SPARK, LIFE0[E.SPARK]);
        this.shade[j] = (this.shade[j] & 0xf8) | 1 | (CONDUCT_IDX[o] << 1);
      } else this.explode(x, cy + 1, 4);
      return;
    }
    this.set(ci, x, cy, E.THUNDER, 0);
  }

  private doRocket(i: number, x: number, y: number): void {
    this.wake(x, y);
    if (this.life[i] === 0 || y - 1 < 0) {
      this.explode(x, y, 6);
      return;
    }
    this.life[i]--;
    const dx = this.rng.int(3) - 1;
    const nx = x + dx;
    const j = (y - 1) * this.W + nx;
    if (nx >= 0 && nx < this.W && this.species[j] === E.EMPTY) {
      this.swap(i, j, x, y, nx, y - 1);
      if (this.rng.byte() < 150) {
        this.set(i, x, y, E.FIRE, 12 + this.rng.int(10));
        this.shade[i] = this.rng.byte();
      }
      return;
    }
    if (this.species[i - this.W] !== E.EMPTY) this.explode(x, y, 6); // nose blocked
  }

  private static readonly DX4 = [1, -1, 0, 0];
  private static readonly DY4 = [0, 0, 1, -1];
  private static readonly OPP4 = [1, 0, 3, 2];
  // hop preference per travel direction: straight, the two perpendiculars, back
  private static readonly PREF4 = [
    [0, 2, 3, 1],
    [1, 2, 3, 0],
    [2, 0, 1, 3],
    [3, 0, 1, 2],
  ];

  /** pump: life holds the carried species (full byte — ids can exceed 63);
   *  the travel direction lives in the shade byte's low 2 bits (a ±3/255 tint,
   *  invisible). Adjacent liquids/gases are absorbed; the token walks the pump
   *  line with momentum (one hop per tick) and ejects where the line ends —
   *  one clear dot beyond the pump so it can't instantly re-enter. */
  private doPump(i: number, x: number, y: number): void {
    const { W, H, species } = this;
    const carried = this.life[i];
    if (carried === 0) {
      for (let k = 0; k < 4; k++) {
        const nx = x + World.DX4[k];
        const ny = y + World.DY4[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        const b = BEHAVIOR[species[j]];
        if (b === B.LIQUID || b === B.GAS) {
          this.life[i] = species[j];
          this.shade[i] = (this.shade[i] & 0xfc) | World.OPP4[k];
          this.set(j, nx, ny, E.EMPTY, 0);
          this.wake(x, y);
          return;
        }
      }
      return; // idle pump: its chunk may sleep
    }
    const pref = World.PREF4[this.shade[i] & 3];
    for (let p = 0; p < 4; p++) {
      const d = pref[p];
      const nx = x + World.DX4[d];
      const ny = y + World.DY4[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (species[j] === E.PUMP && this.life[j] === 0) {
        this.life[j] = carried;
        this.shade[j] = (this.shade[j] & 0xfc) | d;
        this.life[i] = 0;
        this.clock[j] = this.stamp; // one hop per tick
        this.wake(nx, ny);
        this.wake(x, y);
        return;
      }
    }
    // line ends here: eject into the world, preferring the travel direction
    for (let p = 0; p < 4; p++) {
      const d = pref[p];
      const dx = World.DX4[d];
      const dy = World.DY4[d];
      const n1x = x + dx;
      const n1y = y + dy;
      if (n1x < 0 || n1y < 0 || n1x >= W || n1y >= H) continue;
      if (species[n1y * W + n1x] !== E.EMPTY) continue;
      const n2x = n1x + dx;
      const n2y = n1y + dy;
      const far = n2x >= 0 && n2y >= 0 && n2x < W && n2y < H && species[n2y * W + n2x] === E.EMPTY;
      const ex = far ? n2x : n1x;
      const ey = far ? n2y : n1y;
      const j = ey * W + ex;
      this.set(j, ex, ey, carried, LIFE0[carried]);
      this.shade[j] = this.rng.byte();
      this.life[i] = 0;
      this.wake(x, y);
      return;
    }
    this.wake(x, y); // stuck holding fluid: stay awake until space frees up
  }

  // ---- save / load -------------------------------------------------------

  /** RLE snapshot of species+life (shade regenerates on load) */
  serialize(): Uint8Array {
    const rle = (arr: Uint8Array): number[] => {
      const out: number[] = [];
      let v = arr[0];
      let run = 1;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] === v && run < 65535) run++;
        else {
          out.push(v, run & 255, run >> 8);
          v = arr[i];
          run = 1;
        }
      }
      out.push(v, run & 255, run >> 8);
      return out;
    };
    const s = rle(this.species);
    const l = rle(this.life);
    const buf = new Uint8Array(12 + s.length + l.length);
    buf.set([0x47, 0x52, 0x4e, 0x31]); // "GRN1"
    buf[4] = this.W & 255; buf[5] = this.W >> 8;
    buf[6] = this.H & 255; buf[7] = this.H >> 8;
    buf[8] = s.length & 255; buf[9] = (s.length >> 8) & 255;
    buf[10] = (s.length >> 16) & 255; buf[11] = (s.length >> 24) & 255;
    buf.set(s, 12);
    buf.set(l, 12 + s.length);
    return buf;
  }

  deserialize(buf: Uint8Array): boolean {
    if (buf[0] !== 0x47 || buf[1] !== 0x52 || buf[2] !== 0x4e || buf[3] !== 0x31) return false;
    if ((buf[4] | (buf[5] << 8)) !== this.W || (buf[6] | (buf[7] << 8)) !== this.H) return false;
    const sLen = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
    const unrle = (from: number, to: number, target: Uint8Array): void => {
      let w = 0;
      for (let p = from; p < to; p += 3) {
        const v = buf[p];
        const run = buf[p + 1] | (buf[p + 2] << 8);
        target.fill(v, w, w + run);
        w += run;
      }
    };
    unrle(12, 12 + sLen, this.species);
    unrle(12 + sLen, buf.length, this.life);
    this.clock.fill(0);
    this.vx8.fill(0);
    this.vy8.fill(0);
    this.press.fill(0);
    this.pgas.fill(0);
    this.pressTicks = 0;
    this.activeCur.fill(1);
    this.activeNext.fill(1);
    this.fans.length = 0;
    this.dots = 0;
    this.temp.fill(AMBIENT);
    this.thermalCur.fill(0);
    this.thermalNext.fill(0);
    this.gasDots = 0;
    for (let i = 0; i < this.species.length; i++) {
      const id = this.species[i];
      if (id !== E.EMPTY) this.shade[i] = this.rng.byte();
      if (id !== E.EMPTY && id !== E.WALL) this.dots++;
      if (PRESSURIZES[id] !== 0) {
        this.gasDots++;
        this.pgas[(((i / this.W) | 0) >> WSHIFT) * this.WX + ((i % this.W) >> WSHIFT)]++;
      }
      if (id === E.FAN && this.fans.length < 8192) this.fans.push(i);
      if (HEAT_PUMP[id] > 0) {
        this.pumpHeat(i % this.W, (i / this.W) | 0, TEMP0[id], 0.6);
      }
    }
    return true;
  }

  /** straight line from the blast center, walls block — this is what makes a
   *  wall barrel a CANNON: the pressure only travels up the open bore */
  losClear(x0: number, y0: number, x1: number, y1: number): boolean {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    while (x !== x1 || y !== y1) {
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (this.species[y * this.W + x] === E.WALL && !(x === x1 && y === y1)) return false;
    }
    return true;
  }

  private static blastStack = new Int32Array(8192);

  /** consume the whole CONNECTED explosive charge at the blast site and
   *  return its yield — one keg, one unified boom. Mass makes the bang. */
  private coalesceCharge(cx: number, cy: number): number {
    const { W, H, species } = this;
    const start = cy * W + cx;
    if (EXPLODE_R[species[start]] === 0) return 0;
    const stack = World.blastStack;
    let sp = 0;
    let yieldSum = 0;
    stack[sp++] = start;
    let pops = 0;
    while (sp > 0 && pops < 4000) {
      const i = stack[--sp];
      const id = species[i];
      if (EXPLODE_R[id] === 0) continue;
      pops++;
      yieldSum += EXPLODE_R[id];
      const x = i % W;
      const y = (i / W) | 0;
      this.set(i, x, y, E.EMPTY, 0); // consumed as propellant (marks visited)
      if (x + 1 < W && sp < 8188) stack[sp++] = i + 1;
      if (x > 0 && sp < 8188) stack[sp++] = i - 1;
      if (y + 1 < H && sp < 8188) stack[sp++] = i + W;
      if (y > 0 && sp < 8188) stack[sp++] = i - W;
    }
    return yieldSum;
  }

  private explode(cx: number, cy: number, r: number): void {
    const { W, H } = this;
    // the bigger the charge, the bigger the boom: connected explosive mass
    // scales the blast radius (sqrt law), up to a screen-shaking cap
    const charge = this.coalesceCharge(cx, cy);
    if (charge > 0) r = Math.min(46, r + Math.floor(Math.sqrt(charge) * 0.9));
    if (r > this.fxPower) this.fxPower = r;
    if (this.blastQueue.length < 96) this.blastQueue.push(cx, cy, r);
    // blast overpressure: sealed rooms near the boom blow their windows
    {
      const pw = Math.min(6, 2 + r * 0.35);
      const wr = Math.max(1, r >> WSHIFT);
      const wcx = cx >> WSHIFT;
      const wcy = cy >> WSHIFT;
      for (let wy = wcy - wr; wy <= wcy + wr; wy++) {
        if (wy < 0 || wy >= this.WY) continue;
        for (let wx = wcx - wr; wx <= wcx + wr; wx++) {
          if (wx < 0 || wx >= this.WX) continue;
          const wi = wy * this.WX + wx;
          if (this.press[wi] < pw) this.press[wi] = pw;
        }
      }
      this.pressTicks = Math.max(this.pressTicks, 60);
    }
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        const o = this.species[i];
        if (o === E.WALL) continue;
        if (!this.losClear(cx, cy, x, y)) continue; // shielded by walls
        // heavy rubble and solid metal mostly survive the fireball — blasts
        // mangle metal, they don't vaporize it (gold statues outlive sieges)
        const tough = (BEHAVIOR[o] === B.POWDER && DENSITY[o] >= 70) || BEHAVIOR[o] === B.METAL;
        if (this.rng.byte() < (tough ? 45 : 200)) {
          this.set(i, x, y, E.FIRE, 10 + this.rng.int(30));
          this.shade[i] = this.rng.byte();
        }
      }
    }
    // debris shockwave: movable material near the blast is thrown outward in
    // ballistic arcs (the fire core above already consumed most of the inside)
    const R2 = r * 2 + 4;
    const r2out = R2 * R2;
    for (let dy = -R2; dy <= R2; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -R2; dx <= R2; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2out || d2 === 0) continue;
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        const i = y * W + x;
        const b = BEHAVIOR[this.species[i]];
        if (b !== B.POWDER && b !== B.LIQUID && b !== B.SUPERBALL) continue;
        if (!this.losClear(cx, cy, x, y)) continue; // walls shield the debris too
        const d = Math.sqrt(d2);
        const mag = 170 * (1 - d / R2) + 22; // up to ~12 cells/tick at the core
        this.vx8[i] = Math.max(-126, Math.min(126, ((dx / d) * mag) | 0));
        this.vy8[i] = Math.max(-126, Math.min(126, (((dy / d) * mag) | 0) - 22)); // loft
        this.wake(x, y);
      }
    }
    // heat flash
    const tr = (r >> TSHIFT) + 2;
    const tcx = cx >> TSHIFT;
    const tcy = cy >> TSHIFT;
    for (let dy = -tr; dy <= tr; dy++) {
      const ty = tcy + dy;
      if (ty < 0 || ty >= this.TH) continue;
      for (let dx = -tr; dx <= tr; dx++) {
        const tx = tcx + dx;
        if (tx < 0 || tx >= this.TW) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > tr) continue;
        this.temp[ty * this.TW + tx] += 260 * (1 - d / tr);
        this.markThermalCoarse(tx, ty);
      }
    }
    // radial wind impulse
    this.windTicks = 240;
    const rw = (r >> WSHIFT) + 2;
    const wcx = cx >> WSHIFT;
    const wcy = cy >> WSHIFT;
    for (let dy = -rw; dy <= rw; dy++) {
      const wy = wcy + dy;
      if (wy < 0 || wy >= this.WY) continue;
      for (let dx = -rw; dx <= rw; dx++) {
        const wx = wcx + dx;
        if (wx < 0 || wx >= this.WX) continue;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d > rw) continue;
        const s = (9 * (1 - d / rw)) / d;
        const wi = wy * this.WX + wx;
        this.vx[wi] = Math.max(-8, Math.min(8, this.vx[wi] + dx * s));
        this.vy[wi] = Math.max(-8, Math.min(8, this.vy[wi] + dy * s));
      }
    }
  }

  clear(): void {
    this.species.fill(0);
    this.shade.fill(0);
    this.life.fill(0);
    this.clock.fill(0);
    this.vx8.fill(0);
    this.vy8.fill(0);
    this.activeCur.fill(1);
    this.activeNext.fill(1);
    this.vx.fill(0);
    this.vy.fill(0);
    this.glow.fill(0);
    this.press.fill(0);
    this.pgas.fill(0);
    this.pressTicks = 0;
    this.gasDots = 0;
    this.temp.fill(AMBIENT);
    this.thermalCur.fill(0);
    this.thermalNext.fill(0);
    this.fans.length = 0;
    this.blastQueue.length = 0;
    this.dots = 0;
  }
}
