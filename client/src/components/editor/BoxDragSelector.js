/**
 * BoxDragSelector — Drag to draw a bounding box for SAM box-prompt segmentation.
 *
 * Renders a transparent <canvas> above the image.  When boxMode is true it
 * captures pointer events and draws a real-time dashed rectangle; on pointer-up
 * the caller receives the box in display-canvas pixel space.
 *
 * Coordinate system:
 *   onBoxEnd receives { x_min, y_min, x_max, y_max } in display-canvas pixels.
 *   RoomCanvas converts these to original-image pixel space before calling SAM.
 *
 * Props:
 *   canvasSize  {w, h}   — display canvas dimensions
 *   zoom        number   — current zoom
 *   boxMode     boolean  — when false, renders null
 *   disabled    boolean  — block new boxes while SAM is running
 *   onBoxEnd    Function — ({ x_min, y_min, x_max, y_max }: canvas px) => void
 */

import React, { useRef, useCallback } from 'react';
import './BoxDragSelector.css';

// ─────────────────────────────────────────────────────────────────────────────

export default function BoxDragSelector({
  canvasSize,
  zoom,
  boxMode,
  disabled,
  onBoxEnd,
}) {
  const canvasRef    = useRef(null);
  const isDrawingRef = useRef(false);
  const originRef    = useRef({ x: 0, y: 0 });

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

  const redraw = useCallback((current) => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const o = originRef.current;
    const x = Math.min(o.x, current.x);
    const y = Math.min(o.y, current.y);
    const w = Math.abs(current.x - o.x);
    const h = Math.abs(current.y - o.y);

    ctx.save();
    // Semi-transparent fill
    ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
    ctx.fillRect(x, y, w, h);
    // Dashed border
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)';
    ctx.lineWidth   = 2;
    ctx.strokeRect(x, y, w, h);
    // Resize handles at corners
    const hs = 6; // handle half-size
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.9)';
    for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    }
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
    originRef.current = getXY(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [disabled, getXY]);

  const handlePointerMove = useCallback((e) => {
    if (!isDrawingRef.current) return;
    e.preventDefault();
    redraw(getXY(e));
  }, [getXY, redraw]);

  const finishBox = useCallback((e) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    const end = getXY(e);
    const o   = originRef.current;
    clearCanvas();

    const minW = 5;
    const minH = 5;
    if (Math.abs(end.x - o.x) > minW && Math.abs(end.y - o.y) > minH && !disabled) {
      onBoxEnd({
        x_min: Math.min(o.x, end.x),
        y_min: Math.min(o.y, end.y),
        x_max: Math.max(o.x, end.x),
        y_max: Math.max(o.y, end.y),
      });
    }
  }, [disabled, getXY, clearCanvas, onBoxEnd]);

  // ─────────────────────────────────────────────────────────────────────────
  if (!boxMode) return null;

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize.w}
      height={canvasSize.h}
      className="box-drag-overlay-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishBox}
      onPointerLeave={finishBox}
    />
  );
}
