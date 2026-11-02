import type { Element, Kit } from '../sim/moves';

/**
 * Playable characters. Mostly cosmetic: the simulation only sees each one's element (its super)
 * and kit (which moves it has), both patched in live, so switching mid-match is safe.
 */
export type EnergyStyle = 'fire' | 'thunder' | 'goo' | 'sound';

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
  /** Look of the character's blasts, beams and shield. */
  readonly energy: EnergyStyle;
  /** Which super the character has (given a full kit). */
  readonly element: Element;
  readonly kit: Kit;
  readonly hud: HudPalette;
  /** Still being built: only offered in solo testing, not in versus. */
  readonly soloOnly?: boolean;
}

export const CHARACTERS: readonly CharacterDef[] = [
  {
    id: 'maroon',
    name: 'FLASH',
    sheet: 'fighters/maroon.json',
    energy: 'fire',
    element: 'fire',
    kit: 'full',
    hud: { fill: 0xffa63a, dim: 0xa8401f, hot: 0xfff4d6, trough: 0x2a1510 },
  },
  {
    id: 'navy',
    name: 'VOLT',
    sheet: 'fighters/navy.json',
    energy: 'thunder',
    element: 'thunder',
    kit: 'full',
    hud: { fill: 0x5cb4ff, dim: 0x2d4f9e, hot: 0xeef6ff, trough: 0x0e1630 },
  },
  {
    // Fights with fluid instead of energy: a sticky white goo ball and a gushing stream (see
    // gooView.ts). His super, Goon Fall, raises a colossus of goo that rains goo balls (colossusView.ts).
    id: 'gooner',
    name: 'GOONER',
    sheet: 'fighters/gooner.json',
    energy: 'goo',
    element: 'goo',
    kit: 'full',
    hud: { fill: 0xf3f0e6, dim: 0x8e8875, hot: 0xffffff, trough: 0x1e1c18 },
  },
  {
    // Squirrel-tailed brawler who fights with sound: a humming ball of it and a loud, widening beam
    // (see soundView.ts). He shields behind his curled-up tail. His super, Nutmare, sends the
    // opponent into a dream full of squirrels (dream.ts, dreamView.ts).
    id: 'tkurii',
    name: 'TKURII',
    sheet: 'fighters/tkurii.json',
    energy: 'sound',
    element: 'mind',
    kit: 'full',
    hud: { fill: 0xe0832f, dim: 0x8a4a1c, hot: 0xffe6c4, trough: 0x24150b },
  },
];
