/**
 * Simulation tuning. Units: stage pixels (1280-wide stage) and ticks (60 per second).
 * Keep simulation math to + - * / and comparisons so it stays deterministic across machines.
 */
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

export const STAGE_WIDTH = 1280;
/** How close a fighter's centre may get to either stage edge. */
export const STAGE_MARGIN = 80;

export const WALK_SPEED = 4.25;
/**
 * Ticks per walking step (two steps per full cycle). Chosen so one step covers about the stride
 * drawn in the walk frames (~105px at the current fighter size), which keeps the feet from sliding.
 */
export const WALK_STEP_TICKS = 25;
export const AIR_SPEED = 4.25;
/** Initial upward speed of a jump; with GRAVITY gives ~160px apex and ~0.7s airtime. */
export const JUMP_VELOCITY = 15;
export const GRAVITY = 0.7;

/** Standing height of a fighter in stage px. Gameplay body size; the renderer draws to match. */
export const FIGHTER_HEIGHT = 209;

export const ENERGY_MAX = 100;
/** Energy regained per tick once ENERGY_REGEN_DELAY ticks have passed without spending any. */
export const ENERGY_REGEN = 0.25;
export const ENERGY_REGEN_DELAY = 40;

/** A deep pool so rounds last: roughly 15 clean kicks, or 12 blasts. */
export const HEALTH_MAX = 1000;

/** Hurtbox: the body that can be hit, centred on x, from the feet up. */
export const HURT_HALF_WIDTH = 38;
export const HURT_HEIGHT = 200;
/** Fighters cannot get closer than twice this (centre to centre) unless one clears the other's head. */
export const PUSH_HALF_WIDTH = 42;
export const PROJECTILE_RADIUS = 24;
/** Half the thickness of a beam, for colliding it with other energy. */
export const BEAM_HALF_THICKNESS = 20;
/** How long a clash stays listed in GameState for the renderer to pick up. */
export const CLASH_KEEP_TICKS = 30;
/** Ground knockback slides decay by this factor each tick. */
export const HIT_FRICTION = 0.82;
/** After a KO the round freezes for this many ticks, then restarts. */
export const KO_RESET_TICKS = 240;

/** Projectiles are removed once this far outside the stage. */
export const PROJECTILE_DESPAWN_MARGIN = 400;
export const BEAM_MAX_LENGTH = 1800;

/** A jump pressed this many ticks before landing (or during a kick) still fires. */
export const JUMP_BUFFER_TICKS = 4;
/** Cap for counters that only need to tell "recent" from "long ago". */
export const COUNTER_CAP = 1 << 14;
