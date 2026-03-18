/**
 * SamSegmenter — Transformers.js wrapper for SAM browser inference.
 *
 * Replaces the hand-crafted ONNX Runtime Web pipeline (manual letterboxing,
 * normalisation, CHW transpose, decoder tensor wrangling) with
 * @xenova/transformers, which provides:
 *
 *   AutoProcessor  → image resize + normalise + coordinate scaling (auto)
 *   SamModel       → encoder + decoder in one unified API
 *   post_process_masks → upsample decoder output → original image resolution
 *   IndexedDB cache → model weights cached after first download (~77 MB once)
 *   Backend auto   → WebGPU > WebGL > WASM (best available at runtime)
 *
 * Model: Xenova/slimsam-77-uniform
 *   SlimSAM-77 is a 100× compressed SAM variant (5.5 M params vs 637 M).
 *   Quality is ~3 % below full SAM on COCO, but runs comfortably in the browser.
 *
 * Interface (matches previous ONNX SamModel):
 *   samSegmenter.load()               — one-time model download + init
 *   samSegmenter.encodeImage(el)      — per-image (~1–3 s with WebGL/WASM)
 *   samSegmenter.decode(pts, labels)  — per-click/lasso (~50–200 ms)
 *   samSegmenter.postProcess(...)     — → { masks, scores, bestIndex }
 *   samSegmenter.clearImage()         — on image change
 */

import { SamModel, AutoProcessor, RawImage, Tensor, env } from '@xenova/transformers';

// ── Transformers.js environment ───────────────────────────────────────────────
// Use HuggingFace Hub CDN; model weights are cached in IndexedDB automatically.
env.allowLocalModels = false;
env.useBrowserCache  = true;

const MODEL_ID = 'Xenova/slimsam-77-uniform';

// image_positional_embeddings are derived from model weights (not image content)
// and are identical for every image.  Cache after first encode for the
// server-fallback inject path.
let _cachedPositionalEmbeddings = null;

// ─────────────────────────────────────────────────────────────────────────────

class SamSegmenter {
  constructor() {
    this._loadPromise = null;
    this._model       = null;
    this._processor   = null;

    // Per-image state
    this._rawImage        = null;
    this._imageEmbeddings = null;  // { image_embeddings, image_positional_embeddings }
    this._originalSizes   = null;  // [[origH, origW]]
    this._reshapedSizes   = null;  // [[scaledH, scaledW]]
  }

  isLoaded() { return this._model !== null; }
  hasImage()  { return this._imageEmbeddings !== null; }

  // ── Load model + processor (idempotent, IndexedDB-cached) ────────────────

  async load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = Promise.all([
      SamModel.from_pretrained(MODEL_ID, { dtype: 'fp32' }),
      AutoProcessor.from_pretrained(MODEL_ID),
    ]).then(([model, processor]) => {
      this._model     = model;
      this._processor = processor;
    }).catch(err => {
      this._loadPromise = null; // allow retry on error
      throw err;
    });
    return this._loadPromise;
  }

  // ── Encode image (per upload, ~1–3 s) ────────────────────────────────────

  async encodeImage(imageElement) {
    if (!this._model) throw new Error('Call load() first');

    // DOM element → RawImage (needed by AutoProcessor)
    const W   = imageElement.naturalWidth  || imageElement.width;
    const H   = imageElement.naturalHeight || imageElement.height;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d').drawImage(imageElement, 0, 0);
    this._rawImage = await RawImage.fromURL(tmp.toDataURL('image/jpeg', 0.92));

    // Image-only processor pass: resize + normalise (no GPU)
    const image_inputs = await this._processor(this._rawImage);

    // Cache size metadata used by every post_process_masks call
    this._originalSizes = image_inputs.original_sizes;
    this._reshapedSizes  = image_inputs.reshaped_input_sizes;

    // Vision encoder (~1–3 s, runs on WebGL/WASM)
    this._imageEmbeddings = await this._model.get_image_embeddings(image_inputs);

    // Cache positional embeddings once (constant across all images)
    if (!_cachedPositionalEmbeddings && this._imageEmbeddings.image_positional_embeddings) {
      _cachedPositionalEmbeddings = this._imageEmbeddings.image_positional_embeddings;
    }

    return true;
  }

  // ── Inject server-computed embedding (server-fallback path) ──────────────

  /**
   * Used when browser encoding exceeds ENCODER_TIMEOUT_MS.
   * The server encodes the image and returns the content embedding as float32.
   *
   * @param {Float32Array} float32Data  image_embeddings tensor data
   * @param {number[]}     dims         e.g. [1, 256, 64, 64]
   * @param {HTMLImageElement|HTMLCanvasElement} imageElement
   */
  async injectEmbedding(float32Data, dims, imageElement) {
    if (!this._model) throw new Error('Call load() first');

    const W   = imageElement.naturalWidth  || imageElement.width;
    const H   = imageElement.naturalHeight || imageElement.height;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d').drawImage(imageElement, 0, 0);
    this._rawImage = await RawImage.fromURL(tmp.toDataURL('image/jpeg', 0.92));

    // Derive size metadata without running the encoder
    const scale = 1024 / Math.max(H, W);
    this._originalSizes = [[H, W]];
    this._reshapedSizes  = [[Math.round(H * scale), Math.round(W * scale)]];

    this._imageEmbeddings = {
      image_embeddings: new Tensor('float32', float32Data, dims),
      // Use cached positional embeddings if available (from a prior browser encode).
      // null is acceptable: some Transformers.js builds compute it internally.
      image_positional_embeddings: _cachedPositionalEmbeddings ?? null,
    };
  }

  // ── Decode prompt (per lasso / click, ~50–200 ms) ────────────────────────

  /**
   * @param {Array<{x:number,y:number}>} points  Original-image pixel coords
   * @param {number[]} labels  1=fg, 0=bg, 2=box-tl, 3=box-br
   * @returns {Promise<{ pred_masks, iou_scores }>}
   */
  async decode(points, labels) {
    if (!this._imageEmbeddings) throw new Error('No embedding — call encodeImage() first');

    // Batch-wrap point arrays: [[[x0,y0],[x1,y1],...]] and [[l0,l1,...]]
    const prompt_inputs = await this._processor(
      this._rawImage,
      [points.map(p => [p.x, p.y])],
      [labels],
    );

    // Decoder with cached image embedding
    const outputs = await this._model({
      ...this._imageEmbeddings,
      input_points: prompt_inputs.input_points,
      input_labels: prompt_inputs.input_labels,
    });

    return { pred_masks: outputs.pred_masks, iou_scores: outputs.iou_scores };
  }

  // ── Post-process → { masks, scores, bestIndex } ──────────────────────────

  /**
   * Upsample low-res masks → original image resolution.
   *
   * Each mask in the result is a duck-typed tensor { data: Float32Array, dims }
   * with dims [1,1,H,W], fully compatible with tensorToBinaryProcessed().
   */
  async postProcess(pred_masks, iou_scores) {
    const processed = await this._processor.post_process_masks(
      pred_masks,
      this._originalSizes,
      this._reshapedSizes,
    );

    // processed[0] = masks for the single image in the batch.
    // Shape: [num_masks, H, W]  OR  [1, num_masks, H, W] (version-dependent)
    const mt   = processed[0];
    const dims = mt.dims;
    let K, H, W;

    if (dims.length === 3)      { [K, H, W]    = dims; }
    else if (dims.length === 4) { [, K, H, W]  = dims; }
    else throw new Error(`Unexpected pred_masks dims: ${JSON.stringify(dims)}`);

    const scores = Array.from(iou_scores.data);

    // Split into K individual { data, dims } tensors
    const masks = [];
    for (let k = 0; k < K; k++) {
      const offset  = k * H * W;
      const float32 = new Float32Array(H * W);
      for (let i = 0; i < H * W; i++) float32[i] = mt.data[offset + i] ? 1.0 : 0.0;
      masks.push({ data: float32, dims: [1, 1, H, W] });
    }

    let bestIndex = 0;
    for (let k = 1; k < scores.length; k++) {
      if (scores[k] > scores[bestIndex]) bestIndex = k;
    }

    return { masks, scores, bestIndex };
  }

  // ── Housekeeping ─────────────────────────────────────────────────────────

  clearImage() {
    this._rawImage        = null;
    this._imageEmbeddings = null;
    this._originalSizes   = null;
    this._reshapedSizes   = null;
  }
}

// Singleton shared across the whole React app
export const samSegmenter = new SamSegmenter();

// Backward-compat alias (BenchmarkPage and any external consumers)
export { samSegmenter as samModel };
