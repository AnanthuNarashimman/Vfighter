import {
  BEAM_HALF_THICKNESS,
  BLOCK_PUSHBACK,
  CATACLYSMS,
  CROUCH_HURT_HEIGHT,
  FIGHTER_HEIGHT,
  GUARD_BREAK_STUN,
  SHIELD_OPEN_TICKS,
  SHIELD_REACH,
  SHOVE_SPEED,
  STRIKE_GRACE_TICKS,
  HURT_HALF_WIDTH,
  HURT_HEIGHT,
  PROJECTILE_RADIUS,
  PUSH_HALF_WIDTH,
  STAGE_MARGIN,
  STAGE_WIDTH,
} from './constants';
import { strikeActive } from './cataclysm';
import { MOVES, MUZZLE, STRIKE_HITS, phaseAt, sustainEndTick, type HitDef } from './moves';
import { setAction, type Clash, type FighterState, type Mutable, type ProjectileState, type Strike } from './state';

/** Where a clash happened; `step` stamps the id and tick. */
export type ClashSpawn = Omit<Clash, 'id' | 'tick'>;

interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * Everything fighters do to each other in one tick, after they have each moved. Energy meeting
 * energy is settled first (beam vs beam, blast vs beam, blast vs blast all cancel where they meet,
 * reported through `clash`), so cancelled energy never deals damage. Then kicks, beams and blasts
 * land, and bodies push apart. Mutates the fighters (fresh copies made by this tick's step) and
 * returns the projectiles that survive.
 */
export function resolveCombat(
  fighters: Mutable<FighterState>[],
  projectiles: readonly ProjectileState[],
  clash: (c: ClashSpawn) => void = () => {},
): ProjectileState[] {
  const gone = new Set<number>();
  for (const f of fighters) f.beamBlocked = false;

  // Beam vs beam: both fronts stop at the middle of where they overlap, and both beams die out there.
  fighters.forEach((a, i) => {
    fighters.forEach((b, j) => {
      if (j <= i || !firingBeam(a) || !firingBeam(b) || a.facing === b.facing) return;
      const ma = muzzle(a);
      const mb = muzzle(b);
      if (a.facing * (b.x - a.x) <= 0 || Math.abs(ma.y - mb.y) >= BEAM_HALF_THICKNESS * 2) return;
      const gap = a.facing * (mb.x - ma.x);
      if (a.beamLength + b.beamLength < gap) return;
      // Fronts overlap; meet halfway between them (muzzles already crossed: halfway between muzzles).
      const meet = gap > 0 ? (ma.x + a.facing * a.beamLength + mb.x + b.facing * b.beamLength) / 2 : (ma.x + mb.x) / 2;
      a.beamLength = Math.max(0, a.facing * (meet - ma.x));
      b.beamLength = Math.max(0, b.facing * (meet - mb.x));
      endBeam(a);
      endBeam(b);
      clash({ x: meet, y: (ma.y + mb.y) / 2, owners: [i, j], kind: 'beam' });
    });
  });

  // Blast vs beam: the blast bursts on the beam and the beam dies out at that point.
  for (const p of projectiles) {
    const i = fighters.findIndex((f, j) => j !== p.owner && firingBeam(f) && blastOnBeam(p, f));
    if (i < 0) continue;
    const f = fighters[i];
    const m = muzzle(f);
    f.beamLength = Math.max(0, f.facing * (p.x - m.x));
    endBeam(f);
    gone.add(p.id);
    clash({ x: p.x, y: p.y, owners: [p.owner, i], kind: 'blast' });
  }

  // Blast vs blast: they burst where they meet.
  for (const a of projectiles) {
    for (const b of projectiles) {
      if (a.id >= b.id || a.owner === b.owner || gone.has(a.id) || gone.has(b.id)) continue;
      if (Math.abs(a.x - b.x) < PROJECTILE_RADIUS * 2 && Math.abs(a.y - b.y) < PROJECTILE_RADIUS * 2) {
        gone.add(a.id);
        gone.add(b.id);
        clash({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, owners: [a.owner, b.owner], kind: 'blast' });
      }
    }
  }

  fighters.forEach((attacker, i) => {
    fighters.forEach((victim, j) => {
      if (i !== j) strike(attacker, victim);
    });
  });

  const blast = MOVES.blast.hit!;
  for (const p of projectiles) {
    if (gone.has(p.id)) continue;
    const victim = fighters.find((f, j) => j !== p.owner && f.action !== 'ko' && overlaps(hurtbox(f), around(p)));
    if (!victim) continue;
    applyHit(victim, blast, p.vx > 0 ? 1 : -1);
    gone.add(p.id);
  }

  if (fighters.length === 2) pushApart(fighters[0], fighters[1]);
  return gone.size ? projectiles.filter((p) => !gone.has(p.id)) : [...projectiles];
}

/** Kicks and beams: the attacker's active move against one opponent. */
function strike(a: Mutable<FighterState>, v: Mutable<FighterState>): void {
  if (v.action === 'ko' || (a.action !== 'kick' && a.action !== 'beam')) return;
  const move = MOVES[a.action];
  const hit = move.hit;
  if (!hit || phaseAt(move, a.actionTick, a.moveSustained)?.phase !== 'active') return;

  if (hit.hitbox && !a.moveHit) {
    const b = hit.hitbox;
    const near = a.x + a.facing * b.x0 * FIGHTER_HEIGHT;
    const far = a.x + a.facing * b.x1 * FIGHTER_HEIGHT;
    const box = {
      x0: Math.min(near, far),
      x1: Math.max(near, far),
      y0: a.y + b.y0 * FIGHTER_HEIGHT,
      y1: a.y + b.y1 * FIGHTER_HEIGHT,
    };
    if (overlaps(box, hurtbox(v))) {
      applyHit(v, hit, a.facing);
      a.moveHit = true;
    }
  }

  if (move.beam && a.beamLength > 0) {
    // The beam runs level from the muzzle; it stops at the near side of a body in its path.
    const { x: muzzleX, y: muzzleY } = muzzle(a);
    const ahead = a.facing * (v.x - muzzleX); // victim centre, measured along the beam
    // A raised shield facing the beam catches it further out than the body would.
    const front = shielding(v, a.facing) ? SHIELD_REACH : HURT_HALF_WIDTH;
    const contact = Math.max(0, ahead - front);
    const box = hurtbox(v);
    if (ahead > -HURT_HALF_WIDTH && muzzleY >= box.y0 && muzzleY <= box.y1 && contact <= a.beamLength) {
      a.beamLength = contact;
      a.beamBlocked = true;
      applyHit(v, hit, a.facing);
    }
  }
}

/**
 * Supers' strikes (lava columns, lightning bolts) hitting anyone but their owner standing in them
 * (once per strike per fighter, and then not again by any strike for STRIKE_GRACE_TICKS). Returns
 * the strikes with who they have struck updated.
 */
export function strikeHits(fighters: Mutable<FighterState>[], strikes: readonly Strike[]): Strike[] {
  return strikes.map((s) => {
    if (!strikeActive(s)) return s;
    const def = CATACLYSMS[s.kind];
    const column = { x0: s.x - def.halfWidth, x1: s.x + def.halfWidth, y0: 0, y1: def.height };
    let struck = s.struck;
    fighters.forEach((f, i) => {
      const bit = 1 << i;
      if (i === s.owner || struck & bit || f.action === 'ko' || f.strikeGrace > 0) return;
      if (!overlaps(column, hurtbox(f))) return;
      // Thrown away from the column's centre.
      applyHit(f, STRIKE_HITS[s.kind], f.x >= s.x ? 1 : -1);
      f.strikeGrace = STRIKE_GRACE_TICKS;
      struck |= bit;
    });
    return struck === s.struck ? s : { ...s, struck };
  });
}

/**
 * Damage, hitstun and knockback; a finishing blow launches the victim instead. A hit on a raised
 * shield costs guard instead of health, and one that empties the guard breaks it. Launching hits
 * throw the victim into the air.
 */
function applyHit(v: Mutable<FighterState>, hit: HitDef, dir: 1 | -1): void {
  if (!hit.unblockable && shielding(v, dir)) {
    v.guard = Math.max(0, v.guard - hit.guardDamage);
    v.guardIdleTicks = 0;
    v.vx = dir * hit.knockback * BLOCK_PUSHBACK;
    if (v.guard > 0) return;
    // Guard break: the shield shatters and the fighter reels, wide open.
    setAction(v, 'hit');
    v.hitstun = GUARD_BREAK_STUN;
    v.guardBrokenTick = 0;
    v.vx = dir * hit.knockback;
    return;
  }

  v.health = Math.max(0, v.health - hit.damage);
  if (v.health === 0) {
    setAction(v, 'ko');
    v.hitstun = 0;
    v.grounded = false;
    v.vx = dir * 6;
    v.vy = 9;
    return;
  }
  if (v.action !== 'hit') setAction(v, 'hit');
  v.hitstun = Math.max(v.hitstun, hit.hitstun);
  v.vx = dir * hit.knockback;
  if (hit.launch) {
    v.grounded = false;
    v.vy = Math.max(v.vy, hit.launch);
  } else if (!v.grounded) {
    v.vy = Math.max(v.vy, 3); // a hit in the air pops the victim up slightly
  }
}

/**
 * Bodies can't overlap. Normally they share the push. A raised shield is a solid wall at its
 * surface that holds its ground: only the other fighter gives way, and while the shield is still
 * unfolding it shoves them into a skid. Against a stage edge, whoever is pinned pushes the other.
 */
function pushApart(a: Mutable<FighterState>, b: Mutable<FighterState>): void {
  if (a.action === 'ko' || b.action === 'ko') return;
  if (Math.abs(a.y - b.y) >= HURT_HEIGHT * 0.7) return; // clearing a head is allowed: jump over
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const leftWall = shieldTowards(left, right.x);
  const rightWall = shieldTowards(right, left.x);
  const min = reach(left, leftWall) + reach(right, rightWall);
  const overlap = min - (right.x - left.x);
  if (overlap <= 0) return;

  const leftShare = leftWall === rightWall ? 0.5 : leftWall ? 0 : 1;
  const lo = STAGE_MARGIN;
  const hi = STAGE_WIDTH - STAGE_MARGIN;
  left.x = Math.max(lo, left.x - overlap * leftShare);
  right.x = Math.min(hi, right.x + overlap * (1 - leftShare));
  if (right.x - left.x < min) {
    if (left.x <= lo) right.x = left.x + min;
    else left.x = right.x - min;
  }

  // An unfolding shield throws a close opponent back.
  if (leftWall && !rightWall && opening(left)) right.shove = Math.max(right.shove, SHOVE_SPEED);
  if (rightWall && !leftWall && opening(right)) left.shove = Math.min(left.shove, -SHOVE_SPEED);
}

/** Does `f` have a shield raised toward something at `x`? */
function shieldTowards(f: FighterState, x: number): boolean {
  return f.action === 'block' && (x - f.x) * f.facing > 0;
}

function opening(f: FighterState): boolean {
  return f.actionTick < SHIELD_OPEN_TICKS;
}

/** How far in front of its centre a body holds the other off: its own width, or its shield as it unfolds. */
function reach(f: FighterState, shielded: boolean): number {
  if (!shielded) return PUSH_HALF_WIDTH;
  const open = Math.min(1, (f.actionTick + 1) / SHIELD_OPEN_TICKS);
  return PUSH_HALF_WIDTH + (SHIELD_REACH - PUSH_HALF_WIDTH) * open;
}

/** A beam in its active phase with some length out. */
function firingBeam(f: FighterState): boolean {
  return f.action === 'beam' && f.beamLength > 0 && phaseAt(MOVES.beam, f.actionTick, f.moveSustained)?.phase === 'active';
}

/** Cut a beam off: jump straight to its recovery, where it fades out at its current length. */
function endBeam(f: Mutable<FighterState>): void {
  f.actionTick = sustainEndTick(MOVES.beam, f.moveSustained)!;
}

/** Does the blast touch the beam anywhere between its muzzle and its front? */
function blastOnBeam(p: ProjectileState, f: FighterState): boolean {
  const m = muzzle(f);
  const along = f.facing * (p.x - m.x);
  return (
    along > -PROJECTILE_RADIUS &&
    along < f.beamLength + PROJECTILE_RADIUS &&
    Math.abs(p.y - m.y) < PROJECTILE_RADIUS + BEAM_HALF_THICKNESS
  );
}

function muzzle(f: FighterState): { x: number; y: number } {
  return { x: f.x + f.facing * MUZZLE.x * FIGHTER_HEIGHT, y: f.y + MUZZLE.y * FIGHTER_HEIGHT };
}

/** Is `f` holding a shield up against an attack travelling in direction `dir`? */
function shielding(f: FighterState, dir: 1 | -1): boolean {
  return f.action === 'block' && f.facing === -dir;
}

/** The body, lower when ducking. A raised shield extends it forward, so attacks meet the shield first. */
function hurtbox(f: FighterState): Box {
  const height = f.action === 'crouch' ? CROUCH_HURT_HEIGHT : HURT_HEIGHT;
  let x0 = f.x - HURT_HALF_WIDTH;
  let x1 = f.x + HURT_HALF_WIDTH;
  if (f.action === 'block') {
    if (f.facing > 0) x1 = f.x + SHIELD_REACH;
    else x0 = f.x - SHIELD_REACH;
  }
  return { x0, x1, y0: f.y, y1: f.y + height };
}

function around(p: ProjectileState): Box {
  return { x0: p.x - PROJECTILE_RADIUS, x1: p.x + PROJECTILE_RADIUS, y0: p.y - PROJECTILE_RADIUS, y1: p.y + PROJECTILE_RADIUS };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
