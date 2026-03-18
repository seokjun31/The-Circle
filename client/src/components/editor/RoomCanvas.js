/**
 * RoomCanvas — Interactive image editor canvas with SAM segmentation.
 *
 * Input modes:
 *   Point mode (default)
 *     - Left-click  → foreground point (label=1) → mask updated instantly
 *     - Right-click → background point (label=0) → mask refined
 *     - Points accumulate; all are passed to SAM decoder together.
 *
 *   Brush mode
 *     - Left-drag   → scribble to ADD area to selection (label=1)
 *     - Right-drag / Alt+drag → scribble to REMOVE area (label=0)
 *     - Brush path is sampled to ≤24 points, passed to SAM.
 *     - SAM carries the previous mask as context (lowResMask chaining) so
 *       successive strokes expand / contract the selection naturally.
 *     - Each stroke replaces accumulated point history; only the stroke's
 *       own points are forwarded, but the hook's prevMask carries context.
 *
 * Props:
 *   imageSrc         {string}   URL / data-URL of the room photo
 *   onMasksChange    {Function} called with confirmed masks array
 *   onEncodingChange {Function} called with { isEncoding, isModelLoading }
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
import BrushSelector  from './BrushSelector';
import { useSamSegmentation } from '../../hooks/useSamSegmentation';
import { maskToBinary } from '../../lib/sam/samUtils';
import './RoomCanvas.css';

// ── Rescale binary mask from original image dims to canvas dims ───────────────
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

// ── Constants ─────────────────────────────────────────────────────────────────
const LABEL_OPTIONS = ['벽', '바닥', '천장', '기타'];
const LABEL_COLORS  = { '벽': '#1e90ff', '바닥': '#22c55e', '천장': '#f59e0b', '기타': '#ec4899' };

const MIN_ZOOM  = 0.5;
const MAX_ZOOM  = 4.0;
const ZOOM_STEP = 0.15;

const BRUSH_MIN  = 10;
const BRUSH_MAX  = 50;
const BRUSH_INIT = 20;

// ─────────────────────────────────────────────────────────────────────────────

function RoomCanvas({ imageSrc, onMasksChange, onEncodingChange, className = '' }) {
  // ── SAM hook ──────────────────────────────────────────────────────────────
  const {
    initModel,
    encodeImage,
    segmentMultiPoint,
    segmentPreview,
    resetEncoding,
    clearPrevMask,
    isModelLoading,
    isEncoding,
    isSegmenting,
    error: samError,
  } = useSamSegmentation();

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const containerRef   = useRef(null);
  const wrapperRef     = useRef(null);
  const imageCanvasRef = useRef(null);
  const imageElRef     = useRef(null);

  // ── Display dimensions ────────────────────────────────────────────────────
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  // ── Zoom / pan ────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart  = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  // ── Input mode ────────────────────────────────────────────────────────────
  const [brushMode, setBrushMode] = useState(false);
  const [brushSize, setBrushSize] = useState(BRUSH_INIT);
  const strokeCountRef = useRef(0); // number of brush strokes in current selection

  // ── Segmentation state ────────────────────────────────────────────────────
  const [clickPoints,   setClickPoints]   = useState([]); // point mode only
  const [currentMask,   setCurrentMask]   = useState(null);
  const [previewMask,   setPreviewMask]   = useState(null); // live brush preview
  const [pendingLabel,  setPendingLabel]  = useState('벽');
  const [confirmedMasks, setConfirmedMasks] = useState([]);

  // ── Notify parent of encoding status ─────────────────────────────────────
  useEffect(() => {
    onEncodingChange?.({ isModelLoading, isEncoding });
  }, [isModelLoading, isEncoding, onEncodingChange]);

  // ── Load image + run encoder ──────────────────────────────────────────────
  useEffect(() => {
    if (!imageSrc) return;
    let cancelled = false;

    resetEncoding();
    setClickPoints([]);
    setCurrentMask(null);
    setConfirmedMasks([]);
    strokeCountRef.current = 0;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      if (cancelled) return;
      imageElRef.current = img;

      const container = containerRef.current;
      const maxW  = container?.clientWidth  || 800;
      const maxH  = container?.clientHeight || 600;
      const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w     = Math.round(img.naturalWidth  * scale);
      const h     = Math.round(img.naturalHeight * scale);
      setCanvasSize({ w, h });

      const ok = await initModel();
      if (!cancelled && ok) await encodeImage(img);
    };
    img.src = imageSrc;

    return () => { cancelled = true; };
  }, [imageSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draw image onto canvas after size is committed ────────────────────────
  useEffect(() => {
    if (canvasSize.w === 0 || canvasSize.h === 0) return;
    const img    = imageElRef.current;
    const canvas = imageCanvasRef.current;
    if (!img || !canvas) return;
    const id = requestAnimationFrame(() => {
      canvas.getContext('2d').drawImage(img, 0, 0, canvasSize.w, canvasSize.h);
    });
    return () => cancelAnimationFrame(id);
  }, [canvasSize]);

  // ── Notify parent when confirmed masks change ─────────────────────────────
  useEffect(() => {
    onMasksChange?.(confirmedMasks);
  }, [confirmedMasks, onMasksChange]);

  // ── Switch modes: clear current pending selection ─────────────────────────
  const handleSwitchMode = useCallback((nextBrushMode) => {
    setBrushMode(nextBrushMode);
    setClickPoints([]);
    setCurrentMask(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [clearPrevMask]);

  // ── Point mode: canvas click → original image coords ─────────────────────
  const canvasToImageCoords = useCallback((clientX, clientY) => {
    const canvas = imageCanvasRef.current;
    const img    = imageElRef.current;
    if (!canvas || !img) return null;

    const rect  = canvas.getBoundingClientRect();
    const canvX = (clientX - rect.left) / zoom;
    const canvY = (clientY - rect.top)  / zoom;

    return {
      x:     (canvX / canvasSize.w) * img.naturalWidth,
      y:     (canvY / canvasSize.h) * img.naturalHeight,
      canvX,
      canvY,
    };
  }, [zoom, canvasSize]);

  // ── Point mode click handler ──────────────────────────────────────────────
  const handleCanvasClick = useCallback(async (e) => {
    if (brushMode || isEncoding || isModelLoading) return;
    e.preventDefault();

    const label  = e.button === 2 ? 0 : 1;
    const coords = canvasToImageCoords(e.clientX, e.clientY);
    if (!coords) return;

    const newPoint  = { x: coords.x, y: coords.y, label };
    const nextPoints = [...clickPoints, newPoint];
    setClickPoints(nextPoints);

    const mask = await segmentMultiPoint(
      nextPoints.map(({ x, y }) => ({ x, y })),
      nextPoints.map(({ label: l }) => l),
    );
    setCurrentMask(mask);
  }, [brushMode, clickPoints, isEncoding, isModelLoading, canvasToImageCoords, segmentMultiPoint]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    handleCanvasClick(e);
  }, [handleCanvasClick]);

  // ── Brush mode stroke handler ─────────────────────────────────────────────
  /**
   * Called by BrushSelector when a drag stroke ends.
   * canvasPoints: [{x, y}] in display-canvas pixel space (0..canvasSize.w)
   * isExclude:    true → label=0 (remove), false → label=1 (add)
   *
   * Strategy: each stroke is passed independently to SAM; the previous
   * selection is carried as context via the hook's lowResMask ref.
   * This lets successive strokes expand / contract naturally without
   * accumulating hundreds of points.
   */
  const handleStrokeEnd = useCallback(async (canvasPoints, isExclude) => {
    if (isEncoding || isModelLoading) return;
    const img = imageElRef.current;
    if (!img) return;

    // Clear stale preview immediately so we don't show it while the full
    // decode is running.  The real result will appear when it arrives.
    setPreviewMask(null);
    strokeCountRef.current += 1;

    // Convert canvas px → original image px
    const pts    = canvasPoints.map(({ x, y }) => ({
      x: (x / canvasSize.w) * img.naturalWidth,
      y: (y / canvasSize.h) * img.naturalHeight,
    }));
    const labels = canvasPoints.map(() => isExclude ? 0 : 1);

    // segmentMultiPoint returns null if the result was superseded by a newer
    // request — in that case we leave currentMask at its previous value so the
    // UI doesn't flicker.
    const mask = await segmentMultiPoint(pts, labels);
    if (mask !== null) setCurrentMask(mask);
  }, [isEncoding, isModelLoading, canvasSize, segmentMultiPoint]);

  /**
   * Throttled live-preview handler called by BrushSelector during drag.
   * Uses segmentPreview (no requestId increment, no state updates in the hook).
   * Preview is shown at half-opacity; replaced by the real mask on stroke end.
   */
  const handleBrushPreview = useCallback(async (canvasPoints, isExclude) => {
    const img = imageElRef.current;
    if (!img) return;

    const pts    = canvasPoints.map(({ x, y }) => ({
      x: (x / canvasSize.w) * img.naturalWidth,
      y: (y / canvasSize.h) * img.naturalHeight,
    }));
    const labels = canvasPoints.map(() => isExclude ? 0 : 1);

    const mask = await segmentPreview(pts, labels);
    if (mask !== null) setPreviewMask(mask);
  }, [canvasSize, segmentPreview]);

  // ── Confirm → save mask to confirmed list ────────────────────────────────
  const handleConfirm = useCallback(() => {
    if (!currentMask) return;

    const raw    = maskToBinary(currentMask);
    const maskW  = currentMask.dims[3];
    const maskH  = currentMask.dims[2];
    const binary = (maskW !== canvasSize.w || maskH !== canvasSize.h)
      ? rescaleMask(raw, maskW, maskH, canvasSize.w, canvasSize.h)
      : raw;

    const color = LABEL_COLORS[pendingLabel] || '#1e90ff';
    setConfirmedMasks(prev => [...prev, { binary, label: pendingLabel, color }]);
    setClickPoints([]);
    setCurrentMask(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [currentMask, pendingLabel, canvasSize, clearPrevMask]);

  // ── Cancel current selection ──────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setClickPoints([]);
    setCurrentMask(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [clearPrevMask]);

  const handleRemoveMask = useCallback((idx) => {
    setConfirmedMasks(prev => prev.filter((_, i) => i !== idx));
  }, []);

  // ── Zoom (wheel) ──────────────────────────────────────────────────────────
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

  // ── Pan (middle mouse) ────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 1) return;
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

  // ── Overlay masks ─────────────────────────────────────────────────────────
  const overlayMasks = useMemo(() => {
    const all = [...confirmedMasks];

    // Live preview (during brush drag): show at half opacity, no label.
    // Only shown when there is no confirmed current mask yet (i.e. mid-stroke).
    if (previewMask && !currentMask) {
      const raw    = maskToBinary(previewMask);
      const maskW  = previewMask.dims[3];
      const maskH  = previewMask.dims[2];
      const binary = (maskW !== canvasSize.w || maskH !== canvasSize.h)
        ? rescaleMask(raw, maskW, maskH, canvasSize.w, canvasSize.h)
        : raw;
      all.push({
        binary,
        label:   '',    // no label text for preview
        color:   LABEL_COLORS[pendingLabel] || '#1e90ff',
        preview: true,  // → SegmentOverlay renders at reduced opacity, no ants
      });
    }

    // Pending selection (after stroke end or point click).
    if (currentMask) {
      const raw    = maskToBinary(currentMask);
      const maskW  = currentMask.dims[3];
      const maskH  = currentMask.dims[2];
      const binary = (maskW !== canvasSize.w || maskH !== canvasSize.h)
        ? rescaleMask(raw, maskW, maskH, canvasSize.w, canvasSize.h)
        : raw;
      all.push({ binary, label: pendingLabel, color: LABEL_COLORS[pendingLabel] || '#1e90ff' });
    }

    return all;
  }, [confirmedMasks, currentMask, previewMask, pendingLabel, canvasSize]);

  // ── Point markers (point mode only) ──────────────────────────────────────
  const pointMarkers = useMemo(() => clickPoints.map((pt, i) => {
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

  // ── Brush size slider CSS custom-property (fill colour) ───────────────────
  const brushSliderStyle = useMemo(() => ({
    '--progress': `${((brushSize - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 100}%`,
  }), [brushSize]);

  // ── Action bar visibility: show whenever there is a pending selection ─────
  const hasSelection = currentMask !== null || clickPoints.length > 0;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className={`room-canvas-root ${className}`}>

      {/* ── Left panel ─────────────────────────────────────────────────── */}
      <div className="room-canvas-sidebar">

        {/* Label selector */}
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

        {/* Mode toggle */}
        <div className="rcs-section">
          <h4 className="rcs-title">입력 모드</h4>
          <div className="rcs-mode-bar">
            <button
              className={`rcs-mode-btn ${!brushMode ? 'active' : ''}`}
              onClick={() => handleSwitchMode(false)}
              title="포인트 클릭으로 영역 선택"
            >
              <span className="rcs-mode-icon">⊕</span>
              포인트
            </button>
            <button
              className={`rcs-mode-btn ${brushMode ? 'active' : ''}`}
              onClick={() => handleSwitchMode(true)}
              title="브러시로 영역을 긁어서 선택"
            >
              <span className="rcs-mode-icon">✏️</span>
              브러시
            </button>
          </div>
        </div>

        {/* Brush size slider (brush mode only) */}
        {brushMode && (
          <div className="rcs-brush-controls">
            <div className="rcs-brush-header">
              <span className="rcs-brush-label">브러시 크기</span>
              <span className="rcs-brush-value">{brushSize}px</span>
            </div>
            <input
              type="range"
              className="rcs-brush-slider"
              min={BRUSH_MIN}
              max={BRUSH_MAX}
              value={brushSize}
              style={brushSliderStyle}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
          </div>
        )}

        {/* Usage tips */}
        <div className="rcs-section">
          <h4 className="rcs-title">사용법</h4>
          {brushMode ? (
            <ul className="rcs-tips">
              <li><span className="tip-brush-add">◉</span> 좌클릭 드래그: 영역 추가</li>
              <li><span className="tip-brush-remove">◉</span> 우클릭 / Alt+드래그: 영역 제외</li>
              <li>여러 번 긁으면 선택 영역이 확장됩니다</li>
              <li>휠: 줌 / 가운데 버튼: 이동</li>
            </ul>
          ) : (
            <ul className="rcs-tips">
              <li><span className="tip-dot positive" /> 좌클릭: 선택할 영역</li>
              <li><span className="tip-dot negative" /> 우클릭: 제외할 영역</li>
              <li>휠: 줌 / 가운데 버튼: 이동</li>
            </ul>
          )}
        </div>

        {/* Confirmed mask list */}
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

      {/* ── Main canvas area ────────────────────────────────────────────── */}
      <div className="room-canvas-main">
        <div
          className="room-canvas-viewport"
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Status banners */}
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

            {/* Layer 3: click point markers (point mode only) */}
            <div
              className="rcs-points-layer"
              style={{ width: canvasSize.w, height: canvasSize.h }}
            >
              {!brushMode && pointMarkers}
            </div>

            {/* Layer 4: brush canvas overlay (brush mode) */}
            {canvasSize.w > 0 && (
              <BrushSelector
                canvasSize={canvasSize}
                zoom={zoom}
                brushSize={brushSize}
                brushMode={brushMode}
                disabled={isEncoding || isModelLoading || isSegmenting}
                onStrokeEnd={handleStrokeEnd}
                onBrushPreview={handleBrushPreview}
              />
            )}

            {/* Layer 5: point-mode hit area (disabled in brush mode) */}
            <div
              className="rcs-hit-area"
              onClick={handleCanvasClick}
              onContextMenu={handleContextMenu}
              role="button"
              tabIndex={0}
              aria-label="이미지 클릭으로 영역 선택"
              style={{
                cursor: brushMode
                  ? 'default'
                  : (isEncoding || isModelLoading || isSegmenting ? 'wait' : 'crosshair'),
                pointerEvents: brushMode ? 'none' : 'auto',
                position: 'absolute',
                top: 0,
                left: 0,
                width: canvasSize.w,
                height: canvasSize.h,
              }}
            />
          </div>
        </div>

        {/* Action bar */}
        {hasSelection && (
          <div className="rcs-action-bar">
            <div className="rcs-action-info">
              {isSegmenting ? (
                <><span className="spinner" /> 마스크 생성 중...</>
              ) : currentMask ? (
                brushMode ? (
                  <>
                    영역이 선택됐습니다. 확인하거나 클릭을 추가하세요.
                    {strokeCountRef.current > 0 && (
                      <span className="rcs-stroke-badge">
                        {strokeCountRef.current}회 스트로크
                      </span>
                    )}
                  </>
                ) : (
                  <>영역이 선택됐습니다. 확인하거나 클릭을 추가하세요.</>
                )
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
