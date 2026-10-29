# Valley Fighter

2D side-view browser fighter. Vite + TypeScript + PixiJS (WebGL).

```
npm install
npm run dev        # http://localhost:5173
```

Two players on one keyboard:

| | move | jump | duck (hold) | kick | blast | beam (hold) | block (hold) | switch fighter (dev only) |
|---|---|---|---|---|---|---|---|---|
| P1 | A / D | W, Space | S | K | J | L | I | C |
| P2 | ← / → | ↑ | ↓ | `.` (Num2) | `,` (Num1) | `/` (Num3) | Right Shift (Num0) | M |

Ducking slips under blasts and beams but kicks still land. Blocking raises a shield that stops
everything but drains the guard meter (blocked hits, and slowly just holding it); an empty guard
breaks and leaves you stunned, and the shield can't go back up until the guard refills past the notch.

Pick characters by URL: `?p1=maroon&p2=navy`. H toggles the controls strip.

## Asset pipeline

`npm run build-sprites` (also runs automatically before `dev`/`build` when the sources changed)
reads `images/` (never modified) and writes `public/assets/`:

- `fighters/maroon.png` + `.json`: 12 frames sliced by detecting each figure (empty row/column
  bands, not a fixed grid), magenta keyed out with edge un-mixing and despill (no halo), all on one
  466x352 canvas with feet on a shared baseline and the anchor at the middle of the feet.
  Frame names: `idle_stance idle_breathe walk_1 walk_2 punch_windup punch_extend kick_windup
  kick_high blast_charge blast_release jump_air hit_recoil`, plus `block` and `duck` taken from
  the shared defense-poses sheet and rescaled to match (block is matched to `punch_windup`).
- `stages/valley.png`: the background.

`node scripts/build-sprites.mjs --debug <dir>` writes a preview of the frames over green with
baseline/anchor guides. Per-frame anchor nudges live in the script's `CONFIG`.

## Code layout

```
src/sim/        pure, deterministic simulation (no Pixi, DOM, clocks or Math.random)
  step.ts         step(state, inputs) -> new state, one 60Hz tick (KO + round reset live here)
  combat.ts       energy clashes (blast/beam meeting cancel, no damage), then hitboxes vs
                  hurtboxes for kicks, blasts and beams, then body push
  state.ts        GameState / FighterState, createInitialState
  moves.ts        data-driven moves (phases, lunge, air-usable); add punch/blast here
  input.ts        InputFrame {left,right,jump,kick} + bit-packing for the network
  constants.ts    speeds, gravity, stage bounds
  rng.ts          seeded PRNG (seed lives in GameState)
src/input/      InputSource interface, KeyboardInput (one InputFrame per tick)
src/game/       LocalSession: fixed-timestep accumulator, one InputSource per fighter
src/render/     reads state only: frame selection, fighter/stage views, HUD, layout
src/main.ts     wiring
```

Each fighter in `createInitialState` gets one `InputSource` in the `LocalSession` (currently a
`KeyboardInput` per `PLAYER_BINDINGS` entry; a network source could replace P2 later). Adding a move: add it to `MOVES`, map its phases to frames in
`render/animations.ts`, and trigger it from an input in `sim/step.ts`.
