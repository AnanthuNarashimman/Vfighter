import { Container, Graphics, Sprite, TilingSprite, type Texture } from 'pixi.js';
import { CATACLYSMS } from '../sim/constants';
import type { FighterState, GameState, Strike } from '../sim/state';
import { canvasTexture, dustPuff, glowSprite, groundBurst, lerp, mixColor, Particles, spawnCount } from './fx';
import { FIGHTER_HEIGHT, FLOOR_Y, type ViewLayout } from './layout';
import { bolt, boltPoint, type Bolt } from './lightning';
import { superCharge } from './supers';

/** Tempest's lightning strikes, as the simulation times and sizes them. */
const STRIKE = CATACLYSMS.thunder;

/** Lightning light: a white-hot channel, pale blue glow, violet bloom. */
const LIGHT = { core: 0xffffff, glow: 0xc4d4ff, bloom: 0x8e7cff, ground: 0xb8ccff } as const;
/** Stage painting at full storm: a sickly, desaturated blue-green dusk. A flash lights it cold white. */
const DARK_TINT = 0x2e3a3e;
const FLASH_TINT = 0xdfe8ff;
const FIGHTER_DARK_TINT = 0x6e7c84;
/** Clouds: near-black and heavy, lit from within by lightning. */
const CLOUD_TINT = 0x1c2226;
const CLOUD_LIT_TINT = 0x8f9cba;
/** Ground mist: a dark grey-green haze in the gloom, not a pale band. */
const FOG_TINT = 0x4e5c5e;
const MIST_HEIGHT = 160;
/** The storm rolls in over ~0.5s and clears over ~1.2s. */
const DARK_RISE = 2.4;
const DARK_FALL = 0.8;
/** How dark the world gets while the super is being wound up (of the full storm). */
const CHARGE_DARKNESS = 0.7;
/** Camera shake: max offset in px at full trauma; trauma drains per second. */
const SHAKE_PX = 14;
const SHAKE_DECAY = 1.9;
/** Lightning hidden in the clouds every this many seconds (much more often as the storm gathers). */
const CLOUD_FLICKER_EVERY = { min: 0.7, max: 2.6 } as const;
/** Ticks before the return stroke during which the stepped leader feels its way down. */
const LEADER_TICKS = 7;
const SCORCH_LIFE = 4;

/**
 * Brightness of a strike's channel per tick after it connects: the first return stroke, then the
 * repeat strokes down the same channel that make real lightning flicker, then nothing.
 */
const RETURN_STROKES = [1, 0.25, 0.9, 0.15, 0.7, 0.55, 0.1, 0.45, 0.05, 0.2, 0];

/**
 * Thunder's super, Tempest: an eerie dark storm. As the super is wound up, the world darkens, the
 * clouds sink and churn with flickers of hidden lightning, the wind drags dust in and static crawls
 * over the caster; when it lands the storm breaks with a strike on the horizon and a thunderclap.
 * Each strike of the storm then plays like the real thing: faint static gathers on the ground, a
 * stepped leader forks down out of the clouds, and when it connects the channel blazes white and
 * flickers through its return strokes, lighting everything, before a dull scorch and smoke remain.
 * Reads simulation state only.
 *
 * Layers: `sky` (screen space, over the background: gloom, clouds, distant lightning), `back`
 * (world, under the fighters), `front` (world, over them) and `overlay` (screen space, over the
 * world, under the HUD: ground mist, vignette, flash).
 */
export class StormView {
  readonly sky = new Container();
  readonly back = new Container();
  readonly front = new Container();
  readonly overlay = new Container();
  private readonly gloom = new Sprite(gloomTexture());
  private readonly cloudsFar = new TilingSprite({ texture: cloudTexture('far'), width: 1, height: 1 });
  private readonly cloudsNear = new TilingSprite({ texture: cloudTexture('near'), width: 1, height: 1 });
  /** Hidden lightning lighting a patch of cloud from inside. */
  private readonly cloudGlow = glowSprite('add', LIGHT.glow);
  private readonly skyBolts = new Graphics();
  private readonly mist = new TilingSprite({ texture: mistTexture(), width: 1, height: 1 });
  private readonly vignette = new Sprite(vignetteTexture());
  private readonly flashFill = new Graphics();
  private readonly particles = new Particles(1000);
  private readonly strikes = new Map<number, StrikeFx>();
  private readonly scorches: { sprite: Sprite; age: number }[] = [];
  private readonly auras = new Map<number, { glow: Sprite; arcs: Graphics; nextArcs: number; crawl: Bolt[] }>();
  /** A distant cloud-to-ground bolt on the horizon, while it lasts. */
  private skyBolt: { tree: Branch[]; age: number; scale: number } | null = null;
  private nextCloudFlicker = 1;
  /** Flashes and thunder still to come (repeat strokes; thunder lagging behind the light). */
  private readonly pending: { at: number; flash: number; rumble: number; cloudX?: number }[] = [];
  private dark = 0;
  private charge = 0;
  private flash = 0;
  private cloudLight = 0;
  private trauma = 0;
  private time = 0;
  private lastTempestTick = -1;
  private view: ViewLayout | null = null;

  constructor() {
    this.gloom.alpha = 0;
    for (const s of [this.cloudsFar, this.cloudsNear]) {
      s.alpha = 0;
      s.tint = CLOUD_TINT;
    }
    this.cloudGlow.alpha = 0;
    this.skyBolts.blendMode = 'add';
    this.mist.tint = FOG_TINT;
    this.mist.alpha = 0;
    this.vignette.alpha = 0;
    this.sky.addChild(this.gloom, this.skyBolts, this.cloudsFar, this.cloudGlow, this.cloudsNear);
    this.front.addChild(this.particles.root);
    this.overlay.addChild(this.mist, this.vignette, this.flashFill);
  }

  layout(view: ViewLayout): void {
    this.view = view;
    this.gloom.width = view.width;
    this.gloom.height = view.height;
    for (const s of [this.cloudsFar, this.cloudsNear]) s.width = view.width;
    // Exactly one tile tall: a tiling sprite repeats vertically too, which would stack copies.
    this.mist.width = view.width;
    this.mist.height = MIST_HEIGHT;
    this.mist.tileScale.set(MIST_HEIGHT / 128);
    this.mist.position.set(0, view.floorY - MIST_HEIGHT * 0.6);
    this.vignette.width = view.width;
    this.vignette.height = view.height;
  }

  /** Current camera shake offset; add to the world and background. */
  shake(): { x: number; y: number } {
    const amount = this.trauma * this.trauma * SHAKE_PX;
    return { x: (Math.random() * 2 - 1) * amount, y: (Math.random() * 2 - 1) * amount * 0.6 };
  }

  /** Tint for the stage painting: the storm's gloom, lit up by lightning (multiplies with other lighting). */
  backgroundTint(): number {
    return mixColor(mixColor(0xffffff, DARK_TINT, this.dark), FLASH_TINT, Math.min(1, this.flash) * this.dark);
  }

  /** Tint for fighters in the storm (multiplies with other lighting). */
  fighterTint(): number {
    return mixColor(mixColor(0xffffff, FIGHTER_DARK_TINT, this.dark), 0xffffff, Math.min(1, this.flash) * this.dark);
  }

  update(prev: GameState, curr: GameState, alpha: number, deltaMs: number): void {
    const dt = Math.min(deltaMs, 50) / 1000;
    this.time += deltaMs;
    const tempest = curr.cataclysms.find((c) => c.kind === 'thunder');

    // The storm gathers while the super is wound up and breaks when it lands.
    this.charge = 0;
    curr.fighters.forEach((f) => (this.charge = Math.max(this.charge, superCharge(f, 'thunder'))));
    const target = tempest ? 1 : this.charge * CHARGE_DARKNESS;
    this.dark += (target - this.dark) * Math.min(1, dt * (target > this.dark ? DARK_RISE : DARK_FALL));
    if (this.dark < 0.002) this.dark = 0;

    const tick = tempest?.tick ?? -1;
    if (tempest && (this.lastTempestTick < 0 || tick < this.lastTempestTick)) this.breakStorm();
    this.lastTempestTick = tick;

    this.runPending();
    this.updateSky(dt);
    curr.fighters.forEach((f, i) => this.updateBuildUp(i, prev.fighters[i] ?? f, f, alpha, dt));
    this.updateStrikes(
      curr.strikes.filter((s) => s.kind === 'thunder'),
      alpha,
      dt,
    );
    this.updateScorches(dt);

    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);
    this.flash = Math.max(0, this.flash - dt * 6);
    this.cloudLight = Math.max(0, this.cloudLight - dt * 5);
    this.drawFlash();
    this.particles.update(dt);
  }

  private addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * A flash of lightning: the light itself, its repeat strokes a few tens of ms apart, and the
   * thunder arriving `delay` seconds later (distance) with a shake of `rumble`.
   */
  private lightning(strength: number, delay: number, rumble: number, cloudX?: number): void {
    this.flash = Math.max(this.flash, strength);
    this.lightCloud(strength, cloudX);
    const now = this.time / 1000;
    this.pending.push({ at: now + 0.06, flash: strength * 0.3, rumble: 0, cloudX });
    this.pending.push({ at: now + 0.12 + Math.random() * 0.06, flash: strength * 0.8, rumble: 0, cloudX });
    if (Math.random() < 0.5) this.pending.push({ at: now + 0.26 + Math.random() * 0.1, flash: strength * 0.45, rumble: 0, cloudX });
    this.pending.push({ at: now + delay, flash: 0, rumble });
  }

  /** Light a patch of cloud from inside (around screen x `cloudX`, or a random spot). */
  private lightCloud(strength: number, cloudX?: number): void {
    if (!this.view) return;
    this.cloudLight = Math.max(this.cloudLight, strength);
    this.cloudGlow.position.set(cloudX ?? this.view.width * (0.1 + Math.random() * 0.8), this.view.height * (0.08 + Math.random() * 0.12));
    this.cloudGlow.width = 500 + Math.random() * 400;
    this.cloudGlow.height = 220 + Math.random() * 120;
  }

  private runPending(): void {
    const now = this.time / 1000;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.at > now) continue;
      if (p.flash) {
        this.flash = Math.max(this.flash, p.flash);
        this.lightCloud(p.flash, p.cloudX);
      }
      this.addTrauma(p.rumble);
      this.pending.splice(i, 1);
    }
  }

  /** The super lands and the storm breaks: a great bolt on the horizon and a thunderclap. */
  private breakStorm(): void {
    if (!this.view) return;
    const v = this.view;
    const x = v.width * (0.25 + Math.random() * 0.5);
    this.skyBolt = { tree: lightningTree(x + (Math.random() - 0.5) * 200, v.height * 0.12, x, v.floorY - 40, 1.2), age: 0, scale: 0.85 };
    this.lightning(1.4, 0.15, 0.9, x);
  }

  /** Gloom, sinking churning clouds lit from within, ground mist, vignette, lightning on the horizon. */
  private updateSky(dt: number): void {
    const d = this.dark;
    const v = this.view;
    if (!v) return;
    this.gloom.alpha = d;
    // The clouds sink in from above as the storm arrives, and roll slowly in opposite drifts.
    const cloudHeight = v.height * 0.5;
    for (const [s, scale, drift, a] of [
      [this.cloudsFar, 1, 6, 0.95],
      [this.cloudsNear, 1.3, -14, 1],
    ] as const) {
      s.height = cloudHeight * scale;
      s.tileScale.set((cloudHeight * scale) / 220);
      s.position.y = -cloudHeight * scale * (1 - d) * 0.8 - cloudHeight * (scale - 1) * 0.4;
      s.alpha = a * Math.min(1, d * 1.4);
      s.tilePosition.x += drift * dt * (1 + this.charge * 3);
      s.tint = mixColor(CLOUD_TINT, CLOUD_LIT_TINT, Math.min(1, this.cloudLight) * 0.7);
    }
    this.cloudGlow.alpha = Math.min(1, this.cloudLight) * 0.5 * d;
    this.mist.alpha = 0.45 * d;
    this.mist.tilePosition.x -= 12 * dt;
    this.vignette.alpha = d;

    // Lightning hidden in the clouds: rare when the storm is settled, constant as it gathers.
    if (d > 0.15) {
      this.nextCloudFlicker -= dt * (1 + this.charge * 5);
      if (this.nextCloudFlicker <= 0) {
        this.nextCloudFlicker = lerp(CLOUD_FLICKER_EVERY.min, CLOUD_FLICKER_EVERY.max, Math.random());
        if (d > 0.6 && Math.random() < 0.3) {
          // Now and then a bolt reaches the ground far off on the horizon.
          const x = v.width * (0.06 + Math.random() * 0.88);
          const tree = lightningTree(x + (Math.random() - 0.5) * 140, v.height * 0.15, x, v.floorY - 30 - Math.random() * 50, 0.7);
          this.skyBolt = { tree, age: 0, scale: 0.5 };
          this.lightning(0.6, 1 + Math.random(), 0.2, x);
        } else {
          this.lightning(0.25 + Math.random() * 0.35, 1.2 + Math.random() * 1.5, 0.1);
        }
      }
    }

    this.skyBolts.clear();
    if (this.skyBolt) {
      this.skyBolt.age += dt;
      const strokeIndex = Math.floor(this.skyBolt.age * 60);
      if (strokeIndex >= RETURN_STROKES.length) {
        this.skyBolt = null;
      } else {
        drawLightning(this.skyBolts, this.skyBolt.tree, 1, RETURN_STROKES[strokeIndex] * d, strokeIndex, this.skyBolt.scale);
      }
    }
  }

  /**
   * Winding up the super: a faint cold glow at the feet, static creeping over the body's outline,
   * the wind dragging dust in around the caster, and thunder growling under it all.
   */
  private updateBuildUp(i: number, prev: FighterState, f: FighterState, alpha: number, dt: number): void {
    const k = superCharge(f, 'thunder');
    let aura = this.auras.get(i);
    if (k <= 0) {
      if (aura) {
        aura.glow.visible = false;
        aura.arcs.clear();
      }
      return;
    }
    if (!aura) {
      aura = { glow: glowSprite('add', LIGHT.glow), arcs: new Graphics(), nextArcs: 0, crawl: [] };
      aura.arcs.blendMode = 'add';
      this.back.addChild(aura.glow);
      this.front.addChild(aura.arcs);
      this.auras.set(i, aura);
    }
    const x = lerp(prev.x, f.x, alpha);
    const y = FLOOR_Y - lerp(prev.y, f.y, alpha);
    aura.glow.visible = true;
    aura.glow.position.set(x, y);
    aura.glow.width = 120 + 140 * k;
    aura.glow.height = 26 + 16 * k;
    aura.glow.alpha = 0.45 * k * (0.7 + 0.3 * Math.random());
    this.addTrauma(0.25 * k * dt);

    // Static creeping over the body: short arcs hugging the outline, re-forming constantly.
    aura.arcs.clear();
    aura.nextArcs -= dt;
    if (aura.nextArcs <= 0) {
      aura.nextArcs = 0.04 + Math.random() * 0.05;
      aura.crawl = [];
      const count = 1 + Math.round(5 * k);
      for (let n = 0; n < count; n++) {
        const a = Math.random() * Math.PI * 2;
        const b = a + (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.4);
        const outline = (t: number) => ({
          x: Math.cos(t) * FIGHTER_HEIGHT * 0.2,
          y: -FIGHTER_HEIGHT * 0.52 + Math.sin(t) * FIGHTER_HEIGHT * 0.5,
        });
        const p0 = outline(a);
        const p1 = outline(b);
        aura.crawl.push(bolt(p0.x, p0.y, p1.x, p1.y, 4, 6, 0.4 + Math.random() * 0.4));
      }
    }
    drawBranches(aura.arcs, aura.crawl.map((b) => ({ bolt: b, from: 0, depth: 2 })), x, y, 0.6 + 0.4 * k, 1, 0.5);

    // The wind drags dust in, swirling around the caster.
    let n = spawnCount(40 * k * dt);
    while (n-- > 0) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const r = 160 + Math.random() * 200;
      dustPuff(this.particles, x + side * r, -side * (120 + Math.random() * 160) * (0.5 + k), -(10 + Math.random() * 40), 14 + Math.random() * 14);
    }
    // A few cold sparks drifting up off the body.
    n = spawnCount(14 * k * dt);
    while (n-- > 0) staticSpark(this.particles, x + (Math.random() - 0.5) * 70, y - Math.random() * FIGHTER_HEIGHT);
  }

  private updateStrikes(list: readonly Strike[], alpha: number, dt: number): void {
    const alive = new Set<number>();
    for (const s of list) {
      alive.add(s.id);
      let fx = this.strikes.get(s.id);
      if (!fx) {
        fx = new StrikeFx(s.x, this.skyTop());
        this.strikes.set(s.id, fx);
        this.back.addChild(fx.back);
        this.front.addChildAt(fx.front, 0);
      }
      const events = fx.update(s.age + alpha, dt, this.particles);
      if (events.charge) this.lightCloud(events.charge * 0.5, this.screenX(s.x));
      if (events.struck) {
        // Close lightning: the light and the crack of thunder arrive together.
        this.lightning(1.3, 0.03, 0.55, this.screenX(s.x));
        groundBurst(this.particles, s.x, 1.3);
        this.scorch(s.x);
      }
    }
    for (const [id, fx] of this.strikes) {
      if (alive.has(id)) continue;
      fx.destroy();
      this.strikes.delete(id);
    }
  }

  private scorch(x: number): void {
    const sprite = glowSprite('normal', 0x0c0e12);
    sprite.position.set(x, FLOOR_Y + 6);
    sprite.width = 150;
    sprite.height = 24;
    this.back.addChildAt(sprite, 0);
    this.scorches.push({ sprite, age: 0 });
  }

  private updateScorches(dt: number): void {
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const s = this.scorches[i];
      s.age += dt;
      if (s.age >= SCORCH_LIFE) {
        s.sprite.destroy();
        this.scorches.splice(i, 1);
        continue;
      }
      s.sprite.alpha = 0.8 * (1 - s.age / SCORCH_LIFE);
    }
  }

  /** World y just above the top of the screen, where bolts come from. */
  private skyTop(): number {
    return -(this.view?.worldY ?? 0) - 30;
  }

  private screenX(worldX: number): number {
    return worldX + (this.view?.worldX ?? 0);
  }

  private drawFlash(): void {
    const g = this.flashFill.clear();
    if (this.flash <= 0 || !this.view) return;
    g.rect(0, 0, this.view.width, this.view.height).fill({ color: LIGHT.glow, alpha: Math.min(1, this.flash) * 0.38 });
    this.flashFill.blendMode = 'add';
  }
}

/** One stroke of a lightning tree: a jagged path, where along its parent it starts (0..1), how deep a fork it is. */
interface Branch {
  bolt: Bolt;
  from: number;
  depth: number;
}

/**
 * A realistic lightning channel from (x0,y0) down to (x1,y1): a finely tortuous main stroke with
 * forks that split again, each level shorter, thinner and angled further out. `size` scales the
 * forks for distant bolts.
 */
function lightningTree(x0: number, y0: number, x1: number, y1: number, size = 1): Branch[] {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const main = bolt(x0, y0, x1, y1, 8, len * 0.075);
  const tree: Branch[] = [{ bolt: main, from: 0, depth: 0 }];
  const fork = (parent: Bolt, parentFrom: number, depth: number, count: number) => {
    for (let i = 0; i < count; i++) {
      // Forks leave from the upper part of their parent, heading down and outward.
      const at = 0.05 + Math.random() * 0.7;
      const p = boltPoint(parent, Math.floor(at * (parent.u.length - 1)));
      const side = Math.random() < 0.5 ? -1 : 1;
      const angle = (0.35 + Math.random() * 0.55 + depth * 0.15) * side;
      const l = (len * (0.12 + Math.random() * 0.2)) / (depth + 1) * size;
      const child = bolt(p.x, p.y, p.x + Math.sin(angle) * l, p.y + Math.cos(angle) * l, 5, l * 0.16, 1);
      const from = parentFrom + at * (1 - parentFrom);
      tree.push({ bolt: child, from, depth: depth + 1 });
      if (depth < 1) fork(child, from, depth + 1, Math.floor(Math.random() * 3));
    }
  };
  fork(main, 0, 0, 4 + Math.floor(Math.random() * 4));
  return tree;
}

/**
 * Draws a lightning tree. `progress` (0..1) is how far the leader has come down the main stroke;
 * forks grow out behind it. `brightness` is the return stroke's (0 = only the faint leader).
 * `stroke` counts ticks since the return stroke: forks only light up on the first one or two.
 */
function drawLightning(g: Graphics, tree: Branch[], progress: number, brightness: number, stroke: number, scale = 1): void {
  if (brightness <= 0.01) {
    drawBranches(g, tree, 0, 0, 0.35, progress, 0.5 * scale);
    return;
  }
  // The return stroke runs up the main channel only; the forks flash on the first stroke and die.
  const forkLight = stroke < 2 ? brightness * 0.6 : 0;
  const main = tree.filter((b) => b.depth === 0);
  const forks = tree.filter((b) => b.depth > 0);
  if (forkLight > 0.01) drawBranches(g, forks, 0, 0, forkLight, 1, 0.55 * scale);
  drawBranches(g, main, 0, 0, brightness, 1, 1.25 * scale);
}

/**
 * Strokes branches with a violet bloom, a pale blue glow and a white-hot core, thinning with
 * depth. Each branch is drawn only as far as `progress` has reached past its start.
 */
function drawBranches(g: Graphics, branches: readonly Branch[], ox: number, oy: number, brightness: number, progress: number, width: number): void {
  const layers = [
    { color: LIGHT.bloom, width: 22, alpha: 0.12 },
    { color: LIGHT.glow, width: 6, alpha: 0.55 },
    { color: LIGHT.core, width: 2, alpha: 1 },
  ];
  for (const layer of layers) {
    for (const b of branches) {
      const reach = b.from >= 1 ? 1 : Math.min(1, Math.max(0, (progress - b.from) / (1 - b.from)));
      const points = Math.floor(reach * (b.bolt.u.length - 1));
      if (points < 1) continue;
      const thin = 1 / (1 + b.depth * 0.9);
      let p = boltPoint(b.bolt, 0);
      g.moveTo(ox + p.x, oy + p.y);
      for (let i = 1; i <= points; i++) {
        p = boltPoint(b.bolt, i);
        g.lineTo(ox + p.x, oy + p.y);
      }
      g.stroke({
        color: layer.color,
        width: Math.max(0.6, layer.width * width * thin),
        alpha: Math.min(1, layer.alpha * brightness * (0.5 + 0.5 * thin)),
        cap: 'round',
        join: 'round',
      });
    }
  }
}

/** A cold spark of static: a tiny blue-white ember drifting up (or bursting out at `speed`). */
function staticSpark(particles: Particles, x: number, y: number, speed = 0): void {
  const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
  particles.emit({
    x,
    y,
    vx: speed ? Math.cos(angle) * speed * (0.3 + Math.random() * 0.7) : (Math.random() - 0.5) * 30,
    vy: speed ? Math.sin(angle) * speed * (0.3 + Math.random() * 0.7) : -(30 + Math.random() * 60),
    life: speed ? 0.3 + Math.random() * 0.35 : 0.6 + Math.random() * 0.6,
    size: 2.5 + Math.random() * 3,
    tint: LIGHT.core,
    tintEnd: LIGHT.bloom,
    alpha: 0.85,
    drag: speed ? 3 : 0.5,
    gravity: speed ? 500 : 0,
    ember: true,
  });
}

/**
 * One lightning strike. Before: faint static on the ground and the cloud above flickering. Then
 * the stepped leader forks its way down; when it connects, the channel blazes white and flickers
 * through its return strokes, the ground under it lit up. After: a dull glow, smoke, a scorch.
 */
class StrikeFx {
  readonly back = new Container();
  readonly front = new Container();
  private readonly pool = glowSprite('add', LIGHT.ground);
  private readonly channel = new Graphics();
  private readonly tree: Branch[];
  private struck = false;

  constructor(
    private readonly x: number,
    skyTop: number,
  ) {
    this.tree = lightningTree(x + (Math.random() - 0.5) * 160, skyTop, x, FLOOR_Y);
    this.pool.position.set(x, FLOOR_Y + 2);
    this.pool.alpha = 0;
    this.channel.blendMode = 'add';
    this.back.addChild(this.pool);
    this.front.addChild(this.channel);
  }

  /** `age` in ticks (fractional). `charge`: the cloud above lighting up as the leader forms. */
  update(age: number, dt: number, particles: Particles): { struck: boolean; charge: number } {
    const strikeAt = STRIKE.warnTicks;
    const events = { struck: false, charge: 0 };
    this.channel.clear();

    if (age < strikeAt) {
      const k = age / strikeAt;
      // Static gathering: a faint cold glow and a few sparks lifting off the spot.
      this.pool.width = 50 + 90 * k;
      this.pool.height = 14 + 10 * k;
      this.pool.alpha = 0.35 * k * (0.6 + 0.4 * Math.random());
      let n = spawnCount((3 + 22 * k) * dt);
      while (n-- > 0) staticSpark(particles, this.x + (Math.random() - 0.5) * 60, FLOOR_Y - Math.random() * 6);
      // The stepped leader feels its way down out of the clouds in the last few ticks.
      const leader = (age - (strikeAt - LEADER_TICKS)) / LEADER_TICKS;
      if (leader > 0) {
        drawLightning(this.channel, this.tree, Math.min(1, leader), 0, 0);
        events.charge = 0.3 + 0.4 * leader;
      } else if (Math.random() < 0.06 * k) {
        events.charge = 0.3 * k;
      }
      return events;
    }

    if (!this.struck) {
      this.struck = true;
      events.struck = true;
      for (let i = 0; i < 26; i++) staticSpark(particles, this.x, FLOOR_Y - 4, 520);
    }

    const stroke = Math.floor(age - strikeAt);
    const brightness = RETURN_STROKES[Math.min(RETURN_STROKES.length - 1, stroke)];
    drawLightning(this.channel, this.tree, 1, brightness, stroke);
    // The ground under the channel lit up with each stroke, then a fading glow.
    const after = Math.max(0, 1 - (age - strikeAt) / (STRIKE.activeTicks + STRIKE.fadeTicks));
    this.pool.width = 280;
    this.pool.height = 50;
    this.pool.alpha = Math.max(brightness, 0.25 * after);

    let n = spawnCount(12 * after * dt);
    while (n-- > 0) {
      particles.emit({
        x: this.x + (Math.random() - 0.5) * 40,
        y: FLOOR_Y - 4,
        vx: (Math.random() - 0.5) * 24,
        vy: -(35 + Math.random() * 40),
        life: 1.1 + Math.random() * 0.8,
        size: 16 + Math.random() * 14,
        tint: 0x30343c,
        tintEnd: 0x5c6068,
        grow: 2.8,
        alpha: 0.4,
        drag: 1,
        round: true,
        blend: 'normal',
      });
    }
    return events;
  }

  destroy(): void {
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
  }
}

/** The storm's gloom: almost black overhead, a heavy sickly blue-green toward the horizon. */
function gloomTexture(): Texture {
  return canvasTexture('storm-gloom', 4, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(3,5,8,0.92)');
    g.addColorStop(0.4, 'rgba(10,16,20,0.68)');
    g.addColorStop(0.75, 'rgba(22,32,36,0.45)');
    g.addColorStop(1, 'rgba(6,9,12,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
  });
}

/**
 * A strip of storm cloud that tiles sideways: a solid ceiling with heavy billows hanging lower and
 * lower, their undersides lumpy and ragged. White; tinted dark.
 */
function cloudTexture(kind: 'far' | 'near'): Texture {
  return canvasTexture(`storm-clouds-${kind}`, 512, 220, (ctx) => {
    const w = 512;
    const puff = (x: number, y: number, r: number, a: number) => {
      // Drawn across the seam so the strip tiles without a join.
      for (const off of [-w, 0, w]) {
        const g = ctx.createRadialGradient(x + off, y, 0, x + off, y, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(0.55, `rgba(255,255,255,${a * 0.65})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + off - r, y - r, r * 2, r * 2);
      }
    };
    const top = ctx.createLinearGradient(0, 0, 0, 100);
    top.addColorStop(0, 'rgba(255,255,255,1)');
    top.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, w, 100);
    const blobs = kind === 'far' ? 80 : 55;
    for (let i = 0; i < blobs; i++) {
      const depth = Math.random();
      puff(Math.random() * w, 30 + depth * 130, (kind === 'far' ? 28 : 40) + Math.random() * 42, 0.5 + 0.45 * (1 - depth));
    }
    // Feather the underside to nothing so puffs reaching the bottom edge never leave a straight cut.
    const fade = ctx.createLinearGradient(0, 0, 0, 220);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.7, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, 220);
    ctx.globalCompositeOperation = 'source-over';
  });
}

/**
 * Low mist that tiles sideways: soft uneven banks. It is feathered to nothing at the top and bottom
 * of the strip, so no straight edge can ever show (the sprite must not tile it vertically).
 */
function mistTexture(): Texture {
  return canvasTexture('storm-mist', 512, 128, (ctx) => {
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * 512;
      const y = 50 + Math.random() * 40;
      const r = 30 + Math.random() * 40;
      for (const off of [-512, 0, 512]) {
        const g = ctx.createRadialGradient(x + off, y, 0, x + off, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.2)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + off - r, y - r, r * 2, r * 2);
      }
    }
    // Feather the strip vertically: keep the middle, fade out completely toward both edges.
    const fade = ctx.createLinearGradient(0, 0, 0, 128);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(0.35, 'rgba(0,0,0,1)');
    fade.addColorStop(0.7, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, 512, 128);
    ctx.globalCompositeOperation = 'source-over';
  });
}

/** Darkness closing in from the edges of the screen. */
function vignetteTexture(): Texture {
  return canvasTexture('storm-vignette', 256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 182);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.6, 'rgba(0,2,4,0.35)');
    g.addColorStop(1, 'rgba(0,2,4,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}
