import { Container, Graphics, type Sprite } from 'pixi.js';
import { BEAM_MAX_LENGTH, STAGE_WIDTH } from '../sim/constants';
import { MOVES, MUZZLE, phaseAt } from '../sim/moves';
import type { FighterState, ProjectileState } from '../sim/state';
import { glowSprite, lerp, spawnCount } from './fx';
import { FIGHTER_HEIGHT, FLOOR_Y } from './layout';

/**
 * Goo: GOONER's blast and beam are a thick, sticky white fluid rather than energy. Matter, not
 * light, so everything here is drawn with normal blending: an off-white body, a darker cream
 * underside, a glossy highlight on top, and a thin outline so it reads against the bright sky.
 *
 * The fluid behaves like a viscous liquid:
 * - the ball is a soft body that jiggles and stretches into a teardrop as it flies;
 * - the stream is a powerful jet: it swells as it leaves the hand (die swell) and then holds its
 *   thickness, dead straight, with fast streaks racing along it; drops spit off its edges and fall
 *   away, it piles up and sprays where it hits; when it stops, the tail detaches and breaks up;
 * - every loose drop falls under gravity and lands as a puddle that lingers, then soaks away.
 *
 * Purely cosmetic: reads simulation state, never writes it, so unseeded randomness is fine.
 */

export const GOO = {
  body: 0xf3f0e6,
  shade: 0xcbc5b2,
  edge: 0x8e8875,
  gloss: 0xffffff,
} as const;
/** The fluid is thick but not quite opaque. */
export const GOO_ALPHA = 0.95;

/** Where the cupped hands hold the goo in the charge pose (like energyView's CHARGE_POINT). */
const CHARGE_POINT = { x: 0.27, y: 0.66 } as const;
/** Muzzle flash length after a blast is released, in ticks. */
const FLASH_TICKS = MOVES.blast.phases[1].ticks;

const GRAVITY = 1500; // px/s²
const MAX_DROPS = 320;
const MAX_PUDDLES = 70;
const PUDDLE_LIFE = 4.5; // seconds
const PUDDLE_FADE = 1.2;

/** Stream half-thickness, px, at full strength: at the hand, and once swollen. */
const STREAM = { nozzle: 13, swollen: 19 };
/** The flow along the stream, px per ms (the streaks race along with it). */
const STREAM_FLOW = 2.6;

type Point = { x: number; y: number };

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Floor depth it lands at (the dirt strip has some depth), world y. */
  floor: number;
}

interface Puddle {
  x: number;
  y: number;
  r: number;
  age: number;
}

/**
 * Every loose drop of goo, and the puddles they leave. `floor` (beneath the fighters) holds the
 * puddles, `air` (above them) the drops in flight.
 */
export class GooDrops {
  readonly floor = new Graphics();
  readonly air = new Graphics();
  private readonly drops: Drop[] = [];
  private readonly puddles: Puddle[] = [];

  add(x: number, y: number, vx: number, vy: number, r: number): void {
    if (this.drops.length >= MAX_DROPS) return;
    this.drops.push({ x, y, vx, vy, r, floor: FLOOR_Y + 2 + Math.random() * 16 });
  }

  update(dt: number): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.vy += GRAVITY * dt;
      d.vx *= Math.max(0, 1 - 0.6 * dt);
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y < d.floor) continue;
      this.land(d);
      this.drops[i] = this.drops[this.drops.length - 1];
      this.drops.pop();
    }
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const p = this.puddles[i];
      p.age += dt;
      // Spreads out a little as it settles.
      if (p.age < 0.4) p.r += dt * p.r * 0.5;
      if (p.age < PUDDLE_LIFE) continue;
      this.puddles[i] = this.puddles[this.puddles.length - 1];
      this.puddles.pop();
    }
    this.draw();
  }

  /** A drop hitting the floor joins a puddle nearby or starts one; a fast one splashes a little. */
  private land(d: Drop): void {
    const near = this.puddles.find((p) => Math.abs(p.x - d.x) < p.r * 0.8 && Math.abs(p.y - d.floor) < 8);
    if (near) {
      // Volume adds up: area grows with the drop's.
      near.r = Math.min(70, Math.sqrt(near.r * near.r + d.r * d.r * 3));
      near.age = Math.min(near.age, 0.5);
    } else if (this.puddles.length < MAX_PUDDLES) {
      this.puddles.push({ x: d.x, y: d.floor, r: d.r * 1.8, age: 0 });
    }
    if (d.vy > 600 && d.r > 2.5) {
      for (let i = 0; i < 2; i++) {
        this.add(d.x, d.floor - 2, d.vx * 0.2 + (Math.random() - 0.5) * 160, -(120 + Math.random() * 160), d.r * 0.4);
      }
    }
  }

  private draw(): void {
    const f = this.floor.clear();
    for (const p of this.puddles) {
      const fade = Math.min(1, (PUDDLE_LIFE - p.age) / PUDDLE_FADE);
      const ry = p.r * 0.26;
      f.ellipse(p.x, p.y, p.r, ry).fill({ color: GOO.shade, alpha: 0.9 * fade });
      f.ellipse(p.x, p.y - ry * 0.15, p.r * 0.86, ry * 0.75).fill({ color: GOO.body, alpha: 0.95 * fade });
      f.ellipse(p.x - p.r * 0.25, p.y - ry * 0.35, p.r * 0.3, ry * 0.22).fill({ color: GOO.gloss, alpha: 0.8 * fade });
    }
    const a = this.air.clear();
    for (const d of this.drops) drawDrop(a, d.x, d.y, d.vx, d.vy, d.r);
  }
}

/** A falling drop: round when slow, stretched along its path when fast, with a glint. */
export function drawDrop(g: Graphics, x: number, y: number, vx: number, vy: number, r: number): void {
  const speed = Math.hypot(vx, vy);
  const stretch = Math.min(2.4, 1 + speed / 700);
  const ux = speed > 1 ? vx / speed : 0;
  const uy = speed > 1 ? vy / speed : 1;
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    // Teardrop: the trailing half stretches out behind, the leading half stays round.
    const along = Math.cos(a) * r * (Math.cos(a) < 0 ? stretch : 1);
    const across = Math.sin(a) * r;
    pts.push(x + ux * along - uy * across, y + uy * along + ux * across);
  }
  g.poly(pts).fill({ color: GOO.body, alpha: GOO_ALPHA }).stroke({ color: GOO.edge, width: 1, alpha: 0.5 });
  if (r > 2) g.circle(x - r * 0.3, y - r * 0.35, r * 0.3).fill({ color: GOO.gloss, alpha: 0.9 });
}

/**
 * A soft blob of goo centred on `c`: jiggling surface, optionally stretched into a teardrop
 * trailing behind `dir` (along x, or along y when `vertical`: `dir` 1 falls downward with the
 * tail above). Shaded underside, body, gloss.
 */
export function drawBlob(
  g: Graphics,
  c: Point,
  r: number,
  time: number,
  seed: number,
  jiggle: number,
  stretch = 0,
  dir = 1,
  vertical = false,
): void {
  const shape = (scale: number, dy: number): number[] => {
    const pts: number[] = [];
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wobble =
        1 + jiggle * (0.09 * Math.sin(3 * a + time * 0.011 + seed) + 0.06 * Math.sin(5 * a - time * 0.017 + seed * 2));
      const R = r * wobble * scale;
      const back = Math.max(0, -Math.cos(a) * dir); // 1 straight behind, 0 in front
      // The tail pulls out behind and pinches in; the front flattens a touch against the air.
      // Smooth taper (no point): the tail stretches and narrows, the front flattens a touch.
      const pull = back * back;
      const x = Math.cos(a) * R * (back > 0 ? 1 + stretch * 0.9 * pull : 1 - stretch * 0.1);
      const y = Math.sin(a) * R * (1 - stretch * 0.3 * pull);
      // Vertical: turn the shape a quarter so its front faces down (the light still comes from above).
      if (vertical) pts.push(c.x - y, c.y + x + dy);
      else pts.push(c.x + x, c.y + y + dy);
    }
    return pts;
  };
  // Shaded underside, body, a soft bright sheen, then the specular glints.
  g.poly(shape(1, 0)).fill({ color: GOO.shade, alpha: GOO_ALPHA }).stroke({ color: GOO.edge, width: 1.5, alpha: 0.6 });
  g.poly(shape(0.8, -r * 0.17)).fill({ color: GOO.body, alpha: GOO_ALPHA });
  g.poly(shape(0.5, -r * 0.3)).fill({ color: GOO.gloss, alpha: 0.35 });
  g.ellipse(c.x + dir * r * 0.18, c.y - r * 0.5, r * 0.32, r * 0.13).fill({ color: GOO.gloss, alpha: 0.95 });
  g.circle(c.x - dir * r * 0.32, c.y - r * 0.28, r * 0.07).fill({ color: GOO.gloss, alpha: 0.85 });
  // Light coming through the thick fluid pools along the bottom edge.
  g.ellipse(c.x - dir * r * 0.1, c.y + r * 0.62, r * 0.4, r * 0.1).fill({ color: GOO.gloss, alpha: 0.4 });
}

/**
 * A sticky strand from `a` to `b`, sagging under its own weight, `w` px thick at `a` and thinner
 * toward `b` (necking, as a stretched viscous thread does).
 */
function drawStrand(g: Graphics, a: Point, b: Point, w: number, sag: number): void {
  const n = 14;
  const top: number[] = [];
  const bottom: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = lerp(a.x, b.x, t);
    const y = lerp(a.y, b.y, t) + sag * 4 * t * (1 - t);
    // Thinnest a little past the middle, where it will snap.
    const half = Math.max(0.6, w * (1 - 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.15))) * (1 - 0.3 * t));
    top.push(x, y - half);
    bottom.unshift(x, y + half);
  }
  g.poly([...top, ...bottom]).fill({ color: GOO.body, alpha: GOO_ALPHA }).stroke({ color: GOO.edge, width: 1, alpha: 0.45 });
}

/** Goo bursting out from a point: drops thrown around `dir` (0 = all round). */
export function gooSplash(drops: GooDrops, x: number, y: number, dir: number, count: number, power = 1): void {
  for (let i = 0; i < count; i++) {
    const spread = dir === 0 ? Math.PI : 1.3;
    const angle = (dir < 0 ? Math.PI : 0) + (Math.random() - 0.5) * 2 * spread - (dir === 0 ? 0 : 0.35);
    const speed = (120 + Math.random() * 420) * power;
    drops.add(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed - 80, 2 + Math.random() * 4.5);
  }
}

/** The goo a fighter gathers (charge), lets fly (release) and streams (beam). */
export class GooFighterFx {
  readonly root = new Container();
  private readonly g = new Graphics();
  private chargeDrip = 0;
  /** The stream was flowing last frame (to spot it stopping and breaking up). */
  private wasFiring = false;

  constructor(private readonly drops: GooDrops) {
    this.root.addChild(this.g);
  }

  hide(): void {
    this.g.clear();
    this.wasFiring = false;
  }

  update(prev: FighterState, curr: FighterState, alpha: number, time: number, dt: number): void {
    this.g.clear();
    const firing = this.wasFiring;
    this.wasFiring = false;
    if (curr.action !== 'blast' && curr.action !== 'beam' && curr.action !== 'goonFall') return;
    const move = MOVES[curr.action];
    const phase = phaseAt(move, curr.actionTick, curr.moveSustained);
    if (!phase) return;

    const x = lerp(prev.x, curr.x, alpha);
    const y = lerp(prev.y, curr.y, alpha);
    const at = (pt: Point): Point => ({ x: x + curr.facing * pt.x * FIGHTER_HEIGHT, y: FLOOR_Y - (y + pt.y * FIGHTER_HEIGHT) });
    const t = phase.tick + alpha;

    if (phase.phase === 'startup') {
      this.charge(at(CHARGE_POINT), t / move.phases[0].ticks, time, dt);
    } else if (curr.action === 'goonFall') {
      // The goo leaves the hands to raise the colossus (see colossusView.ts).
      return;
    } else if (curr.action === 'beam') {
      const len = curr.beamLength >= prev.beamLength ? lerp(prev.beamLength, curr.beamLength, alpha) : curr.beamLength;
      const active = phase.phase === 'active';
      // Recovery: the stream has been cut off at the hand; `cut` runs 0 -> 1 as the tail flies away.
      const cut = active ? 0 : Math.min(1, t / move.phases[2].ticks);
      const ramp = active && curr.actionTick - move.phases[0].ticks < 4 ? Math.min(1, (t + 1) / 4) : 1;
      this.stream(at(MUZZLE), curr.facing, len, ramp, cut, curr.beamBlocked, time, dt, firing && !active);
      this.wasFiring = active;
    } else if (phase.phase === 'active') {
      // The last of the ball's goo left on the palm, shrinking back.
      const k = Math.max(0, 1 - t / FLASH_TICKS);
      if (k > 0) drawBlob(this.g, at(MUZZLE), 4 + 12 * k, time, 1.7, 1.5, 0, curr.facing);
    }
  }

  /** Goo welling up between the hands: a growing, wobbling blob with a drip forming under it. */
  private charge(p: Point, k: number, time: number, dt: number): void {
    const r = 5 + 19 * k;
    // The bigger it gets the more it sags.
    const c = { x: p.x, y: p.y + r * 0.1 };
    const drip = (this.chargeDrip += dt * (0.8 + 2.5 * k));
    const hang = drip % 1;
    if (drip >= 1) {
      this.chargeDrip = hang;
      this.drops.add(c.x, c.y + r + 4, (Math.random() - 0.5) * 30, 40, 2.5 + 2 * k);
    }
    // A pendant drop gathering under the blob before it lets go.
    const dr = (1.5 + 3.5 * k) * hang;
    if (dr > 0.8) {
      const neck = { x: c.x + 2, y: c.y + r * 0.85 + dr * 1.6 };
      drawStrand(this.g, { x: c.x + 2, y: c.y + r * 0.7 }, neck, dr * 0.7, 0);
      drawDrop(this.g, neck.x, neck.y + dr * 0.6, 0, 300, dr);
    }
    drawBlob(this.g, c, r, time, 0.4, 1 + 1.5 * k);
  }

  /**
   * The stream, in a local frame (x forward from the hand) mapped to the world by `facing`.
   * `ramp`: the jet still opening up (0..1). `cut`: 0 while flowing; once the flow stops the
   * stream detaches from the hand and its tail end chases the head away.
   */
  private stream(
    p: Point,
    facing: 1 | -1,
    len: number,
    ramp: number,
    cut: number,
    blocked: boolean,
    time: number,
    dt: number,
    justStopped: boolean,
  ): void {
    if (len <= 0) return;
    const g = this.g;
    const world = (u: number, v: number): [number, number] => [p.x + facing * u, p.y + v];
    const start = cut > 0 ? len * cut * cut : 0;
    const thin = 1 - 0.55 * cut;
    const flow = time * STREAM_FLOW;

    /** Half-thickness along the stream: swells out of the hand, then holds, with only a faint pulse. */
    const half = (u: number): number => {
      const swell = STREAM.nozzle + (STREAM.swollen - STREAM.nozzle) * Math.min(1, u / 60);
      const pulse = 1 + 0.035 * Math.sin(u * 0.05 - flow * 0.05);
      return swell * pulse * ramp * thin;
    };
    /** Centre line: dead straight (a forceful jet doesn't wander). */
    const mid = (_u: number): number => 0;

    if (justStopped) {
      // The cut-off stream necks and breaks into a line of drops.
      for (let u = 20; u < Math.min(len, 1300); u += 70 + Math.random() * 60) {
        const [wx, wy] = world(u, mid(u) + half(u) * 0.5);
        this.drops.add(wx, wy, facing * (200 + Math.random() * 200), Math.random() * 60, 2.5 + Math.random() * 3);
      }
    }

    const end = Math.min(len, STAGE_WIDTH + 200);
    if (end - start > 2) {
      const top: number[] = [];
      const under: number[] = [];
      const bottom: number[] = [];
      const step = 10;
      for (let u = start; ; u = Math.min(end, u + step)) {
        const h = half(u);
        const c = mid(u);
        // Heavy fluid: the underside hangs a little lower than the top rises.
        top.push(...world(u, c - h * 0.9));
        under.unshift(...world(u, c + h * 0.4));
        bottom.unshift(...world(u, c + h * 1.08));
        if (u >= end) break;
      }
      g.poly([...top, ...bottom]).fill({ color: GOO.shade, alpha: GOO_ALPHA }).stroke({ color: GOO.edge, width: 1.5, alpha: 0.5 });
      g.poly([...top, ...under]).fill({ color: GOO.body, alpha: GOO_ALPHA });

      // Straight streaks racing along the jet: gloss on top, darker drag lines lower down.
      const streaks: [from: number, to: number, period: number, dash: number, speed: number, color: number, alpha: number][] = [
        [-0.72, -0.45, 110, 70, 1, GOO.gloss, 0.9],
        [-0.25, -0.15, 150, 50, 1.3, GOO.gloss, 0.55],
        [0.55, 0.68, 130, 60, 0.8, GOO.edge, 0.35],
      ];
      for (const [from, to, period, dash, speed, color, alphaStreak] of streaks) {
        const shift = (flow * speed) % period;
        for (let u0 = start - ((start - shift) % period) - period; u0 < end; u0 += period) {
          const a = Math.max(start, u0);
          const b = Math.min(end, u0 + dash);
          if (b - a < 4) continue;
          g.poly([...world(a, half(a) * from), ...world(b, half(b) * from), ...world(b, half(b) * to), ...world(a, half(a) * to)]).fill({
            color,
            alpha: alphaStreak,
          });
        }
      }
    }

    // The hand keeps a gob of goo at the nozzle while it flows.
    if (cut === 0) drawBlob(g, { x: p.x + facing * 4, y: p.y }, 14 * ramp, time, 2.1, 1.2, 0, facing);

    // The head: a bulbous front where the advancing goo piles up. Off-stage it is not drawn.
    if (len < BEAM_MAX_LENGTH && len < STAGE_WIDTH + 100) {
      const h = half(len);
      const [hx, hy] = world(len, mid(len));
      drawBlob(g, { x: hx, y: hy }, h * 1.5, time, 3.3, 0.7, 0, facing);
      if (blocked && cut === 0) {
        // Slamming into something: goo sprays back and spatters down off the contact.
        let n = spawnCount(90 * dt);
        while (n-- > 0) {
          const a = Math.PI + (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.9);
          const s = 250 + Math.random() * 450;
          this.drops.add(hx, hy + (Math.random() - 0.5) * h, facing * Math.cos(a) * s, Math.sin(a) * s - 60, 2 + Math.random() * 4);
        }
      } else if (cut === 0) {
        let n = spawnCount(25 * dt);
        while (n-- > 0) this.drops.add(hx, hy + (Math.random() - 0.5) * h, facing * (350 + Math.random() * 300), (Math.random() - 0.6) * 200, 2 + Math.random() * 2.5);
      }
    }

    if (cut > 0) return;
    // A few drops tear off the jet's underside and fall straight away.
    const reach = Math.min(end, 1250);
    let n = spawnCount((reach / 200) * dt * 3);
    while (n-- > 0) {
      const u = 60 + Math.random() * Math.max(1, reach - 60);
      const [dx, dy] = world(u, half(u));
      this.drops.add(dx, dy + 2, facing * 120, 40, 2 + Math.random() * 2);
    }
  }
}

/**
 * A goo ball in flight: a jiggling soft body stretched by its speed into a teardrop, now and then
 * shaking a drop loose.
 */
export class GooBallFx {
  readonly root = new Container();
  readonly ground: Sprite = glowSprite('normal', 0x000000);
  private readonly g = new Graphics();
  private last: Point = { x: 0, y: 0 };
  private readonly seed = Math.random() * 10;

  constructor(private readonly drops: GooDrops) {
    this.root.addChild(this.g);
  }

  /** Where the ball was last drawn, for the splat when it hits. */
  get position(): Point {
    return this.last;
  }

  update(prev: ProjectileState, curr: ProjectileState, alpha: number, time: number, dt: number): void {
    const x = lerp(prev.x, curr.x, alpha);
    const y = FLOOR_Y - lerp(prev.y, curr.y, alpha);
    const dir = Math.sign(curr.vx) || 1;
    this.last = { x, y };
    const g = this.g.clear();

    // Swells out of the hand over the first ticks; flight stretches it into a teardrop.
    const r = 27 * Math.min(1, 0.45 + (curr.age + alpha) / 7);
    const stretch = Math.min(0.5, Math.abs(curr.vx) / 32);

    drawBlob(g, { x, y }, r, time, this.seed, 1.4 + stretch, stretch, dir);

    // Now and then a drop shakes loose off its tail and falls away behind it.
    let n = spawnCount(8 * dt);
    while (n-- > 0) {
      this.drops.add(x - dir * r * (1.1 + stretch), y + r * 0.3, dir * 40, 30, 1.8 + Math.random() * 2);
    }

    // A soft shadow on the floor under it (goo casts shade; it doesn't glow).
    const lift = Math.max(0, Math.min(1, (FLOOR_Y - y) / 400));
    this.ground.position.set(x, FLOOR_Y + 4);
    this.ground.width = 90 * (1 - lift * 0.4);
    this.ground.height = 16;
    this.ground.alpha = 0.32 * (1 - lift);
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.ground.destroy();
  }
}
