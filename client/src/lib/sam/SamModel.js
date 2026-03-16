/**
 * SamModel — ONNX Runtime Web session manager for SAM (Segment Anything Model).
 *
 * Two sessions are managed:
 *   encoder  — heavy (~40 MB). Runs once per image → image embedding [1,256,64,64]
 *   decoder  — light (~3.6 MB). Runs per click → mask [1,1,H,W]
 *
 * Execution providers tried in order: WebGL → WASM.
 * Call configureOrtPaths() early (before any session creation) to point ort to CDN WASM files.
 */

import * as ort from 'onnxruntime-web';

// ── CDN WASM paths (avoids webpack/CRA copy issues) ───────────────────────────
const ORT_VERSION = '1.17.3';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Model paths (served from public/)
const MODEL_BASE = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
export const ENCODER_MODEL_PATH = `${MODEL_BASE}/models/sam_encoder.onnx`;
export const DECODER_MODEL_PATH = `${MODEL_BASE}/models/sam_decoder.onnx`;

let ortConfigured = false;

/**
 * Point onnxruntime-web to CDN-hosted WASM binaries.
 * Must be called before the first InferenceSession.create().
 */
export function configureOrtPaths() {
  if (ortConfigured) return;
  ort.env.wasm.wasmPaths = CDN_BASE;
  // Disable multi-threaded WASM in CRA (SharedArrayBuffer restrictions)
  ort.env.wasm.numThreads = 1;
  ortConfigured = true;
}

// ─────────────────────────────────────────────────────────────────────────────

class SamModel {
  constructor() {
    /** @type {ort.InferenceSession|null} */
    this.encoderSession = null;
    /** @type {ort.InferenceSession|null} */
    this.decoderSession = null;
    this._encoderLoading = null; // Promise lock
    this._decoderLoading = null; // Promise lock
  }

  /**
   * Load (or return cached) encoder session.
   * Uses WebGL backend for GPU acceleration; falls back to WASM.
   *
   * @param {string} [modelPath]
   * @returns {Promise<ort.InferenceSession>}
   */
  async loadEncoder(modelPath = ENCODER_MODEL_PATH) {
    if (this.encoderSession) return this.encoderSession;
    if (this._encoderLoading) return this._encoderLoading;

    configureOrtPaths();

    this._encoderLoading = (async () => {
      const providers = this._supportsWebGL()
        ? ['webgl', 'wasm']
        : ['wasm'];

      this.encoderSession = await ort.InferenceSession.create(modelPath, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
      });
      return this.encoderSession;
    })();

    return this._encoderLoading;
  }

  /**
   * Load (or return cached) decoder session.
   * Decoder is WASM-only (small and fast enough; WebGL has limited int64 support).
   *
   * @param {string} [modelPath]
   * @returns {Promise<ort.InferenceSession>}
   */
  async loadDecoder(modelPath = DECODER_MODEL_PATH) {
    if (this.decoderSession) return this.decoderSession;
    if (this._decoderLoading) return this._decoderLoading;

    configureOrtPaths();

    this._decoderLoading = (async () => {
      this.decoderSession = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      return this.decoderSession;
    })();

    return this._decoderLoading;
  }

  /** True if both sessions are loaded. */
  isLoaded() {
    return !!this.encoderSession && !!this.decoderSession;
  }

  /** Release sessions (call when unmounting to free GPU memory). */
  dispose() {
    this.encoderSession = null;
    this.decoderSession = null;
    this._encoderLoading = null;
    this._decoderLoading = null;
  }

  /** Heuristic: check for WebGL support. */
  _supportsWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return !!(
        canvas.getContext('webgl2') || canvas.getContext('webgl')
      );
    } catch {
      return false;
    }
  }
}

// Singleton — shared across the whole React app
export const samModel = new SamModel();
