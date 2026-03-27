/**
 * LightingPanel — Layout 탭 내 조명 선택 + 적용 (1코인)
 * POST /projects/{id}/lighting
 */
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { applyLightingPreset } from '../../utils/api';

const LIGHTING_OPTIONS = [
  { id: 'morning', label: '아침',   icon: 'wb_sunny',   desc: '따뜻한 아침 햇살',   gradient: 'from-amber-500/20 to-orange-400/10' },
  { id: 'evening', label: '저녁',   icon: 'wb_twilight', desc: '아늑한 저녁 조명',   gradient: 'from-orange-600/20 to-pink-500/10'  },
  { id: 'night',   label: '야간',   icon: 'bedtime',     desc: '실내 인공 조명',     gradient: 'from-indigo-500/20 to-violet-600/10' },
];

const CREDITS_COST = 1;

export default function LightingPanel({
  projectId,
  creditBalance,
  onResult,
}) {
  const [selected, setSelected] = useState('morning');
  const [loading,  setLoading]  = useState(false);

  const handleApply = async () => {
    if ((creditBalance ?? 0) < CREDITS_COST) {
      toast.error(`크레딧 부족 (잔액: ${creditBalance ?? 0})`);
      return;
    }
    setLoading(true);
    try {
      const result = await applyLightingPreset(projectId, { lighting: selected });
      toast.success('조명이 적용됐습니다!');
      onResult?.({
        result_url:        result.result_url,
        layer_id:          result.layer_id,
        remaining_balance: result.remaining_balance,
      });
    } catch (err) {
      toast.error('조명 적용 실패: ' + (err?.response?.data?.detail?.message || err.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-3">
          조명 선택
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {LIGHTING_OPTIONS.map(opt => (
            <button
              key={opt.id}
              className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                selected === opt.id
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-outline-variant/20 bg-surface-container text-on-surface-variant hover:border-primary/40 hover:text-white'
              }`}
              onClick={() => setSelected(opt.id)}
            >
              {selected === opt.id && (
                <div className={`absolute inset-0 rounded-xl bg-gradient-to-br ${opt.gradient} pointer-events-none`} />
              )}
              <span className="material-symbols-outlined text-2xl relative"
                style={selected === opt.id ? { fontVariationSettings: "'FILL' 1" } : {}}>
                {opt.icon}
              </span>
              <span className="text-xs font-bold relative">{opt.label}</span>
              <span className="text-[10px] text-center leading-tight relative opacity-70">{opt.desc}</span>
              {selected === opt.id && (
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>
      </div>

      <button
        className="w-full py-4 rounded-xl bg-gradient-to-r from-[#7c3aed] to-primary text-white font-headline font-bold text-sm shadow-lg hover:shadow-primary/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
        onClick={handleApply}
        disabled={loading || (creditBalance ?? 0) < CREDITS_COST}
      >
        {loading ? (
          <><span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />처리 중...</>
        ) : (
          <><span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>wb_incandescent</span>
          조명 적용하기 ({CREDITS_COST} 코인)</>
        )}
      </button>

      <p className="text-[10px] text-on-surface-variant text-center">
        💎 잔여 크레딧: <strong className="text-white">{creditBalance ?? '—'}</strong>
      </p>
    </div>
  );
}
