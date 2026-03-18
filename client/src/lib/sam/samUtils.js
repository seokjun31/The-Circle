/**
 * samUtils — Pure utility functions for SAM ONNX inference in the browser.
 *
 * Pipeline:
 *   1. preprocessImage(el)          → { tensor, originalSize, modelSize }
 *   2. runEncoder(session, tensor)   → embedding Tensor [1,256,64,64]
 *   3. runDecoder(session, emb, ...) → masks Tensor [1,1,H,W]
 *   4. maskToImageData(mask, w, h)   → ImageData (blue overlay)
 *   5. maskToBinary(mask)            → Uint8Array (0/1 per pixel)
 *
 * SAM normalisation constants (ImageNet):
 *   mean = [123.675, 116.28,  103.53]
 *   std  = [ 58.395,  57.12,   57.375]
 */

import * as ort from 'onnxruntime-web';

export const SAM_SIZE = 1024; // Encoder input resolution

const PIXEL_MEAN = [123.675, 116.28, 103.53];
const PIXEL_STD  = [58.395,  57.12,  57.375];

// ── 1. Image pre-processing ───────────────────────────────────────────────────

/**
 * Resize & normalise an image element into a SAM encoder input tensor.
 *
 * The image is letterboxed (aspect ratio preserved) into a 1024×1024 canvas.
 * Pixels outside the image area are filled with ImageNet mean colour.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} imageEl
 * @returns {{ tensor: ort.Tensor, originalSize: [number,number], modelSize: [number,number] }}
 *   - originalSize: [origH, origW]
 *   - modelSize:    [scaledH, scaledW]  — content area inside the 1024 square
 */
export function preprocessImage(imageEl) {
  const origW = imageEl.naturalWidth  || imageEl.width;
  const origH = imageEl.naturalHeight || imageEl.height;

  // Letterbox: scale so the longer edge = SAM_SIZE
  const scale = SAM_SIZE / Math.max(origH, origW);
  const scaledW = Math.round(origW * scale);
  const scaledH = Math.round(origH * scale);

  const tmp = document.createElement('canvas');
  tmp.width  = SAM_SIZE;
  tmp.height = SAM_SIZE;
  const ctx = tmp.getContext('2d');

  // Fill with mean colour (R≈124 G≈116 B≈104)
  ctx.fillStyle = `rgb(${Math.round(PIXEL_MEAN[0])},${Math.round(PIXEL_MEAN[1])},${Math.round(PIXEL_MEAN[2])})`;
  ctx.fillRect(0, 0, SAM_SIZE, SAM_SIZE);

  // Draw image top-left aligned (padding is bottom / right)
  ctx.drawImage(imageEl, 0, 0, scaledW, scaledH);

  const { data } = ctx.getImageData(0, 0, SAM_SIZE, SAM_SIZE);
  const n = SAM_SIZE * SAM_SIZE;
  const float32 = new Float32Array(3 * n);

  // HWC → CHW + normalise
  for (let i = 0; i < n; i++) {
    float32[0 * n + i] = (data[i * 4 + 0] - PIXEL_MEAN[0]) / PIXEL_STD[0];
    float32[1 * n + i] = (data[i * 4 + 1] - PIXEL_MEAN[1]) / PIXEL_STD[1];
    float32[2 * n + i] = (data[i * 4 + 2] - PIXEL_MEAN[2]) / PIXEL_STD[2];
  }

  return {
    tensor: new ort.Tensor('float32', float32, [1, 3, SAM_SIZE, SAM_SIZE]),
    originalSize: [origH, origW],
    modelSize: [scaledH, scaledW],
  };
}

// ── 2. Encoder ────────────────────────────────────────────────────────────────

/**
 * Run the SAM image encoder.
 *
 * @param {import('onnxruntime-web').InferenceSession} session - encoder ONNX session
 * @param {ort.Tensor} imageTensor - [1,3,1024,1024] float32
 * @returns {Promise<ort.Tensor>} image_embeddings [1,256,64,64]
 */
export async function runEncoder(session, imageTensor) {
  const inputName = session.inputNames[0];

  // vietanhdev/samexporter models use 'input_image' and expect rank 3 HWC [H,W,C].
  // Original SAM/dhkim2810 models use 'image' and expect rank 4 NCHW [1,C,H,W].
  let input = imageTensor;
  if (inputName === 'input_image' && imageTensor.dims.length === 4) {
    const [, C, H, W] = imageTensor.dims;
    const chw = imageTensor.data;
    // Transpose CHW → HWC
    const hwc = new Float32Array(H * W * C);
    for (let h = 0; h < H; h++) {
      for (let w = 0; w < W; w++) {
        for (let c = 0; c < C; c++) {
          hwc[h * W * C + w * C + c] = chw[c * H * W + h * W + w];
        }
      }
    }
    input = new ort.Tensor('float32', hwc, [H, W, C]);
  }

  const results = await session.run({ [inputName]: input });
  const outputName = session.outputNames[0];
  return results[outputName];
}

// ── 3. Decoder ────────────────────────────────────────────────────────────────

/**
 * Run the SAM mask decoder given an image embedding + click points.
 *
 * Point coordinates are in **original image pixels** (before any scaling).
 * They are converted internally to model (1024-space) coordinates.
 *
 * @param {import('onnxruntime-web').InferenceSession} session - decoder ONNX session
 * @param {ort.Tensor} embedding           - image_embeddings [1,256,64,64]
 * @param {Array<{x:number, y:number}>} points - click coords in original image pixels
 * @param {Array<number>} labels           - 1=foreground, 0=background (-1 for padding)
 * @param {[number,number]} originalSize   - [origH, origW]
 * @param {[number,number]} modelSize      - [scaledH, scaledW] from preprocessImage
 * @param {ort.Tensor|null} prevMaskTensor - low_res_masks from previous run (for refinement)
 * @returns {Promise<{masks: ort.Tensor, iouPredictions: ort.Tensor, lowResMasks: ort.Tensor}>}
 */
export async function runDecoder(
  session,
  embedding,
  points,
  labels,
  originalSize,
  modelSize,
  prevMaskTensor = null,
) {
  const [origH, origW] = originalSize;
  const [scaledH, scaledW] = modelSize;

  // Map original-image pixels → 1024-space coordinates
  const scaleX = scaledW / origW;
  const scaleY = scaledH / origH;

  const N = points.length;
  const coordsData = new Float32Array(N * 2);
  const labelsData  = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    coordsData[i * 2 + 0] = points[i].x * scaleX;
    coordsData[i * 2 + 1] = points[i].y * scaleY;
    labelsData[i] = labels[i];
  }

  const pointCoords  = new ort.Tensor('float32', coordsData,  [1, N, 2]);
  const pointLabels  = new ort.Tensor('float32', labelsData,  [1, N]);
  const maskInput    = prevMaskTensor
    ?? new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]);
  const hasMaskInput = new ort.Tensor('float32', new Float32Array([prevMaskTensor ? 1 : 0]), [1]);
  const origImSize   = new ort.Tensor('float32', new Float32Array([origH, origW]), [2]);

  const results = await session.run({
    image_embeddings: embedding,
    point_coords:     pointCoords,
    point_labels:     pointLabels,
    mask_input:       maskInput,
    has_mask_input:   hasMaskInput,
    orig_im_size:     origImSize,
  });

  return {
    masks:         results.masks,
    iouPredictions: results.iou_predictions,
    lowResMasks:   results.low_res_masks,
  };
}

// ── 4. Mask → ImageData ───────────────────────────────────────────────────────

/**
 * Convert a SAM masks tensor to an ImageData with a semi-transparent blue overlay
 * for selected pixels.
 *
 * @param {ort.Tensor} maskTensor - [1,1,H,W] float32
 * @param {number} width
 * @param {number} height
 * @returns {ImageData}
 */
export function maskToImageData(maskTensor, width, height) {
  const src  = maskTensor.data;
  const dest = new ImageData(width, height);
  const px   = dest.data;

  for (let i = 0; i < width * height; i++) {
    if (src[i] > 0) {
      px[i * 4 + 0] = 30;   // R
      px[i * 4 + 1] = 144;  // G
      px[i * 4 + 2] = 255;  // B
      px[i * 4 + 3] = 80;   // A ≈ 31% opacity
    }
    // else: transparent
  }

  return dest;
}

/**
 * Convert a SAM masks tensor to a binary Uint8Array (1 = selected, 0 = not).
 * Used as input for marching-ants contour drawing.
 *
 * @param {ort.Tensor} maskTensor - [1,1,H,W] float32
 * @returns {Uint8Array}
 */
export function maskToBinary(maskTensor) {
  const src  = maskTensor.data;
  const out  = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i] > 0 ? 1 : 0;
  }
  return out;
}

// ── 5. Multi-mask selection ───────────────────────────────────────────────────

/**
 * Pick the single best SAM mask by highest predicted IoU score.
 * (kept for backward-compat; prefer extractAllMasks for new code)
 *
 * @param {ort.Tensor} masks           - [1,K,H,W]
 * @param {ort.Tensor} iouPredictions  - [1,K]
 * @returns {ort.Tensor}               - [1,1,H,W] best mask
 */
export function selectBestMask(masks, iouPredictions) {
  const iouData = iouPredictions.data;
  let bestIdx = 0;
  for (let k = 1; k < iouData.length; k++) {
    if (iouData[k] > iouData[bestIdx]) bestIdx = k;
  }

  const [, , H, W] = masks.dims;
  const offset = bestIdx * H * W;
  const slice  = masks.data.slice(offset, offset + H * W);

  return new ort.Tensor('float32', slice, [1, 1, H, W]);
}

/**
 * Extract ALL mask candidates from SAM output.
 * Returns each as a separate [1,1,H,W] tensor so the caller can let the user
 * switch between them without re-running the decoder.
 *
 * @param {ort.Tensor} masks           - [1,K,H,W]
 * @param {ort.Tensor} iouPredictions  - [1,K]
 * @returns {{ masks: ort.Tensor[], scores: number[], bestIndex: number }}
 */
export function extractAllMasks(masks, iouPredictions) {
  const iouData = Array.from(iouPredictions.data);
  const [, K, H, W] = masks.dims;

  let bestIdx = 0;
  for (let k = 1; k < K; k++) {
    if (iouData[k] > iouData[bestIdx]) bestIdx = k;
  }

  const allMasks = [];
  for (let k = 0; k < K; k++) {
    const offset = k * H * W;
    const slice  = masks.data.slice(offset, offset + H * W);
    allMasks.push(new ort.Tensor('float32', slice, [1, 1, H, W]));
  }

  return { masks: allMasks, scores: iouData, bestIndex: bestIdx };
}

// ── 6. Brush path sampling ────────────────────────────────────────────────────

/**
 * Sample a brush stroke path using arc-length parameterisation.
 *
 * Unlike a simple distance-gate approach, this distributes the sampled points
 * evenly along the total path length, giving SAM a representative spread of
 * the stroke regardless of where the pointer slowed down or sped up.
 *
 * Point count guide (adaptive when maxPoints is omitted):
 *   arc-length  < 100 px  →  4 points  (tiny tap / dot)
 *   arc-length  < 300 px  →  6 points  (short stroke, single object)
 *   arc-length  < 600 px  →  8 points  (medium stroke, one wall face)
 *   arc-length  < 1000 px → 10 points  (long stroke, full floor)
 *   arc-length ≥ 1000 px  → 12 points  (hard cap — avoids over-segmentation)
 *
 * @param {Array<{x:number, y:number}>} brushPath  Raw pointer path
 * @param {number} [maxPoints]  Explicit cap; adaptive if omitted
 * @returns {Array<{x:number, y:number}>}
 */
export function samplePointsFromBrush(brushPath, maxPoints) {
  if (brushPath.length === 0) return [];
  if (brushPath.length === 1) return [brushPath[0]];

  // 1. Compute total arc length
  let totalLength = 0;
  for (let i = 1; i < brushPath.length; i++) {
    const dx = brushPath[i].x - brushPath[i - 1].x;
    const dy = brushPath[i].y - brushPath[i - 1].y;
    totalLength += Math.sqrt(dx * dx + dy * dy);
  }

  // 2. Determine maxPoints adaptively if not supplied
  if (maxPoints === undefined) {
    if      (totalLength <  100) maxPoints =  4;
    else if (totalLength <  300) maxPoints =  6;
    else if (totalLength <  600) maxPoints =  8;
    else if (totalLength < 1000) maxPoints = 10;
    else                         maxPoints = 12; // absolute cap
  }

  if (brushPath.length <= maxPoints) return brushPath;

  // 3. Arc-length parameterised sampling
  const sampled     = [brushPath[0]]; // always include start point
  const interval    = totalLength / (maxPoints - 1);
  let   accumulated = 0;

  for (let i = 1; i < brushPath.length && sampled.length < maxPoints - 1; i++) {
    const dx = brushPath[i].x - brushPath[i - 1].x;
    const dy = brushPath[i].y - brushPath[i - 1].y;
    accumulated += Math.sqrt(dx * dx + dy * dy);
    if (accumulated >= interval) {
      sampled.push(brushPath[i]);
      accumulated -= interval; // carry remainder for even spacing
    }
  }

  // 4. Always include end point
  const last = brushPath[brushPath.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);

  return sampled.slice(0, maxPoints);
}

// ── 7. Base64 embedding helpers (for server fallback) ────────────────────────

/**
 * Serialise an ONNX Tensor to a plain object that can be JSON-stringified.
 * Used to receive server-computed embeddings and reconstruct a Tensor.
 *
 * @param {{ data: string, dims: number[], type: string }} payload
 * @returns {ort.Tensor}
 */
export function embeddingFromBase64(payload) {
  const binary   = atob(payload.data);
  const bytes    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const float32  = new Float32Array(bytes.buffer);
  return new ort.Tensor('float32', float32, payload.dims);
}
