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
    },
  ],
  stages: [{ id: 'valley', image: 'images/Serene Fantasy Valley Panorama.png' }],
  outDir: 'public/assets',
  framePad: 4, // transparent margin around the figures inside the shared frame canvas
  atlasGap: 2, // gap between frames in the atlas (prevents bleeding under linear filtering)
  maxAtlas: 2048,
  edgeRadius: 2, // width (px) of the band next to the background where partial alpha is allowed
  minSpeck: 40, // foreground islands smaller than this (px) are discarded as noise
};

const args = process.argv.slice(2);
const ifStale = args.includes('--if-stale');
const debugDir = args.includes('--debug') ? path.resolve(args[args.indexOf('--debug') + 1] ?? 'sprite-debug') : null;
const scriptMtime = fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;

for (const fighter of CONFIG.fighters) buildFighter(fighter);
for (const stage of CONFIG.stages) copyStage(stage);

// ---------------------------------------------------------------------------

function buildFighter(cfg) {
  const src = path.join(ROOT, cfg.sheet);
  const outDir = path.join(ROOT, CONFIG.outDir, 'fighters');
  const outPng = path.join(outDir, `${cfg.id}.png`);
  const outJson = path.join(outDir, `${cfg.id}.json`);
  if (ifStale && isFresh([outPng, outJson], [src])) {
    console.log(`[sprites] ${cfg.id}: up to date`);
    return;
  }

  const sheet = PNG.sync.read(fs.readFileSync(src));
  const { width: W, height: H } = sheet;
  const rgba = sheet.data;

  // 1. Background removal -> straight-alpha RGBA (copy, the source buffer is not touched).
  const bg = estimateBackground(rgba, W, H);
  const out = removeBackground(rgba, W, H, bg);
  removeSpecks(out, W, H, CONFIG.minSpeck);

  // 2. Find the 12 figures: split by empty rows/columns instead of assuming an even grid.
  const solid = (x, y) => out[(y * W + x) * 4 + 3] >= 128;
  const rowBands = splitBands(projection(H, (y) => countRow(solid, W, y)), cfg.rows, 'rows');
  const boxes = [];
  for (const [y0, y1] of rowBands) {
    const colCounts = projection(W, (x) => {
      let n = 0;
      for (let y = y0; y <= y1; y++) if (solid(x, y)) n++;
      return n;
    });
    for (const [x0, x1] of splitBands(colCounts, cfg.cols, 'columns')) boxes.push(tightBox(solid, x0, y0, x1, y1));
  }
  if (boxes.length !== cfg.frames.length) throw new Error(`found ${boxes.length} figures, expected ${cfg.frames.length}`);

  // 3. Anchor each figure: feet baseline = lowest solid row; horizontal anchor = middle of the feet.
  boxes.forEach((b, i) => {
    const footRows = Math.max(4, Math.round((b.y1 - b.y0 + 1) * 0.06));
    let minX = Infinity, maxX = -Infinity;
    for (let y = b.y1 - footRows + 1; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) if (solid(x, y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
    b.ax = Math.round((minX + maxX) / 2) + (cfg.anchorNudge[cfg.frames[i]]?.dx ?? 0);
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
        const s = (y * W + x) * 4;
        if (out[s + 3] === 0) continue;
        const d = ((y + oy) * aw + (x + ox)) * 4;
        atlas.data[d] = out[s];
        atlas.data[d + 1] = out[s + 1];
        atlas.data[d + 2] = out[s + 2];
        atlas.data[d + 3] = out[s + 3];
      }
    }
    frames[cfg.frames[i]] = {
      frame: { x: fx, y: fy, w: fw, h: fh },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: fw, h: fh },
      sourceSize: { w: fw, h: fh },
      anchor: { x: 0.5, y: baselineY / fh },
    };
  });

  const standing = boxes[cfg.frames.indexOf(cfg.standingFrame)];
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
        background: bg.color,
      },
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPng, PNG.sync.write(atlas));
  fs.writeFileSync(outJson, JSON.stringify(json, null, 2));
  console.log(
    `[sprites] ${cfg.id}: bg rgb(${bg.color.join(',')}), ${boxes.length} frames of ${fw}x${fh}, atlas ${aw}x${ah}`,
  );
  boxes.forEach((b, i) =>
    console.log(`  ${cfg.frames[i].padEnd(14)} box ${b.x0},${b.y0} ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}  anchor x=${b.ax}`),
  );

  if (debugDir) writeDebugPreview(atlas, json, path.join(debugDir, `${cfg.id}-preview.png`));
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
  const dists = samples.map((i) => colorDist(px, i, color)).sort((a, b) => a - b);
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
function removeBackground(px, W, H, bg) {
  const N = W * H;
  const B = bg.color;
  const spill = makeSpillModel(B);
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
        const t = spill ? Math.min(1, Math.max(0, (spill.keyness(px, i) - spill.tol) / (spill.bgKey - spill.tol))) : 0;
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
 */
function makeSpillModel(B) {
  const hi = [0, 1, 2].filter((c) => B[c] >= 128);
  const lo = [0, 1, 2].filter((c) => B[c] < 128);
  if (!hi.length || !lo.length) return null;
  const keyness = (px, i) => Math.min(...hi.map((c) => px[i + c])) - Math.max(...lo.map((c) => px[i + c]));
  return { hi, lo, keyness, bgKey: keyness(B, 0), tol: 25 };
}

/** Clamp the key hue out of a pixel so no tinted fringe survives: keyness <= tol. */
function despill(out, i, spill) {
  const excess = spill.keyness(out, i) - spill.tol;
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
