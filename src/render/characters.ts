/**
 * Playable characters. Purely cosmetic for now: every character uses the same moves and the
 * simulation never sees which one is picked, so switching mid-match is safe.
 */
export type EnergyStyle = 'fire' | 'thunder';

/** Energy gauge colours. */
export interface HudPalette {
  /** Fill when a blast is affordable. */
  readonly fill: number;
  /** Fill when it is not. */
  readonly dim: number;
  /** Highlight along the top of the fill, and the "full" pulse. */
  readonly hot: number;
  readonly trough: number;
}

export interface CharacterDef {
  readonly id: string;
  /** Shown in the HUD. */
  readonly name: string;
  /** Atlas written by scripts/build-sprites.mjs, relative to the assets folder. */
  readonly sheet: string;
  readonly energy: EnergyStyle;
  readonly hud: HudPalette;
}

export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 'maroon',
    name: 'FLASH',
    sheet: 'fighters/maroon.json',
    energy: 'fire',
    hud: { fill: 0xffa63a, dim: 0xa8401f, hot: 0xfff4d6, trough: 0x2a1510 },
  },
  {
    id: 'navy',
    name: 'VOLT',
    sheet: 'fighters/navy.json',
    energy: 'thunder',
    hud: { fill: 0x5cb4ff, dim: 0x2d4f9e, hot: 0xeef6ff, trough: 0x0e1630 },
  },
];
