/**
 * semanticSegmentation — SegFormer (ADE20K) browser inference via Transformers.js.
 *
 * Runs once per uploaded image (background, invisible to the user) and caches
 * per-label binary masks so the chat system can instantly highlight a region
 * when the user says "벽 바꿔줘" or "바닥 대리석으로".
 *
 * Pipeline:
 *   1. pipeline('image-segmentation', SegFormer)  → raw ADE20K segments
 *   2. ADE20K label → The Circle label mapping   → merge same-label segments (OR)
 *   3. Edge snap refinement (wall / ceiling only) → tighter, cleaner boundaries
 *
 * Interface:
 *   roomSegmenter.analyzeRoom(imageUrl, imageCanvas?)  → Promise<Map>
 *   roomSegmenter.getSegment(label)                    → { binary, width, height } | null
 *   roomSegmenter.getAllSegments()                      → Array<{ label, binary, width, height }>
 *   roomSegmenter.clear()
 */

import { pipeline, env } from '@xenova/transformers';
import { sobelEdges, dilate, boundedFloodFill, gaussianSmooth } from './edgeSnap';

// ── Transformers.js environment ───────────────────────────────────────────────
env.allowLocalModels = false;
env.useBrowserCache  = true;

const MODEL_ID = 'Xenova/segformer-b2-finetuned-ade-512-512';

// Labels that benefit from edge snap boundary refinement (large homogeneous planes)
const REFINE_LABELS = new Set(['wall', 'ceiling']);

// ── ADE20K → The Circle label mapping ────────────────────────────────────────
const ADE_TO_CIRCLE = {
  wall:      'wall',
  floor:     'floor',
  flooring:  'floor',
  ceiling:   'ceiling',
  door:      'door',
  'door-stuff': 'door',
  windowpane: 'window',
  window:    'window',
  table:     'furniture',
  chair:     'furniture',
  sofa:      'furniture',
  bed:       'furniture',
  desk:      'furniture',
  cabinet:   'furniture',
  shelf:     'furniture',
  armchair:  'furniture',
  wardrobe:  'furniture',
  bookcase:  'furniture',
  ottoman:   'furniture',
  bench:     'furniture',
};

// ─────────────────────────────────────────────────────────────────────────────

class RoomSegmenter {
  constructor() {
    this._pipe     = null;
    this._loading  = false;
    this._segments = new Map(); // circleLabel → { binary: Uint8Array, width, height }
  }

  isLoaded() { return this._pipe !== null; }

  async _init() {
    if (this._pipe) return;
    if (this._loading) {
      // Wait for the ongoing load
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (!this._loading) { clearInterval(check); resolve(); }
        }, 100);
      });
      return;
    }
    this._loading = true;
    try {
      this._pipe = await pipeline('image-segmentation', MODEL_ID, { quantized: true });
    } finally {
      this._loading = false;
    }
  }

  /**
   * Run SegFormer on the image, cache per-label binary masks.
   *
   * @param {string} imageUrl
   * @param {HTMLCanvasElement|null} imageCanvas  Room canvas for edge refinement (optional)
   * @returns {Promise<Map<string, {binary:Uint8Array, width:number, height:number}>>}
   */
  async analyzeRoom(imageUrl, imageCanvas = null) {
    await this._init();
    this._segments.clear();

    const results = await this._pipe(imageUrl);

    // Build offscreen canvas for edge refinement if not supplied
    let refCanvas = imageCanvas;
    if (!refCanvas) refCanvas = await _imageToCanvas(imageUrl);

    // Merge segments that share a The Circle label (OR union)
    const merged = new Map(); // circleLabel → { binary, w, h }
    for (const seg of results) {
      const circleLabel = ADE_TO_CIRCLE[seg.label.toLowerCase()];
      if (!circleLabel) continue;

      const { data, width, height } = seg.mask; // data: Uint8ClampedArray, 1-channel 0/255
      const binary = new Uint8Array(width * height);
      for (let i = 0; i < binary.length; i++) binary[i] = data[i] > 128 ? 1 : 0;

      if (merged.has(circleLabel)) {
        const existing = merged.get(circleLabel);
        for (let i = 0; i < binary.length; i++) {
          if (binary[i]) existing.binary[i] = 1;
        }
      } else {
        merged.set(circleLabel, { binary, w: width, h: height });
      }
    }

    // Apply edge snap refinement to wall / ceiling
    for (const [label, { binary, w, h }] of merged) {
      let finalBinary = binary;
      if (REFINE_LABELS.has(label) && refCanvas) {
        finalBinary = _refineMask(binary, refCanvas, w, h);
      }
      this._segments.set(label, { binary: finalBinary, width: w, height: h });
    }

    return this._segments;
  }

  /**
   * Return cached segment for a label, or null.
   * @param {string} label  e.g. 'wall', 'floor', 'ceiling', 'door', 'window', 'furniture'
   */
  getSegment(label) {
    return this._segments.get(label) || null;
  }

  /** Return all cached segments. */
  getAllSegments() {
    return Array.from(this._segments.entries()).map(([label, seg]) => ({ label, ...seg }));
  }

  /** Clear cached results (call on new image). */
  clear() { this._segments.clear(); }
}

// ── Edge snap refinement for binary mask ─────────────────────────────────────

/**
 * Refine a binary mask from SegFormer using edge-aware boundary snapping.
 * Reuses edgeSnap.js primitives (sobelEdges, dilate, boundedFloodFill, gaussianSmooth).
 *
 * @param {Uint8Array} binary
 * @param {HTMLCanvasElement} imageCanvas
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
function _refineMask(binary, imageCanvas, width, height) {
  // Get image pixels at mask resolution
  let pixels;
  if (imageCanvas.width === width && imageCanvas.height === height) {
    pixels = imageCanvas.getContext('2d').getImageData(0, 0, width, height).data;
  } else {
    const tmp = document.createElement('canvas');
    tmp.width  = width;
    tmp.height = height;
    tmp.getContext('2d').drawImage(imageCanvas, 0, 0, width, height);
    pixels = tmp.getContext('2d').getImageData(0, 0, width, height).data;
  }

  const edges    = sobelEdges(pixels, width, height);
  const expanded = dilate(binary, width, height, 15);   // search region

  // Centroid of the mask as flood fill seed
  let cx = 0, cy = 0, count = 0;
  for (let i = 0; i < binary.length; i++) {
    if (binary[i]) { cx += i % width; cy += (i / width) | 0; count++; }
  }
  if (count === 0) return binary; // empty mask — skip
  cx = (cx / count) | 0;
  cy = (cy / count) | 0;

  const filled = boundedFloodFill(cx, cy, edges, expanded, width, height);
  return gaussianSmooth(filled, width, height);
}

/** Load an image URL into an offscreen canvas. */
function _imageToCanvas(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas  = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

// ── Singleton export ──────────────────────────────────────────────────────────
export const roomSegmenter = new RoomSegmenter();
