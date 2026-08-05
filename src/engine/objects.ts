// Rigid objects (ball / box / wheel), Powder-Game style: each entity stamps its
// footprint into the grid as static cells every tick, so powders pile on top and
// the sim treats them as obstacles; the entity itself collides against cells.

import { E, B, BEHAVIOR } from "./elements";
import type { World } from "./world";

export type ObjKind = "ball" | "box" | "wheel";

const KIND_ID: Record<ObjKind, number> = { ball: E.BALL, box: E.BOX, wheel: E.WHEEL };
const ID_KIND: Record<number, ObjKind> = { [E.BALL]: "ball", [E.BOX]: "box", [E.WHEEL]: "wheel" };
const KIND_R: Record<ObjKind, number> = { ball: 7, box: 8, wheel: 9 };
const REST: Record<ObjKind, number> = { ball: 0.72, box: 0.05, wheel: 0.3 };
const FRICTION: Record<ObjKind, number> = { ball: 0.996, box: 0.86, wheel: 0.999 };
const BUOY: Record<ObjKind, number> = { ball: 0.4, box: 0.26, wheel: 0.1 };
const MAX_OBJECTS = 64;

export class RigidObject {
  vx = 0;
  vy = 0;
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
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (box || dx * dx + dy * dy <= r2) cb(x0 + dx, y0 + dy);
      }
    }
  }

  private stamp(o: RigidObject): void {
    const w = this.world;
    this.cells(o, (cx, cy) => {
      if (cx >= 0 && cy >= 0 && cx < w.W && cy < w.H && w.species[cy * w.W + cx] === E.EMPTY) {
        w.rawSet(cx, cy, o.id, 150 + ((cx * 3 + cy * 5) & 63));
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
    // object-object impulses (all treated as circles)
    for (let a = 0; a < this.list.length; a++) {
      for (let b = a + 1; b < this.list.length; b++) {
        const A = this.list[a];
        const B = this.list[b];
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
    for (const o of this.list) {
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
      o.vx = Math.max(-4, Math.min(4, o.vx));
      o.vy = Math.max(-4, Math.min(4, o.vy));
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
              // ground contact: wheels roll toward the lower ground side
              if (o.kind === "wheel") {
                const hl = this.groundY(o.x - 4, o.y);
                const hr = this.groundY(o.x + 4, o.y);
                if (hr - hl > 1) o.vx += 0.15;
                else if (hl - hr > 1) o.vx -= 0.15;
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
