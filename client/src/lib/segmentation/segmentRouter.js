/**
 * segmentRouter — Selects the best segmentation algorithm for each label.
 *
 * Routing rules (fully transparent to the user — same lasso/box UX):
 *
 *   door / window / floor  →  SAM hybrid     (objects with clear boundaries)
 *   wall  / ceiling        →  Edge snap       (homogeneous planes — SAM struggles)
 *   molding / custom       →  SAM first, then edge snap if selected area < 5 %
 *
 * Always returns the same { masks, scores, bestIndex } shape as
 * useSamSegmentation.segmentMultiPoint(), so RoomCanvas requires no
 * conditional branching in its render or confirm logic.
 */

import * as ort       from 'onnxruntime-web';
import { edgeSnapMask } from './edgeSnap';

// ── Label routing sets ────────────────────────────────────────────────────────

/** Labels that SAM handles best — discrete objects with strong boundaries. */
const SAM_LABELS  = new Set(['door', 'window', 'floor']);

/** Labels where SAM under-performs — large homogeneous planes. */
const EDGE_LABELS = new Set(['wall', 'ceiling']);

/** Minimum selected-area fraction for SAM result to be accepted (molding/custom). */
const SAM_MIN_AREA = 0.05; // 5 %

// ── Helper: wrap binary mask as a Tensor-based mask set ───────────────────────

/**
 * Wrap a plain Uint8Array binary mask (0/1, canvasSize dimensions) as the
 * { masks: Tensor[], scores: number[], bestIndex: number } shape expected by
 * RoomCanvas / MaskSizeSelector / tensorToBinaryProcessed.
 *
 * The tensor has dims [1, 1, h, w] and float32 values 0.0 or 1.0 — identical
 * to the SAM decoder output that tensorToBinaryProcessed already handles.
 *
 * @param {Uint8Array} binary
 * @param {{w:number, h:number}} canvasSize
 * @returns {{ masks: ort.Tensor[], scores: number[], bestIndex: number }}
 */
function binaryToMaskSet(binary, canvasSize) {
  const { w, h } = canvasSize;
  const float32  = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) float32[i] = binary[i];
  const tensor = new ort.Tensor('float32', float32, [1, 1, h, w]);
  return { masks: [tensor], scores: [1.0], bestIndex: 0 };
}

/**
 * Compute the fraction of selected pixels in the best SAM mask candidate.
 *
 * @param {{ masks: ort.Tensor[], bestIndex: number }} maskSet
 * @returns {number}  0.0 – 1.0
 */
function bestMaskAreaRatio(maskSet) {
  const data = maskSet.masks[maskSet.bestIndex].data;
  let selected = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > 0) selected++;
  return selected / data.length;
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Route a user's lasso / box selection to the correct segmentation backend.
 *
 * @param {{
 *   label:              string,
 *   canvasPoints:       Array<{x:number,y:number}>,  // raw lasso / box path (canvas px)
 *   samInputPoints:     Array<{x:number,y:number}>,  // decoder points (original image px)
 *   samInputLabels:     number[],                    // SAM point labels (0/1/2/3)
 *   segmentMultiPoint:  Function,                    // from useSamSegmentation hook
 *   imageCanvas:        HTMLCanvasElement,            // room photo drawn at canvasSize
 *   canvasSize:         {w:number, h:number},
 * }} params
 *
 * @returns {Promise<{ masks: ort.Tensor[], scores: number[], bestIndex: number } | null>}
 *   null when SAM call was superseded (stale discard) and edge snap was not used.
 */
export async function segmentByLabel({
  label,
  canvasPoints,
  samInputPoints,
  samInputLabels,
  segmentMultiPoint,
  imageCanvas,
  canvasSize,
}) {
  // ── Object labels: use SAM hybrid (box + pos/neg points) ─────────────────
  if (SAM_LABELS.has(label)) {
    return segmentMultiPoint(samInputPoints, samInputLabels);
  }

  // ── Plane labels: skip SAM, go straight to edge snap ─────────────────────
  if (EDGE_LABELS.has(label)) {
    if (!imageCanvas) return segmentMultiPoint(samInputPoints, samInputLabels); // safety fallback
    const binary = edgeSnapMask(imageCanvas, canvasPoints, canvasSize);
    return binaryToMaskSet(binary, canvasSize);
  }

  // ── Molding / custom: SAM first, edge snap fallback ───────────────────────
  const samResult = await segmentMultiPoint(samInputPoints, samInputLabels);

  if (samResult && bestMaskAreaRatio(samResult) >= SAM_MIN_AREA) {
    return samResult; // SAM produced a meaningful result
  }

  // SAM returned null (stale) or tiny area — fall back to edge snap
  console.debug(
    '[segmentRouter] SAM area < %d% for "%s" → edge snap',
    SAM_MIN_AREA * 100, label,
  );
  if (!imageCanvas) return samResult; // safety: no canvas available
  const binary = edgeSnapMask(imageCanvas, canvasPoints, canvasSize);
  return binaryToMaskSet(binary, canvasSize);
}
