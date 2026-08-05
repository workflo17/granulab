// The Powder Game stickman: arrow-key player whose head takes the attribute of
// the last element it touched. Lives ABOVE the grid; rendered as a texture patch.

import { E, B, BEHAVIOR, LIFE0 } from "./elements";
import type { World } from "./world";

export interface PlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
}

const PW = 2; // half-width in cells
const PH = 9; // height above the feet row

export class Player {
  x = 0; // feet center
  y = 0;
  vx = 0;
  vy = 0;
  headId = 0; // 0 = plain head (rendered with headFallback's color)
  facing = 1;
  alive = false;
  protected headFallback: number = E.SPARK; // plain-head color (yellow)

  place(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.headId = 0;
    this.alive = true;
  }

  remove(): void {
    this.alive = false;
  }

  private solidAt(world: World, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= world.W || y >= world.H) return true;
    const id = world.species[y * world.W + x];
    if (id === E.EMPTY) return false;
    const b = BEHAVIOR[id];
    return !(
      b === B.LIQUID || b === B.GAS || b === B.FIRE || b === B.LASER ||
      b === B.THUNDER || b === B.ROCKET || b === B.CLOUD || b === B.BIRD
    );
  }

  private liquidAt(world: World, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= world.W || y >= world.H) return false;
    return BEHAVIOR[world.species[y * world.W + x]] === B.LIQUID;
  }

  private bodyBlocked(world: World, cx: number, cy: number): boolean {
    for (const dy of [0, -4, -PH]) {
      for (let dx = -PW; dx <= PW; dx += PW) {
        if (this.solidAt(world, cx + dx, cy + dy)) return true;
      }
    }
    return false;
  }

  update(world: World, input: PlayerInput): void {
    if (!this.alive) return;
    const bird = this.headId === E.BIRD;
    const superball = this.headId === E.SUPERBALL;
    const inLiquid = this.liquidAt(world, this.x, this.y - 2);
    const grounded =
      this.solidAt(world, this.x - 1, this.y + 1) ||
      this.solidAt(world, this.x, this.y + 1) ||
      this.solidAt(world, this.x + 1, this.y + 1);

    this.vx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (this.vx !== 0) this.facing = this.vx;
    this.vx *= inLiquid ? 0.8 : 1.3;

    this.vy += bird ? 0.06 : 0.22;
    if (inLiquid) this.vy *= 0.82;
    if (input.up) {
      if (bird) this.vy = Math.max(this.vy - 0.5, -1.6);
      else if (inLiquid) this.vy = -1.8;
      else if (grounded) this.vy = superball ? -6.2 : -4.4;
    }
    this.vy = Math.min(3, Math.max(-7, this.vy));

    // horizontal move with 1-cell step-up (walk over slopes)
    let nx = Math.round(this.x + this.vx);
    nx = Math.max(PW, Math.min(world.W - 1 - PW, nx));
    if (nx !== this.x) {
      if (!this.bodyBlocked(world, nx, this.y)) this.x = nx;
      else if (!this.bodyBlocked(world, nx, this.y - 1)) { this.x = nx; this.y -= 1; }
      else this.vx = 0;
    }
    // vertical move, cell by cell
    let steps = Math.round(this.vy);
    const dir = steps > 0 ? 1 : -1;
    steps = Math.abs(steps);
    for (let s = 0; s < steps; s++) {
      const ny = this.y + dir;
      if (ny > world.H - 1 || ny - PH < 0 || this.bodyBlocked(world, this.x, ny)) {
        this.vy = 0;
        break;
      }
      this.y = ny;
    }

    // head absorbs the attribute of touched elements
    const headY = this.y - PH + 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const cx = this.x + dx;
        const cy = headY + dy;
        if (cx < 0 || cy < 0 || cx >= world.W || cy >= world.H) continue;
        const id = world.species[cy * world.W + cx];
        if (id !== E.EMPTY && id !== E.WALL && id !== E.STICK) {
          this.headId = id;
        }
      }
    }

    // head emission — the head's element acts through the player
    const h = this.headId;
    const rng = world.rng;
    const emit = (id: number, prob: number, dx: number, dy: number): void => {
      if (rng.byte() < prob) {
        const ex = this.x + dx;
        const ey = headY + dy;
        if (ex >= 0 && ey >= 0 && ex < world.W && ey < world.H &&
            world.species[ey * world.W + ex] === E.EMPTY) {
          world.paint(ex, ey, id);
        }
      }
    };
    if (h === E.FIRE || h === E.MAGMA || h === E.TORCH) emit(E.FIRE, 120, this.facing * 3, 0);
    else if (h === E.WATER || h === E.SEAWATER) emit(E.WATER, 60, this.facing * 2, 1);
    else if (h === E.GAS || h === E.STEAM) emit(h, 80, 0, -2);
    else if (h === E.ACID) emit(E.ACID, 40, this.facing * 2, 2);
    else if (h === E.SEED) emit(E.SEED, 20, this.facing * 2, 2);
    else if (h === E.LASER) {
      if (rng.byte() < 30) {
        const ex = this.x + this.facing * 3;
        if (ex >= 0 && ex < world.W && world.species[headY * world.W + ex] === E.EMPTY) {
          world.paint(ex, headY, E.LASER, ((this.facing > 0 ? 0 : 4) << 5) | 31);
        }
      }
    }
  }

  /** AI variant: chases a target and jumps obstacles; head works the same way */
  think(world: World, target: Player): PlayerInput {
    if (!target.alive) {
      return { left: false, right: world.rng.byte() < 4, up: world.rng.byte() < 4 };
    }
    const dx = target.x - this.x;
    const left = dx < -8;
    const right = dx > 8;
    const aheadBlocked =
      this.solidAt(world, this.x + this.facing * 4, this.y - 2) ||
      this.solidAt(world, this.x + this.facing * 4, this.y - 6);
    return { left, right, up: aheadBlocked || world.rng.byte() < 5 };
  }

  /** stamp the stickman into a species patch for the renderer (grid-space box) */
  patch(world: World): { x0: number; y0: number; w: number; h: number; species: Uint8Array; shade: Uint8Array } | null {
    if (!this.alive) return null;
    const x0 = Math.max(0, this.x - 2);
    const y0 = Math.max(0, this.y - PH);
    const w = Math.min(world.W, this.x + 3) - x0;
    const h = Math.min(world.H, this.y + 1) - y0;
    const sp = new Uint8Array(w * h);
    const sh = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const gi = (y0 + yy) * world.W + (x0 + xx);
        sp[yy * w + xx] = world.species[gi];
        sh[yy * w + xx] = world.shade[gi];
      }
    }
    const put = (dx: number, dy: number, id: number): void => {
      const px = this.x + dx - x0;
      const py = this.y + dy - y0;
      if (px >= 0 && py >= 0 && px < w && py < h) {
        sp[py * w + px] = id;
        sh[py * w + px] = 200;
      }
    };
    const head = this.headId === 0 ? this.headFallback : this.headId;
    for (let dy = -PH; dy <= -PH + 2; dy++)
      for (let dx = -1; dx <= 1; dx++) put(dx, dy, head);
    for (let dy = -PH + 3; dy <= -3; dy++) put(0, dy, E.STICK); // spine
    put(-2, -5, E.STICK); put(-1, -5, E.STICK); put(1, -5, E.STICK); put(2, -5, E.STICK); // arms
    const step = (this.x >> 2) & 1; // simple walk cycle
    if (step === 0) {
      put(-1, -2, E.STICK); put(1, -2, E.STICK);
      put(-2, -1, E.STICK); put(2, -1, E.STICK);
      put(-2, 0, E.STICK); put(2, 0, E.STICK);
    } else {
      put(-1, -2, E.STICK); put(1, -2, E.STICK);
      put(-1, -1, E.STICK); put(1, -1, E.STICK);
      put(-1, 0, E.STICK); put(1, 0, E.STICK);
    }
    return { x0, y0, w, h, species: sp, shade: sh };
  }
}

export class Fighter extends Player {
  protected headFallback: number = E.VIRUS; // purple plain head marks the enemy
}
