/**
 * LightingPanel — Right sidebar panel for Lighting tab
 * 조명 프리셋(아침/저녁/야간) 선택 후 렌더링
 */
import React, { useRef, useState } from 'react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import { runFinalRender } from '../../utils/api';

const LIGHTING_OPTIONS = [
  { id: 'morning', label: '아침',   icon: 'wb_sunny',       desc: '따뜻한 아침 햇살',   gradient: 'from-amber-500/20 to-orange-400/10' },
  { id: 'evening', label: '저녁',   icon: 'wb_twilight',     desc: '아늑한 저녁 조명',   gradient: 'from-orange-600/20 to-pink-500/10'  },
  { id: 'night',   label: '야간',   icon: 'bedtime',         desc: '실내 인공 조명',     gradient: 'from-indigo-500/20 to-violet-600/10' },
];

const CREDITS_COST = 3;

export default function LightingPanel({
  projectId,
  originalImageUrl,
  creditBalance,
  onResult,
}) {
  const [selectedLighting, setSelectedLighting] = useState('morning');
  const [loading,          setLoading]          = useState(false);
  const [progress,         setProgress]         = useState(null); // { step, pct }
  const [resultUrl,        setResultUrl]        = useState(null);
  const abortRef = useRef(null);

  const handleApply = async () => {
    if ((creditBalance ?? 0) < CREDITS_COST) {
      toast.error(`크레딧 부족 (잔액: ${creditBalance ?? 0})`);
      return;
    }
    abortRef.current = new AbortController();
    setLoading(true);
    setProgress({ step: '렌더링 준비 중...', pct: 0 });

    try {
      const result = await runFinalRender(
        projectId,
        { lighting: selectedLighting, quality: 'standard' },
        (event) => {
          if (event.step !== undefined) setProgress({ step: event.message || '처리 중...', pct: event.step });
        },
        abortRef.current.signal,
      );
      setResultUrl(result.result_url);
      onResult?.({ result_url: result.result_url, remaining_balance: result.remaining_balance });
    } catch (err) {
      if (err.name !== 'AbortError') toast.error('조명 변경 실패: ' + err.message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setLoading(false);
    setProgress(null);
  };

  return (
    <div className="flex flex-col gap-6">

      {/* Lighting presets */}
      <div>
        <h3 className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-3">
          조명 선택
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {LIGHTING_OPTIONS.map(opt => (
            <button
              key={opt.id}
              className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                selectedLighting === opt.id
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-outline-variant/20 bg-surface-container text-on-surface-variant hover:border-primary/40 hover:text-white'
              }`}
              onClick={() => setSelectedLighting(opt.id)}
            >
              {selectedLighting === opt.id && (
                <div className={`absolute inset-0 rounded-xl bg-gradient-to-br ${opt.gradient} pointer-events-none`} />
              )}
              <span className="material-symbols-outlined text-2xl relative"
                style={selectedLighting === opt.id ? { fontVariationSettings: "'FILL' 1" } : {}}>
                {opt.icon}
              </span>
              <span className="text-xs font-bold relative">{opt.label}</span>
              <span className="text-[10px] text-center leading-tight relative opacity-70">{opt.desc}</span>
              {selectedLighting === opt.id && (
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Progress bar (when loading) */}
      {loading && progress && (
        <div className="p-4 bg-surface-container rounded-xl border border-outline-variant/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-on-surface-variant">{progress.step}</span>
            <span className="text-xs font-bold text-primary">{Math.round(progress.pct)}%</span>
          </div>
          <div className="w-full h-1.5 bg-outline-variant/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#7c3aed] to-primary rounded-full transition-all duration-500"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Compare result */}
      {resultUrl && originalImageUrl && !loading && (
        <div className="rounded-xl overflow-hidden border border-outline-variant/20 shadow-xl">
          <div className="relative h-48">
            <ReactCompareSlider
              itemOne={<ReactCompareSliderImage src={originalImageUrl} alt="원본" style={{ objectFit: 'cover' }} />}
              itemTwo={<ReactCompareSliderImage src={resultUrl} alt="조명 적용" style={{ objectFit: 'cover' }} />}
              style={{ width: '100%', height: '100%' }}
            />
            <span className="absolute top-2 left-2 text-[10px] font-bold bg-black/60 backdrop-blur-sm px-2 py-1 rounded-full text-white">원본</span>
            <span className="absolute top-2 right-2 text-[10px] font-bold bg-primary/30 backdrop-blur-sm px-2 py-1 rounded-full text-primary border border-primary/30">조명 적용</span>
          </div>
        </div>
      )}

      {/* CTA */}
      {loading ? (
        <button
          className="w-full py-4 rounded-xl border border-outline-variant/30 text-on-surface-variant text-sm font-medium transition-all hover:border-outline-variant/60 flex items-center justify-center gap-2"
          onClick={handleCancel}
        >
          <span className="w-4 h-4 rounded-full border-2 border-on-surface-variant border-t-transparent animate-spin" />
          취소
        </button>
      ) : (
        <button
          className="w-full py-4 rounded-xl bg-gradient-to-r from-[#7c3aed] to-primary text-white font-headline font-bold text-sm shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
          onClick={handleApply}
          disabled={(creditBalance ?? 0) < CREDITS_COST}
        >
          <span className="material-symbols-outlined text-base"
            style={{ fontVariationSettings: "'FILL' 1" }}>wb_incandescent</span>
          조명 적용하기 ({CREDITS_COST} 크레딧)
        </button>
      )}

      <p className="text-[10px] text-on-surface-variant text-center">
        💎 잔여 크레딧: <strong className="text-white">{creditBalance ?? '—'}</strong>
      </p>
    </div>
  );
}
