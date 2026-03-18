/**
 * samUtils — Browser-side mask utility functions.
 *
 * All ONNX-specific helpers (preprocessImage, runEncoder, runDecoder,
 * selectBestMask, extractAllMasks) have been removed.  Encoding and decoding
 * are now handled by samSegmenter (SamModel.js) via @xenova/transformers.
 *
 * Remaining exports:
 *   maskToImageData      – SAM tensor → blue overlay ImageData
 *   maskToBinary         – SAM tensor → Uint8Array (0/1)
 *   binaryToPng          – Uint8Array → PNG Blob  (for server upload)
 *   samplePointsFromBrush – arc-length brush stroke sampling
 *   embeddingFromBase64  – deserialise server embedding → { data, dims }
 */

// ── 1. Mask → ImageData (blue overlay) ───────────────────────────────────────

/**
 * Convert a mask tensor (duck-typed { data, dims }) to a semi-transparent
 * blue ImageData overlay for selected pixels.
 *
 * Compatible with both Transformers.js tensors and plain { data, dims } objects.
 *
 * @param {{ data: ArrayLike<number>, dims: number[] }} maskTensor
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
      px[i * 4 + 3] = 80;   // A ≈ 31 % opacity
    }
    // else: transparent
  }

  return dest;
}

// ── 2. Mask → binary Uint8Array ───────────────────────────────────────────────

/**
 * Convert a mask tensor to a binary Uint8Array (1 = selected, 0 = not).
 * Used as input for marching-ants contour drawing.
 *
 * @param {{ data: ArrayLike<number> }} maskTensor
 * @returns {Uint8Array}
 */
export function maskToBinary(maskTensor) {
  const src = maskTensor.data;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i] > 0 ? 1 : 0;
  }
  return out;
}

// ── 3. Binary mask → PNG Blob ─────────────────────────────────────────────────

/**
 * Convert a binary Uint8Array mask to a PNG Blob for server upload.
 * Selected pixels (1) → white (255,255,255), background (0) → black (0,0,0).
 *
 * @param {Uint8Array} binary  Row-major 0/1 mask, width × height elements
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Blob>}  PNG blob, resolves via canvas.toBlob
 */
export function binaryToPng(binary, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx  = canvas.getContext('2d');
  const img  = ctx.createImageData(width, height);
  const data = img.data;
  for (let i = 0; i < binary.length; i++) {
    const v = binary[i] ? 255 : 0;
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// ── 4. Brush path sampling ────────────────────────────────────────────────────

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
    else                         maxPoints = 12;
  }

  if (brushPath.length <= maxPoints) return brushPath;

  // 3. Arc-length parameterised sampling
  const sampled     = [brushPath[0]];
  const interval    = totalLength / (maxPoints - 1);
  let   accumulated = 0;

  for (let i = 1; i < brushPath.length && sampled.length < maxPoints - 1; i++) {
    const dx = brushPath[i].x - brushPath[i - 1].x;
    const dy = brushPath[i].y - brushPath[i - 1].y;
    accumulated += Math.sqrt(dx * dx + dy * dy);
    if (accumulated >= interval) {
      sampled.push(brushPath[i]);
      accumulated -= interval;
    }
  }

  // 4. Always include end point
  const last = brushPath[brushPath.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);

  return sampled.slice(0, maxPoints);
}

// ── 5. Server embedding deserialisation ──────────────────────────────────────

/**
 * Deserialise a server-computed image embedding from base64.
 *
 * Returns a plain { data: Float32Array, dims } object (duck-typed tensor).
 * Used by useSamSegmentation._serverEncodeAndInject() to feed into
 * samSegmenter.injectEmbedding().
 *
 * @param {{ data: string, dims: number[], type: string }} payload
 * @returns {{ data: Float32Array, dims: number[] }}
 */
export function embeddingFromBase64(payload) {
  const binary = atob(payload.data);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { data: new Float32Array(bytes.buffer), dims: payload.dims };
}
