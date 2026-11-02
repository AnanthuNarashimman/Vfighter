import {
  BEAM_HALF_THICKNESS,
  DREAM,
  FIGHTER_HEIGHT,
  GRAVITY,
  SQUIRREL,
  SQUIRREL_HITS,
  STAGE_MARGIN,
  STAGE_WIDTH,
} from './constants';
import { applyHit, around, firingBeam, hurtbox, muzzle, overlaps, type Box } from './combat';
import { MOVES, phaseAt, type HitDef } from './moves';
import { nextRandom } from './rng';
import type { Cataclysm, Critter, CritterState, FighterState, Mutable, ProjectileState } from './state';

export interface DreamStep {
  readonly cataclysms: Cataclysm[];
  readonly critters: Critter[];
  readonly projectiles: ProjectileState[];
  readonly rngSeed: number;
  readonly nextId: number;
}

/** States in which a squirrel is out and fighting: it can be hit, and counts toward the pack. */
const FIGHTING: ReadonlySet<CritterState> = new Set(['leap', 'run', 'windup', 'lunge', 'recover']);
const LO = STAGE_MARGIN * 0.5;
const HI = STAGE_WIDTH - STAGE_MARGIN * 0.5;

/**
 * Mind's super, Nutmare, for one tick: every running dream ages (straight to its outro once the
 * round is decided), its director sends squirrels at the target, the squirrels run, lunge and bite,
 * and the target's kicks, blasts and beams knock them out. Mutates the fighters (bites land on
 * this tick's fresh copies); returns everything else new.
 *
 * The director keeps the damage in DREAM's range. It expects the squirrels to have dealt a share of
 * `minDamage` that grows with the dream's progress, and the further behind they are, the more
 * squirrels it keeps out, the closer to the target they surface, the faster they come, and the
 * more of them ambush from right under the target; when they are ahead of a pace that reaches
 * `maxDamage` only at the end, it sends one at a time, slowly. If the target still holds them off, the finale
 * brings the rest down in a pile nothing can stop. Bites never take more than `maxDamage` in all;
 * once it is reached, the squirrels leave.
 */
export function stepDream(
  cataclysms: readonly Cataclysm[],
  critters: readonly Critter[],
  fighters: Mutable<FighterState>[],
  projectiles: readonly ProjectileState[],
  rngSeed: number,
  nextId: number,
  roundOver: boolean,
): DreamStep {
  let seed = rngSeed;
  const random = (): number => {
    const [value, next] = nextRandom(seed);
    seed = next;
    return value;
  };

  // Age the dreams. Health dealt is tallied per owner as the squirrels bite.
  const dreams = new Map<number, Mutable<Cataclysm>>();
  const others: Cataclysm[] = [];
  for (const c of cataclysms) {
    if (c.kind !== 'mind') {
      others.push(c);
      continue;
    }
    let tick = c.tick + 1;
    if (roundOver && tick < DREAM.outro) tick = DREAM.outro;
    if (tick < DREAM.ticks) dreams.set(c.owner, { ...c, tick });
  }
  const targetOf = (owner: number) => fighters.find((f, j) => j !== owner && f.action !== 'ko');

  /** A bite, capped so the dream never takes more than its maximum. */
  const bite = (dream: Mutable<Cataclysm>, target: Mutable<FighterState>, hit: HitDef, dir: 1 | -1): void => {
    const room = DREAM.maxDamage - dream.dealt;
    if (room <= 0) return;
    const before = target.health;
    applyHit(target, { ...hit, damage: Math.min(hit.damage, room) }, dir);
    dream.dealt += before - target.health;
  };

  // The squirrels, one by one.
  const out: Mutable<Critter>[] = [];
  for (const prev of critters) {
    const dream = dreams.get(prev.owner);
    if (!dream) continue; // the dream is over: so are they
    const k: Mutable<Critter> = { ...prev, tick: prev.tick + 1 };
    const target = targetOf(k.owner);
    // Once the dream winds down (or has taken all it may), everyone still out goes back underground.
    const leaving = dream.tick >= DREAM.outro || dream.dealt >= DREAM.maxDamage;
    if (leaving && (FIGHTING.has(k.state) || k.state === 'burrow')) setState(k, 'poof');
    if (!stepCritter(k, dream, target, bite, aheadOfPace(dream))) continue;
    k.x = Math.min(HI, Math.max(LO, k.x));
    out.push(k);
  }

  // The directors send more.
  for (const dream of dreams.values()) {
    const target = targetOf(dream.owner);
    const t = dream.tick;
    if (t === DREAM.finaleAt && target && dream.dealt < DREAM.minDamage) {
      // The finale: whatever is still owed, a pile of squirrels brings down from all sides.
      const share = (DREAM.minDamage - dream.dealt) / SQUIRREL.pileCount;
      for (let i = 0; i < SQUIRREL.pileCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const x = target.x + side * (150 + random() * 160);
        const k = critter(nextId++, dream.owner, x, target.x > x ? 1 : -1, false, 0.9 + random() * 0.2);
        // A ballistic arc that comes down after pileTicks (it homes in on the target as it flies).
        out.push({ ...k, state: 'pile', vy: (GRAVITY * SQUIRREL.pileTicks) / 2, share });
      }
      continue;
    }
    if (t < DREAM.spawnFrom || t >= DREAM.finaleAt || dream.dealt >= DREAM.maxDamage) continue;
    const progress = (t - DREAM.spawnFrom) / (DREAM.finaleAt - DREAM.spawnFrom);
    const behind = Math.max(0, DREAM.minDamage * Math.min(1, progress * 0.9) - dream.dealt);
    dream.nextStrikeIn--;
    const alive = out.filter((k) => k.owner === dream.owner && (FIGHTING.has(k.state) || k.state === 'burrow')).length;
    // Ahead of the pace that only reaches maxDamage at the end: ease off, so the dream never empties early.
    const ahead = dream.dealt - paceAt(t);
    // A crowd either way (ahead, they only circle and menace); more as it goes on and when behind.
    const crowd = ahead > 0 ? 5 + Math.floor(progress * 5) : 4 + Math.floor(progress * 6) + Math.floor(behind / 20);
    const want = Math.min(SQUIRREL.maxAlive, crowd);
    if (dream.nextStrikeIn > 0 || alive >= want) continue;
    dream.nextStrikeIn = behind > 20 ? 8 : ahead > 0 ? 28 + Math.floor(random() * 24) : 12 + Math.floor(random() * 14);

    const pace = 0.85 + random() * 0.3 + Math.min(0.3, behind / 200);
    if (!target) {
      // Nobody to dream about (solo testing): they pop up anywhere and show off.
      out.push(critter(nextId++, dream.owner, LO + random() * (HI - LO), random() < 0.5 ? 1 : -1, false, pace));
      continue;
    }
    const ambush = behind > 40 && progress > 0.25 && random() < 0.55;
    let x = target.x;
    if (!ambush) {
      const side = random() < 0.5 ? -1 : 1;
      const dist = behind > 25 ? 120 + random() * 110 : 180 + random() * 240;
      x = target.x + side * dist;
      if (x < LO || x > HI) x = target.x - side * dist;
    }
    x = Math.min(HI, Math.max(LO, x));
    out.push(critter(nextId++, dream.owner, x, target.x >= x ? 1 : -1, ambush, pace));
  }

  // The target fights back: kicks reach squirrels on the ground; blasts and beams fly at chest
  // height, so they only catch squirrels in the air.
  const gone = new Set<number>();
  for (const k of out) {
    if (!FIGHTING.has(k.state) || (k.state === 'leap' && k.tick < 4)) continue;
    const body = critterBox(k);
    for (const [i, f] of fighters.entries()) {
      if (i === k.owner || k.state === 'knocked') continue;
      const kick = kickBox(f);
      if (kick && overlaps(kick, body)) knockOut(k, f.facing);
      else if (firingBeam(f) && overlaps(beamBox(f), body)) knockOut(k, f.facing);
    }
    if (k.state === 'knocked') continue;
    const p = projectiles.find((p) => p.owner !== k.owner && !gone.has(p.id) && overlaps(around(p), body));
    if (p) {
      gone.add(p.id);
      knockOut(k, p.vx > 0 ? 1 : -1);
    }
  }

  return {
    cataclysms: [...others, ...dreams.values()],
    critters: out,
    projectiles: gone.size ? projectiles.filter((p) => !gone.has(p.id)) : [...projectiles],
    rngSeed: seed,
    nextId,
  };
}

/**
 * Health the dream may have taken by tick `t`: a pace that reaches maxDamage just before the finale,
 * so the squirrels spread their bites over the whole dream instead of finishing early.
 */
function paceAt(t: number): number {
  const progress = Math.max(0, (t - DREAM.spawnFrom) / (DREAM.finaleAt - DREAM.spawnFrom));
  return DREAM.maxDamage * Math.min(1, progress * 1.05);
}

/** Ahead of pace: the squirrels hold back and circle the target, menacing, until the pace catches up. */
function aheadOfPace(dream: Cataclysm): boolean {
  return dream.tick < DREAM.finaleAt && dream.dealt >= paceAt(dream.tick) + 10;
}

function critter(id: number, owner: number, x: number, facing: 1 | -1, ambush: boolean, pace: number): Critter {
  return { id, owner, x, y: 0, vx: 0, vy: 0, facing, state: 'burrow', tick: 0, ambush, hit: false, pace, share: 0 };
}

function setState(k: Mutable<Critter>, state: CritterState): void {
  k.state = state;
  k.tick = 0;
  k.hit = false;
}

/** One squirrel for one tick. Returns false once it is gone (knocked out of sight, back underground). */
function stepCritter(
  k: Mutable<Critter>,
  dream: Mutable<Cataclysm>,
  target: Mutable<FighterState> | undefined,
  bite: (dream: Mutable<Cataclysm>, target: Mutable<FighterState>, hit: HitDef, dir: 1 | -1) => void,
  holdBack: boolean,
): boolean {
  const toward = (): 1 | -1 => (target ? (target.x >= k.x ? 1 : -1) : k.facing);
  const touching = () => target !== undefined && overlaps(critterBox(k), hurtbox(target));

  switch (k.state) {
    case 'burrow':
      // An ambusher waits underground while the dream holds back.
      if (k.ambush && holdBack) k.tick = Math.min(k.tick, SQUIRREL.ambushTicks - 6);
      if (k.tick >= (k.ambush ? SQUIRREL.ambushTicks : SQUIRREL.burrowTicks)) {
        setState(k, 'leap');
        k.facing = toward();
        k.vy = SQUIRREL.leapVy;
        k.vx = k.ambush ? 0 : k.facing * 1.5 * k.pace;
      }
      return true;
    case 'run': {
      k.facing = toward();
      const step = SQUIRREL.runSpeed * k.pace;
      if (target && holdBack) {
        // Holding back: a mob milling round the target, each at its own distance, every so often
        // darting across to the other side of them, and hopping about.
        const keep = 140 + (k.id % 6) * 32 + Math.sin(k.tick * 0.05 + k.id) * 30;
        const side = Math.floor((k.tick + k.id * 37) / 150) % 2 === 0 ? 1 : -1;
        const spot = target.x + (k.id % 2 === 0 ? side : -side) * keep;
        const off = spot - k.x;
        k.vx = Math.abs(off) < 10 ? 0 : Math.sign(off) * step * (Math.abs(off) > 120 ? 1.3 : 0.7);
        k.x += k.vx;
        if (k.vx !== 0) k.facing = k.vx > 0 ? 1 : -1;
        if ((k.tick + k.id * 11) % (45 + (k.id % 5) * 12) === 0) {
          setState(k, 'leap');
          k.vy = 5 + (k.id % 3) * 1.5;
        }
        return true;
      }
      k.vx = k.facing * step;
      k.x += k.vx;
      // Nobody to chase: a few hops about, then a show of fists.
      if (target ? Math.abs(target.x - k.x) <= SQUIRREL.reach : k.tick > 40) setState(k, 'windup');
      return true;
    }
    case 'windup':
      k.vx = 0;
      k.facing = toward();
      if (k.tick >= SQUIRREL.windupTicks) {
        setState(k, 'lunge');
        k.vx = k.facing * SQUIRREL.lungeVx;
        k.vy = SQUIRREL.lungeVy;
      }
      return true;
    case 'recover':
      k.vx = 0;
      if (k.tick >= SQUIRREL.recoverTicks) setState(k, 'run');
      return true;
    case 'poof':
      return k.tick < SQUIRREL.poofTicks;
    case 'pile':
      // Homing in: whatever is left of the gap closes evenly over the rest of the flight.
      if (target) k.x += (target.x - k.x) / Math.max(1, SQUIRREL.pileTicks - k.tick + 1);
      break;
    default:
      k.x += k.vx;
  }

  // Airborne: leap, lunge, pile, knocked.
  k.vy -= GRAVITY;
  k.y += k.vy;
  if (k.state === 'pile' && k.tick >= SQUIRREL.pileTicks) {
    if (target) bite(dream, target, { damage: k.share, guardDamage: 0, hitstun: 16, knockback: 0, unblockable: true }, k.facing);
    k.y = Math.max(0, k.y);
    knockOut(k, -k.facing as 1 | -1);
    return true;
  }
  if (target && !k.hit && touching()) {
    if (k.state === 'lunge') {
      bite(dream, target, SQUIRREL_HITS.bite, k.facing);
      k.hit = true;
      // Bounce back off them.
      k.vx = -k.facing * 2.5;
      k.vy = Math.max(k.vy, 3);
    } else if (k.state === 'leap' && k.ambush) {
      bite(dream, target, SQUIRREL_HITS.ambush, k.facing);
      k.hit = true;
    }
  }
  if (k.y > 0) return k.state !== 'knocked' || k.tick < SQUIRREL.knockedTicks;
  // Touchdown.
  k.y = 0;
  k.vy = 0;
  if (k.state === 'knocked') return false;
  if (k.state === 'leap') setState(k, 'run');
  else if (k.state === 'lunge') setState(k, 'recover');
  return true;
}

/** Knocked out: sent flying away from the blow, spinning, and gone once it lands. */
function knockOut(k: Mutable<Critter>, dir: 1 | -1): void {
  setState(k, 'knocked');
  k.vx = dir * 5;
  k.vy = 8;
}

function critterBox(k: Critter): Box {
  return { x0: k.x - SQUIRREL.halfWidth, x1: k.x + SQUIRREL.halfWidth, y0: k.y, y1: k.y + SQUIRREL.height };
}

/** A kick in its active phase, reaching down to the ground for something this small. */
function kickBox(f: FighterState): Box | null {
  if (f.action !== 'kick' || phaseAt(MOVES.kick, f.actionTick, f.moveSustained)?.phase !== 'active') return null;
  const b = MOVES.kick.hit!.hitbox!;
  const near = f.x + f.facing * b.x0 * FIGHTER_HEIGHT;
  const far = f.x + f.facing * b.x1 * FIGHTER_HEIGHT;
  return { x0: Math.min(near, far), x1: Math.max(near, far), y0: f.y, y1: f.y + b.y1 * FIGHTER_HEIGHT };
}

/** The length of a firing beam, as a box. */
function beamBox(f: FighterState): Box {
  const m = muzzle(f);
  const end = m.x + f.facing * f.beamLength;
  return { x0: Math.min(m.x, end), x1: Math.max(m.x, end), y0: m.y - BEAM_HALF_THICKNESS, y1: m.y + BEAM_HALF_THICKNESS };
}
