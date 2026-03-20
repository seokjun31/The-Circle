/**
 * RoomCanvas — Interactive image editor canvas with SAM segmentation.
 *
 * Input modes (inputMode):
 *   'lasso'  (default) — Freehand lasso → hybrid Box + Positive + Negative SAM input
 *   'point'            — Left/right-click accumulates foreground/background points
 *   'box'              — Drag to draw a bounding box (SAM box-prompt labels 2/3)
 *   'brush'            — Scribble stroke → arc-length sampled points
 *
 * Multi-select flow:
 *   - Each segmentation result is "staged" via 선택 추가 button (or auto-staged on mode switch)
 *   - Staged masks accumulate in the sidebar list
 *   - Final "완료 (저장)" button uploads all staged masks to server at once
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
import SegmentLabel, { SEGMENT_LABELS, labelColor, labelText } from './SegmentLabel';
import { useSamSegmentation } from '../../hooks/useSamSegmentation';
import { maskToBinary, binaryToPng } from '../../lib/sam/samUtils';
import { cleanMask, fillHoles }      from '../../lib/sam/maskPostProcess';
import { lassoToSamInput }           from '../../lib/sam/lassoToSamInput';
import { segmentByLabel }             from '../../lib/segmentation/segmentRouter';
import { saveMask }                   from '../../utils/api';
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
const QUICK_LABELS = ['wall', 'floor', 'ceiling', 'door'];

const MIN_ZOOM  = 0.5;
const MAX_ZOOM  = 4.0;
const ZOOM_STEP = 0.15;

const BRUSH_MIN  = 10;
const BRUSH_MAX  = 50;
const BRUSH_INIT = 20;

const LARGE_PREV_W = 280;

// ─────────────────────────────────────────────────────────────────────────────

function RoomCanvas({ imageSrc, projectId, onMasksChange, onEncodingChange, className = '', externalMode }) {
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
  const containerRef       = useRef(null); // viewport (wheel events)
  const canvasAreaRef      = useRef(null); // canvas area (size calc)
  const wrapperRef         = useRef(null);
  const imageCanvasRef     = useRef(null);
  const imageElRef         = useRef(null);
  const largePreviewCanvasRef = useRef(null);

  // ── Display dimensions ────────────────────────────────────────────────────
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  // ── Zoom / pan ────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart  = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  // ── Input mode ────────────────────────────────────────────────────────────
  const [inputMode, setInputMode] = useState(externalMode || 'lasso');
  // Sync with external mode prop
  useEffect(() => {
    if (externalMode && externalMode !== inputMode) setInputMode(externalMode);
  }, [externalMode]); // eslint-disable-line
  const [brushSize, setBrushSize] = useState(BRUSH_INIT);
  const strokeCountRef = useRef(0);
  const brushMode = inputMode === 'brush';

  // ── Segmentation state ────────────────────────────────────────────────────
  const [clickPoints,     setClickPoints]     = useState([]);
  const [currentMaskSet,  setCurrentMaskSet]  = useState(null);
  const [selectedMaskIdx, setSelectedMaskIdx] = useState(0);
  const [previewMask,     setPreviewMask]     = useState(null);
  const [pendingLabel,    setPendingLabel]    = useState('wall');

  // Staged masks (accumulated until "완료" is pressed)
  const [stagedMasks,  setStagedMasks]  = useState([]);
  // Undo stack — each entry is a snapshot of stagedMasks before the last stage action
  const [undoStack,    setUndoStack]    = useState([]);
  const [isSaving,     setIsSaving]     = useState(false);

  // ── Area percentage ────────────────────────────────────────────────────────
  const [areaPercentage, setAreaPercentage] = useState(0);

  // Sync selectedMaskIdx to SAM's best guess whenever a new decode arrives.
  useEffect(() => {
    if (currentMaskSet) setSelectedMaskIdx(currentMaskSet.bestIndex);
  }, [currentMaskSet]);

  // ── Notify parent of encoding status ─────────────────────────────────────
  useEffect(() => {
    onEncodingChange?.({ isModelLoading, isEncoding });
  }, [isModelLoading, isEncoding, onEncodingChange]);

  // ── Notify parent when staged masks change ────────────────────────────────
  useEffect(() => {
    onMasksChange?.(stagedMasks);
  }, [stagedMasks, onMasksChange]);

  // ── Load image + run encoder ──────────────────────────────────────────────
  useEffect(() => {
    if (!imageSrc) return;
    let cancelled = false;

    resetEncoding();
    setClickPoints([]);
    setCurrentMaskSet(null);
    setPreviewMask(null);
    setStagedMasks([]);
    setUndoStack([]);
    strokeCountRef.current = 0;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      if (cancelled) return;
      imageElRef.current = img;

      const container = canvasAreaRef.current;
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

  // ── Draw image after canvas dimensions are committed ──────────────────────
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

  // ── Large preview canvas ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = largePreviewCanvasRef.current;
    if (!currentMaskSet || !imageElRef.current || !canvas || canvasSize.w === 0) {
      setAreaPercentage(0);
      return;
    }

    const img    = imageElRef.current;
    const tensor = currentMaskSet.masks[selectedMaskIdx];
    const binary = tensorToBinaryProcessed(tensor, canvasSize.w, canvasSize.h);

    // Compute area %
    let selectedPx = 0;
    for (let i = 0; i < binary.length; i++) selectedPx += binary[i];
    setAreaPercentage((selectedPx / binary.length) * 100);

    const PREV_W = LARGE_PREV_W;
    const PREV_H = Math.max(1, Math.round(PREV_W * canvasSize.h / canvasSize.w));
    canvas.width  = PREV_W;
    canvas.height = PREV_H;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, PREV_W, PREV_H);

    const color = labelColor(pendingLabel);
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);

    const oc   = document.createElement('canvas');
    oc.width   = PREV_W;
    oc.height  = PREV_H;
    const octx = oc.getContext('2d');
    const id   = octx.createImageData(PREV_W, PREV_H);
    const od   = id.data;

    for (let py = 0; py < PREV_H; py++) {
      for (let px = 0; px < PREV_W; px++) {
        const cx = Math.min(Math.round(px * canvasSize.w / PREV_W), canvasSize.w - 1);
        const cy = Math.min(Math.round(py * canvasSize.h / PREV_H), canvasSize.h - 1);
        if (binary[cy * canvasSize.w + cx]) {
          const idx = (py * PREV_W + px) * 4;
          od[idx]     = r;
          od[idx + 1] = g;
          od[idx + 2] = b;
          od[idx + 3] = 255;
        }
      }
    }
    octx.putImageData(id, 0, 0);

    ctx.globalAlpha = 0.42;
    ctx.drawImage(oc, 0, 0);
    ctx.globalAlpha = 1.0;
  }, [currentMaskSet, selectedMaskIdx, pendingLabel, canvasSize]);

  // ── Mode switch: auto-stage current pending mask ──────────────────────────
  const handleSwitchMode = useCallback((nextMode) => {
    if (currentMaskSet) {
      const tensor       = currentMaskSet.masks[selectedMaskIdx];
      const binary       = tensorToBinaryProcessed(tensor, canvasSize.w, canvasSize.h);
      const color        = labelColor(pendingLabel);
      const displayLabel = labelText(pendingLabel);
      const localId      = Date.now();
      setUndoStack(prev => [...prev, stagedMasks]);
      setStagedMasks(prev => [...prev, {
        localId, binary, label: displayLabel, labelId: pendingLabel,
        color, mask_id: null, mask_url: null,
      }]);
    }
    setInputMode(nextMode);
    setClickPoints([]);
    setCurrentMaskSet(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [clearPrevMask, currentMaskSet, selectedMaskIdx, canvasSize, pendingLabel, stagedMasks]);

  // ── Lasso mode ────────────────────────────────────────────────────────────
  const handleLassoEnd = useCallback(async (canvasPoints) => {
    if (isEncoding || isModelLoading) return;
    const img = imageElRef.current;
    if (!img) return;

    const scaleX    = img.naturalWidth  / canvasSize.w;
    const scaleY    = img.naturalHeight / canvasSize.h;
    const imagePath = canvasPoints.map(({ x, y }) => ({ x: x * scaleX, y: y * scaleY }));

    const samPoints = lassoToSamInput(imagePath);
    if (samPoints.length === 0) return;

    const result = await segmentByLabel({
      label:             pendingLabel,
      canvasPoints,
      samInputPoints:    samPoints.map((p) => ({ x: p.x, y: p.y })),
      samInputLabels:    samPoints.map((p) => p.label),
      segmentMultiPoint,
      imageCanvas:       imageCanvasRef.current,
      canvasSize,
    });
    if (result !== null) setCurrentMaskSet(result);
  }, [isEncoding, isModelLoading, canvasSize, pendingLabel, segmentMultiPoint]);

  // ── Box mode ──────────────────────────────────────────────────────────────
  const handleBoxEnd = useCallback(async (canvasBox) => {
    if (isEncoding || isModelLoading) return;
    const img = imageElRef.current;
    if (!img) return;

    const scaleX = img.naturalWidth  / canvasSize.w;
    const scaleY = img.naturalHeight / canvasSize.h;

    const samInputPoints = [
      { x: canvasBox.x_min * scaleX, y: canvasBox.y_min * scaleY },
      { x: canvasBox.x_max * scaleX, y: canvasBox.y_max * scaleY },
    ];
    const boxPath = [
      { x: canvasBox.x_min, y: canvasBox.y_min },
      { x: canvasBox.x_max, y: canvasBox.y_min },
      { x: canvasBox.x_max, y: canvasBox.y_max },
      { x: canvasBox.x_min, y: canvasBox.y_max },
    ];

    const result = await segmentByLabel({
      label:             pendingLabel,
      canvasPoints:      boxPath,
      samInputPoints,
      samInputLabels:    [2, 3],
      segmentMultiPoint,
      imageCanvas:       imageCanvasRef.current,
      canvasSize,
    });
    if (result !== null) setCurrentMaskSet(result);
  }, [isEncoding, isModelLoading, canvasSize, pendingLabel, segmentMultiPoint]);

  // ── Point mode ────────────────────────────────────────────────────────────
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

  // ── Brush mode ────────────────────────────────────────────────────────────
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

  // ── Stage current selection (add to staged list, no server upload yet) ────
  const handleStageSelection = useCallback(() => {
    if (!currentMaskSet) return;

    const tensor       = currentMaskSet.masks[selectedMaskIdx];
    const binary       = tensorToBinaryProcessed(tensor, canvasSize.w, canvasSize.h);
    const color        = labelColor(pendingLabel);
    const displayLabel = labelText(pendingLabel);
    const localId      = Date.now();

    setUndoStack(prev => [...prev, stagedMasks]);
    setStagedMasks(prev => [...prev, {
      localId,
      binary,
      label:   displayLabel,
      labelId: pendingLabel,
      color,
      mask_id: null,
      mask_url: null,
    }]);
    setClickPoints([]);
    setCurrentMaskSet(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [currentMaskSet, selectedMaskIdx, pendingLabel, canvasSize, clearPrevMask, stagedMasks]);

  // ── Undo: restore previous staged masks state ─────────────────────────────
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const newStack = [...undoStack];
    const previous = newStack.pop();
    setUndoStack(newStack);
    setStagedMasks(previous);
  }, [undoStack]);

  // ── Complete: batch upload all staged masks to server ─────────────────────
  const handleComplete = useCallback(async () => {
    if (stagedMasks.length === 0) return;
    setIsSaving(true);
    if (projectId) {
      for (let i = 0; i < stagedMasks.length; i++) {
        const m = stagedMasks[i];
        if (m.mask_id) continue;
        try {
          const pngBlob = await binaryToPng(m.binary, canvasSize.w, canvasSize.h);
          const saved   = await saveMask(projectId, {
            maskBlob:    pngBlob,
            label:       m.labelId,
            customLabel: m.labelId === 'custom' ? m.label : undefined,
            layerOrder:  i,
          });
          setStagedMasks(prev => prev.map(mask =>
            mask.localId === m.localId
              ? { ...mask, mask_id: saved.mask_id, mask_url: saved.mask_url }
              : mask
          ));
        } catch (err) {
          console.error('[RoomCanvas] Mask save failed:', err);
        }
      }
    }
    setIsSaving(false);
    onMasksChange?.(stagedMasks);
  }, [stagedMasks, projectId, canvasSize, onMasksChange]);

  // ── Cancel pending selection ──────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setClickPoints([]);
    setCurrentMaskSet(null);
    setPreviewMask(null);
    clearPrevMask();
    strokeCountRef.current = 0;
  }, [clearPrevMask]);

  // ── Remove individual staged mask ─────────────────────────────────────────
  const handleRemoveMask = useCallback((idx) => {
    setUndoStack(prev => [...prev, stagedMasks]);
    setStagedMasks(prev => prev.filter((_, i) => i !== idx));
  }, [stagedMasks]);

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

  // ── Overlay masks (staged + preview + pending) ────────────────────────────
  const overlayMasks = useMemo(() => {
    const all = [...stagedMasks];

    if (previewMask && !currentMaskSet) {
      const binary = tensorToBinaryProcessed(previewMask, canvasSize.w, canvasSize.h);
      all.push({ binary, label: '', color: labelColor(pendingLabel), preview: true });
    }

    if (currentMaskSet) {
      const tensor = currentMaskSet.masks[selectedMaskIdx];
      const binary = tensorToBinaryProcessed(tensor, canvasSize.w, canvasSize.h);
      all.push({ binary, label: pendingLabel, color: labelColor(pendingLabel) });
    }

    return all;
  }, [stagedMasks, currentMaskSet, selectedMaskIdx, previewMask, pendingLabel, canvasSize]);

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

  const hasSelection  = currentMaskSet !== null || clickPoints.length > 0;
  const hasMultiMasks = currentMaskSet?.masks.length > 1;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className={`room-canvas-root ${className}`}>

      {/* ── Left panel ─────────────────────────────────────────────────── */}
      <div className="room-canvas-sidebar">

        {/* Quick label selector */}
        <div className="rcs-section">
          <h4 className="rcs-title">영역 레이블</h4>
          <div className="rcs-labels">
            {SEGMENT_LABELS.filter((l) => QUICK_LABELS.includes(l.id)).map(({ id, label, color }) => (
              <button
                key={id}
                className={`rcs-label-btn ${pendingLabel === id ? 'active' : ''}`}
                style={{ '--accent': color }}
                onClick={() => setPendingLabel(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Mode toggle */}
        <div className="rcs-section">
          <h4 className="rcs-title">입력 모드</h4>
          <div className="rcs-mode-bar rcs-mode-bar-4">
            <button
              className={`rcs-mode-btn ${inputMode === 'lasso' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('lasso')}
              title="자유형 올가미로 영역 선택 (기본)"
            >
              <span className="rcs-mode-icon">◎</span>올가미
            </button>
            <button
              className={`rcs-mode-btn ${inputMode === 'point' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('point')}
              title="포인트 클릭으로 영역 선택"
            >
              <span className="rcs-mode-icon">⊕</span>포인트
            </button>
            <button
              className={`rcs-mode-btn ${inputMode === 'box' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('box')}
              title="박스 드래그로 영역 선택"
            >
              <span className="rcs-mode-icon">▢</span>박스
            </button>
            <button
              className={`rcs-mode-btn ${inputMode === 'brush' ? 'active' : ''}`}
              onClick={() => handleSwitchMode('brush')}
              title="브러시로 영역을 긁어서 선택"
            >
              <span className="rcs-mode-icon">✏️</span>브러시
            </button>
          </div>
        </div>

        {/* Brush size */}
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

        {/* Staged mask list + 완료 button */}
        {stagedMasks.length > 0 && (
          <div className="rcs-section">
            <h4 className="rcs-title">선택된 영역 ({stagedMasks.length})</h4>
            <div className="rcs-mask-list">
              {stagedMasks.map((m, i) => (
                <div key={m.localId} className="rcs-mask-item">
                  <span className="rcs-mask-dot" style={{ background: m.color }} />
                  <span className="rcs-mask-label">{m.label}</span>
                  {m.mask_id && <span className="rcs-mask-saved" title="저장됨">✓</span>}
                  <button
                    className="rcs-mask-remove"
                    onClick={() => handleRemoveMask(i)}
                    title="제거"
                  >×</button>
                </div>
              ))}
            </div>
            <div className="rcs-undo-row">
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title="이전 단계로"
              >
                ↩ 이전 단계
              </button>
            </div>
            <button
              className="btn btn-complete"
              onClick={handleComplete}
              disabled={isSaving}
            >
              {isSaving ? '저장 중...' : `완료 (${stagedMasks.length}개 저장)`}
            </button>
          </div>
        )}
      </div>

      {/* ── Main canvas area ────────────────────────────────────────────── */}
      <div className="room-canvas-main">

        {/* Viewport row: canvas + large preview panel */}
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

          {/* Canvas area (left) */}
          <div className="rcs-canvas-area" ref={canvasAreaRef}>
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

          {/* Large preview panel (right) */}
          <div className="rcs-live-preview-panel">
            <div className="rcs-live-preview-header">
              <span className="rcs-live-preview-title">미리보기</span>
              {currentMaskSet && !isSegmenting && (
                <span className="rcs-live-preview-pct">
                  {areaPercentage.toFixed(1)}%
                </span>
              )}
            </div>

            {currentMaskSet && !isSegmenting ? (
              <canvas ref={largePreviewCanvasRef} className="rcs-live-preview-canvas" />
            ) : (
              <div className="rcs-live-preview-placeholder">
                {isSegmenting ? (
                  <><span className="spinner spinner-dark" /> 마스크 생성 중...</>
                ) : (
                  <>영역을 선택하면<br />미리보기가 표시됩니다</>
                )}
              </div>
            )}

            {stagedMasks.length > 0 && (
              <div className="rcs-live-preview-staged-count">
                {stagedMasks.length}개 영역 선택됨
              </div>
            )}
          </div>
        </div>

        {/* Action bar (shown when there's a pending selection) */}
        {hasSelection && (
          <div className="rcs-action-bar">

            {/* Status text */}
            <div className="rcs-action-info">
              {isSegmenting ? (
                <><span className="spinner" /> 마스크 생성 중...</>
              ) : !currentMaskSet ? (
                <>클릭 포인트가 추가됐습니다.</>
              ) : null}
            </div>

            {/* Mask size selector */}
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

            {/* Label picker + undo */}
            {currentMaskSet && (
              <div className="rcs-label-row">
                <span className="rcs-label-title">라벨 선택</span>
                <SegmentLabel value={pendingLabel} onChange={setPendingLabel} />
                <div className="rcs-undo-row">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={handleUndo}
                    disabled={undoStack.length === 0}
                    title="이전 선택 단계로 되돌리기"
                  >
                    ↩ 이전 단계 ({undoStack.length})
                  </button>
                </div>
              </div>
            )}

            <div className="rcs-action-buttons">
              <button className="btn btn-secondary" onClick={handleCancel}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={handleStageSelection}
                disabled={!currentMaskSet || isSegmenting || !pendingLabel}
              >
                선택 추가
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default RoomCanvas;
