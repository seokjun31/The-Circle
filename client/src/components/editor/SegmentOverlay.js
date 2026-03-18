/**
 * SegmentOverlay — Canvas layer that renders SAM mask results as:
 *
 *   1. Semi-transparent blue fill  (selected area, 20% opacity)
 *   2. Animated marching-ants border (strokeDashOffset animation via rAF)
 *   3. Optional per-region colour coding when multiple masks are active
 *
 * Props:
 *   masks       {Array<{ binary: Uint8Array, label: string, color: string }>}
 *               Each entry has a binary Uint8Array (width×height, 0/1) plus metadata.
 *   width       {number}  canvas width  (matches parent image canvas)
 *   height      {number}  canvas height
 *   style       {object}  additional CSS styles
 */

import React, { useEffect, useRef, useCallback } from 'react';

// ── Marching-ants config ──────────────────────────────────────────────────────
const ANT_DASH         = 6;    // px on
const ANT_GAP          = 4;    // px off
const ANT_SPEED        = 0.3;  // offset increment per frame
const ANT_LINE_WIDTH   = 1.5;
const FILL_ALPHA       = 0.22; // full-mask fill opacity
const PREVIEW_ALPHA    = 0.10; // live-preview fill opacity (lighter, no ants)

// Default palette for multiple regions
const DEFAULT_COLORS = [
  '#1e90ff', // blue   (wall)
  '#22c55e', // green  (floor)
  '#f59e0b', // amber  (ceiling)
  '#ec4899', // pink   (custom)
];

// ─────────────────────────────────────────────────────────────────────────────

function SegmentOverlay({ masks = [], width, height, style }) {
  const canvasRef  = useRef(null);
  const rafRef     = useRef(null);
  const offsetRef  = useRef(0);

  // Pre-compute ImageData for each mask's fill layer
  const fillCacheRef = useRef([]);

  // ── Build fill ImageData whenever masks change ─────────────────────────────
  useEffect(() => {
    fillCacheRef.current = masks.map((m, idx) => {
      const color     = m.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
      const [r, g, b] = hexToRgb(color);
      const img       = new ImageData(width, height);
      const px        = img.data;
      // Preview masks render at reduced opacity so they're clearly "tentative".
      const alpha     = Math.round((m.preview ? PREVIEW_ALPHA : FILL_ALPHA) * 255);

      for (let i = 0; i < m.binary.length; i++) {
        if (m.binary[i]) {
          px[i * 4 + 0] = r;
          px[i * 4 + 1] = g;
          px[i * 4 + 2] = b;
          px[i * 4 + 3] = alpha;
        }
      }
      return img;
    });
  }, [masks, width, height]);

  // ── Animation loop ─────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    if (masks.length === 0) {
      rafRef.current = null;
      return;
    }

    offsetRef.current = (offsetRef.current + ANT_SPEED) % (ANT_DASH + ANT_GAP);

    masks.forEach((m, idx) => {
      const color = m.color || DEFAULT_COLORS[idx % DEFAULT_COLORS.length];

      // 1. Fill overlay (from pre-computed ImageData)
      if (fillCacheRef.current[idx]) {
        ctx.putImageData(fillCacheRef.current[idx], 0, 0);
      }

      // Preview masks: fill-only, no marching-ants, no label.
      // They are transient (shown during brush drag) and intentionally subtle.
      if (m.preview) return;

      // 2. Marching-ants contour
      const contourPath = buildContourPath(m.binary, width, height);
      if (contourPath.length === 0) return;

      ctx.save();
      ctx.strokeStyle    = color;
      ctx.lineWidth      = ANT_LINE_WIDTH;
      ctx.setLineDash([ANT_DASH, ANT_GAP]);
      ctx.lineDashOffset = -offsetRef.current;
      ctx.shadowColor    = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur     = 2;

      ctx.beginPath();
      contourPath.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x + 0.5, y + 0.5);
        else ctx.lineTo(x + 0.5, y + 0.5);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();

      // 3. Region label
      if (m.label) {
        const [cx, cy] = maskCentroid(m.binary, width, height);
        ctx.save();
        ctx.font         = 'bold 12px system-ui, sans-serif';
        ctx.fillStyle    = '#ffffff';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor  = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur   = 4;
        ctx.fillText(m.label, cx, cy);
        ctx.restore();
      }
    });

    rafRef.current = requestAnimationFrame(draw);
  }, [masks, width, height]);

  // ── Start / stop animation ─────────────────────────────────────────────────
  useEffect(() => {
    if (masks.length > 0) {
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(draw);
      }
    } else {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Clear canvas when no masks
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext('2d').clearRect(0, 0, width, height);
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [masks, draw, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        ...style,
      }}
    />
  );
}

export default React.memo(SegmentOverlay);

// ── Contour extraction (simple boundary tracing) ──────────────────────────────

/**
 * Extract the outer boundary pixels of a binary mask.
 * Returns an array of [x, y] pixel coordinates forming the contour,
 * suitable for Canvas Path2D / lineTo calls.
 *
 * Algorithm: scan each pixel; if it is selected (1) and any 4-neighbour is not,
 * it is a border pixel.  We collect these and sort them by (y, x) — sufficient
 * for the marching-ants stroke effect.
 *
 * @param {Uint8Array} binary - width×height, 0 or 1
 * @param {number} w
 * @param {number} h
 * @returns {Array<[number,number]>}
 */
function buildContourPath(binary, w, h) {
  const border = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!binary[i]) continue;

      // Check 4 neighbours
      const top    = y > 0     ? binary[(y - 1) * w + x] : 0;
      const bottom = y < h - 1 ? binary[(y + 1) * w + x] : 0;
      const left   = x > 0     ? binary[y * w + (x - 1)] : 0;
      const right  = x < w - 1 ? binary[y * w + (x + 1)] : 0;

      if (!top || !bottom || !left || !right) {
        border.push([x, y]);
      }
    }
  }

  if (border.length === 0) return [];

  // Simple chain: sort border pixels into approximate order by angle from centroid
  const [cx, cy] = maskCentroid(binary, w, h);
  border.sort(([ax, ay], [bx, by]) =>
    Math.atan2(ay - cy, ax - cx) - Math.atan2(by - cy, bx - cx)
  );

  return border;
}

/** Compute centroid of selected pixels. */
function maskCentroid(binary, w, h) {
  let sumX = 0, sumY = 0, count = 0;
  for (let i = 0; i < binary.length; i++) {
    if (binary[i]) {
      sumX += i % w;
      sumY += Math.floor(i / w);
      count++;
    }
  }
  if (count === 0) return [w / 2, h / 2];
  return [sumX / count, sumY / count];
}

/** Parse #rrggbb hex to [r, g, b]. */
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
