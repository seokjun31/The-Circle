/**
 * RoomCanvas — Interactive image editor canvas with SAM segmentation.
 *
 * Input modes (inputMode):
 *   'lasso'  (default) — Freehand lasso → hybrid Box + Positive + Negative SAM input
 *   'point'            — Left/right-click accumulates foreground/background points
 *   'box'              — Drag to draw a bounding box (SAM box-prompt labels 2/3)
 *   'brush'            — Scribble stroke → arc-length sampled points
 *
 * Over-segmentation prevention (解決 A+B+C):
 *   A. arc-length sampling via samplePointsFromBrush()  — adaptive 4-12 pts
 *   B. MaskSizeSelector — show all 3 SAM mask candidates; instant switching
 *   C. cleanMask + fillHoles applied after each decode  — remove islands/gaps
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
import SegmentOverlay   from './SegmentOverlay';
import BrushSelector    from './BrushSelector';
import LassoSelector    from './LassoSelector';
import BoxDragSelector  from './BoxDragSelector';
import MaskSizeSelector from './MaskSizeSelector';
import { useSamSegmentation } from '../../hooks/useSamSegmentation';
import { maskToBinary }        from '../../lib/sam/samUtils';
import { cleanMask, fillHoles } from '../../lib/sam/maskPostProcess';
import { lassoToSamInput }      from '../../lib/sam/lassoToSamInput';
import './RoomCanvas.css';

// ── Rescale binary mask from tensor dims to canvas dims ───────────────────────
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

/**
 * Convert a SAM tensor to a display-ready binary mask:
 *   1. maskToBinary (logits > 0)
 *   2. rescale to canvas dimensions
 *   3. cleanMask (remove isolated islands < 1 %)
 *   4. fillHoles (fill interior gaps < 2 %)
 */
function tensorToBinaryProcessed(tensor, canvasW, canvasH) {
  const raw    = maskToBinary(tensor);
  const maskW  = tensor.dims[3];
  const maskH  = tensor.dims[2];
  const scaled = (maskW !== canvasW || maskH !== canvasH)
    ? rescaleMask(raw, maskW, maskH, canvasW, canvasH)
    : raw;
  const clean  = cleanMask(scaled, canvasW, canvasH);
  return fillHoles(clean, canvasW, canvasH);
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

  // ── Canvas refs ───────────────────────────────────────────────────────────
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
  // 'lasso' | 'point' | 'box' | 'brush'
  const [inputMode, setInputMode] = useState('lasso');
  const [brushSize, setBrushSize] = useState(BRUSH_INIT);
  const strokeCountRef = useRef(0);

  // Derived booleans for selector components
  const brushMode = inputMode === 'brush';

  // ── Segmentation state ────────────────────────────────────────────────────
  const [clickPoints,   setClickPoints]   = useState([]); // point mode only
  // currentMaskSet: { masks: Tensor[], scores: number[], bestIndex: number } | null
  const [currentMaskSet,  setCurrentMaskSet]  = useState(null);
  const [selectedMaskIdx, setSelectedMaskIdx] = useState(0);
  const [previewMask,     setPreviewMask]     = useState(null); // single tensor, brush drag
  const [pendingLabel,    setPendingLabel]    = useState('벽');
  const [confirmedMasks,  setConfirmedMasks]  = useState([]);

  // Sync selectedMaskIdx to SAM's best guess whenever a new decode arrives.
  useEffect(() => {
    if (currentMaskSet) setSelectedMaskIdx(currentMaskSet.bestIndex);
  }, [currentMaskSet]);

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
    setCurrentMaskSet(null);
    setPreviewMask(null);
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

  // ── Draw image after canvas dimensions are committed ─────────────────────
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

  // ── Mode switch: clear pending selection ──────────────────────────────────
  const handleSwitchMode = useCallback((nextMode) => {
    setInputMode(nextMode);
    setClickPoints([]);
    setCurrentMaskSet(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [clearPrevMask]);

  // ── Lasso mode: lasso end → SAM hybrid input ─────────────────────────────
  const handleLassoEnd = useCallback(async (canvasPoints) => {
    if (isEncoding || isModelLoading) return;
    const img = imageElRef.current;
    if (!img) return;

    // Convert canvas px → image px
    const scaleX = img.naturalWidth  / canvasSize.w;
    const scaleY = img.naturalHeight / canvasSize.h;
    const imagePath = canvasPoints.map(({ x, y }) => ({
      x: x * scaleX,
      y: y * scaleY,
    }));

    // Extract SAM hybrid inputs: box corners (labels 2/3) + pos/neg points
    const samPoints = lassoToSamInput(imagePath);
    if (samPoints.length === 0) return;

    const pts    = samPoints.map((p) => ({ x: p.x, y: p.y }));
    const labels = samPoints.map((p) => p.label);

    const result = await segmentMultiPoint(pts, labels);
    if (result !== null) setCurrentMaskSet(result);
  }, [isEncoding, isModelLoading, canvasSize, segmentMultiPoint]);

  // ── Box mode: box end → SAM box-prompt input ──────────────────────────────
  const handleBoxEnd = useCallback(async (canvasBox) => {
    if (isEncoding || isModelLoading) return;
    const img = imageElRef.current;
    if (!img) return;

    // Convert canvas px → image px
    const scaleX = img.naturalWidth  / canvasSize.w;
    const scaleY = img.naturalHeight / canvasSize.h;

    // SAM box-prompt: top-left label=2, bottom-right label=3
    const pts = [
      { x: canvasBox.x_min * scaleX, y: canvasBox.y_min * scaleY },
      { x: canvasBox.x_max * scaleX, y: canvasBox.y_max * scaleY },
    ];
    const labels = [2, 3];

    const result = await segmentMultiPoint(pts, labels);
    if (result !== null) setCurrentMaskSet(result);
  }, [isEncoding, isModelLoading, canvasSize, segmentMultiPoint]);

  // ── Point mode: canvas click → image coords ───────────────────────────────
  const canvasToImageCoords = useCallback((clientX, clientY) => {
    const canvas = imageCanvasRef.current;
    const img    = imageElRef.current;
    if (!canvas || !img) return null;
    const rect  = canvas.getBoundingClientRect();
    const canvX = (clientX - rect.left) / zoom;
    const canvY = (clientY - rect.top)  / zoom;
    return {
      x: (canvX / canvasSize.w) * img.naturalWidth,
      y: (canvY / canvasSize.h) * img.naturalHeight,
    };
  }, [zoom, canvasSize]);

  const handleCanvasClick = useCallback(async (e) => {
    if (inputMode !== 'point' || isEncoding || isModelLoading) return;
    e.preventDefault();

    const label  = e.button === 2 ? 0 : 1;
    const coords = canvasToImageCoords(e.clientX, e.clientY);
    if (!coords) return;

    const newPoint   = { x: coords.x, y: coords.y, label };
    const nextPoints = [...clickPoints, newPoint];
    setClickPoints(nextPoints);

    const result = await segmentMultiPoint(
      nextPoints.map(({ x, y }) => ({ x, y })),
      nextPoints.map(({ label: l }) => l),
    );
    if (result !== null) setCurrentMaskSet(result);
  }, [inputMode, clickPoints, isEncoding, isModelLoading, canvasToImageCoords, segmentMultiPoint]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    handleCanvasClick(e);
  }, [handleCanvasClick]);

  // ── Brush mode: stroke end ────────────────────────────────────────────────
  const handleStrokeEnd = useCallback(async (canvasPoints, isExclude) => {
    if (isEncoding || isModelLoading) return;
    const img = imageElRef.current;
    if (!img) return;

    setPreviewMask(null);
    strokeCountRef.current += 1;

    const pts    = canvasPoints.map(({ x, y }) => ({
      x: (x / canvasSize.w) * img.naturalWidth,
      y: (y / canvasSize.h) * img.naturalHeight,
    }));
    const labels = canvasPoints.map(() => isExclude ? 0 : 1);

    const result = await segmentMultiPoint(pts, labels);
    if (result !== null) setCurrentMaskSet(result);
  }, [isEncoding, isModelLoading, canvasSize, segmentMultiPoint]);

  // ── Brush mode: throttled preview ─────────────────────────────────────────
  const handleBrushPreview = useCallback(async (canvasPoints, isExclude) => {
    const img = imageElRef.current;
    if (!img) return;
    const pts    = canvasPoints.map(({ x, y }) => ({
      x: (x / canvasSize.w) * img.naturalWidth,
      y: (y / canvasSize.h) * img.naturalHeight,
    }));
    const labels = canvasPoints.map(() => isExclude ? 0 : 1);
    const mask   = await segmentPreview(pts, labels);
    if (mask !== null) setPreviewMask(mask);
  }, [canvasSize, segmentPreview]);

  // ── Confirm → save to confirmed list ─────────────────────────────────────
  const handleConfirm = useCallback(() => {
    if (!currentMaskSet) return;

    const tensor = currentMaskSet.masks[selectedMaskIdx];
    const binary = tensorToBinaryProcessed(tensor, canvasSize.w, canvasSize.h);
    const color  = LABEL_COLORS[pendingLabel] || '#1e90ff';

    setConfirmedMasks(prev => [...prev, { binary, label: pendingLabel, color }]);
    setClickPoints([]);
    setCurrentMaskSet(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [currentMaskSet, selectedMaskIdx, pendingLabel, canvasSize, clearPrevMask]);

  // ── Cancel ────────────────────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setClickPoints([]);
    setCurrentMaskSet(null);
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

  // ── Overlay masks (confirmed + preview + pending) ─────────────────────────
  const overlayMasks = useMemo(() => {
    const all = [...confirmedMasks];

    // Live preview during brush drag (half opacity, no label, no ants).
    if (previewMask && !currentMaskSet) {
      const binary = tensorToBinaryProcessed(previewMask, canvasSize.w, canvasSize.h);
      all.push({
        binary,
        label:   '',
        color:   LABEL_COLORS[pendingLabel] || '#1e90ff',
        preview: true,
      });
    }

    // Pending selection (after stroke end or point click).
    if (currentMaskSet) {
      const tensor = currentMaskSet.masks[selectedMaskIdx];
      const binary = tensorToBinaryProcessed(tensor, canvasSize.w, canvasSize.h);
      all.push({
        binary,
        label: pendingLabel,
        color: LABEL_COLORS[pendingLabel] || '#1e90ff',
      });
    }

    return all;
  }, [confirmedMasks, currentMaskSet, selectedMaskIdx, previewMask, pendingLabel, canvasSize]);

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

  // ── Brush size slider progress ────────────────────────────────────────────
  const brushSliderStyle = useMemo(() => ({
    '--progress': `${((brushSize - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 100}%`,
  }), [brushSize]);

  const hasSelection = currentMaskSet !== null || clickPoints.length > 0;
  const hasMultiMasks = currentMaskSet?.masks.length > 1;

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

        {/* Mode toggle — 3 main tools + brush */}
        <div className="rcs-section">
          <h4 className="rcs-title">입력 모드</h4>
          <div className="rcs-mode-bar rcs-mode-bar-4">
            <button
              className={`rcs-mode-btn ${inputMode === 'lasso' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('lasso')}
              title="자유형 올가미로 영역 선택 (기본)"
            >
              <span className="rcs-mode-icon">◎</span>
              올가미
            </button>
            <button
              className={`rcs-mode-btn ${inputMode === 'point' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('point')}
              title="포인트 클릭으로 영역 선택"
            >
              <span className="rcs-mode-icon">⊕</span>
              포인트
            </button>
            <button
              className={`rcs-mode-btn ${inputMode === 'box' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('box')}
              title="박스 드래그로 영역 선택"
            >
              <span className="rcs-mode-icon">▢</span>
              박스
            </button>
            <button
              className={`rcs-mode-btn ${inputMode === 'brush' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('brush')}
              title="브러시로 영역을 긁어서 선택"
            >
              <span className="rcs-mode-icon">✏️</span>
              브러시
            </button>
          </div>
        </div>

        {/* Brush size (brush mode only) */}
        {inputMode === 'brush' && (
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
          {inputMode === 'lasso' && (
            <ul className="rcs-tips">
              <li>원하는 영역을 대충 둘러싸세요</li>
              <li>드래그로 자유형 경계선 그리기</li>
              <li>SAM이 정밀 마스크를 자동 생성</li>
              <li>휠: 줌 / 가운데 버튼: 이동</li>
            </ul>
          )}
          {inputMode === 'point' && (
            <ul className="rcs-tips">
              <li><span className="tip-dot positive" /> 좌클릭: 선택할 영역</li>
              <li><span className="tip-dot negative" /> 우클릭: 제외할 영역</li>
              <li>여러 번 클릭해 영역을 정밀화</li>
              <li>휠: 줌 / 가운데 버튼: 이동</li>
            </ul>
          )}
          {inputMode === 'box' && (
            <ul className="rcs-tips">
              <li>드래그로 사각형 영역 그리기</li>
              <li>문, 창문 등 사각형 객체에 최적</li>
              <li>SAM Box Prompt로 직접 입력</li>
              <li>휠: 줌 / 가운데 버튼: 이동</li>
            </ul>
          )}
          {inputMode === 'brush' && (
            <ul className="rcs-tips">
              <li><span className="tip-brush-add">◉</span> 좌클릭 드래그: 영역 추가</li>
              <li><span className="tip-brush-remove">◉</span> 우클릭 / Alt+드래그: 영역 제외</li>
              <li>여러 번 긁으면 선택 영역이 확장됩니다</li>
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
                >×</button>
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
          {samError && <div className="rcs-error-banner">{samError}</div>}

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
              {inputMode === 'point' && pointMarkers}
            </div>

            {/* Layer 4a: lasso overlay */}
            {canvasSize.w > 0 && (
              <LassoSelector
                canvasSize={canvasSize}
                zoom={zoom}
                lassoMode={inputMode === 'lasso'}
                disabled={isEncoding || isModelLoading || isSegmenting}
                onLassoEnd={handleLassoEnd}
              />
            )}

            {/* Layer 4b: box drag overlay */}
            {canvasSize.w > 0 && (
              <BoxDragSelector
                canvasSize={canvasSize}
                zoom={zoom}
                boxMode={inputMode === 'box'}
                disabled={isEncoding || isModelLoading || isSegmenting}
                onBoxEnd={handleBoxEnd}
              />
            )}

            {/* Layer 4c: brush canvas overlay */}
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

            {/* Layer 5: point-mode invisible hit area */}
            <div
              className="rcs-hit-area"
              onClick={handleCanvasClick}
              onContextMenu={handleContextMenu}
              role="button"
              tabIndex={0}
              aria-label="이미지 클릭으로 영역 선택"
              style={{
                cursor: inputMode === 'point'
                  ? (isEncoding || isModelLoading || isSegmenting ? 'wait' : 'crosshair')
                  : 'default',
                pointerEvents: inputMode === 'point' ? 'auto' : 'none',
                position: 'absolute',
                top: 0,
                left: 0,
                width:  canvasSize.w,
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
              ) : currentMaskSet ? (
                <>
                  영역이 선택됐습니다.
                  {inputMode === 'point' && ' 클릭을 추가하거나 확정하세요.'}
                  {inputMode === 'brush' && strokeCountRef.current > 0 && (
                    <span className="rcs-stroke-badge">
                      {strokeCountRef.current}회 스트로크
                    </span>
                  )}
                </>
              ) : (
                <>클릭 포인트가 추가됐습니다.</>
              )}
            </div>

            {/* Mask size selector — only when SAM returned multiple candidates */}
            {currentMaskSet && hasMultiMasks && (
              <div className="rcs-mask-size-row">
                <MaskSizeSelector
                  masks={currentMaskSet.masks}
                  scores={currentMaskSet.scores}
                  selectedIdx={selectedMaskIdx}
                  bestIndex={currentMaskSet.bestIndex}
                  onSelect={setSelectedMaskIdx}
                />
              </div>
            )}

            <div className="rcs-action-buttons">
              <button className="btn btn-secondary" onClick={handleCancel}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={!currentMaskSet || isSegmenting}
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
