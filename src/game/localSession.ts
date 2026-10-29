import type { InputSource } from '../input/keyboard';
import { TICK_MS } from '../sim/constants';
import type { Element } from '../sim/moves';
import type { GameState } from '../sim/state';
import { step } from '../sim/step';

/** Never simulate more than this many ticks per frame (avoids a spiral after a long stall). */
const MAX_TICKS_PER_FRAME = 5;

/**
 * Runs the simulation at a fixed 60Hz from variable-rate frames using an accumulator.
 * One InputSource per fighter; an online session would swap these for local + remote sources.
 */
export class LocalSession {
  /** State before the most recent tick, for render interpolation. */
  previous: GameState;
  current: GameState;
  private accumulator = 0;

  constructor(
    initial: GameState,
    private readonly sources: readonly InputSource[],
  ) {
    this.previous = initial;
    this.current = initial;
  }

  /**
   * Change which element (and so which super) a fighter has, for switching characters while
   * testing locally. Patches both kept states so interpolation stays consistent.
   */
  setElement(fighter: number, element: Element): void {
    const patch = (s: GameState): GameState => ({
      ...s,
      fighters: s.fighters.map((f, i) => (i === fighter ? { ...f, element } : f)),
    });
    this.previous = patch(this.previous);
    this.current = patch(this.current);
  }

  /** Feed elapsed real time; returns how far (0..1) we are between `previous` and `current`. */
  advance(elapsedMs: number): number {
    this.accumulator += Math.min(elapsedMs, 250);
    let ticks = 0;
    while (this.accumulator >= TICK_MS && ticks < MAX_TICKS_PER_FRAME) {
      const inputs = this.sources.map((s) => s.sample());
      this.previous = this.current;
      this.current = step(this.current, inputs);
      this.accumulator -= TICK_MS;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = Math.min(this.accumulator, TICK_MS);
    return this.accumulator / TICK_MS;
  }
}
