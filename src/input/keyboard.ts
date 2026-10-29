import type { InputFrame } from '../sim/input';

/** Anything that can produce one InputFrame per tick: keyboard, gamepad, network peer, AI, replay. */
export interface InputSource {
  sample(): InputFrame;
}

export type KeyBindings = Readonly<Record<keyof InputFrame, readonly string[]>>;

/**
 * Two players sharing one keyboard: P1 on WASD with J K L to attack, I (above K) to block and O
 * (above L) for the super; P2 on the arrows with , . / (the same shape as J K L one row down),
 * Right Shift (next to /) to block and Enter for the super, or the numpad. KeyboardEvent.code
 * values, so bindings follow key position regardless of layout.
 */
export const PLAYER_BINDINGS: readonly KeyBindings[] = [
  {
    left: ['KeyA'],
    right: ['KeyD'],
    jump: ['KeyW', 'Space'],
    down: ['KeyS'],
    kick: ['KeyK'],
    blast: ['KeyJ'],
    beam: ['KeyL'],
    block: ['KeyI'],
    super: ['KeyO'],
  },
  {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    jump: ['ArrowUp'],
    down: ['ArrowDown'],
    kick: ['Period', 'Numpad2'],
    blast: ['Comma', 'Numpad1'],
    beam: ['Slash', 'Numpad3'],
    block: ['ShiftRight', 'Numpad0'],
    super: ['Enter', 'NumpadEnter'],
  },
];

/**
 * Collects keyboard state between ticks. A key tapped and released between two samples still
 * counts as held for the next sample, so quick taps are never lost.
 */
export class KeyboardInput implements InputSource {
  private readonly down = new Set<string>();
  private readonly tapped = new Set<string>();
  private readonly bound: ReadonlySet<string>;

  constructor(private readonly bindings: KeyBindings = PLAYER_BINDINGS[0], target: Window = window) {
    this.bound = new Set(Object.values(bindings).flat());
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.reset);
  }

  sample(): InputFrame {
    const held = (key: keyof InputFrame) => this.bindings[key].some((c) => this.down.has(c) || this.tapped.has(c));
    const frame: InputFrame = {
      left: held('left'),
      right: held('right'),
      jump: held('jump'),
      down: held('down'),
      kick: held('kick'),
      blast: held('blast'),
      beam: held('beam'),
      block: held('block'),
      super: held('super'),
    };
    this.tapped.clear();
    return frame;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.bound.has(e.code)) return;
    e.preventDefault(); // keep arrows/space from scrolling the page
    this.down.add(e.code);
    this.tapped.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly reset = (): void => {
    this.down.clear();
    this.tapped.clear();
  };
}
