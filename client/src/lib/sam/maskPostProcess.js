/**
 * maskPostProcess — Binary mask cleanup utilities for SAM output.
 *
 * Two operations are provided, both operating on a flat Uint8Array (0/1):
 *
 *   cleanMask   — Connected Component Labeling (CCL) to remove tiny isolated
 *                 islands that account for less than `minAreaRatio` of the
 *                 total selected area.  Typical value: 1 % (0.01).
 *
 *   fillHoles   — Flood-fill from the image border to identify "true
 *                 background", then fill interior holes whose area is less
 *                 than `maxHoleRatio` of the total selected area.
 *                 Typical value: 2 % (0.02).
 *
 * Both functions are pure (return new Uint8Arrays) and run in O(n) time
 * where n = width × height.  For a typical display canvas (~600 × 800)
 * each call takes < 5 ms on modern hardware.
 */

// ── Union-Find helpers ────────────────────────────────────────────────────────

function makeParent(n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  return p;
}

function find(parent, x) {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]]; // path halving
    x = parent[x];
  }
  return x;
}

function union(parent, a, b) {
  a = find(parent, a);
  b = find(parent, b);
  if (a !== b) parent[b] = a;
}

// ── Connected Component Labeling (4-connectivity) ─────────────────────────────

/**
 * Label connected components in a binary mask using union-find.
 *
 * @param {Uint8Array} binary   0/1 mask, row-major, width × height elements
 * @param {number} width
 * @param {number} height
 * @returns {{ parent: Int32Array, areas: Map<number,number> }}
 *   parent: union-find array; call find(parent, i) to get root of pixel i
 *   areas:  root → pixel count for each connected component
 */
function cclBinary(binary, width, height) {
  const n      = width * height;
  const parent = makeParent(n);

  // Single-pass union with left and top neighbours
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!binary[i]) continue;
      if (x > 0     && binary[i - 1])     union(parent, i, i - 1);
      if (y > 0     && binary[i - width]) union(parent, i, i - width);
    }
  }

  // Count pixels per root (component area)
  const areas = new Map();
  for (let i = 0; i < n; i++) {
    if (!binary[i]) continue;
    const root = find(parent, i);
    areas.set(root, (areas.get(root) || 0) + 1);
  }

  return { parent, areas };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Remove isolated "island" components whose area is less than
 * `minAreaRatio` of the total selected pixel count.
 *
 * Example: minAreaRatio=0.01 removes components smaller than 1 % of the mask.
 *
 * @param {Uint8Array} binary       Row-major 0/1 mask
 * @param {number}     width
 * @param {number}     height
 * @param {number}     [minAreaRatio=0.01]
 * @returns {Uint8Array}  New mask with small islands removed
 */
export function cleanMask(binary, width, height, minAreaRatio = 0.01) {
  let totalSelected = 0;
  for (let i = 0; i < binary.length; i++) totalSelected += binary[i];
  if (totalSelected === 0) return binary;

  const minArea    = Math.max(1, Math.floor(totalSelected * minAreaRatio));
  const { parent, areas } = cclBinary(binary, width, height);

  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    if (!binary[i]) continue;
    if ((areas.get(find(parent, i)) || 0) >= minArea) result[i] = 1;
  }
  return result;
}

/**
 * Fill interior "holes" (background regions completely enclosed by the mask)
 * whose area is less than `maxHoleRatio` of the total selected pixel count.
 *
 * Algorithm:
 *   1. DFS/stack flood-fill from all four image edges to mark outer background.
 *   2. Any background pixel not reached is "interior" (a hole).
 *   3. CCL the interior background.
 *   4. Fill components smaller than maxHoleRatio × totalSelected.
 *
 * Example: maxHoleRatio=0.02 fills holes smaller than 2 % of the mask area.
 *
 * @param {Uint8Array} binary       Row-major 0/1 mask
 * @param {number}     width
 * @param {number}     height
 * @param {number}     [maxHoleRatio=0.02]
 * @returns {Uint8Array}  New mask with small interior holes filled
 */
export function fillHoles(binary, width, height, maxHoleRatio = 0.02) {
  const n = width * height;

  let totalSelected = 0;
  for (let i = 0; i < binary.length; i++) totalSelected += binary[i];
  if (totalSelected === 0) return binary;

  // ── Step 1: Flood-fill outer background from all edge pixels ─────────────
  const outerBg = new Uint8Array(n);
  const stack   = [];

  function seedEdge(i) {
    if (!binary[i] && !outerBg[i]) { outerBg[i] = 1; stack.push(i); }
  }

  for (let x = 0; x < width; x++) {
    seedEdge(x);                          // top row
    seedEdge((height - 1) * width + x);  // bottom row
  }
  for (let y = 1; y < height - 1; y++) {
    seedEdge(y * width);                  // left column
    seedEdge(y * width + width - 1);     // right column
  }

  while (stack.length > 0) {
    const i = stack.pop();
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0         && !binary[i - 1]     && !outerBg[i - 1])     { outerBg[i - 1]     = 1; stack.push(i - 1);     }
    if (x < width - 1 && !binary[i + 1]     && !outerBg[i + 1])     { outerBg[i + 1]     = 1; stack.push(i + 1);     }
    if (y > 0         && !binary[i - width] && !outerBg[i - width]) { outerBg[i - width] = 1; stack.push(i - width); }
    if (y < height - 1 && !binary[i + width] && !outerBg[i + width]){ outerBg[i + width] = 1; stack.push(i + width); }
  }

  // ── Step 2: Collect interior background pixels ────────────────────────────
  const interiorBg = new Uint8Array(n);
  let   totalHoles = 0;
  for (let i = 0; i < n; i++) {
    if (!binary[i] && !outerBg[i]) { interiorBg[i] = 1; totalHoles++; }
  }
  if (totalHoles === 0) return binary;

  // ── Step 3: CCL on interior background ───────────────────────────────────
  const { parent, areas } = cclBinary(interiorBg, width, height);
  const maxHoleArea = totalSelected * maxHoleRatio;

  // ── Step 4: Fill small holes ──────────────────────────────────────────────
  const result = new Uint8Array(binary);
  for (let i = 0; i < n; i++) {
    if (!interiorBg[i]) continue;
    const root = find(parent, i);
    if ((areas.get(root) || 0) < maxHoleArea) result[i] = 1;
  }
  return result;
}
