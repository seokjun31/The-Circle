/**
 * StyleOnboarding — "분위기 먼저 설정" step
 *
 * SELECT step:
 *   3-column hero: [원본 이미지] → [참조 이미지 업로드] → [AI 변환 예시 animated]
 *   + Style preset cards (horizontal scroll)
 *   + Strength slider
 *   + "건너뛰기" / "변환하기" buttons
 *
 * RESULT step:
 *   Compact Before/After slider (max 360px)
 *   3 free retries counter (UI only, decrements per retry)
 *   "← 다시 해볼게요" / "이렇게 할게요 →"
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import { getStylePresets, applyCircleAI, copyMood } from '../../utils/api';
import './StyleOnboarding.css';

const CREDITS_COST  = 5;
const MAX_RETRIES   = 3;

const STYLE_GRAD = {
  modern:        'linear-gradient(135deg,#e8e8e8 0%,#b0b0b0 100%)',
  scandinavian:  'linear-gradient(135deg,#f5f0e8 0%,#c8b89a 100%)',
  classic:       'linear-gradient(135deg,#f0e6d2 0%,#8b6914 100%)',
  industrial:    'linear-gradient(135deg,#4a4a4a 0%,#8b7355 100%)',
  korean_modern: 'linear-gradient(135deg,#f5e6c8 0%,#d4956a 100%)',
  japanese:      'linear-gradient(135deg,#e8f0e8 0%,#7a9e7e 100%)',
  coastal:       'linear-gradient(135deg,#d0e8f5 0%,#4a90c4 100%)',
  art_deco:      'linear-gradient(135deg,#1a1a2e 0%,#c9a227 100%)',
};

const PREVIEW_HINTS = [
  '"재팬디 스타일로 바꿔줘"',
  '"따뜻한 분위기로 변환해줘"',
  '"모던하고 깔끔하게"',
  '"스칸디나비안 느낌으로"',
];

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/** Animated right preview column shown before transform */
function AiPreviewColumn({ selectedPreset, refPreview }) {
  const src = refPreview || selectedPreset?.referenceImageUrl || null;
  return (
    <div className="so-col so-col--right">
      <div className="so-preview-magic">
        {src ? (
          <img className="so-preview-img" src={src} alt="참조 스타일" />
        ) : (
          <div className="so-preview-anim">
            <div className="so-anim-orb so-anim-orb--1" />
            <div className="so-anim-orb so-anim-orb--2" />
            <div className="so-anim-orb so-anim-orb--3" />
            <div className="so-anim-particles">
              {[...Array(8)].map((_, i) => (
                <div key={i} className={`so-particle so-particle--${i + 1}`} />
              ))}
            </div>
          </div>
        )}
        <div className="so-preview-overlay">
          <span className="so-preview-icon">✨</span>
          <p className="so-preview-text">멋진 공간이<br />완성됩니다</p>
        </div>
      </div>
      <span className="so-col-label">AI 변환 결과</span>
    </div>
  );
}

export default function StyleOnboarding({ projectId, imageUrl, creditBalance, onDone }) {
  const [step,         setStep]         = useState('select');
  const [presets,      setPresets]      = useState([]);
  const [selected,     setSelected]     = useState(null);
  const [refDataUrl,   setRefDataUrl]   = useState(null);
  const [refPreview,   setRefPreview]   = useState(null);
  const [isDragging,   setIsDragging]   = useState(false);
  const [strength,     setStrength]     = useState(0.65);
  const [loading,      setLoading]      = useState(false);
  const [resultUrl,    setResultUrl]    = useState(null);
  const [retriesLeft,  setRetriesLeft]  = useState(MAX_RETRIES);
  // Params for retry (so we re-apply with same settings)
  const lastParams = useRef(null);
  const fileRef    = useRef(null);

  useEffect(() => {
    getStylePresets()
      .then((data) => setPresets(data.filter((p) => !p.isUserPreset)))
      .catch(() => {});
  }, []);

  const handleFile = useCallback(async (file) => {
    if (!file?.type.startsWith('image/')) { toast.error('이미지만 가능합니다.'); return; }
    const url = await fileToDataURL(file);
    setRefPreview(url);
    setRefDataUrl(url);
    setSelected(null);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false);
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  // ── Core apply (shared by first apply + retries) ────────────────────────────
  const runTransform = useCallback(async (params) => {
    setLoading(true);
    try {
      let result;
      if (params.refDataUrl) {
        result = await copyMood(projectId, { referenceImage: params.refDataUrl, strength: params.strength });
      } else {
        result = await applyCircleAI(projectId, { stylePreset: params.presetId, strength: params.strength });
      }
      setResultUrl(result.result_url);
      setStep('result');
    } catch (err) {
      toast.error('변환 실패: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const handleApply = useCallback(async () => {
    if (!selected && !refDataUrl) { toast.error('스타일 또는 참조 이미지를 선택해주세요.'); return; }
    if ((creditBalance ?? 0) < CREDITS_COST) { toast.error(`크레딧 부족 (잔액: ${creditBalance ?? 0})`); return; }
    const params = { refDataUrl, presetId: selected?.id, strength };
    lastParams.current = params;
    setRetriesLeft(MAX_RETRIES);
    await runTransform(params);
  }, [selected, refDataUrl, strength, creditBalance, runTransform]);

  const handleRetry = useCallback(async () => {
    if (retriesLeft <= 0) return;
    setRetriesLeft((n) => n - 1);
    await runTransform(lastParams.current);
  }, [retriesLeft, runTransform]);

  // ── RESULT step ─────────────────────────────────────────────────────────────
  if (step === 'result') {
    return (
      <div className="h-full flex flex-col gap-6 p-6 bg-surface-container-lowest">

        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span
                className="material-symbols-outlined text-primary text-2xl"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                auto_awesome
              </span>
              <h2 className="font-headline text-2xl font-bold text-white tracking-tight">변환 완료!</h2>
            </div>
            <p className="text-xs text-on-surface-variant ml-9">슬라이더를 드래그해서 비교해보세요</p>
          </div>
          <div className="flex items-center gap-2 bg-surface-container-high px-4 py-2 rounded-full border border-outline-variant/20">
            <span className="text-xs text-on-surface-variant font-medium">재시도</span>
            <div className="flex gap-1.5">
              {[...Array(MAX_RETRIES)].map((_, i) => (
                <span
                  key={i}
                  className={`w-2 h-2 rounded-full transition-all ${i < retriesLeft ? 'bg-primary' : 'bg-outline-variant/40'}`}
                />
              ))}
            </div>
            <span className="text-xs font-bold text-white">{retriesLeft}회 남음</span>
          </div>
        </div>

        {/* Comparison Slider */}
        <div className="flex-1 min-h-0 relative rounded-xl overflow-hidden shadow-2xl border border-outline-variant/20">
          <ReactCompareSlider
            itemOne={<ReactCompareSliderImage src={imageUrl} alt="원본" style={{ objectFit: 'cover' }} />}
            itemTwo={<ReactCompareSliderImage src={resultUrl} alt="AI 변환" style={{ objectFit: 'cover' }} />}
            style={{ width: '100%', height: '100%' }}
          />
          <span className="absolute top-4 left-4 text-xs font-bold uppercase tracking-wider bg-black/50 backdrop-blur-sm px-3 py-1.5 rounded-full text-white border border-white/10">
            원본
          </span>
          <span className="absolute top-4 right-4 text-xs font-bold uppercase tracking-wider bg-primary/20 backdrop-blur-sm px-3 py-1.5 rounded-full text-primary border border-primary/30"
            style={{ boxShadow: '0 0 20px rgba(124, 58, 237, 0.2)' }}
          >
            AI 변환
          </span>
        </div>

        {/* Action Buttons */}
        <div className="flex-shrink-0 flex gap-3">
          <button
            className="flex-1 py-3 px-4 rounded-xl border border-outline-variant/30 text-on-surface-variant hover:text-white hover:border-outline-variant/60 transition-all text-sm font-medium"
            onClick={() => { setResultUrl(null); setStep('select'); }}
          >
            ← 처음부터
          </button>
          <button
            className="flex-1 py-3 px-4 rounded-xl border border-primary/30 text-primary hover:bg-primary/10 transition-all text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            onClick={handleRetry}
            disabled={loading || retriesLeft <= 0}
          >
            {loading
              ? <><span className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />재변환 중...</>
              : retriesLeft > 0 ? `🔄 다시 해볼게요 (${retriesLeft}회)` : '재시도 횟수 소진'
            }
          </button>
          <button
            className="flex-1 py-3 px-6 rounded-xl bg-gradient-to-r from-[#7c3aed] to-primary text-white font-headline font-bold text-sm shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98]"
            onClick={() => onDone({ result_url: resultUrl })}
          >
            이대로 쓸래요 →
          </button>
        </div>
      </div>
    );
  }

  // ── SELECT step ─────────────────────────────────────────────────────────────
  return (
    <div className="so-root">
      {/* ── 3-column hero ─────────────────────────────────────────────────── */}
      <div className="so-hero">
        {/* Col 1: original room */}
        <div className="so-col so-col--left">
          <div className="so-orig-frame">
            {imageUrl
              ? <img className="so-orig-img" src={imageUrl} alt="원본 방" />
              : <div className="so-orig-skeleton"><span className="spinner" /></div>
            }
            <div className="so-col-badge so-col-badge--orig">원본</div>
          </div>
          <span className="so-col-label">현재 내 방</span>
        </div>

        {/* Arrow 1 */}
        <div className="so-hero-arrow">
          <div className="so-arrow-line" />
          <span className="so-arrow-tip">▶</span>
          <span className="so-arrow-hint">스타일 선택</span>
        </div>

        {/* Col 2: reference image upload */}
        <div className="so-col so-col--mid">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files[0])}
          />
          {refPreview ? (
            <div className="so-ref-frame">
              <img className="so-ref-img" src={refPreview} alt="참조 이미지" />
              <div className="so-col-badge so-col-badge--ref">참조</div>
              <button className="so-ref-remove" onClick={() => { setRefDataUrl(null); setRefPreview(null); }}>✕</button>
            </div>
          ) : (
            <div
              className={`so-dropzone-frame ${isDragging ? 'dragging' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <span className="so-drop-icon">📎</span>
              <p className="so-drop-text">참조 이미지 업로드</p>
              <p className="so-drop-sub">이런 느낌으로 바꿔주세요</p>
            </div>
          )}
          <span className="so-col-label">참조 이미지</span>
        </div>

        {/* Arrow 2 */}
        <div className="so-hero-arrow">
          <div className="so-arrow-line" />
          <span className="so-arrow-tip">▶</span>
          <span className="so-arrow-hint">AI 변환</span>
        </div>

        {/* Col 3: AI result preview */}
        <AiPreviewColumn selectedPreset={selected} refPreview={refPreview} />
      </div>

      {/* ── Body: presets + controls ──────────────────────────────────────── */}
      <div className="so-body">
        {/* Preset cards */}
        <section className="so-section">
          <h3 className="so-section-title">스타일 선택 <span className="so-section-sub">(하나를 선택하거나 위에 이미지를 직접 올려주세요)</span></h3>
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
                {selected?.id === p.id && !refDataUrl && <span className="so-preset-check">✓</span>}
              </button>
            ))}
          </div>
        </section>

        {/* Strength */}
        <section className="so-section so-strength-row">
          <label className="so-section-title">
            변환 강도
            <span className="so-strength-val">{Math.round(strength * 100)}%</span>
          </label>
          <input
            type="range" className="so-slider"
            min="0.3" max="0.85" step="0.05"
            value={strength}
            onChange={(e) => setStrength(parseFloat(e.target.value))}
          />
          <div className="so-slider-labels"><span>원본 유지</span><span>강한 변환</span></div>
        </section>

        {/* CTA */}
        <div className="so-cta">
          <button className="so-btn so-btn--ghost" onClick={() => onDone(null)}>건너뛰기</button>
          <button
            className="so-btn so-btn--primary"
            onClick={handleApply}
            disabled={loading || (!selected && !refDataUrl)}
          >
            {loading
              ? <><span className="spinner so-spinner" /> AI 변환 중...</>
              : `✨ 변환하기 (${CREDITS_COST} 크레딧)`
            }
          </button>
        </div>
        <p className="so-credit-hint">💎 잔여 크레딧: <strong>{creditBalance ?? '—'}</strong></p>
      </div>
    </div>
  );
}
