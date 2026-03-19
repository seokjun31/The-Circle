/**
 * useSemanticSegmentation — React hook for SegFormer background room analysis.
 *
 * Triggered once per image URL (on editor mount or image change).
 * Results are cached in the singleton roomSegmenter; this hook only manages
 * the async state so the UI can show a loading indicator.
 *
 * Usage:
 *   const { isAnalyzing, segments, analyzeRoom } = useSemanticSegmentation();
 *   // trigger:
 *   await analyzeRoom(imageUrl, imageCanvas);  // imageCanvas is optional
 *
 *   // later (chat intent):
 *   const wallSegment = roomSegmenter.getSegment('wall');
 */

import { useCallback, useState } from 'react';
import { modelManager } from '../lib/ai/ModelManager';
import { roomSegmenter } from '../lib/segmentation/semanticSegmentation';

export function useSemanticSegmentation() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [segments,    setSegments]    = useState(null);
  const [error,       setError]       = useState(null);

  /**
   * Run SegFormer via ModelManager (15s timeout + graceful fallback).
   * @param {string} imageUrl
   * @param {HTMLCanvasElement|null} imageCanvas  Optional — for edge refinement
   */
  const analyzeRoom = useCallback(async (imageUrl, imageCanvas = null) => {
    if (!imageUrl) return null;
    setIsAnalyzing(true);
    setError(null);
    try {
      await modelManager.onImageUpload(imageUrl, imageCanvas);
      const result = roomSegmenter.getAllSegments();
      setSegments(result);
      return result;
    } catch (err) {
      console.error('[SemanticSeg] Analysis failed:', err);
      setError(err.message || '분석 실패');
      return null;
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  return { isAnalyzing, segments, error, analyzeRoom };
}
