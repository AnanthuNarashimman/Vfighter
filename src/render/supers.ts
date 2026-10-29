import { MOVES, isMoveId, phaseAt, type Element } from '../sim/moves';
import type { FighterState } from '../sim/state';

/** 0..1 while a fighter of `element` is winding up their super (its startup phase), else 0. */
export function superCharge(f: FighterState, element: Element): number {
  if (f.element !== element || !isMoveId(f.action) || !MOVES[f.action].cataclysm) return 0;
  const move = MOVES[f.action];
  const phase = phaseAt(move, f.actionTick, f.moveSustained);
  return phase?.phase === 'startup' ? (phase.tick + 1) / move.phases[0].ticks : 0;
}
