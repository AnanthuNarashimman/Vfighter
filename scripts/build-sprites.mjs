#!/usr/bin/env node
/**
 * Asset pipeline: fighter sprite sheet -> aligned, background-free frames packed into one atlas.
 *
 *   node scripts/build-sprites.mjs              rebuild everything
 *   node scripts/build-sprites.mjs --if-stale   skip if outputs are newer than inputs
 *   node scripts/build-sprites.mjs --debug DIR  also write a preview sheet (frames over green, with guides)
 *
 * Source images in images/ are only read, never modified. Output goes to public/assets/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Extra poses drawn on their own sheet, at a different size from the main sheets. `cells` picks
 * figures (reading order) for each frame name; the figures are rescaled so that `match[0]` (a cell
 * frame) comes out the same height as `match[1]` (a main-sheet frame of a similar pose).
 */
const DEFENSE_SHEET = {
  sheet: 'images/Martial Artists in Dynamic Combat Poses.png',
  rows: 2,
  cols: 2,
  // The block guard is the same wide, upright fighting stance as the punch wind-up.
  match: ['block', 'punch_windup'],
};

/**
 * Skid: braced and leaning back, being shoved. No main-sheet pose stands the same height, so it is
 * matched by silhouette area (scale = sqrt of the area ratio) against the punch wind-up instead.
 */
const SKID_SHEET = {
  sheet: 'images/Dynamic Warrior Recoil Duo.png',
  rows: 1,
  cols: 2,
  match: ['skid', 'punch_windup'],
  matchBy: 'area',
};

/**
 * Gooner's own defense poses: block and duck side by side on top, skid alone underneath (so the rows
 * have different column counts). All three are drawn at one size, so one scale fits them all.
 */
const GOONER_POSES = {
  sheet: 'images/Magenta Fighter Pose Sheet.png',
  rows: 2,
  cols: [2, 1],
  match: ['block', 'punch_windup'],
};

/**
 * Spill tolerance (see makeSpillModel) for colours on the far side of the key's hue, for sheets
 * whose art has key-like colours of its own: Gooner's purple sash is close to the magenta key, and
 * the default would eat it. The sash leans blue where the key leans red, so only bluish pixels get
 * this tolerance; reddish fringes (where skin meets the key) still get the default.
 */
const SPILL_TOLERANCE_AWAY = {
  'images/Heavyset Fighter Sprite Sheet.png': 140,
  'images/Magenta Fighter Pose Sheet.png': 140,
  'images/Muscular Warrior Pose Sheet.png': 140,
};

const CONFIG = {
  fighters: [
    {
      id: 'maroon',
      sheet: 'images/Maroon Fighter Sprite Sheet.png',
      rows: 3,
      cols: 4,
      // Reading order: left to right, top to bottom.
      frames: [
        'idle_stance', 'idle_breathe', 'walk_1', 'walk_2',
        'punch_windup', 'punch_extend', 'kick_windup', 'kick_high',
        'blast_charge', 'blast_release', 'jump_air', 'hit_recoil',
      ],
      // Frame used to measure the character's standing height.
      standingFrame: 'idle_stance',
      // Optional manual nudges (source px) if the auto anchor of a frame looks off: { walk_1: { dx: -4 } }
      anchorNudge: {},
      extras: [
        { ...DEFENSE_SHEET, cells: { block: 0, duck: 1 } },
        { ...SKID_SHEET, cells: { skid: 0 } },
      ],
    },
    {
      id: 'navy',
      sheet: 'images/Fighter Sprite Sheet in Action.png',
      rows: 3,
      cols: 4,
      // Same pose layout as the maroon sheet.
      frames: [
        'idle_stance', 'idle_breathe', 'walk_1', 'walk_2',
        'punch_windup', 'punch_extend', 'kick_windup', 'kick_high',
        'blast_charge', 'blast_release', 'jump_air', 'hit_recoil',
      ],
      standingFrame: 'idle_stance',
      anchorNudge: {},
      extras: [
        { ...DEFENSE_SHEET, cells: { block: 2, duck: 3 } },
        { ...SKID_SHEET, cells: { skid: 1 } },
      ],
    },
    {
      id: 'gooner',
      sheet: 'images/Heavyset Fighter Sprite Sheet.png',
      rows: 3,
      cols: 4,
      // Same pose layout as the maroon sheet.
      frames: [
        'idle_stance', 'idle_breathe', 'walk_1', 'walk_2',
        'punch_windup', 'punch_extend', 'kick_windup', 'kick_high',
        'blast_charge', 'blast_release', 'jump_air', 'hit_recoil',
      ],
      standingFrame: 'idle_stance',
      anchorNudge: {},
      extras: [
        { ...GOONER_POSES, cells: { block: 0, duck: 1, skid: 2 } },
        // His goo stream: gathering it (hands together), then letting it pour (arched back, arms out).
        // Both stand in the same wide stance as the punch wind-up.
        {
          sheet: 'images/Muscular Warrior Pose Sheet.png',
          rows: 1,
          cols: 2,
          match: ['beam_charge', 'punch_windup'],
          cells: { beam_charge: 0, beam_release: 1 },
        },
      ],
    },
  ],
  stages: [{ id: 'valley', image: 'images/Serene Fantasy Valley Panorama.png' }],
  // Giants of goo for supers (see buildGiant). The source is a fighter's frame (`fighter` + `frame`)
  // or a whole image (`image`). `shading`: 'form' rebuilds the shading from the silhouette (for
  // painted, coloured art), 'image' keeps the source's own (for art that is already a white statue).
  // `eyes`: in source px. Drip lengths are in source px (before `upscale`); `dripFrom`: share of the
  // height from the top with no drips.
  giants: [
    {
      // Gooner as a giant of goo, facing the viewer with arms spread and palms open.
      id: 'colossus',
      image: 'images/Glossy Wax Warrior on Magenta.png',
      shading: 'image',
      dripFrom: 0.22,
      upscale: 1,
      eyes: [[569, 196], [633, 177]],
      dripChance: 0.05,
      dripMin: 10,
      dripMax: 40,
    },
  ],
  outDir: 'public/assets',
  framePad: 4, // transparent margin around the figures inside the shared frame canvas
  atlasGap: 2, // gap between frames in the atlas (prevents bleeding under linear filtering)
  maxAtlas: 4096, // the smallest max texture size WebGL devices realistically have
  edgeRadius: 2, // width (px) of the band next to the background where partial alpha is allowed
  minSpeck: 40, // foreground islands smaller than this (px) are discarded as noise
};

const args = process.argv.slice(2);
const ifStale = args.includes('--if-stale');
const debugDir = args.includes('--debug') ? path.resolve(args[args.indexOf('--debug') + 1] ?? 'sprite-debug') : null;
const scriptMtime = fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;
/** Keyed sheets by path, so a sheet shared by several fighters is processed once. */
const keyedCache = new Map();

for (const fighter of CONFIG.fighters) buildFighter(fighter);
for (const stage of CONFIG.stages) copyStage(stage);
for (const giant of CONFIG.giants) buildGiant(giant);

// ---------------------------------------------------------------------------

function buildFighter(cfg) {
  const extras = cfg.extras ?? [];
  const inputs = [cfg.sheet, ...extras.map((e) => e.sheet)].map((s) => path.join(ROOT, s));
  const outDir = path.join(ROOT, CONFIG.outDir, 'fighters');
  const outPng = path.join(outDir, `${cfg.id}.png`);
  const outJson = path.join(outDir, `${cfg.id}.json`);
  if (ifStale && isFresh([outPng, outJson], inputs)) {
    console.log(`[sprites] ${cfg.id}: up to date`);
    return;
  }

  // 1-2. Key out the background and find the figures (empty row/column bands, not an even grid).
  // Each figure carries its own pixels: { px, stride, x0, y0, x1, y1 } with inclusive bounds.
  const main = keyedSheet(cfg.sheet);
  const mainBoxes = findFigures(main, cfg.rows, cfg.cols);
  if (mainBoxes.length !== cfg.frames.length) {
    throw new Error(`found ${mainBoxes.length} figures, expected ${cfg.frames.length}`);
  }
  const names = [...cfg.frames];
  const boxes = mainBoxes.map((b) => ({ ...b, px: main.px, stride: main.W }));

  // Extra sheets: pick cells, rescale so the matched pose is as tall as its main-sheet counterpart.
  for (const extra of extras) {
    const sheet = keyedSheet(extra.sheet);
    const cells = findFigures(sheet, extra.rows, extra.cols);
    const [cellFrame, mainFrame] = extra.match;
    const ref = mainBoxes[cfg.frames.indexOf(mainFrame)];
    const cellBox = cells[extra.cells[cellFrame]];
    const scale =
      extra.matchBy === 'area'
        ? Math.sqrt(area(main.px, main.W, ref) / area(sheet.px, sheet.W, cellBox))
        : height(ref) / height(cellBox);
    for (const [name, cell] of Object.entries(extra.cells)) {
      names.push(name);
      boxes.push(scaleFigure(sheet.px, sheet.W, cells[cell], scale));
    }
    console.log(`[sprites] ${cfg.id}: ${Object.keys(extra.cells).join(', ')} from ${extra.sheet} at x${scale.toFixed(3)}`);
  }

  // 3. Anchor each figure: feet baseline = lowest solid row; horizontal anchor = middle of the feet.
  boxes.forEach((b, i) => {
    const solid = (x, y) => b.px[(y * b.stride + x) * 4 + 3] >= 128;
    const footRows = Math.max(4, Math.round((b.y1 - b.y0 + 1) * 0.06));
    let minX = Infinity, maxX = -Infinity;
    for (let y = b.y1 - footRows + 1; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) if (solid(x, y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
    b.ax = Math.round((minX + maxX) / 2) + (cfg.anchorNudge[names[i]]?.dx ?? 0);
    b.base = b.y1;
  });

  // 4. Shared canvas big enough for every frame with the anchor at (centre, baseline).
  const pad = CONFIG.framePad;
  const halfW = Math.max(...boxes.map((b) => Math.max(b.ax - b.x0, b.x1 - b.ax + 1))) + pad;
  const fw = halfW * 2;
  const fh = Math.max(...boxes.map((b) => b.base - b.y0 + 1)) + pad * 2;
  const baselineY = fh - pad; // feet bottom edge, in frame pixels

  // 5. Pack into an atlas grid.
  const gap = CONFIG.atlasGap;
  const perRow = Math.floor((CONFIG.maxAtlas + gap) / (fw + gap));
  const atlasRows = Math.ceil(boxes.length / perRow);
  const aw = Math.min(perRow, boxes.length) * (fw + gap) - gap;
  const ah = atlasRows * (fh + gap) - gap;
  if (perRow < 1 || aw > CONFIG.maxAtlas || ah > CONFIG.maxAtlas) {
    throw new Error(`atlas ${aw}x${ah} exceeds ${CONFIG.maxAtlas}px (frame ${fw}x${fh})`);
  }
  const atlas = new PNG({ width: aw, height: ah });
  atlas.data.fill(0);

  const frames = {};
  boxes.forEach((b, i) => {
    const fx = (i % perRow) * (fw + gap);
    const fy = Math.floor(i / perRow) * (fh + gap);
    const ox = fx + halfW - b.ax; // source x -> atlas x offset
    const oy = fy + baselineY - 1 - b.base;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const s = (y * b.stride + x) * 4;
        if (b.px[s + 3] === 0) continue;
        const d = ((y + oy) * aw + (x + ox)) * 4;
        atlas.data[d] = b.px[s];
        atlas.data[d + 1] = b.px[s + 1];
        atlas.data[d + 2] = b.px[s + 2];
        atlas.data[d + 3] = b.px[s + 3];
      }
    }
    frames[names[i]] = {
      frame: { x: fx, y: fy, w: fw, h: fh },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: fw, h: fh },
      sourceSize: { w: fw, h: fh },
      anchor: { x: 0.5, y: baselineY / fh },
    };
  });

  const standing = boxes[names.indexOf(cfg.standingFrame)];
  const json = {
    frames,
    meta: {
      app: 'scripts/build-sprites.mjs',
      image: `${cfg.id}.png`,
      format: 'RGBA8888',
      size: { w: aw, h: ah },
      scale: '1',
      fighter: {
        id: cfg.id,
        frameSize: { w: fw, h: fh },
        anchor: { x: 0.5, y: baselineY / fh },
        standingHeight: standing.base - standing.y0 + 1,
        background: main.bg.color,
      },
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPng, PNG.sync.write(atlas));
  fs.writeFileSync(outJson, JSON.stringify(json, null, 2));
  console.log(
    `[sprites] ${cfg.id}: bg rgb(${main.bg.color.join(',')}), ${boxes.length} frames of ${fw}x${fh}, atlas ${aw}x${ah}`,
  );
  boxes.forEach((b, i) =>
    console.log(`  ${names[i].padEnd(14)} box ${b.x0},${b.y0} ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}  anchor x=${b.ax}`),
  );

  if (debugDir) writeDebugPreview(atlas, json, path.join(debugDir, `${cfg.id}-preview.png`));
}

/** A sheet with its background keyed out (straight-alpha copy; the source file is never touched). Cached per run. */
function keyedSheet(file) {
  const hit = keyedCache.get(file);
  if (hit) return hit;
  const sheet = PNG.sync.read(fs.readFileSync(path.join(ROOT, file)));
  const { width: W, height: H } = sheet;
  const bg = estimateBackground(sheet.data, W, H);
  const px = removeBackground(sheet.data, W, H, bg, SPILL_TOLERANCE_AWAY[file]);
  removeSpecks(px, W, H, CONFIG.minSpeck);
  const keyed = { px, W, H, bg };
  keyedCache.set(file, keyed);
  return keyed;
}

/** Tight boxes of the figures, in reading order. `cols` is one count for every row, or a count per row. */
function findFigures({ px, W, H }, rows, cols) {
  const solid = (x, y) => px[(y * W + x) * 4 + 3] >= 128;
  const boxes = [];
  const rowBands = splitBands(projection(H, (y) => countRow(solid, W, y)), rows, 'rows');
  for (const [row, [y0, y1]] of rowBands.entries()) {
    const colCounts = projection(W, (x) => {
      let n = 0;
      for (let y = y0; y <= y1; y++) if (solid(x, y)) n++;
      return n;
    });
    const want = Array.isArray(cols) ? cols[row] : cols;
    for (const [x0, x1] of splitBands(colCounts, want, 'columns')) boxes.push(tightBox(solid, x0, y0, x1, y1));
  }
  return boxes;
}

function height(b) {
  return b.y1 - b.y0 + 1;
}

/** Solid (alpha >= 128) pixels of a figure: its silhouette area. */
function area(px, W, b) {
  let n = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (px[(y * W + x) * 4 + 3] >= 128) n++;
  return n;
}

/**
 * Crop a figure and resize it by `s` with an area-weighted (box) filter in premultiplied alpha, so
 * edges stay clean. Returns a figure with its own buffer.
 */
function scaleFigure(px, W, b, s) {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const w = Math.max(1, Math.round(bw * s));
  const h = Math.max(1, Math.round(bh * s));
  const sx = bw / w;
  const sy = bh / h;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fy0 = y * sy, fy1 = fy0 + sy;
    for (let x = 0; x < w; x++) {
      const fx0 = x * sx, fx1 = fx0 + sx;
      let r = 0, g = 0, bl = 0, a = 0, area = 0;
      for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
        const wy = Math.min(fy1, yy + 1) - Math.max(fy0, yy);
        for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
          const wgt = wy * (Math.min(fx1, xx + 1) - Math.max(fx0, xx));
          const i = ((b.y0 + yy) * W + b.x0 + xx) * 4;
          const al = (px[i + 3] / 255) * wgt;
          r += px[i] * al; g += px[i + 1] * al; bl += px[i + 2] * al; a += al; area += wgt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(bl / a);
        out[o + 3] = Math.round((a / area) * 255);
      }
    }
  }
  // Recompute the tight box in the new buffer (resampling can leave a faint empty edge).
  const solid = (x, y) => out[(y * w + x) * 4 + 3] >= 128;
  return { ...tightBox(solid, 0, 0, w - 1, h - 1), px: out, stride: w };
}

/**
 * A giant made of goo from one of a fighter's poses: the figure is cut from the fighter's sheet,
 * upsampled, its shading turned into glossy white goo (soft cool shadows, cream body, white
 * sheen where the form bulges) with the fine painted detail smoothed away, and goo drips hanging
 * off every downward-facing edge. Writes supers/<id>.png and supers/<id>.json (eye positions in
 * texture px, for the glow).
 */
function buildGiant(cfg) {
  const fighter = cfg.fighter && CONFIG.fighters.find((f) => f.id === cfg.fighter);
  const file = cfg.image ?? fighter.sheet;
  const src = path.join(ROOT, file);
  const dstPng = path.join(ROOT, CONFIG.outDir, 'supers', `${cfg.id}.png`);
  const dstJson = path.join(ROOT, CONFIG.outDir, 'supers', `${cfg.id}.json`);
  if (ifStale && isFresh([dstPng, dstJson], [src])) return;

  const sheet = keyedSheet(file);
  const box = fighter
    ? findFigures(sheet, fighter.rows, fighter.cols)[fighter.frames.indexOf(cfg.frame)]
    : tightBox((x, y) => sheet.px[(y * sheet.W + x) * 4 + 3] > 0, 0, 0, sheet.W - 1, sheet.H - 1);
  const k = cfg.upscale;
  const fig = scaleFigure(sheet.px, sheet.W, box, k);
  const w = fig.x1 - fig.x0 + 1;
  const h0 = fig.y1 - fig.y0 + 1;
  const drip = Math.round(cfg.dripMax * k);
  const h = h0 + drip;
  const at = (x, y) => ((fig.y0 + y) * fig.stride + fig.x0 + x) * 4;
  const alpha = new Float32Array(w * h);
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h0; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      alpha[y * w + x] = fig.px[i + 3] / 255;
      lum[y * w + x] = (0.3 * fig.px[i] + 0.59 * fig.px[i + 1] + 0.11 * fig.px[i + 2]) / 255;
    }
  }

  // Goo is one colour, so the painting's colours (dark vest, pale trousers) must not show; only its
  // shapes may. Two sources of form:
  // - the silhouette, puffed up like a pillow: blurring the alpha gives a height field that rises
  //   inward from every edge; lit from the upper left it rounds every limb and fold of cloth;
  // - the painted shading with its colours removed: the painting minus a broad blur of itself keeps
  //   the folds, muscles and face but not which garment is which colour.
  const smooth = blurMasked(lum, alpha, w, h, Math.round(0.6 * k));
  const broad = blurMasked(lum, alpha, w, h, Math.round(7 * k));
  const height = boxBlur(alpha, w, h, Math.round(5 * k));
  const fine = boxBlur(alpha, w, h, Math.round(1.5 * k));
  const light = (() => {
    const l = [-0.55, -0.7, 0.45];
    const n = Math.hypot(...l);
    return l.map((c) => c / n);
  })();

  // 'image' shading: the source's own light, stretched to the goo palette.
  const solid = [];
  for (let p = 0; p < w * h; p++) if (alpha[p] > 0.5) solid.push(smooth[p]);
  solid.sort((a, b) => a - b);
  const lo = solid[Math.floor(solid.length * 0.03)];
  const hi = solid[Math.floor(solid.length * 0.99)];
  const imageColor = (p) => {
    const n = Math.min(1, Math.max(0, (smooth[p] - lo) / (hi - lo)));
    const sheen = Math.min(1, Math.max(0, (smooth[p] - broad[p]) * 3));
    return gooColor(0.12 + 0.88 * Math.pow(n, 1.15), sheen);
  };

  const out = new PNG({ width: w, height: h });
  const colorAt = (p) => {
    if (cfg.shading === 'image') return imageColor(p);
    const x = p % w;
    const y = (p / w) | 0;
    const hAt = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : height[yy * w + xx] * 0.6 + fine[yy * w + xx] * 0.4);
    const gx = (hAt(x + 1, y) - hAt(x - 1, y)) * 0.5;
    const gy = (hAt(x, y + 1) - hAt(x, y - 1)) * 0.5;
    // Surface normal of the puffed silhouette (steeper near the edges).
    const bump = 9;
    const nx = -gx * bump;
    const ny = -gy * bump;
    const nl = Math.hypot(nx, ny, 1);
    const diffuse = Math.max(0, (nx * light[0] + ny * light[1] + light[2]) / nl);
    // Specular: the light's reflection, a tight hot spot where the surface faces between light and eye.
    const half = [light[0], light[1], light[2] + 1];
    const hl = Math.hypot(...half);
    const spec = Math.pow(Math.max(0, (nx * half[0] + ny * half[1] + half[2]) / nl / hl), 24);
    const detail = (smooth[p] - broad[p]) * 2.6;
    const v = Math.min(1, Math.max(0, 0.34 + 0.62 * diffuse + detail));
    const sheen = Math.min(1, spec * 1.6 + Math.max(0, detail - 0.08) * 2.5);
    return gooColor(v, sheen);
  };
  for (let p = 0; p < w * h0; p++) {
    if (alpha[p] <= 0) continue;
    const c = colorAt(p);
    out.data.set([c[0], c[1], c[2], Math.round(alpha[p] * 255)], p * 4);
  }

  // Drips: from bottom edges (solid above, empty below), seeded so the build is repeatable.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let lastDrip = -Infinity;
  const drips = [];
  for (let x = 2; x < w - 2; x++) {
    // None off the head (drips hanging from hair read as earrings).
    for (let y = Math.max(4, Math.round(h0 * (cfg.dripFrom ?? 0))); y < h0 - 4; y++) {
      const p = y * w + x;
      // The last solid pixel above empty space (the edge itself is a few px soft).
      if (alpha[p] < 0.6 || alpha[p + w] >= 0.6 || alpha[p + 3 * w] > 0.1) continue;
      if (Math.abs(x - lastDrip) < 5 * k || rand() > cfg.dripChance) continue;
      lastDrip = x;
      drips.push({ x, y, len: (cfg.dripMin + rand() * (cfg.dripMax - cfg.dripMin)) * k * (0.4 + 0.6 * rand()), r: (2.6 + rand() * 2.6) * k, c: gooColor(0.8, 0) });
    }
  }
  for (const d of drips) {
    // A thin neck (with a small fillet where it leaves the edge) running down into a round bead.
    const bead = d.r;
    for (let yy = 0; yy <= d.len + bead; yy++) {
      const t = Math.min(1, yy / d.len);
      const neck = yy <= d.len ? d.r * (0.42 + 0.6 * (1 - t) ** 6) : 0;
      const round = Math.sqrt(Math.max(0, bead * bead - (yy - d.len) ** 2));
      const half = Math.max(neck, round);
      const yAt = Math.round(d.y + yy);
      if (yAt >= h) break;
      for (let xx = Math.floor(d.x - half - 1); xx <= Math.ceil(d.x + half + 1); xx++) {
        if (xx < 0 || xx >= w) continue;
        const cover = Math.min(1, Math.max(0, half + 0.5 - Math.abs(xx - d.x)));
        if (cover <= 0) continue;
        const q = (yAt * w + xx) * 4;
        // Lit down the left of the bead, shaded on the right.
        const shade = 1 - 0.18 * ((xx - d.x) / Math.max(1, half) + 1);
        const a = Math.max(out.data[q + 3], Math.round(cover * 255));
        out.data[q] = Math.round(d.c[0] * shade);
        out.data[q + 1] = Math.round(d.c[1] * shade);
        out.data[q + 2] = Math.round(d.c[2] * shade);
        out.data[q + 3] = a;
        if (Math.abs(xx - (d.x - half * 0.35)) < 0.6 && yy > 2) out.data.set([255, 255, 255], q);
      }
    }
  }

  // Eyes: from sheet px to texture px.
  const eyes = cfg.eyes.map(([ex, ey]) => ({ x: (ex - box.x0) * k - fig.x0, y: (ey - box.y0) * k - fig.y0 }));
  fs.mkdirSync(path.dirname(dstPng), { recursive: true });
  fs.writeFileSync(dstPng, PNG.sync.write(out));
  fs.writeFileSync(dstJson, JSON.stringify({ size: { w, h }, eyes, bodyHeight: h0 }, null, 2));
  console.log(`[sprites] giant ${cfg.id}: ${cfg.image ?? `${cfg.fighter} ${cfg.frame}`}, ${w}x${h}, ${drips.length} drips`);
  if (debugDir) writeDebugPreview(out, { frames: {} }, path.join(debugDir, `${cfg.id}-preview.png`));
}

/** Goo colour for a shading value (0 dark .. 1 light) plus sheen: cool lavender shadows to cream to white. */
function gooColor(v, sheen) {
  const stops = [
    [0, [92, 86, 108]],
    [0.4, [182, 176, 190]],
    [0.75, [228, 223, 214]],
    [1, [250, 248, 242]],
  ];
  let c = stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    if (v > stops[i][0]) continue;
    const [a, ca] = stops[i - 1];
    const [b, cb] = stops[i];
    const t = (v - a) / (b - a);
    c = ca.map((x, j) => x + (cb[j] - x) * t);
    break;
  }
  return c.map((x) => Math.round(Math.min(255, x + (255 - x) * sheen * 0.85)));
}

/** Plain box blur, radius `r`, two passes (close to a gaussian). */
function boxBlur(v, w, h, r) {
  return blurMasked(v, new Float32Array(w * h).fill(1), w, h, r);
}

/** Box blur of `v` over solid pixels only (weights by alpha), radius `r`, two passes. */
function blurMasked(v, alpha, w, h, r) {
  let cur = Float32Array.from(v, (x, i) => x * alpha[i]);
  let wt = Float32Array.from(alpha);
  for (let pass = 0; pass < 2; pass++) {
    for (const horizontal of [true, false]) {
      const nv = new Float32Array(w * h);
      const nw = new Float32Array(w * h);
      const len = horizontal ? w : h;
      const lines = horizontal ? h : w;
      for (let l = 0; l < lines; l++) {
        const idx = (i) => (horizontal ? l * w + i : i * w + l);
        let sv = 0, sw = 0;
        for (let i = -r; i <= r; i++) if (i >= 0 && i < len) { sv += cur[idx(i)]; sw += wt[idx(i)]; }
        for (let i = 0; i < len; i++) {
          nv[idx(i)] = sv;
          nw[idx(i)] = sw;
          const add = i + r + 1, rem = i - r;
          if (add < len) { sv += cur[idx(add)]; sw += wt[idx(add)]; }
          if (rem >= 0) { sv -= cur[idx(rem)]; sw -= wt[idx(rem)]; }
        }
      }
      cur = nv;
      wt = nw;
    }
  }
  return Float32Array.from(cur, (x, i) => (wt[i] > 1e-6 ? x / wt[i] : 0));
}

function copyStage(stage) {
  const src = path.join(ROOT, stage.image);
  const dst = path.join(ROOT, CONFIG.outDir, 'stages', `${stage.id}${path.extname(stage.image)}`);
  if (ifStale && isFresh([dst], [src])) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`[sprites] stage ${stage.id}: copied`);
}

function isFresh(outputs, inputs) {
  if (!outputs.every((f) => fs.existsSync(f))) return false;
  const oldestOut = Math.min(...outputs.map((f) => fs.statSync(f).mtimeMs));
  return Math.max(scriptMtime, ...inputs.map((f) => fs.statSync(f).mtimeMs)) < oldestOut;
}

// --- background removal ------------------------------------------------------

/** Median colour of the image border, plus how noisy the background is. */
function estimateBackground(px, W, H) {
  const samples = [];
  const take = (x, y) => samples.push((y * W + x) * 4);
  for (let x = 0; x < W; x++) { take(x, 0); take(x, 1); take(x, H - 1); take(x, H - 2); }
  for (let y = 0; y < H; y++) { take(0, y); take(1, y); take(W - 1, y); take(W - 2, y); }
  const median = (c) => {
    const v = samples.map((i) => px[i + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const color = [median(0), median(1), median(2)];
  // Border pixels far from the key are a figure touching the edge, not background noise.
  const dists = samples
    .map((i) => colorDist(px, i, color))
    .filter((d) => d < 100)
    .sort((a, b) => a - b);
  const noise = dists[Math.floor(dists.length * 0.995)];
  return { color, threshold: noise + 12 };
}

function colorDist(px, i, c) {
  const dr = px[i] - c[0], dg = px[i + 1] - c[1], db = px[i + 2] - c[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Pixels close to the key colour are background. Only pixels within `edgeRadius` of the background
 * may get partial alpha (interior shading that happens to resemble the key stays opaque). For those
 * edge pixels we treat the colour as a mix of the key and a nearby "pure" foreground colour, solve
 * for alpha, and un-mix the key out of the colour so no magenta fringe is left (no halo).
 */
function removeBackground(px, W, H, bg, awayTol) {
  const N = W * H;
  const B = bg.color;
  const spill = makeSpillModel(B, awayTol);
  const isBg = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (colorDist(px, p * 4, B) <= bg.threshold) isBg[p] = 1;

  // Distance (chebyshev, capped) to the nearest background pixel via two-pass dilation.
  const R = CONFIG.edgeRadius;
  const near = dilate(isBg, W, H, R);

  const out = new Uint8Array(N * 4);
  const SEARCH = R + 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      if (isBg[p]) continue; // stays transparent black
      if (!near[p]) {
        // Interior. Small enclosed gaps (between hair strands, under an arm) are key-coloured
        // blends that never touch the open background; turn the key share into transparency.
        const t = spill ? Math.min(1, Math.max(0, (spill.keyness(px, i) - spill.tol(px, i)) / (spill.bgKey - spill.tol(px, i)))) : 0;
        const a = t < 0.15 ? 1 : 1 - t;
        if (a < 0.05) continue;
        for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round((px[i + c] - (1 - a) * B[c]) / a)));
        out[i + 3] = Math.round(a * 255);
        if (spill) despill(out, i, spill);
        continue;
      }
      // Reference foreground colour = the non-background neighbour furthest from the key colour.
      let best = -1, bestD = -1;
      for (let yy = Math.max(0, y - SEARCH); yy <= Math.min(H - 1, y + SEARCH); yy++) {
        for (let xx = Math.max(0, x - SEARCH); xx <= Math.min(W - 1, x + SEARCH); xx++) {
          const q = yy * W + xx;
          if (isBg[q]) continue;
          const d = colorDist(px, q * 4, B);
          if (d > bestD) { bestD = d; best = q * 4; }
        }
      }
      const F = [px[best], px[best + 1], px[best + 2]];
      const fb = [F[0] - B[0], F[1] - B[1], F[2] - B[2]];
      const cb = [px[i] - B[0], px[i + 1] - B[1], px[i + 2] - B[2]];
      const len2 = fb[0] * fb[0] + fb[1] * fb[1] + fb[2] * fb[2];
      let a = len2 > 0 ? (cb[0] * fb[0] + cb[1] * fb[1] + cb[2] * fb[2]) / len2 : 1;
      a = Math.min(1, Math.max(0, a));
      if (a < 0.05) continue;
      for (let c = 0; c < 3; c++) {
        // C = a*F + (1-a)*B  =>  F = (C - (1-a)*B) / a. Low alpha is noisy, lean on the reference colour.
        const unmixed = (px[i + c] - (1 - a) * B[c]) / a;
        const v = a < 0.35 ? F[c] : unmixed;
        out[i + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      out[i + 3] = Math.round(a * 255);
      if (spill) despill(out, i, spill);
    }
  }
  return out;
}

/**
 * For a saturated key (magenta, green, ...) "keyness" = how much a colour leans towards the key hue:
 * min of the channels that are high in the key minus max of the channels that are low in it.
 * Returns null for unsaturated keys (white/grey), where hue-based spill removal does not apply.
 * `tol(px, i)` is how much keyness a pixel may keep: 25, or `awayTol` (if given) for a pixel whose
 * two high channels lean the opposite way to the key's (bluish purple against a reddish magenta).
 */
function makeSpillModel(B, awayTol) {
  const hi = [0, 1, 2].filter((c) => B[c] >= 128);
  const lo = [0, 1, 2].filter((c) => B[c] < 128);
  if (!hi.length || !lo.length) return null;
  const keyness = (px, i) => Math.min(...hi.map((c) => px[i + c])) - Math.max(...lo.map((c) => px[i + c]));
  const lean = (px, i) => px[i + hi[0]] - px[i + hi[1]];
  const keyLean = hi.length === 2 ? Math.sign(lean(B, 0)) : 0;
  const tol = (px, i) => (awayTol !== undefined && keyLean !== 0 && Math.sign(lean(px, i)) === -keyLean ? awayTol : 25);
  return { hi, lo, keyness, bgKey: keyness(B, 0), tol };
}

/** Clamp the key hue out of a pixel so no tinted fringe survives: keyness <= tol. */
function despill(out, i, spill) {
  const excess = spill.keyness(out, i) - spill.tol(out, i);
  if (excess > 0) for (const c of spill.hi) out[i + c] = Math.max(0, out[i + c] - excess);
}

function dilate(mask, W, H, r) {
  const tmp = new Uint8Array(mask.length);
  const res = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r) && !v; k++) v = mask[y * W + k];
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r) && !v; k++) v = tmp[k * W + x];
      res[y * W + x] = v;
    }
  }
  return res;
}

/** Remove small isolated islands of non-transparent pixels (8-connected). */
function removeSpecks(out, W, H, minSize) {
  const N = W * H;
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  for (let start = 0; start < N; start++) {
    if (seen[start] || out[start * 4 + 3] === 0) continue;
    let top = 0, count = 0;
    const members = [];
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const p = stack[--top];
      members.push(p);
      count++;
      const x = p % W, y = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (!seen[q] && out[q * 4 + 3] !== 0) { seen[q] = 1; stack[top++] = q; }
        }
      }
    }
    if (count < minSize) for (const p of members) out[p * 4 + 3] = 0;
  }
  for (let p = 0; p < N; p++) if (out[p * 4 + 3] === 0) out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = 0;
}

// --- figure detection --------------------------------------------------------

function countRow(solid, W, y) {
  let n = 0;
  for (let x = 0; x < W; x++) if (solid(x, y)) n++;
  return n;
}

function projection(len, count) {
  const a = new Array(len);
  for (let i = 0; i < len; i++) a[i] = count(i);
  return a;
}

/** Runs of non-empty entries; the closest runs are merged until exactly `want` remain. */
function splitBands(counts, want, label) {
  const bands = [];
  let start = -1;
  counts.forEach((c, i) => {
    if (c > 0 && start < 0) start = i;
    if (c === 0 && start >= 0) { bands.push([start, i - 1]); start = -1; }
  });
  if (start >= 0) bands.push([start, counts.length - 1]);
  if (bands.length < want) throw new Error(`could only separate ${bands.length} ${label}, expected ${want}`);
  while (bands.length > want) {
    let gi = 0;
    for (let i = 1; i < bands.length - 1; i++) {
      if (bands[i + 1][0] - bands[i][1] < bands[gi + 1][0] - bands[gi][1]) gi = i;
    }
    bands.splice(gi, 2, [bands[gi][0], bands[gi + 1][1]]);
  }
  return bands;
}

function tightBox(solid, x0, y0, x1, y1) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!solid(x, y)) continue;
      b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
    }
  }
  return b;
}

// --- debug -------------------------------------------------------------------

/** Frames composited over bright green with anchor guides, to eyeball halos and alignment. */
function writeDebugPreview(atlas, json, file) {
  const img = new PNG({ width: atlas.width, height: atlas.height });
  for (let i = 0; i < atlas.data.length; i += 4) {
    const a = atlas.data[i + 3] / 255;
    img.data[i] = Math.round(atlas.data[i] * a);
    img.data[i + 1] = Math.round(atlas.data[i + 1] * a + 200 * (1 - a));
    img.data[i + 2] = Math.round(atlas.data[i + 2] * a);
    img.data[i + 3] = 255;
  }
  for (const f of Object.values(json.frames)) {
    const { x, y, w, h } = f.frame;
    const ax = x + Math.round(f.anchor.x * w), by = y + Math.round(f.anchor.y * h);
    for (let xx = x; xx < x + w; xx++) setPx(img, xx, by, [255, 0, 0]);
    for (let yy = y; yy < y + h; yy++) setPx(img, ax, yy, [0, 0, 255]);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(img));
  console.log(`[sprites] debug preview: ${file}`);
}

function setPx(img, x, y, c) {
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2];
}
