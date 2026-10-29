/**
 * One fighter's input for one simulation tick. Buttons are "held" states; the simulation derives
 * presses itself (by comparing with the previous tick), so an input frame is all that needs to be
 * sent over the network later.
 */
export interface InputFrame {
  readonly left: boolean;
  readonly right: boolean;
  readonly jump: boolean;
  readonly kick: boolean;
  readonly blast: boolean;
  readonly beam: boolean;
}

export type Button = keyof InputFrame;

export const NO_INPUT: InputFrame = Object.freeze({
  left: false,
  right: false,
  jump: false,
  kick: false,
  blast: false,
  beam: false,
});

const BITS: readonly Button[] = ['left', 'right', 'jump', 'kick', 'blast', 'beam'];

/** Pack into a small integer (for network packets / replays). */
export function encodeInput(input: InputFrame): number {
  let bits = 0;
  BITS.forEach((key, i) => {
    if (input[key]) bits |= 1 << i;
  });
  return bits;
}

export function decodeInput(bits: number): InputFrame {
  const frame = { ...NO_INPUT };
  BITS.forEach((key, i) => {
    frame[key] = (bits & (1 << i)) !== 0;
  });
  return frame;
}
