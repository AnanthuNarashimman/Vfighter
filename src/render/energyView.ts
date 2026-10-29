import { Container, Graphics, Sprite, type Texture, TilingSprite } from 'pixi.js';
import { BEAM_MAX_LENGTH, GUARD_MAX, SHIELD_OPEN_TICKS, SHIELD_REACH } from '../sim/constants';
import { MOVES, MUZZLE, phaseAt } from '../sim/moves';
import type { FighterState, GameState, ProjectileState } from '../sim/state';
import type { EnergyStyle } from './characters';
import {
  canvasTexture,
  coreSprite,
  dustPuff,
  easeOut,
  glowSprite,
  groundBurst,
  lerp,
  Particles,
  ringTexture,
  setSize,
  spawnCount,
} from './fx';
import { FIGHTER_HEIGHT, FLOOR_Y } from './layout';
import { bolt, boltPoint, Crackle, drawBolts, radialArcs, type Bolt, type BoltFrame, type BoltLayer } from './lightning';

interface EnergyTheme {
  /** Colours, hottest first: white-hot core, body, outer fringe. */
  readonly core: number;
  readonly body: number;
  readonly fringe: number;
  /** Electric: jagged arcs crackle around charges, blasts and through the beam. */
  readonly lightning: boolean;
}

const THEMES: Readonly<Record<EnergyStyle, EnergyTheme>> = {
  fire: { core: 0xfff4d6, body: 0xffa63a, fringe: 0xff4a12, lightning: false },
  thunder: { core: 0xf4f9ff, body: 0x74bcff, fringe: 0x3f52ff, lightning: true },
};

/** Lightning bolt strokes at full strength, glow first. */
function boltLayers(t: EnergyTheme, s: number, k: number): BoltLayer[] {
  return [
    { color: t.fringe, width: 11 * s, alpha: 0.22 * k },
    { color: t.body, width: 4.5 * s, alpha: 0.8 * k },
    { color: t.core, width: 1.8 * s, alpha: k },
  ];
}

/** Lightning beams are generated over this many px and cut to the current beam length. */
const BOLT_SPAN = 2048;

/** Where the cupped hands hold the energy in the charge pose (fractions of FIGHTER_HEIGHT, like MUZZLE). */
const CHARGE_POINT = { x: 0.27, y: 0.66 } as const;

/** Beam layer thicknesses in px at full strength. */
const BEAM = { core: 14, body: 38, fringe: 104 };
/** Beam texture scroll speed, px per ms (energy visibly pours forward). */
const BEAM_FLOW = 2.2;
/** Muzzle flash length after a blast is released, in ticks (the blast's active phase). */
const FLASH_TICKS = MOVES.blast.phases[1].ticks;

const MAX_PARTICLES = 1200;

/**
 * Draws ki charges, blasts and beams. Purely cosmetic: reads simulation state and never writes it,
 * so the sparks may use unseeded randomness. `ground` holds light cast on the floor and belongs
 * beneath the fighters; `root` belongs above them.
 */
export class EnergyView {
  readonly ground = new Container();
  readonly root = new Container();
  private readonly fighters: FighterFx[] = [];
  private readonly projectiles = new Map<number, ProjectileFx>();
  private readonly particles = new Particles(MAX_PARTICLES);
  private readonly projectileLayer = new Container();
  private readonly clashes: ClashFx[] = [];
  /** Clash ids already shown (the sim keeps each clash listed for a few ticks). */
  private readonly seenClashes = new Set<number>();
  private readonly styles: EnergyStyle[] = [];
  /** Health seen last frame per fighter, to spot hits landing. */
  private readonly lastHealth: number[] = [];
  /** guardBrokenTick seen last frame per fighter, to spot guard breaks. */
  private readonly lastBroken: number[] = [];
  /** Per fighter: on the ground last frame, and vertical speed while last airborne (for landings). */
  private readonly lastGrounded: boolean[] = [];
  private readonly lastVy: number[] = [];
  private time = 0;

  constructor() {
    this.root.addChild(this.projectileLayer, this.particles.root);
  }

  /** Energy look for one fighter's charges, beams and (newly fired) blasts. */
  setStyle(fighter: number, style: EnergyStyle): void {
    this.styles[fighter] = style;
    this.fighters[fighter]?.setTheme(THEMES[style]);
  }

  private themeFor(fighter: number): EnergyTheme {
    return THEMES[this.styles[fighter] ?? 'fire'];
  }

  update(prev: GameState, curr: GameState, alpha: number, deltaMs: number): void {
    this.time += deltaMs;
    const dt = Math.min(deltaMs, 50) / 1000;

    curr.fighters.forEach((f, i) => {
      let fx = this.fighters[i];
      if (!fx) {
        fx = this.fighters[i] = new FighterFx(this.themeFor(i));
        this.ground.addChild(fx.ground);
        this.root.addChildAt(fx.root, 0);
      }
      fx.update(prev.fighters[i] ?? f, f, alpha, this.time, dt, this.particles);

      const lost = (this.lastHealth[i] ?? f.health) - f.health;
      this.lastHealth[i] = f.health;
      // Sparks in the attacker's colours, off the side of the body that took the hit.
      if (lost > 0) impact(this.particles, f, lost, this.themeFor(curr.fighters.length === 2 ? 1 - i : i));

      // A shield broken by a hit goes off like a blast of its own element (not one that just ran dry).
      if (f.guardBrokenTick < (this.lastBroken[i] ?? f.guardBrokenTick)) {
        const theme = this.themeFor(i);
        const x = f.x + f.facing * (SHIELD_REACH - SHIELD.rx * FIGHTER_HEIGHT * 0.5);
        const fx = new ClashFx(x, FLOOR_Y - (f.y + SHIELD.centreY * FIGHTER_HEIGHT), theme, theme, true, this.particles);
        this.clashes.push(fx);
        this.root.addChild(fx.root);
        this.ground.addChild(fx.ground);
      }
      this.lastBroken[i] = f.guardBrokenTick;

      // Takeoff: the push-off blasts dust out behind the jump. Landing: a ring of dust, heavier the
      // faster the fall (a knocked-out body hits hardest).
      const wasGrounded = this.lastGrounded[i] ?? f.grounded;
      if (wasGrounded && !f.grounded && f.vy > 0) groundBurst(this.particles, f.x, 0.9, -Math.sign(f.vx) * 0.6);
      if (!wasGrounded && f.grounded) {
        const fall = Math.abs(this.lastVy[i] ?? 0);
        groundBurst(this.particles, f.x, Math.min(1.8, fall / 12) + (f.action === 'ko' ? 0.6 : 0));
      }
      this.lastGrounded[i] = f.grounded;
      if (!f.grounded) this.lastVy[i] = f.vy;

      skidDust(this.particles, f, dt);
    });

    this.updateProjectiles(prev, curr, alpha, dt);
    this.updateClashes(curr, dt);
    this.particles.update(dt);
  }

  private updateClashes(curr: GameState, dt: number): void {
    const listed = new Set<number>();
    for (const c of curr.clashes) {
      listed.add(c.id);
      if (this.seenClashes.has(c.id)) continue;
      this.seenClashes.add(c.id);
      const [a, b] = c.owners.map((o) => this.themeFor(o));
      const fx = new ClashFx(c.x, FLOOR_Y - c.y, a, b ?? a, c.kind === 'beam', this.particles);
      this.clashes.push(fx);
      this.root.addChild(fx.root);
      this.ground.addChild(fx.ground);
    }
    for (const id of this.seenClashes) if (!listed.has(id)) this.seenClashes.delete(id);

    for (let i = this.clashes.length - 1; i >= 0; i--) {
      const fx = this.clashes[i];
      if (fx.update(dt, this.time)) continue;
      fx.destroy();
      this.clashes.splice(i, 1);
    }
  }

  private updateProjectiles(prev: GameState, curr: GameState, alpha: number, dt: number): void {
    const before = new Map(prev.projectiles.map((p) => [p.id, p]));
    const alive = new Set<number>();
    for (const p of curr.projectiles) {
      alive.add(p.id);
      let fx = this.projectiles.get(p.id);
      if (!fx) {
        const theme = this.themeFor(p.owner);
        fx = new ProjectileFx(theme);
        this.projectiles.set(p.id, fx);
        this.projectileLayer.addChild(fx.root);
        this.ground.addChild(fx.ground);
        burst(this.particles, p.x, FLOOR_Y - p.y, Math.sign(p.vx), theme);
      }
      fx.update(before.get(p.id) ?? p, p, alpha, this.time, dt, this.particles);
    }
    for (const [id, fx] of this.projectiles) {
      if (alive.has(id)) continue;
      fx.destroy();
      this.projectiles.delete(id);
    }
  }
}

/** Charge orb, muzzle flash and beam for one fighter. */
class FighterFx {
  readonly root = new Container();
  readonly ground = glowSprite();
  private readonly orbFringe = glowSprite('normal');
  private readonly orbGlow = glowSprite();
  private readonly orbCore = coreSprite();
  private readonly beam = new Container();
  private readonly beamFringe = new Sprite(profileTexture('soft'));
  private readonly beamBody = new TilingSprite({ texture: streakTexture(), width: 1, height: 1 });
  private readonly beamCore = new Sprite(profileTexture('sharp'));
  private readonly beamMuzzle = glowSprite();
  private readonly beamMuzzleCore = coreSprite();
  private readonly beamTip = glowSprite();
  private readonly beamTipCore = coreSprite();
  private readonly orb = new Container();
  /** Lightning arcs, drawn in world coordinates on top of everything else. */
  private readonly arcs = new Graphics();
  private readonly crackle = new Crackle();
  private readonly tipCrackle = new Crackle(40);
  private readonly shield = new ShieldFx();
  private theme!: EnergyTheme;

  constructor(theme: EnergyTheme) {
    this.beamFringe.anchor.set(0, 0.5);
    this.beamBody.anchor.set(0, 0.5);
    this.beamBody.blendMode = 'add';
    this.beamCore.anchor.set(0, 0.5);
    this.beamCore.blendMode = 'add';
    this.arcs.blendMode = 'add';
    this.setTheme(theme);
    this.beam.addChild(
      this.beamFringe,
      this.beamBody,
      this.beamCore,
      this.beamTip,
      this.beamTipCore,
      this.beamMuzzle,
      this.beamMuzzleCore,
    );
    this.orb.addChild(this.orbFringe, this.orbGlow, this.orbCore);
    this.root.addChild(this.shield.root, this.beam, this.orb, this.arcs);
    this.hide();
  }

  setTheme(theme: EnergyTheme): void {
    this.theme = theme;
    this.shield.setTheme(theme);
    for (const sp of [this.orbFringe, this.beamFringe]) sp.tint = theme.fringe;
    for (const sp of [this.ground, this.orbGlow, this.beamBody, this.beamMuzzle, this.beamTip]) sp.tint = theme.body;
    for (const sp of [this.orbCore, this.beamCore, this.beamMuzzleCore, this.beamTipCore]) sp.tint = theme.core;
  }

  update(prev: FighterState, curr: FighterState, alpha: number, time: number, dt: number, particles: Particles): void {
    this.hide();
    const x = lerp(prev.x, curr.x, alpha);
    const y = lerp(prev.y, curr.y, alpha);
    this.shield.update(curr, x, y, time, dt, particles);

    if (curr.action !== 'blast' && curr.action !== 'beam') return;
    const move = MOVES[curr.action];
    const phase = phaseAt(move, curr.actionTick, curr.moveSustained);
    if (!phase) return;

    const at = (pt: { x: number; y: number }) => ({
      x: x + curr.facing * pt.x * FIGHTER_HEIGHT,
      y: FLOOR_Y - (y + pt.y * FIGHTER_HEIGHT),
    });
    const t = phase.tick + alpha;

    if (phase.phase === 'startup') {
      const k = t / move.phases[0].ticks;
      this.charge(at(CHARGE_POINT), k, time, dt, particles);
    } else if (curr.action === 'beam') {
      // Beam length can only shrink when a new beam starts; never interpolate across that.
      const len = curr.beamLength >= prev.beamLength ? lerp(prev.beamLength, curr.beamLength, alpha) : curr.beamLength;
      let k = 1;
      if (phase.phase === 'active' && curr.actionTick - move.phases[0].ticks < 4) k = Math.min(1, (t + 1) / 4);
      if (phase.phase === 'recovery') k = Math.max(0, 1 - t / move.phases[2].ticks);
      this.drawBeam(at(MUZZLE), curr.facing, len, k, phase.phase === 'active', time, dt, particles);
    } else if (phase.phase === 'active') {
      const k = Math.max(0, 1 - t / FLASH_TICKS);
      this.flash(at(MUZZLE), curr.facing, k, time);
    }
  }

  private hide(): void {
    this.orb.visible = false;
    this.beam.visible = false;
    this.ground.visible = false;
    this.arcs.clear();
  }

  /** Energy gathering between the hands: a growing, unstable orb with sparks drawn inward. */
  private charge(p: { x: number; y: number }, k: number, time: number, dt: number, particles: Particles): void {
    const wobble = 1 + 0.12 * Math.sin(time * 0.05) + 0.08 * Math.sin(time * 0.13 + 2) + (Math.random() - 0.5) * 0.1;
    this.orb.visible = true;
    this.orb.position.set(p.x + (Math.random() - 0.5) * 2 * k, p.y + (Math.random() - 0.5) * 2 * k);
    setSize(this.orbFringe, (40 + 90 * k) * wobble);
    this.orbFringe.alpha = 0.25 * k;
    setSize(this.orbGlow, (24 + 70 * k) * wobble);
    this.orbGlow.alpha = 0.5 + 0.5 * k;
    setSize(this.orbCore, (6 + 26 * k) * wobble);
    this.orbCore.alpha = 0.6 + 0.4 * k;

    let n = spawnCount((40 + 160 * k) * dt);
    while (n-- > 0) {
      const angle = Math.random() * Math.PI * 2;
      const r = 50 + Math.random() * 60;
      const life = 0.18 + Math.random() * 0.14;
      particles.emit({
        x: p.x + Math.cos(angle) * r,
        y: p.y + Math.sin(angle) * r,
        vx: (-Math.cos(angle) * r) / life,
        vy: (-Math.sin(angle) * r) / life,
        life,
        size: 3 + Math.random() * 4,
        tint: Math.random() < 0.5 ? this.theme.core : this.theme.body,
        fadeIn: true,
      });
    }
    if (this.theme.lightning) {
      // Static building up: more and longer arcs snapping out of the orb as it charges.
      const bolts = this.crackle.get('charge', time, () => radialArcs(2 + Math.round(4 * k)));
      const frame = { x: this.orb.position.x, y: this.orb.position.y, flip: 1 as const, scale: 22 + 60 * k };
      drawBolts(this.arcs, bolts, frame, boltLayers(this.theme, 0.45 + 0.35 * k, 0.5 + 0.5 * k));
    }
    this.light(p.x, p.y, 140 + 80 * k, 0.28 * k);
  }

  /** Bright release flash at the palm as a blast leaves the hand. */
  private flash(p: { x: number; y: number }, facing: 1 | -1, k: number, time: number): void {
    if (k <= 0) return;
    this.orb.visible = true;
    this.orb.position.set(p.x, p.y);
    setSize(this.orbFringe, 200 * k);
    this.orbFringe.alpha = 0.35 * k;
    setSize(this.orbGlow, 150 * k);
    this.orbGlow.alpha = k;
    setSize(this.orbCore, 60 * k);
    this.orbCore.alpha = k;
    if (this.theme.lightning) {
      // A thunderclap: forks spray forward out of the palm.
      const bolts = this.crackle.get('flash', time, () => radialArcs(6, -0.9, 0.9, 0.2));
      drawBolts(this.arcs, bolts, { x: p.x, y: p.y, flip: facing, scale: 150 }, boltLayers(this.theme, 0.8, k));
    }
    this.light(p.x, p.y, 260, 0.4 * k);
  }

  private drawBeam(
    p: { x: number; y: number },
    facing: 1 | -1,
    len: number,
    k: number,
    firing: boolean,
    time: number,
    dt: number,
    particles: Particles,
  ): void {
    if (k <= 0 || len <= 0) return;
    // Thickness surges slightly and never holds perfectly still.
    const surge = 1 + 0.07 * Math.sin(time * 0.045) + 0.05 * Math.sin(time * 0.11 + 1.3) + (Math.random() - 0.5) * 0.05;
    const s = Math.sqrt(k) * surge;
    const start = -12;
    const length = len - start;

    this.beam.visible = true;
    this.beam.position.set(p.x, p.y);
    this.beam.scale.x = facing;

    const { lightning } = this.theme;

    this.beamFringe.position.x = start;
    this.beamFringe.width = length;
    this.beamFringe.height = BEAM.fringe * s;
    this.beamFringe.alpha = (lightning ? 0.3 : 0.45) * k;

    // A lightning beam is mostly its bolts; the smooth body stays as a faint charged channel.
    this.beamBody.position.x = start;
    this.beamBody.width = length;
    this.beamBody.height = BEAM.body * s;
    this.beamBody.tileScale.y = this.beamBody.height / STREAK_HEIGHT;
    this.beamBody.tilePosition.x = time * BEAM_FLOW;
    this.beamBody.alpha = (lightning ? 0.35 : 1) * k;

    this.beamCore.position.x = start;
    this.beamCore.width = length;
    this.beamCore.height = BEAM.core * s;
    this.beamCore.alpha = lightning ? 0 : k;

    if (lightning) this.drawBeamBolts(p, facing, len, s, k, time);

    setSize(this.beamMuzzle, 130 * s);
    this.beamMuzzle.alpha = k;
    setSize(this.beamMuzzleCore, 42 * s);
    this.beamMuzzleCore.alpha = k;

    // The head of the beam: a churning ball of energy pushing forward.
    const tipVisible = len < BEAM_MAX_LENGTH;
    this.beamTip.visible = this.beamTipCore.visible = tipVisible;
    this.beamTip.position.x = this.beamTipCore.position.x = len;
    setSize(this.beamTip, 150 * s * (1 + (Math.random() - 0.5) * 0.15));
    this.beamTip.alpha = k;
    setSize(this.beamTipCore, 56 * s);
    this.beamTipCore.alpha = k;

    const shown = Math.min(len, 1400);
    this.light(p.x + (facing * shown) / 2, p.y, shown + 240, 0.35 * k);

    if (!firing) return;
    // Sparks spraying off the palm and crackling along the beam's edges.
    let n = spawnCount(110 * dt);
    while (n-- > 0) {
      const speed = 250 + Math.random() * 450;
      const angle = (Math.random() - 0.5) * 1.3;
      particles.emit({
        x: p.x,
        y: p.y + (Math.random() - 0.5) * BEAM.body * 0.6,
        vx: facing * Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.15 + Math.random() * 0.25,
        size: 2 + Math.random() * 3,
        tint: Math.random() < 0.4 ? this.theme.core : this.theme.body,
        gravity: 500,
        drag: 3,
      });
    }
    n = spawnCount(Math.min(len, 1400) * 0.12 * dt);
    while (n-- > 0) {
      const side = Math.random() < 0.5 ? -1 : 1;
      particles.emit({
        x: p.x + facing * Math.random() * Math.min(len, 1400),
        y: p.y + side * BEAM.body * 0.45 * s,
        vx: facing * (100 + Math.random() * 250),
        vy: side * (40 + Math.random() * 120),
        life: 0.15 + Math.random() * 0.2,
        size: 2 + Math.random() * 3,
        tint: this.theme.body,
        drag: 4,
      });
    }
  }

  /** Twisting bolts running the length of the beam, forks snapping off it, and arcs around the head. */
  private drawBeamBolts(p: { x: number; y: number }, facing: 1 | -1, len: number, s: number, k: number, time: number): void {
    const bolts = this.crackle.get('beam', time, () => {
      const main = bolt(0, 0, BOLT_SPAN, 0, 7, 22);
      const out = [main, bolt(0, 0, BOLT_SPAN, 0, 7, 32, 0.55), bolt(0, 0, BOLT_SPAN, 0, 7, 32, 0.4)];
      for (let i = 0; i < 12; i++) {
        const from = boltPoint(main, 4 + Math.floor(Math.random() * (main.u.length - 4)));
        const a = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.7);
        const l = 30 + Math.random() * 90;
        out.push(bolt(from.x, from.y, from.x + Math.cos(a) * l, from.y + Math.sin(a) * l, 3, l * 0.18, 0.45));
      }
      return out;
    });
    drawBolts(this.arcs, bolts, { x: p.x, y: p.y, flip: facing, scale: 1, maxX: len }, boltLayers(this.theme, s, k));

    if (len >= BEAM_MAX_LENGTH) return;
    const tip = this.tipCrackle.get('tip', time, () => radialArcs(5));
    const frame = { x: p.x + facing * len, y: p.y, flip: facing, scale: 70 * s };
    drawBolts(this.arcs, tip, frame, boltLayers(this.theme, 0.7 * s, k));
  }

  /** Light thrown onto the floor below a source at height `y`. Lightning makes it flicker. */
  private light(x: number, y: number, width: number, strength: number): void {
    const falloff = Math.max(0, 1 - (FLOOR_Y - y) / 400);
    const flicker = this.theme.lightning ? 0.7 + Math.random() * 0.6 : 1;
    this.ground.visible = true;
    this.ground.position.set(x, FLOOR_Y + 4);
    this.ground.width = width;
    this.ground.height = 46;
    this.ground.alpha = strength * falloff * flicker;
  }
}

/**
 * Shield geometry, as fractions of FIGHTER_HEIGHT. It is projected from the outstretched palm of
 * the block pose (measured from both characters' block frames) and curves around in front of it:
 * a tall dome whose face stands at the sim's SHIELD_REACH, where blocked energy stops.
 */
const SHIELD = {
  palm: { x: 0.49, y: 0.725 },
  /** Dome: horizontal and vertical radius, vertical centre (below the palm, to cover the legs). */
  rx: 0.2,
  ry: 0.56,
  centreY: 0.56,
  /** The dome spans this many radians either side of straight ahead. */
  sweep: 1.25,
  /** Where blocked attacks strike the dome (energy flies at ~0.68 of the body: just above centre). */
  impactAngle: -0.22,
} as const;
/** A blocked hit's ripple runs across the dome for this long, seconds. */
const RIPPLE_LIFE = 0.38;
/** Shield flare after a blocked hit, ms. */
const SHIELD_FLARE_MS = 180;
/** Fire cools from white-hot to this deep ember red as it rises off the shield. */
const EMBER_RED = 0x7a1204;

type Point = { x: number; y: number };

/**
 * The guard shield, projected from the palm, one element per energy style.
 *
 * Fire: a dome of living flame. Billowing puffs rise off its face and cool from white-hot to deep
 * red, a hot rim ripples, embers drift up. Thunder: a plasma
 * barrier, lightning filaments wander from the palm out to a crackling rim like a plasma ball,
 * with a static haze filling the dome. Both unfold from the palm when raised, dim and sputter as
 * the guard runs low, flare on blocked hits (thunder's filaments all leap to the impact), and
 * burst apart on a guard break.
 */
class ShieldFx {
  readonly root = new Container();
  private readonly haze = glowSprite();
  private readonly sheet = glowSprite();
  private readonly palmGlow = glowSprite();
  private readonly palmCore = coreSprite();
  private readonly lines = new Graphics();
  private readonly crackle = new Crackle(45);
  private readonly rimCrackle = new Crackle(35);
  /** Where each plasma filament touches the rim; they wander. */
  private readonly filaments = [-0.9, -0.5, -0.15, 0.2, 0.55, 0.95, 0.05];
  private theme!: EnergyTheme;
  private readonly ripples: { sprite: Sprite; age: number }[] = [];
  private lastGuard = GUARD_MAX;
  /** guardBrokenTick seen last frame (null until the first frame), to spot a break. */
  private lastBroken: number | null = null;
  private flareMs = 0;

  constructor() {
    this.lines.blendMode = 'add';
    this.root.addChild(this.haze, this.sheet, this.lines, this.palmGlow, this.palmCore);
  }

  setTheme(theme: EnergyTheme): void {
    this.theme = theme;
    this.haze.tint = theme.fringe;
    this.sheet.tint = theme.body;
    this.palmGlow.tint = theme.body;
    this.palmCore.tint = theme.core;
  }

  update(f: FighterState, x: number, y: number, time: number, dt: number, particles: Particles): void {
    const t = this.theme;
    const H = FIGHTER_HEIGHT;
    const baseY = FLOOR_Y - y;
    /** Local frame: x forward from the body centre, y down from the feet (so bolts can use it). */
    const world = (p: Point): Point => ({ x: x + f.facing * p.x, y: baseY + p.y });
    const palm: Point = { x: SHIELD.palm.x * H, y: -SHIELD.palm.y * H };

    const blocking = f.action === 'block';
    const strength = f.guard / GUARD_MAX;
    // Unfold from the palm when raised; a drained guard shrinks the dome a little.
    const open = blocking ? easeOut(Math.min(1, (f.actionTick + 1) / SHIELD_OPEN_TICKS)) : 1;
    const size = open * (0.85 + 0.15 * strength);
    const rx = SHIELD.rx * H * size;
    const ry = SHIELD.ry * H * size;
    const full: Point = { x: SHIELD_REACH - SHIELD.rx * H, y: -SHIELD.centreY * H };
    const centre: Point = { x: lerp(palm.x, full.x, open), y: lerp(palm.y, full.y, open) };
    /** A point on the dome at angle `a` (0 = straight ahead, negative = up), pushed out by `dr` px. */
    const rim = (a: number, dr = 0): Point => ({
      x: centre.x + Math.cos(a) * (rx + dr),
      y: centre.y + Math.sin(a) * (ry + dr),
    });

    // Guard break: the shield bursts apart.
    if (this.lastBroken !== null && f.guardBrokenTick < this.lastBroken) this.shatter((a) => world(rim(a)), particles);
    this.lastBroken = f.guardBrokenTick;
    // A blocked hit costs far more guard per tick than holding the shield does.
    const lost = this.lastGuard - f.guard;
    this.lastGuard = f.guard;
    if (blocking && lost > 0.5) {
      this.flareMs = SHIELD_FLARE_MS;
      const big = lost >= 10; // a kick or blast; a beam grinds in small steps every tick
      const at = SHIELD.impactAngle + (Math.random() - 0.5) * (big ? 0.3 : 0.12);
      const hit = world(rim(at, 4));
      sparksOff(particles, hit, f.facing, big ? 26 : 3, t);
      this.disperse(rim, at, f.facing, big ? 1 : 0.12, particles, world);
      if (big) this.ripple(hit);
    }
    this.flareMs = Math.max(0, this.flareMs - dt * 1000);
    this.updateRipples(dt, ry);

    this.lines.clear();
    this.root.visible = blocking;
    if (!blocking) return;

    const flare = this.flareMs / SHIELD_FLARE_MS;
    // A weak guard sputters.
    const sputter = strength < 0.3 ? 0.4 + Math.random() * 0.6 : 1;
    const k = Math.min(1, (0.5 + 0.5 * strength) * sputter + flare * 0.6);

    const c = world(centre);
    this.haze.position.set(c.x, c.y);
    this.haze.width = rx * 3.6;
    this.haze.height = ry * 2.6;
    this.haze.alpha = (0.22 + 0.2 * flare) * k;
    // The face of the dome, seen nearly edge-on: a tall bright sheet hugging the rim.
    const face = world(rim(0, -rx * 0.35));
    this.sheet.position.set(face.x, face.y);
    this.sheet.width = rx * 1.7;
    this.sheet.height = ry * 2.15;
    this.sheet.alpha = (t.lightning ? 0.3 : 0.42) * k * (1 + flare * 0.5);

    const p = world(palm);
    const pulse = 1 + 0.12 * Math.sin(time * 0.03) + (Math.random() - 0.5) * 0.12;
    this.palmGlow.position.set(p.x, p.y);
    setSize(this.palmGlow, 70 * pulse * (1 + flare * 0.5));
    this.palmGlow.alpha = 0.8 * k;
    this.palmCore.position.set(p.x, p.y);
    setSize(this.palmCore, 22 * pulse);
    this.palmCore.alpha = k;

    const frame: BoltFrame = { x, y: baseY, flip: f.facing, scale: 1 };
    if (t.lightning) this.drawThunder(palm, rim, frame, world, k, flare, time, dt, particles);
    else this.drawFire(rim, world, f.facing, k, flare, time, dt, particles);
  }

  /**
   * Living flame: billowing puffs boil off the dome's face and the space inside it, rising and
   * cooling to ember red; a turbulent hot rim; embers.
   */
  private drawFire(
    rim: (a: number, dr?: number) => Point,
    world: (p: Point) => Point,
    facing: 1 | -1,
    k: number,
    flare: number,
    time: number,
    dt: number,
    particles: Particles,
  ): void {
    const t = this.theme;
    const strokePath = (pts: Point[], color: number, width: number, alpha: number) => {
      pts.forEach((pt, i) => {
        const w = world(pt);
        if (i === 0) this.lines.moveTo(w.x, w.y);
        else this.lines.lineTo(w.x, w.y);
      });
      this.lines.stroke({ color, width, alpha, cap: 'round', join: 'round' });
    };

    // Turbulent rim: two noise octaves crawl upward along it, so the edge licks like flame.
    const steps = 30;
    for (const layer of [
      { color: t.fringe, width: 12, alpha: 0.4, wobble: 7 },
      { color: t.body, width: 4.5, alpha: 0.9, wobble: 5 },
      { color: t.core, width: 1.8 + flare * 2, alpha: 1, wobble: 3 },
    ]) {
      const pts: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = -SHIELD.sweep + (2 * SHIELD.sweep * i) / steps;
        const dr = layer.wobble * (Math.sin(a * 8 + time * 0.02) + 0.55 * Math.sin(a * 19 + time * 0.037));
        pts.push(rim(a, dr));
      }
      strokePath(pts, layer.color, layer.width, layer.alpha * k);
    }

    // The flame body: puffs swell and rise off the face (most) and inside the dome (some).
    const puff = (onFace: boolean) => {
      const a = (Math.random() * 2 - 1) * SHIELD.sweep;
      const p = world(rim(a, onFace ? (Math.random() - 0.5) * 10 : -Math.random() * 0.8 * SHIELD.rx * FIGHTER_HEIGHT));
      particles.emit({
        x: p.x,
        y: p.y,
        vx: facing * (15 + Math.random() * 45),
        vy: -(90 + Math.random() * 110),
        life: 0.3 + Math.random() * 0.3,
        size: 12 + Math.random() * 14,
        tint: Math.random() < 0.5 ? t.core : t.body,
        tintEnd: EMBER_RED,
        grow: 2.3,
        alpha: 0.5,
        drag: 1.5,
        round: true,
      });
    };
    let n = spawnCount(230 * k * dt * (1 + flare));
    while (n-- > 0) puff(true);
    n = spawnCount(70 * k * dt);
    while (n-- > 0) puff(false);

    n = spawnCount(35 * k * dt);
    while (n-- > 0) {
      const p = world(rim((Math.random() * 2 - 1) * SHIELD.sweep));
      particles.emit({
        x: p.x,
        y: p.y,
        vx: facing * Math.random() * 60 + (Math.random() - 0.5) * 30,
        vy: -(80 + Math.random() * 160),
        life: 0.5 + Math.random() * 0.6,
        size: 2 + Math.random() * 2.5,
        tint: t.core,
        tintEnd: t.fringe,
        drag: 0.8,
      });
    }
  }

  /**
   * Plasma barrier: filaments of lightning wander from the palm out to the dome's rim (leaping
   * together to the point of impact on a hit), the rim itself crackles, sparks fizz where the
   * filaments touch it.
   */
  private drawThunder(
    palm: Point,
    rim: (a: number, dr?: number) => Point,
    frame: BoltFrame,
    world: (p: Point) => Point,
    k: number,
    flare: number,
    time: number,
    dt: number,
    particles: Particles,
  ): void {
    const t = this.theme;
    // Filament ends drift along the rim, like a plasma ball's.
    for (let i = 0; i < this.filaments.length; i++) {
      const a = this.filaments[i] + (Math.random() - 0.5) * 6 * dt;
      this.filaments[i] = Math.max(-SHIELD.sweep, Math.min(SHIELD.sweep, a));
    }
    const filaments = this.crackle.get('filaments', time, () =>
      this.filaments.map((a) => {
        // On impact every filament leaps to the struck point.
        const end = rim(flare > 0.4 ? (Math.random() - 0.5) * 0.35 : a);
        const len = Math.hypot(end.x - palm.x, end.y - palm.y);
        return bolt(palm.x, palm.y, end.x, end.y, 4, len * 0.12, 0.5 + Math.random() * 0.3);
      }),
    );
    drawBolts(this.lines, filaments, frame, boltLayers(t, 0.6 + flare * 0.6, k * 0.9));

    const segments = 9;
    const angle = (i: number, count: number) => -SHIELD.sweep + (2 * SHIELD.sweep * i) / count;
    const rimBolts = this.rimCrackle.get('rim', time, () => {
      const out: Bolt[] = [];
      for (let i = 0; i < segments; i++) {
        const p0 = rim(angle(i, segments));
        const p1 = rim(angle(i + 1, segments));
        out.push(bolt(p0.x, p0.y, p1.x, p1.y, 3, 6, 0.8));
      }
      return out;
    });
    drawBolts(this.lines, rimBolts, frame, boltLayers(t, 0.7 + flare * 0.4, k));
    // A smooth faint shell so the dome still reads between flickers.
    for (let i = 0; i <= 26; i++) {
      const w = world(rim(angle(i, 26)));
      if (i === 0) this.lines.moveTo(w.x, w.y);
      else this.lines.lineTo(w.x, w.y);
    }
    this.lines.stroke({ color: t.body, width: 6, alpha: 0.22 * k, cap: 'round' });

    // Sparks fizz off where the filaments touch the rim.
    let n = spawnCount(50 * k * dt * (1 + 2 * flare));
    while (n-- > 0) {
      const a = this.filaments[Math.floor(Math.random() * this.filaments.length)];
      const p = world(rim(a));
      const dir = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 200;
      particles.emit({
        x: p.x,
        y: p.y,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        life: 0.08 + Math.random() * 0.14,
        size: 1.5 + Math.random() * 2.5,
        tint: Math.random() < 0.6 ? t.core : t.body,
        drag: 6,
      });
    }
  }

  /**
   * The struck energy spreading out across the dome and thinning into the air: puffs run up and
   * down along the surface from the impact (tangent to it), drifting slightly outward.
   */
  private disperse(
    rim: (a: number, dr?: number) => Point,
    at: number,
    facing: 1 | -1,
    amount: number,
    particles: Particles,
    world: (p: Point) => Point,
  ): void {
    const t = this.theme;
    const p = world(rim(at));
    let n = spawnCount(28 * amount);
    while (n-- > 0) {
      // Tangent of the dome at `at` (local frame), either way along it, plus a little outward normal.
      const along = Math.random() < 0.5 ? -1 : 1;
      const tx = -Math.sin(at) * SHIELD.rx * along;
      const ty = Math.cos(at) * SHIELD.ry * along;
      const len = Math.hypot(tx, ty) || 1;
      const speed = 140 + Math.random() * 260;
      const out = 30 + Math.random() * 50;
      particles.emit({
        x: p.x,
        y: p.y,
        vx: facing * ((tx / len) * speed + Math.cos(at) * out),
        vy: (ty / len) * speed + Math.sin(at) * out,
        life: 0.25 + Math.random() * 0.25,
        size: 12 + Math.random() * 12,
        tint: Math.random() < 0.4 ? t.core : t.body,
        tintEnd: t.lightning ? t.fringe : EMBER_RED,
        grow: 2,
        alpha: 0.45,
        drag: 3.5,
        round: true,
      });
      if (t.lightning) {
        // Static skittering along the surface with it.
        particles.emit({
          x: p.x,
          y: p.y,
          vx: facing * (tx / len) * speed * 1.4,
          vy: (ty / len) * speed * 1.4,
          life: 0.1 + Math.random() * 0.12,
          size: 2 + Math.random() * 2,
          tint: t.core,
          drag: 4,
        });
      }
    }
  }

  /** A ring of disturbed energy spreading from the impact across the face of the dome. */
  private ripple(at: Point): void {
    const sprite = new Sprite(ringTexture());
    sprite.anchor.set(0.5);
    sprite.tint = this.theme.core;
    sprite.blendMode = 'add';
    sprite.position.set(at.x, at.y);
    this.root.addChild(sprite);
    this.ripples.push({ sprite, age: 0 });
  }

  /** Seen almost edge-on, a ripple is a narrow ellipse stretching up and down the dome as it spreads. */
  private updateRipples(dt: number, ry: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const k = r.age / RIPPLE_LIFE;
      if (k >= 1) {
        r.sprite.destroy();
        this.ripples.splice(i, 1);
        continue;
      }
      r.sprite.height = 30 + easeOut(k) * ry * 1.8;
      r.sprite.width = 18 + easeOut(k) * 26;
      r.sprite.alpha = (1 - k) * 0.9;
    }
  }

  private shatter(point: (a: number) => Point, particles: Particles): void {
    const t = this.theme;
    if (!t.lightning) {
      // Fire: the dome collapses in a gout of flame.
      for (let i = 0; i < 24; i++) {
        const p = point((Math.random() * 2 - 1) * SHIELD.sweep);
        particles.emit({
          x: p.x,
          y: p.y,
          vx: (Math.random() - 0.5) * 260,
          vy: -(60 + Math.random() * 200),
          life: 0.35 + Math.random() * 0.35,
          size: 20 + Math.random() * 22,
          tint: t.core,
          tintEnd: EMBER_RED,
          grow: 2.4,
          alpha: 0.6,
          drag: 2,
          round: true,
        });
      }
    }
    for (let i = 0; i < 46; i++) {
      const p = point((Math.random() * 2 - 1) * SHIELD.sweep);
      const angle = Math.random() * Math.PI * 2;
      const speed = 150 + Math.random() * 500;
      particles.emit({
        x: p.x,
        y: p.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.25 + Math.random() * 0.35,
        size: 3 + Math.random() * 5,
        tint: Math.random() < 0.5 ? t.core : t.body,
        drag: 3,
        gravity: t.lightning ? 0 : 500,
      });
    }
    const c = point(0);
    particles.emit({ x: c.x, y: c.y, vx: 0, vy: 0, life: 0.2, size: 260, tint: t.body, round: true });
  }
}

/** A spray of sparks thrown back off a surface facing `facing`. */
function sparksOff(particles: Particles, p: Point, facing: number, count: number, t: EnergyTheme): void {
  for (let i = 0; i < count; i++) {
    const angle = (Math.random() - 0.5) * 2.2;
    const speed = 150 + Math.random() * 450;
    particles.emit({
      x: p.x,
      y: p.y + (Math.random() - 0.5) * 60,
      vx: facing * Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.12 + Math.random() * 0.2,
      size: 2 + Math.random() * 4,
      tint: Math.random() < 0.5 ? t.core : t.body,
      drag: 5,
    });
  }
}

/**
 * A fired blast: a pulsing white-hot orb trailing a comet tail of embers, or for lightning a
 * crackling ball of arcs dragging a forked tail.
 */
class ProjectileFx {
  readonly root = new Container();
  readonly ground: Sprite;
  private readonly fringe: Sprite;
  private readonly glow: Sprite;
  private readonly core: Sprite;
  private readonly arcs = new Graphics();
  private readonly crackle = new Crackle(45);

  constructor(private readonly theme: EnergyTheme) {
    this.ground = glowSprite('add', theme.body);
    this.fringe = glowSprite('normal', theme.fringe);
    this.glow = glowSprite('add', theme.body);
    this.core = coreSprite(theme.core);
    this.arcs.blendMode = 'add';
    this.root.addChild(this.fringe, this.glow, this.core, this.arcs);
  }

  update(
    prev: ProjectileState,
    curr: ProjectileState,
    alpha: number,
    time: number,
    dt: number,
    particles: Particles,
  ): void {
    const x = lerp(prev.x, curr.x, alpha);
    const y = FLOOR_Y - lerp(prev.y, curr.y, alpha);
    const dir = Math.sign(curr.vx) || 1;
    const grow = Math.min(1, 0.55 + (curr.age + alpha) / 10);
    const pulse = 1 + 0.08 * Math.sin(time * 0.06 + curr.id) + (Math.random() - 0.5) * 0.08;
    const s = grow * pulse;

    this.root.position.set(x, y);
    // Stretched slightly along the direction of travel.
    this.fringe.width = 150 * s * 1.3;
    this.fringe.height = 150 * s;
    this.fringe.alpha = 0.3;
    this.glow.width = 96 * s * 1.35;
    this.glow.height = 96 * s;
    this.core.width = 40 * s * 1.25;
    this.core.height = 40 * s;
    this.core.position.x = dir * 4;

    const { lightning } = this.theme;
    if (lightning) {
      this.arcs.clear();
      const bolts = this.crackle.get('ball', time, () => [
        ...radialArcs(5),
        // Forked tail lashing out behind the ball.
        bolt(0, 0, -2.4, (Math.random() - 0.5) * 0.6, 4, 0.3, 0.8),
        bolt(0, 0, -1.6, (Math.random() - 0.5) * 1.2, 3, 0.3, 0.5),
      ]);
      drawBolts(this.arcs, bolts, { x: 0, y: 0, flip: dir < 0 ? -1 : 1, scale: 48 * s }, boltLayers(this.theme, 0.75, 1));
    }

    const speed = curr.vx * 60;
    let n = spawnCount((lightning ? 50 : 150) * dt);
    while (n-- > 0) {
      particles.emit({
        x: x - dir * Math.random() * 14,
        y: y + (Math.random() - 0.5) * 22 * s,
        vx: speed * (0.15 + Math.random() * 0.25),
        vy: (Math.random() - 0.5) * 60,
        life: 0.12 + Math.random() * 0.16,
        size: (22 + Math.random() * 26) * s,
        tint: Math.random() < 0.3 ? this.theme.fringe : this.theme.body,
        round: true,
      });
    }
    n = spawnCount((lightning ? 90 : 40) * dt);
    while (n-- > 0) {
      particles.emit({
        x,
        y: y + (Math.random() - 0.5) * 20,
        vx: -speed * (0.1 + Math.random() * 0.3),
        vy: (Math.random() - 0.5) * (lightning ? 420 : 240),
        life: 0.2 + Math.random() * 0.25,
        size: 2 + Math.random() * 3,
        tint: this.theme.core,
        drag: lightning ? 5 : 2,
        gravity: lightning ? 0 : 300,
      });
    }

    this.ground.position.set(x, FLOOR_Y + 4);
    this.ground.width = 260;
    this.ground.height = 40;
    const flicker = lightning ? 0.7 + Math.random() * 0.6 : 1;
    this.ground.alpha = 0.32 * flicker * Math.max(0, 1 - (FLOOR_Y - y) / 400);
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.ground.destroy();
  }
}

/** A ring of sparks thrown off when a blast leaves the hand. */
function burst(particles: Particles, x: number, y: number, dir: number, theme: EnergyTheme): void {
  for (let i = 0; i < 26; i++) {
    const angle = (Math.random() - 0.5) * Math.PI * 1.4;
    const speed = 200 + Math.random() * 500;
    particles.emit({
      x,
      y,
      vx: dir * Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.2 + Math.random() * 0.3,
      size: 2 + Math.random() * 4,
      tint: Math.random() < 0.5 ? theme.core : theme.body,
      drag: 4,
      gravity: theme.lightning ? 0 : 400,
    });
  }
}

/** Seconds a clash burst lasts. */
const CLASH_LIFE = 0.42;

/**
 * Two energies cancelling: a short pop of light, a shockwave ring in each side's colour, sparks,
 * and a haze that drifts apart. Lightning adds a crackle of arcs. Beams meeting pop a bit bigger.
 */
class ClashFx {
  readonly root = new Container();
  readonly ground: Sprite;
  private readonly flash: Sprite;
  private readonly core: Sprite;
  private readonly ringA = new Sprite(ringTexture());
  private readonly ringB = new Sprite(ringTexture());
  private readonly arcs = new Graphics();
  private readonly crackle = new Crackle(40);
  private readonly lightning: EnergyTheme | null;
  private readonly size: number;
  private age = 0;

  constructor(
    private readonly x: number,
    private readonly y: number,
    a: EnergyTheme,
    b: EnergyTheme,
    big: boolean,
    particles: Particles,
  ) {
    this.size = big ? 1.35 : 1;
    this.lightning = a.lightning ? a : b.lightning ? b : null;
    this.flash = glowSprite('add', a.core);
    this.core = coreSprite(0xffffff);
    this.ground = glowSprite('add', a.body);
    for (const [ring, t] of [[this.ringA, a], [this.ringB, b]] as const) {
      ring.anchor.set(0.5);
      ring.tint = t.body;
      ring.blendMode = 'add';
    }
    this.arcs.blendMode = 'add';
    this.root.position.set(x, y);
    this.root.addChild(this.flash, this.ringA, this.ringB, this.core, this.arcs);

    const themes = [a, b];
    for (let i = 0; i < 30 * this.size; i++) {
      const t = themes[i % 2];
      const angle = Math.random() * Math.PI * 2;
      const speed = 200 + Math.random() * 520;
      particles.emit({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.15 + Math.random() * 0.25,
        size: 2 + Math.random() * 4,
        tint: Math.random() < 0.4 ? t.core : t.body,
        drag: 5,
        gravity: t.lightning ? 0 : 300,
      });
    }
    // The diffuse part: soft puffs of spent energy drifting outward and fading.
    for (let i = 0; i < 12 * this.size; i++) {
      const t = themes[i % 2];
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 130;
      particles.emit({
        x: x + Math.cos(angle) * 10,
        y: y + Math.sin(angle) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 30,
        life: 0.35 + Math.random() * 0.3,
        size: (40 + Math.random() * 40) * this.size,
        tint: t.fringe,
        drag: 2.5,
        round: true,
      });
    }
  }

  /** Returns false once finished. */
  update(dt: number, time: number): boolean {
    this.age += dt;
    const k = this.age / CLASH_LIFE;
    if (k >= 1) return false;
    const out = 1 - (1 - k) * (1 - k) * (1 - k); // ease-out
    const fade = 1 - k;
    const s = this.size;

    setSize(this.flash, 190 * s * (1 - 0.5 * k));
    this.flash.alpha = Math.max(0, 1 - k * 2.5);
    setSize(this.core, 60 * s * Math.max(0, 1 - k * 3));
    this.core.alpha = Math.max(0, 1 - k * 3);
    setSize(this.ringA, (30 + 170 * out) * s);
    this.ringA.alpha = fade * 0.9;
    setSize(this.ringB, (20 + 120 * out) * s);
    this.ringB.alpha = fade * 0.7;

    this.arcs.clear();
    if (this.lightning && k < 0.55) {
      const bolts = this.crackle.get('clash', time, () => radialArcs(7));
      const frame = { x: 0, y: 0, flip: 1 as const, scale: (60 + 70 * out) * s };
      drawBolts(this.arcs, bolts, frame, boltLayers(this.lightning, 0.7, 1 - k / 0.55));
    }

    this.ground.position.set(this.x, FLOOR_Y + 4);
    this.ground.width = 300 * s;
    this.ground.height = 44;
    this.ground.alpha = 0.4 * fade * Math.max(0, 1 - (FLOOR_Y - this.y) / 400);
    return true;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.ground.destroy();
  }
}

/** Slides slower than this (px per tick) don't raise dust. */
const SKID_MIN_SPEED = 1.2;

/**
 * Dust ploughed up by a fighter sliding across the ground (shoved, knocked back, or braced behind
 * a shield): the heels dig in and push a wave of dust ahead of them along the slide.
 */
function skidDust(particles: Particles, f: FighterState, dt: number): void {
  if (!f.grounded) return;
  const slide = f.vx + f.shove;
  // Walking moves at a steady vx too; only count slides (shoves, knockback, blocked-hit pushback).
  const sliding = f.shove !== 0 || f.action === 'hit' || f.action === 'block' || f.action === 'ko';
  const speed = Math.abs(slide);
  if (!sliding || speed < SKID_MIN_SPEED) return;
  const dir = Math.sign(slide);
  // The leading heel (on the side the body slides toward) ploughs.
  const heel = f.x + dir * (20 + Math.random() * 25);
  let n = spawnCount(speed * 26 * dt);
  while (n-- > 0) {
    dustPuff(particles, heel, dir * (60 + Math.random() * 90) + slide * 30, -(30 + Math.random() * 110), 18 + Math.random() * 20);
  }
}

/** Sparks bursting off a fighter who just lost `damage` health; big hits get a big spray. */
function impact(particles: Particles, f: FighterState, damage: number, theme: EnergyTheme): void {
  const x = f.x + f.facing * FIGHTER_HEIGHT * 0.12;
  const y = FLOOR_Y - (f.y + FIGHTER_HEIGHT * 0.62);
  const big = damage >= 20;
  const count = big ? 34 : 3;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (big ? 250 : 150) + Math.random() * (big ? 650 : 250);
    particles.emit({
      x: x + (Math.random() - 0.5) * 20,
      y: y + (Math.random() - 0.5) * 40,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.12 + Math.random() * 0.22,
      size: 3 + Math.random() * (big ? 5 : 3),
      tint: Math.random() < 0.5 ? theme.core : theme.body,
      drag: 5,
    });
  }
  if (big) {
    // One bright flare at the point of contact.
    particles.emit({ x, y, vx: 0, vy: 0, life: 0.12, size: 120, tint: theme.core, round: true });
  }
}

/** A cross-section of the beam: stretched along its length. */
function profileTexture(kind: 'soft' | 'sharp'): Texture {
  const stops: [number, number][] =
    kind === 'soft'
      ? [[0, 0], [0.25, 0.2], [0.5, 1], [0.75, 0.2], [1, 0]]
      : [[0, 0], [0.3, 0.05], [0.42, 0.85], [0.5, 1], [0.58, 0.85], [0.7, 0.05], [1, 0]];
  return canvasTexture(`profile-${kind}`, 8, 64, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    for (const [at, a] of stops) g.addColorStop(at, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 64);
  });
}

const STREAK_HEIGHT = 32;

/** Tileable streaks of energy that scroll along the beam's body. */
function streakTexture(): Texture {
  return canvasTexture('streaks', 256, STREAK_HEIGHT, (ctx) => {
    const w = 256;
    const h = STREAK_HEIGHT;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      // Streaks cluster toward the middle of the beam.
      const yy = h / 2 + ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * h * 0.9;
      const edge = 1 - Math.abs(yy - h / 2) / (h / 2);
      const x0 = Math.random() * w;
      const len = 30 + Math.random() * 140;
      ctx.strokeStyle = `rgba(255,255,255,${(0.25 + Math.random() * 0.6) * edge})`;
      ctx.lineWidth = 1 + Math.random() * 2;
      // Draw twice so streaks crossing the right edge wrap around and the texture tiles seamlessly.
      for (const off of [0, -w]) {
        ctx.beginPath();
        ctx.moveTo(x0 + off, yy);
        ctx.lineTo(x0 + off + len, yy);
        ctx.stroke();
      }
    }
  });
}
