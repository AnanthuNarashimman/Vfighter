import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { CATACLYSMS, STAGE_WIDTH, TRAP } from '../sim/constants';
import type { Cataclysm, FighterState, GameState, Strike } from '../sim/state';
import { canvasTexture, coreSprite, dustPuff, easeOut, glowSprite, lerp, mixColor, Particles, ringTexture, spawnCount } from './fx';
import { drawBlob, drawDrop, GOO, GOO_ALPHA, GooDrops, gooSplash } from './gooView';
import { FIGHTER_HEIGHT, FLOOR_Y, type ViewLayout } from './layout';
import { superCharge } from './supers';

/** Written by scripts/build-sprites.mjs next to the giant's texture. */
export interface GiantMeta {
  readonly size: { readonly w: number; readonly h: number };
  /** Height of the body without the drips hanging below it, texture px. */
  readonly bodyHeight: number;
  readonly eyes: readonly { readonly x: number; readonly y: number }[];
}

/** The goo balls, as the simulation times and sizes them. */
const BALL = CATACLYSMS.goo;
const BALL_RADIUS = 44;
/** Ticks after a ball lands during which its crown of goo splashes up and its flash fades. */
const CROWN_TICKS = 14;

/**
 * The giant, as shares of the view height: its whole body's height, where its head ends up, and
 * the valley line it wades in (everything below is hidden in the mist).
 */
const GIANT = { height: 1.02, top: 0.03, base: 0.66 } as const;
/**
 * Where goo drips off the giant, in its texture (0..1 across and down): the open palms and
 * forearms, which drip the most, and the chest.
 */
const DRIP_SPOTS = [
  { u0: 0.0, u1: 0.3, v0: 0.4, v1: 0.6, weight: 0.4 },
  { u0: 0.7, u1: 1.0, v0: 0.4, v1: 0.6, weight: 0.4 },
  { u0: 0.35, u1: 0.65, v0: 0.25, v1: 0.55, weight: 0.2 },
] as const;

/**
 * The entrance, in seconds from the super landing: darkness falls, the giant heaves up out of the
 * valley, its eyes ignite, and it roars. Then the rain begins (the sim's firstStrike, ~2.1s).
 */
const ENTRANCE = { riseFrom: 0.2, riseTo: 2.0, eyes: 1.65, roar: 2.0 } as const;
/** Seconds for the giant to melt back into the valley once the super ends. */
const MELT_SECONDS = 1.7;

/** The world at full darkness: the painting sinks into a violet night, fighters into its gloom. */
const NIGHT_TINT = 0x3b3448;
const FIGHTER_NIGHT_TINT = 0x9a92ad;
/** Darkness falls over ~0.4s and lifts over ~1.5s. */
const DARK_RISE = 2.6;
const DARK_FALL = 0.7;
/** Ghostly backlight around the giant and the colour of its outline glow. */
const AURA = 0x8f7cff;
const EYE = { glow: 0xff2a14, core: 0xfff0e0 } as const;
/** Camera shake: max offset in px at full trauma; trauma drains per second. */
const SHAKE_PX = 18;
const SHAKE_DECAY = 1.4;
/** Offsets of the additive copies that make the giant's outline glow, px. */
const GLOW_RING = 6;
const GLOW_COPIES = 8;

interface Drip {
  x: number;
  y: number;
  vy: number;
  r: number;
}

interface Ring {
  sprite: Sprite;
  age: number;
  life: number;
  size: number;
}

/**
 * Goo's super, Goon Fall: Gooner's colossus made of goo, the most powerful thing on the field.
 *
 * Entrance: darkness falls; the ground shakes as the colossus heaves up out of the valley, goo
 * streaming off it; it faces the viewer with its arms spread and palms open; its eyes ignite blood
 * red; it roars (a flash, shockwaves across the screen, dust blasted off the floor). Then it looms
 * over the fight, breathing, eyes burning, while goo balls rain down. Each
 * one is targeted first: a pillar of light and a closing reticle on the ground, its shadow
 * tightening. It plunges out of the sky ever faster in a glowing trail and hits like a bomb: a flash,
 * a crown of goo bursting up, shockwaves along the ground, dust, a jolt of the screen, a spreading
 * splat. Anyone hit is held in a heap of goo with tendrils climbing their legs. When it ends the
 * colossus melts back into the valley and the night lifts. Nothing covers the play area, and no
 * name is shown. Reads simulation state only.
 *
 * Layers: `sky` (screen space, over the background: night, the colossus, mist), `back` (world,
 * under the fighters), `front` (world, over them) and `overlay` (screen space, over the world,
 * under the HUD: vignette, flash, shockwaves).
 */
export class ColossusView {
  readonly sky = new Container();
  readonly back = new Container();
  readonly front = new Container();
  readonly overlay = new Container();

  private readonly night = new Sprite(nightTexture());
  private readonly backlight = glowSprite('add', AURA);
  private readonly giant = new Container();
  private readonly giantMask = new Graphics();
  private readonly body: Sprite;
  private readonly glows: Sprite[] = [];
  private readonly eyeLight = glowSprite('add', EYE.glow);
  private readonly eyes: { glow: Sprite; core: Sprite; flare: Sprite }[] = [];
  private readonly mist = new Sprite(mistTexture());
  private readonly giantDrips = new Graphics();
  private readonly drizzle = new Graphics();

  private readonly shadows = new Graphics();
  /** Light on the ground and in the air: targeting pillars and reticles, trails, impact flashes. */
  private readonly targetLight = new Graphics();
  private readonly fallLight = new Graphics();
  /** Soft glows (balls' halos, impact flashes), handed out afresh each frame. */
  private readonly glowLayer = new Container();
  private glowsUsed = 0;
  private readonly balls = new Graphics();
  private readonly traps = new Graphics();
  private readonly drops = new GooDrops();
  private readonly dust = new Particles(400);

  private readonly vignette = new Sprite(vignetteTexture());
  private readonly flashFill = new Graphics();
  private readonly rings: Ring[] = [];

  private readonly drips: Drip[] = [];
  private readonly streaks: { x: number; y: number; len: number; speed: number }[] = [];
  /** Strikes already seen landing (for the one-off splat). */
  private readonly landed = new Set<number>();
  /** The running super (kept after it ends, for the melt), and how far the melt has got (0..1). */
  private last: Cataclysm | null = null;
  private melt = 1;
  private roared = false;
  private dark = 0;
  private flash = 0;
  private trauma = 0;
  private time = 0;
  private view: ViewLayout | null = null;

  constructor(
    texture: Texture,
    private readonly meta: GiantMeta,
  ) {
    this.night.alpha = 0;
    this.backlight.alpha = 0;
    this.body = new Sprite(texture);
    for (let i = 0; i < GLOW_COPIES; i++) {
      const glow = new Sprite(texture);
      glow.blendMode = 'add';
      glow.tint = AURA;
      this.glows.push(glow);
    }
    this.giant.addChild(...this.glows, this.body);
    this.giant.mask = this.giantMask;
    this.eyeLight.alpha = 0;
    for (let i = 0; i < meta.eyes.length; i++) {
      // Each eye: a hot core, its glow, and a long horizontal flare like a light caught in a lens.
      this.eyes.push({ glow: glowSprite('add', EYE.glow), core: coreSprite(EYE.core), flare: glowSprite('add', EYE.glow) });
    }
    this.mist.tint = 0x1c1726;
    this.drizzle.blendMode = 'add';
    this.sky.addChild(
      this.night,
      this.drizzle,
      this.backlight,
      this.giantMask,
      this.giant,
      this.eyeLight,
      ...this.eyes.flatMap((e) => [e.flare, e.glow, e.core]),
      this.giantDrips,
      this.mist,
    );
    this.sky.visible = false;

    this.targetLight.blendMode = 'add';
    this.fallLight.blendMode = 'add';
    this.back.addChild(this.drops.floor, this.shadows, this.targetLight);
    this.front.addChild(this.fallLight, this.glowLayer, this.balls, this.traps, this.dust.root, this.drops.air);

    this.vignette.alpha = 0;
    this.overlay.addChild(this.vignette, this.flashFill);
  }

  layout(view: ViewLayout): void {
    this.view = view;
    this.night.width = view.width;
    this.night.height = view.height;
    this.vignette.width = view.width;
    this.vignette.height = view.height;
    // Cut off a little below the valley line, inside the opaque band of the mist, so the edge never shows.
    this.giantMask.clear().rect(-50, -50, view.width + 100, view.height * (GIANT.base + 0.02) + 50).fill(0xffffff);
    // The mist thickens to fully opaque at the valley line, where the giant is cut off.
    this.mist.width = view.width + 100;
    this.mist.height = view.height * 0.34;
    this.mist.position.set(-50, view.height * GIANT.base - this.mist.height * 0.68);
  }

  /** Current camera shake offset; add to the world and background. */
  shake(): { x: number; y: number } {
    const amount = this.trauma * this.trauma * SHAKE_PX;
    return { x: (Math.random() * 2 - 1) * amount, y: (Math.random() * 2 - 1) * amount * 0.7 };
  }

  /** Tint for the stage painting (multiplies with other lighting). */
  backgroundTint(): number {
    return mixColor(mixColor(0xffffff, NIGHT_TINT, this.dark), 0xffffff, Math.min(1, this.flash) * this.dark);
  }

  /** Tint for the fighters (multiplies with other lighting). */
  fighterTint(): number {
    return mixColor(mixColor(0xffffff, FIGHTER_NIGHT_TINT, this.dark), 0xffffff, Math.min(1, this.flash));
  }

  update(prev: GameState, curr: GameState, alpha: number, deltaMs: number): void {
    const dt = Math.min(deltaMs, 50) / 1000;
    this.time += deltaMs;
    const colossus = curr.cataclysms.find((c) => c.kind === 'goo') ?? null;

    if (colossus) {
      if (!this.last || colossus.tick < this.last.tick) this.begin();
      this.last = colossus;
      this.melt = 0;
    } else if (this.last) {
      this.melt += dt / MELT_SECONDS;
      if (this.melt >= 1) this.last = null;
    }
    // Seconds into the super (frozen once it ends, while it melts).
    const t = this.last ? (this.last.tick + (colossus ? alpha : 0)) / 60 : 0;

    // Wind-up: the ground trembles and the night starts to fall.
    let charge = 0;
    curr.fighters.forEach((f) => (charge = Math.max(charge, superCharge(f, 'goo'))));
    if (charge > 0) this.trauma = Math.max(this.trauma, 0.3 * charge);
    const target = colossus ? 1 : this.last ? 1 - this.melt : charge * 0.55;
    this.dark += (target - this.dark) * Math.min(1, dt * (target > this.dark ? DARK_RISE : DARK_FALL));
    if (this.dark < 0.002) this.dark = 0;

    if (colossus && t >= ENTRANCE.riseFrom && t < ENTRANCE.riseTo) this.trauma = Math.max(this.trauma, 0.55);
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);

    this.drawGiant(t, colossus !== null, dt);
    if (colossus && !this.roared && t >= ENTRANCE.roar) this.roar();
    this.drawDrizzle(colossus !== null && t > ENTRANCE.roar, dt);
    this.drawStrikes(curr.strikes, alpha);
    this.drawTraps(prev, curr, alpha);
    this.drawOverlay(dt);
    this.drops.update(dt);
    this.dust.update(dt);
  }

  /** The super just landed: get the entrance ready. */
  private begin(): void {
    this.roared = false;
    this.flash = 0.5;
    this.trauma = 0.7;
  }

  /** The roar: a flash, shockwaves rolling out from its head, dust torn off the floor. */
  private roar(): void {
    this.roared = true;
    this.flash = 1;
    this.trauma = 1;
    const head = this.eyePoint(0);
    if (head) {
      const width = this.view?.width ?? 1280;
      for (let i = 0; i < 3; i++) this.ring(head.x, head.y, 0.9 + i * 0.25, width * (2.2 - i * 0.4), -i * 0.12);
    }
    for (let x = -100; x < STAGE_WIDTH + 100; x += 22) {
      const away = x < STAGE_WIDTH / 2 ? -1 : 1;
      dustPuff(this.dust, x, away * (200 + Math.random() * 300), -(40 + Math.random() * 120), 30 + Math.random() * 30);
    }
  }

  private ring(x: number, y: number, life: number, size: number, delay: number): void {
    const sprite = new Sprite(ringTexture());
    sprite.anchor.set(0.5);
    sprite.blendMode = 'add';
    sprite.tint = AURA;
    sprite.position.set(x, y);
    sprite.visible = false;
    this.overlay.addChildAt(sprite, 2);
    this.rings.push({ sprite, age: delay, life, size });
  }

  /** Screen position of eye `i`, while the giant is shown. */
  private eyePoint(i: number): { x: number; y: number } | null {
    const e = this.meta.eyes[i];
    if (!e || !this.body.visible) return null;
    return this.texturePoint(e.x, e.y);
  }

  /** Screen position of a point given in the giant's texture px (a sprite's local origin is its anchor). */
  private texturePoint(x: number, y: number): { x: number; y: number } {
    const { w, h } = this.meta.size;
    return this.body.toGlobal({ x: x - this.body.anchor.x * w, y: y - this.body.anchor.y * h });
  }

  private drawGiant(t: number, live: boolean, dt: number): void {
    const view = this.view;
    const shown = this.last !== null;
    this.sky.visible = view !== null && (shown || this.dark > 0 || this.drips.length > 0);
    this.night.alpha = this.dark;
    this.mist.alpha = Math.min(1, this.dark * 1.15);
    this.body.visible = this.giant.visible = shown;
    if (!view) return;

    // Rise: slow at first as it heaves itself up, then surging, then settling. Melt: it slumps and
    // spreads as it sinks back.
    const k = Math.min(1, Math.max(0, (t - ENTRANCE.riseFrom) / (ENTRANCE.riseTo - ENTRANCE.riseFrom)));
    const m = live ? 0 : Math.min(1, this.melt);
    const rise = shown ? k * k * (3 - 2 * k) * (1 - easeOut(m)) : 0;
    const scale = (view.height * GIANT.height) / this.meta.bodyHeight;
    const breathe = 1 + 0.014 * Math.sin(this.time * 0.0013);
    const finalTop = view.height * GIANT.top;
    const hiddenTop = view.height * (GIANT.base + 0.05);
    const top = lerp(hiddenTop, finalTop, rise) + Math.sin(this.time * 0.0011) * 4;
    // Front on, in the middle of the valley.
    const cx = view.width / 2;

    this.body.anchor.set(0.5, 0);
    this.body.position.set(cx, top);
    this.body.scale.set(scale * (1 + m * 0.25), scale * breathe * (1 - m * 0.3));
    this.body.rotation = 0.01 * Math.sin(this.time * 0.0008);
    this.glows.forEach((g, i) => {
      const a = (i / GLOW_COPIES) * Math.PI * 2;
      g.anchor.set(0.5, 0);
      g.position.set(cx + Math.cos(a) * GLOW_RING, top + Math.sin(a) * GLOW_RING);
      g.scale.copyFrom(this.body.scale);
      g.rotation = this.body.rotation;
      g.alpha = 0.14 + 0.05 * Math.sin(this.time * 0.003 + i);
    });
    this.backlight.position.set(cx, top + view.height * 0.3);
    this.backlight.width = view.height * 1.3;
    this.backlight.height = view.height * 1.1;
    this.backlight.alpha = 0.55 * rise * (0.85 + 0.15 * Math.sin(this.time * 0.002));

    // Eyes: ignite with a flare, then burn and pulse; they die first when it melts.
    const lit = live ? Math.min(1, Math.max(0, (t - ENTRANCE.eyes) / 0.12)) : Math.max(0, 1 - this.melt * 4);
    const ignite = live ? Math.max(0, 1 - Math.abs(t - ENTRANCE.eyes - 0.1) / 0.25) : 0;
    const pulse = 0.85 + 0.15 * Math.sin(this.time * 0.006) + (Math.random() - 0.5) * 0.08;
    // Sized from how far apart the eyes are on screen, whatever the texture's resolution.
    const [e0, e1] = this.meta.eyes;
    const eyeSize = e0 && e1 ? Math.hypot(e1.x - e0.x, e1.y - e0.y) * scale * 0.3 : scale * 10;
    const points = this.eyes.map((_, i) => this.eyePoint(i));
    this.eyes.forEach((e, i) => {
      const p = points[i];
      const on = p !== null && lit > 0;
      e.glow.visible = e.core.visible = e.flare.visible = on;
      if (!on) return;
      e.glow.position.set(p.x, p.y);
      e.glow.width = e.glow.height = eyeSize * (5 + 8 * ignite) * pulse;
      e.glow.alpha = lit;
      e.core.position.set(p.x, p.y);
      e.core.width = e.core.height = eyeSize * 1.2 * pulse;
      e.core.alpha = lit;
      e.flare.position.set(p.x, p.y);
      e.flare.width = eyeSize * (16 + 40 * ignite);
      e.flare.height = eyeSize * 1.2;
      e.flare.alpha = (0.5 + 0.5 * ignite) * lit;
    });
    const seen = points.filter((p): p is { x: number; y: number } => p !== null);
    this.eyeLight.visible = seen.length > 0 && lit > 0;
    if (this.eyeLight.visible) {
      // Red light spilling over the face.
      const mx = seen.reduce((s, p) => s + p.x, 0) / seen.length;
      const my = seen.reduce((s, p) => s + p.y, 0) / seen.length;
      this.eyeLight.position.set(mx, my + eyeSize * 3);
      this.eyeLight.width = this.eyeLight.height = eyeSize * 22;
      this.eyeLight.alpha = 0.35 * lit * pulse;
    }

    // Goo streaming off it: a torrent as it rises, a steady dripping after, a flood as it melts.
    const rate = !shown ? 0 : !live ? 50 : rise < 1 ? 40 : 7;
    const base = view.height * GIANT.base;
    let n = spawnCount(rate * dt);
    while (n-- > 0) {
      let pick = Math.random();
      const spot = DRIP_SPOTS.find((s) => (pick -= s.weight) < 0) ?? DRIP_SPOTS[0];
      const p = this.texturePoint(
        lerp(spot.u0, spot.u1, Math.random()) * this.meta.size.w,
        lerp(spot.v0, spot.v1, Math.random()) * this.meta.bodyHeight,
      );
      const r = (2 + Math.random() * 3.5) * (view.height / 620);
      if (p.y < base) this.drips.push({ x: p.x, y: p.y, vy: Math.random() * 60, r });
    }
    const g = this.giantDrips.clear();
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i];
      d.vy += 1100 * dt;
      d.y += d.vy * dt;
      if (d.y > base) {
        this.drips.splice(i, 1);
        continue;
      }
      drawDrop(g, d.x, d.y, 0, d.vy, d.r);
    }
  }

  /** A fine rain of goo streaking down through the dark while the balls fall. */
  private drawDrizzle(on: boolean, dt: number): void {
    const view = this.view;
    const g = this.drizzle.clear();
    if (!view) return;
    let n = on ? spawnCount(90 * dt) : 0;
    while (n-- > 0) {
      this.streaks.push({ x: Math.random() * (view.width + 200) - 100, y: -40, len: 20 + Math.random() * 40, speed: 900 + Math.random() * 700 });
    }
    const slant = 0.12;
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      s.y += s.speed * dt;
      s.x += s.speed * slant * dt;
      if (s.y > view.height * GIANT.base + 60) {
        this.streaks.splice(i, 1);
        continue;
      }
      g.moveTo(s.x, s.y).lineTo(s.x - s.len * slant, s.y - s.len);
    }
    if (this.streaks.length) g.stroke({ color: 0xd8d2ea, width: 1.5, alpha: 0.35 });
  }

  /**
   * Each goo ball, in three beats. Targeting: a thin pillar of light drops onto the spot and a
   * reticle closes in on it while the ball's shadow darkens and tightens. The plunge: the ball tears
   * down out of the sky, faster and faster (it covers most of the drop in the last few ticks),
   * stretched by its speed, dragging a glowing trail. Impact: a flash, a crown of goo bursting up,
   * two shockwaves racing out along the ground, dust, a jolt, then the splat spreading and soaking
   * away.
   */
  private drawStrikes(strikes: readonly Strike[], alpha: number): void {
    const s = this.shadows.clear();
    const light = this.targetLight.clear();
    const fall = this.fallLight.clear();
    this.glowsUsed = 0;
    const b = this.balls.clear();
    const top = -(this.view?.worldY ?? 0) - 200;
    const ground = FLOOR_Y + 4;
    const live = new Set<number>();
    for (const strike of strikes) {
      if (strike.kind !== 'goo') continue;
      live.add(strike.id);
      const age = strike.age + alpha;
      const x = strike.x;
      if (age < BALL.warnTicks) {
        const t = age / BALL.warnTicks;
        // Targeting: the pillar brightens, the reticle closes, the shadow gathers.
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.04 + strike.id);
        const pillar = 3 + 9 * t;
        light.rect(x - pillar, top, pillar * 2, ground - top).fill({ color: AURA, alpha: 0.05 + 0.12 * t });
        light.rect(x - pillar * 0.25, top, pillar * 0.5, ground - top).fill({ color: GOO.gloss, alpha: 0.05 + 0.2 * t });
        const rx = BALL.halfWidth * (2.6 - 1.6 * t);
        s.ellipse(x, ground, BALL.halfWidth * (1.6 - 0.6 * t), BALL.halfWidth * (1.6 - 0.6 * t) * 0.22).fill({ color: 0x05020a, alpha: 0.25 + 0.5 * t });
        light.ellipse(x, ground, rx, rx * 0.22).stroke({ color: AURA, width: 3, alpha: (0.4 + 0.5 * pulse) * (0.3 + 0.7 * t) });
        for (const side of [-1, 1]) {
          // Brackets either side of the reticle, closing in.
          light.moveTo(x + side * rx * 1.05, ground).lineTo(x + side * (rx * 1.05 + 14), ground);
        }
        light.stroke({ color: GOO.gloss, width: 2, alpha: 0.6 * t });

        // The plunge: slow at first, then it tears down (most of the drop in the last third).
        const y = lerp(top, FLOOR_Y - BALL_RADIUS, Math.pow(t, 3));
        const speed = 3 * t * t; // d(t³)/dt: how fast it is moving now, relative
        const trail = 40 + 320 * Math.min(1, speed);
        fall.poly([x - BALL_RADIUS * 0.9, y, x + BALL_RADIUS * 0.9, y, x, y - trail]).fill({ color: AURA, alpha: 0.35 });
        fall.poly([x - BALL_RADIUS * 0.4, y, x + BALL_RADIUS * 0.4, y, x, y - trail * 0.8]).fill({ color: GOO.gloss, alpha: 0.45 });
        this.glow(x, y, BALL_RADIUS * 4.5, AURA, 0.55);
        drawBlob(b, { x, y }, BALL_RADIUS, this.time, strike.id, 1.1, Math.min(0.85, 0.2 + speed * 0.3), 1, true);
        continue;
      }
      const since = age - BALL.warnTicks;
      if (!this.landed.has(strike.id)) {
        this.landed.add(strike.id);
        this.impact(x);
      }
      // Impact flash, and the crown of goo bursting up from the splat.
      if (since < CROWN_TICKS) {
        const c = since / CROWN_TICKS;
        this.glow(x, FLOOR_Y - 30, 120 + 380 * easeOut(c), GOO.gloss, 0.9 * (1 - c) * (1 - c));
        fall.ellipse(x, ground, 60 + 260 * easeOut(c), (60 + 260 * easeOut(c)) * 0.2).fill({ color: AURA, alpha: 0.35 * (1 - c) });
        drawCrown(b, x, FLOOR_Y + 2, BALL.halfWidth * (1 + 0.6 * easeOut(c)), 90 * Math.sin(Math.PI * Math.min(1, c * 1.2)), strike.id, 1 - c * c);
      }
      // Two shockwaves racing out along the ground.
      for (const [delay, reach] of [[0, 260], [4, 170]] as const) {
        const w = easeOut(Math.min(1, Math.max(0, since - delay) / 20));
        if (w <= 0 || w >= 1) continue;
        const r = 30 + reach * w;
        s.ellipse(x, ground, r, r * 0.2).stroke({ color: GOO.gloss, width: 4 * (1 - w) + 1, alpha: 0.7 * (1 - w) });
      }
      const k = Math.min(1, since / (BALL.activeTicks + BALL.fadeTicks));
      const spread = easeOut(Math.min(1, since / 8));
      drawMound(b, x, FLOOR_Y + 2, BALL.halfWidth * (1.4 + 1.1 * spread), 46 * (1 - spread * 0.6) * (1 - k), this.time, strike.id, 1 - k * k);
    }
    for (const id of this.landed) if (!live.has(id)) this.landed.delete(id);
    // Glows not needed this frame stay hidden until they are.
    this.glowLayer.children.forEach((c, i) => (c.visible = i < this.glowsUsed));
  }

  /** A soft additive glow for this frame only, `size` px across. */
  private glow(x: number, y: number, size: number, tint: number, alpha: number): void {
    let sprite = this.glowLayer.children[this.glowsUsed] as Sprite | undefined;
    if (!sprite) sprite = this.glowLayer.addChild(glowSprite('add'));
    this.glowsUsed++;
    sprite.position.set(x, y);
    sprite.width = sprite.height = size;
    sprite.tint = tint;
    sprite.alpha = alpha;
  }

  private impact(x: number): void {
    gooSplash(this.drops, x, FLOOR_Y - 20, 0, 40, 1.45);
    for (let i = 0; i < 14; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      dustPuff(this.dust, x + side * 20, side * (150 + Math.random() * 320), -(20 + Math.random() * 120), 26 + Math.random() * 24);
    }
    this.trauma = Math.min(1, this.trauma + 0.5);
  }

  /** Goo heaped around a trapped fighter's legs, tendrils climbing them; shrinks as the trap wears off. */
  private drawTraps(prev: GameState, curr: GameState, alpha: number): void {
    const g = this.traps.clear();
    curr.fighters.forEach((f: FighterState, i) => {
      if (f.trapped <= 0) return;
      const p = prev.fighters[i] ?? f;
      const x = lerp(p.x, f.x, alpha);
      const y = FLOOR_Y - lerp(p.y, f.y, alpha);
      const k = f.trapped / TRAP.ticks;
      const stuck = f.trapped > TRAP.ticks - TRAP.stuckTicks;
      const grow = Math.min(1, k * 1.6);
      const fade = Math.min(1, k * 4);
      const h = FIGHTER_HEIGHT * (stuck ? 0.24 : 0.1) * grow;
      const w = FIGHTER_HEIGHT * (stuck ? 0.7 : 0.55);
      // Tendrils of goo wrapped up the legs, swaying.
      const reach = FIGHTER_HEIGHT * (stuck ? 0.48 : 0.22) * grow;
      for (let j = 0; j < 4; j++) {
        const off = (j / 3 - 0.5) * w * 0.45;
        const sway = Math.sin(this.time * 0.004 + j * 1.9 + i) * 6;
        drawTendril(g, x + off, y - h * 0.5, x + off * 0.4 + sway, y - reach * (0.75 + 0.125 * (j % 3)), 7 * grow, fade);
      }
      drawMound(g, x, y + 3, w / 2, h, this.time, i * 7.3, fade);
      if (Math.random() < 0.2) this.drops.add(x + (Math.random() - 0.5) * w * 0.6, y - h * 0.7, 0, -40, 2 + Math.random() * 2);
    });
  }

  private drawOverlay(dt: number): void {
    const view = this.view;
    if (!view) return;
    // Kept light so nobody loses sight of the fight: soft edges, and a flash that never whites out.
    this.vignette.alpha = this.dark * 0.55;

    const f = this.flashFill.clear();
    if (this.flash > 0) f.rect(0, 0, view.width, view.height).fill({ color: 0xf4efff, alpha: Math.min(1, this.flash) * 0.5 });

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      if (r.age < 0) continue;
      const k = r.age / r.life;
      if (k >= 1) {
        r.sprite.destroy();
        this.rings.splice(i, 1);
        continue;
      }
      r.sprite.visible = true;
      r.sprite.width = r.sprite.height = r.size * easeOut(k);
      r.sprite.alpha = (1 - k) * 0.9;
    }
  }
}

/**
 * A heap of goo sitting on the ground at (`x`, `floor`): `halfWidth` wide either side, `height`
 * tall at the middle, with a wobbling top. Shaded base, body, gloss.
 */
function drawMound(g: Graphics, x: number, floor: number, halfWidth: number, height: number, time: number, seed: number, alpha: number): void {
  if (alpha <= 0.01 || halfWidth <= 1) return;
  const n = 22;
  const outline = (scale: number, lift: number): number[] => {
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * 2 - 1;
      const wob = 1 + 0.12 * Math.sin(u * 7 + time * 0.005 + seed) + 0.06 * Math.sin(u * 13 - time * 0.008 + seed);
      const top = Math.pow(Math.max(0, 1 - u * u), 0.35) * height * wob * scale;
      pts.push(x + u * halfWidth * scale, floor - top - lift);
    }
    // The base: a flat ellipse along the ground.
    for (let i = n; i >= 0; i--) {
      const u = (i / n) * 2 - 1;
      pts.push(x + u * halfWidth * scale, floor + Math.sqrt(Math.max(0, 1 - u * u)) * halfWidth * 0.12 - lift);
    }
    return pts;
  };
  g.poly(outline(1, 0)).fill({ color: GOO.shade, alpha: GOO_ALPHA * alpha }).stroke({ color: GOO.edge, width: 1.5, alpha: 0.5 * alpha });
  g.poly(outline(0.85, height * 0.12 + 1)).fill({ color: GOO.body, alpha: GOO_ALPHA * alpha });
  if (height > 6) {
    g.ellipse(x - halfWidth * 0.25, floor - height * 0.62, halfWidth * 0.22, Math.max(2, height * 0.12)).fill({ color: GOO.gloss, alpha: 0.85 * alpha });
  }
}

/**
 * The crown of a big splash: a ring of goo spikes bursting up from (`x`, `floor`), `halfWidth`
 * across, the tallest `height` px, each tipped with a bead about to fly off.
 */
function drawCrown(g: Graphics, x: number, floor: number, halfWidth: number, height: number, seed: number, alpha: number): void {
  if (height < 2 || alpha <= 0.01) return;
  const spikes = 9;
  for (let i = 0; i < spikes; i++) {
    const u = (i / (spikes - 1)) * 2 - 1;
    // Taller toward the middle, uneven, leaning outward.
    const h = height * (0.55 + 0.45 * Math.cos(u * 1.2)) * (0.75 + 0.25 * Math.sin(seed * 3.1 + i * 2.3));
    const bx = x + u * halfWidth;
    const tx = bx + u * h * 0.35;
    const ty = floor - h;
    const w = 6 + 4 * (1 - Math.abs(u));
    g.poly([bx - w, floor, bx + w, floor, tx + w * 0.3, ty, tx - w * 0.3, ty]).fill({ color: GOO.body, alpha: GOO_ALPHA * alpha }).stroke({ color: GOO.edge, width: 1, alpha: 0.45 * alpha });
    g.circle(tx, ty - w * 0.3, w * 0.75).fill({ color: GOO.body, alpha: GOO_ALPHA * alpha }).stroke({ color: GOO.edge, width: 1, alpha: 0.45 * alpha });
    g.circle(tx - w * 0.25, ty - w * 0.5, w * 0.25).fill({ color: GOO.gloss, alpha: 0.9 * alpha });
  }
}

/** A tendril of goo from (x0, y0) curling up to a thin tip at (x1, y1), `w` px thick at its root. */
function drawTendril(g: Graphics, x0: number, y0: number, x1: number, y1: number, w: number, alpha: number): void {
  if (w < 0.5 || alpha <= 0.01) return;
  const n = 10;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = lerp(x0, x1, t) + Math.sin(t * Math.PI) * (x1 - x0) * 0.6;
    const y = lerp(y0, y1, t);
    const half = w * (1 - t * 0.85);
    left.push(x - half, y);
    right.unshift(x + half, y);
  }
  g.poly([...left, ...right]).fill({ color: GOO.body, alpha: GOO_ALPHA * alpha }).stroke({ color: GOO.edge, width: 1, alpha: 0.45 * alpha });
}

/** The night sky laid over the painting: darkest overhead, thinning toward the valley. */
function nightTexture(): Texture {
  return canvasTexture('colossus-night', 4, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(8,4,18,0.85)');
    g.addColorStop(0.55, 'rgba(18,12,32,0.55)');
    g.addColorStop(1, 'rgba(18,12,32,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
  });
}

/** A low band of mist the giant wades in (hides where it is cut off), soft at top and bottom. */
function mistTexture(): Texture {
  return canvasTexture('colossus-mist', 4, 128, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.55, 'rgba(255,255,255,1)');
    g.addColorStop(0.78, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 128);
  });
}

/** Darkness closing in from the screen's edges. */
function vignetteTexture(): Texture {
  return canvasTexture('colossus-vignette', 256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 182);
    g.addColorStop(0, 'rgba(6,2,12,0)');
    g.addColorStop(1, 'rgba(6,2,12,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}
