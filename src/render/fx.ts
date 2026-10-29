import { Container, Sprite, Texture } from 'pixi.js';
import { FLOOR_Y } from './layout';

/**
 * Shared building blocks for visual effects: a pooled particle system, sprite helpers and
 * procedural textures. Purely cosmetic, so unseeded randomness is fine here.
 */

export interface ParticleSpec {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds. */
  life: number;
  size: number;
  tint: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Downward acceleration, px/s². */
  gravity?: number;
  /** Soft round puff instead of a spark streaked along its velocity. */
  round?: boolean;
  /** Brighten as it lives (for sparks being drawn into a charge) instead of fading. */
  fadeIn?: boolean;
  /** Colour it cools/shifts to by the end of its life (default: stays `tint`). */
  tintEnd?: number;
  /** Round puffs only: size multiplier reached at the end of life (billowing flame); 0 = shrink away. */
  grow?: number;
  /** Round puffs only: peak opacity. */
  alpha?: number;
  /** 'normal' for matter that doesn't glow (dust, smoke); energy is additive. */
  blend?: 'add' | 'normal';
  /**
   * A glowing ember riding the heat: a soft round point (never streaked) that sways side to side,
   * flickers, and fades in and out gently.
   */
  ember?: boolean;
}

interface Particle extends Required<ParticleSpec> {
  sprite: Sprite;
  maxLife: number;
  /** Per-particle offset so embers sway and flicker out of step. */
  phase: number;
}

/** Ember sway amplitude (px) and speed (rad/s); flicker speed (rad/s). */
const EMBER = { sway: 7, swaySpeed: 2.6, flicker: 14 } as const;

/** Pooled sparks, embers and puffs. */
export class Particles {
  readonly root = new Container();
  private readonly live: Particle[] = [];
  private readonly pool: Sprite[] = [];

  constructor(private readonly max: number) {}

  emit(spec: ParticleSpec): void {
    if (this.live.length >= this.max) return;
    const sprite = this.pool.pop() ?? this.newSprite();
    sprite.visible = true;
    sprite.tint = spec.tint;
    sprite.blendMode = spec.blend ?? 'add';
    this.live.push({
      drag: 0,
      gravity: 0,
      round: false,
      fadeIn: false,
      tintEnd: spec.tint,
      grow: 0,
      alpha: 0.55,
      blend: 'add',
      ember: false,
      ...spec,
      sprite,
      maxLife: spec.life,
      phase: Math.random() * Math.PI * 2,
    });
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        this.pool.push(p.sprite);
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        continue;
      }
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const left = p.life / p.maxLife;
      const sp = p.sprite;
      sp.position.set(p.x, p.y);
      if (p.tintEnd !== p.tint) sp.tint = mixColor(p.tint, p.tintEnd, 1 - left);
      if (p.ember) {
        const age = p.maxLife - p.life;
        sp.rotation = 0;
        sp.position.set(p.x + Math.sin(p.phase + age * EMBER.swaySpeed) * EMBER.sway, p.y);
        sp.width = sp.height = p.size * (0.85 + 0.15 * Math.sin(p.phase * 3 + age * 5));
        const flicker = 0.7 + 0.3 * Math.sin(p.phase + age * EMBER.flicker);
        // Fades in over the first moments and out over the last third: no popping.
        sp.alpha = p.alpha * flicker * Math.min(1, left * 3) * Math.min(1, (1 - left) * 10);
      } else if (p.round) {
        sp.rotation = 0;
        sp.width = sp.height = p.size * (p.grow > 0 ? 1 + (p.grow - 1) * (1 - left) : 0.4 + 0.6 * left);
        // Billowing puffs swell in quickly then thin out; plain puffs just fade.
        sp.alpha = p.alpha * (p.grow > 0 ? Math.min(1, (1 - left) * 6) * left : left);
      } else {
        const speed = Math.hypot(p.vx, p.vy);
        sp.rotation = Math.atan2(p.vy, p.vx);
        sp.width = p.size * (1 + speed / 120);
        sp.height = p.size * (p.fadeIn ? 1 : 0.5 + 0.5 * left);
        sp.alpha = p.fadeIn ? 1 - left * 0.6 : left;
      }
    }
  }

  private newSprite(): Sprite {
    const sp = new Sprite(glowTexture());
    sp.anchor.set(0.5);
    sp.blendMode = 'add';
    this.root.addChild(sp);
    return sp;
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Blend two 0xRRGGBB colours. */
export function mixColor(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(lerp((a >> shift) & 0xff, (b >> shift) & 0xff, t)) << shift;
  return ch(16) | ch(8) | ch(0);
}

/** Multiply two 0xRRGGBB tints, as stacking two coloured lights on a sprite would. */
export function multiplyColor(a: number, b: number): number {
  const ch = (shift: number) => Math.round((((a >> shift) & 0xff) * ((b >> shift) & 0xff)) / 255) << shift;
  return ch(16) | ch(8) | ch(0);
}

/** Turn a fractional expected count into a whole number of spawns this frame. */
export function spawnCount(expected: number): number {
  const whole = Math.floor(expected);
  return whole + (Math.random() < expected - whole ? 1 : 0);
}

export function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

export function setSize(sprite: Sprite, size: number): void {
  sprite.width = sprite.height = size;
}

export function glowSprite(blend: 'add' | 'normal' = 'add', tint = 0xffffff): Sprite {
  const sp = new Sprite(glowTexture());
  sp.anchor.set(0.5);
  sp.tint = tint;
  sp.blendMode = blend;
  return sp;
}

export function coreSprite(tint = 0xffffff): Sprite {
  const sp = new Sprite(coreTexture());
  sp.anchor.set(0.5);
  sp.tint = tint;
  sp.blendMode = 'add';
  return sp;
}

// --- Ground dust ---

/** The valley floor's dust in a few earth tones: lighter, fine dust hangs; darker, heavier dust settles. */
const DUST_TONES = [0xb09a78, 0x9a8466, 0x7d6a50, 0x5e4d3a] as const;

/** One billow of dust at floor level. `vx`/`vy` in px/s. */
export function dustPuff(particles: Particles, x: number, vx: number, vy: number, size: number): void {
  const tone = Math.floor(Math.random() * DUST_TONES.length);
  particles.emit({
    x,
    y: FLOOR_Y - 2 - Math.random() * 8,
    vx,
    vy,
    life: 0.6 + Math.random() * 0.7,
    size,
    // Darker dust is heavier: it settles; the pale fines hang in the air longer.
    tint: DUST_TONES[tone],
    tintEnd: DUST_TONES[Math.max(0, tone - 1)],
    grow: 3.2,
    alpha: 0.62 - tone * 0.05,
    drag: 2.6,
    gravity: 18 + tone * 22,
    round: true,
    blend: 'normal',
  });
}

/**
 * Feet hitting or leaving the ground hard: a low ring of dust rolling out both ways. `strength`
 * ~1 for a jump, more for a heavy landing.
 */
export function groundBurst(particles: Particles, x: number, strength: number, lean = 0): void {
  let n = Math.round(12 + 14 * strength);
  while (n-- > 0) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const speed = (90 + Math.random() * 260) * strength;
    dustPuff(particles, x + side * Math.random() * 26, side * speed + lean * 120, -(10 + Math.random() * 70), 22 + Math.random() * 22);
  }
}

// --- Procedural textures (generated once, white so they can be tinted). ---

const cache = new Map<string, Texture>();

export function canvasTexture(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const tex = Texture.from(canvas);
  cache.set(key, tex);
  return tex;
}

export function radial(stops: readonly [number, number][]): (ctx: CanvasRenderingContext2D) => void {
  return (ctx) => {
    const r = ctx.canvas.width / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    for (const [at, a] of stops) g.addColorStop(at, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, r * 2, r * 2);
  };
}

/** Soft light falloff. */
export function glowTexture(): Texture {
  return canvasTexture('glow', 128, 128, radial([[0, 1], [0.15, 0.75], [0.4, 0.28], [0.7, 0.07], [1, 0]]));
}

/** Hard-edged hot centre. */
export function coreTexture(): Texture {
  return canvasTexture('core', 64, 64, radial([[0, 1], [0.4, 1], [0.65, 0.45], [1, 0]]));
}

/** A thin bright ring with a soft inner glow: a shockwave. */
export function ringTexture(): Texture {
  return canvasTexture('ring', 128, 128, radial([[0, 0], [0.55, 0.06], [0.78, 0.35], [0.88, 1], [0.95, 0.3], [1, 0]]));
}
