import { Container, Graphics, Text, type Ticker } from 'pixi.js';
import { ENERGY_MAX, HEALTH_MAX } from '../sim/constants';
import { MOVES } from '../sim/moves';
import type { FighterState, GameState } from '../sim/state';
import { CHARACTERS, type CharacterDef, type HudPalette } from './characters';
import type { ViewLayout } from './layout';

const FONT = 'system-ui, Segoe UI, Arial, sans-serif';
const TITLE_STYLE = { fontFamily: FONT, fontSize: 13, fontWeight: '900', fontStyle: 'italic', fill: 0xffffff } as const;
const KEY_STYLE = { fontFamily: FONT, fontSize: 12, fontWeight: '700', fill: 0x1a1008 } as const;
const LABEL_STYLE = {
  fontFamily: FONT,
  fontSize: 12,
  fontWeight: '600',
  fill: 0xffffff,
  letterSpacing: 0.5,
  stroke: { color: 0x000000, width: 3 },
} as const;

/** A slanted bar's geometry, drawn from the screen edge inward (P2's panel is mirrored). */
interface BarShape {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly slant: number;
}

/** Health: the big bar across the top, each player's reaching nearly to the centre. */
const HEALTH_BAR: BarShape = { x: 16, y: 28, width: 500, height: 22, slant: 12 };
/** Energy: a slimmer segmented gauge tucked under the health bar. */
const BAR: BarShape = { x: 16, y: 58, width: 170, height: 9, slant: 6 };
/** Player tag and name sit above the health bar, starting here from the screen edge. */
const TAG_X = HEALTH_BAR.x + HEALTH_BAR.slant;
const NAME_X = TAG_X + 27;
/** The drain ghost (white trail behind the fill) catches up at this many energy per second. */
const GHOST_SPEED = 60;
/** Lost health shows as a red chunk that holds briefly, then drains away at this rate (hp/s). */
const HEALTH_GHOST_HOLD_MS = 550;
const HEALTH_GHOST_SPEED = 450;
const HEALTH = { fill: 0xffcf3a, low: 0xff6a2a, shine: 0xfff6c8, ghost: 0xe0301e, trough: 0x3a0d0d } as const;
/** Below this share of health the bar turns orange and its frame pulses. */
const HEALTH_LOW = 0.3;
/** The winner is announced this many ticks after the K.O. */
const WINNER_DELAY_TICKS = 50;
/** Controls strip fades out after this many ms; H brings it back. */
const CONTROLS_SHOW_MS = 7000;
const CONTROLS_FADE_MS = 600;
/** Vertical distance between the two players' control strips. */
const CONTROLS_ROW = 32;

type ControlHint = readonly [keys: readonly string[], label: string];

/** Per player, matching input/keyboard.ts PLAYER_BINDINGS. The last entry is the dev-only character switch (see main.ts). */
const CONTROLS: readonly (readonly ControlHint[])[] = [
  [[['A', 'D'], 'move'], [['W'], 'jump'], [['K'], 'kick'], [['J'], 'blast'], [['L'], 'beam (hold)'], [['C'], 'switch fighter']],
  [[['←', '→'], 'move'], [['↑'], 'jump'], [['.'], 'kick'], [[','], 'blast'], [['/'], 'beam (hold)'], [['M'], 'switch fighter']],
];

/**
 * Fighting-game style HUD: per player a big health bar across the top with an energy gauge under
 * it, slim controls strips along the bottom, a K.O. banner when the round is decided, FPS bottom-right.
 */
export class Hud {
  readonly root = new Container();
  private readonly fps: Text;
  private readonly panels: PlayerPanel[];
  private readonly controls = new Container();
  private readonly controlsHint = new Container();
  private readonly banner = new Container();
  private readonly koText: Text;
  private readonly winnerText: Text;
  private time = 0;
  private controlsShownAt = 0;
  private sinceFpsUpdate = 0;

  constructor(target: Window = window) {
    this.panels = [new PlayerPanel(0), new PlayerPanel(1)];
    this.buildControls();

    this.fps = new Text({ text: '', style: { ...LABEL_STYLE, fontSize: 11, fontWeight: '400' } });
    this.fps.anchor.set(1, 0);
    this.fps.alpha = 0.6;

    this.koText = new Text({
      text: 'K.O.',
      style: { ...TITLE_STYLE, fontSize: 120, fill: HEALTH.fill, stroke: { color: 0x2a0800, width: 10 }, letterSpacing: 4 },
    });
    this.koText.anchor.set(0.5);
    this.winnerText = new Text({ text: '', style: { ...TITLE_STYLE, fontSize: 40, stroke: { color: 0x000000, width: 6 } } });
    this.winnerText.anchor.set(0.5);
    this.winnerText.position.y = 92;
    this.banner.addChild(this.koText, this.winnerText);
    this.banner.visible = false;

    this.root.addChild(...this.panels.map((p) => p.root), this.controls, this.controlsHint, this.banner, this.fps);

    target.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyH' || e.repeat) return;
      const visible = this.controls.alpha > 0.5;
      this.controlsShownAt = visible ? -Infinity : this.time;
    });
  }

  setCharacter(player: number, character: CharacterDef): void {
    this.panels[player]?.setCharacter(character);
  }

  layout(view: ViewLayout): void {
    this.panels[1].root.position.x = view.width;
    this.fps.position.set(view.width - 10, view.height - 22);
    this.banner.position.set(view.width / 2, Math.round(view.height * 0.36));
    this.controls.position.set(Math.round((view.width - this.controls.width) / 2), view.height - 34 - CONTROLS_ROW);
    this.controlsHint.position.set(Math.round((view.width - this.controlsHint.width) / 2), view.height - 34);
  }

  update(ticker: Ticker, state: GameState): void {
    this.time += ticker.deltaMS;
    this.panels.forEach((panel, i) => {
      const f = state.fighters[i];
      panel.root.visible = f !== undefined;
      if (f) panel.update(f, ticker.deltaMS, this.time);
    });

    const { ko } = state;
    this.banner.visible = ko !== null;
    if (ko) {
      // Slams in big and settles.
      const pop = Math.max(0, 1 - ko.tick / 10);
      this.koText.scale.set(1 + pop * 1.2);
      this.koText.alpha = 1 - pop * 0.6;
      this.winnerText.visible = ko.tick >= WINNER_DELAY_TICKS;
      this.winnerText.text = ko.winner === null ? 'DOUBLE K.O.' : `P${ko.winner + 1} ${this.panels[ko.winner].name.text} WINS`;
    }

    const elapsed = this.time - this.controlsShownAt;
    const fade = Math.min(1, Math.max(0, (elapsed - CONTROLS_SHOW_MS) / CONTROLS_FADE_MS));
    this.controls.alpha = 1 - fade;
    this.controlsHint.alpha = fade * 0.55;

    // Text re-rasterizes on change, so only refresh twice a second.
    this.sinceFpsUpdate += ticker.deltaMS;
    if (this.sinceFpsUpdate < 500) return;
    this.sinceFpsUpdate = 0;
    this.fps.text = `${Math.round(ticker.FPS)} fps`;
  }

  private buildControls(): void {
    const rows = CONTROLS.map((hints, player) => {
      const row = new Container();
      const tag = new Text({ text: `P${player + 1}`, style: { ...TITLE_STYLE, stroke: { color: 0x000000, width: 3 } } });
      tag.position.set(14, 2);
      row.addChild(tag);
      let cx = 14 + tag.width + 12;
      // Character switching is a local testing aid, so it is only listed in dev builds.
      for (const [keys, label] of import.meta.env.DEV ? hints : hints.slice(0, -1)) {
        for (const k of keys) {
          cx += keyCap(row, k, cx) + 3;
        }
        const text = new Text({ text: label, style: LABEL_STYLE });
        text.position.set(cx + 3, 3);
        row.addChild(text);
        cx += text.width + 20;
      }
      return { row, width: cx };
    });
    const hide = new Text({ text: 'H hide', style: { ...LABEL_STYLE, fontWeight: '400' } });
    hide.alpha = 0.6;
    hide.position.set(rows[1].width, 3);
    rows[1].row.addChild(hide);
    rows[1].width += hide.width + 14;

    const width = Math.max(...rows.map((r) => r.width));
    rows.forEach(({ row, width: w }, i) => {
      const bg = new Graphics().roundRect((width - w) / 2, -4, w, 28, 14).fill({ color: 0x000000, alpha: 0.35 });
      row.position.x = (width - w) / 2;
      const strip = new Container();
      strip.position.y = i * CONTROLS_ROW;
      strip.addChild(bg, row);
      this.controls.addChild(strip);
    });

    const hint = new Container();
    const w = keyCap(hint, 'H', 0);
    const text = new Text({ text: 'controls', style: LABEL_STYLE });
    text.position.set(w + 6, 3);
    hint.addChild(text);
    this.controlsHint.addChild(hint);
  }
}

/** One player's tag, name, health bar and energy gauge. P2's panel sits at the right edge and mirrors. */
class PlayerPanel {
  readonly root = new Container();
  readonly name: Text;
  private readonly healthBar = new Graphics();
  private readonly gauge = new Graphics();
  private readonly tagBg = new Graphics();
  private palette: HudPalette = CHARACTERS[0].hud;
  private shownEnergy = ENERGY_MAX;
  private ghostEnergy = ENERGY_MAX;
  private shownHealth = HEALTH_MAX;
  private ghostHealth = HEALTH_MAX;
  private ghostHoldMs = 0;

  constructor(player: number) {
    const side = player === 0 ? 1 : -1;
    // Bars are drawn left-to-right and flipped for P2, so both drain from the centre outward.
    this.healthBar.scale.x = side;
    this.gauge.scale.x = side;

    const tag = new Container();
    const tagText = new Text({ text: `P${player + 1}`, style: { ...TITLE_STYLE, fontSize: 10, fill: 0x1a1008 } });
    tagText.position.set(3, 0);
    tag.addChild(this.tagBg, tagText);
    tag.position.set(side > 0 ? TAG_X : -TAG_X - 22, 11);

    this.name = new Text({ text: '', style: { ...TITLE_STYLE, stroke: { color: 0x000000, width: 3 } } });
    this.name.anchor.set(side > 0 ? 0 : 1, 0);
    this.name.position.set(side * NAME_X, 8);

    this.root.addChild(this.healthBar, this.gauge, tag, this.name);
  }

  setCharacter(character: CharacterDef): void {
    this.palette = character.hud;
    this.name.text = character.name;
    this.tagBg.clear().poly([0, 0, 22, 0, 18, 14, -4, 14]).fill(character.hud.fill);
  }

  update(f: FighterState, deltaMs: number, time: number): void {
    const dt = deltaMs / 1000;
    // The fill tracks energy closely; a pale ghost lingers where it was so spending reads clearly.
    this.shownEnergy += (f.energy - this.shownEnergy) * Math.min(1, dt * 20);
    this.ghostEnergy = f.energy >= this.ghostEnergy ? f.energy : Math.max(f.energy, this.ghostEnergy - GHOST_SPEED * dt);
    this.drawGauge(f.energy, time);

    // Health snaps down on a hit; the red chunk that was lost holds, then drains to meet it.
    if (f.health < this.shownHealth) this.ghostHoldMs = HEALTH_GHOST_HOLD_MS;
    this.shownHealth = f.health;
    this.ghostHoldMs = Math.max(0, this.ghostHoldMs - deltaMs);
    if (f.health >= this.ghostHealth) this.ghostHealth = f.health;
    else if (this.ghostHoldMs === 0) this.ghostHealth = Math.max(f.health, this.ghostHealth - HEALTH_GHOST_SPEED * dt);
    this.drawHealth(time);
  }

  private drawHealth(time: number): void {
    const { width, height } = HEALTH_BAR;
    const strip = slantStrip(HEALTH_BAR);
    const at = (h: number) => (Math.max(0, Math.min(HEALTH_MAX, h)) / HEALTH_MAX) * width;
    const share = this.shownHealth / HEALTH_MAX;
    const low = share <= HEALTH_LOW;

    const g = this.healthBar.clear();
    g.poly(strip(-4, width + 4, -4, height + 4)).fill({ color: 0x000000, alpha: 0.7 });
    g.poly(strip(0, width)).fill(HEALTH.trough);
    // The bar is anchored at the screen edge and empties from the centre side.
    const fill = at(this.shownHealth);
    const ghost = at(this.ghostHealth);
    if (ghost > fill) g.poly(strip(fill, ghost)).fill(HEALTH.ghost);
    if (fill > 0) {
      g.poly(strip(0, fill)).fill(low ? HEALTH.low : HEALTH.fill);
      g.poly(strip(0, fill, 2, height * 0.38)).fill({ color: HEALTH.shine, alpha: 0.55 });
      g.poly(strip(0, fill, height * 0.75, height)).fill({ color: 0x000000, alpha: 0.18 });
    }
    // Faint notches every tenth, so damage reads at a glance.
    for (let i = 1; i < 10; i++) {
      const px = (width * i) / 10;
      g.poly(strip(px - 0.75, px + 0.75)).fill({ color: 0x000000, alpha: 0.28 });
    }
    if (low && share > 0) {
      const pulse = 0.4 + 0.35 * Math.sin(time * 0.012);
      g.poly(strip(-3, width + 3, -3, height + 3)).stroke({ color: HEALTH.ghost, alpha: pulse, width: 2 });
    }
  }

  private drawGauge(energy: number, time: number): void {
    const { width } = BAR;
    const { fill: fillColor, dim, hot, trough } = this.palette;
    const cost = MOVES.blast.energyCost ?? ENERGY_MAX;
    const canBlast = energy >= cost;
    const full = energy >= ENERGY_MAX;
    const at = (e: number) => (Math.max(0, Math.min(ENERGY_MAX, e)) / ENERGY_MAX) * width;
    const strip = slantStrip(BAR);
    const { height } = BAR;

    const g = this.gauge.clear();
    // Frame and trough.
    g.poly(strip(-3, width + 3, -3, height + 3)).fill({ color: 0x000000, alpha: 0.6 });
    g.poly(strip(0, width)).fill(trough);

    const ghost = at(this.ghostEnergy);
    const fill = at(this.shownEnergy);
    if (ghost > fill) g.poly(strip(fill, ghost)).fill({ color: 0xffffff, alpha: 0.75 });
    if (fill > 0) {
      g.poly(strip(0, fill)).fill(canBlast ? fillColor : dim);
      g.poly(strip(0, fill, 0, height * 0.4)).fill({ color: hot, alpha: canBlast ? 0.55 : 0.25 });
      g.poly(strip(0, fill, height * 0.8, height)).fill({ color: 0x000000, alpha: 0.2 });
    }
    // Pulse while full: the gauge is "charged".
    if (full) {
      const pulse = 0.35 + 0.25 * Math.sin(time * 0.008);
      g.poly(strip(-2, width + 2, -2, height + 2)).stroke({ color: hot, alpha: pulse, width: 2 });
    }
    // Segment dividers, one per blast's worth of energy.
    for (let e = cost; e < ENERGY_MAX; e += cost) {
      const px = at(e);
      g.poly(strip(px - 1, px + 1)).fill({ color: 0x000000, alpha: 0.65 });
    }
  }
}

/** For a bar: a slanted strip from px a to px b along it, `top`..`bottom` px down, as polygon points. */
function slantStrip({ x, y, height, slant }: BarShape) {
  return (a: number, b: number, top = 0, bottom = height): number[] => {
    const s0 = slant * (1 - top / height);
    const s1 = slant * (1 - bottom / height);
    return [x + a + s0, y + top, x + b + s0, y + top, x + b + s1, y + bottom, x + a + s1, y + bottom];
  };
}

/** Draws a small keyboard key at `x` inside `parent`; returns its width. */
function keyCap(parent: Container, key: string, x: number): number {
  const text = new Text({ text: key, style: KEY_STYLE });
  const w = Math.max(20, text.width + 10);
  const cap = new Graphics()
    .roundRect(x, 0, w, 20, 4)
    .fill(0xf3e6cf)
    .roundRect(x, 16, w, 4, 2)
    .fill({ color: 0x000000, alpha: 0.25 });
  text.position.set(x + (w - text.width) / 2, 2);
  parent.addChild(cap, text);
  return w;
}
