/**
 * World coordinates are a 1280x720 reference frame: x matches the simulation's stage width, and
 * the floor sits at FLOOR_Y. The view (canvas) always fills the window: it keeps the stage's
 * 1280 width and takes its height from the window's shape, so wider windows crop a little sky and
 * grass, taller ones reveal more. The background is re-fitted to cover whatever is visible.
 */
export const VIEW_WIDTH = 1280;
export const REF_HEIGHT = 720;

/** Floor line in world coordinates (on the dirt patch of the valley stage). */
export const FLOOR_Y = Math.round(REF_HEIGHT * 0.79);
/** Where the floor line sits on screen, as a fraction of the view height. */
const FLOOR_SCREEN_FRACTION = 0.79;
/** On-screen height of a standing fighter: the simulation's body size, drawn 1:1. */
export { FIGHTER_HEIGHT } from '../sim/constants';
/** Below this view height (very wide windows) the view grows wider instead, so jumps stay visible. */
const MIN_VIEW_HEIGHT = 540;

export interface ViewLayout {
  /** Canvas size in render pixels (CSS-scaled to the full window). */
  readonly width: number;
  readonly height: number;
  /** Offset of the world container inside the view. */
  readonly worldX: number;
  readonly worldY: number;
  /** Floor line in view coordinates. */
  readonly floorY: number;
}

export function computeLayout(windowWidth: number, windowHeight: number): ViewLayout {
  const aspect = Math.max(0.3, windowWidth / Math.max(1, windowHeight));
  const width = Math.max(VIEW_WIDTH, Math.round(MIN_VIEW_HEIGHT * aspect));
  const height = Math.round(width / aspect);
  const floorY = Math.round(height * FLOOR_SCREEN_FRACTION);
  return { width, height, worldX: Math.round((width - VIEW_WIDTH) / 2), worldY: floorY - FLOOR_Y, floorY };
}
