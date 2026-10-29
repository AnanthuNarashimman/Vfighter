import { Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import { BEAM_MAX_LENGTH } from '../sim/constants';
import { MOVES, MUZZLE, phaseAt } from '../sim/moves';
import type { FighterState, GameState, ProjectileState } from '../sim/state';
import type { EnergyStyle } from './characters';
import { FIGHTER_HEIGHT, FLOOR_Y } from './layout';
import { bolt, boltPoint, Crackle, drawBolts, radialArcs, type BoltLayer } from './lightning';

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

const MAX_PARTICLES = 700;

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
  private readonly particles = new Particles();
  private readonly projectileLayer = new Container();
  private readonly clashes: ClashFx[] = [];
  /** Clash ids already shown (the sim keeps each clash listed for a few ticks). */
  private readonly seenClashes = new Set<number>();
  private readonly styles: EnergyStyle[] = [];
  /** Health seen last frame per fighter, to spot hits landing. */
  private readonly lastHealth: number[] = [];
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
    this.root.addChild(this.beam, this.orb, this.arcs);
    this.hide();
  }

  setTheme(theme: EnergyTheme): void {
    this.theme = theme;
    for (const sp of [this.orbFringe, this.beamFringe]) sp.tint = theme.fringe;
    for (const sp of [this.ground, this.orbGlow, this.beamBody, this.beamMuzzle, this.beamTip]) sp.tint = theme.body;
    for (const sp of [this.orbCore, this.beamCore, this.beamMuzzleCore, this.beamTipCore]) sp.tint = theme.core;
  }

  update(prev: FighterState, curr: FighterState, alpha: number, time: number, dt: number, particles: Particles): void {
    this.hide();
    if (curr.action !== 'blast' && curr.action !== 'beam') return;
    const move = MOVES[curr.action];
    const phase = phaseAt(move, curr.actionTick, curr.moveSustained);
    if (!phase) return;

    const x = lerp(prev.x, curr.x, alpha);
    const y = lerp(prev.y, curr.y, alpha);
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

interface ParticleSpec {
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
}

interface Particle extends Required<ParticleSpec> {
  sprite: Sprite;
  maxLife: number;
}

/** Simple pooled sparks and embers with additive blending. */
class Particles {
  readonly root = new Container();
  private readonly live: Particle[] = [];
  private readonly pool: Sprite[] = [];

  emit(spec: ParticleSpec): void {
    if (this.live.length >= MAX_PARTICLES) return;
    const sprite = this.pool.pop() ?? this.newSprite();
    sprite.visible = true;
    sprite.tint = spec.tint;
    this.live.push({ drag: 0, gravity: 0, round: false, fadeIn: false, ...spec, sprite, maxLife: spec.life });
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
      if (p.round) {
        sp.rotation = 0;
        sp.width = sp.height = p.size * (0.4 + 0.6 * left);
        sp.alpha = left * 0.55;
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Turn a fractional expected count into a whole number of spawns this frame. */
function spawnCount(expected: number): number {
  const whole = Math.floor(expected);
  return whole + (Math.random() < expected - whole ? 1 : 0);
}

function setSize(sprite: Sprite, size: number): void {
  sprite.width = sprite.height = size;
}

function glowSprite(blend: 'add' | 'normal' = 'add', tint = 0xffffff): Sprite {
  const sp = new Sprite(glowTexture());
  sp.anchor.set(0.5);
  sp.tint = tint;
  sp.blendMode = blend;
  return sp;
}

function coreSprite(tint = 0xffffff): Sprite {
  const sp = new Sprite(coreTexture());
  sp.anchor.set(0.5);
  sp.tint = tint;
  sp.blendMode = 'add';
  return sp;
}

// --- Procedural textures (generated once, white so they can be tinted). ---

const cache = new Map<string, Texture>();

function canvasTexture(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Texture {
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

function radial(stops: readonly [number, number][]): (ctx: CanvasRenderingContext2D) => void {
  return (ctx) => {
    const r = ctx.canvas.width / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    for (const [at, a] of stops) g.addColorStop(at, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, r * 2, r * 2);
  };
}

/** Soft light falloff. */
function glowTexture(): Texture {
  return canvasTexture('glow', 128, 128, radial([[0, 1], [0.15, 0.75], [0.4, 0.28], [0.7, 0.07], [1, 0]]));
}

/** Hard-edged hot centre. */
function coreTexture(): Texture {
  return canvasTexture('core', 64, 64, radial([[0, 1], [0.4, 1], [0.65, 0.45], [1, 0]]));
}

/** A thin bright ring with a soft inner glow: a shockwave. */
function ringTexture(): Texture {
  return canvasTexture('ring', 128, 128, radial([[0, 0], [0.55, 0.06], [0.78, 0.35], [0.88, 1], [0.95, 0.3], [1, 0]]));
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
