import { CATACLYSMS, STAGE_MARGIN, STAGE_WIDTH } from './constants';
import { MOVES, isMoveId, phaseAt } from './moves';
import { nextRandom } from './rng';
import type { Cataclysm, FighterState, Strike } from './state';

export interface CataclysmStep {
  readonly cataclysms: Cataclysm[];
  readonly strikes: Strike[];
  readonly rngSeed: number;
  readonly nextId: number;
}

/**
 * Supers for one tick. A fighter whose super lands (first active tick) starts (or restarts) their
 * cataclysm; while it lasts, strikes of its element open at seeded-random spots, some aimed near
 * the opponent; every strike ages through warn -> active -> fade and is then dropped.
 * `roundOver` stops new strikes (the ones already under way play out).
 */
export function stepCataclysms(
  cataclysms: readonly Cataclysm[],
  strikes: readonly Strike[],
  fighters: readonly FighterState[],
  rngSeed: number,
  nextId: number,
  roundOver: boolean,
): CataclysmStep {
  let seed = rngSeed;
  const random = (): number => {
    const [value, next] = nextRandom(seed);
    seed = next;
    return value;
  };

  let active = [...cataclysms];
  fighters.forEach((f, owner) => {
    if (!isMoveId(f.action) || !MOVES[f.action].cataclysm) return;
    const phase = phaseAt(MOVES[f.action], f.actionTick, f.moveSustained);
    if (phase?.phase !== 'active' || phase.tick !== 0) return;
    // The first strike follows the super almost at once (unless the super has an entrance).
    active = active.filter((c) => c.owner !== owner);
    active.push({ owner, kind: f.element, tick: 0, nextStrikeIn: CATACLYSMS[f.element].firstStrike ?? 8 });
  });

  const aged = strikes
    .map((s) => ({ ...s, age: s.age + 1 }))
    .filter((s) => {
      const def = CATACLYSMS[s.kind];
      return s.age < def.warnTicks + def.activeTicks + def.fadeTicks;
    });

  const next: Cataclysm[] = [];
  for (const c of active) {
    const def = CATACLYSMS[c.kind];
    const tick = c.tick + 1;
    let wait = c.nextStrikeIn - 1;
    if (wait <= 0 && !roundOver) {
      const target = fighters.find((_, j) => j !== c.owner);
      const lo = STAGE_MARGIN * 0.5;
      const hi = STAGE_WIDTH - STAGE_MARGIN * 0.5;
      const x = target && random() < def.aim ? target.x + (random() * 2 - 1) * def.aimSpread : lo + random() * (hi - lo);
      aged.push({ id: nextId++, owner: c.owner, kind: c.kind, x: Math.min(hi, Math.max(lo, x)), age: 0, struck: 0 });
      wait = def.interval.min + Math.floor(random() * (def.interval.max - def.interval.min + 1));
    }
    if (tick < def.ticks) next.push({ ...c, tick, nextStrikeIn: wait });
  }

  return { cataclysms: next, strikes: aged, rngSeed: seed, nextId };
}

/** Is the strike dangerous (lava up, bolt down) at its current age? */
export function strikeActive(s: Strike): boolean {
  const def = CATACLYSMS[s.kind];
  return s.age >= def.warnTicks && s.age < def.warnTicks + def.activeTicks;
}
