# Valley Fighter

2D side-view browser fighter. Vite + TypeScript + PixiJS (WebGL).

```
npm install
npm run dev        # http://localhost:5173
```

Two players on one keyboard:

| | move | jump | duck (hold) | kick | blast | beam (hold) | block (hold) | super | switch fighter |
|---|---|---|---|---|---|---|---|---|---|
| P1 | A / D | W, Space | S | K | J | L | I | O | C |
| P2 | ← / → | ↑ | ↓ | `.` (Num2) | `,` (Num1) | `/` (Num3) | Right Shift (Num0) | Enter | M |

**Supers** need a full energy gauge (and spend it all); a hit during the wind-up cancels them
(the energy is still spent). Each runs for 9 seconds, striking at random spots, about half the
time near the opponent. Shields can't stop the strikes, but each one is telegraphed, and the
caster is never hurt by their own.

- **Inferno** (FLASH, fire): the stage burns. Each eruption glows and smokes as a crack for ~0.7s,
  then a lava column blasts up, launching anyone in it for heavy damage.
- **Tempest** (VOLT, thunder): the sky goes dark with storm clouds and rain. Each strike gathers as
  static on the ground for ~0.5s, then lightning slams down, electrocuting anyone there (a little
  less damage, a longer stun). Strikes come more often than eruptions.
- **Goon Fall** (GOONER, goo), the strongest super: a ~2s entrance first (night falls, a colossus of
  goo in Gooner's image heaves up out of the valley facing you, arms spread and palms open, its eyes
  ignite red, it roars), then goo balls rain down for ~9s
  while it looms over everything. Each is targeted for ~0.37s (a pillar of light, a closing reticle,
  its shadow) while it plunges ever faster, then hits like a bomb. Hits are lighter than an eruption
  but far more frequent (short grace) and trap: glued in place for ~0.75s, then slowed for ~0.9s
  (`TRAP` in `sim/constants.ts`), so the next ball is hard to escape. When it ends the colossus
  melts back into the valley. Nothing covers the play area, and the name is never shown.

Ducking slips under blasts and beams but kicks still land. Blocking raises a shield that stops
everything but drains the guard meter (blocked hits, and slowly just holding it); an empty guard
breaks and leaves you stunned, and the shield can't go back up until the guard refills past the notch.

Switch characters any time, even mid-fight: C cycles P1 (FLASH, VOLT, GOONER), M cycles P2. The
picks are kept in the URL (`?p1=maroon&p2=navy`, also `gooner`), so a reload keeps them. H toggles
the controls strip.

**GOONER** fights with fluid instead of energy (`render/gooView.ts`): his blast is a jiggling ball of
sticky white goo, and his beam a powerful straight jet that
sprays where it hits; goo lands as puddles and hit fighters drip for a while. His shield is a holy
holographic cross (white-gold, scanlines, halo and rays, the odd glitch). His super is Goon Fall
(`render/colossusView.ts`). The **Test GOONER solo** button at the top (or `?solo=gooner`) puts him
alone on the stage on P1's keys; **Back to versus** returns to the match.

## Asset pipeline

`npm run build-sprites` (also runs automatically before `dev`/`build` when the sources changed)
reads `images/` (never modified) and writes `public/assets/`:

- `fighters/maroon.png` + `.json`: 12 frames sliced by detecting each figure (empty row/column
  bands, not a fixed grid), magenta keyed out with edge un-mixing and despill (no halo), all on one
  466x352 canvas with feet on a shared baseline and the anchor at the middle of the feet.
  Frame names: `idle_stance idle_breathe walk_1 walk_2 punch_windup punch_extend kick_windup
  kick_high blast_charge blast_release jump_air hit_recoil`, plus `block` and `duck` taken from
  the shared defense-poses sheet and rescaled to match (block is matched to `punch_windup`).
- `fighters/navy.*` likewise; `fighters/gooner.*` from the heavyset sheet, with block, duck and skid
  from his own pose sheet (rows of 2 and 1 figures). His purple sash is close to the magenta key, so
  his sheets keep more of that hue on bluish pixels (`SPILL_TOLERANCE_AWAY` in the script).
- `stages/valley.png`: the background.
- `supers/colossus.png` + `.json`: Goon Fall's colossus (`giants` in the script's `CONFIG`), cut from
  the open-armed statue reference and recoloured to the game's goo palette from its own shading,
  with extra drips hanging off its lower edges (none off the head). The builder can also make a
  giant from a fighter frame, rebuilding the shading from the silhouette. The JSON holds the eye
  positions for the glow.

`node scripts/build-sprites.mjs --debug <dir>` writes a preview of the frames over green with
baseline/anchor guides. Per-frame anchor nudges live in the script's `CONFIG`.

## Code layout

```
src/sim/        pure, deterministic simulation (no Pixi, DOM, clocks or Math.random)
  step.ts         step(state, inputs) -> new state, one 60Hz tick (KO + round reset live here)
  combat.ts       energy clashes (blast/beam meeting cancel, no damage), then hitboxes vs
                  hurtboxes for kicks, blasts and beams, then body push
  cataclysm.ts    supers' strikes: eruptions / lightning (seeded random spots, warn/active/fade)
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
