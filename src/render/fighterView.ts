import { Container, Sprite, Texture, type Spritesheet } from 'pixi.js';
import type { FighterState } from '../sim/state';
import { frameFor, type FrameName } from './animations';
import { FIGHTER_HEIGHT, FLOOR_Y } from './layout';

/** Extra metadata written by the sprite pipeline into the atlas JSON. */
export interface FighterAtlasMeta {
  standingHeight: number;
  anchor: { x: number; y: number };
}

const LANDING_SQUASH_TICKS = 7;
const LANDING_SQUASH = 0.1;

/**
 * The stage's sun is high on the upper left, so shadows fall to the right and slightly away
 * from the camera. The cast shadow is the current pose flattened onto the ground and sheared.
 */
const CAST_SHADOW = {
  alpha: 0.42,
  /** Vertical squash of the silhouette (before the shear shortens it further). */
  flatten: 0.45,
  /** Shear angle in radians; negative leans the top of the silhouette to the right. */
  skew: -1.2,
  /** How far the shadow slides right per px of jump height. */
  driftPerHeight: 0.35,
};
/** Soft dark blob where the feet meet the ground (ambient occlusion). */
const CONTACT_SHADOW = { width: FIGHTER_HEIGHT * 0.55, height: FIGHTER_HEIGHT * 0.1, alpha: 0.75 };
/** Shadows fade out over this jump height. */
const SHADOW_FADE_HEIGHT = 220;
/** Taking a hit: the sprite flashes red and shakes for this long (ms). */
const HIT_FLASH_MS = 160;
const HIT_FLASH_TINT = 0xff9a8a;
const HIT_SHAKE_PX = 5;

/** Draws one fighter. Reads simulation state only; never writes to it. */
export class FighterView {
  readonly root = new Container();
  private readonly sprite: Sprite;
  private readonly castShadow: Sprite;
  private readonly contactShadow: Sprite;
  private textures: Record<string, Texture> = {};
  private baseScale = 1;
  /** Health seen last frame (tracked here, not from `prev`, so hits in multi-tick frames still show). */
  private lastHealth = Infinity;
  private flashMs = 0;
  /** Light the fighter stands in (e.g. warm lava glow); multiplies the sprite. */
  private ambient = 0xffffff;

  constructor(sheet: Spritesheet) {
    this.contactShadow = new Sprite(softBlobTexture());
    this.contactShadow.anchor.set(0.5);

    this.castShadow = new Sprite();
    this.castShadow.tint = 0x000000;
    this.castShadow.skew.x = CAST_SHADOW.skew;

    this.sprite = new Sprite();
    this.root.addChild(this.castShadow, this.contactShadow, this.sprite);
    this.setSheet(sheet);
  }

  setAmbient(tint: number): void {
    this.ambient = tint;
  }

  /** Swap the character's art; takes effect on the next update. */
  setSheet(sheet: Spritesheet): void {
    const meta = (sheet.data.meta as unknown as { fighter: FighterAtlasMeta }).fighter;
    this.textures = sheet.textures;
    this.baseScale = FIGHTER_HEIGHT / meta.standingHeight;
    for (const sp of [this.sprite, this.castShadow]) {
      sp.texture = this.textures['idle_stance'];
      sp.anchor.set(meta.anchor.x, meta.anchor.y);
    }
  }

  /** `alpha` interpolates position between the last two ticks for smooth motion on any refresh rate. */
  update(prev: FighterState | undefined, curr: FighterState, alpha: number, deltaMs: number): void {
    const p = prev ?? curr;
    let x = p.x + (curr.x - p.x) * alpha;
    const y = p.y + (curr.y - p.y) * alpha;

    if (curr.health < this.lastHealth) this.flashMs = HIT_FLASH_MS;
    this.lastHealth = curr.health;
    this.flashMs = Math.max(0, this.flashMs - deltaMs);
    this.sprite.tint = this.flashMs > 0 ? HIT_FLASH_TINT : this.ambient;
    if (this.flashMs > 0) x += (Math.random() - 0.5) * 2 * HIT_SHAKE_PX * (this.flashMs / HIT_FLASH_MS);

    const tex = this.textures[frameFor(curr) satisfies FrameName];
    if (this.sprite.texture !== tex) {
      this.sprite.texture = tex;
      this.castShadow.texture = tex;
    }

    // Landing squash: brief and eased.
    let sx = 1;
    let sy = 1;
    if (curr.grounded && curr.landedTick < LANDING_SQUASH_TICKS) {
      const k = 1 - curr.landedTick / LANDING_SQUASH_TICKS;
      const amount = LANDING_SQUASH * k * k;
      sy = 1 - amount;
      sx = 1 + amount * 0.6;
    }
    this.sprite.position.set(x, FLOOR_Y - y);
    this.sprite.scale.set(this.baseScale * sx * curr.facing, this.baseScale * sy);

    // Shadows stay on the floor; they drift away from the sun and fade as the fighter rises.
    const lift = Math.min(1, y / SHADOW_FADE_HEIGHT);
    this.castShadow.position.set(x + y * CAST_SHADOW.driftPerHeight, FLOOR_Y);
    this.castShadow.scale.set(this.baseScale * sx * curr.facing, this.baseScale * sy * CAST_SHADOW.flatten);
    this.castShadow.alpha = CAST_SHADOW.alpha * (1 - lift * 0.7);

    const spread = 1 - lift * 0.4;
    this.contactShadow.position.set(x + y * CAST_SHADOW.driftPerHeight * 0.5, FLOOR_Y);
    this.contactShadow.width = CONTACT_SHADOW.width * spread * sx;
    this.contactShadow.height = CONTACT_SHADOW.height * spread;
    this.contactShadow.alpha = CONTACT_SHADOW.alpha * (1 - lift * 0.8);
  }
}

let blob: Texture | undefined;

/** Radial-gradient ellipse texture, generated once and shared. */
function softBlobTexture(): Texture {
  if (blob) return blob;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  blob = Texture.from(canvas);
  return blob;
}
