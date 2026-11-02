import { ColorMatrixFilter, Container, DisplacementFilter, Graphics, Sprite, type Spritesheet, type Texture } from 'pixi.js';
import { DREAM, SQUIRREL } from '../sim/constants';
import { MOVES, phaseAt } from '../sim/moves';
import type { Cataclysm, Critter, CritterState, FighterState, GameState } from '../sim/state';
import { canvasTexture, groundBurst, lerp, mixColor, Particles } from './fx';
import { FIGHTER_HEIGHT, FLOOR_Y, VIEW_WIDTH, type ViewLayout } from './layout';
import { superCharge } from './supers';

/** Written by scripts/build-sprites.mjs into the squirrel atlas. */
interface CritterMeta {
  readonly standingHeight: number;
  readonly anchor: { readonly x: number; readonly y: number };
}

/** A squirrel standing (fists up, tail and all) is drawn this tall, px. */
const SQUIRREL_HEIGHT = 92;
/** The dream's palette, red to yellow and back: the hallucination's lines and circles. */
const FEVER = [0xff1a1a, 0xff7a00, 0xffe600, 0xff7a00, 0xff1a1a, 0xb3001b] as const;
/** The colour the screen goes as it fades out of one world and into the other: a red-black. */
const FADE_COLOR = 0x140102;
/** The vignette's colour, closing in at the edges. */
const VIGNETTE_COLOR = 0x3a0004;
/** The dream sways the whole view gently, px. */
const SWAY = { x: 7, y: 5 } as const;
const FUR = [0xf0a24e, 0xd9772b, 0xb85a1e] as const;
/** Ms for the colour grade to swing red -> yellow -> red once. */
const GRADE_PERIOD_MS = 7000;
/** Ms of dream for its weirdness to build to full. */
const BUILD_MS = 9000;
/** The wobble map's sprite scale (the map is 256px, so its tile is this times that). */
const WARP_TILE = 3;

/**
 * Mind's super, Nutmare (the sim side is dream.ts), from the brain wave to waking up.
 *
 * TKURII focuses (psychic rings around his head), then thrusts a brain wave: wavy lines in red and
 * yellow run from his head to the opponent's. Hallucination circles close in on the opponent,
 * spinning, as the screen fades to a red-black. It fades back in on the same valley, nothing added
 * to it, but dreamt: TKURII is not there, and the picture itself is wrong. The whole scene is
 * colour-graded red, swinging slowly to a burning yellow and back to red; it wobbles in slow waves
 * as if seen through heat; a ghost of the valley drifts over it, out of register (double vision);
 * the view breathes in and out and tilts; a crimson vignette pulses at the edges like a heartbeat;
 * and now and then it glitches (a flash of negative, a jolt sideways). All of it builds over the
 * dream, and surges. Squirrels burrow up (a dirt mound shows where; an ambusher's under the
 * opponent pulses a warning), burst out, run, wind up and lunge; knocked out, they fly off
 * spinning with stars around their heads. At the end they burrow away, the circles spin again,
 * the screen goes dark, and it is reality again. Reads simulation state only.
 *
 * Layers: `back` (world, under the fighters: mounds, shadows), `front` (world, over them:
 * squirrels, the brain wave, the circles) and `overlay` (screen space, under the HUD: vignette and
 * fade). The scene effects (grade, wobble, ghost, breathing) act on the scene container given to
 * `attach`.
 */
export class DreamView {
  readonly back = new Container();
  readonly front = new Container();
  readonly overlay = new Container();

  private readonly mounds = new Graphics();
  private readonly shadows = new Graphics();
  private readonly squirrels = new Container();
  private readonly stars = new Graphics();
  private readonly psychic = new Graphics();
  private readonly dust = new Particles(400);
  private readonly fade = new Graphics();
  private readonly vignette = new Sprite(vignetteTexture());

  // Scene effects.
  private readonly grade = new ColorMatrixFilter();
  private readonly warpMap = new Sprite(warpTexture());
  private readonly warp = new DisplacementFilter({ sprite: this.warpMap, scale: 0 });
  private readonly ghost = new Sprite();
  private scene: Container | null = null;
  private background: Sprite | null = null;

  private readonly textures: Record<string, Texture>;
  private readonly scale: number;
  private readonly anchor: { readonly x: number; readonly y: number };
  private readonly sprites = new Map<number, Sprite>();
  /** Each squirrel's state last frame, to spot it bursting out, being knocked out, leaving. */
  private readonly seen = new Map<number, CritterState>();
  private inDream = false;
  /** Whose dream is showing (that fighter is hidden), or -1. */
  private dreamer = -1;
  private black = 0;
  private time = 0;
  /** Ms spent in the current dream. */
  private dreamMs = 0;
  /** A glitch: ms left of it, ms until the next, its kind, and its sideways jolt. */
  private glitchMs = 0;
  private nextGlitchMs = 3000;
  private glitchNegative = false;
  private jolt = 0;
  private view: ViewLayout | null = null;

  constructor(sheet: Spritesheet) {
    this.textures = sheet.textures;
    const meta = (sheet.data.meta as unknown as { fighter: CritterMeta }).fighter;
    this.scale = SQUIRREL_HEIGHT / meta.standingHeight;
    this.anchor = meta.anchor;
    this.psychic.blendMode = 'add';
    this.back.addChild(this.mounds, this.shadows);
    this.front.addChild(this.squirrels, this.stars, this.dust.root, this.psychic);
    this.vignette.anchor.set(0.5);
    this.vignette.tint = VIGNETTE_COLOR;
    this.vignette.visible = false;
    this.overlay.addChild(this.vignette, this.fade);
    this.ghost.visible = false;
    this.warpMap.scale.set(WARP_TILE);
  }

  /**
   * The scene the dream warps (stage painting, skies, world; not the HUD or overlays), and its
   * stage painting, which the dream's ghost image copies.
   */
  attach(scene: Container, background: Sprite): void {
    this.scene = scene;
    this.background = background;
    this.ghost.texture = background.texture;
    scene.addChildAt(this.ghost, scene.getChildIndex(background) + 1);
    // The wobble's map must sit in the scene for its transform; the filter keeps it from drawing.
    scene.addChild(this.warpMap);
  }

  layout(view: ViewLayout): void {
    this.view = view;
    this.vignette.position.set(view.width / 2, view.height / 2);
    this.vignette.width = view.width * 1.15;
    this.vignette.height = view.height * 1.25;
  }

  /** Is this fighter away in their own dream (not drawn)? */
  hidden(fighter: number): boolean {
    return this.inDream && fighter === this.dreamer;
  }

  /** The dream sways the view: add to the world and background like camera shake. */
  shake(): { x: number; y: number } {
    if (!this.inDream) return { x: 0, y: 0 };
    return { x: Math.sin(this.time * 0.0011) * SWAY.x, y: Math.sin(this.time * 0.0016 + 1) * SWAY.y };
  }

  /** Tint for the stage painting (multiplies with other lighting): the grade does the dream's colour. */
  backgroundTint(): number {
    return 0xffffff;
  }

  /** Tint for the fighters (multiplies with other lighting). */
  fighterTint(): number {
    return 0xffffff;
  }

  update(prev: GameState, curr: GameState, alpha: number, deltaMs: number): void {
    const dt = Math.min(deltaMs, 50) / 1000;
    this.time += deltaMs;
    this.psychic.clear();
    this.stars.clear();
    this.mounds.clear();
    this.shadows.clear();

    const dream = curr.cataclysms.find((c) => c.kind === 'mind') ?? null;
    const t = dream ? Math.min(dream.tick + alpha, DREAM.ticks) : -1;
    const wasInDream = this.inDream;
    this.inDream = dream !== null && t >= DREAM.dreamFrom && t < DREAM.wakeAt;
    this.dreamer = dream?.owner ?? -1;
    if (this.inDream && !wasInDream) {
      this.dreamMs = 0;
      this.nextGlitchMs = 2500;
      this.glitchMs = 0;
    }

    // TKURII focusing and thrusting the brain wave.
    curr.fighters.forEach((f, i) => {
      const p = prev.fighters[i] ?? f;
      const charge = superCharge(f, 'mind');
      if (charge > 0) this.focus(head(p, f, alpha), charge);
      const target = curr.fighters.find((_, j) => j !== i);
      if (f.action === 'brainwave' && phaseAt(MOVES.brainwave, f.actionTick, f.moveSustained)?.phase !== 'startup' && target) {
        this.brainwave(head(p, f, alpha), head(prev.fighters[curr.fighters.indexOf(target)] ?? target, target, alpha), 1);
      }
    });

    if (dream) this.drawDream(prev, curr, dream, t, alpha);
    this.black = dream ? blackAt(t) : 0;
    this.sceneEffects(deltaMs);
    this.drawSquirrels(prev, curr, alpha);
    this.dust.update(dt);

    const v = this.view;
    this.fade.clear();
    if (v && this.black > 0) this.fade.rect(-60, -60, v.width + 120, v.height + 120).fill({ color: FADE_COLOR, alpha: this.black });
  }

  /**
   * The dream's weirdness, all on the picture itself: grade, wobble, ghost, breathing and tilt,
   * vignette and glitches. Switched on and off while the screen is dark, so it never pops.
   */
  private sceneEffects(deltaMs: number): void {
    const scene = this.scene;
    const v = this.view;
    if (!scene || !v) return;
    if (!this.inDream) {
      if (scene.filters) {
        scene.filters = null;
        scene.pivot.set(0, 0);
        scene.position.set(0, 0);
        scene.scale.set(1);
        scene.rotation = 0;
        this.ghost.visible = false;
        this.vignette.visible = false;
      }
      return;
    }
    this.dreamMs += deltaMs;
    const ms = this.dreamMs;
    // Builds from uneasy to full over BUILD_MS, with slow surges on top.
    const build = 0.4 + 0.6 * smooth(Math.min(1, ms / BUILD_MS));
    const surge = Math.max(0, Math.sin(ms * 0.00075)) ** 3;
    const w = Math.min(1.25, build + 0.3 * surge);

    // Glitches: rarer at first, more often as it builds.
    this.nextGlitchMs -= deltaMs;
    if (this.nextGlitchMs <= 0) {
      this.glitchMs = 70 + Math.random() * 120;
      this.nextGlitchMs = (3200 - 1800 * build) * (0.6 + Math.random() * 0.8);
      this.glitchNegative = Math.random() < 0.5;
      this.jolt = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 18);
    }
    const glitching = this.glitchMs > 0;
    this.glitchMs = Math.max(0, this.glitchMs - deltaMs);

    // The grade: red, swinging to yellow and back to red.
    // Eased twice, so it lingers at full red and full yellow and passes quickly through orange.
    const swing = smooth(smooth(0.5 - 0.5 * Math.cos((ms / GRADE_PERIOD_MS) * Math.PI * 2)));
    feverGrade(this.grade, swing, Math.min(1, 0.65 + 0.35 * w));
    if (glitching && this.glitchNegative) this.grade.negative(true);

    // The wobble: slow waves, as through heat; a glitch kicks it.
    const kick = glitching ? 2.2 : 1;
    this.warp.scale.set((8 + 20 * w) * kick, (5 + 12 * w) * kick);
    const tile = 256 * WARP_TILE;
    this.warpMap.position.set((ms * 0.03) % tile, (ms * 0.017) % tile);
    if (!scene.filters) scene.filters = [this.warp, this.grade];

    // Breathing in and out, and a slow tilt, about the middle of the view. Zoomed in enough that
    // the tilt never shows past the painting's edge.
    const cx = v.width / 2;
    const cy = v.height / 2;
    scene.pivot.set(cx, cy);
    scene.position.set(cx + (glitching ? this.jolt : 0), cy);
    scene.scale.set(1.06 + 0.025 * w + 0.018 * Math.sin(ms * 0.0011));
    scene.rotation = 0.026 * w * Math.sin(ms * 0.00042);

    // Double vision: the valley again, a little bigger, drifting out of register.
    const bg = this.background;
    if (bg) {
      this.ghost.visible = true;
      this.ghost.scale.set(bg.scale.x * 1.02, bg.scale.y * 1.02);
      const drift = 14 + 22 * w;
      this.ghost.position.set(
        bg.position.x - bg.width * 0.01 + Math.sin(ms * 0.0007) * drift,
        bg.position.y - bg.height * 0.01 + Math.sin(ms * 0.00053 + 2) * drift * 0.5,
      );
      this.ghost.alpha = 0.16 + 0.14 * w;
      this.ghost.tint = cycle(FEVER, ms / GRADE_PERIOD_MS + 0.5);
    }

    // The edges darken in, pulsing like a heartbeat.
    const beat = Math.max(0, Math.sin(ms * 0.0068)) ** 6;
    this.vignette.visible = true;
    this.vignette.alpha = Math.min(1, 0.45 + 0.3 * w + 0.2 * beat);
  }

  /** The hallucination: brain waves still arriving, then circles closing in on the dreamer's target. */
  private drawDream(prev: GameState, curr: GameState, dream: Cataclysm, t: number, alpha: number): void {
    const ti = curr.fighters.findIndex((_, j) => j !== dream.owner);
    const target = curr.fighters[ti];
    const centre = target
      ? { x: lerp((prev.fighters[ti] ?? target).x, target.x, alpha), y: FLOOR_Y - (target.y + FIGHTER_HEIGHT * 0.55) }
      : { x: VIEW_WIDTH / 2, y: FLOOR_Y - FIGHTER_HEIGHT * 0.55 };

    // The brain wave keeps pouring into the target's head until the dark takes over.
    const owner = curr.fighters[dream.owner];
    if (owner && target && t < 45) {
      const op = prev.fighters[dream.owner] ?? owner;
      this.brainwave(head(op, owner, alpha), head(prev.fighters[ti] ?? target, target, alpha), Math.min(1, (45 - t) / 12));
    }

    const ramp = (a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
    let k = 0;
    if (t < DREAM.dreamFrom) k = ramp(0, 20);
    else if (t >= DREAM.outro && t < DREAM.wakeAt) k = ramp(DREAM.outro, DREAM.outro + 20);
    if (k > 0) this.circles(centre, k, t);

    // Ambushers' mounds pulse a warning on the ground.
    for (const c of curr.critters) {
      if (c.state !== 'burrow' || !c.ambush) continue;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 0.02);
      const r = 30 + 10 * pulse;
      this.psychic.ellipse(c.x, FLOOR_Y + 2, r * 1.6, r * 0.35).stroke({ color: 0xffe600, width: 3, alpha: 0.5 + 0.4 * pulse });
    }
  }

  /** Rings of thought pulsing out around a focusing head. */
  private focus(p: { x: number; y: number }, k: number): void {
    for (let i = 0; i < 3; i++) {
      const u = frac(this.time * 0.0018 + i / 3);
      const color = cycle(FEVER, this.time * 0.0004 + i * 0.3);
      this.psychic.circle(p.x, p.y, 16 + u * 60 * (0.5 + k)).stroke({ color, width: 3, alpha: (1 - u) * k * 0.8 });
    }
  }

  /** Wavy lines of thought running from one head into another. */
  private brainwave(from: { x: number; y: number }, to: { x: number; y: number }, k: number): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1 || k <= 0) return;
    const nx = -dy / len;
    const ny = dx / len;
    for (let w = 0; w < 3; w++) {
      const color = cycle(FEVER, this.time * 0.0006 + w * 0.33);
      const amp = 10 + w * 6;
      const steps = Math.max(8, Math.round(len / 10));
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        // Waves travel from TKURII to the target; they pinch in at both heads.
        const wave = Math.sin(u * len * 0.06 - this.time * 0.02 + w * 2.1) * amp * Math.sin(u * Math.PI);
        const x = from.x + dx * u + nx * wave;
        const y = from.y + dy * u + ny * wave;
        if (i === 0) this.psychic.moveTo(x, y);
        else this.psychic.lineTo(x, y);
      }
      this.psychic.stroke({ color, width: 4 - w, alpha: 0.75 * k });
    }
  }

  /** Spinning circles, red through yellow, closing in around the target. */
  private circles(c: { x: number; y: number }, k: number, t: number): void {
    for (let i = 0; i < 6; i++) {
      const color = cycle(FEVER, this.time * 0.0008 + i * 0.2);
      // Shrinking in towards the target as the spell takes hold.
      const r = (60 + i * 34) * (1.25 - 0.35 * k) + Math.sin(this.time * 0.006 + i) * 8;
      const spin = this.time * 0.003 * (i % 2 === 0 ? 1 : -1) + i;
      // Dashed: arcs round the ring.
      const dashes = 6 + i * 2;
      for (let d = 0; d < dashes; d++) {
        const a0 = spin + (d / dashes) * Math.PI * 2;
        const a1 = a0 + (Math.PI * 2) / dashes / 1.8;
        this.psychic
          .moveTo(c.x + Math.cos(a0) * r, c.y + Math.sin(a0) * r * 0.8)
          .arc(c.x, c.y, r, a0, a1)
          .stroke({ color, width: 4, alpha: k * (0.85 - i * 0.09) });
      }
    }
    // A hypnotic spiral right over them.
    const spinT = this.time * 0.006;
    for (let i = 0; i <= 60; i++) {
      const a = spinT + i * 0.32;
      const r = i * 2.2 * k;
      const x = c.x + Math.cos(a) * r;
      const y = c.y + Math.sin(a) * r * 0.8;
      if (i === 0) this.psychic.moveTo(x, y);
      else this.psychic.lineTo(x, y);
    }
    this.psychic.stroke({ color: cycle(FEVER, t * 0.02), width: 3, alpha: 0.6 * k });
  }

  private drawSquirrels(prev: GameState, curr: GameState, alpha: number): void {
    const before = new Map(prev.critters.map((k) => [k.id, k]));
    const live = new Set<number>();
    for (const k of curr.critters) {
      live.add(k.id);
      const p = before.get(k.id) ?? k;
      const x = lerp(p.x, k.x, alpha);
      const y = lerp(p.y, k.y, alpha);
      this.events(k, x);

      let sprite = this.sprites.get(k.id);
      if (!sprite) {
        sprite = new Sprite();
        sprite.anchor.set(this.anchor.x, this.anchor.y);
        this.sprites.set(k.id, sprite);
        this.squirrels.addChild(sprite);
      }
      const look = this.look(k);
      sprite.visible = look.frame !== null;
      // The mound it comes out of (or goes back into).
      const mound = k.state === 'burrow' ? Math.min(1, k.tick / 14) : k.state === 'leap' ? Math.max(0, 1 - k.tick / 16) : k.state === 'poof' ? 1 - k.tick / SQUIRREL.poofTicks : 0;
      if (mound > 0) this.mound(k.x, mound, k.state === 'burrow' ? k.tick : 0);
      if (!look.frame) continue;

      sprite.texture = this.textures[look.frame];
      sprite.position.set(x, FLOOR_Y - (look.grounded ? 0 : y) + look.sink);
      sprite.scale.set(this.scale * k.facing, this.scale);
      sprite.rotation = look.rotation;
      sprite.alpha = look.alpha;
      // A shadow on the floor under it.
      const lift = Math.min(1, y / 200);
      this.shadows.ellipse(x, FLOOR_Y + 3, 30 * (1 - lift * 0.5), 6 * (1 - lift * 0.5)).fill({ color: 0x000000, alpha: 0.3 * (1 - lift) * look.alpha });
      if (k.state === 'knocked') this.dizzy(x, FLOOR_Y - y - SQUIRREL_HEIGHT * 0.95, k.tick);
    }
    for (const [id, sprite] of this.sprites) {
      if (live.has(id)) continue;
      sprite.destroy();
      this.sprites.delete(id);
      this.seen.delete(id);
    }
  }

  /** Which frame a squirrel shows, and how. */
  private look(k: Critter): { frame: string | null; grounded: boolean; rotation: number; alpha: number; sink: number } {
    const base = { grounded: false, rotation: 0, alpha: 1, sink: 0 };
    switch (k.state) {
      case 'burrow': {
        // The mound heaves first; then the squirrel peeks out of it.
        const show = (k.ambush ? SQUIRREL.ambushTicks : SQUIRREL.burrowTicks) * 0.45;
        if (k.tick < show) return { ...base, frame: null };
        return { ...base, frame: 'burrow', grounded: true, alpha: Math.min(1, (k.tick - show) / 8) };
      }
      case 'leap':
        // Bursting out (the frame has the dirt flying under it), then tucked up in the air.
        return k.tick < 10 ? { ...base, frame: 'burst', grounded: true } : { ...base, frame: 'run_2' };
      case 'run':
        return { ...base, frame: Math.floor(k.tick / 6) % 2 === 0 ? 'run_1' : 'run_2' };
      case 'windup':
        return { ...base, frame: 'stance' };
      case 'lunge':
      case 'pile':
        return { ...base, frame: 'dive' };
      case 'recover':
        return { ...base, frame: k.tick < 8 ? 'punch' : 'stance' };
      case 'knocked':
        return { ...base, frame: 'dizzy', rotation: -k.facing * k.tick * 0.25, alpha: Math.min(1, (SQUIRREL.knockedTicks - k.tick) / 10) };
      case 'poof':
        return { ...base, frame: 'burrow', grounded: true, alpha: 1 - k.tick / SQUIRREL.poofTicks, sink: (k.tick / SQUIRREL.poofTicks) * 30 };
    }
  }

  /** One-off effects as a squirrel changes state. */
  private events(k: Critter, x: number): void {
    const was = this.seen.get(k.id);
    this.seen.set(k.id, k.state);
    if (was === k.state) return;
    if (k.state === 'leap') groundBurst(this.dust, x, 0.7);
    if (k.state === 'poof') groundBurst(this.dust, x, 0.4);
    if (k.state === 'knocked') {
      // Knocked out: fur flies, and a little white pop.
      const y = FLOOR_Y - (k.y + SQUIRREL_HEIGHT * 0.5);
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2;
        const speed = 80 + Math.random() * 240;
        this.dust.emit({
          x,
          y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - 60,
          life: 0.6 + Math.random() * 0.5,
          size: 5 + Math.random() * 6,
          tint: FUR[Math.floor(Math.random() * FUR.length)],
          round: true,
          grow: 0.7,
          alpha: 0.95,
          blend: 'normal',
          gravity: 220,
          drag: 3,
        });
      }
      this.dust.emit({ x, y, vx: 0, vy: 0, life: 0.18, size: 110, tint: 0xffffff, round: true, alpha: 0.7 });
    }
  }

  /** A heap of fresh dirt, heaving (`tick` shakes it while something digs up under it). */
  private mound(x: number, k: number, tick: number): void {
    const shake = tick > 0 ? Math.sin(tick * 1.7) * 2 : 0;
    const w = 46 * k;
    const h = 16 * k;
    this.mounds.ellipse(x + shake, FLOOR_Y, w, h).fill({ color: 0x5e3d22 }).ellipse(x + shake - w * 0.2, FLOOR_Y - h * 0.35, w * 0.55, h * 0.5).fill({ color: 0x7a5232 });
    for (let i = 0; i < 5; i++) {
      const px = x + shake + (i - 2) * w * 0.42;
      this.mounds.circle(px, FLOOR_Y - h * 0.2 + (i % 2) * 3, 3 + (i % 3)).fill({ color: 0x4a2f1a });
    }
  }

  /** Stars circling a knocked-out squirrel's head. */
  private dizzy(x: number, y: number, tick: number): void {
    for (let i = 0; i < 3; i++) {
      const a = tick * 0.25 + (i / 3) * Math.PI * 2;
      star(this.stars, x + Math.cos(a) * 22, y + Math.sin(a) * 7, 6, 0xfff36e);
    }
  }
}


/** The fighter's head, interpolated, in world coordinates. */
function head(p: FighterState, f: FighterState, alpha: number): { x: number; y: number } {
  return { x: lerp(p.x, f.x, alpha) + f.facing * FIGHTER_HEIGHT * 0.06, y: FLOOR_Y - (lerp(p.y, f.y, alpha) + FIGHTER_HEIGHT * 0.9) };
}

/**
 * How dark the screen is, `t` ticks into the dream: fading out as the circles close in, dark
 * while the worlds swap, fading into the dream; the same again on waking.
 */
function blackAt(t: number): number {
  const ramp = (a: number, b: number) => smooth(Math.min(1, Math.max(0, (t - a) / (b - a))));
  if (t < DREAM.dreamFrom) return ramp(18, 45);
  if (t < DREAM.outro) return 1 - ramp(DREAM.dreamFrom, DREAM.dreamFrom + 30);
  if (t < DREAM.wakeAt) return ramp(DREAM.outro, DREAM.wakeAt - 7);
  return 1 - ramp(DREAM.wakeAt, DREAM.wakeAt + 30);
}

/**
 * The fever grade: every colour becomes its brightness, mapped onto the dream's palette. `swing`
 * 0 is red (shadows blood-dark, lights crimson), 1 is yellow (lights burning yellow, shadows
 * orange-red); `k` is how far the grade has taken over from the real colours.
 */
function feverGrade(f: ColorMatrixFilter, swing: number, k: number): void {
  const lum = [0.299, 0.587, 0.114];
  // Per channel: gain on brightness, and a lift.
  const gain = [1.35, 0.1 + 1.05 * swing, 0.03 + 0.07 * swing];
  const lift = [0.08, 0.04 * swing, 0];
  const m: number[] = [];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 3; i++) {
      const real = c === i ? 1 : 0;
      m.push(real + (lum[i] * gain[c] - real) * k);
    }
    m.push(0, lift[c] * k);
  }
  m.push(0, 0, 0, 1, 0);
  f.matrix = m as ColorMatrixFilter['matrix'];
  // Contrast pushes the fever harder.
  f.contrast(0.25 * k, true);
}

/** Dark edges closing in on a clear middle (white, to be tinted). */
function vignetteTexture(): Texture {
  return canvasTexture('dream-vignette', 256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  });
}

/**
 * A tiling map of slow, smooth waves for the wobble: red and green carry the x and y offsets
 * (128 is still). Only whole numbers of waves fit across, so it tiles without a seam.
 */
function warpTexture(): Texture {
  const n = 256;
  const tex = canvasTexture('dream-warp', n, n, (ctx) => {
    const img = ctx.createImageData(n, n);
    const terms: readonly [number, number, number][] = [[1, 2, 0.5], [3, 1, 0.3], [2, -3, 0.2]];
    const waves = (x: number, y: number, seed: number): number =>
      terms.reduce((v, [fx, fy, a]) => v + a * Math.sin(((fx * x + fy * y) / n) * Math.PI * 2 + seed), 0);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const o = (y * n + x) * 4;
        img.data[o] = 128 + 127 * waves(x, y, 0.7);
        img.data[o + 1] = 128 + 127 * waves(y, x, 2.3);
        img.data[o + 2] = 128;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  tex.source.style.addressMode = 'repeat';
  return tex;
}

function smooth(u: number): number {
  return u * u * (3 - 2 * u);
}

function frac(v: number): number {
  return v - Math.floor(v);
}

/** A colour drifting smoothly round a palette as `u` grows (one lap per 1). */
function cycle(colors: readonly number[], u: number): number {
  const f = frac(u) * colors.length;
  const i = Math.floor(f);
  return mixColor(colors[i], colors[(i + 1) % colors.length], f - i);
}

function star(g: Graphics, x: number, y: number, r: number, color: number): void {
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    if (i === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.fill(color);
}
