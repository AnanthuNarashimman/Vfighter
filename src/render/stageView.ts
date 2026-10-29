import { Sprite, type Texture } from 'pixi.js';
import type { ViewLayout } from './layout';

/**
 * Stage background that always covers the whole view while keeping its painted floor line
 * (`floorFraction` of the image height) under the fighters' feet.
 */
export class StageBackground {
  readonly sprite: Sprite;

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
    const scale = Math.max(view.width / tw, view.floorY / above, (view.height - view.floorY) / below);
    this.sprite.scale.set(scale);
    this.sprite.position.set(Math.round((view.width - tw * scale) / 2), Math.round(view.floorY - above * scale));
  }
}
