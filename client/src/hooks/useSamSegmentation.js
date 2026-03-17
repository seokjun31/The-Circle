/**
 * useSamSegmentation — React hook for client-side SAM segmentation.
 *
 * Workflow:
 *   1. initModel()       — lazy-loads encoder + decoder ONNX sessions (once)
 *   2. encodeImage(el)   — runs encoder → stores embedding in ref (once per image)
 *   3. segment(pt, lbl)  — runs decoder → returns mask (per click, ~50-100 ms)
 *   4. segmentMultiPoint — same, but with multiple points
 *
 * Mobile / low-end fallback:
 *   - If WebGL is absent OR encoding exceeds ENCODER_TIMEOUT_MS (10 s),
 *     the hook calls POST /api/v1/segment/encode (server-side encoder).
 *   - The decoder always runs in the browser (it's only ~3.6 MB).
 *
 * State exposed:
 *   isModelLoading  — initial ONNX session download
 *   isEncoding      — encoder running
 *   isSegmenting    — decoder running
 *   error           — last error message (string|null)
 *   clearError()
 */

import { useCallback, useRef, useState } from 'react';
import api from '../utils/api';
import { samModel } from '../lib/sam/SamModel';
import {
  preprocessImage,
  runEncoder,
  runDecoder,
  selectBestMask,
  embeddingFromBase64,
} from '../lib/sam/samUtils';

const ENCODER_TIMEOUT_MS = 10_000; // fall back to server if encoder > 10 s

// ─────────────────────────────────────────────────────────────────────────────

export function useSamSegmentation() {
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [isEncoding,     setIsEncoding]     = useState(false);
  const [isSegmenting,   setIsSegmenting]   = useState(false);
  const [error,          setError]          = useState(null);

  // Stable refs — never trigger re-renders
  const embeddingRef    = useRef(null);  // ort.Tensor [1,256,64,64]
  const originalSizeRef = useRef(null);  // [origH, origW]
  const modelSizeRef    = useRef(null);  // [scaledH, scaledW]
  const lowResMaskRef   = useRef(null);  // ort.Tensor for chained refinement
  const encodingLockRef = useRef(false); // prevent concurrent encoder runs

  const clearError = useCallback(() => setError(null), []);

  // ── initModel ─────────────────────────────────────────────────────────────

  /**
   * Load encoder + decoder sessions. Idempotent (safe to call multiple times).
   * Returns true if loaded successfully, false on error.
   */
  const initModel = useCallback(async () => {
    if (samModel.isLoaded()) return true;
    setIsModelLoading(true);
    setError(null);
    try {
      await Promise.all([
        samModel.loadEncoder(),
        samModel.loadDecoder(),
      ]);
      return true;
    } catch (err) {
      console.error('[SAM] Failed to load ONNX sessions:', err);
      setError('SAM 모델 로드에 실패했습니다. 네트워크를 확인해주세요.');
      return false;
    } finally {
      setIsModelLoading(false);
    }
  }, []);

  // ── encodeImage ───────────────────────────────────────────────────────────

  /**
   * Run the image encoder → cache embedding.
   * Falls back to server if encoder is slow or WebGL unavailable.
   *
   * @param {HTMLImageElement|HTMLCanvasElement} imageElement
   * @returns {Promise<boolean>} true on success
   */
  const encodeImage = useCallback(async (imageElement) => {
    // Prevent concurrent encoder runs (React Strict Mode fires effects twice)
    if (encodingLockRef.current) {
      console.warn('[SAM] encodeImage skipped — already running');
      return false;
    }
    encodingLockRef.current = true;
    setIsEncoding(true);
    setError(null);
    lowResMaskRef.current = null;

    try {
      const { tensor, originalSize, modelSize } = preprocessImage(imageElement);
      originalSizeRef.current = originalSize;
      modelSizeRef.current    = modelSize;

      // Try browser-side encoder with timeout guard
      const browserEmbedding = await _runEncoderWithTimeout(tensor);

      if (browserEmbedding) {
        embeddingRef.current = browserEmbedding;
      } else {
        // Fallback: send image to server, get embedding back
        console.warn('[SAM] Encoder timed out — using server fallback');
        embeddingRef.current = await _serverEncode(imageElement);
      }

      return true;
    } catch (err) {
      console.error('[SAM] encodeImage failed:', err);
      setError('이미지 분석에 실패했습니다.');
      return false;
    } finally {
      encodingLockRef.current = false;
      setIsEncoding(false);
    }
  }, []);

  // ── segment ───────────────────────────────────────────────────────────────

  /**
   * Run decoder for a single click point.
   *
   * @param {{ x: number, y: number }} point - click in original image pixels
   * @param {number} label - 1 = foreground, 0 = background
   * @returns {Promise<import('onnxruntime-web').Tensor|null>} best mask [1,1,H,W]
   */
  const segment = useCallback(async (point, label) => {
    return segmentMultiPoint([point], [label]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Run decoder for multiple click points simultaneously.
   *
   * @param {Array<{x:number,y:number}>} points
   * @param {Array<number>} labels
   * @returns {Promise<import('onnxruntime-web').Tensor|null>}
   */
  const segmentMultiPoint = useCallback(async (points, labels) => {
    if (!embeddingRef.current) {
      setError('먼저 이미지를 분석해주세요.');
      return null;
    }

    setIsSegmenting(true);
    try {
      const decoderSession = await samModel.loadDecoder();

      const { masks, iouPredictions, lowResMasks } = await runDecoder(
        decoderSession,
        embeddingRef.current,
        points,
        labels,
        originalSizeRef.current,
        modelSizeRef.current,
        lowResMaskRef.current,
      );

      // Cache low-res mask for next click (chained refinement)
      lowResMaskRef.current = lowResMasks;

      return selectBestMask(masks, iouPredictions);
    } catch (err) {
      console.error('[SAM] segmentMultiPoint failed:', err);
      setError('마스크 생성에 실패했습니다.');
      return null;
    } finally {
      setIsSegmenting(false);
    }
  }, []);

  // ── resetEncoding ─────────────────────────────────────────────────────────

  /** Clear cached embedding (call when switching images). */
  const resetEncoding = useCallback(() => {
    embeddingRef.current    = null;
    originalSizeRef.current = null;
    modelSizeRef.current    = null;
    lowResMaskRef.current   = null;
  }, []);

  // ── Internal helpers ──────────────────────────────────────────────────────

  return {
    initModel,
    encodeImage,
    segment,
    segmentMultiPoint,
    resetEncoding,
    clearError,
    isModelLoading,
    isEncoding,
    isSegmenting,
    error,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Run the browser-side encoder with a timeout.
 * Returns the embedding tensor, or null if it times out.
 */
async function _runEncoderWithTimeout(imageTensor) {
  const encoderSession = await samModel.loadEncoder();

  const encodingPromise = runEncoder(encoderSession, imageTensor);
  const timeoutPromise  = new Promise((resolve) =>
    setTimeout(() => resolve(null), ENCODER_TIMEOUT_MS)
  );

  return Promise.race([encodingPromise, timeoutPromise]);
}

/**
 * Server fallback: send image as base64 to POST /api/v1/segment/encode.
 * Returns the reconstructed embedding tensor.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} imageElement
 * @returns {Promise<import('onnxruntime-web').Tensor>}
 */
async function _serverEncode(imageElement) {
  // Convert image to base64 JPEG (resize to max 1024 px to reduce payload)
  const tmp    = document.createElement('canvas');
  const maxPx  = 1024;
  const origW  = imageElement.naturalWidth  || imageElement.width;
  const origH  = imageElement.naturalHeight || imageElement.height;
  const scale  = Math.min(1, maxPx / Math.max(origW, origH));
  tmp.width    = Math.round(origW * scale);
  tmp.height   = Math.round(origH * scale);
  tmp.getContext('2d').drawImage(imageElement, 0, 0, tmp.width, tmp.height);
  const base64 = tmp.toDataURL('image/jpeg', 0.85).split(',')[1];

  const { data } = await api.post('/v1/segment/encode', { image_base64: base64 });
  return embeddingFromBase64(data.embedding);
}
