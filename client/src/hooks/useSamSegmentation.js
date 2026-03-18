/**
 * useSamSegmentation — React hook for Transformers.js SAM segmentation.
 *
 * Provides the same external interface as the previous ONNX-direct version;
 * all callers (RoomCanvas, segmentRouter) work without modification.
 *
 * Backend: samSegmenter (SamModel.js) — Xenova/slimsam-77-uniform via
 * @xenova/transformers with automatic WebGPU / WebGL / WASM backend selection
 * and IndexedDB model caching.
 *
 * State exposed:
 *   isModelLoading  — initial model download (HuggingFace Hub / IndexedDB)
 *   isEncoding      — vision encoder running
 *   isSegmenting    — mask decoder running
 *   error           — last error message (string | null)
 *   clearError()
 *
 * Server fallback:
 *   If browser encoding exceeds ENCODER_TIMEOUT_MS (10 s), the image is sent
 *   to POST /api/v1/segment/encode which runs Python SAM on the server and
 *   returns the float32 image_embeddings as base64.  The decoder still runs
 *   in the browser (~50–200 ms), same as before.
 */

import { useCallback, useRef, useState } from 'react';
import api                   from '../utils/api';
import { samSegmenter }      from '../lib/sam/SamModel';
import { embeddingFromBase64 } from '../lib/sam/samUtils';

const ENCODER_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

export function useSamSegmentation() {
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [isEncoding,     setIsEncoding]     = useState(false);
  const [isSegmenting,   setIsSegmenting]   = useState(false);
  const [error,          setError]          = useState(null);

  // Concurrency control
  const requestIdRef  = useRef(0);
  const isDecodingRef = useRef(false);

  // Kept for server fallback (needed by injectEmbedding)
  const imageElementRef = useRef(null);

  const clearError = useCallback(() => setError(null), []);

  // ── initModel ─────────────────────────────────────────────────────────────

  const initModel = useCallback(async () => {
    if (samSegmenter.isLoaded()) return true;
    setIsModelLoading(true);
    setError(null);
    try {
      await samSegmenter.load();
      return true;
    } catch (err) {
      console.error('[SAM] Model load failed:', err);
      setError('SAM 모델 로드에 실패했습니다. 네트워크를 확인해주세요.');
      return false;
    } finally {
      setIsModelLoading(false);
    }
  }, []);

  // ── encodeImage ───────────────────────────────────────────────────────────

  const encodeImage = useCallback(async (imageElement) => {
    setIsEncoding(true);
    setError(null);
    imageElementRef.current = imageElement; // keep for fallback inject

    try {
      // Try browser-side encoder with a 10-second timeout
      const ok = await Promise.race([
        samSegmenter.encodeImage(imageElement).then(() => true),
        new Promise(resolve => setTimeout(() => resolve(null), ENCODER_TIMEOUT_MS)),
      ]);

      if (ok) return true;

      // Timed out — use server-computed embedding
      console.warn('[SAM] Browser encoder timed out — using server fallback');
      await _serverEncodeAndInject(imageElement);
      return true;
    } catch (err) {
      console.error('[SAM] encodeImage failed:', err);
      setError('이미지 분석에 실패했습니다.');
      return false;
    } finally {
      setIsEncoding(false);
    }
  }, []);

  // ── segmentMultiPoint ─────────────────────────────────────────────────────

  /**
   * Decode a mask for multiple click / lasso-derived points.
   *
   * Returns ALL mask candidates so the caller can offer small/auto/large
   * switching via MaskSizeSelector without re-running inference.
   *
   * @param {Array<{x:number,y:number}>} points  Original-image pixel coords
   * @param {number[]} labels                    1=fg, 0=bg, 2=box-tl, 3=box-br
   * @returns {Promise<{ masks, scores, bestIndex } | null>}
   */
  const segmentMultiPoint = useCallback(async (points, labels) => {
    if (!samSegmenter.hasImage()) {
      setError('먼저 이미지를 분석해주세요.');
      return null;
    }

    const myId = ++requestIdRef.current;
    isDecodingRef.current = true;
    setIsSegmenting(true);
    setError(null);

    try {
      const { pred_masks, iou_scores } = await samSegmenter.decode(points, labels);

      if (myId !== requestIdRef.current) return null; // stale

      const result = await samSegmenter.postProcess(pred_masks, iou_scores);

      if (myId !== requestIdRef.current) return null;

      return result;
    } catch (err) {
      if (myId === requestIdRef.current) {
        console.error('[SAM] segmentMultiPoint failed:', err);
        setError('마스크 생성에 실패했습니다.');
      }
      return null;
    } finally {
      if (myId === requestIdRef.current) {
        setIsSegmenting(false);
        isDecodingRef.current = false;
      }
    }
  }, []);

  // ── segment (single point) ────────────────────────────────────────────────

  const segment = useCallback(
    (point, label) => segmentMultiPoint([point], [label]),
    [segmentMultiPoint],
  );

  // ── segmentPreview (brush drag — no state changes) ────────────────────────

  /**
   * Lightweight decode for live brush preview.
   * Returns the best-mask tensor only; does not update React state.
   */
  const segmentPreview = useCallback(async (points, labels) => {
    if (!samSegmenter.hasImage() || isDecodingRef.current) return null;

    const myId = requestIdRef.current; // snapshot — do NOT increment

    try {
      const { pred_masks, iou_scores } = await samSegmenter.decode(points, labels);
      if (myId !== requestIdRef.current) return null;

      const result = await samSegmenter.postProcess(pred_masks, iou_scores);
      if (!result) return null;

      return result.masks[result.bestIndex]; // single best tensor
    } catch {
      return null; // preview failures are silent
    }
  }, []);

  // ── resetEncoding ─────────────────────────────────────────────────────────

  const resetEncoding = useCallback(() => {
    samSegmenter.clearImage();
    requestIdRef.current  = 0;
    isDecodingRef.current = false;
    imageElementRef.current = null;
  }, []);

  // ── clearPrevMask ─────────────────────────────────────────────────────────
  // Transformers.js does not expose chained low-res mask refinement through
  // its public API, so this is a no-op.  Brush strokes start fresh each time.
  const clearPrevMask = useCallback(() => {}, []);

  // ─────────────────────────────────────────────────────────────────────────
  return {
    initModel,
    encodeImage,
    segment,
    segmentMultiPoint,
    segmentPreview,
    resetEncoding,
    clearPrevMask,
    clearError,
    isModelLoading,
    isEncoding,
    isSegmenting,
    error,
  };
}

// ── Server-fallback helper ────────────────────────────────────────────────────

/**
 * Send the room image to the server for encoding and inject the returned
 * float32 embedding into samSegmenter.
 *
 * The server endpoint POST /api/v1/segment/encode is unchanged; it returns:
 *   { embedding: { data: <base64>, dims: [1,256,64,64], type: 'float32' } }
 */
async function _serverEncodeAndInject(imageElement) {
  const maxPx = 1024;
  const origW = imageElement.naturalWidth  || imageElement.width;
  const origH = imageElement.naturalHeight || imageElement.height;
  const scale = Math.min(1, maxPx / Math.max(origW, origH));

  const tmp = document.createElement('canvas');
  tmp.width  = Math.round(origW * scale);
  tmp.height = Math.round(origH * scale);
  tmp.getContext('2d').drawImage(imageElement, 0, 0, tmp.width, tmp.height);
  const base64 = tmp.toDataURL('image/jpeg', 0.85).split(',')[1];

  const { data } = await api.post('/v1/segment/encode', { image_base64: base64 });

  // embeddingFromBase64 now returns { data: Float32Array, dims } (no ort.Tensor)
  const emb = embeddingFromBase64(data.embedding);
  await samSegmenter.injectEmbedding(emb.data, emb.dims, imageElement);
}
