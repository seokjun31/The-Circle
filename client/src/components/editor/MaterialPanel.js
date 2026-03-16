/**
 * MaterialPanel — 자재 선택 및 AI 적용 패널
 *
 * Props:
 *   projectId        {number}   현재 프로젝트 ID
 *   confirmedMasks   {Array}    RoomCanvas에서 확정된 마스크 [{binary, label, color, layerId?}]
 *   originalImageSrc {string}   원본 방 이미지 URL (before)
 *   onApplyComplete  {Function} ({ layerId, resultUrl }) — AI 적용 완료 콜백
 *
 * Features:
 *   - 카테고리별 탭 (벽지, 바닥재, 천장재, 타일, 페인트)
 *   - 스타일 필터 (모던, 클래식, 북유럽, 내추럴, 인더스트리얼)
 *   - 자재 썸네일 그리드 (API 로드)
 *   - 자재 선택 → 마스킹 영역에 Canvas 패턴 즉석 미리보기
 *   - "AI 적용" 버튼 → POST /api/v1/projects/{id}/apply-material
 *   - 진행 중 예상 시간 배너 + 폴링 없는 단순 await (최대 60 s)
 *   - 완료 후 BeforeAfterSlider로 결과 비교
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import toast from 'react-hot-toast';
import api from '../../utils/api';
import BeforeAfterSlider from './BeforeAfterSlider';
import './MaterialPanel.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: 'wallpaper', label: '벽지'  },
  { id: 'flooring',  label: '바닥재' },
  { id: 'ceiling',   label: '천장재' },
  { id: 'tile',      label: '타일'   },
  { id: 'paint',     label: '페인트' },
];

const STYLES = [
  { id: '',            label: '전체'       },
  { id: 'modern',      label: '모던'       },
  { id: 'classic',     label: '클래식'     },
  { id: 'nordic',      label: '북유럽'     },
  { id: 'natural',     label: '내추럴'     },
  { id: 'industrial',  label: '인더스트리얼' },
];

// ─────────────────────────────────────────────────────────────────────────────

function MaterialPanel({
  projectId,
  confirmedMasks = [],
  originalImageSrc,
  onApplyComplete,
}) {
  // ── UI state ──────────────────────────────────────────────────────────────
  const [activeCategory, setActiveCategory] = useState('wallpaper');
  const [activeStyle,    setActiveStyle]    = useState('');
  const [searchQuery,    setSearchQuery]    = useState('');

  // ── Material data ──────────────────────────────────────────────────────────
  const [materials,    setMaterials]    = useState([]);
  const [isLoading,    setIsLoading]    = useState(false);
  const [page,         setPage]         = useState(1);
  const [totalPages,   setTotalPages]   = useState(1);

  // ── Selection + apply state ────────────────────────────────────────────────
  const [selectedMaterial, setSelectedMaterial] = useState(null);
  const [selectedLayerIdx, setSelectedLayerIdx] = useState(0);   // which mask to apply to
  const [isApplying,       setIsApplying]       = useState(false);
  const [resultUrl,        setResultUrl]         = useState(null);

  // Preview canvas
  const previewCanvasRef = useRef(null);
  const previewImgRef    = useRef(null);

  // ── Fetch materials ────────────────────────────────────────────────────────
  const fetchMaterials = useCallback(async (cat, style, q, p) => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        category:  cat,
        page:      p,
        page_size: 20,
      });
      if (style) params.set('style',  style);
      if (q)     params.set('search', q);

      const { data } = await api.get(`/v1/materials?${params}`);
      setMaterials(p === 1 ? data.items : prev => [...prev, ...data.items]);
      setTotalPages(data.total_pages);
    } catch (err) {
      toast.error('자재 목록 로드 실패: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setPage(1);
    setMaterials([]);
    fetchMaterials(activeCategory, activeStyle, searchQuery, 1);
  }, [activeCategory, activeStyle, fetchMaterials]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = useCallback((e) => {
    e.preventDefault();
    setPage(1);
    setMaterials([]);
    fetchMaterials(activeCategory, activeStyle, searchQuery, 1);
  }, [activeCategory, activeStyle, searchQuery, fetchMaterials]);

  const handleLoadMore = useCallback(() => {
    const next = page + 1;
    setPage(next);
    fetchMaterials(activeCategory, activeStyle, searchQuery, next);
  }, [page, activeCategory, activeStyle, searchQuery, fetchMaterials]);

  // ── Material selection → canvas preview ──────────────────────────────────
  const handleSelectMaterial = useCallback((mat) => {
    setSelectedMaterial(mat);
    setResultUrl(null);
    // Draw pattern preview on canvas
    drawPreview(mat.tile_image_url);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const drawPreview = useCallback(async (tileUrl) => {
    const canvas = previewCanvasRef.current;
    const baseImg = previewImgRef.current;
    if (!canvas || !baseImg) return;

    const ctx = canvas.getContext('2d');
    const w   = canvas.width;
    const h   = canvas.height;

    // Draw base room image
    ctx.drawImage(baseImg, 0, 0, w, h);

    // If no masks yet, just show the base image
    if (confirmedMasks.length === 0) return;

    // Load tile image and create a repeating pattern
    const tileImg = new window.Image();
    tileImg.crossOrigin = 'anonymous';
    tileImg.onload = () => {
      const pattern = ctx.createPattern(tileImg, 'repeat');
      if (!pattern) return;

      const mask = confirmedMasks[selectedLayerIdx] || confirmedMasks[0];
      if (!mask?.binary) return;

      // Restore base image, then overlay the pattern only in mask region
      ctx.drawImage(baseImg, 0, 0, w, h);
      ctx.save();
      ctx.globalAlpha = 0.65;

      // Build a clip path from the mask binary
      const imageData = ctx.getImageData(0, 0, w, h);
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width  = w;
      tempCanvas.height = h;
      const tCtx = tempCanvas.getContext('2d');
      tCtx.fillStyle = '#000';
      tCtx.fillRect(0, 0, w, h);

      // Fill white in mask region
      const tmp = tCtx.getImageData(0, 0, w, h);
      for (let i = 0; i < mask.binary.length; i++) {
        if (mask.binary[i]) {
          tmp.data[i * 4]     = 255;
          tmp.data[i * 4 + 1] = 255;
          tmp.data[i * 4 + 2] = 255;
          tmp.data[i * 4 + 3] = 255;
        }
      }
      tCtx.putImageData(tmp, 0, 0);

      // Use the mask canvas as clip
      ctx.drawImage(baseImg, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-atop';
      // Apply mask
      ctx.globalAlpha = 1;
      ctx.drawImage(tempCanvas, 0, 0);

      ctx.restore();

      // Draw pattern over masked area
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      // Re-draw base outside mask (restore non-mask area)
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(baseImg, 0, 0, w, h);
      ctx.restore();
    };
    tileImg.src = tileUrl;
  }, [confirmedMasks, selectedLayerIdx]);

  // Redraw preview when layer selection changes
  useEffect(() => {
    if (selectedMaterial) drawPreview(selectedMaterial.tile_image_url);
  }, [selectedLayerIdx, selectedMaterial, drawPreview]);

  // Sync canvas size when original image loads
  useEffect(() => {
    if (!originalImageSrc) return;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      previewImgRef.current = img;
      const canvas = previewCanvasRef.current;
      if (canvas) {
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
      }
    };
    img.src = originalImageSrc;
  }, [originalImageSrc]);

  // ── AI Apply ──────────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    if (!selectedMaterial) return;
    if (confirmedMasks.length === 0) {
      toast.error('먼저 적용할 영역을 선택해주세요.');
      return;
    }

    const mask = confirmedMasks[selectedLayerIdx] || confirmedMasks[0];
    const layerId = mask?.layerId;

    if (!layerId) {
      toast.error('마스크가 서버에 저장되지 않았습니다. 마스크를 다시 확정해주세요.');
      return;
    }

    setIsApplying(true);
    setResultUrl(null);

    try {
      const { data } = await api.post(
        `/v1/projects/${projectId}/apply-material`,
        {
          layer_id:    layerId,
          material_id: selectedMaterial.id,
        },
        { timeout: 120_000 }   // 2 min timeout (RunPod cold start ≈ 30-60 s)
      );

      setResultUrl(data.result_url);
      toast.success('자재가 성공적으로 적용됐습니다!');
      onApplyComplete?.({ layerId: data.layer_id, resultUrl: data.result_url });
    } catch (err) {
      toast.error('AI 적용 실패: ' + err.message);
    } finally {
      setIsApplying(false);
    }
  }, [selectedMaterial, confirmedMasks, selectedLayerIdx, projectId, onApplyComplete]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="mp-root">
      {/* ── Left column: selection controls ── */}
      <div className="mp-controls">

        {/* Category tabs */}
        <div className="mp-tabs">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              className={`mp-tab ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => { setActiveCategory(cat.id); setSelectedMaterial(null); }}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Style filter */}
        <div className="mp-style-filter">
          {STYLES.map((s) => (
            <button
              key={s.id}
              className={`mp-style-chip ${activeStyle === s.id ? 'active' : ''}`}
              onClick={() => setActiveStyle(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <form className="mp-search" onSubmit={handleSearch}>
          <input
            type="text"
            placeholder="자재명 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="mp-search-input"
          />
          <button type="submit" className="mp-search-btn">검색</button>
        </form>

        {/* Material grid */}
        <div className="mp-grid-wrap">
          {isLoading && materials.length === 0 ? (
            <div className="mp-loading"><span className="spinner" /> 자재 로딩 중...</div>
          ) : materials.length === 0 ? (
            <div className="mp-empty">자재가 없습니다.</div>
          ) : (
            <div className="mp-grid">
              {materials.map((mat) => (
                <MaterialCard
                  key={mat.id}
                  material={mat}
                  selected={selectedMaterial?.id === mat.id}
                  onSelect={handleSelectMaterial}
                />
              ))}
            </div>
          )}

          {page < totalPages && (
            <button
              className="mp-load-more"
              onClick={handleLoadMore}
              disabled={isLoading}
            >
              {isLoading ? <span className="spinner" /> : '더 보기'}
            </button>
          )}
        </div>

        {/* Mask region selector (when multiple masks exist) */}
        {confirmedMasks.length > 1 && (
          <div className="mp-section">
            <h4 className="mp-label">적용 영역</h4>
            <div className="mp-mask-selector">
              {confirmedMasks.map((m, i) => (
                <button
                  key={i}
                  className={`mp-mask-btn ${selectedLayerIdx === i ? 'active' : ''}`}
                  style={{ '--accent': m.color }}
                  onClick={() => setSelectedLayerIdx(i)}
                >
                  <span className="mp-mask-dot" style={{ background: m.color }} />
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Selected material info + apply button */}
        {selectedMaterial && (
          <div className="mp-apply-panel">
            <div className="mp-selected-info">
              <img
                src={selectedMaterial.tile_image_url}
                alt={selectedMaterial.name}
                className="mp-selected-thumb"
              />
              <div>
                <div className="mp-selected-name">{selectedMaterial.name}</div>
                {selectedMaterial.brand && (
                  <div className="mp-selected-brand">{selectedMaterial.brand}</div>
                )}
                {selectedMaterial.tile_width_cm && (
                  <div className="mp-selected-size">
                    {selectedMaterial.tile_width_cm} × {selectedMaterial.tile_height_cm} cm
                  </div>
                )}
              </div>
            </div>

            <button
              className="btn btn-primary mp-apply-btn"
              onClick={handleApply}
              disabled={isApplying || confirmedMasks.length === 0}
            >
              {isApplying ? (
                <>
                  <span className="spinner" />
                  AI 적용 중... (15~30초 소요)
                </>
              ) : (
                '✨ AI로 자재 적용'
              )}
            </button>

            {isApplying && (
              <div className="mp-applying-hint">
                IP-Adapter + ControlNet Depth가 방 구조에 맞게 자재를 배치하고 있습니다.
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Right column: preview canvas + before/after ── */}
      <div className="mp-preview">
        {resultUrl ? (
          <>
            <div className="mp-preview-label">변경 전 / 후 비교</div>
            <BeforeAfterSlider
              beforeSrc={originalImageSrc}
              afterSrc={resultUrl}
              className="mp-slider"
            />
          </>
        ) : (
          <>
            <div className="mp-preview-label">
              {selectedMaterial ? '자재 미리보기 (간략)' : '방 이미지'}
            </div>
            <canvas
              ref={previewCanvasRef}
              className="mp-preview-canvas"
            />
            {!selectedMaterial && (
              <div className="mp-preview-hint">
                자재를 선택하면 영역에 패턴이 미리보기됩니다.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── MaterialCard sub-component ───────────────────────────────────────────────

function MaterialCard({ material, selected, onSelect }) {
  return (
    <button
      className={`mp-card ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(material)}
      title={material.name}
    >
      <div className="mp-card-img-wrap">
        <img
          src={material.tile_image_url}
          alt={material.name}
          loading="lazy"
          className="mp-card-img"
        />
        {selected && <div className="mp-card-check">✓</div>}
      </div>
      <div className="mp-card-name">{material.name}</div>
      {material.brand && <div className="mp-card-brand">{material.brand}</div>}
    </button>
  );
}

export default MaterialPanel;
