import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { CATACLYSMS, STAGE_WIDTH } from '../sim/constants';
import type { FighterState, GameState, Strike } from '../sim/state';
import {
  canvasTexture,
  coreSprite,
  easeOut,
  glowSprite,
  groundBurst,
  lerp,
  mixColor,
  Particles,
  ringTexture,
  spawnCount,
} from './fx';
import { FIGHTER_HEIGHT, FLOOR_Y, type ViewLayout } from './layout';
import { bolt, drawBolts, type Bolt, type BoltLayer } from './lightning';
import { superCharge } from './supers';

/** Inferno's eruptions, as the simulation times and sizes them. */
const ERUPTION = CATACLYSMS.fire;
const ERUPTION_WARN_TICKS = ERUPTION.warnTicks;
const ERUPTION_ACTIVE_TICKS = ERUPTION.activeTicks;
const ERUPTION_FADE_TICKS = ERUPTION.fadeTicks;
const ERUPTION_HALF_WIDTH = ERUPTION.halfWidth;
const ERUPTION_HEIGHT = ERUPTION.height;

/** Lava, hottest first, then cooling crust and smoke. */
const LAVA = { white: 0xfff6d0, yellow: 0xffd25a, orange: 0xff7a1a, red: 0xe0300a, crust: 0x4a0a02 } as const;
const SMOKE = { dark: 0x241a16, light: 0x5e5048 } as const;
/** Background tint at full heat (multiplies the painting: keeps reds, burns off blue and green). */
const HOT_TINT = 0xff9a66;
/** Fighters are lit by the lava glow. */
const FIGHTER_HEAT_TINT = 0xffc2a0;
/** Heat rises over ~0.5s when the Inferno erupts, and cools over ~1s after it ends. */
const HEAT_RISE = 2.4;
const HEAT_FALL = 1.0;
/** Scorch marks left by eruptions fade over this many seconds. */
const SCORCH_LIFE = 4;
/** Camera shake: max offset in px at full trauma; trauma drains per second. */
const SHAKE_PX = 16;
const SHAKE_DECAY = 1.7;

const CRACK_LAYERS: readonly BoltLayer[] = [
  { color: LAVA.red, width: 9, alpha: 0.35 },
  { color: LAVA.orange, width: 3.5, alpha: 0.9 },
  { color: LAVA.yellow, width: 1.4, alpha: 1 },
];

/**
 * The fire super's Inferno: the world heats up (sky, background, fighters' light), lava cracks
 * glow across the floor, ash and embers drift, and each eruption plays out from a smoking,
 * spitting crack to a roaring lava column and fountain with a smoke plume, leaving a scorch.
 * Reads simulation state only.
 *
 * Layers: `sky` (screen space, over the background), `back` (world, under the fighters), `front`
 * (world, over them) and `flash` (screen space, over the world, under the HUD).
 */
export class InfernoView {
  readonly sky = new Container();
  readonly back = new Container();
  readonly front = new Container();
  readonly flash = new Container();
  private readonly skyGradient = new Sprite(skyTexture());
  private readonly horizon = glowSprite('add', LAVA.orange);
  private readonly floorCracks = new Sprite(floorCrackTexture());
  private readonly flashFill = new Graphics();
  private readonly particles = new Particles(1500);
  /** Ash and smoke sit under the lava (normal blending looks wrong over additive light). */
  private readonly smoke = new Particles(500);
  private readonly eruptions = new Map<number, EruptionFx>();
  private readonly scorches: { sprite: Sprite; age: number }[] = [];
  /** Shockwaves racing out along the floor from the slam. */
  private readonly shockwaves: { sprite: Sprite; age: number }[] = [];
  private readonly auras = new Map<number, Sprite>();
  private heat = 0;
  private trauma = 0;
  private flashAlpha = 0;
  private time = 0;
  private lastInfernoTick = -1;
  private view: ViewLayout | null = null;

  constructor() {
    this.skyGradient.alpha = 0;
    this.horizon.alpha = 0;
    this.floorCracks.anchor.set(0.5, 0);
    this.floorCracks.blendMode = 'add';
    this.floorCracks.tint = LAVA.orange;
    this.floorCracks.position.set(STAGE_WIDTH / 2, FLOOR_Y - 8);
    this.floorCracks.alpha = 0;
    this.sky.addChild(this.skyGradient, this.horizon);
    this.back.addChild(this.floorCracks);
    this.front.addChild(this.smoke.root, this.particles.root);
    this.flash.addChild(this.flashFill);
  }

  layout(view: ViewLayout): void {
    this.view = view;
    this.skyGradient.width = view.width;
    this.skyGradient.height = view.height;
    this.horizon.position.set(view.width / 2, view.floorY);
    this.horizon.width = view.width * 1.6;
    this.horizon.height = view.height * 0.5;
    // The floor strip spans the whole visible width (the world is centred in wider views).
    this.floorCracks.width = Math.max(view.width, STAGE_WIDTH) + 200;
    this.floorCracks.height = 70;
  }

  /** Current camera shake offset; apply to the world and background. */
  shake(): { x: number; y: number } {
    const amount = this.trauma * this.trauma * SHAKE_PX;
    return { x: (Math.random() * 2 - 1) * amount, y: (Math.random() * 2 - 1) * amount * 0.6 };
  }

  /** Tint for fighters standing in the heat (multiplies with other lighting). */
  fighterTint(): number {
    return mixColor(0xffffff, FIGHTER_HEAT_TINT, this.heat);
  }

  /** Tint for the stage painting (multiplies with other lighting). */
  backgroundTint(): number {
    return mixColor(0xffffff, HOT_TINT, this.heat);
  }

  update(prev: GameState, curr: GameState, alpha: number, deltaMs: number): void {
    const dt = Math.min(deltaMs, 50) / 1000;
    this.time += deltaMs;
    const inferno = curr.cataclysms.find((c) => c.kind === 'fire');

    // Heat: full while the Inferno burns; it starts building as a fire super is wound up.
    let target = inferno ? 1 : 0;
    curr.fighters.forEach((f) => (target = Math.max(target, superCharge(f, 'fire') * 0.45)));
    this.heat += (target - this.heat) * Math.min(1, dt * (target > this.heat ? HEAT_RISE : HEAT_FALL));
    if (this.heat < 0.002) this.heat = 0;

    // The slam that wakes the volcano.
    const tick = inferno?.tick ?? -1;
    if (inferno && (this.lastInfernoTick < 0 || tick < this.lastInfernoTick)) {
      const caster = curr.fighters[inferno.owner];
      if (caster) this.awaken(caster);
    }
    this.lastInfernoTick = tick;

    this.updateWorld();
    curr.fighters.forEach((f, i) => this.updateAura(i, prev.fighters[i] ?? f, f, alpha, dt));
    this.updateEruptions(
      curr.strikes.filter((s) => s.kind === 'fire'),
      alpha,
      dt,
    );
    this.updateScorches(dt);
    this.updateShockwaves(dt);
    this.ambient(dt);

    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.8);
    this.drawFlash();
    this.particles.update(dt);
    this.smoke.update(dt);
  }

  private addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  private updateWorld(): void {
    const h = this.heat;
    this.skyGradient.alpha = h;
    // The horizon and the floor glow breathe like something alive is down there.
    const breathe = 0.8 + 0.2 * Math.sin(this.time * 0.0021) + 0.08 * Math.sin(this.time * 0.0077);
    this.horizon.alpha = 0.35 * h * breathe;
    this.floorCracks.alpha = 0.75 * h * breathe;
    this.floorCracks.tint = mixColor(LAVA.red, LAVA.yellow, 0.35 + 0.25 * Math.sin(this.time * 0.003));
  }

  /** Ash drifting down and embers rising off the floor across the whole scene. */
  private ambient(dt: number): void {
    const h = this.heat;
    if (h <= 0.01) return;
    const left = -200;
    const width = (this.view?.width ?? STAGE_WIDTH) + 400;
    let n = spawnCount(28 * h * dt);
    while (n-- > 0) {
      ember(this.particles, left + Math.random() * width, FLOOR_Y + Math.random() * 10, 15 + Math.random() * 25, -(45 + Math.random() * 60));
    }
    n = spawnCount(30 * h * dt);
    while (n-- > 0) {
      this.smoke.emit({
        x: left + Math.random() * width,
        y: FLOOR_Y - 450 - Math.random() * 200,
        vx: 20 + Math.random() * 40,
        vy: 25 + Math.random() * 45,
        life: 3 + Math.random() * 2,
        size: 2 + Math.random() * 3,
        tint: 0x8a807a,
        tintEnd: 0x4a4440,
        grow: 1.3,
        alpha: 0.7,
        drag: 0.2,
        round: true,
        blend: 'normal',
      });
    }
  }

  /** Winding up the super: fire gathers around the body and the ground starts to glow and rumble. */
  private updateAura(i: number, prev: FighterState, f: FighterState, alpha: number, dt: number): void {
    const k = superCharge(f, 'fire');
    let glow = this.auras.get(i);
    if (k <= 0) {
      if (glow) glow.visible = false;
      return;
    }
    if (!glow) {
      glow = glowSprite('add', LAVA.orange);
      this.back.addChild(glow);
      this.auras.set(i, glow);
    }
    const x = lerp(prev.x, f.x, alpha);
    const y = FLOOR_Y - lerp(prev.y, f.y, alpha);
    glow.visible = true;
    glow.position.set(x, y);
    glow.width = 160 + 220 * k;
    glow.height = 40 + 30 * k;
    glow.alpha = 0.7 * k;
    this.addTrauma(0.6 * k * dt);

    // Flames licking up the body, more and taller as the heat gathers.
    let n = spawnCount((60 + 260 * k) * dt);
    while (n-- > 0) {
      const side = (Math.random() * 2 - 1) * FIGHTER_HEIGHT * 0.32;
      this.particles.emit({
        x: x + side,
        y: y - Math.random() * FIGHTER_HEIGHT * 0.25,
        vx: -side * 0.4,
        vy: -(140 + Math.random() * 220) * (0.6 + k),
        life: 0.35 + Math.random() * 0.35,
        size: 14 + Math.random() * 16,
        tint: Math.random() < 0.4 ? LAVA.white : LAVA.yellow,
        tintEnd: LAVA.crust,
        grow: 2.2,
        alpha: 0.5,
        drag: 1.4,
        round: true,
      });
    }
    // Embers lifting off the scorched ground around the feet as the heat gathers.
    n = spawnCount(45 * k * dt);
    while (n-- > 0) {
      ember(this.particles, x + (Math.random() - 0.5) * 220, y - Math.random() * 10, (Math.random() - 0.5) * 40, -(60 + Math.random() * 90));
    }
  }

  /** The super slams down: a white-hot flash, a shockwave along the ground, and a dust storm. */
  private awaken(caster: FighterState): void {
    this.flashAlpha = 0.85;
    this.addTrauma(0.85);
    const x = caster.x + caster.facing * FIGHTER_HEIGHT * 0.35;
    groundBurst(this.smoke, x, 2.4);
    const ring = new Sprite(ringTexture());
    ring.anchor.set(0.5);
    ring.tint = LAVA.orange;
    ring.blendMode = 'add';
    ring.position.set(x, FLOOR_Y);
    this.back.addChild(ring);
    this.shockwaves.push({ sprite: ring, age: 0 });
    for (let i = 0; i < 60; i++) {
      const angle = -Math.PI * (0.05 + Math.random() * 0.9);
      const speed = 300 + Math.random() * 700;
      this.particles.emit({
        x,
        y: FLOOR_Y - 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.4 + Math.random() * 0.5,
        size: 16 + Math.random() * 24,
        tint: Math.random() < 0.4 ? LAVA.white : LAVA.yellow,
        tintEnd: LAVA.crust,
        grow: 2,
        alpha: 0.6,
        drag: 2.2,
        gravity: 300,
        round: true,
      });
    }
  }

  private updateEruptions(list: readonly Strike[], alpha: number, dt: number): void {
    const alive = new Set<number>();
    for (const e of list) {
      alive.add(e.id);
      let fx = this.eruptions.get(e.id);
      if (!fx) {
        fx = new EruptionFx(e.x);
        this.eruptions.set(e.id, fx);
        this.back.addChild(fx.back);
        this.front.addChildAt(fx.front, 0);
      }
      const events = fx.update(e.age + alpha, dt, this.particles, this.smoke);
      if (events.rumble) this.addTrauma(events.rumble * dt);
      if (events.erupted) {
        this.addTrauma(0.55);
        groundBurst(this.smoke, e.x, 2);
        this.scorch(e.x);
      }
    }
    for (const [id, fx] of this.eruptions) {
      if (alive.has(id)) continue;
      fx.destroy();
      this.eruptions.delete(id);
    }
  }

  private scorch(x: number): void {
    const sprite = glowSprite('normal', 0x1a0c06);
    sprite.position.set(x, FLOOR_Y + 6);
    sprite.width = 230;
    sprite.height = 34;
    this.back.addChildAt(sprite, 1);
    this.scorches.push({ sprite, age: 0 });
  }

  /** The slam's shockwave: a flattened ring (seen along the floor) racing outward over 0.6s. */
  private updateShockwaves(dt: number): void {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.age += dt;
      const k = s.age / 0.6;
      if (k >= 1) {
        s.sprite.destroy();
        this.shockwaves.splice(i, 1);
        continue;
      }
      s.sprite.width = 80 + easeOut(k) * 1900;
      s.sprite.height = 30 + easeOut(k) * 130;
      s.sprite.alpha = 1 - k;
    }
  }

  /** Scorch marks left by eruptions fade slowly. */
  private updateScorches(dt: number): void {
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const s = this.scorches[i];
      s.age += dt;
      if (s.age >= SCORCH_LIFE) {
        s.sprite.destroy();
        this.scorches.splice(i, 1);
        continue;
      }
      s.sprite.alpha = 0.7 * (1 - s.age / SCORCH_LIFE);
    }
  }

  private drawFlash(): void {
    const g = this.flashFill.clear();
    if (this.flashAlpha <= 0 || !this.view) return;
    g.rect(0, 0, this.view.width, this.view.height).fill({ color: LAVA.yellow, alpha: this.flashAlpha * 0.55 });
    this.flashFill.blendMode = 'add';
  }
}

/**
 * A glowing ember carried on the heat: a soft point that sways and flickers as it rises and dims
 * from yellow to deep red. `depth` 0..1: nearer embers are bigger, brighter and faster.
 */
function ember(particles: Particles, x: number, y: number, vx: number, vy: number, depth = Math.random()): void {
  particles.emit({
    x,
    y,
    vx: vx * (0.6 + 0.6 * depth),
    vy: vy * (0.6 + 0.6 * depth),
    life: 1.4 + Math.random() * 1.8,
    size: 3 + depth * 5,
    tint: Math.random() < 0.4 ? LAVA.white : LAVA.yellow,
    tintEnd: LAVA.red,
    alpha: 0.55 + 0.4 * depth,
    drag: 0.4,
    ember: true,
  });
}

/** A small molten droplet: arcs and falls, cooling to crust and shrinking away. */
function droplet(particles: Particles, x: number, y: number, vx: number, vy: number): void {
  particles.emit({
    x,
    y,
    vx,
    vy,
    life: 0.45 + Math.random() * 0.4,
    size: 5 + Math.random() * 6,
    tint: LAVA.yellow,
    tintEnd: LAVA.crust,
    alpha: 0.9,
    gravity: 1300,
    drag: 0.3,
    round: true,
  });
}


/**
 * One eruption. Warn: a crack splits the floor and glows brighter, smoking and spitting sparks.
 * Active: a roaring lava column with a fountain of blobs that arc out and cool, and a dark smoke
 * plume off the top. Fade: the column sinks back, the fountain dribbles out.
 */
class EruptionFx {
  readonly back = new Container();
  readonly front = new Container();
  private readonly crack = new Graphics();
  private readonly crackBolts: Bolt[];
  private readonly pool = glowSprite('add', LAVA.orange);
  private readonly columnGlow = glowSprite('add', LAVA.red);
  private readonly columnBody = coreSprite(LAVA.orange);
  private readonly columnCore = coreSprite(LAVA.white);
  private erupted = false;

  constructor(private readonly x: number) {
    this.crack.blendMode = 'add';
    // The crack: jagged fissures splitting out along the floor from the vent.
    this.crackBolts = [];
    for (let i = 0; i < 7; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const len = 40 + Math.random() * 90;
      const end = { x: x + side * len, y: FLOOR_Y + (Math.random() - 0.3) * 22 };
      this.crackBolts.push(bolt(x + side * Math.random() * 8, FLOOR_Y + 2, end.x, end.y, 3, len * 0.15, 0.5 + Math.random() * 0.5));
    }
    this.pool.position.set(x, FLOOR_Y + 2);
    for (const s of [this.columnGlow, this.columnBody, this.columnCore]) s.anchor.set(0.5, 1);
    this.back.addChild(this.pool, this.crack);
    this.front.addChild(this.columnGlow, this.columnBody, this.columnCore);
    this.setColumn(0, 0);
  }

  /** `age` in ticks (fractional). Returns what the caller should react to. */
  update(age: number, dt: number, particles: Particles, smoke: Particles): { rumble: number; erupted: boolean } {
    const warnEnd = ERUPTION_WARN_TICKS;
    const activeEnd = warnEnd + ERUPTION_ACTIVE_TICKS;
    const end = activeEnd + ERUPTION_FADE_TICKS;
    const events = { rumble: 0, erupted: false };

    if (age < warnEnd) {
      const k = age / warnEnd;
      // Flickers faster as it gets ready to blow.
      const flicker = 0.75 + 0.25 * Math.sin(age * (0.4 + k * 1.4));
      this.drawCrack(k * flicker);
      this.pool.width = 50 + 150 * k;
      this.pool.height = 18 + 22 * k;
      this.pool.alpha = 0.9 * k * flicker;
      this.setColumn(0, 0);
      events.rumble = 0.25 + 0.6 * k;
      this.spit(k, dt, particles, smoke);
      return events;
    }

    if (!this.erupted) {
      this.erupted = true;
      events.erupted = true;
      this.blast(particles);
    }

    const crackFade = 1 - Math.max(0, (age - activeEnd) / ERUPTION_FADE_TICKS);
    this.drawCrack(crackFade);
    this.pool.width = 230;
    this.pool.height = 44;
    this.pool.alpha = 0.95 * crackFade;

    if (age < activeEnd) {
      // Shoots up almost instantly, then roars and wavers.
      const t = age - warnEnd;
      const rise = easeOut(Math.min(1, t / 4));
      const roar = 1 + 0.06 * Math.sin(age * 2.3) + (Math.random() - 0.5) * 0.08;
      this.setColumn(ERUPTION_HEIGHT * rise * roar, 1);
      this.fountain(1, dt, particles, smoke);
    } else {
      const k = Math.min(1, (age - activeEnd) / ERUPTION_FADE_TICKS);
      this.setColumn(ERUPTION_HEIGHT * (1 - easeOut(k)), 1 - k);
      this.fountain((1 - k) * 0.35, dt, particles, smoke);
      if (age >= end) this.setColumn(0, 0);
    }
    return events;
  }

  private drawCrack(k: number): void {
    this.crack.clear();
    if (k <= 0.01) return;
    drawBolts(
      this.crack,
      this.crackBolts,
      { x: 0, y: 0, flip: 1, scale: 1 },
      CRACK_LAYERS.map((l) => ({ ...l, alpha: l.alpha * k })),
    );
  }

  private setColumn(height: number, alpha: number): void {
    const visible = height > 2 && alpha > 0.01;
    for (const s of [this.columnGlow, this.columnBody, this.columnCore]) {
      s.visible = visible;
      s.position.set(this.x, FLOOR_Y + 6);
    }
    if (!visible) return;
    const w = ERUPTION_HALF_WIDTH * 2;
    this.columnGlow.width = w * 2.6;
    this.columnGlow.height = height * 1.25;
    this.columnGlow.alpha = 0.75 * alpha;
    this.columnBody.width = w * (1 + (Math.random() - 0.5) * 0.12);
    this.columnBody.height = height;
    this.columnBody.alpha = alpha;
    this.columnCore.width = w * 0.42;
    this.columnCore.height = height * 0.92;
    this.columnCore.alpha = alpha;
  }

  /** While cracking open: smoke seeps out and sparks spit, faster and faster. */
  private spit(k: number, dt: number, particles: Particles, smoke: Particles): void {
    let n = spawnCount((6 + 30 * k) * dt);
    while (n-- > 0) {
      smoke.emit({
        x: this.x + (Math.random() - 0.5) * 50,
        y: FLOOR_Y - 4,
        vx: (Math.random() - 0.5) * 30,
        vy: -(40 + Math.random() * 60),
        life: 0.9 + Math.random() * 0.8,
        size: 16 + Math.random() * 16,
        tint: SMOKE.dark,
        tintEnd: SMOKE.light,
        grow: 2.8,
        alpha: 0.45,
        drag: 1,
        round: true,
        blend: 'normal',
      });
    }
    // Molten droplets spat out of the crack, more and higher as it gets ready to blow; embers lift off it.
    n = spawnCount((4 + 34 * k * k) * dt);
    while (n-- > 0) {
      droplet(particles, this.x + (Math.random() - 0.5) * 36, FLOOR_Y - 2, (Math.random() - 0.5) * 140, -(180 + Math.random() * 320 * k));
    }
    n = spawnCount((3 + 14 * k) * dt);
    while (n-- > 0) {
      ember(particles, this.x + (Math.random() - 0.5) * 60, FLOOR_Y - 4, (Math.random() - 0.5) * 30, -(50 + Math.random() * 70));
    }
  }

  /** The moment it blows: a burst of white-hot lava in every upward direction. */
  private blast(particles: Particles): void {
    for (let i = 0; i < 46; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const speed = 350 + Math.random() * 750;
      particles.emit({
        x: this.x,
        y: FLOOR_Y - 6,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.5,
        size: 12 + Math.random() * 18,
        tint: LAVA.white,
        tintEnd: LAVA.crust,
        alpha: 0.8,
        grow: 1.4,
        gravity: 1300,
        drag: 0.6,
        round: true,
      });
    }
  }

  /**
   * The fountain: lava blobs flung up out of the column that arc over and fall, cooling from
   * white to crust as they go; streaking sparks; and a smoke plume rolling off the top.
   */
  private fountain(strength: number, dt: number, particles: Particles, smoke: Particles): void {
    if (strength <= 0.01) return;
    let n = spawnCount(380 * strength * dt);
    while (n-- > 0) {
      const spread = (Math.random() - 0.5) * 2;
      particles.emit({
        x: this.x + spread * ERUPTION_HALF_WIDTH * 0.6,
        y: FLOOR_Y - Math.random() * 40,
        vx: spread * (60 + Math.random() * 200),
        vy: -(650 + Math.random() * 600),
        life: 0.7 + Math.random() * 0.5,
        size: 12 + Math.random() * 20,
        tint: Math.random() < 0.35 ? LAVA.white : LAVA.yellow,
        tintEnd: LAVA.crust,
        alpha: 0.85,
        grow: 1.2,
        gravity: 1500,
        drag: 0.3,
        round: true,
      });
    }
    // Finer spray: small droplets flung wide off the column's sides.
    n = spawnCount(70 * strength * dt);
    while (n-- > 0) {
      const side = Math.random() < 0.5 ? -1 : 1;
      droplet(
        particles,
        this.x + side * ERUPTION_HALF_WIDTH * 0.5,
        FLOOR_Y - Math.random() * ERUPTION_HEIGHT * 0.7,
        side * (120 + Math.random() * 260),
        -(250 + Math.random() * 450),
      );
    }
    // Embers drift up off the top of the column into the smoke.
    n = spawnCount(40 * strength * dt);
    while (n-- > 0) {
      ember(
        particles,
        this.x + (Math.random() - 0.5) * ERUPTION_HALF_WIDTH * 2,
        FLOOR_Y - ERUPTION_HEIGHT * (0.75 + Math.random() * 0.3),
        (Math.random() - 0.5) * 60,
        -(90 + Math.random() * 110),
      );
    }
    n = spawnCount(70 * strength * dt);
    while (n-- > 0) {
      smoke.emit({
        x: this.x + (Math.random() - 0.5) * 60,
        y: FLOOR_Y - ERUPTION_HEIGHT * (0.7 + Math.random() * 0.35),
        vx: (Math.random() - 0.5) * 90,
        vy: -(90 + Math.random() * 120),
        life: 1.4 + Math.random() * 1,
        size: 34 + Math.random() * 30,
        tint: SMOKE.dark,
        tintEnd: SMOKE.light,
        grow: 3.2,
        alpha: 0.55,
        drag: 0.8,
        round: true,
        blend: 'normal',
      });
    }
  }

  destroy(): void {
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
  }
}

/** Sky over the stage at full heat: smoky dark red overhead fading to a hot orange haze at the horizon. */
function skyTexture(): Texture {
  return canvasTexture('inferno-sky', 4, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(46,4,0,0.78)');
    g.addColorStop(0.35, 'rgba(120,20,0,0.45)');
    g.addColorStop(0.72, 'rgba(255,90,20,0.28)');
    g.addColorStop(0.8, 'rgba(255,120,30,0.22)');
    g.addColorStop(1, 'rgba(60,8,0,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
  });
}

/** Glowing fissures criss-crossing the floor strip (white; tinted lava colours). */
function floorCrackTexture(): Texture {
  return canvasTexture('inferno-cracks', 1024, 70, (ctx) => {
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.shadowColor = 'rgba(255,255,255,1)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      // Mostly running along the floor, wandering and forking, denser near the front edge.
      let x = Math.random() * 1024;
      let y = 6 + Math.pow(Math.random(), 0.7) * 58;
      const steps = 5 + Math.floor(Math.random() * 9);
      ctx.lineWidth = 0.8 + Math.random() * 1.8;
      ctx.shadowBlur = 4 + Math.random() * 6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < steps; s++) {
        x += (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 30);
        y = Math.max(2, Math.min(68, y + (Math.random() - 0.5) * 12));
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
}
