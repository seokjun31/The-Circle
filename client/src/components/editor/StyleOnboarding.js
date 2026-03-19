/**
 * StyleOnboarding — "분위기 먼저 설정" step shown before the chat editor.
 *
 * Step A (select):
 *   - Original room image (top)
 *   - Style preset cards (from API, horizontal scroll)
 *   - OR: drag-and-drop reference image upload
 *   - Strength slider
 *   - "변환하기" + "건너뛰기" buttons
 *
 * Step B (result):
 *   - Before / After compare slider
 *   - "다시 선택" + "이렇게 할게요 →" buttons
 *
 * Props:
 *   projectId       {number}
 *   imageUrl        {string}   original room image
 *   creditBalance   {number}
 *   onDone          {Function} (result | null) → enter chat editor
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import { getStylePresets, applyCircleAI, copyMood } from '../../utils/api';
import './StyleOnboarding.css';

const CREDITS_COST = 5;

// Fallback gradient thumbnails (used when preset has no referenceImageUrl)
const STYLE_GRAD = {
  modern:        'linear-gradient(135deg,#e8e8e8,#b0b0b0)',
  scandinavian:  'linear-gradient(135deg,#f5f0e8,#c8b89a)',
  classic:       'linear-gradient(135deg,#f0e6d2,#8b6914)',
  industrial:    'linear-gradient(135deg,#4a4a4a,#8b7355)',
  korean_modern: 'linear-gradient(135deg,#f5e6c8,#d4956a)',
  japanese:      'linear-gradient(135deg,#e8f0e8,#7a9e7e)',
  coastal:       'linear-gradient(135deg,#d0e8f5,#4a90c4)',
  art_deco:      'linear-gradient(135deg,#1a1a2e,#c9a227)',
};

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export default function StyleOnboarding({ projectId, imageUrl, creditBalance, onDone }) {
  const [step,          setStep]          = useState('select');   // 'select' | 'result'
  const [presets,       setPresets]       = useState([]);
  const [selected,      setSelected]      = useState(null);      // preset object | null
  const [refDataUrl,    setRefDataUrl]    = useState(null);      // uploaded reference
  const [refPreview,    setRefPreview]    = useState(null);
  const [isDragging,    setIsDragging]    = useState(false);
  const [strength,      setStrength]      = useState(0.65);
  const [loading,       setLoading]       = useState(false);
  const [resultUrl,     setResultUrl]     = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    getStylePresets()
      .then((data) => setPresets(data.filter((p) => !p.isUserPreset)))
      .catch(() => {});
  }, []);

  // ── Reference image handling ────────────────────────────────────────────────
  const handleFile = useCallback(async (file) => {
    if (!file?.type.startsWith('image/')) { toast.error('이미지만 가능합니다.'); return; }
    const url = await fileToDataURL(file);
    setRefPreview(url);
    setRefDataUrl(url);
    setSelected(null);   // deselect preset when reference image is chosen
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false);
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  // ── Apply ───────────────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    if (!selected && !refDataUrl) { toast.error('스타일 또는 참조 이미지를 선택해주세요.'); return; }
    if ((creditBalance ?? 0) < CREDITS_COST) { toast.error(`크레딧이 부족합니다. (잔액: ${creditBalance ?? 0}, 필요: ${CREDITS_COST})`); return; }

    setLoading(true);
    try {
      let result;
      if (refDataUrl) {
        result = await copyMood(projectId, { referenceImage: refDataUrl, strength });
      } else {
        result = await applyCircleAI(projectId, { stylePreset: selected.id, strength });
      }
      setResultUrl(result.result_url);
      setStep('result');
    } catch (err) {
      toast.error('변환 실패: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, selected, refDataUrl, strength, creditBalance]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (step === 'result') {
    return (
      <div className="so-root">
        <div className="so-result-header">
          <p className="so-result-title">변환이 완료됐어요! 어떠세요?</p>
          <p className="so-result-sub">슬라이더를 드래그해서 비교해보세요</p>
        </div>

        <div className="so-compare-wrap">
          <ReactCompareSlider
            itemOne={<ReactCompareSliderImage src={imageUrl} alt="원본" />}
            itemTwo={<ReactCompareSliderImage src={resultUrl} alt="변환" />}
            style={{ width: '100%', height: '100%', borderRadius: '12px', overflow: 'hidden' }}
          />
        </div>

        <div className="so-result-actions">
          <button
            className="so-btn so-btn--ghost"
            onClick={() => { setResultUrl(null); setStep('select'); }}
          >
            ← 다시 선택
          </button>
          <button
            className="so-btn so-btn--primary"
            onClick={() => onDone({ result_url: resultUrl })}
          >
            이렇게 할게요 →
          </button>
        </div>
      </div>
    );
  }

  // ── Step: select ─────────────────────────────────────────────────────────────
  return (
    <div className="so-root">

      {/* Original image preview */}
      <div className="so-orig-wrap">
        {imageUrl
          ? <img className="so-orig-img" src={imageUrl} alt="원본 방" />
          : <div className="so-orig-placeholder"><span className="spinner" /></div>
        }
      </div>

      <div className="so-body">
        {/* ── Style preset cards ──────────────────────────────────────────── */}
        <section className="so-section">
          <h3 className="so-section-title">스타일 선택</h3>
          <div className="so-preset-row">
            {presets.map((p) => (
              <button
                key={p.dbId || p.id}
                className={`so-preset-card ${selected?.id === p.id && !refDataUrl ? 'selected' : ''}`}
                onClick={() => { setSelected(p); setRefDataUrl(null); setRefPreview(null); }}
              >
                {p.referenceImageUrl ? (
                  <img className="so-preset-thumb" src={p.referenceImageUrl} alt={p.label} />
                ) : (
                  <div className="so-preset-thumb" style={{ background: STYLE_GRAD[p.id] || '#2a2a4a' }} />
                )}
                <span className="so-preset-label">{p.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* ── Reference image upload ──────────────────────────────────────── */}
        <section className="so-section">
          <h3 className="so-section-title">또는 참조 이미지 업로드</h3>
          <p className="so-section-sub">"이런 느낌으로 바꿔주세요" — 원하는 인테리어 사진을 올려주세요</p>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files[0])}
          />

          {refPreview ? (
            <div className="so-ref-preview-wrap">
              <img className="so-ref-preview" src={refPreview} alt="참조 이미지" />
              <button
                className="so-ref-remove"
                onClick={() => { setRefDataUrl(null); setRefPreview(null); }}
              >✕ 제거</button>
            </div>
          ) : (
            <div
              className={`so-dropzone ${isDragging ? 'dragging' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <span className="so-drop-icon">📎</span>
              <span>이미지를 드래그하거나 클릭해서 업로드</span>
            </div>
          )}
        </section>

        {/* ── Strength slider ─────────────────────────────────────────────── */}
        <section className="so-section so-strength-section">
          <h3 className="so-section-title">
            변환 강도
            <span className="so-strength-val">{Math.round(strength * 100)}%</span>
          </h3>
          <input
            type="range"
            className="so-slider"
            min="0.3" max="0.85" step="0.05"
            value={strength}
            onChange={(e) => setStrength(parseFloat(e.target.value))}
          />
          <div className="so-slider-labels">
            <span>원본 유지</span>
            <span>강한 변환</span>
          </div>
        </section>

        {/* ── CTA ─────────────────────────────────────────────────────────── */}
        <div className="so-cta">
          <button className="so-btn so-btn--ghost" onClick={() => onDone(null)}>
            건너뛰기
          </button>
          <button
            className="so-btn so-btn--primary"
            onClick={handleApply}
            disabled={loading || (!selected && !refDataUrl)}
          >
            {loading
              ? <><span className="spinner so-spinner" /> 변환 중...</>
              : `변환하기 (${CREDITS_COST} 크레딧)`
            }
          </button>
        </div>

        {/* Credit hint */}
        <p className="so-credit-hint">
          💎 잔여 크레딧: <strong>{creditBalance ?? '—'}</strong>
        </p>
      </div>
    </div>
  );
}
