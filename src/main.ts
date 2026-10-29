import { Application, Assets, Container, type Spritesheet, type Texture } from 'pixi.js';
import { LocalSession } from './game/localSession';
import { KeyboardInput, PLAYER_BINDINGS } from './input/keyboard';
import { CHARACTERS } from './render/characters';
import { EnergyView } from './render/energyView';
import { FighterView } from './render/fighterView';
import { Hud } from './render/hud';
import { computeLayout } from './render/layout';
import { StageBackground } from './render/stageView';
import { createInitialState } from './sim/state';

const ASSETS = import.meta.env.BASE_URL + 'assets/';

async function main(): Promise<void> {
  const host = document.getElementById('game')!;
  const app = new Application();
  const initial = computeLayout(window.innerWidth, window.innerHeight);
  await app.init({
    width: initial.width,
    height: initial.height,
    resolution: 1, // render at the view size (1280 wide) and let CSS stretch the canvas to the window
    autoDensity: false,
    antialias: false,
    background: 0x000000,
    preference: 'webgl',
  });
  host.appendChild(app.canvas);

  const [stageTex, ...sheets] = await Promise.all([
    Assets.load<Texture>(ASSETS + 'stages/valley.png'),
    ...CHARACTERS.map((c) => Assets.load<Spritesheet>(ASSETS + c.sheet)),
  ]);

  const background = new StageBackground(stageTex);
  const world = new Container();
  const fightersLayer = new Container();
  const energy = new EnergyView();
  world.addChild(energy.ground, fightersLayer, energy.root);
  const hud = new Hud();
  app.stage.addChild(background.sprite, world, hud.root);

  const applyLayout = (): void => {
    const view = computeLayout(window.innerWidth, window.innerHeight);
    app.renderer.resize(view.width, view.height);
    world.position.set(view.worldX, view.worldY);
    background.layout(view);
    hud.layout(view);
  };
  applyLayout();
  window.addEventListener('resize', applyLayout);

  // Two players on one keyboard: one InputSource per fighter.
  const initialState = createInitialState();
  const inputs = initialState.fighters.map((_, i) => new KeyboardInput(PLAYER_BINDINGS[i]));
  const session = new LocalSession(initialState, inputs);
  if (import.meta.env.DEV) Object.assign(window, { __session: session }); // for debugging in the console
  const views = session.current.fighters.map(() => {
    const view = new FighterView(sheets[0] as Spritesheet);
    fightersLayer.addChild(view.root);
    return view;
  });

  // Characters come from ?p1=<id>&p2=<id> (defaults: P1 the first character, P2 the second). In dev,
  // C cycles P1 and M cycles P2; the URL follows, so a reload keeps the picks. Characters are
  // cosmetic, so switching mid-fight is safe.
  const params = new URLSearchParams(location.search);
  const picks = views.map((_, i) => {
    const found = CHARACTERS.findIndex((c) => c.id === params.get(`p${i + 1}`));
    return found >= 0 ? found : i % CHARACTERS.length;
  });
  const applyCharacter = (player: number): void => {
    const character = CHARACTERS[picks[player]];
    views[player].setSheet(sheets[picks[player]] as Spritesheet);
    energy.setStyle(player, character.energy);
    hud.setCharacter(player, character);
  };
  views.forEach((_, i) => applyCharacter(i));
  if (import.meta.env.DEV) {
    const switchKeys = ['KeyC', 'KeyM'];
    window.addEventListener('keydown', (e) => {
      const player = switchKeys.indexOf(e.code);
      if (player < 0 || player >= views.length || e.repeat) return;
      picks[player] = (picks[player] + 1) % CHARACTERS.length;
      applyCharacter(player);
      const url = new URL(location.href);
      url.searchParams.set(`p${player + 1}`, CHARACTERS[picks[player]].id);
      history.replaceState(null, '', url);
    });
  }

  app.ticker.add((ticker) => {
    const alpha = session.advance(ticker.deltaMS);
    const { previous, current } = session;
    current.fighters.forEach((f, i) => views[i].update(previous.fighters[i], f, alpha, ticker.deltaMS));
    energy.update(previous, current, alpha, ticker.deltaMS);
    hud.update(ticker, current);
  });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#f88;padding:16px">Failed to start: ${String(err)}\nDid the sprite build run? Try: npm run build-sprites</pre>`,
  );
});
