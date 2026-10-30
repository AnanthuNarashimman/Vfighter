import { METER_MAX, TRAP } from './constants';
import type { Button } from './input';

/** A fighter's element decides which super it has. */
export type Element = 'fire' | 'thunder' | 'goo';

/**
 * Data-driven move definitions. A move is a sequence of timed phases; while a move runs the fighter
 * cannot walk or start another move. Add new moves here and give them frames in
 * render/animations.ts.
 */
export type MovePhase = 'startup' | 'active' | 'recovery';

export interface PhaseDef {
  readonly phase: MovePhase;
  /** Duration in ticks (the minimum, for a sustained phase). */
  readonly ticks: number;
  /** Keeps going past `ticks` while the move's button is held and energy lasts. */
  readonly sustain?: boolean;
}

export interface MoveDef {
  /** Pressing this button starts the move (holding it sustains a `sustain` phase). */
  readonly button: Button;
  readonly phases: readonly PhaseDef[];
  /** Can be started while airborne (the jump arc continues). */
  readonly allowedInAir: boolean;
  /** Displacement in px for each tick of the active phase, grounded only (+ forward, - back). */
  readonly lunge?: readonly number[];
  /** Constant displacement per active tick, e.g. pushback while firing (+ forward, - back). */
  readonly activeDrift?: number;
  /** Energy paid up front; the move cannot start without it. */
  readonly energyCost?: number;
  /** Super meter paid up front (all of it, for a super); the move cannot start without it. */
  readonly meterCost?: number;
  /** Energy drained per tick of the active phase. */
  readonly drainPerTick?: number;
  /** Fires a projectile from the muzzle on the first active tick. */
  readonly projectile?: { readonly speed: number };
  /** Fires a beam from the muzzle that extends this many px per active tick. */
  readonly beam?: { readonly growPerTick: number };
  /**
   * What landing this move does to the opponent. A beam deals it every tick it touches; a kick
   * once per move (through `hitbox`); a blast through its projectile.
   */
  readonly hit?: HitDef;
  /** Only fighters of this element have the move. */
  readonly element?: Element;
  /** Unleashes the fighter's element as a cataclysm on the first active tick (see cataclysm.ts). */
  readonly cataclysm?: boolean;
}

export interface HitDef {
  readonly damage: number;
  /** Guard lost when the hit is blocked instead (no health is lost). */
  readonly guardDamage: number;
  /** Ticks the victim is stunned (cannot act). */
  readonly hitstun: number;
  /** Victim's push-away speed, px per tick. */
  readonly knockback: number;
  /**
   * Area that hits during the active phase, as fractions of FIGHTER_HEIGHT: x forward of the body
   * centre, y above the feet. Moves that hit through a projectile or beam have none.
   */
  readonly hitbox?: { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number };
  /** Throws the victim up at this speed (px per tick) instead of just sliding them. */
  readonly launch?: number;
  /** Comes from somewhere a shield can't face (the ground): ignores blocking. */
  readonly unblockable?: boolean;
  /** Sticks goo to the victim for this many ticks: trapped, then slowed (see TRAP). */
  readonly trap?: number;
}

/**
 * What a cataclysm's strike does. Both come from where a shield can't face. A lava column bursting
 * up under the opponent: heavy, and launches. A lightning bolt from above: as heavy, and the shock
 * locks them up longer, but it only jolts them off their feet.
 */
export const STRIKE_HITS: Readonly<Record<Element, HitDef>> = {
  fire: { damage: 40, guardDamage: 0, hitstun: 30, knockback: 5, launch: 12, unblockable: true },
  thunder: { damage: 44, guardDamage: 0, hitstun: 40, knockback: 3, launch: 5, unblockable: true },
  // A goo ball from above: doesn't knock anyone away; it glues them down instead (see TRAP).
  goo: { damage: 38, guardDamage: 0, hitstun: 10, knockback: 0, unblockable: true, trap: TRAP.ticks },
};

const MOVE_TABLE = {
  kick: {
    button: 'kick',
    phases: [
      { phase: 'startup', ticks: 6 },
      { phase: 'active', ticks: 8 },
      { phase: 'recovery', ticks: 6 },
    ],
    allowedInAir: true,
    lunge: [5, 4, 3, 2, 1],
    // The high kick reaches out at chest-to-head height (measured from the kick_high frame).
    // Hitstun is short enough that the victim recovers before a repeated kick can land again.
    hit: { damage: 42, guardDamage: 18, hitstun: 14, knockback: 7, hitbox: { x0: 0.1, x1: 0.62, y0: 0.45, y1: 0.95 } },
  },
  blast: {
    button: 'blast',
    phases: [
      { phase: 'startup', ticks: 5 },
      { phase: 'active', ticks: 5 },
      { phase: 'recovery', ticks: 9 },
    ],
    allowedInAir: false,
    energyCost: 25,
    lunge: [-4, -3, -2, -1],
    projectile: { speed: 16 },
    hit: { damage: 52, guardDamage: 26, hitstun: 22, knockback: 8 },
  },
  beam: {
    button: 'beam',
    phases: [
      { phase: 'startup', ticks: 18 },
      { phase: 'active', ticks: 10, sustain: true },
      { phase: 'recovery', ticks: 14 },
    ],
    allowedInAir: false,
    energyCost: 5,
    drainPerTick: 0.75,
    activeDrift: -0.25,
    beam: { growPerTick: 48 },
    // Per tick of contact; holding a full gauge's worth on someone takes about a sixth of their
    // health. Against a shield it grinds the guard down in about 1.5 seconds: a beam breaks a turtle.
    hit: { damage: 1.3, guardDamage: 1.1, hitstun: 10, knockback: 2.5 },
  },
  // Fire's super, Inferno: gather the heat (interruptible), then thrust it into the ground to wake the volcano.
  super: {
    button: 'super',
    phases: [
      { phase: 'startup', ticks: 36 },
      { phase: 'active', ticks: 10 },
      { phase: 'recovery', ticks: 22 },
    ],
    allowedInAir: false,
    meterCost: METER_MAX,
    element: 'fire',
    cataclysm: true,
  },
  // Thunder's super, Tempest: draw the charge up (interruptible), then call the storm down.
  storm: {
    button: 'super',
    phases: [
      { phase: 'startup', ticks: 36 },
      { phase: 'active', ticks: 10 },
      { phase: 'recovery', ticks: 22 },
    ],
    allowedInAir: false,
    meterCost: METER_MAX,
    element: 'thunder',
    cataclysm: true,
  },
  // Goo's super, Goon Fall: draw the goo up (interruptible), then fling the arms wide to raise the
  // colossus and bring the goo down.
  goonFall: {
    button: 'super',
    phases: [
      { phase: 'startup', ticks: 36 },
      { phase: 'active', ticks: 10 },
      { phase: 'recovery', ticks: 24 },
    ],
    allowedInAir: false,
    meterCost: METER_MAX,
    element: 'goo',
    cataclysm: true,
  },
} as const satisfies Record<string, MoveDef>;

export type MoveId = keyof typeof MOVE_TABLE;
export const MOVES: Readonly<Record<MoveId, MoveDef>> = MOVE_TABLE;
/** Checked in this order when several buttons are pressed on the same tick. */
export const MOVE_PRIORITY: readonly MoveId[] = ['super', 'storm', 'goonFall', 'kick', 'blast', 'beam'];

/**
 * Which moves a fighter has, on top of walking, jumping, ducking and blocking (which every kit has).
 * `full`: all of them, including the element's super. `basic`: hand-to-hand only, the kick.
 */
export type Kit = 'full' | 'basic';
const KIT_MOVES: Readonly<Record<Kit, ReadonlySet<MoveId> | 'all'>> = {
  full: 'all',
  basic: new Set<MoveId>(['kick']),
};

export function kitHasMove(kit: Kit, id: MoveId): boolean {
  const moves = KIT_MOVES[kit];
  return moves === 'all' || moves.has(id);
}

/**
 * Where energy leaves the hand in the release pose, as fractions of FIGHTER_HEIGHT
 * (forward of the body centre, above the feet). Measured from the sprite frames.
 */
export const MUZZLE = { x: 0.49, y: 0.676 } as const;

export function isMoveId(action: string): action is MoveId {
  return action in MOVES;
}

export interface PhaseAt {
  readonly phase: MovePhase;
  readonly index: number;
  /** Ticks elapsed within this phase (0-based). */
  readonly tick: number;
}

/**
 * Which phase a move is in `tick` ticks after it started, or null once it has finished.
 * `sustained` = extra ticks the sustain phase has been held beyond its minimum.
 */
export function phaseAt(move: MoveDef, tick: number, sustained = 0): PhaseAt | null {
  let t = tick;
  for (let index = 0; index < move.phases.length; index++) {
    const p = move.phases[index];
    const ticks = p.ticks + (p.sustain ? sustained : 0);
    if (t < ticks) return { phase: p.phase, index, tick: t };
    t -= ticks;
  }
  return null;
}

/** Tick at which the sustain phase would end, or null if the move has none. */
export function sustainEndTick(move: MoveDef, sustained: number): number | null {
  let t = 0;
  for (const p of move.phases) {
    t += p.ticks;
    if (p.sustain) return t + sustained;
  }
  return null;
}
