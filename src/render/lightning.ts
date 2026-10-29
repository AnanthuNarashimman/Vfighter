import type { Graphics } from 'pixi.js';

/** A jagged arc from (x0,y0) to (x1,y1) in some local frame; see drawBolts. */
export interface Bolt {
  /** Fractions along the straight line, 0..1. */
  readonly u: Float32Array;
  /** Sideways offsets from the straight line, in local units. */
  readonly v: Float32Array;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Multiplies every layer's stroke width (thinner forks). */
  readonly weight: number;
}

/** One stroke pass; bolts are drawn as a wide dim glow, then a body, then a thin white-hot core. */
export interface BoltLayer {
  readonly color: number;
  readonly width: number;
  readonly alpha: number;
}

/**
 * Midpoint displacement: 2^levels segments, offsets halving-ish at each level, so the arc has a
 * few big kinks and lots of small ones. Ends stay pinned on the line.
 */
export function bolt(x0: number, y0: number, x1: number, y1: number, levels: number, roughness: number, weight = 1): Bolt {
  const n = (1 << levels) + 1;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) u[i] = i / (n - 1);
  let amp = roughness;
  for (let step = n - 1; step > 1; step >>= 1) {
    const half = step >> 1;
    for (let i = half; i < n; i += step) v[i] = (v[i - half] + v[i + half]) / 2 + (Math.random() * 2 - 1) * amp;
    amp *= 0.55;
  }
  return { u, v, x0, y0, x1, y1, weight };
}

/** Local position of point `i` of a bolt. */
export function boltPoint(b: Bolt, i: number): { x: number; y: number } {
  const dx = b.x1 - b.x0;
  const dy = b.y1 - b.y0;
  const len = Math.hypot(dx, dy) || 1;
  return { x: b.x0 + dx * b.u[i] - (dy / len) * b.v[i], y: b.y0 + dy * b.u[i] + (dx / len) * b.v[i] };
}

export interface BoltFrame {
  /** World position of the local origin. */
  readonly x: number;
  readonly y: number;
  /** Mirrors local x (fighter facing). */
  readonly flip: 1 | -1;
  /** Local units -> px. */
  readonly scale: number;
  /** Bolts are cut off where local x passes this (a beam that is still growing). */
  readonly maxX?: number;
}

/** Strokes `bolts` into `g` (which should use additive blending), every layer for every bolt. */
export function drawBolts(g: Graphics, bolts: readonly Bolt[], f: BoltFrame, layers: readonly BoltLayer[]): void {
  const maxX = f.maxX ?? Infinity;
  for (const layer of layers) {
    for (const b of bolts) {
      if (b.x0 >= maxX) continue;
      let prev = boltPoint(b, 0);
      g.moveTo(f.x + f.flip * prev.x * f.scale, f.y + prev.y * f.scale);
      for (let i = 1; i < b.u.length; i++) {
        let p = boltPoint(b, i);
        const cut = p.x > maxX;
        if (cut) {
          const t = (maxX - prev.x) / (p.x - prev.x);
          p = { x: maxX, y: prev.y + (p.y - prev.y) * t };
        }
        g.lineTo(f.x + f.flip * p.x * f.scale, f.y + p.y * f.scale);
        if (cut) break;
        prev = p;
      }
      g.stroke({ color: layer.color, width: layer.width * b.weight, alpha: layer.alpha, cap: 'round', join: 'round' });
    }
  }
}

/** Arcs flung out from the origin at random angles within [from, to] (radians), lengths 0.5..1. */
export function radialArcs(count: number, from = -Math.PI, to = Math.PI, roughness = 0.16): Bolt[] {
  const out: Bolt[] = [];
  for (let i = 0; i < count; i++) {
    const a = from + Math.random() * (to - from);
    const len = 0.5 + Math.random() * 0.5;
    out.push(bolt(0, 0, Math.cos(a) * len, Math.sin(a) * len, 3, roughness, 0.6 + Math.random() * 0.4));
  }
  return out;
}

/**
 * Holds bolt geometry and re-rolls it every few tens of ms, so lightning flickers between shapes
 * instead of either freezing or boiling every frame.
 */
export class Crackle {
  private bolts: Bolt[] = [];
  private kind = '';
  private nextRoll = 0;

  constructor(private readonly flickerMs = 55) {}

  get(kind: string, time: number, roll: () => Bolt[]): readonly Bolt[] {
    if (kind !== this.kind || time >= this.nextRoll) {
      this.bolts = roll();
      this.kind = kind;
      this.nextRoll = time + this.flickerMs * (0.5 + Math.random());
    }
    return this.bolts;
  }
}
