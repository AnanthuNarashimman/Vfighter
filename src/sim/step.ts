import {
  AIR_SPEED,
  BEAM_MAX_LENGTH,
  CLASH_KEEP_TICKS,
  COUNTER_CAP,
  ENERGY_MAX,
  ENERGY_REGEN,
  ENERGY_REGEN_DELAY,
  FIGHTER_HEIGHT,
  GRAVITY,
  GUARD_HOLD_DRAIN,
  GUARD_MAX,
  GUARD_RAISE_MIN,
  GUARD_REGEN,
  GUARD_REGEN_DELAY,
  HIT_FRICTION,
  JUMP_BUFFER_TICKS,
  JUMP_VELOCITY,
  KO_RESET_TICKS,
  PROJECTILE_DESPAWN_MARGIN,
  SHOVE_FRICTION,
  STAGE_MARGIN,
  STAGE_WIDTH,
  TRAP,
  WALK_SPEED,
} from './constants';
import { stepCataclysms } from './cataclysm';
import { resolveCombat, strikeHits } from './combat';
import { NO_INPUT, type Button, type InputFrame } from './input';
import { MOVES, MOVE_PRIORITY, MUZZLE, isMoveId, kitHasMove, phaseAt, sustainEndTick, type MoveId } from './moves';
import {
  createInitialState,
  loadoutOf,
  setAction,
  type Action,
  type FighterState,
  type GameState,
  type Mutable,
  type ProjectileState,
} from './state';

/** A projectile a fighter fired this tick; `step` assigns its id and owner. */
export type ProjectileSpawn = Pick<ProjectileState, 'x' | 'y' | 'vx'>;

/**
 * Advance the game by one fixed tick. Pure: no rendering, clocks or unseeded randomness, and the
 * input state is never mutated. `inputs[i]` belongs to `state.fighters[i]`.
 */
export function step(state: GameState, inputs: readonly InputFrame[]): GameState {
  if (state.ko && state.ko.tick >= KO_RESET_TICKS) {
    return createInitialState(state.rngSeed, state.nextProjectileId, state.fighters.map(loadoutOf));
  }

  const spawned: ProjectileState[] = [];
  let nextId = state.nextProjectileId;
  const fighters: Mutable<FighterState>[] = state.fighters.map((f, owner) => {
    // Once the round is decided nobody takes input; bodies still fall and slide.
    const input = state.ko ? NO_INPUT : (inputs[owner] ?? NO_INPUT);
    const opponent = state.fighters.find((_, j) => j !== owner);
    const spawn = (p: ProjectileSpawn) => spawned.push({ ...p, id: nextId++, owner, age: 0 });
    return stepFighter(f, input, spawn, opponent?.x);
  });
  const moved = state.projectiles
    .map((p) => ({ ...p, x: p.x + p.vx, age: p.age + 1 }))
    .filter((p) => p.x > -PROJECTILE_DESPAWN_MARGIN && p.x < STAGE_WIDTH + PROJECTILE_DESPAWN_MARGIN);
  const tick = state.tick + 1;
  const clashes = state.clashes.filter((c) => tick - c.tick < CLASH_KEEP_TICKS);
  // Ids only need to be unique among the few clashes kept at once.
  const projectiles = resolveCombat(fighters, spawned.length ? [...moved, ...spawned] : moved, (c) =>
    clashes.push({ ...c, id: tick * 16 + (clashes.length % 16), tick }),
  );

  const supers = stepCataclysms(state.cataclysms, state.strikes, fighters, state.rngSeed, nextId, state.ko !== null);
  const strikes = strikeHits(fighters, supers.strikes);

  let ko = state.ko && { ...state.ko, tick: state.ko.tick + 1 };
  if (!ko && fighters.some((f) => f.health <= 0)) {
    const standing = fighters.map((f, i) => (f.health > 0 ? i : -1)).filter((i) => i >= 0);
    ko = { winner: standing.length === 1 ? standing[0] : null, tick: 0 };
  }

  return {
    tick,
    rngSeed: supers.rngSeed,
    fighters,
    projectiles,
    nextProjectileId: supers.nextId,
    clashes,
    cataclysms: supers.cataclysms,
    strikes,
    ko,
  };
}

/** `opponentX`, when there is an opponent, keeps the fighter turned toward them on the ground. */
export function stepFighter(
  prev: FighterState,
  input: InputFrame,
  spawn: (p: ProjectileSpawn) => void = () => {},
  opponentX?: number,
): FighterState {
  const f: Mutable<FighterState> = { ...prev };
  const pressed = (b: Button) => input[b] && !prev.lastInput[b];
  const dir: -1 | 0 | 1 = input.right === input.left ? 0 : input.right ? 1 : -1;

  f.lastInput = input;
  f.actionTick = Math.min(prev.actionTick + 1, COUNTER_CAP);
  f.landedTick = Math.min(prev.landedTick + 1, COUNTER_CAP);
  f.jumpBuffer = pressed('jump') ? JUMP_BUFFER_TICKS : Math.max(0, prev.jumpBuffer - 1);
  f.energyIdleTicks = Math.min(prev.energyIdleTicks + 1, COUNTER_CAP);
  if (f.energyIdleTicks >= ENERGY_REGEN_DELAY) f.energy = Math.min(ENERGY_MAX, f.energy + ENERGY_REGEN);
  f.guardIdleTicks = Math.min(prev.guardIdleTicks + 1, COUNTER_CAP);
  f.guardBrokenTick = Math.min(prev.guardBrokenTick + 1, COUNTER_CAP);
  f.strikeGrace = Math.max(0, prev.strikeGrace - 1);
  f.trapped = Math.max(0, prev.trapped - 1);
  // Goo stuck to the fighter: first glued in place, then wading through it.
  const stuck = f.trapped > TRAP.ticks - TRAP.stuckTicks;
  const pace = stuck ? 0 : f.trapped > 0 ? TRAP.slow : 1;

  if (f.action === 'hit') {
    f.hitstun = Math.max(0, f.hitstun - 1);
    if (f.hitstun === 0) setAction(f, f.grounded ? 'idle' : 'air');
  }
  const stunned = f.action === 'hit' || f.action === 'ko';

  if (isMoveId(f.action)) {
    const move = MOVES[f.action];
    // A sustained phase keeps going while its button is held and there is energy to pay for it.
    // A beam always finishes reaching across the stage, even from a quick tap or once energy runs
    // dry, unless it is already pressed against the opponent.
    const extending = move.beam !== undefined && !f.beamBlocked && f.beamLength < beamReach(f);
    const holding = input[move.button] && f.energy >= (move.drainPerTick ?? 0);
    if (f.actionTick === sustainEndTick(move, f.moveSustained) && (holding || extending)) {
      f.moveSustained++;
    }
    // A finished move hands control back.
    if (phaseAt(move, f.actionTick, f.moveSustained) === null) setAction(f, f.grounded ? 'idle' : 'air');
  }

  if (!isMoveId(f.action) && !stunned) {
    for (const id of MOVE_PRIORITY) {
      if (pressed(MOVES[id].button) && tryStartMove(f, id)) break;
    }
  }

  if (stunned) {
    // Knocked back: no control; a ground slide eases off, an airborne body keeps its arc.
    if (f.grounded) f.vx *= HIT_FRICTION;
  } else if (isMoveId(f.action)) {
    // Committed: no steering. On the ground the fighter is planted; in the air momentum carries.
    if (f.grounded) f.vx = 0;
    runMove(f, f.action, spawn);
  } else if (f.grounded) {
    // Face the opponent (walking away is a backstep); alone, face the way you walk.
    if (opponentX !== undefined && opponentX !== f.x) f.facing = opponentX > f.x ? 1 : -1;
    else if (dir !== 0) f.facing = dir;
    // Keeping the shield up only needs some guard left; raising it again needs a reserve.
    const canBlock = f.action === 'block' ? f.guard > 0 : f.guard >= GUARD_RAISE_MIN;
    if (input.block && canBlock) {
      // Planted behind the shield; blocked hits still slide the blocker back.
      if (f.action !== 'block') {
        setAction(f, 'block');
        f.vx = 0;
      }
      f.vx *= HIT_FRICTION;
      f.guard = Math.max(0, f.guard - GUARD_HOLD_DRAIN);
      f.guardIdleTicks = 0;
    } else if (f.jumpBuffer > 0 && !stuck) {
      f.jumpBuffer = 0;
      f.grounded = false;
      // Wading through goo: a feeble hop.
      f.vy = JUMP_VELOCITY * (pace < 1 ? 0.7 : 1);
      f.vx = dir * AIR_SPEED * pace;
      setAction(f, 'air');
    } else if (input.down) {
      // Ducking lasts as long as it is held; no walking while down.
      if (f.action !== 'crouch') setAction(f, 'crouch');
      f.vx = 0;
    } else {
      const next: Action = dir !== 0 ? 'walk' : 'idle';
      if (next !== f.action) setAction(f, next);
      f.vx = dir * WALK_SPEED * pace;
    }
  } else {
    // Air control (no double jump: jumping only starts from the ground). With an opponent, facing
    // is kept through the jump and corrected on landing.
    if (dir !== 0 && opponentX === undefined) f.facing = dir;
    f.vx = dir * AIR_SPEED * pace;
  }

  if (f.action !== 'block' && f.guardIdleTicks >= GUARD_REGEN_DELAY) {
    f.guard = Math.min(GUARD_MAX, f.guard + GUARD_REGEN);
  }

  f.x += f.vx + f.shove;
  f.shove = Math.abs(f.shove) < 0.1 ? 0 : f.shove * SHOVE_FRICTION;
  if (!f.grounded) {
    f.vy -= GRAVITY;
    f.y += f.vy;
    if (f.y <= 0) land(f);
  }
  f.x = Math.min(STAGE_WIDTH - STAGE_MARGIN, Math.max(STAGE_MARGIN, f.x));

  return f;
}

/** Per-tick effects of the move in progress: lunge/pushback, energy drain, projectiles, beam. */
function runMove(f: Mutable<FighterState>, id: MoveId, spawn: (p: ProjectileSpawn) => void): void {
  const move = MOVES[id];
  const phase = phaseAt(move, f.actionTick, f.moveSustained);
  if (phase?.phase !== 'active') return;

  if (f.grounded && move.lunge) f.x += f.facing * (move.lunge[phase.tick] ?? 0);
  if (move.activeDrift) f.x += f.facing * move.activeDrift;
  if (move.drainPerTick) spendEnergy(f, move.drainPerTick);

  const muzzleX = f.x + f.facing * MUZZLE.x * FIGHTER_HEIGHT;
  const muzzleY = f.y + MUZZLE.y * FIGHTER_HEIGHT;
  if (move.projectile && phase.tick === 0) spawn({ x: muzzleX, y: muzzleY, vx: f.facing * move.projectile.speed });
  if (move.beam) f.beamLength = Math.min(BEAM_MAX_LENGTH, f.beamLength + move.beam.growPerTick);
}

/** Beam length needed to run from the muzzle past the stage edge the fighter is facing. */
function beamReach(f: FighterState): number {
  const muzzleX = f.x + f.facing * MUZZLE.x * FIGHTER_HEIGHT;
  const toEdge = f.facing > 0 ? STAGE_WIDTH - muzzleX : muzzleX;
  return Math.min(BEAM_MAX_LENGTH, toEdge + PROJECTILE_DESPAWN_MARGIN);
}

function tryStartMove(f: Mutable<FighterState>, id: MoveId): boolean {
  const move = MOVES[id];
  if (!kitHasMove(f.kit, id)) return false;
  if (move.element && move.element !== f.element) return false;
  if (!f.grounded && !move.allowedInAir) return false;
  const cost = move.energyCost ?? 0;
  if (f.energy < cost + (move.drainPerTick ?? 0)) return false;
  spendEnergy(f, cost);
  setAction(f, id);
  return true;
}

function spendEnergy(f: Mutable<FighterState>, amount: number): void {
  if (amount <= 0) return;
  f.energy = Math.max(0, f.energy - amount);
  f.energyIdleTicks = 0;
}

function land(f: Mutable<FighterState>): void {
  f.y = 0;
  f.vy = 0;
  f.vx = 0;
  f.grounded = true;
  f.landedTick = 0;
  // Air attacks end on landing, like most fighting games. Hitstun and KO carry on.
  if (f.action !== 'hit' && f.action !== 'ko') setAction(f, 'idle');
}
