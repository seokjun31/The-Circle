import React, { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { getFurnitureList, uploadFurnitureImage } from '../../utils/api';
import './FurniturePanel.css';

const CATEGORIES = [
  { id: '',          label: '전체' },
  { id: 'sofa',      label: '소파' },
  { id: 'table',     label: '테이블' },
  { id: 'chair',     label: '의자' },
  { id: 'bed',       label: '침대' },
  { id: 'shelf',     label: '선반' },
  { id: 'desk',      label: '책상' },
  { id: 'lighting',  label: '조명' },
  { id: 'etc',       label: '기타' },
];

function FurnitureCard({ furniture, selected, onSelect }) {
  return (
    <button
      className={`fp-card ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(furniture)}
      title={`${furniture.name}${furniture.brand ? ` — ${furniture.brand}` : ''}`}
    >
      <div className="fp-card-img-wrap">
        {furniture.thumbnail_url || furniture.image_url ? (
          <img
            src={furniture.thumbnail_url || furniture.image_url}
            alt={furniture.name}
            className="fp-card-img"
          />
        ) : (
          <div className="fp-card-placeholder">🪑</div>
        )}
      </div>
      <div className="fp-card-info">
        <span className="fp-card-name">{furniture.name}</span>
        {furniture.brand && (
          <span className="fp-card-brand">{furniture.brand}</span>
        )}
        {furniture.width_cm && (
          <span className="fp-card-dims">
            {furniture.width_cm}
            {furniture.height_cm ? ` × ${furniture.height_cm}` : ''}
            {furniture.depth_cm ? ` × ${furniture.depth_cm}` : ''} cm
          </span>
        )}
      </div>
    </button>
  );
}

function FurniturePanel({ selectedFurniture, onSelect }) {
  const [category, setCategory]         = useState('');
  const [search, setSearch]             = useState('');
  const [items, setItems]               = useState([]);
  const [loading, setLoading]           = useState(false);
  const [page, setPage]                 = useState(1);
  const [totalPages, setTotalPages]     = useState(1);

  // Custom furniture upload state
  const [showUploadForm, setShowUpload] = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [customFile, setCustomFile]     = useState(null);
  const [customPreview, setCustomPreview] = useState(null);
  const [customWidthCm, setCustomW]     = useState('');
  const [customHeightCm, setCustomH]    = useState('');
  const [customName, setCustomName]     = useState('');

  const fileInputRef = useRef(null);
  const searchTimer  = useRef(null);

  const fetchFurniture = async (params = {}) => {
    setLoading(true);
    try {
      const result = await getFurnitureList({
        category:  params.category ?? category,
        search:    params.search   ?? search,
        page:      params.page     ?? page,
        pageSize:  16,
      });
      setItems(result.items || []);
      setTotalPages(result.total_pages || 1);
    } catch (err) {
      toast.error('가구 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchFurniture(); }, []); // eslint-disable-line

  const handleCategoryChange = (cat) => {
    setCategory(cat);
    setPage(1);
    fetchFurniture({ category: cat, page: 1 });
  };

  const handleSearchChange = (val) => {
    setSearch(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setPage(1);
      fetchFurniture({ search: val, page: 1 });
    }, 400);
  };

  const handlePageChange = (p) => {
    setPage(p);
    fetchFurniture({ page: p });
  };

  // ── Custom upload ──────────────────────────────────────────────────────────

  const handleCustomFileChange = (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('이미지 파일만 업로드 가능합니다.');
      return;
    }
    setCustomFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setCustomPreview(e.target.result);
    reader.readAsDataURL(file);
    if (!customName) setCustomName(file.name.replace(/\.[^.]+$/, ''));
  };

  const handleCustomUpload = async () => {
    if (!customFile) {
      toast.error('이미지를 먼저 선택해주세요.');
      return;
    }
    setUploading(true);
    try {
      const result = await uploadFurnitureImage(customFile);
      // Create a virtual furniture object for the placer
      const virtualFurniture = {
        id:                 null,
        name:               customName || '커스텀 가구',
        image_url:          result.furniture_image_url,
        thumbnail_url:      customPreview,
        width_cm:           customWidthCm ? parseFloat(customWidthCm) : null,
        height_cm:          customHeightCm ? parseFloat(customHeightCm) : null,
        isCustom:           true,
        furniture_image_url: result.furniture_image_url,
      };
      onSelect(virtualFurniture);
      setShowUpload(false);
      toast.success('커스텀 가구가 준비되었습니다.');
    } catch (err) {
      toast.error(err.message || '업로드에 실패했습니다.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="furniture-panel">
      {/* Search bar */}
      <div className="fp-search-wrap">
        <input
          type="text"
          className="fp-search"
          placeholder="가구 이름 / 브랜드 검색..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      {/* Category tabs */}
      <div className="fp-categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`fp-cat-btn ${category === c.id ? 'active' : ''}`}
            onClick={() => handleCategoryChange(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Custom upload toggle */}
      <button
        className="fp-upload-btn btn btn-secondary btn-sm"
        onClick={() => setShowUpload(!showUploadForm)}
      >
        {showUploadForm ? '↑ 닫기' : '📷 직접 업로드'}
      </button>

      {/* Custom upload form */}
      {showUploadForm && (
        <div className="fp-upload-form card">
          <h4>커스텀 가구 업로드</h4>
          <p className="text-muted" style={{ fontSize: '0.8rem' }}>
            배경이 제거된 PNG 권장 (최대 10 MB)
          </p>

          <div
            className={`fp-upload-dropzone ${customPreview ? 'has-image' : ''}`}
            onClick={() => fileInputRef.current?.click()}
          >
            {customPreview ? (
              <img src={customPreview} alt="미리보기" className="fp-upload-preview" />
            ) : (
              <div className="fp-upload-placeholder">
                <span>📦</span>
                <span>클릭하여 이미지 선택</span>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => handleCustomFileChange(e.target.files[0])}
          />

          <input
            type="text"
            placeholder="가구 이름 (선택)"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
          />
          <div className="fp-dim-row">
            <input
              type="number"
              placeholder="너비 (cm)"
              value={customWidthCm}
              onChange={(e) => setCustomW(e.target.value)}
              min="1"
            />
            <span>×</span>
            <input
              type="number"
              placeholder="높이 (cm)"
              value={customHeightCm}
              onChange={(e) => setCustomH(e.target.value)}
              min="1"
            />
          </div>

          <button
            className="btn btn-primary w-full"
            onClick={handleCustomUpload}
            disabled={uploading || !customFile}
          >
            {uploading ? <><span className="spinner" /> 업로드 중...</> : '배치 준비'}
          </button>
        </div>
      )}

      {/* Furniture grid */}
      {loading ? (
        <div className="fp-loading">
          <div className="spinner spinner-lg" />
        </div>
      ) : items.length === 0 ? (
        <div className="fp-empty">
          <p>검색 결과가 없습니다.</p>
          <p className="text-muted" style={{ fontSize: '0.8rem' }}>
            직접 업로드를 이용해보세요.
          </p>
        </div>
      ) : (
        <div className="fp-grid">
          {items.map((furn) => (
            <FurnitureCard
              key={furn.id}
              furniture={furn}
              selected={selectedFurniture?.id === furn.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="fp-pagination">
          <button
            className="btn btn-secondary btn-sm"
            disabled={page <= 1}
            onClick={() => handlePageChange(page - 1)}
          >
            ←
          </button>
          <span className="fp-page-info">{page} / {totalPages}</span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={page >= totalPages}
            onClick={() => handlePageChange(page + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}

export default FurniturePanel;
