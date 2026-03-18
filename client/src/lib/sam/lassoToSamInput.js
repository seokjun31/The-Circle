/**
 * lassoToSamInput — Convert a freehand lasso path to SAM decoder point inputs.
 *
 * Returns a flat array of { x, y, label } points in image-pixel coordinates:
 *   label 2  = top-left  box corner  (SAM box-prompt convention)
 *   label 3  = bottom-right box corner
 *   label 1  = positive foreground point (inside lasso)
 *   label 0  = negative background point (outside lasso, inside bounding box)
 *
 * Hybrid approach:
 *   Box alone        → picks up everything inside the bounding box (imprecise).
 *   Box + positives  → tells SAM "the lasso interior is what we want".
 *   Box + pos + neg  → additionally excludes corners that are outside the lasso
 *                      → maximum precision for irregular shapes (walls, niches…).
 */

/**
 * @param {Array<{x:number, y:number}>} lassoPath  Lasso points in image pixels
 * @returns {Array<{x:number, y:number, label:number}>}
 */
export function lassoToSamInput(lassoPath) {
  if (lassoPath.length < 3) return [];

  // 1. Bounding box (represented as SAM box-prompt corner points, labels 2 & 3)
  const xCoords = lassoPath.map((p) => p.x);
  const yCoords = lassoPath.map((p) => p.y);
  const box = {
    x_min: Math.min(...xCoords),
    y_min: Math.min(...yCoords),
    x_max: Math.max(...xCoords),
    y_max: Math.max(...yCoords),
  };

  const boxPoints = [
    { x: box.x_min, y: box.y_min, label: 2 }, // top-left
    { x: box.x_max, y: box.y_max, label: 3 }, // bottom-right
  ];

  // 2. Positive points: inside the lasso polygon (label = 1)
  const center = getPolygonCentroid(lassoPath);
  const inner1 = getInnerOffset(center, lassoPath, 0.3);
  const positivePoints = [
    { x: center.x, y: center.y, label: 1 },
    { x: inner1.x, y: inner1.y, label: 1 },
  ];

  // 3. Negative points: inside bounding box but outside the lasso (label = 0)
  const outerPoints = getOutsideLassoInsideBox(lassoPath, box)
    .slice(0, 2)
    .map((p) => ({ x: p.x, y: p.y, label: 0 }));

  return [...boxPoints, ...positivePoints, ...outerPoints];
}

// ── Utility functions ─────────────────────────────────────────────────────────

/**
 * Compute the centroid (average position) of a polygon.
 *
 * @param {Array<{x:number, y:number}>} polygon
 * @returns {{x:number, y:number}}
 */
export function getPolygonCentroid(polygon) {
  let sx = 0;
  let sy = 0;
  for (const p of polygon) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / polygon.length, y: sy / polygon.length };
}

/**
 * Return a point offset from `center` that stays well inside the polygon.
 * Tries several cardinal directions and picks the first that lands inside.
 *
 * @param {{x:number, y:number}} center   Polygon centroid
 * @param {Array<{x:number, y:number}>} polygon
 * @param {number} ratio                  Fractional distance from center (0–1)
 * @returns {{x:number, y:number}}
 */
export function getInnerOffset(center, polygon, ratio) {
  const xCoords = polygon.map((p) => p.x);
  const yCoords = polygon.map((p) => p.y);
  const bboxW = Math.max(...xCoords) - Math.min(...xCoords);
  const bboxH = Math.max(...yCoords) - Math.min(...yCoords);
  const stepX = bboxW * ratio * 0.3;
  const stepY = bboxH * ratio * 0.3;

  // Try 8 cardinal + diagonal directions, return first point that's inside
  const directions = [
    { dx: 0,     dy: stepY  },
    { dx: 0,     dy: -stepY },
    { dx: stepX, dy: 0      },
    { dx: -stepX, dy: 0     },
    { dx: stepX, dy: stepY  },
    { dx: -stepX, dy: -stepY },
    { dx: stepX, dy: -stepY },
    { dx: -stepX, dy: stepY },
  ];

  for (const { dx, dy } of directions) {
    const candidate = { x: center.x + dx, y: center.y + dy };
    if (isPointInsidePolygon(candidate, polygon)) return candidate;
  }

  // Fallback: a tiny nudge from center (usually still inside)
  return { x: center.x + stepX * 0.1, y: center.y + stepY * 0.1 };
}

/**
 * Find candidate negative points: inside the bounding box but outside the lasso.
 * Probes 8 near-edge positions in the box and collects those that are outside.
 *
 * @param {Array<{x:number, y:number}>} lasso
 * @param {{ x_min, y_min, x_max, y_max }} box
 * @returns {Array<{x:number, y:number}>}
 */
export function getOutsideLassoInsideBox(lasso, box) {
  const { x_min, y_min, x_max, y_max } = box;
  const w = x_max - x_min;
  const h = y_max - y_min;

  // Sample near the 4 corners and 4 edge midpoints (inside box)
  const candidates = [
    { x: x_min + w * 0.08, y: y_min + h * 0.08 }, // near top-left
    { x: x_max - w * 0.08, y: y_min + h * 0.08 }, // near top-right
    { x: x_min + w * 0.08, y: y_max - h * 0.08 }, // near bottom-left
    { x: x_max - w * 0.08, y: y_max - h * 0.08 }, // near bottom-right
    { x: x_min + w * 0.50, y: y_min + h * 0.08 }, // top-mid
    { x: x_min + w * 0.50, y: y_max - h * 0.08 }, // bottom-mid
    { x: x_min + w * 0.08, y: y_min + h * 0.50 }, // left-mid
    { x: x_max - w * 0.08, y: y_min + h * 0.50 }, // right-mid
  ];

  return candidates.filter((p) => !isPointInsidePolygon(p, lasso));
}

/**
 * Ray-casting algorithm — returns true if `point` is inside `polygon`.
 *
 * @param {{x:number, y:number}} point
 * @param {Array<{x:number, y:number}>} polygon
 * @returns {boolean}
 */
export function isPointInsidePolygon(point, polygon) {
  const { x, y } = point;
  const n = polygon.length;
  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}
