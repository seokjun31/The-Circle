/**
 * BrushSelector — Scribble/brush input layer for SAM segmentation.
 *
 * Rendered as a transparent <canvas> that floats above the image.
 * In brush mode it intercepts all pointer events; when mode is off it
 * returns null so the normal hit-area click handler receives events.
 *
 * Workflow:
 *   1. User presses pointer → isDrawing = true
 *   2. Pointer moves        → path accumulates, stroke drawn on canvas
 *   3. Pointer up / leave   → path sampled → onStrokeEnd(canvasPoints, isExclude)
 *
 * Coordinate system:
 *   All points returned via onStrokeEnd are in *display-canvas* pixel space
 *   (0..canvasSize.w, 0..canvasSize.h).  RoomCanvas is responsible for
 *   converting these to original-image pixel space before calling SAM.
 *
 * Props:
 *   canvasSize      {w, h}    — display canvas dimensions
 *   zoom            number    — current zoom (used to un-scale clientX/Y)
 *   brushSize       number    — stroke width in display pixels (10–50)
 *   brushMode       boolean   — when false, component renders null
 *   disabled        boolean   — block new strokes while SAM is running
 *   onStrokeEnd     Function  — (canvasPoints:[{x,y}], isExclude:bool) => void
 *   onBrushPreview  Function? — optional, throttled preview during drag
 *                               (canvasPoints:[{x,y}], isExclude:bool) => void
 */

import React, { useRef, useCallback } from 'react';
import './BrushSelector.css';

// ── Path sampling constants ───────────────────────────────────────────────────
const MIN_SAMPLE_DIST    = 12; // minimum distance between sampled points (canvas px)
const MAX_POINTS         = 24; // max points sent to SAM per final stroke
const PREVIEW_MAX_POINTS = 6;  // fewer points for lightweight preview decodes
const PREVIEW_THROTTLE   = 200; // ms between throttled preview SAM calls

/**
 * Sample a raw pointer path to a manageable set of points for SAM.
 *
 * @param {Array<{x,y}>} path  Raw pointer path
 * @param {number} [maxPts]    Cap; defaults to MAX_POINTS (24)
 *
 * Steps:
 *   1. Distance-gate: skip points closer than MIN_SAMPLE_DIST to previous sample.
 *   2. Cap: if still too many, uniformly subsample down to maxPts.
 */
function sampleStrokePath(path, maxPts = MAX_POINTS) {
  if (path.length === 0) return [];

  // 1. Distance-based deduplication
  const kept = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const prev = kept[kept.length - 1];
    const dx   = path[i].x - prev.x;
    const dy   = path[i].y - prev.y;
    if (Math.sqrt(dx * dx + dy * dy) >= MIN_SAMPLE_DIST) {
      kept.push(path[i]);
    }
  }

  if (kept.length <= maxPts) return kept;

  // 2. Uniform subsample
  const result = [];
  const step   = (kept.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) {
    result.push(kept[Math.round(i * step)]);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function BrushSelector({
  canvasSize,
  zoom,
  brushSize,
  brushMode,
  disabled,
  onStrokeEnd,
  onBrushPreview,   // optional throttled preview callback
}) {
  const canvasRef        = useRef(null);
  const isDrawingRef     = useRef(false);
  const isExcludeRef     = useRef(false);
  const pathRef          = useRef([]);         // raw pointer path (canvas px)
  const lastPreviewRef   = useRef(0);          // timestamp of last preview call

  // ── Coordinate helper ─────────────────────────────────────────────────────

  /** Convert a PointerEvent to canvas-pixel coordinates (unscaled by zoom). */
  const getXY = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect(); // already accounts for CSS transform
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top)  / zoom,
    };
  }, [zoom]);

  // ── Canvas rendering ──────────────────────────────────────────────────────

  /** Redraw the brush stroke preview + optional cursor circle. */
  const redraw = useCallback((cursorX, cursorY) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const path      = pathRef.current;
    const exclude   = isExcludeRef.current;
    const fillColor   = exclude ? 'rgba(239,68,68,0.35)'  : 'rgba(37,99,235,0.35)';
    const cursorColor = exclude ? 'rgba(239,68,68,0.8)'   : 'rgba(37,99,235,0.8)';

    // Draw accumulated stroke
    if (path.length >= 2) {
      ctx.save();
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.lineWidth   = brushSize;
      ctx.strokeStyle = fillColor;
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.stroke();
      ctx.restore();
    } else if (path.length === 1) {
      ctx.beginPath();
      ctx.arc(path[0].x, path[0].y, brushSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
    }

    // Cursor ring (dashed circle showing brush radius)
    if (cursorX !== undefined) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cursorX, cursorY, brushSize / 2, 0, Math.PI * 2);
      ctx.strokeStyle = cursorColor;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      // small cross-hair centre dot
      ctx.beginPath();
      ctx.arc(cursorX, cursorY, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = cursorColor;
      ctx.fill();
      ctx.restore();
    }
  }, [brushSize]);

  /** Wipe the brush canvas entirely. */
  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  // ── Pointer event handlers ────────────────────────────────────────────────

  const handlePointerDown = useCallback((e) => {
    if (disabled) return;
    e.preventDefault();
    // Right-click OR Alt+click → exclude (label=0)
    isExcludeRef.current = e.button === 2 || e.altKey;
    isDrawingRef.current = true;
    const pt = getXY(e);
    pathRef.current = [pt];
    redraw(pt.x, pt.y);
    // Capture so we keep getting moves even if pointer leaves canvas
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [disabled, getXY, redraw]);

  const handlePointerMove = useCallback((e) => {
    const pt = getXY(e);
    if (!isDrawingRef.current) {
      // Not drawing — just update the cursor ring
      redraw(pt.x, pt.y);
      return;
    }
    e.preventDefault();
    pathRef.current.push(pt);
    redraw(pt.x, pt.y);

    // Throttled live preview: sample with fewer points and call back.
    // This gives real-time mask feedback without hammering the SAM decoder.
    if (onBrushPreview && !disabled) {
      const now = Date.now();
      if (now - lastPreviewRef.current >= PREVIEW_THROTTLE) {
        lastPreviewRef.current = now;
        const sampled = sampleStrokePath(pathRef.current, PREVIEW_MAX_POINTS);
        if (sampled.length > 0) {
          onBrushPreview(sampled, isExcludeRef.current);
        }
      }
    }
  }, [getXY, redraw, onBrushPreview, disabled]);

  const finishStroke = useCallback((e) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    const sampled = sampleStrokePath(pathRef.current);
    pathRef.current = [];
    clearCanvas();

    if (sampled.length > 0 && !disabled) {
      onStrokeEnd(sampled, isExcludeRef.current);
    }
  }, [disabled, clearCanvas, onStrokeEnd]);

  const handlePointerLeave = useCallback((e) => {
    if (isDrawingRef.current) {
      finishStroke(e);
    } else {
      // Just clear the cursor ring when hovering out
      clearCanvas();
    }
  }, [finishStroke, clearCanvas]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault(); // suppress browser context menu on right-drag
  }, []);

  // When brush mode is off, render nothing (hit area resumes control)
  if (!brushMode) return null;

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize.w}
      height={canvasSize.h}
      className="brush-overlay-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishStroke}
      onPointerLeave={handlePointerLeave}
      onContextMenu={handleContextMenu}
    />
  );
}
