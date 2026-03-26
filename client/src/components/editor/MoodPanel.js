/**
 * MoodPanel — Right sidebar panel for Mood tab
 * 참조 이미지 업로드 → 변환하기 → 3회 무료 재시도
 */
import React, { useState, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { copyMood, applyMoodPreset } from '../../utils/api';

const CREDITS_COST = 5;
const MAX_RETRIES  = 3;

const STYLE_PRESETS = [
  { id: 'wood_white',   label: '우드 앤 화이트',    emoji: '🪵' },
  { id: 'mid_century',  label: '미드센추리 모던',   emoji: '🛋️' },
  { id: 'japandi',      label: '재팬디',            emoji: '🎋' },
];

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/**
 * Props:
 *   projectId      — current project
 *   creditBalance  — current credits
 *   onResult       — called with API result (result_url, remaining_balance)
 *   onPhaseChange  — (phase: 'select'|'result', resultUrl?) called on phase transition
 *   phase          — controlled by parent (EditorPage)
 *   resultUrl      — current result URL (from parent)
 *   retriesLeft    — retries remaining (from parent)
 *   setRetries     — setter from parent
 */
export default function MoodPanel({
  projectId,
  creditBalance,
  onResult,
  onPhaseChange,
  onAddToLayout,
  phase,
  retriesLeft,
  setRetries,
}) {
  const [refDataUrl,     setRefDataUrl]     = useState(null);
  const [refPreview,     setRefPreview]     = useState(null);
  const [strength,       setStrength]       = useState(0.65);
  const [loading,        setLoading]        = useState(false);
  const [isDragging,     setIsDragging]     = useState(false);
  const [activePreset,   setActivePreset]   = useState(null);
  const fileRef    = useRef(null);
  const lastParams = useRef(null);

  const handleFile = useCallback(async (file) => {
    if (!file?.type.startsWith('image/')) { toast.error('이미지만 가능합니다.'); return; }
    const url = await fileToDataURL(file);
    setRefPreview(url);
    setRefDataUrl(url);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  const runTransform = useCallback(async (params, isFreeRetry = false) => {
    setLoading(true);
    try {
      const result = await copyMood(projectId, {
        referenceImage: params.refDataUrl,
        strength:       params.strength,
      });
      if (!isFreeRetry) setRetries(MAX_RETRIES);
      else              setRetries(r => r - 1);
      onPhaseChange('result', result.result_url);
      onResult?.(result);
    } catch (err) {
      toast.error('변환 실패: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, onResult, onPhaseChange, setRetries]);

  /* Preset transform */
  const handlePreset = useCallback(async (presetId) => {
    if ((creditBalance ?? 0) < CREDITS_COST) {
      toast.error(`크레딧 부족 (잔액: ${creditBalance ?? 0})`); return;
    }
    setActivePreset(presetId);
    setLoading(true);
    try {
      const result = await applyMoodPreset(projectId, { preset: presetId, strength });
      setRetries(MAX_RETRIES);
      onPhaseChange('result', result.result_url);
      onResult?.(result);
    } catch (err) {
      toast.error('변환 실패: ' + err.message);
    } finally {
      setLoading(false);
      setActivePreset(null);
    }
  }, [projectId, strength, creditBalance, onResult, onPhaseChange, setRetries]);

  /* First paid transform */
  const handleTransform = useCallback(async () => {
    if (!refDataUrl) { toast.error('참조 이미지를 업로드해주세요.'); return; }
    if ((creditBalance ?? 0) < CREDITS_COST) {
      toast.error(`크레딧 부족 (잔액: ${creditBalance ?? 0})`); return;
    }
    const params = { refDataUrl, strength };
    lastParams.current = params;
    await runTransform(params, false);
  }, [refDataUrl, strength, creditBalance, runTransform]);

  /* Free retry: stays in select phase, user adjusts strength, then calls this */
  const handleFreeRetry = useCallback(async () => {
    if (retriesLeft <= 0) return;
    const params = { ...lastParams.current, strength };
    await runTransform(params, true);
  }, [retriesLeft, strength, runTransform]);

  /* ── RESULT phase (minimal — main comparison is in center viewport) ── */
  if (phase === 'result') {
    return (
      <div className="flex flex-col gap-5">

        {/* Retry status */}
        <div className="p-4 bg-surface-container rounded-xl border border-outline-variant/20">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-primary text-base"
              style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
            <p className="text-sm font-bold text-white">변환 완료!</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-on-surface-variant uppercase tracking-widest">재시도</span>
            <div className="flex gap-1.5">
              {[...Array(MAX_RETRIES)].map((_, i) => (
                <span key={i}
                  className={`w-2 h-2 rounded-full transition-all ${
                    i < retriesLeft ? 'bg-primary' : 'bg-outline-variant/40'
                  }`} />
              ))}
            </div>
            <span className="text-[10px] font-bold text-white">{retriesLeft}회 남음</span>
          </div>
        </div>

        {/* Add to layout */}
        <button
          className="w-full py-3 rounded-xl border border-primary/50 text-primary hover:bg-primary/10 transition-all text-sm font-medium flex items-center justify-center gap-2"
          onClick={onAddToLayout}
        >
          <span className="material-symbols-outlined text-base">add_photo_alternate</span>
          레이아웃 추가
        </button>

        {/* Retry: go back to select phase to adjust strength */}
        <button
          className="w-full py-3 rounded-xl border border-outline-variant/30 text-on-surface-variant hover:border-outline-variant/60 transition-all text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={() => onPhaseChange('select')}
          disabled={retriesLeft <= 0}
        >
          🔄 강도 조절 후 다시 해볼게요 ({retriesLeft}회 남음)
        </button>

        {/* Accept */}
        <button
          className="w-full py-3 rounded-xl bg-gradient-to-r from-[#7c3aed] to-primary text-white font-headline font-bold text-sm shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98]"
          onClick={() => { setRetries(0); onPhaseChange('done'); }}
        >
          이대로 쓸래요 →
        </button>
      </div>
    );
  }

  /* ── SELECT phase ── */
  const isRetryMode = retriesLeft > 0 && retriesLeft < MAX_RETRIES;

  return (
    <div className="flex flex-col gap-5">

      {/* Style preset buttons */}
      <div>
        <h3 className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-3">
          스타일 프리셋
        </h3>
        <div className="flex flex-col gap-2">
          {STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`w-full py-3 px-4 rounded-xl border transition-all text-sm font-medium flex items-center gap-3 disabled:opacity-50 ${
                activePreset === preset.id
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-outline-variant/30 text-white hover:border-primary/50 hover:bg-primary/5'
              }`}
              onClick={() => handlePreset(preset.id)}
              disabled={loading}
            >
              <span className="text-base">{preset.emoji}</span>
              <span>{preset.label}</span>
              {activePreset === preset.id && loading && (
                <span className="ml-auto w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-outline-variant/20" />
        <span className="text-[10px] text-on-surface-variant uppercase tracking-widest">또는 직접 업로드</span>
        <div className="flex-1 h-px bg-outline-variant/20" />
      </div>

      {/* Upload zone */}
      <div>
        <h3 className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-3">
          참조 이미지
        </h3>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={e => handleFile(e.target.files[0])} />

        {refPreview ? (
          <div className="relative rounded-xl overflow-hidden border border-outline-variant/20">
            <img src={refPreview} alt="참조" className="w-full h-44 object-cover" />
            <button
              className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/70 text-white text-xs flex items-center justify-center hover:bg-black/90 transition-colors"
              onClick={() => { setRefDataUrl(null); setRefPreview(null); }}
            >✕</button>
            <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-full text-[10px] text-white">
              참조 이미지
            </div>
          </div>
        ) : (
          <div
            className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer transition-all ${
              isDragging ? 'border-primary bg-primary/10' : 'border-outline-variant/30 hover:border-primary/50 hover:bg-primary/5'
            }`}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <span className="material-symbols-outlined text-on-surface-variant text-4xl">upload_file</span>
            <div className="text-center">
              <p className="text-sm font-medium text-white">참조 이미지 업로드</p>
              <p className="text-xs text-on-surface-variant mt-1">이런 분위기로 바꿔주세요</p>
            </div>
          </div>
        )}
      </div>

      {/* Strength slider */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            변환 강도
          </h3>
          <span className="text-xs font-bold text-primary">{Math.round(strength * 100)}%</span>
        </div>
        <input
          type="range" className="w-full accent-primary"
          min="0.3" max="0.85" step="0.05"
          value={strength}
          onChange={e => setStrength(parseFloat(e.target.value))}
        />
        <div className="flex justify-between text-[10px] text-on-surface-variant mt-1">
          <span>원본 유지</span><span>강한 변환</span>
        </div>
      </div>

      {/* Retry notice */}
      {isRetryMode && (
        <div className="p-3 bg-primary/10 rounded-xl border border-primary/20">
          <p className="text-xs text-primary">
            🔄 강도를 조절하고 무료로 재변환하세요 ({retriesLeft}회 남음)
          </p>
        </div>
      )}

      {/* CTA */}
      <button
        className="w-full py-4 rounded-xl bg-gradient-to-r from-[#7c3aed] to-primary text-white font-headline font-bold text-sm shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
        onClick={isRetryMode ? handleFreeRetry : handleTransform}
        disabled={loading || (!refDataUrl)}
      >
        {loading
          ? <><span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />AI 변환 중...</>
          : isRetryMode
            ? `✨ 다시 변환하기 (무료 · ${retriesLeft}회)`
            : `✨ 변환하기 (${CREDITS_COST} 크레딧)`
        }
      </button>

      <p className="text-[10px] text-on-surface-variant text-center">
        💎 잔여 크레딧: <strong className="text-white">{creditBalance ?? '—'}</strong>
      </p>
    </div>
  );
}
