/**
 * LassoSelector — Freehand lasso drawing overlay for SAM segmentation.
 *
 * Renders a transparent <canvas> that floats above the image.
 * When lassoMode is true it captures all pointer events and draws a
 * real-time dashed path; on pointer-up the path is closed and the
 * caller receives the canvas-pixel coordinates.
 *
 * Coordinate system:
 *   All points in onLassoEnd are in *display-canvas* pixel space
 *   (0..canvasSize.w, 0..canvasSize.h).  RoomCanvas converts these to
 *   original-image pixel space before calling lassoToSamInput / SAM.
 *
 * Props:
 *   canvasSize   {w, h}   — display canvas dimensions
 *   zoom         number   — current zoom (used to un-scale clientX/Y)
 *   lassoMode    boolean  — when false, renders null
 *   disabled     boolean  — block new strokes while SAM is running
 *   onLassoEnd   Function — (canvasPoints: [{x,y}]) => void
 */

import React, { useRef, useCallback } from 'react';
import './LassoSelector.css';

// Downsample a path to at most maxPts points while preserving start/end.
function simplifyPath(path, maxPts = 150) {
  if (path.length <= maxPts) return path;
  const step = Math.floor(path.length / maxPts);
  const out = [];
  for (let i = 0; i < path.length; i += step) out.push(path[i]);
  if (out[out.length - 1] !== path[path.length - 1]) {
    out.push(path[path.length - 1]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function LassoSelector({
  canvasSize,
  zoom,
  lassoMode,
  disabled,
  onLassoEnd,
}) {
  const canvasRef    = useRef(null);
  const isDrawingRef = useRef(false);
  const pathRef      = useRef([]);

  // ── Coordinate helper ─────────────────────────────────────────────────────

  const getXY = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top)  / zoom,
    };
  }, [zoom]);

  // ── Canvas drawing ────────────────────────────────────────────────────────

  /** Draw the open (in-progress) dashed path. */
  const redrawOpen = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const path = pathRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (path.length < 2) return;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)';
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();

    // Closing dashed line back to start
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.45)';
    ctx.beginPath();
    ctx.moveTo(path[path.length - 1].x, path[path.length - 1].y);
    ctx.lineTo(path[0].x, path[0].y);
    ctx.stroke();

    ctx.restore();
  }, []);

  /** Draw the closed (completed) filled shape. */
  const drawClosed = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const path = pathRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (path.length < 3) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.closePath();

    // Semi-transparent fill
    ctx.fillStyle = 'rgba(37, 99, 235, 0.22)';
    ctx.fill();

    // Solid stroke
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
    ctx.lineWidth   = 2;
    ctx.stroke();

    ctx.restore();
  }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  // ── Pointer events ────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e) => {
    if (disabled) return;
    e.preventDefault();
    isDrawingRef.current = true;
    pathRef.current = [getXY(e)];
    redrawOpen();
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [disabled, getXY, redrawOpen]);

  const handlePointerMove = useCallback((e) => {
    if (!isDrawingRef.current) return;
    e.preventDefault();
    pathRef.current.push(getXY(e));
    redrawOpen();
  }, [getXY, redrawOpen]);

  const finishLasso = useCallback(() => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    const raw = pathRef.current;
    pathRef.current = [];

    if (raw.length >= 3 && !disabled) {
      const simplified = simplifyPath(raw);
      drawClosed();
      // Brief flash of the closed shape, then clear
      setTimeout(clearCanvas, 500);
      onLassoEnd(simplified);
    } else {
      clearCanvas();
    }
  }, [disabled, drawClosed, clearCanvas, onLassoEnd]);

  const handlePointerLeave = useCallback(() => {
    if (isDrawingRef.current) finishLasso();
  }, [finishLasso]);

  // ─────────────────────────────────────────────────────────────────────────
  if (!lassoMode) return null;

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize.w}
      height={canvasSize.h}
      className="lasso-overlay-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishLasso}
      onPointerLeave={handlePointerLeave}
    />
  );
}
