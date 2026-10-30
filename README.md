# Valley Fighter

2D side-view browser fighter. Vite + TypeScript + PixiJS (WebGL).

```
npm install
npm run dev        # http://localhost:5173
```

Two players on one keyboard:

| | move | jump | duck (hold) | kick | blast | beam (hold) | block (hold) | super | pick fighter |
|---|---|---|---|---|---|---|---|---|---|
| P1 | A / D | W, Space | S | K | J | L | I | O | C |
| P2 | ← / → | ↑ | ↓ | `.` (Num2) | `,` (Num1) | `/` (Num3) | Right Shift (Num0) | Enter | M |

**Supers** need a full **super meter**, a separate bar under the guard. It starts empty each round
and fills only from fighting: mostly from damage you deal (and guard you knock off a shield), a
little from damage you take; never on its own, and not while your super runs. A super spends all
of it; a hit during the wind-up cancels it (the meter is still spent). Once it lands the caster
holds a power stance until it ends: rooted, taking no input, and immune to everything (hits are
absorbed). Each runs for 9 seconds, striking at random spots, about half the time near the
opponent. Shields can't stop the strikes, but each one is telegraphed, and the caster is never hurt
by their own. Against an opponent who keeps running: Inferno and Tempest ~180, Goon Fall ~195.

Damage is kept low so fights last: a clean kick 42, a blast 52, of 1000 health.

- **Inferno** (FLASH, fire): the stage burns. Each eruption glows and smokes as a crack for only
  ~0.4s, most of them right by the opponent, then a lava column blasts up, launching anyone in it.
- **Tempest** (VOLT, thunder): the sky goes dark with storm clouds and rain. Each strike gathers as
  static on the ground for ~0.5s, then lightning slams down, electrocuting anyone there (a longer
  stun). The storm hunts its target: most bolts strike close to the opponent. Strikes come more
  often than eruptions.
- **Goon Fall** (GOONER, goo), the strongest super: a ~2s entrance first (night falls, a colossus of
  goo in Gooner's image heaves up out of the valley facing you, arms spread and palms open, its eyes
  ignite red, it roars), then goo balls rain down for ~9s
  while it looms over everything. Each is targeted for ~0.37s (a pillar of light, a closing reticle,
  its shadow) while it plunges ever faster, then hits like a bomb and traps: glued in place for
  ~0.4s, then slowed for ~0.7s (`TRAP` in `sim/constants.ts`). A trapped fighter isn't aimed at and
  can't be hit again until the goo lets go, so they always get to move away. When it ends the colossus
  melts back into the valley. Nothing covers the play area, and the name is never shown.

Ducking slips under blasts and beams but kicks still land. Blocking raises a shield that stops
everything but drains the guard meter (blocked hits, and slowly just holding it); an empty guard
breaks and leaves you stunned, and the shield can't go back up until the guard refills past the notch.

Pick characters before the fight: C cycles P1 (FLASH, VOLT, GOONER), M cycles P2. Once anyone
presses a fight key the picks are locked until the next round. They are kept in the URL
(`?p1=maroon&p2=navy`, also `gooner`), so a reload keeps them. In solo testing the super meter
refills on its own. H toggles the controls strip.

**GOONER** fights with fluid instead of energy (`render/gooView.ts`): his blast is a jiggling ball of
sticky white goo, and his beam a powerful straight jet poured from his forward palm (his own two
stream poses: gathering it hands together, then arched back with arms out) that
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
  his sheets keep more of that hue on bluish pixels (`SPILL_TOLERANCE_AWAY` in the script). He also
  has `beam_charge` and `beam_release` from his stream pose sheet; characters without them show their
  blast poses instead (`FRAME_FALLBACK` in `render/animations.ts`). Atlases may be up to 4096px.
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
