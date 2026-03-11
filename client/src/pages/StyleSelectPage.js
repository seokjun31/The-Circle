import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { getMaterials } from '../utils/api';
import { useAppState } from '../hooks/useAppState';
import './StyleSelectPage.css';

const MOODS = [
  {
    id: 'modern',
    label: '모던',
    desc: '깔끔하고 미니멀한 현대적 스타일',
    emoji: '🏙️',
    color: '#7c6af2',
  },
  {
    id: 'natural',
    label: '내추럴',
    desc: '목재와 자연 소재의 따뜻한 스타일',
    emoji: '🌿',
    color: '#50fa7b',
  },
  {
    id: 'luxury',
    label: '럭셔리',
    desc: '고급스럽고 우아한 하이엔드 스타일',
    emoji: '✨',
    color: '#f1fa8c',
  },
  {
    id: 'nordic',
    label: '노르딕',
    desc: '심플하고 기능적인 스칸디나비아 스타일',
    emoji: '❄️',
    color: '#8be9fd',
  },
  {
    id: 'industrial',
    label: '인더스트리얼',
    desc: '노출 콘크리트, 금속 소재의 거친 매력',
    emoji: '🔩',
    color: '#ff79c6',
  },
  {
    id: 'classic',
    label: '클래식',
    desc: '전통적인 고전 유럽 스타일',
    emoji: '🏛️',
    color: '#ffb86c',
  },
];

const MATERIAL_CATEGORIES = ['전체', '바닥재', '벽지', '타일', '가구'];

function StyleSelectPage() {
  const navigate = useNavigate();
  const { state, update } = useAppState();
  const [selectedMood, setSelectedMood] = useState(state.selectedMood || null);
  const [selectedMaterials, setSelectedMaterials] = useState(state.selectedMaterials || []);
  const [materials, setMaterials] = useState([]);
  const [loadingMaterials, setLoadingMaterials] = useState(true);
  const [activeCategory, setActiveCategory] = useState('전체');

  useEffect(() => {
    if (!state.imageId) {
      toast.error('먼저 방 사진을 업로드해주세요.');
      navigate('/');
      return;
    }
    getMaterials()
      .then(setMaterials)
      .catch(() => toast.error('자재 목록을 불러오지 못했습니다.'))
      .finally(() => setLoadingMaterials(false));
  }, [state.imageId, navigate]);

  const filteredMaterials =
    activeCategory === '전체'
      ? materials
      : materials.filter((m) => m.category === activeCategory);

  const toggleMaterial = (m) => {
    setSelectedMaterials((prev) => {
      const exists = prev.find((p) => p.id === m.id);
      if (exists) return prev.filter((p) => p.id !== m.id);
      if (prev.length >= 5) {
        toast.error('자재는 최대 5개까지 선택 가능합니다.');
        return prev;
      }
      return [...prev, m];
    });
  };

  const handleNext = () => {
    if (!selectedMood) {
      toast.error('인테리어 무드를 선택해주세요.');
      return;
    }
    update({ selectedMood, selectedMaterials });
    navigate('/mask');
  };

  return (
    <div className="style-page">
      <div className="page-header">
        <h1>스타일 & 자재 선택</h1>
        <p>원하는 인테리어 분위기와 자재를 선택해주세요.</p>
      </div>

      {/* Mood Section */}
      <section className="section">
        <h2 className="section-title">
          <span className="section-num">1</span>
          인테리어 무드
        </h2>
        <div className="mood-grid">
          {MOODS.map((mood) => (
            <button
              key={mood.id}
              className={`mood-card ${selectedMood === mood.id ? 'selected' : ''}`}
              style={{ '--mood-color': mood.color }}
              onClick={() => setSelectedMood(mood.id)}
            >
              <span className="mood-emoji">{mood.emoji}</span>
              <strong className="mood-label">{mood.label}</strong>
              <p className="mood-desc">{mood.desc}</p>
              {selectedMood === mood.id && (
                <span className="mood-check">✓</span>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* Materials Section */}
      <section className="section">
        <div className="section-header-row">
          <h2 className="section-title">
            <span className="section-num">2</span>
            자재 카탈로그
            <span className="optional-badge">선택사항</span>
          </h2>
          {selectedMaterials.length > 0 && (
            <span className="selected-count">
              {selectedMaterials.length}개 선택됨
            </span>
          )}
        </div>
        <p className="section-desc">
          특정 자재를 지정하면 AI가 해당 텍스처를 참고합니다. (최대 5개)
        </p>

        <div className="category-tabs">
          {MATERIAL_CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`cat-tab ${activeCategory === cat ? 'active' : ''}`}
              onClick={() => setActiveCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        {loadingMaterials ? (
          <div className="loading-overlay">
            <div className="spinner spinner-lg" />
            <p>자재 목록 불러오는 중...</p>
          </div>
        ) : filteredMaterials.length === 0 ? (
          <div className="empty-materials">
            <p>해당 카테고리의 자재가 없습니다.</p>
          </div>
        ) : (
          <div className="materials-grid">
            {filteredMaterials.map((m) => {
              const isSelected = selectedMaterials.find((s) => s.id === m.id);
              return (
                <button
                  key={m.id}
                  className={`material-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleMaterial(m)}
                >
                  <div className="material-img-wrap">
                    {m.imageUrl ? (
                      <img src={m.imageUrl} alt={m.name} />
                    ) : (
                      <div className="material-img-placeholder">🪵</div>
                    )}
                    {isSelected && <div className="material-overlay">✓</div>}
                  </div>
                  <div className="material-info">
                    <span className="material-name">{m.name}</span>
                    <span className="material-cat">{m.category}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Selected materials summary */}
      {selectedMaterials.length > 0 && (
        <div className="selected-summary card">
          <h3>선택된 자재</h3>
          <div className="selected-materials-list">
            {selectedMaterials.map((m) => (
              <div key={m.id} className="selected-material-chip">
                <span>{m.name}</span>
                <button onClick={() => toggleMaterial(m)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="page-actions">
        <button className="btn btn-secondary" onClick={() => navigate('/')}>
          ← 이전
        </button>
        <button
          className="btn btn-primary btn-lg"
          onClick={handleNext}
          disabled={!selectedMood}
        >
          마스킹 단계로 →
        </button>
      </div>
    </div>
  );
}

export default StyleSelectPage;
