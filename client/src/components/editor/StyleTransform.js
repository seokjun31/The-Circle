import React, { useState, useEffect } from 'react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import { getStylePresets, applyCircleAI } from '../../utils/api';
import './StyleTransform.css';

// Gradient backgrounds per style (visual hint without actual preview images)
const STYLE_GRADIENTS = {
  modern:        'linear-gradient(135deg, #e8e8e8 0%, #b0b0b0 100%)',
  scandinavian:  'linear-gradient(135deg, #f5f0e8 0%, #c8b89a 100%)',
  classic:       'linear-gradient(135deg, #f0e6d2 0%, #8b6914 100%)',
  industrial:    'linear-gradient(135deg, #4a4a4a 0%, #8b7355 100%)',
  korean_modern: 'linear-gradient(135deg, #f5e6c8 0%, #d4956a 100%)',
  japanese:      'linear-gradient(135deg, #e8f0e8 0%, #7a9e7e 100%)',
  coastal:       'linear-gradient(135deg, #d0e8f5 0%, #4a90c4 100%)',
  art_deco:      'linear-gradient(135deg, #1a1a2e 0%, #c9a227 100%)',
};

const STYLE_ICONS = {
  modern:        '◻',
  scandinavian:  '❄',
  classic:       '♛',
  industrial:    '⚙',
  korean_modern: '🏠',
  japanese:      '⛩',
  coastal:       '🌊',
  art_deco:      '◈',
};

function CreditConfirmModal({ style, strength, creditCost, onConfirm, onCancel }) {
  return (
    <div className="st-modal-overlay" onClick={onCancel}>
      <div className="st-modal" onClick={(e) => e.stopPropagation()}>
        <h3>변환 확인</h3>
        <p className="st-modal-desc">
          <strong>{style?.label}</strong> 스타일로 전체 방을 변환합니다.
        </p>
        <div className="st-modal-info">
          <div className="st-modal-row">
            <span>변환 강도</span>
            <span>{Math.round(strength * 100)}%</span>
          </div>
          <div className="st-modal-row">
            <span>크레딧 차감</span>
            <span className="st-credit-cost">{creditCost} 크레딧</span>
          </div>
        </div>
        <div className="st-modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>취소</button>
          <button className="btn btn-primary" onClick={onConfirm}>변환 시작</button>
        </div>
      </div>
    </div>
  );
}

async function downloadBlob(url, filename) {
  try {
    const res  = await fetch(url);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
  } catch {
    window.open(url, '_blank');
  }
}

function StyleTransform({ projectId, originalImageUrl, creditBalance, onResult }) {
  const [presets, setPresets]           = useState([]);
  const [selectedPreset, setSelected]   = useState(null);
  const [strength, setStrength]         = useState(0.6);
  const [loading, setLoading]           = useState(false);
  const [showConfirm, setShowConfirm]   = useState(false);
  const [resultUrl, setResultUrl]       = useState(null);

  useEffect(() => {
    getStylePresets()
      .then(setPresets)
      .catch(() => toast.error('스타일 목록을 불러오지 못했습니다.'));
  }, []);

  const creditCost = presets[0]?.credits ?? 5;

  const handleTransformClick = () => {
    if (!selectedPreset) {
      toast.error('스타일을 선택해주세요.');
      return;
    }
    if ((creditBalance ?? 0) < creditCost) {
      toast.error(`크레딧이 부족합니다. (잔액: ${creditBalance ?? 0}, 필요: ${creditCost})`);
      return;
    }
    setShowConfirm(true);
  };

  const handleConfirm = async () => {
    setShowConfirm(false);
    setLoading(true);
    setResultUrl(null);
    try {
      const result = await applyCircleAI(projectId, {
        stylePreset: selectedPreset.id,
        strength,
      });
      setResultUrl(result.result_url);
      if (onResult) onResult(result);
      toast.success(`변환 완료! 남은 크레딧: ${result.remaining_balance}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="style-transform">
      {showConfirm && (
        <CreditConfirmModal
          style={selectedPreset}
          strength={strength}
          creditCost={creditCost}
          onConfirm={handleConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      <div className="st-layout">
        {/* Left panel — controls */}
        <div className="st-controls card">
          <div className="st-section">
            <h3 className="st-section-title">스타일 선택</h3>
            <div className="st-preset-grid">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  className={`st-preset-card ${selectedPreset?.id === preset.id ? 'selected' : ''}`}
                  onClick={() => setSelected(preset)}
                >
                  <div
                    className="st-preset-thumb"
                    style={{ background: STYLE_GRADIENTS[preset.id] || '#2a2a4a' }}
                  >
                    <span className="st-preset-icon">{STYLE_ICONS[preset.id] || '◻'}</span>
                  </div>
                  <span className="st-preset-label">{preset.label}</span>
                  <span className="st-preset-desc">{preset.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="st-section">
            <h3 className="st-section-title">
              변환 강도
              <span className="st-strength-value">{Math.round(strength * 100)}%</span>
            </h3>
            <input
              type="range"
              className="st-slider"
              min="0.3"
              max="0.8"
              step="0.05"
              value={strength}
              onChange={(e) => setStrength(parseFloat(e.target.value))}
            />
            <div className="st-slider-labels">
              <span>원본 유지</span>
              <span>강한 변환</span>
            </div>
          </div>

          <div className="st-section st-credit-info">
            <span>잔여 크레딧: <strong>{creditBalance ?? '—'}</strong></span>
            <span>차감 예정: <strong className="text-accent">{creditCost}</strong></span>
          </div>

          <button
            className="btn btn-primary w-full btn-lg"
            onClick={handleTransformClick}
            disabled={loading || !selectedPreset}
          >
            {loading ? (
              <>
                <span className="spinner" />
                AI 변환 중...
              </>
            ) : (
              '✨ 스타일 변환'
            )}
          </button>
        </div>

        {/* Right panel — preview */}
        <div className="st-preview">
          {loading && (
            <div className="st-loading-overlay">
              <div className="spinner spinner-lg" />
              <p>AI가 방 분위기를 변환하고 있습니다...</p>
              <p className="text-muted" style={{ fontSize: '0.85rem' }}>약 20–40초 소요</p>
            </div>
          )}

          {!loading && resultUrl ? (
            <div className="st-result">
              <p className="st-result-label">변환 결과 — 슬라이더로 비교하세요</p>
              <ReactCompareSlider
                className="st-compare-slider"
                itemOne={
                  <ReactCompareSliderImage
                    src={originalImageUrl}
                    alt="변환 전"
                    style={{ objectFit: 'cover' }}
                  />
                }
                itemTwo={
                  <ReactCompareSliderImage
                    src={resultUrl}
                    alt="변환 후"
                    style={{ objectFit: 'cover' }}
                  />
                }
              />
              <div className="st-result-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => { setResultUrl(null); }}
                >
                  다시 설정
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => downloadBlob(resultUrl, 'circle_ai_result.jpg')}
                >
                  다운로드
                </button>
              </div>
            </div>
          ) : !loading && (
            <div className="st-placeholder">
              {originalImageUrl ? (
                <img
                  src={originalImageUrl}
                  alt="원본 방 사진"
                  className="st-original-img"
                />
              ) : (
                <div className="st-empty">
                  <span>방 사진이 없습니다</span>
                </div>
              )}
              {selectedPreset && (
                <div className="st-selected-badge">
                  {selectedPreset.label} 스타일 선택됨
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default StyleTransform;
