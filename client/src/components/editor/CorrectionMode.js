/**
 * CorrectionMode — Modal overlay for manual mask correction.
 *
 * Shown when user clicks "다시 선택" in the chat flow.
 *
 * Tools (2 only):
 *   [영역 선택]  — Click on a colored semantic segment overlay to pick it
 *   [올가미]     — Freehand lasso → SAM (door/window/floor) or edge snap (wall/ceiling)
 *   [포인트]     — Single click → SAM decoder
 *
 * Label-based routing:
 *   door / window / floor → SAM
 *   wall / ceiling        → edge snap
 *   other                 → SAM first, edge snap fallback
 *
 * Props:
 *   imageUrl      {string}
 *   initialLabel  {string}   Hint from chat intent (e.g. 'wall')
 *   onComplete    {Function} ({ binary, width, height, label }) → confirmed mask
 *   onCancel      {Function}
 */

import React, {
  useState, useRef, useEffect, useCallback,
} from 'react';
import SegmentOverlay from './SegmentOverlay';
import LassoSelector  from './LassoSelector';
import { useSamSegmentation } from '../../hooks/useSamSegmentation';
import { roomSegmenter } from '../../lib/segmentation/semanticSegmentation';
import { segmentByLabel } from '../../lib/segmentation/segmentRouter';
import { lassoToSamInput } from '../../lib/sam/lassoToSamInput';
import { maskToBinary, binaryToPng } from '../../lib/sam/samUtils';
import { cleanMask, fillHoles } from '../../lib/sam/maskPostProcess';
import './CorrectionMode.css';

const LABEL_KR = {
  wall: '벽', floor: '바닥', ceiling: '천장',
  door: '문', window: '창문', molding: '몰딩', furniture: '가구',
};

// Per-label colors for the segment overlay
const LABEL_COLORS = {
  wall:      '#1e90ff',
  floor:     '#22c55e',
  ceiling:   '#f59e0b',
  door:      '#ec4899',
  window:    '#06b6d4',
  molding:   '#a855f7',
  furniture: '#f97316',
};

// Rescale binary mask from src→dst dimensions
function rescaleBinary(binary, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return binary;
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.round(x * srcW / dstW), srcW - 1);
      const sy = Math.min(Math.round(y * srcH / dstH), srcH - 1);
      out[y * dstW + x] = binary[sy * srcW + sx];
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

function CorrectionMode({ imageUrl, initialLabel, onComplete, onCancel }) {
  const [activeTool, setActiveTool]     = useState('segment'); // 'segment' | 'lasso' | 'point'
  const [canvasSize, setCanvasSize]     = useState({ w: 0, h: 0 });
  const [selectedMask, setSelectedMask] = useState(null);  // { binary, width, height, label }
  const [selectedLabel, setSelectedLabel] = useState(initialLabel || null);

  const imageCanvasRef = useRef(null);
  const imageElRef     = useRef(null);
  const containerRef   = useRef(null);

  const {
    initModel, encodeImage,
    segmentMultiPoint, isSegmenting, isModelLoading,
  } = useSamSegmentation();

  // Cached segments from SegFormer (already analyzed)
  const allSegments = roomSegmenter.getAllSegments();

  // ── Load image + encode for SAM ────────────────────────────────────────────
  useEffect(() => {
    if (!imageUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      imageElRef.current = img;

      // Fit to container
      const maxW = containerRef.current?.clientWidth  || 800;
      const maxH = containerRef.current?.clientHeight || 600;
      const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = Math.round(img.naturalWidth  * scale);
      const h = Math.round(img.naturalHeight * scale);
      setCanvasSize({ w, h });

      // Draw image
      const canvas = imageCanvasRef.current;
      if (canvas) {
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      }

      // Encode for SAM
      const ok = await initModel();
      if (ok) await encodeImage(img);
    };
    img.src = imageUrl;
  }, [imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build overlay masks for all cached segments ────────────────────────────
  const overlayMasks = allSegments
    .filter((s) => s.binary && canvasSize.w > 0)
    .map((s) => ({
      binary: rescaleBinary(s.binary, s.width, s.height, canvasSize.w, canvasSize.h),
      label:  LABEL_KR[s.label] || s.label,
      color:  LABEL_COLORS[s.label] || '#888',
      _label: s.label,
    }));

  // Selected mask overlay (full opacity)
  const selectedOverlay = selectedMask ? [{
    binary: rescaleBinary(
      selectedMask.binary,
      selectedMask.width,
      selectedMask.height,
      canvasSize.w,
      canvasSize.h,
    ),
    label:  LABEL_KR[selectedMask.label] || selectedMask.label,
    color:  LABEL_COLORS[selectedMask.label] || '#4f46e5',
  }] : [];

  // ── Segment overlay click → select that segment ────────────────────────────
  const handleCanvasClick = useCallback((e) => {
    if (activeTool !== 'segment') return;
    const rect = imageCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = Math.round(e.clientX - rect.left);
    const cy = Math.round(e.clientY - rect.top);
    const idx = cy * canvasSize.w + cx;

    // Find which segment contains this pixel
    for (const seg of overlayMasks) {
      if (seg.binary[idx]) {
        setSelectedMask({
          binary: seg.binary,
          width:  canvasSize.w,
          height: canvasSize.h,
          label:  seg._label,
        });
        setSelectedLabel(seg._label);
        return;
      }
    }
  }, [activeTool, overlayMasks, canvasSize]);

  // ── Point click in point mode → SAM ───────────────────────────────────────
  const handlePointClick = useCallback(async (e) => {
    if (activeTool !== 'point') return;
    const rect = imageCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = Math.round(e.clientX - rect.left);
    const cy = Math.round(e.clientY - rect.top);

    // Scale to original image coords
    const img = imageElRef.current;
    if (!img) return;
    const scaleX = img.naturalWidth  / canvasSize.w;
    const scaleY = img.naturalHeight / canvasSize.h;

    const result = await segmentMultiPoint(
      [{ x: cx * scaleX, y: cy * scaleY }],
      [1],
    );
    if (!result) return;

    const { masks, scores, bestIndex } = result;
    const best   = masks[bestIndex];
    const raw    = new Uint8Array(best.data.length);
    for (let i = 0; i < best.data.length; i++) raw[i] = best.data[i] > 0 ? 1 : 0;
    const clean  = cleanMask(fillHoles(raw, best.dims[3], best.dims[2]), best.dims[3], best.dims[2]);
    const scaled = rescaleBinary(clean, best.dims[3], best.dims[2], canvasSize.w, canvasSize.h);

    setSelectedMask({ binary: scaled, width: canvasSize.w, height: canvasSize.h, label: selectedLabel || 'custom' });
  }, [activeTool, canvasSize, segmentMultiPoint, selectedLabel]);

  // ── Lasso end → segmentByLabel ─────────────────────────────────────────────
  const handleLassoEnd = useCallback(async (canvasPoints) => {
    if (canvasPoints.length < 3) return;
    const img = imageElRef.current;
    if (!img) return;

    const scaleX = img.naturalWidth  / canvasSize.w;
    const scaleY = img.naturalHeight / canvasSize.h;
    const imgPoints = canvasPoints.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
    const samInput  = lassoToSamInput(imgPoints);
    const samPts    = samInput.map(({ x, y }) => ({ x, y }));
    const samLabels = samInput.map(({ label }) => label);

    const label = selectedLabel || 'custom';
    const result = await segmentByLabel({
      label,
      canvasPoints,
      samInputPoints:  samPts,
      samInputLabels:  samLabels,
      segmentMultiPoint,
      imageCanvas:     imageCanvasRef.current,
      canvasSize,
    });
    if (!result) return;

    const { masks, bestIndex } = result;
    const best  = masks[bestIndex];
    const raw   = new Uint8Array(best.data.length);
    for (let i = 0; i < best.data.length; i++) raw[i] = best.data[i] > 0 ? 1 : 0;
    const clean = cleanMask(fillHoles(raw, best.dims[3], best.dims[2]), best.dims[3], best.dims[2]);
    const rescaled = rescaleBinary(clean, best.dims[3], best.dims[2], canvasSize.w, canvasSize.h);

    setSelectedMask({ binary: rescaled, width: canvasSize.w, height: canvasSize.h, label });
  }, [canvasSize, selectedLabel, segmentMultiPoint]);

  // ── Confirm ────────────────────────────────────────────────────────────────
  const handleConfirm = useCallback(() => {
    if (!selectedMask) return;
    onComplete(selectedMask);
  }, [selectedMask, onComplete]);

  const isLoading = isModelLoading || isSegmenting;

  return (
    <div className="correction-modal">
      <header className="correction-header">
        <span className="correction-title">보정 모드 — 원하는 영역을 선택해주세요</span>
        <button className="correction-close" onClick={onCancel}>✕</button>
      </header>

      <div className="correction-toolbar">
        {[
          { id: 'segment', label: '영역 선택' },
          { id: 'lasso',   label: '올가미' },
          { id: 'point',   label: '포인트' },
        ].map((t) => (
          <button
            key={t.id}
            className={`correction-tool ${activeTool === t.id ? 'active' : ''}`}
            onClick={() => setActiveTool(t.id)}
          >
            {t.label}
          </button>
        ))}
        {selectedLabel && (
          <span className="correction-hint">
            대상: {LABEL_KR[selectedLabel] || selectedLabel}
          </span>
        )}
      </div>

      <div className="correction-canvas-wrap" ref={containerRef}>
        {/* Room image canvas */}
        <canvas
          ref={imageCanvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          className="correction-canvas"
          onClick={(e) => {
            handleCanvasClick(e);
            handlePointClick(e);
          }}
          style={{ cursor: activeTool === 'point' ? 'crosshair' : 'default' }}
        />

        {/* All semantic segments (clickable overlay) */}
        {activeTool === 'segment' && overlayMasks.length > 0 && (
          <SegmentOverlay
            masks={overlayMasks}
            width={canvasSize.w}
            height={canvasSize.h}
            style={{ pointerEvents: 'none' }}
          />
        )}

        {/* Selected mask highlight */}
        {selectedMask && (
          <SegmentOverlay
            masks={selectedOverlay}
            width={canvasSize.w}
            height={canvasSize.h}
            style={{ pointerEvents: 'none', zIndex: 5 }}
          />
        )}

        {/* Lasso tool */}
        {activeTool === 'lasso' && (
          <LassoSelector
            canvasSize={canvasSize}
            zoom={1}
            lassoMode
            disabled={isLoading}
            onLassoEnd={handleLassoEnd}
          />
        )}

        {isLoading && (
          <div className="correction-spinner-overlay">
            <span className="spinner" />
          </div>
        )}
      </div>

      <footer className="correction-footer">
        <button
          className="correction-confirm"
          onClick={handleConfirm}
          disabled={!selectedMask}
        >
          확정 ✓
        </button>
        <button className="correction-cancel" onClick={onCancel}>
          취소
        </button>
      </footer>
    </div>
  );
}

export default CorrectionMode;
