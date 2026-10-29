import {
  BEAM_HALF_THICKNESS,
  FIGHTER_HEIGHT,
  HURT_HALF_WIDTH,
  HURT_HEIGHT,
  PROJECTILE_RADIUS,
  PUSH_HALF_WIDTH,
  STAGE_MARGIN,
  STAGE_WIDTH,
} from './constants';
import { MOVES, MUZZLE, phaseAt, sustainEndTick, type HitDef } from './moves';
import { setAction, type Clash, type FighterState, type Mutable, type ProjectileState } from './state';

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
    const contact = Math.max(0, ahead - HURT_HALF_WIDTH);
    if (ahead > -HURT_HALF_WIDTH && muzzleY >= v.y && muzzleY <= v.y + HURT_HEIGHT && contact <= a.beamLength) {
      a.beamLength = contact;
      a.beamBlocked = true;
      applyHit(v, hit, a.facing);
    }
  }
}

/** Damage, hitstun and knockback; a finishing blow launches the victim instead. */
function applyHit(v: Mutable<FighterState>, hit: HitDef, dir: 1 | -1): void {
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
  if (!v.grounded) v.vy = Math.max(v.vy, 3); // a hit in the air pops the victim up slightly
}

/** Bodies can't overlap; they share the push, and one pinned against a wall pushes the other. */
function pushApart(a: Mutable<FighterState>, b: Mutable<FighterState>): void {
  if (a.action === 'ko' || b.action === 'ko') return;
  if (Math.abs(a.y - b.y) >= HURT_HEIGHT * 0.7) return; // clearing a head is allowed: jump over
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const min = PUSH_HALF_WIDTH * 2;
  const overlap = min - (right.x - left.x);
  if (overlap <= 0) return;
  const lo = STAGE_MARGIN;
  const hi = STAGE_WIDTH - STAGE_MARGIN;
  left.x = Math.max(lo, left.x - overlap / 2);
  right.x = Math.min(hi, right.x + overlap / 2);
  if (right.x - left.x < min) {
    if (left.x <= lo) right.x = left.x + min;
    else left.x = right.x - min;
  }
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

function hurtbox(f: FighterState): Box {
  return { x0: f.x - HURT_HALF_WIDTH, x1: f.x + HURT_HALF_WIDTH, y0: f.y, y1: f.y + HURT_HEIGHT };
}

function around(p: ProjectileState): Box {
  return { x0: p.x - PROJECTILE_RADIUS, x1: p.x + PROJECTILE_RADIUS, y0: p.y - PROJECTILE_RADIUS, y1: p.y + PROJECTILE_RADIUS };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
