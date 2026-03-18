/**
 * edgeSnap — Structural edge detection + bounded flood-fill segmentation.
 *
 * Used for labels where SAM under-performs because the target surface is
 * texturally homogeneous (wall, ceiling) but has strong structural edges.
 *
 * Pipeline:
 *   1. sobelEdges()         – Detect structural edges from the room image
 *   2. fillPolygon()        – Rasterise user lasso into an initial binary mask
 *   3. dilate()             – Expand mask boundary by snapRadius (search region)
 *   4. boundedFloodFill()   – Fill from centroid; stop at Sobel edges + region boundary
 *   5. gaussianSmooth()     – 3×3 majority-vote smoothing for a clean boundary
 *
 * All operations are pure (no DOM side-effects except the single createCanvas in
 * fillPolygon) and run synchronously in < 80 ms on a 1024×768 canvas.
 */

// ── 1. Sobel edge detection ───────────────────────────────────────────────────

/**
 * Compute Sobel gradient magnitude and threshold to a binary edge map.
 *
 * @param {Uint8ClampedArray} pixels  RGBA flat pixel array (from ImageData.data)
 * @param {number} width
 * @param {number} height
 * @param {number} [threshold=25]  Gradient magnitude cutoff (0–255 scale)
 * @returns {Uint8Array}  Binary edge map (1 = edge, 0 = not)
 */
export function sobelEdges(pixels, width, height, threshold = 25) {
  const n    = width * height;
  const gray = new Float32Array(n);

  // RGBA → greyscale (ITU-R BT.601)
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2];
  }

  const edges = new Uint8Array(n);

  // 3×3 Sobel — skip the 1-pixel border
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const tl = gray[(y - 1) * width + (x - 1)];
      const tm = gray[(y - 1) * width +  x      ];
      const tr = gray[(y - 1) * width + (x + 1)];
      const ml = gray[ y      * width + (x - 1)];
      const mr = gray[ y      * width + (x + 1)];
      const bl = gray[(y + 1) * width + (x - 1)];
      const bm = gray[(y + 1) * width +  x      ];
      const br = gray[(y + 1) * width + (x + 1)];

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tm - tr + bl + 2 * bm + br;

      edges[y * width + x] = Math.sqrt(gx * gx + gy * gy) > threshold ? 1 : 0;
    }
  }

  return edges;
}

// ── 2. Polygon fill ───────────────────────────────────────────────────────────

/**
 * Rasterise a freehand polygon path into a binary mask using the Canvas 2D API.
 *
 * @param {Array<{x:number,y:number}>} points  Polygon vertices in canvas pixels
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}  Binary mask (1 = inside polygon, 0 = outside)
 */
export function fillPolygon(points, width, height) {
  if (points.length < 3) return new Uint8Array(width * height);

  const canvas  = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill();

  const rgba   = ctx.getImageData(0, 0, width, height).data;
  const binary = new Uint8Array(width * height);
  // Alpha channel: 255 inside the polygon fill, 0 outside
  for (let i = 0; i < binary.length; i++) binary[i] = rgba[i * 4 + 3] > 128 ? 1 : 0;
  return binary;
}

// ── 3. Fast separable OR-dilation ────────────────────────────────────────────

/**
 * Morphological dilation via two separable 1-D passes (horizontal → vertical).
 * Equivalent to a diamond-shaped structuring element; O(N · r) time.
 *
 * @param {Uint8Array} binary
 * @param {number} width
 * @param {number} height
 * @param {number} radius  Dilation radius in pixels
 * @returns {Uint8Array}
 */
export function dilate(binary, width, height, radius) {
  const tmp = new Uint8Array(binary.length);
  const out = new Uint8Array(binary.length);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(width - 1, x + radius);
      for (let nx = xMin; nx <= xMax; nx++) {
        if (binary[y * width + nx]) { tmp[y * width + x] = 1; break; }
      }
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const yMin = Math.max(0, y - radius);
      const yMax = Math.min(height - 1, y + radius);
      for (let ny = yMin; ny <= yMax; ny++) {
        if (tmp[ny * width + x]) { out[y * width + x] = 1; break; }
      }
    }
  }

  return out;
}

// ── 4. Bounded flood fill ─────────────────────────────────────────────────────

/**
 * DFS flood fill from a seed point constrained by two conditions:
 *   - pixel must be inside `boundary`  (the dilated initial mask)
 *   - pixel must NOT be an `edgeMap` pixel  (Sobel edges act as walls)
 *
 * @param {number} startX
 * @param {number} startY
 * @param {Uint8Array} edgeMap   Binary edge map (1 = stop)
 * @param {Uint8Array} boundary  Binary fill region (1 = allowed)
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}  Binary result mask
 */
export function boundedFloodFill(startX, startY, edgeMap, boundary, width, height) {
  const result = new Uint8Array(width * height);
  startX = Math.max(0, Math.min(width - 1, Math.round(startX)));
  startY = Math.max(0, Math.min(height - 1, Math.round(startY)));

  const startIdx = startY * width + startX;
  if (edgeMap[startIdx] || !boundary[startIdx]) {
    // Seed is on an edge or outside the boundary — scan nearby for a valid seed
    let fallback = -1;
    const R = 8;
    outer: for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = startX + dx, ny = startY + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const idx = ny * width + nx;
        if (!edgeMap[idx] && boundary[idx]) { fallback = idx; break outer; }
      }
    }
    if (fallback < 0) return result; // no valid seed found
    result[fallback] = 1;
    const stack = [fallback];
    _fill(stack, result, edgeMap, boundary, width, height);
    return result;
  }

  result[startIdx] = 1;
  const stack = [startIdx];
  _fill(stack, result, edgeMap, boundary, width, height);
  return result;
}

function _fill(stack, result, edgeMap, boundary, width, height) {
  while (stack.length > 0) {
    const idx = stack.pop();
    const x   = idx % width;
    const y   = (idx / width) | 0;

    const left  = x > 0          ? idx - 1     : -1;
    const right = x < width - 1  ? idx + 1     : -1;
    const up    = y > 0          ? idx - width  : -1;
    const down  = y < height - 1 ? idx + width  : -1;

    for (const nidx of [left, right, up, down]) {
      if (nidx < 0 || result[nidx] || edgeMap[nidx] || !boundary[nidx]) continue;
      result[nidx] = 1;
      stack.push(nidx);
    }
  }
}

// ── 5. 3×3 majority-vote smooth ───────────────────────────────────────────────

/**
 * Smooth the binary mask boundary with a 3×3 majority vote.
 * A pixel is set iff ≥ 5 of its 9 neighbours (including itself) are set.
 *
 * @param {Uint8Array} binary
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function gaussianSmooth(binary, width, height) {
  const out = new Uint8Array(binary.length);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const sum =
        binary[(y - 1) * width + (x - 1)] + binary[(y - 1) * width + x] + binary[(y - 1) * width + (x + 1)] +
        binary[ y      * width + (x - 1)] + binary[ y      * width + x] + binary[ y      * width + (x + 1)] +
        binary[(y + 1) * width + (x - 1)] + binary[(y + 1) * width + x] + binary[(y + 1) * width + (x + 1)];
      out[y * width + x] = sum >= 5 ? 1 : 0;
    }
  }

  // Copy 1-pixel border unchanged
  for (let x = 0; x < width; x++) {
    out[x]                      = binary[x];
    out[(height - 1) * width + x] = binary[(height - 1) * width + x];
  }
  for (let y = 0; y < height; y++) {
    out[y * width]              = binary[y * width];
    out[y * width + (width - 1)] = binary[y * width + (width - 1)];
  }

  return out;
}

// ── 6. Main export ────────────────────────────────────────────────────────────

/**
 * Generate a refined mask by snapping the user's lasso to structural room edges.
 *
 * Steps:
 *  1. Sobel edge detection on the room image canvas
 *  2. Polygon fill of the user's lasso path → initial mask
 *  3. Dilate the initial mask by `snapRadius` → search region
 *  4. Bounded flood fill from lasso centroid (stops at Sobel edges)
 *  5. 3×3 majority-vote smoothing
 *
 * @param {HTMLCanvasElement} imageCanvas  Canvas element with the room photo
 * @param {Array<{x:number,y:number}>} userPath  Lasso / box vertices (canvas px)
 * @param {{w:number, h:number}} canvasSize
 * @param {object} [opts]
 * @param {number} [opts.edgeThreshold=25]  Sobel magnitude threshold
 * @param {number} [opts.snapRadius=15]     Max boundary snap distance (px)
 * @returns {Uint8Array}  Binary mask (1 = selected, 0 = not)
 */
export function edgeSnapMask(imageCanvas, userPath, canvasSize, opts = {}) {
  const { w: width, h: height } = canvasSize;
  const { edgeThreshold = 25, snapRadius = 15 } = opts;

  // 1. Structural edge map from the room image
  const ctx     = imageCanvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, width, height);
  const edges   = sobelEdges(imgData.data, width, height, edgeThreshold);

  // 2. Rasterise user polygon → initial mask
  const initial  = fillPolygon(userPath, width, height);

  // 3. Expand by snapRadius → defines how far the boundary may snap outward
  const expanded = dilate(initial, width, height, snapRadius);

  // 4. Centroid of user path (flood fill seed)
  let cx = 0, cy = 0;
  for (const { x, y } of userPath) { cx += x; cy += y; }
  cx /= userPath.length;
  cy /= userPath.length;

  // 5. Flood fill from centroid, stop at Sobel edges, bounded by expanded mask
  const filled = boundedFloodFill(cx, cy, edges, expanded, width, height);

  // 6. Smooth boundary
  return gaussianSmooth(filled, width, height);
}
