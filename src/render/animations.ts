import { MOVES, isMoveId, phaseAt, type MoveId, type MovePhase } from '../sim/moves';
import { WALK_STEP_TICKS } from '../sim/constants';
import type { FighterState } from '../sim/state';

/** Frame names produced by scripts/build-sprites.mjs. */
export type FrameName =
  | 'idle_stance'
  | 'idle_breathe'
  | 'walk_1'
  | 'walk_2'
  | 'punch_windup'
  | 'punch_extend'
  | 'kick_windup'
  | 'kick_high'
  | 'blast_charge'
  | 'blast_release'
  | 'jump_air'
  | 'hit_recoil'
  | 'block'
  | 'duck'
  | 'skid'
  /** Gooner only: gathering and pouring his goo stream. */
  | 'beam_charge'
  | 'beam_release';

/** Frames only some characters have, and what the others show instead. */
export const FRAME_FALLBACK: Partial<Record<FrameName, FrameName>> = {
  beam_charge: 'blast_charge',
  beam_release: 'blast_release',
};

/** Braced and sliding back while shoved (by an opening shield) faster than this, px per tick. */
const SKID_MIN_SHOVE = 0.6;

const IDLE_FRAME_TICKS = 36;
/** Within each step, ticks [CONTACT_HALF, STEP - CONTACT_HALF) show the passing pose. */
const CONTACT_HALF = WALK_STEP_TICKS / 4;

const MOVE_FRAMES: Record<MoveId, Record<MovePhase, FrameName>> = {
  kick: { startup: 'kick_windup', active: 'kick_high', recovery: 'kick_windup' },
  // The arm stays out through the recovery as a follow-through, then snaps back to stance.
  blast: { startup: 'blast_charge', active: 'blast_release', recovery: 'blast_release' },
  beam: { startup: 'beam_charge', active: 'beam_release', recovery: 'beam_release' },
  // Gathering the heat in the hands, then thrusting it out into the earth.
  super: { startup: 'blast_charge', active: 'punch_extend', recovery: 'punch_windup' },
  // Drawing the charge in, then flinging an open palm out to call the storm.
  storm: { startup: 'blast_charge', active: 'blast_release', recovery: 'blast_release' },
  // Gathering the goo, then flinging the arms out to raise the giant.
  goonFall: { startup: 'blast_charge', active: 'blast_release', recovery: 'blast_release' },
};

/** Pure view of the simulation: which sprite frame represents this fighter right now. */
export function frameFor(f: FighterState): FrameName {
  // Being shoved overrides standing, walking and ducking (not attacks, hitstun or blocking).
  const free = f.action === 'idle' || f.action === 'walk' || f.action === 'crouch';
  if (free && f.grounded && Math.abs(f.shove) > SKID_MIN_SHOVE) return 'skid';
  if (isMoveId(f.action)) {
    const phase = phaseAt(MOVES[f.action], f.actionTick, f.moveSustained);
    return MOVE_FRAMES[f.action][phase?.phase ?? 'recovery'];
  }
  switch (f.action) {
    case 'hit':
    case 'ko':
      return 'hit_recoil';
    case 'block':
      return 'block';
    case 'channel':
      // Holding the super: head back, arms flung out (Gooner's own pose; others use their blast release).
      return 'beam_release';
    case 'crouch':
      return 'duck';
    case 'air':
      return 'jump_air';
    case 'walk':
      return walkFrame(f.actionTick);
    case 'idle':
      return Math.floor(f.actionTick / IDLE_FRAME_TICKS) % 2 === 0 ? 'idle_stance' : 'idle_breathe';
  }
}

/** Four-beat walk at constant speed: contact (left) -> passing -> contact (right) -> passing. */
function walkFrame(tick: number): FrameName {
  const cycle = WALK_STEP_TICKS * 2;
  const t = tick % cycle;
  const inStep = t % WALK_STEP_TICKS;
  if (inStep >= CONTACT_HALF && inStep < WALK_STEP_TICKS - CONTACT_HALF) return 'idle_stance';
  return Math.floor(((t + CONTACT_HALF) % cycle) / WALK_STEP_TICKS) === 0 ? 'walk_1' : 'walk_2';
}
