import React, { useRef, useState } from 'react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import { runFinalRender } from '../../utils/api';
import './FinalRender.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const LIGHTING_OPTIONS = [
  { id: 'morning', label: '아침', icon: '☀️', desc: '따뜻한 아침 햇살' },
  { id: 'evening', label: '저녁', icon: '🌅', desc: '아늑한 저녁 조명' },
  { id: 'night',   label: '야간', icon: '🌙', desc: '실내 인공 조명' },
];

const QUALITY_OPTIONS = [
  {
    id: 'standard',
    title: '표준',
    icon: '⚡',
    detail: '빠름 (~20초)',
    credits: 3,
  },
  {
    id: 'high',
    title: '고품질',
    icon: '✨',
    detail: '느림 (~60초) · Refiner + 2× Upscale',
    credits: 5,
  },
];

// ── Credit confirm modal ──────────────────────────────────────────────────────

function CreditConfirmModal({ lighting, quality, creditBalance, onConfirm, onCancel }) {
  const opt = QUALITY_OPTIONS.find(o => o.id === quality);
  const credits = opt?.credits ?? 3;
  const remaining = creditBalance - credits;

  return (
    <div className="credit-modal-backdrop" onClick={onCancel}>
      <div className="credit-modal" onClick={e => e.stopPropagation()}>
        <h4>최종 렌더링 실행</h4>
        <p>
          현재 보이는 모든 레이어를 합성하여<br />
          고품질 최종 이미지를 생성합니다.
        </p>
        <div className="credit-modal-row">
          <span>품질</span>
          <span>{opt?.icon} {opt?.title}</span>
        </div>
        <div className="credit-modal-row">
          <span>조명</span>
          <span>{LIGHTING_OPTIONS.find(l => l.id === lighting)?.label}</span>
        </div>
        <div className="credit-modal-row">
          <span>크레딧 차감</span>
          <span>💎 {credits}</span>
        </div>
        <div className="credit-modal-row">
          <span>차감 후 잔액</span>
          <span style={{ color: remaining < 0 ? '#ef4444' : '#22c55e' }}>
            {remaining}
          </span>
        </div>
        <div className="credit-modal-actions">
          <button className="btn-cancel" onClick={onCancel}>취소</button>
          <button
            className="btn-confirm"
            onClick={onConfirm}
            disabled={remaining < 0}
          >
            렌더링 시작
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * FinalRender
 *
 * Props:
 *   projectId       {number}
 *   originalImageUrl{string}
 *   creditBalance   {number}
 *   onResult        {function({ resultUrl, layerId, creditsUsed, remaining })}
 */
export default function FinalRender({ projectId, originalImageUrl, creditBalance, onResult }) {
  const [lighting, setLighting] = useState('morning');
  const [quality, setQuality] = useState('standard');
  const [showConfirm, setShowConfirm] = useState(false);

  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState('');

  const [result, setResult] = useState(null);   // { resultUrl, elapsed, lighting, quality }
  const [error, setError] = useState(null);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

  const abortRef = useRef(null);

  const selectedQuality = QUALITY_OPTIONS.find(o => o.id === quality);
  const creditsNeeded = selectedQuality?.credits ?? 3;

  // ── Start render ────────────────────────────────────────────────────────────
  async function handleRender() {
    setShowConfirm(false);
    setRendering(true);
    setProgress(0);
    setStep('렌더링 준비 중...');
    setError(null);
    setResult(null);
    setShowCompare(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await runFinalRender(
        projectId,
        { lighting, quality },
        (evt) => {
          if (evt.progress !== undefined) setProgress(evt.progress);
          if (evt.step)     setStep(evt.step);
          if (evt.done) {
            const r = {
              resultUrl: evt.result_url,
              layerId:   evt.layer_id,
              elapsed:   evt.elapsed_s,
              lighting,
              quality,
              creditsUsed: evt.credits_used,
            };
            setResult(r);
            onResult?.({
              resultUrl:    r.resultUrl,
              layerId:      r.layerId,
              creditsUsed:  r.creditsUsed,
            });
            toast.success('최종 렌더링 완료!');
          }
          if (evt.error) {
            throw new Error(evt.error);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || '렌더링 실패');
        toast.error('렌더링 실패: ' + (err.message || '알 수 없는 오류'));
      }
    } finally {
      setRendering(false);
    }
  }

  // ── Download ────────────────────────────────────────────────────────────────
  function handleDownload(fmt = 'jpg') {
    if (!result?.resultUrl) return;
    const a = document.createElement('a');
    a.href = result.resultUrl;
    a.download = `the-circle-render-${Date.now()}.${fmt}`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ── Share ───────────────────────────────────────────────────────────────────
  async function handleShare() {
    if (!result?.resultUrl) return;
    try {
      await navigator.clipboard.writeText(result.resultUrl);
      toast.success('링크가 클립보드에 복사되었습니다!');
    } catch {
      toast.error('클립보드 복사 실패');
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="final-render">
      {/* Lighting */}
      <div>
        <h3>조명 설정</h3>
        <div className="lighting-grid">
          {LIGHTING_OPTIONS.map(opt => (
            <button
              key={opt.id}
              className={`lighting-btn${lighting === opt.id ? ' active' : ''}`}
              onClick={() => setLighting(opt.id)}
              disabled={rendering}
            >
              <span className="icon">{opt.icon}</span>
              <span className="label">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Quality */}
      <div>
        <h3>렌더링 품질</h3>
        <div className="quality-grid">
          {QUALITY_OPTIONS.map(opt => (
            <button
              key={opt.id}
              className={`quality-btn${quality === opt.id ? ' active' : ''}`}
              onClick={() => setQuality(opt.id)}
              disabled={rendering}
            >
              <span className="q-title">{opt.icon} {opt.title}</span>
              <span className="q-detail">{opt.detail}</span>
              <span className="q-credits">💎 {opt.credits} 크레딧</span>
            </button>
          ))}
        </div>
      </div>

      {/* Start button */}
      {!rendering && !result && (
        <button
          className="render-btn"
          onClick={() => setShowConfirm(true)}
          disabled={creditBalance < creditsNeeded}
        >
          ✨ 최종 렌더링
          {creditBalance < creditsNeeded && ' (크레딧 부족)'}
        </button>
      )}

      {/* Progress */}
      {rendering && (
        <div className="render-progress">
          <div className="progress-header">
            <span className="progress-step">{step}</span>
            <span className="progress-pct">{progress}%</span>
          </div>
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <button
            style={{
              background: 'none', border: 'none', color: '#808090',
              fontSize: '11px', cursor: 'pointer', alignSelf: 'flex-end',
            }}
            onClick={() => {
              abortRef.current?.abort();
              setRendering(false);
              setError('렌더링이 취소되었습니다.');
            }}
          >
            취소
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="render-error">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="render-result">
          {showCompare && originalImageUrl ? (
            <div className="render-compare">
              <ReactCompareSlider
                itemOne={<ReactCompareSliderImage src={originalImageUrl} alt="원본" />}
                itemTwo={<ReactCompareSliderImage src={result.resultUrl} alt="렌더링" />}
                style={{ borderRadius: 12, overflow: 'hidden' }}
              />
            </div>
          ) : (
            <div className="result-image-wrap" onClick={() => setShowFullscreen(true)}>
              <img src={result.resultUrl} alt="최종 렌더링 결과" />
              <span className="result-zoom-hint">🔍 클릭해 전체화면</span>
            </div>
          )}

          <div className="result-actions">
            <button className="btn-download" onClick={() => handleDownload('jpg')}>
              ⬇ 다운로드
            </button>
            <button className="btn-compare" onClick={() => setShowCompare(v => !v)}>
              {showCompare ? '결과만 보기' : '⇆ 비교'}
            </button>
            <button className="btn-share" onClick={handleShare}>
              🔗 공유
            </button>
          </div>

          <div className="result-meta">
            {QUALITY_OPTIONS.find(o => o.id === result.quality)?.icon}{' '}
            {QUALITY_OPTIONS.find(o => o.id === result.quality)?.title} ·{' '}
            {LIGHTING_OPTIONS.find(l => l.id === result.lighting)?.label} ·{' '}
            {result.elapsed?.toFixed(1)}s ·{' '}
            💎 {result.creditsUsed} 크레딧 사용
          </div>

          <button
            className="render-btn"
            style={{ marginTop: 4 }}
            onClick={() => {
              setResult(null);
              setError(null);
              setProgress(0);
            }}
          >
            다시 렌더링
          </button>
        </div>
      )}

      {/* Fullscreen overlay */}
      {showFullscreen && result && (
        <div className="fullscreen-overlay" onClick={() => setShowFullscreen(false)}>
          <button className="fullscreen-close" onClick={() => setShowFullscreen(false)}>✕</button>
          <img src={result.resultUrl} alt="최종 렌더링 전체화면" />
        </div>
      )}

      {/* Credit confirm modal */}
      {showConfirm && (
        <CreditConfirmModal
          lighting={lighting}
          quality={quality}
          creditBalance={creditBalance}
          onConfirm={handleRender}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
