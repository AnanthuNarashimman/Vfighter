import { NO_INPUT, type InputFrame } from './input';
import type { MoveId } from './moves';
import { COUNTER_CAP, ENERGY_MAX, HEALTH_MAX, STAGE_WIDTH } from './constants';

/**
 * What the fighter is doing. Moves (kick, blast, beam...) are actions too. `hit` = in hitstun,
 * `ko` = knocked out for the rest of the round.
 */
export type Action = 'idle' | 'walk' | 'air' | 'hit' | 'ko' | MoveId;

export interface FighterState {
  /** Horizontal centre, stage px. */
  readonly x: number;
  /** Feet height above the floor, px (0 = standing on the floor, positive = up). */
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly facing: 1 | -1;
  readonly grounded: boolean;
  readonly action: Action;
  /** Ticks since `action` started; drives move phases and animation timing. */
  readonly actionTick: number;
  /** Extra ticks the current move's sustain phase has been held (see moves.ts). */
  readonly moveSustained: number;
  /** Current beam length in px (kept through the recovery so it can fade out). */
  readonly beamLength: number;
  /** Ticks since the fighter last touched down (for landing effects). */
  readonly landedTick: number;
  /** Remaining ticks of a buffered jump press. */
  readonly jumpBuffer: number;
  readonly energy: number;
  /** Ticks since energy was last spent (regeneration waits for ENERGY_REGEN_DELAY). */
  readonly energyIdleTicks: number;
  readonly health: number;
  /** Remaining ticks of hitstun while `action` is 'hit'. */
  readonly hitstun: number;
  /** The current move already connected (a kick hits once). */
  readonly moveHit: boolean;
  /** The beam is pressed against the opponent this tick (it stops there instead of extending). */
  readonly beamBlocked: boolean;
  /** Input held on the previous tick, used to detect presses. */
  readonly lastInput: InputFrame;
}

export interface ProjectileState {
  readonly id: number;
  /** Index of the fighter that fired it. */
  readonly owner: number;
  readonly x: number;
  /** Height above the floor, px. */
  readonly y: number;
  readonly vx: number;
  readonly age: number;
}

/** Energy meeting energy: both sides cancelled here, harmlessly. Kept briefly for the renderer. */
export interface Clash {
  readonly id: number;
  /** Tick it happened on. */
  readonly tick: number;
  readonly x: number;
  /** Height above the floor, px. */
  readonly y: number;
  /** Fighters whose energy met (for colouring the burst). */
  readonly owners: readonly number[];
  readonly kind: 'blast' | 'beam';
}

export interface KnockOut {
  /** Index of the fighter left standing, or null for a double KO. */
  readonly winner: number | null;
  /** Ticks since the KO. */
  readonly tick: number;
}

export interface GameState {
  readonly tick: number;
  /** Seed for deterministic randomness (see rng.ts). Unused for now but kept in state for netplay. */
  readonly rngSeed: number;
  readonly fighters: readonly FighterState[];
  readonly projectiles: readonly ProjectileState[];
  readonly nextProjectileId: number;
  /** Recent clashes (the last CLASH_KEEP_TICKS ticks), so a frame that runs several ticks sees them all. */
  readonly clashes: readonly Clash[];
  /** Set once the round has been decided; the round restarts KO_RESET_TICKS later. */
  readonly ko: KnockOut | null;
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Start a new action from its first tick, dropping whatever the previous one carried. */
export function setAction(f: Mutable<FighterState>, action: Action): void {
  f.action = action;
  f.actionTick = 0;
  f.moveSustained = 0;
  f.beamLength = 0;
  f.moveHit = false;
  f.beamBlocked = false;
}

export function createFighter(x: number, facing: 1 | -1): FighterState {
  return {
    x,
    y: 0,
    vx: 0,
    vy: 0,
    facing,
    grounded: true,
    action: 'idle',
    actionTick: 0,
    moveSustained: 0,
    beamLength: 0,
    landedTick: COUNTER_CAP,
    jumpBuffer: 0,
    energy: ENERGY_MAX,
    energyIdleTicks: COUNTER_CAP,
    health: HEALTH_MAX,
    hitstun: 0,
    moveHit: false,
    beamBlocked: false,
    lastInput: NO_INPUT,
  };
}

/** `nextProjectileId` carries over between rounds so the renderer never confuses old and new blasts. */
export function createInitialState(seed = 1, nextProjectileId = 1): GameState {
  return {
    tick: 0,
    rngSeed: seed >>> 0,
    fighters: [createFighter(STAGE_WIDTH * 0.3, 1), createFighter(STAGE_WIDTH * 0.7, -1)],
    projectiles: [],
    nextProjectileId,
    clashes: [],
    ko: null,
  };
}
