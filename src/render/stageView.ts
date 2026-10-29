import { Sprite, type Texture } from 'pixi.js';
import type { ViewLayout } from './layout';

/** Extra cover on every side, so camera shake (both supers at once: up to ~30px) never shows past the painting's edge. */
const OVERSCAN = 32;

/**
 * Stage background that always covers the whole view while keeping its painted floor line
 * (`floorFraction` of the image height) under the fighters' feet.
 */
export class StageBackground {
  readonly sprite: Sprite;
  private baseX = 0;
  private baseY = 0;

  constructor(
    texture: Texture,
    private readonly floorFraction = 0.79,
  ) {
    this.sprite = new Sprite(texture);
  }

  layout(view: ViewLayout): void {
    const { width: tw, height: th } = this.sprite.texture;
    const above = this.floorFraction * th;
    const below = th - above;
    // Smallest scale that covers the width and both the part above and below the floor line.
    const scale = Math.max(
      (view.width + OVERSCAN * 2) / tw,
      (view.floorY + OVERSCAN) / above,
      (view.height - view.floorY + OVERSCAN) / below,
    );
    this.sprite.scale.set(scale);
    this.baseX = Math.round((view.width - tw * scale) / 2);
    this.baseY = Math.round(view.floorY - above * scale);
    this.sprite.position.set(this.baseX, this.baseY);
  }

  /** Camera shake offset (keep within OVERSCAN px). */
  shake(dx: number, dy: number): void {
    this.sprite.position.set(this.baseX + dx, this.baseY + dy);
  }
}
