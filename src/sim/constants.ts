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
/**
 * Ducking lowers the hurtbox below energy height (blasts and beams fly at 0.68 of the body,
 * ~141px, with a 24px radius), so ducking dodges energy; kicks still reach it.
 */
export const CROUCH_HURT_HEIGHT = 112;

/**
 * Guard: the shield's strength. Blocked hits and holding the shield drain it; it refills once
 * the shield has been down a while. Emptying it breaks the guard and leaves the fighter open.
 */
export const GUARD_MAX = 100;
/** Holding the shield up with nothing hitting it lasts about 12 seconds. */
export const GUARD_HOLD_DRAIN = 0.14;
export const GUARD_REGEN = 0.3;
export const GUARD_REGEN_DELAY = 50;
/** After the shield drops (or breaks) it cannot be raised again until the guard is back to this. */
export const GUARD_RAISE_MIN = 25;
export const GUARD_BREAK_STUN = 55;
/**
 * The shield is projected from the outstretched palm (~0.49 of the body forward, fingertips at
 * ~0.55, measured from the block frames); its surface stands this far in front of the body
 * centre and blocked energy stops there.
 */
export const SHIELD_REACH = Math.round(FIGHTER_HEIGHT * 0.6);
/** Blocked hits push the blocker back by this share of the hit's knockback. */
export const BLOCK_PUSHBACK = 0.6;
/**
 * A raised shield unfolds from the palm over this many ticks. It is solid: the opponent's body
 * can't pass its surface, and while it is unfolding it shoves a close opponent away.
 */
export const SHIELD_OPEN_TICKS = 6;
/** Skid speed (px per tick) of a fighter shoved away by an opening shield; it eases off by SHOVE_FRICTION per tick. */
export const SHOVE_SPEED = 9;
export const SHOVE_FRICTION = 0.8;
/** Fighters cannot get closer than twice this (centre to centre) unless one clears the other's head. */
export const PUSH_HALF_WIDTH = 54;
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
