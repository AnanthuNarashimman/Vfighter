import { Application, Assets, Container, type Spritesheet, type Texture } from 'pixi.js';
import { LocalSession } from './game/localSession';
import { KeyboardInput, PLAYER_BINDINGS } from './input/keyboard';
import { CHARACTERS, type CharacterDef } from './render/characters';
import { EnergyView } from './render/energyView';
import { FighterView } from './render/fighterView';
import { Hud } from './render/hud';
import { multiplyColor } from './render/fx';
import { InfernoView } from './render/infernoView';
import { computeLayout } from './render/layout';
import { StageBackground } from './render/stageView';
import { StormView } from './render/stormView';
import { ColossusView, type GiantMeta } from './render/colossusView';
import { createInitialState, type Loadout } from './sim/state';

const ASSETS = import.meta.env.BASE_URL + 'assets/';
/** The character the test button tries out alone. */
const TEST_CHARACTER = 'gooner';

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

  const [stageTex, colossusTex, colossusMeta, ...sheets] = await Promise.all([
    Assets.load<Texture>(ASSETS + 'stages/valley.png'),
    Assets.load<Texture>(ASSETS + 'supers/colossus.png'),
    Assets.load<GiantMeta>(ASSETS + 'supers/colossus.json'),
    ...CHARACTERS.map((c) => Assets.load<Spritesheet>(ASSETS + c.sheet)),
  ]);

  const background = new StageBackground(stageTex);
  const world = new Container();
  const fightersLayer = new Container();
  const energy = new EnergyView();
  // The supers: Inferno (fire) and Tempest (thunder) each light, darken and shake the whole scene.
  const inferno = new InfernoView();
  const storm = new StormView();
  const colossus = new ColossusView(colossusTex as Texture, colossusMeta as GiantMeta);
  world.addChild(
    storm.back,
    inferno.back,
    colossus.back,
    energy.ground,
    fightersLayer,
    energy.root,
    colossus.front,
    inferno.front,
    storm.front,
  );
  // Solo test mode (?solo=<id>): that character alone on the stage, on P1's keys. Otherwise a
  // versus match with characters from ?p1=<id>&p2=<id> (defaults: P1 the first, P2 the second).
  const params = new URLSearchParams(location.search);
  const solo = CHARACTERS.findIndex((c) => c.id === params.get('solo'));
  const pickParams = solo >= 0 ? ['solo'] : ['p1', 'p2'];
  const picks = pickParams.map((param, i) => {
    const found = CHARACTERS.findIndex((c) => c.id === params.get(param));
    return found >= 0 ? found : i % CHARACTERS.length;
  });
  addModeButton(solo >= 0);

  const hud = new Hud(picks.length);
  app.stage.addChild(background.sprite, colossus.sky, storm.sky, inferno.sky, world, colossus.overlay, storm.overlay, inferno.flash, hud.root);

  let worldX = 0;
  let worldY = 0;
  const applyLayout = (): void => {
    const view = computeLayout(window.innerWidth, window.innerHeight);
    app.renderer.resize(view.width, view.height);
    worldX = view.worldX;
    worldY = view.worldY;
    world.position.set(worldX, worldY);
    background.layout(view);
    inferno.layout(view);
    storm.layout(view);
    colossus.layout(view);
    hud.layout(view);
  };
  applyLayout();
  window.addEventListener('resize', applyLayout);

  // Players on one keyboard: one InputSource per fighter.
  const initialState = createInitialState(1, 1, picks.map((p) => loadoutOf(CHARACTERS[p])));
  const inputs = initialState.fighters.map((_, i) => new KeyboardInput(PLAYER_BINDINGS[i]));
  const session = new LocalSession(initialState, inputs);
  if (import.meta.env.DEV) Object.assign(window, { __session: session }); // for debugging in the console
  const views = session.current.fighters.map(() => {
    const view = new FighterView(sheets[0] as Spritesheet);
    fightersLayer.addChild(view.root);
    return view;
  });

  // Before the fight, C cycles P1's character and M cycles P2's; once anyone presses a fight key the
  // picks are locked until the next round. The URL follows, so a reload keeps the picks. The
  // simulation's side of a character (element, kit) is patched into the running state.
  const applyCharacter = (player: number): void => {
    const character = CHARACTERS[picks[player]];
    views[player].setSheet(sheets[picks[player]] as Spritesheet);
    energy.setStyle(player, character.energy);
    hud.setCharacter(player, character);
    // The element (which super) and kit (which moves) are gameplay, so the simulation needs them too.
    session.setLoadout(player, loadoutOf(character));
  };
  views.forEach((_, i) => applyCharacter(i));
  const switchKeys = ['KeyC', 'KeyM'];
  window.addEventListener('keydown', (e) => {
    const player = switchKeys.indexOf(e.code);
    if (player < 0 || player >= views.length || e.repeat || session.current.started) return;
    picks[player] = (picks[player] + 1) % CHARACTERS.length;
    applyCharacter(player);
    const url = new URL(location.href);
    url.searchParams.set(pickParams[player], CHARACTERS[picks[player]].id);
    history.replaceState(null, '', url);
  });

  app.ticker.add((ticker) => {
    const alpha = session.advance(ticker.deltaMS);
    const { previous, current } = session;
    inferno.update(previous, current, alpha, ticker.deltaMS);
    storm.update(previous, current, alpha, ticker.deltaMS);
    colossus.update(previous, current, alpha, ticker.deltaMS);
    background.sprite.tint = multiplyColor(
      multiplyColor(inferno.backgroundTint(), storm.backgroundTint()),
      colossus.backgroundTint(),
    );
    const light = multiplyColor(multiplyColor(inferno.fighterTint(), storm.fighterTint()), colossus.fighterTint());
    current.fighters.forEach((f, i) => {
      views[i].setAmbient(light);
      views[i].update(previous.fighters[i], f, alpha, ticker.deltaMS);
    });
    energy.update(previous, current, alpha, ticker.deltaMS);
    hud.update(ticker, current);
    // Camera shake moves the world and the stage together (the HUD stays put).
    const a = inferno.shake();
    const b = storm.shake();
    const c = colossus.shake();
    world.position.set(worldX + a.x + b.x + c.x, worldY + a.y + b.y + c.y);
    background.shake(a.x + b.x + c.x, a.y + b.y + c.y);
  });
}

function loadoutOf(character: CharacterDef): Loadout {
  return { element: character.element, kit: character.kit };
}

/** Top-centre button: from a match, try the test character alone; from solo, back to the match. */
function addModeButton(solo: boolean): void {
  const button = document.createElement('button');
  button.id = 'mode-button';
  const name = CHARACTERS.find((c) => c.id === TEST_CHARACTER)?.name ?? TEST_CHARACTER;
  button.textContent = solo ? 'Back to versus' : `Test ${name} solo`;
  button.addEventListener('click', () => {
    const url = new URL(location.href);
    if (solo) url.searchParams.delete('solo');
    else url.searchParams.set('solo', TEST_CHARACTER);
    location.href = url.toString();
  });
  document.body.appendChild(button);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#f88;padding:16px">Failed to start: ${String(err)}\nDid the sprite build run? Try: npm run build-sprites</pre>`,
  );
});
