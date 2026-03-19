/**
 * ModelManager — Unified coordinator for browser AI models.
 *
 * Manages two Transformers.js models:
 *   1. SegFormer (Xenova/segformer-b2-finetuned-ade-512-512)
 *      → Runs once per image. Results cached for instant chat segment lookup.
 *   2. SAM     (Xenova/slimsam-77-uniform)
 *      → Lazy-loaded. Only initialised when user enters correction mode.
 *
 * Loading strategy:
 *   onImageUpload(url)         → runs SegFormer (15s timeout → graceful skip)
 *   prepareCorrection(imgEl)   → loads SAM + encodes image (lazy)
 *
 * IndexedDB caching is handled automatically by @xenova/transformers env.
 * Backend is chosen automatically: WebGPU > WebGL > WASM.
 *
 * Server fallback (TODO):
 *   If SegFormer times out, POST /api/v1/segment/semantic { image_url }
 *   returns cached segment masks from a Python SegFormer microservice.
 *   Currently stubs to a graceful skip.
 */

import { roomSegmenter } from '../segmentation/semanticSegmentation';
import { samSegmenter }  from '../sam/SamModel';

const SEG_TIMEOUT_MS = 15_000; // 15 s — skip SegFormer on slow devices

// ─────────────────────────────────────────────────────────────────────────────

class ModelManager {
  constructor() {
    this._segDone    = false;
    this._samLoaded  = false;
    this._samEncoded = false;
  }

  // ── Called when a new image is set (upload or project load) ─────────────────

  /**
   * Run SegFormer analysis in the background.
   * If device is too slow (>15 s), degrade gracefully — chat will still work
   * but the "이 영역을 변경할까요?" mask preview will be unavailable.
   *
   * @param {string} imageUrl
   * @param {HTMLCanvasElement|null} imageCanvas  Optional — for edge refinement
   */
  async onImageUpload(imageUrl, imageCanvas = null) {
    this._segDone    = false;
    this._samEncoded = false;
    roomSegmenter.clear();

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('seg_timeout')), SEG_TIMEOUT_MS)
    );

    try {
      await Promise.race([
        roomSegmenter.analyzeRoom(imageUrl, imageCanvas),
        timeout,
      ]);
      this._segDone = true;
    } catch (err) {
      if (err.message === 'seg_timeout') {
        console.warn(
          '[ModelManager] SegFormer exceeded 15s — segment overlay unavailable.\n' +
          'TODO: add server fallback POST /api/v1/segment/semantic'
        );
      } else {
        console.error('[ModelManager] SegFormer error:', err);
      }
    }
  }

  // ── Called when entering CorrectionMode (lazy SAM init) ─────────────────────

  /**
   * Load SAM and encode the current image.
   * Safe to call multiple times — skips if already done.
   *
   * @param {HTMLImageElement} imageElement
   * @returns {Promise<boolean>}
   */
  async prepareCorrection(imageElement) {
    if (this._samEncoded) return true;

    try {
      if (!this._samLoaded) {
        await samSegmenter.load();
        this._samLoaded = true;
      }
      if (imageElement && !samSegmenter.hasImage()) {
        await samSegmenter.encodeImage(imageElement);
        this._samEncoded = true;
      }
      return true;
    } catch (err) {
      console.error('[ModelManager] SAM initialisation failed:', err);
      return false;
    }
  }

  // ── Segment accessors (delegate to roomSegmenter) ────────────────────────────

  /** Whether SegFormer finished successfully. */
  hasSegments() {
    return this._segDone && roomSegmenter.getAllSegments().length > 0;
  }

  /**
   * @param {string} label  e.g. 'wall', 'floor', 'ceiling'
   * @returns {{ binary: Uint8Array, width: number, height: number } | null}
   */
  getSegment(label) {
    return roomSegmenter.getSegment(label);
  }

  /** All cached segments. */
  getAllSegments() {
    return roomSegmenter.getAllSegments();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export const modelManager = new ModelManager();
