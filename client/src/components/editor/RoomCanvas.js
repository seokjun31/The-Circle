/**
 * RoomCanvas — Interactive image editor canvas with SAM click-based segmentation.
 *
 * Features:
 *   - Room image display with letterbox-aware scaling
 *   - SAM image encoding on load (with progress state exposed to parent)
 *   - Left-click  → add foreground point (label=1) → instant mask
 *   - Right-click → add background point (label=0) → refine mask
 *   - Multi-region selection (confirm one area, start next click cycle)
 *   - Marching-ants overlay via SegmentOverlay
 *   - Zoom (wheel) + pan (middle-mouse / two-finger) with CSS transform
 *   - Fallback to brush mode if SAM fails
 *
 * Props:
 *   imageSrc         {string}   URL or data-URL of the room photo
 *   onMasksChange    {Function} called with confirmed masks array
 *   onEncodingChange {Function} called with { isEncoding, isModelLoading } so parent
 *                              can show a status banner
 *   className        {string}
 */

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import SegmentOverlay from './SegmentOverlay';
import { useSamSegmentation } from '../../hooks/useSamSegmentation';
import { maskToBinary } from '../../lib/sam/samUtils';
import './RoomCanvas.css';

// ── Rescale binary mask from original image dims to canvas dims ────────────────
function rescaleMask(binary, srcW, srcH, dstW, dstH) {
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

// ── Region label options ───────────────────────────────────────────────────────
const LABEL_OPTIONS = ['벽', '바닥', '천장', '기타'];
const LABEL_COLORS  = { '벽': '#1e90ff', '바닥': '#22c55e', '천장': '#f59e0b', '기타': '#ec4899' };

// Zoom limits
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4.0;
const ZOOM_STEP = 0.15;

// ─────────────────────────────────────────────────────────────────────────────

function RoomCanvas({ imageSrc, onMasksChange, onEncodingChange, className = '' }) {
  // ── SAM hook ──────────────────────────────────────────────────────────────
  const {
    initModel,
    encodeImage,
    segmentMultiPoint,
    resetEncoding,
    isModelLoading,
    isEncoding,
    isSegmenting,
    error: samError,
  } = useSamSegmentation();

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const containerRef = useRef(null);    // outer scroll/zoom container
  const wrapperRef   = useRef(null);    // zoom target
  const imageCanvasRef = useRef(null);  // base image layer
  const imageElRef   = useRef(null);    // loaded HTMLImageElement

  // ── Display dimensions (canvas size) ──────────────────────────────────────
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  // ── Zoom / pan ─────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart  = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  // ── Segmentation state ─────────────────────────────────────────────────────
  const [clickPoints, setClickPoints] = useState([]); // { x, y, label }[]
  const [currentMask, setCurrentMask] = useState(null); // ort.Tensor
  const [pendingLabel, setPendingLabel] = useState('벽');

  // Confirmed regions (each has binary mask + label + color)
  const [confirmedMasks, setConfirmedMasks] = useState([]);

  // ── Notify parent of encoding status ──────────────────────────────────────
  useEffect(() => {
    onEncodingChange?.({ isModelLoading, isEncoding });
  }, [isModelLoading, isEncoding, onEncodingChange]);

  // ── Load image + run encoder ───────────────────────────────────────────────
  useEffect(() => {
    if (!imageSrc) return;
    let cancelled = false;

    resetEncoding();
    setClickPoints([]);
    setCurrentMask(null);
    setConfirmedMasks([]);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      if (cancelled) return;
      imageElRef.current = img;

      // Fit to container
      const container = containerRef.current;
      const maxW = container?.clientWidth  || 800;
      const maxH = container?.clientHeight || 600;
      const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = Math.round(img.naturalWidth  * scale);
      const h = Math.round(img.naturalHeight * scale);
      setCanvasSize({ w, h });
      // Drawing is deferred to canvasSize effect to avoid React clearing the canvas

      // SAM: init model then encode
      const ok = await initModel();
      if (!cancelled && ok) await encodeImage(img);
    };
    img.src = imageSrc;

    return () => { cancelled = true; };
  }, [imageSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draw image after canvas dimensions are set by React ───────────────────
  useEffect(() => {
    if (canvasSize.w === 0 || canvasSize.h === 0) return;
    const img    = imageElRef.current;
    const canvas = imageCanvasRef.current;
    if (!img || !canvas) return;
    // Wait one tick so React has committed the new width/height props
    const id = requestAnimationFrame(() => {
      canvas.getContext('2d').drawImage(img, 0, 0, canvasSize.w, canvasSize.h);
    });
    return () => cancelAnimationFrame(id);
  }, [canvasSize]);

  // ── Notify parent when confirmed masks change ──────────────────────────────
  useEffect(() => {
    onMasksChange?.(confirmedMasks);
  }, [confirmedMasks, onMasksChange]);

  // ── Convert canvas click → original image coordinates ─────────────────────
  const canvasToImageCoords = useCallback((clientX, clientY) => {
    const canvas = imageCanvasRef.current;
    const img    = imageElRef.current;
    if (!canvas || !img) return null;

    const rect   = canvas.getBoundingClientRect();
    const canvX  = (clientX - rect.left)  / zoom;
    const canvY  = (clientY - rect.top)   / zoom;

    // Map from display-canvas pixels → original image pixels
    const origX  = (canvX / canvasSize.w) * img.naturalWidth;
    const origY  = (canvY / canvasSize.h) * img.naturalHeight;

    return { x: origX, y: origY, canvX, canvY };
  }, [zoom, canvasSize]);

  // ── Click handler ──────────────────────────────────────────────────────────
  const handleCanvasClick = useCallback(async (e) => {
    if (isEncoding || isModelLoading) return;
    e.preventDefault();

    const label = e.button === 2 ? 0 : 1; // right-click = background
    const coords = canvasToImageCoords(e.clientX, e.clientY);
    if (!coords) return;

    const newPoint = { x: coords.x, y: coords.y, label };
    const nextPoints = [...clickPoints, newPoint];
    setClickPoints(nextPoints);

    // Run decoder with all accumulated points
    const mask = await segmentMultiPoint(
      nextPoints.map(({ x, y }) => ({ x, y })),
      nextPoints.map(({ label: l }) => l),
    );
    setCurrentMask(mask);
  }, [clickPoints, isEncoding, isModelLoading, canvasToImageCoords, segmentMultiPoint]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault(); // suppress browser context menu for right-click segmentation
    handleCanvasClick(e);
  }, [handleCanvasClick]);

  // ── Confirm current mask → add to confirmed list ───────────────────────────
  const handleConfirm = useCallback(() => {
    if (!currentMask) return;

    const img    = imageElRef.current;
    const raw    = maskToBinary(currentMask);
    const binary = img
      ? rescaleMask(raw, img.naturalWidth, img.naturalHeight, canvasSize.w, canvasSize.h)
      : raw;
    const color  = LABEL_COLORS[pendingLabel] || '#1e90ff';
    setConfirmedMasks(prev => [...prev, { binary, label: pendingLabel, color }]);
    setClickPoints([]);
    setCurrentMask(null);
  }, [currentMask, pendingLabel]);

  // ── Cancel current selection ───────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setClickPoints([]);
    setCurrentMask(null);
  }, []);

  const handleRemoveMask = useCallback((idx) => {
    setConfirmedMasks(prev => prev.filter((_, i) => i !== idx));
  }, []);

  // ── Zoom (non-passive wheel listener to allow preventDefault) ─────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ── Pan (middle mouse) ─────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 1) return; // middle mouse only
    e.preventDefault();
    isPanning.current = true;
    panStart.current  = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e) => {
    if (!isPanning.current) return;
    setPan({
      x: panStart.current.px + (e.clientX - panStart.current.mx),
      y: panStart.current.py + (e.clientY - panStart.current.my),
    });
  }, []);

  const handleMouseUp = useCallback(() => { isPanning.current = false; }, []);

  // ── Overlay masks: current (pending) + all confirmed ──────────────────────
  const overlayMasks = useMemo(() => {
    const all = [...confirmedMasks]; // already rescaled at confirm time
    if (currentMask) {
      const img = imageElRef.current;
      const raw = maskToBinary(currentMask);
      const binary = img
        ? rescaleMask(raw, img.naturalWidth, img.naturalHeight, canvasSize.w, canvasSize.h)
        : raw;
      all.push({
        binary,
        label: pendingLabel,
        color: LABEL_COLORS[pendingLabel] || '#1e90ff',
      });
    }
    return all;
  }, [confirmedMasks, currentMask, pendingLabel, canvasSize]);

  // ── Point markers (drawn on an overlay div using SVG) ─────────────────────
  const pointMarkers = useMemo(() => clickPoints.map((pt, i) => {
    // Map original-image coords → display-canvas coords
    const img = imageElRef.current;
    if (!img) return null;
    const canvX = (pt.x / img.naturalWidth)  * canvasSize.w;
    const canvY = (pt.y / img.naturalHeight) * canvasSize.h;
    return (
      <div
        key={i}
        className={`sam-point-marker ${pt.label === 1 ? 'positive' : 'negative'}`}
        style={{ left: canvX, top: canvY }}
        title={pt.label === 1 ? '전경 포인트' : '배경 포인트'}
      >
        {pt.label === 1 ? '+' : '−'}
      </div>
    );
  }), [clickPoints, canvasSize]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className={`room-canvas-root ${className}`}>
      {/* ── Left panel: label selector + confirmed list ── */}
      <div className="room-canvas-sidebar">
        <div className="rcs-section">
          <h4 className="rcs-title">영역 레이블</h4>
          <div className="rcs-labels">
            {LABEL_OPTIONS.map((lbl) => (
              <button
                key={lbl}
                className={`rcs-label-btn ${pendingLabel === lbl ? 'active' : ''}`}
                style={{ '--accent': LABEL_COLORS[lbl] }}
                onClick={() => setPendingLabel(lbl)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="rcs-section">
          <h4 className="rcs-title">사용법</h4>
          <ul className="rcs-tips">
            <li><span className="tip-dot positive" /> 좌클릭: 선택할 영역</li>
            <li><span className="tip-dot negative" /> 우클릭: 제외할 영역</li>
            <li>휠: 줌 / 가운데 버튼: 이동</li>
          </ul>
        </div>

        {confirmedMasks.length > 0 && (
          <div className="rcs-section">
            <h4 className="rcs-title">선택된 영역</h4>
            {confirmedMasks.map((m, i) => (
              <div key={i} className="rcs-mask-item">
                <span className="rcs-mask-dot" style={{ background: m.color }} />
                <span className="rcs-mask-label">{m.label}</span>
                <button
                  className="rcs-mask-remove"
                  onClick={() => handleRemoveMask(i)}
                  title="제거"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Main area: viewport + action bar stacked vertically ── */}
      <div className="room-canvas-main">
        <div
          className="room-canvas-viewport"
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Loading / encoding banner */}
          {(isModelLoading || isEncoding) && (
            <div className="rcs-status-banner">
              <span className="spinner" />
              {isModelLoading ? 'SAM 모델 로딩 중...' : '이미지를 분석하고 있습니다...'}
            </div>
          )}
          {samError && (
            <div className="rcs-error-banner">{samError}</div>
          )}

          {/* Zoom/pan wrapper */}
          <div
            ref={wrapperRef}
            className="room-canvas-zoom-wrapper"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              position: 'relative',
              display: 'inline-block',
            }}
          >
            {/* Layer 1: base image */}
            <canvas
              ref={imageCanvasRef}
              className="rcs-image-canvas"
              width={canvasSize.w}
              height={canvasSize.h}
            />

            {/* Layer 2: marching-ants mask overlay */}
            {canvasSize.w > 0 && (
              <SegmentOverlay
                masks={overlayMasks}
                width={canvasSize.w}
                height={canvasSize.h}
              />
            )}

            {/* Layer 3: click point markers */}
            <div className="rcs-points-layer" style={{ width: canvasSize.w, height: canvasSize.h }}>
              {pointMarkers}
            </div>

            {/* Layer 4: invisible hit area for mouse events */}
            <div
              className="rcs-hit-area"
              onClick={handleCanvasClick}
              onContextMenu={handleContextMenu}
              role="button"
              tabIndex={0}
              aria-label="이미지 클릭으로 영역 선택"
              style={{
                cursor: isEncoding || isModelLoading || isSegmenting
                  ? 'wait'
                  : 'crosshair',
                position: 'absolute',
                top: 0,
                left: 0,
                width: canvasSize.w,
                height: canvasSize.h,
              }}
            />
          </div>
        </div>

        {/* ── Action bar (below viewport, not beside it) ── */}
        {clickPoints.length > 0 && (
          <div className="rcs-action-bar">
            <div className="rcs-action-info">
              {isSegmenting ? (
                <><span className="spinner" /> 마스크 생성 중...</>
              ) : currentMask ? (
                <>영역이 선택됐습니다. 확인하거나 클릭을 추가하세요.</>
              ) : (
                <>클릭 포인트가 추가됐습니다.</>
              )}
            </div>
            <div className="rcs-action-buttons">
              <button className="btn btn-secondary" onClick={handleCancel}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={!currentMask || isSegmenting}
              >
                이 영역 확정
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default RoomCanvas;
