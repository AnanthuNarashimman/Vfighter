import { Container, Graphics, type Sprite } from 'pixi.js';
import { BEAM_MAX_LENGTH } from '../sim/constants';
import { MOVES, MUZZLE, phaseAt } from '../sim/moves';
import type { FighterState, ProjectileState } from '../sim/state';
import { coreSprite, glowSprite, lerp, setSize, spawnCount, type Particles } from './fx';
import { FIGHTER_HEIGHT, FLOOR_Y } from './layout';

/**
 * Sound: TKURII's blast and beam are not energy but noise made visible. Everything is drawn as
 * wavefronts, arcs bowing forward like ")))" the way sound is drawn coming out of a speaker:
 * - the charge is rings of sound pulled in to the hands;
 * - the ball is a humming, vibrating orb that throws rings off itself and leaves wavefronts behind;
 * - the beam is a loud, widening cone of sound: wavefronts race along it, the palm throbs, the
 *   head of the beam is a shockwave, and while it blares the whole scene rumbles.
 *
 * Purely cosmetic: reads simulation state, never writes it, so unseeded randomness is fine.
 */

export const SOUND = { core: 0xf4fffd, body: 0x8ff0e6, fringe: 0x2fa9c9 } as const;

/**
 * Where his cupped hands hold the charge, low at the belt (fractions of FIGHTER_HEIGHT, like
 * energyView's CHARGE_POINT; measured from his blast_charge frame).
 */
const CHARGE_POINT = { x: 0.065, y: 0.39 } as const;
/** Muzzle burst length after a ball is released, in ticks (the blast's active phase). */
const FLASH_TICKS = MOVES.blast.phases[1].ticks;

/** Beam wavefronts: px between them, how fast they race along (px per ms). */
const WAVE_SPACING = 62;
const WAVE_SPEED = 1.9;
/** The beam's cone: half-height at the palm, and how fast it widens per px, up to `max`. */
const CONE = { start: 16, spread: 0.07, max: 78 };
/** Screen rumble while the beam blares, in px. */
const RUMBLE_PX = 3.5;

type Point = { x: number; y: number };

/** Stroke layers for a wavefront, widest and faintest first, at full strength. */
type Layer = { readonly color: number; readonly width: number; readonly alpha: number };
const LAYERS: readonly Layer[] = [
  { color: SOUND.fringe, width: 13, alpha: 0.22 },
  { color: SOUND.body, width: 5.5, alpha: 0.75 },
  { color: SOUND.core, width: 2, alpha: 1 },
];

/**
 * One wavefront: an arc of half-height `h` whose front bulges out at `x` towards `dir`. `s` scales
 * the stroke widths, `k` the opacity.
 */
function wavefront(g: Graphics, x: number, y: number, h: number, dir: number, s: number, k: number, layers: readonly Layer[] = LAYERS): void {
  if (k <= 0.01 || h <= 0) return;
  const r = h * 1.45;
  const theta = Math.asin(h / r);
  const cx = x - dir * r;
  const [a0, a1] = dir > 0 ? [-theta, theta] : [Math.PI - theta, Math.PI + theta];
  for (const l of layers) {
    g.moveTo(cx + Math.cos(a0) * r, y + Math.sin(a0) * r)
      .arc(cx, y, r, a0, a1)
      .stroke({ color: l.color, width: l.width * s, alpha: l.alpha * k, cap: 'round' });
  }
}

/** A full ring of sound around a point. */
function ring(g: Graphics, x: number, y: number, r: number, s: number, k: number): void {
  if (k <= 0.01 || r <= 0) return;
  for (const l of LAYERS) g.circle(x, y, r).stroke({ color: l.color, width: l.width * s, alpha: l.alpha * k });
}

/** Fractional part, always in [0, 1). */
function frac(v: number): number {
  return v - Math.floor(v);
}

/** One sound fighter's charge, release burst and beam. */
export class SoundFighterFx {
  readonly root = new Container();
  private readonly g = new Graphics();
  private readonly glow = glowSprite('add', SOUND.body);
  private readonly core = coreSprite(SOUND.core);
  private rumble = 0;

  constructor() {
    this.g.blendMode = 'add';
    this.root.addChild(this.glow, this.core, this.g);
    this.hide();
  }

  hide(): void {
    this.g.clear();
    this.glow.visible = this.core.visible = false;
    this.rumble = 0;
  }

  /** Camera offset while the beam blares. */
  shake(): Point {
    const a = this.rumble * RUMBLE_PX;
    return { x: (Math.random() * 2 - 1) * a, y: (Math.random() * 2 - 1) * a * 0.6 };
  }

  update(prev: FighterState, curr: FighterState, alpha: number, time: number, dt: number, particles: Particles): void {
    this.hide();
    if (curr.action !== 'blast' && curr.action !== 'beam') return;
    const move = MOVES[curr.action];
    const phase = phaseAt(move, curr.actionTick, curr.moveSustained);
    if (!phase) return;

    const x = lerp(prev.x, curr.x, alpha);
    const y = lerp(prev.y, curr.y, alpha);
    const at = (pt: Point): Point => ({ x: x + curr.facing * pt.x * FIGHTER_HEIGHT, y: FLOOR_Y - (y + pt.y * FIGHTER_HEIGHT) });
    const t = phase.tick + alpha;

    if (phase.phase === 'startup') {
      this.charge(at(CHARGE_POINT), t / move.phases[0].ticks, time, dt, particles);
    } else if (curr.action === 'beam') {
      // Beam length can only shrink when a new beam starts; never interpolate across that.
      const len = curr.beamLength >= prev.beamLength ? lerp(prev.beamLength, curr.beamLength, alpha) : curr.beamLength;
      let k = 1;
      if (phase.phase === 'active' && curr.actionTick - move.phases[0].ticks < 4) k = Math.min(1, (t + 1) / 4);
      if (phase.phase === 'recovery') k = Math.max(0, 1 - t / move.phases[2].ticks);
      this.beam(at(MUZZLE), curr.facing, len, k, phase.phase === 'active', time, dt, particles);
    } else if (phase.phase === 'active') {
      this.burst(at(MUZZLE), curr.facing, Math.max(0, 1 - t / FLASH_TICKS));
    }
  }

  /** Rings of sound pulled in from all around, tightening onto a humming orb between the hands. */
  private charge(p: Point, k: number, time: number, dt: number, particles: Particles): void {
    const hum = 1 + 0.12 * Math.sin(time * 0.09) + 0.06 * Math.sin(time * 0.23);
    this.orb(p, (10 + 34 * k) * hum, (4 + 14 * k) * hum, 0.5 + 0.5 * k);
    for (let i = 0; i < 3; i++) {
      const u = frac(time * 0.0024 + i / 3);
      ring(this.g, p.x, p.y, lerp(110, 10, u) * (0.6 + 0.4 * k), 0.4 + 0.3 * k, k * u * 0.8);
    }
    let n = spawnCount((30 + 90 * k) * dt);
    while (n-- > 0) {
      const angle = Math.random() * Math.PI * 2;
      const r = 60 + Math.random() * 50;
      const life = 0.2 + Math.random() * 0.12;
      particles.emit({
        x: p.x + Math.cos(angle) * r,
        y: p.y + Math.sin(angle) * r,
        vx: (-Math.cos(angle) * r) / life,
        vy: (-Math.sin(angle) * r) / life,
        life,
        size: 2 + Math.random() * 3,
        tint: Math.random() < 0.5 ? SOUND.core : SOUND.body,
        fadeIn: true,
      });
    }
  }

  /** The ball leaves the palm with a bang: rings and wavefronts burst out of it. */
  private burst(p: Point, facing: 1 | -1, k: number): void {
    if (k <= 0) return;
    this.orb(p, 120 * k, 40 * k, k);
    const u = 1 - k;
    ring(this.g, p.x, p.y, 20 + 110 * u, 0.9, k);
    for (let i = 0; i < 3; i++) wavefront(this.g, p.x + facing * (30 + 70 * u + i * 26), p.y, 30 + 30 * u + i * 8, facing, 0.9, k * (1 - i * 0.25));
  }

  private beam(p: Point, facing: 1 | -1, len: number, k: number, firing: boolean, time: number, dt: number, particles: Particles): void {
    if (k <= 0 || len <= 0) return;
    // The volume throbs: everything swells and shrinks a little, fast, never quite still.
    const throb = 1 + 0.08 * Math.sin(time * 0.06) + 0.05 * Math.sin(time * 0.17 + 1.1) + (Math.random() - 0.5) * 0.04;
    const s = Math.sqrt(k) * throb;
    const half = (d: number) => Math.min(CONE.max, CONE.start + d * CONE.spread) * s;
    const g = this.g;

    // The cone of shaken air the sound travels down: nested, each narrower and brighter.
    for (const [w, a] of [[1.15, 0.05], [0.7, 0.07], [0.3, 0.1]] as const) {
      const end = p.x + facing * len;
      g.poly([p.x, p.y - half(0) * w, end, p.y - half(len) * w, end, p.y + half(len) * w, p.x, p.y + half(0) * w]).fill({
        color: SOUND.body,
        alpha: a * k,
      });
    }

    // Wavefronts racing down the beam, each as loud as the moment it left the palm.
    const travelled = time * WAVE_SPEED;
    for (let d = frac(travelled / WAVE_SPACING) * WAVE_SPACING; d < len; d += WAVE_SPACING) {
      const wave = Math.floor((travelled - d) / WAVE_SPACING);
      const loud = 0.7 + 0.3 * Math.sin(wave * 1.9);
      const fadeIn = Math.min(1, d / 40);
      const fadeOut = Math.min(1, (len - d) / 50);
      wavefront(g, p.x + facing * d, p.y, half(d) * (0.85 + 0.25 * loud), facing, s * loud, k * fadeIn * fadeOut * (0.65 + 0.35 * loud));
      // A fainter ripple trailing each one.
      const d2 = d + WAVE_SPACING * 0.5;
      if (d2 < len) wavefront(g, p.x + facing * d2, p.y, half(d2) * 0.7, facing, s * 0.6, k * 0.45 * fadeOut, [LAYERS[2]]);
    }

    // The palm throbbing like a speaker cone, and rings pumping out of it.
    this.orb(p, 110 * s, 34 * s, k);
    for (let i = 0; i < 2; i++) {
      const u = frac(time * 0.004 + i / 2);
      ring(g, p.x, p.y, 14 + 60 * u, 0.7 * s, k * (1 - u));
    }

    // The head: a shockwave shoving the air in front of it.
    if (len < BEAM_MAX_LENGTH) {
      const tip = p.x + facing * len;
      const h = half(len) * 1.25;
      wavefront(g, tip, p.y, h, facing, s * 1.4, k);
      wavefront(g, tip + facing * 16, p.y, h * 0.75, facing, s * 0.8, k * 0.6);
    }

    this.rumble = firing ? k : 0;
    if (!firing) return;
    // Air and grit blown along the edges of the cone.
    const shown = Math.min(len, 1400);
    let n = spawnCount(shown * 0.1 * dt);
    while (n-- > 0) {
      const d = Math.random() * shown;
      const side = Math.random() < 0.5 ? -1 : 1;
      particles.emit({
        x: p.x + facing * d,
        y: p.y + side * half(d) * (0.6 + Math.random() * 0.5),
        vx: facing * (300 + Math.random() * 400),
        vy: side * (20 + Math.random() * 60),
        life: 0.12 + Math.random() * 0.18,
        size: 2 + Math.random() * 2.5,
        tint: Math.random() < 0.5 ? SOUND.core : SOUND.body,
        drag: 3,
      });
    }
  }

  private orb(p: Point, glow: number, core: number, k: number): void {
    this.glow.visible = this.core.visible = true;
    this.glow.position.set(p.x, p.y);
    this.core.position.set(p.x, p.y);
    setSize(this.glow, glow);
    setSize(this.core, core);
    this.glow.alpha = 0.7 * k;
    this.core.alpha = k;
  }
}

/** A ball of sound in flight: a vibrating orb throwing rings off itself and leaving wavefronts behind. */
export class SoundBallFx {
  readonly root = new Container();
  readonly ground: Sprite = glowSprite('add', SOUND.body);
  private readonly g = new Graphics();
  private readonly glow = glowSprite('add', SOUND.body);
  private readonly fringe = glowSprite('normal', SOUND.fringe);
  private readonly core = coreSprite(SOUND.core);
  private readonly seed = Math.random() * 1000;

  constructor() {
    this.g.blendMode = 'add';
    this.root.addChild(this.fringe, this.glow, this.core, this.g);
  }

  update(prev: ProjectileState, curr: ProjectileState, alpha: number, time: number, _dt: number, _particles: Particles): void {
    const x = lerp(prev.x, curr.x, alpha);
    const y = FLOOR_Y - lerp(prev.y, curr.y, alpha);
    const dir = Math.sign(curr.vx) || 1;
    const g = this.g.clear();
    const t = time + this.seed;

    // Swells out of the hand over the first ticks, then hums: a fast, small vibration.
    const grow = Math.min(1, 0.4 + (curr.age + alpha) / 6);
    const hum = 1 + 0.1 * Math.sin(t * 0.11) + (Math.random() - 0.5) * 0.06;
    const r = 24 * grow;
    for (const sp of [this.fringe, this.glow, this.core]) sp.position.set(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2);
    setSize(this.fringe, r * 4.2 * hum);
    this.fringe.alpha = 0.25;
    setSize(this.glow, r * 3 * hum);
    setSize(this.core, r * 1.3 * hum);

    // Rings pulsing out of it.
    for (let i = 0; i < 3; i++) {
      const u = frac(t * 0.005 + i / 3);
      ring(g, x, y, r * (0.8 + 1.3 * u), 0.6, (1 - u) * 0.8);
    }
    // Wavefronts out in front, and fading ones left behind in the air.
    wavefront(g, x + dir * r * 1.3, y, r * 1.1 * hum, dir, 0.8, 0.9);
    for (let i = 1; i <= 3; i++) wavefront(g, x - dir * (r * 0.4 + i * 22), y, r * (1.1 + i * 0.22), dir, 0.75, 0.6 - i * 0.15);

    // Light thrown on the floor below.
    const lift = Math.max(0, Math.min(1, (FLOOR_Y - y) / 400));
    this.ground.position.set(x, FLOOR_Y + 4);
    this.ground.width = 160;
    this.ground.height = 40;
    this.ground.alpha = 0.3 * (1 - lift);
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.ground.destroy();
  }
}
