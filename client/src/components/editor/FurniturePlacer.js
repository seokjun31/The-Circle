import React, { useState, useRef, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import {
  setReferenceScale,
  pxToCm,
  checkFit,
  fitCategoryLabel,
} from '../../lib/dimensionCalculator';
import { placeFurniture } from '../../utils/api';
import './FurniturePlacer.css';

/**
 * FurniturePlacer
 * ─────────────────
 * Canvas-like div where the user:
 *  1. Sees their room image
 *  2. Drags a selected furniture PNG to position it
 *  3. Resizes furniture (corner handles, aspect-ratio locked)
 *  4. (Optionally) calibrates the scale by clicking 2 reference points
 *  5. Sees a fit-check border (green / yellow / red)
 *  6. Clicks "AI 합성" → result appears in before/after slider
 */

const MIN_FURN_PX = 30;

function FurniturePlacer({
  projectId,
  originalImageUrl,
  furniture,          // { id?, furniture_image_url?, image_url, name, width_cm, height_cm }
  creditBalance,
  onResult,
}) {
  // ── Placement state ────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 50, y: 50 });
  const [size, setSize]         = useState({ w: 200, h: 200 });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragOffset              = useRef({ x: 0, y: 0 });
  const resizeStart             = useRef({ mx: 0, my: 0, w: 0, h: 0 });
  const aspectRatio             = useRef(1);

  // ── Calibration state ──────────────────────────────────────────────────────
  const [calibMode, setCalibMode]   = useState(false);
  const [calibPoints, setCalibPoints] = useState([]);   // [{x,y}] up to 2
  const [calibInput, setCalibInput] = useState('');
  const [pxPerCm, setPxPerCm]       = useState(null);

  // ── Fit check ──────────────────────────────────────────────────────────────
  const [spaceWidthCm, setSpaceWidthCm] = useState('');
  const [fitResult, setFitResult]       = useState(null);

  // ── AI blend state ─────────────────────────────────────────────────────────
  const [blending, setBlending]   = useState(false);
  const [resultUrl, setResultUrl] = useState(null);
  const [layerResult, setLayerResult] = useState(null);

  // ── Container ref (for coordinate mapping) ─────────────────────────────────
  const containerRef = useRef(null);
  const imgRef       = useRef(null);

  // ── Reset when furniture changes ───────────────────────────────────────────
  useEffect(() => {
    setResultUrl(null);
    setFitResult(null);
    if (!furniture) return;
    // Load image to get natural dimensions for initial aspect ratio
    const img  = new Image();
    img.onload = () => {
      aspectRatio.current = img.naturalWidth / img.naturalHeight;
      const initW = 200;
      setSize({ w: initW, h: Math.round(initW / aspectRatio.current) });
      setPos({ x: 50, y: 50 });
    };
    img.src = furniture.image_url || furniture.furniture_image_url || '';
  }, [furniture]);

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  const getRelativePos = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  // ── Fit check update whenever size or calibration changes ─────────────────
  useEffect(() => {
    if (!furniture?.width_cm || !pxPerCm) { setFitResult(null); return; }
    const spaceW = spaceWidthCm ? parseFloat(spaceWidthCm) : pxToCm(size.w, pxPerCm);
    const result = checkFit(furniture.width_cm, spaceW);
    setFitResult(result);
  }, [furniture, size.w, pxPerCm, spaceWidthCm]);

  // ─────────────────────────────────────────────────────────────────────────
  //  Drag
  // ─────────────────────────────────────────────────────────────────────────

  const handleFurnMouseDown = useCallback((e) => {
    if (calibMode) return;
    e.preventDefault();
    const rel = getRelativePos(e);
    dragOffset.current = { x: rel.x - pos.x, y: rel.y - pos.y };
    setDragging(true);
  }, [calibMode, pos, getRelativePos]);

  const handleMouseMove = useCallback((e) => {
    const rel = getRelativePos(e);
    if (dragging) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({
        x: Math.max(0, Math.min(rel.x - dragOffset.current.x, rect.width  - size.w)),
        y: Math.max(0, Math.min(rel.y - dragOffset.current.y, rect.height - size.h)),
      });
    }
    if (resizing) {
      const dx   = rel.x - resizeStart.current.mx;
      const newW = Math.max(MIN_FURN_PX, resizeStart.current.w + dx);
      const newH = Math.round(newW / aspectRatio.current);
      setSize({ w: newW, h: newH });
    }
  }, [dragging, resizing, size, getRelativePos]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
    setResizing(false);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  //  Resize handle
  // ─────────────────────────────────────────────────────────────────────────

  const handleResizeMouseDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const rel = getRelativePos(e);
    resizeStart.current = { mx: rel.x, my: rel.y, w: size.w, h: size.h };
    setResizing(true);
  }, [size, getRelativePos]);

  // ─────────────────────────────────────────────────────────────────────────
  //  Calibration
  // ─────────────────────────────────────────────────────────────────────────

  const handleContainerClick = useCallback((e) => {
    if (!calibMode) return;
    const rel = getRelativePos(e);
    setCalibPoints((prev) => {
      if (prev.length >= 2) return [rel];  // reset
      return [...prev, rel];
    });
  }, [calibMode, getRelativePos]);

  const handleApplyCalibration = () => {
    if (calibPoints.length < 2) {
      toast.error('이미지 위에 두 점을 클릭해주세요.');
      return;
    }
    const dist = parseFloat(calibInput);
    if (!dist || dist <= 0) {
      toast.error('기준 거리(cm)를 올바르게 입력해주세요.');
      return;
    }
    try {
      const { pxPerCm: newPxPerCm } = setReferenceScale(
        calibPoints[0], calibPoints[1], dist
      );
      setPxPerCm(newPxPerCm);
      setCalibMode(false);
      setCalibPoints([]);
      toast.success(`보정 완료: 1 cm = ${newPxPerCm.toFixed(2)} px`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  Convert display coords → original image coords
  // ─────────────────────────────────────────────────────────────────────────

  const getImageCoords = () => {
    const container = containerRef.current;
    const img       = imgRef.current;
    if (!container || !img) return null;

    const cRect = container.getBoundingClientRect();
    const iRect = img.getBoundingClientRect();

    // The image might be letterboxed within the container
    const scaleX = (img.naturalWidth  || iRect.width)  / iRect.width;
    const scaleY = (img.naturalHeight || iRect.height) / iRect.height;

    const imgOffsetX = iRect.left - cRect.left;
    const imgOffsetY = iRect.top  - cRect.top;

    return {
      x:        Math.round((pos.x - imgOffsetX) * scaleX),
      y:        Math.round((pos.y - imgOffsetY) * scaleY),
      widthPx:  Math.round(size.w * scaleX),
      scaleX,
      scaleY,
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  AI blend
  // ─────────────────────────────────────────────────────────────────────────

  const handleBlend = async () => {
    if (!furniture) { toast.error('가구를 먼저 선택해주세요.'); return; }
    if (!projectId) { toast.error('프로젝트를 먼저 생성해주세요.'); return; }
    if ((creditBalance ?? 0) < 3) {
      toast.error(`크레딧이 부족합니다. (잔액: ${creditBalance ?? 0}, 필요: 3)`);
      return;
    }

    const coords = getImageCoords();
    if (!coords) { toast.error('이미지 좌표를 계산할 수 없습니다.'); return; }

    setBlending(true);
    setResultUrl(null);
    try {
      const result = await placeFurniture(projectId, {
        furnitureId:        furniture.id   || null,
        furnitureImageUrl:  furniture.furniture_image_url || furniture.image_url,
        furnitureWidthCm:   furniture.width_cm  || null,
        furnitureHeightCm:  furniture.height_cm || null,
        spaceWidthCm:       spaceWidthCm ? parseFloat(spaceWidthCm) : null,
        positionX:          coords.x,
        positionY:          coords.y,
        targetWidthPx:      coords.widthPx,
      });
      setResultUrl(result.result_url);
      setLayerResult(result);
      if (onResult) onResult(result);
      toast.success(`AI 합성 완료! 남은 크레딧: ${result.remaining_balance}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBlending(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────────────────────────────────

  const furnImgUrl = furniture?.image_url || furniture?.furniture_image_url;
  const borderColor = fitResult?.borderColor || 'transparent';

  return (
    <div className="furniture-placer">
      {/* Toolbar */}
      <div className="fpl-toolbar card">
        {/* Calibration */}
        <div className="fpl-toolbar-group">
          <button
            className={`btn btn-sm ${calibMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setCalibMode(!calibMode); setCalibPoints([]); }}
          >
            📏 {calibMode ? '보정 모드 (클릭 2점)' : '스케일 보정'}
          </button>
          {calibMode && (
            <div className="fpl-calib-input">
              <input
                type="number"
                placeholder="실제 거리 (cm)"
                value={calibInput}
                onChange={(e) => setCalibInput(e.target.value)}
                min="1"
              />
              <button
                className="btn btn-sm btn-primary"
                onClick={handleApplyCalibration}
                disabled={calibPoints.length < 2}
              >
                적용 ({calibPoints.length}/2)
              </button>
            </div>
          )}
          {pxPerCm && (
            <span className="fpl-calib-badge">
              1 cm = {pxPerCm.toFixed(1)} px
            </span>
          )}
        </div>

        {/* Space width input for fit check */}
        {furniture?.width_cm && (
          <div className="fpl-toolbar-group">
            <label className="fpl-label">배치 공간 너비 (cm)</label>
            <input
              type="number"
              className="fpl-space-input"
              placeholder="예: 150"
              value={spaceWidthCm}
              onChange={(e) => setSpaceWidthCm(e.target.value)}
              min="1"
            />
          </div>
        )}

        {/* Fit check badge */}
        {fitResult && (
          <div
            className="fpl-fit-badge"
            style={{ borderColor, color: borderColor }}
          >
            {fitResult.fits ? '✓' : '✗'} {fitCategoryLabel(fitResult.category)}
            {' '}({fitResult.marginCm >= 0 ? '+' : ''}{fitResult.marginCm} cm)
          </div>
        )}

        {/* Furniture info */}
        {furniture && (
          <div className="fpl-furn-info">
            <strong>{furniture.name}</strong>
            {furniture.width_cm && (
              <span> — {furniture.width_cm}{furniture.height_cm ? ` × ${furniture.height_cm}` : ''} cm</span>
            )}
          </div>
        )}
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        className={`fpl-canvas ${calibMode ? 'calib-mode' : ''}`}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchMove={handleMouseMove}
        onTouchEnd={handleMouseUp}
        onClick={handleContainerClick}
      >
        {originalImageUrl ? (
          <img
            ref={imgRef}
            src={originalImageUrl}
            alt="방 사진"
            className="fpl-room-img"
            draggable={false}
          />
        ) : (
          <div className="fpl-empty-room">방 사진이 없습니다</div>
        )}

        {/* Calibration points */}
        {calibPoints.map((pt, i) => (
          <div
            key={i}
            className="fpl-calib-point"
            style={{ left: pt.x, top: pt.y }}
          >
            {i + 1}
          </div>
        ))}
        {calibPoints.length === 2 && (
          <svg className="fpl-calib-line" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <line
              x1={calibPoints[0].x} y1={calibPoints[0].y}
              x2={calibPoints[1].x} y2={calibPoints[1].y}
              stroke="#f1fa8c" strokeWidth="2" strokeDasharray="6,4"
            />
          </svg>
        )}

        {/* Furniture overlay */}
        {furniture && furnImgUrl && (
          <div
            className="fpl-furniture"
            style={{
              left:        pos.x,
              top:         pos.y,
              width:       size.w,
              height:      size.h,
              outline:     `3px solid ${borderColor || 'var(--accent)'}`,
              boxShadow:   fitResult ? `0 0 12px ${borderColor}66` : 'none',
              cursor:      dragging ? 'grabbing' : 'grab',
            }}
            onMouseDown={handleFurnMouseDown}
            onTouchStart={handleFurnMouseDown}
          >
            <img
              src={furnImgUrl}
              alt={furniture.name}
              className="fpl-furniture-img"
              draggable={false}
            />

            {/* Resize handle (bottom-right corner) */}
            <div
              className="fpl-resize-handle"
              onMouseDown={handleResizeMouseDown}
              onTouchStart={handleResizeMouseDown}
            />
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="fpl-bottom card">
        <div className="fpl-size-info">
          <span className="text-muted" style={{ fontSize: '0.8rem' }}>
            크기: {size.w} × {size.h} px
            {pxPerCm && ` (${(size.w / pxPerCm).toFixed(0)} × ${(size.h / pxPerCm).toFixed(0)} cm)`}
          </span>
        </div>

        <div className="fpl-bottom-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { setPos({ x: 50, y: 50 }); setSize({ w: 200, h: Math.round(200 / aspectRatio.current) }); }}
            disabled={!furniture}
          >
            초기화
          </button>
          <button
            className="btn btn-primary btn-lg"
            onClick={handleBlend}
            disabled={blending || !furniture || !originalImageUrl}
          >
            {blending ? (
              <><span className="spinner" /> AI 합성 중...</>
            ) : (
              '✨ AI 합성 (3 크레딧)'
            )}
          </button>
        </div>
      </div>

      {/* Result comparison */}
      {resultUrl && (
        <div className="fpl-result card">
          <p className="fpl-result-label">합성 결과 — 슬라이더로 비교</p>
          <ReactCompareSlider
            className="fpl-compare"
            itemOne={
              <ReactCompareSliderImage
                src={originalImageUrl}
                alt="합성 전"
                style={{ objectFit: 'cover' }}
              />
            }
            itemTwo={
              <ReactCompareSliderImage
                src={resultUrl}
                alt="합성 후"
                style={{ objectFit: 'cover' }}
              />
            }
          />
          {layerResult?.fit_check && (
            <div
              className="fpl-result-fit"
              style={{
                color: layerResult.fit_check.category === 'comfortable' ? '#50fa7b'
                     : layerResult.fit_check.category === 'tight'        ? '#f1fa8c'
                     : '#ff5555'
              }}
            >
              {layerResult.fit_check.fits
                ? `여유 ${layerResult.fit_check.margin_cm} cm — ${fitCategoryLabel(layerResult.fit_check.category)}`
                : `${Math.abs(layerResult.fit_check.margin_cm)} cm 초과 — 들어가지 않음`}
            </div>
          )}
          <div className="fpl-result-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setResultUrl(null)}>다시 배치</button>
            <a href={resultUrl} download="furniture_result.jpg" className="btn btn-outline btn-sm" target="_blank" rel="noreferrer">
              다운로드
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default FurniturePlacer;
