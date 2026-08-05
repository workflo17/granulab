// Rigid objects (ball / box / wheel), Powder-Game style: each entity stamps its
// footprint into the grid as static cells every tick, so powders pile on top and
// the sim treats them as obstacles; the entity itself collides against cells.

import { E, B, BEHAVIOR } from "./elements";
import type { World } from "./world";

export type ObjKind = "ball" | "box" | "wheel" | "bubble";

const KIND_ID: Record<ObjKind, number> = { ball: E.BALL, box: E.BOX, wheel: E.WHEEL, bubble: E.BUBBLE };
const ID_KIND: Record<number, ObjKind> = { [E.BALL]: "ball", [E.BOX]: "box", [E.WHEEL]: "wheel", [E.BUBBLE]: "bubble" };
const KIND_R: Record<ObjKind, number> = { ball: 7, box: 8, wheel: 9, bubble: 4 };
const REST: Record<ObjKind, number> = { ball: 0.72, box: 0.05, wheel: 0.3, bubble: 0 };
const FRICTION: Record<ObjKind, number> = { ball: 0.996, box: 0.86, wheel: 0.999, bubble: 1 };
const BUOY: Record<ObjKind, number> = { ball: 0.4, box: 0.26, wheel: 0.1, bubble: 0 };
const MAX_OBJECTS = 64;

export class RigidObject {
  vx = 0;
  vy = 0;
  angle = 0; // wheels: rolling rotation, drawn as spokes
  constructor(public kind: ObjKind, public x: number, public y: number) {}
  get r(): number { return KIND_R[this.kind]; }
  get id(): number { return KIND_ID[this.kind]; }
}

const passable = (id: number): boolean => {
  if (id === E.EMPTY) return true;
  const b = BEHAVIOR[id];
  return b === B.LIQUID || b === B.GAS || b === B.FIRE || b === B.LASER ||
    b === B.THUNDER || b === B.ROCKET || b === B.CLOUD || b === B.BIRD;
};

export class ObjectSystem {
  list: RigidObject[] = [];

  constructor(private world: World) {}

  spawnId(id: number, x: number, y: number): void {
    const kind = ID_KIND[id];
    if (kind) this.spawn(kind, x, y);
  }

  spawn(kind: ObjKind, x: number, y: number): void {
    if (this.list.length >= MAX_OBJECTS) return;
    const r = KIND_R[kind];
    const o = new RigidObject(
      kind,
      Math.max(r, Math.min(this.world.W - 1 - r, x)),
      Math.max(r, Math.min(this.world.H - 1 - r, y)),
    );
    this.list.push(o);
    this.stamp(o);
  }

  /** eraser support: remove the object covering (x, y), if any */
  removeAt(x: number, y: number): boolean {
    for (let k = 0; k < this.list.length; k++) {
      const o = this.list[k];
      const dx = x - o.x;
      const dy = y - o.y;
      if (dx * dx + dy * dy <= (o.r + 2) * (o.r + 2)) {
        this.unstamp(o);
        this.list.splice(k, 1);
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.list.length = 0; // world.clear() wipes the footprints
  }

  private cells(o: RigidObject, cb: (cx: number, cy: number) => void): void {
    const r = o.r;
    const x0 = Math.round(o.x);
    const y0 = Math.round(o.y);
    const box = o.kind === "box";
    const r2 = r * r;
    // bubbles are a hollow ring, not a filled disc
    const inner = o.kind === "bubble" ? (r - 1.6) * (r - 1.6) : 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (box || (d2 <= r2 && d2 >= inner)) cb(x0 + dx, y0 + dy);
      }
    }
  }

  private stamp(o: RigidObject): void {
    const w = this.world;
    const wheel = o.kind === "wheel";
    // (balls get a rolling marker in the same pass)
    const x0 = Math.round(o.x);
    const y0 = Math.round(o.y);
    this.cells(o, (cx, cy) => {
      if (cx >= 0 && cy >= 0 && cx < w.W && cy < w.H && w.species[cy * w.W + cx] === E.EMPTY) {
        let shade = 150 + ((cx * 3 + cy * 5) & 63);
        if (wheel) {
          // four rolling spokes + a bright rim so the spin reads
          const dx = cx - x0;
          const dy = cy - y0;
          const rr = dx * dx + dy * dy;
          if (rr >= (o.r - 1.5) * (o.r - 1.5)) shade = 210;
          else if (Math.abs(Math.sin(Math.atan2(dy, dx) * 2 + o.angle)) < 0.3) shade = 96;
          else shade = 170;
        } else if (o.kind === "ball") {
          // one dark marker dot that travels with the rotation
          const mx = x0 + Math.cos(o.angle) * (o.r - 2.5);
          const my = y0 + Math.sin(o.angle) * (o.r - 2.5);
          const dd = (cx - mx) * (cx - mx) + (cy - my) * (cy - my);
          if (dd < 2.6) shade = 92;
        }
        w.rawSet(cx, cy, o.id, shade);
      }
    });
  }

  private unstamp(o: RigidObject): void {
    const w = this.world;
    this.cells(o, (cx, cy) => {
      if (cx >= 0 && cy >= 0 && cx < w.W && cy < w.H && w.species[cy * w.W + cx] === o.id) {
        w.rawSet(cx, cy, E.EMPTY);
      }
    });
  }

  /** first solid row at column px scanning down from fromY (slope sensing) */
  private groundY(px: number, fromY: number): number {
    const w = this.world;
    const x = Math.round(px);
    if (x < 0 || x >= w.W) return Math.round(fromY);
    const y0 = Math.max(0, Math.round(fromY));
    const y1 = Math.min(w.H - 1, y0 + 24);
    for (let y = y0; y <= y1; y++) {
      if (!passable(w.species[y * w.W + x])) return y;
    }
    return y1 + 1;
  }

  /** boundary-sample collision test at a candidate center */
  private collides(o: RigidObject, nx: number, ny: number): boolean {
    const w = this.world;
    const r = o.r;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      let px: number;
      let py: number;
      if (o.kind === "box") {
        px = Math.round(nx + Math.max(-r, Math.min(r, Math.cos(a) * r * 1.5)));
        py = Math.round(ny + Math.max(-r, Math.min(r, Math.sin(a) * r * 1.5)));
      } else {
        px = Math.round(nx + Math.cos(a) * r);
        py = Math.round(ny + Math.sin(a) * r);
      }
      if (px < 0 || py < 0 || px >= w.W || py >= w.H) return true;
      if (!passable(w.species[py * w.W + px])) return true;
    }
    return false;
  }

  update(): void {
    const w = this.world;
    // soapy whipped off by wind becomes real bubbles — capped so a geyser
    // can't starve the shared object budget (balls/boxes/wheels)
    const q = w.bubbleQueue;
    let nb = 0;
    for (const o of this.list) if (o.kind === "bubble") nb++;
    for (let k = 0; k < q.length && nb < 24; k++, nb++) {
      this.spawn("bubble", q[k] % w.W, (q[k] / w.W) | 0);
    }
    q.length = 0;
    // blast impulses: explosions launch rigid objects (the cannonball rule);
    // walls shield — a ball beside a barrel doesn't feel the charge inside
    const bq = w.blastQueue;
    for (let k = 0; k < bq.length; k += 3) {
      const bx = bq[k];
      const by = bq[k + 1];
      const R = bq[k + 2] * 2 + 4;
      for (const o of this.list) {
        if (o.kind === "bubble") continue;
        const dx = o.x - bx;
        const dy = o.y - by;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d > R) continue;
        if (!w.losClear(bx, by, Math.round(o.x), Math.round(o.y))) continue;
        const imp = 16 * (1 - d / R);
        o.vx += (dx / d) * imp;
        o.vy += (dy / d) * imp - 2; // loft
      }
    }
    bq.length = 0;
    // object-object impulses (all treated as circles)
    for (let a = 0; a < this.list.length; a++) {
      for (let b = a + 1; b < this.list.length; b++) {
        const A = this.list[a];
        const B = this.list[b];
        if (A.kind === "bubble" || B.kind === "bubble") continue; // massless
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const rr = A.r + B.r;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.01 && d2 < rr * rr) {
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;
          const push = (rr - d) / 2;
          A.x -= nx * push; A.y -= ny * push;
          B.x += nx * push; B.y += ny * push;
          const rel = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
          if (rel < 0) {
            const j = -rel * 0.7;
            A.vx -= nx * j; A.vy -= ny * j;
            B.vx += nx * j; B.vy += ny * j;
          }
        }
      }
    }
    for (let k = 0; k < this.list.length; k++) {
      const o = this.list[k];
      if (o.kind === "bubble") {
        if (!this.updateBubble(o)) {
          this.list.splice(k, 1);
          k--;
        }
        continue;
      }
      this.unstamp(o);
      o.vy += 0.22;
      // buoyancy + drag when the center sits in liquid
      const ci = Math.round(o.y) * w.W + Math.round(o.x);
      if (BEHAVIOR[w.species[ci]] === B.LIQUID) {
        o.vy -= BUOY[o.kind];
        o.vx *= 0.93;
        o.vy *= 0.9;
      }
      o.vx *= FRICTION[o.kind];
      o.vx = Math.max(-9, Math.min(9, o.vx));
      o.vy = Math.max(-9, Math.min(9, o.vy));
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(o.vx), Math.abs(o.vy))));
      const sx = o.vx / n;
      const sy = o.vy / n;
      for (let s = 0; s < n; s++) {
        if (sx !== 0) {
          if (!this.collides(o, o.x + sx, o.y)) o.x += sx;
          else o.vx = -o.vx * REST[o.kind];
        }
        if (sy !== 0) {
          if (!this.collides(o, o.x, o.y + sy)) o.y += sy;
          else {
            if (sy > 0) {
              // ground contact: round things roll toward the lower side
              if (o.kind === "wheel" || o.kind === "ball") {
                o.angle += o.vx / o.r;
                const hl = this.groundY(o.x - 4, o.y);
                const hr = this.groundY(o.x + 4, o.y);
                const roll = o.kind === "wheel" ? 0.15 : 0.12;
                if (hr - hl > 1) o.vx += roll;
                else if (hl - hr > 1) o.vx -= roll;
              }
              if (Math.abs(o.vy) < 0.6) o.vy = 0;
              else o.vy = -o.vy * REST[o.kind];
            } else {
              o.vy = -o.vy * REST[o.kind];
            }
            break;
          }
        }
      }
      o.x = Math.max(o.r, Math.min(w.W - 1 - o.r, o.x));
      o.y = Math.max(o.r, Math.min(w.H - 1 - o.r, o.y));
      this.stamp(o);
    }
  }

  /** Powder-Game bubble: drifts up on buoyancy, shoved hard by wind; pops on
   *  walls/objects/border, and its ring becomes any element dot it touches
   *  (except fan). Returns false when the bubble is gone. */
  private updateBubble(o: RigidObject): boolean {
    const w = this.world;
    this.unstamp(o);
    for (const other of this.list) {
      if (other === o || other.kind === "bubble") continue;
      const dx = other.x - o.x;
      const dy = other.y - o.y;
      const rr = other.r + o.r;
      if (dx * dx + dy * dy < rr * rr) return false; // popped by a solid object
    }
    const [wx, wy] = w.windAt(Math.round(o.x), Math.round(o.y));
    o.vx = o.vx * 0.88 + wx * 0.45 + (w.rng.byte() - 128) / 900;
    o.vy = o.vy * 0.88 - 0.05 + wy * 0.45;
    o.vx = Math.max(-2.5, Math.min(2.5, o.vx));
    o.vy = Math.max(-2.5, Math.min(2.5, o.vy));
    o.x += o.vx;
    o.y += o.vy;
    if (o.x < o.r || o.y < o.r || o.x > w.W - 1 - o.r || o.y > w.H - 1 - o.r) {
      return false; // popped on the border
    }
    let becomes = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = Math.round(o.x + Math.cos(a) * o.r);
      const py = Math.round(o.y + Math.sin(a) * o.r);
      const s = w.species[py * w.W + px];
      if (s === E.EMPTY || s === E.BUBBLE || s === E.FAN || s === E.SOAPY) continue;
      if (s === E.WALL || s === E.BALL || s === E.BOX || s === E.WHEEL || s === E.STICK) {
        return false; // popped on a solid
      }
      becomes = s;
    }
    if (becomes !== 0) {
      // the ring turns into the touched element
      this.cells(o, (cx, cy) => {
        if (cx >= 0 && cy >= 0 && cx < w.W && cy < w.H) w.paint(cx, cy, becomes);
      });
      return false;
    }
    this.stamp(o);
    return true;
  }

  serialize(): Uint8Array {
    const buf = new Uint8Array(3 + this.list.length * 5);
    buf[0] = 0x4f; buf[1] = 0x42; // "OB"
    buf[2] = this.list.length;
    this.list.forEach((o, k) => {
      const p = 3 + k * 5;
      buf[p] = o.id;
      const x = Math.round(o.x);
      const y = Math.round(o.y);
      buf[p + 1] = x & 255; buf[p + 2] = x >> 8;
      buf[p + 3] = y & 255; buf[p + 4] = y >> 8;
    });
    return buf;
  }

  deserialize(buf: Uint8Array): void {
    this.list.length = 0;
    if (buf.length < 3 || buf[0] !== 0x4f || buf[1] !== 0x42) return;
    const n = buf[2];
    for (let k = 0; k < n; k++) {
      const p = 3 + k * 5;
      this.spawnId(buf[p], buf[p + 1] | (buf[p + 2] << 8), buf[p + 3] | (buf[p + 4] << 8));
    }
  }
}
