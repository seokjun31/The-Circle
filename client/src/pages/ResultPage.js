import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { getRenderStatus } from '../utils/api';
import { useAppState } from '../hooks/useAppState';
import './ResultPage.css';

const POLL_INTERVAL = 3000;
const MAX_POLLS = 100; // ~5 minutes

const STATUS_LABELS = {
  IN_QUEUE: '대기 중...',
  IN_PROGRESS: 'AI가 인테리어를 생성하고 있습니다...',
  COMPLETED: '완료!',
  FAILED: '렌더링 실패',
};

function CompareSlider({ originalUrl, resultUrl }) {
  const [sliderPos, setSliderPos] = useState(50);
  const containerRef = useRef(null);

  const handleMove = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pos = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    setSliderPos(pos);
  };

  return (
    <div
      ref={containerRef}
      className="compare-slider"
      onMouseMove={handleMove}
      onTouchMove={handleMove}
    >
      <img src={originalUrl} alt="원본" className="compare-img" />
      <div className="compare-overlay" style={{ width: `${sliderPos}%` }}>
        <img src={resultUrl} alt="결과" className="compare-img result-img" />
      </div>
      <div className="compare-handle" style={{ left: `${sliderPos}%` }}>
        <div className="handle-line" />
        <div className="handle-circle">⇔</div>
      </div>
      <div className="compare-labels">
        <span className="compare-label left">결과</span>
        <span className="compare-label right">원본</span>
      </div>
    </div>
  );
}

function ResultPage() {
  const navigate = useNavigate();
  const { state, reset } = useAppState();
  const [status, setStatus] = useState('IN_QUEUE');
  const [resultUrl, setResultUrl] = useState(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState(null);
  const pollCount = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!state.jobId) {
      toast.error('렌더링 작업을 찾을 수 없습니다.');
      navigate('/');
      return;
    }

    const poll = async () => {
      try {
        pollCount.current++;
        const data = await getRenderStatus(state.jobId);
        setStatus(data.status);
        if (data.progress) setProgress(data.progress);

        if (data.status === 'COMPLETED') {
          setResultUrl(data.resultUrl);
          clearInterval(timerRef.current);
          toast.success('렌더링이 완료되었습니다! 🎉');
        } else if (data.status === 'FAILED') {
          setErrorMsg(data.error || '알 수 없는 오류가 발생했습니다.');
          clearInterval(timerRef.current);
          toast.error('렌더링에 실패했습니다.');
        } else if (pollCount.current >= MAX_POLLS) {
          clearInterval(timerRef.current);
          setErrorMsg('렌더링 시간이 초과되었습니다.');
        }
      } catch (err) {
        // Don't stop polling on transient errors, just log
        console.error('Poll error:', err.message);
      }
    };

    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [state.jobId, navigate]);

  const handleDownload = () => {
    if (!resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = `interior_render_${Date.now()}.png`;
    a.click();
  };

  const handleRestart = () => {
    reset();
    navigate('/');
  };

  if (errorMsg) {
    return (
      <div className="result-page">
        <div className="error-state card text-center">
          <div className="error-icon">❌</div>
          <h2>렌더링 실패</h2>
          <p>{errorMsg}</p>
          <div className="flex justify-center gap-2 mt-3">
            <button className="btn btn-secondary" onClick={() => navigate('/mask')}>
              다시 시도
            </button>
            <button className="btn btn-primary" onClick={handleRestart}>
              처음부터 시작
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status !== 'COMPLETED') {
    return (
      <div className="result-page">
        <div className="page-header text-center">
          <h1>렌더링 진행 중</h1>
          <p>AI가 인테리어를 생성하고 있습니다. 잠시만 기다려주세요.</p>
        </div>

        <div className="progress-card card">
          <div className="progress-animation">
            <div className="spinner spinner-lg" />
          </div>
          <p className="progress-status">{STATUS_LABELS[status] || status}</p>
          {progress > 0 && (
            <div className="progress-bar-wrap">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
              <span className="progress-pct">{progress}%</span>
            </div>
          )}
          <p className="progress-hint">
            평균 1~3분 소요됩니다. 페이지를 닫아도 처리가 계속됩니다.
          </p>

          <div className="progress-steps">
            {[
              { label: '이미지 전처리', done: pollCount.current > 1 },
              { label: 'ControlNet 구조 분석', done: pollCount.current > 5 },
              { label: 'AI 렌더링 생성', done: status === 'COMPLETED' },
              { label: '후처리 및 업스케일', done: status === 'COMPLETED' },
            ].map((step, i) => (
              <div key={i} className={`progress-step ${step.done ? 'done' : ''}`}>
                <div className="progress-step-dot" />
                <span>{step.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="result-page">
      <div className="page-header">
        <h1>렌더링 완료 🎉</h1>
        <p>AI가 생성한 인테리어 결과입니다. 슬라이더를 움직여 원본과 비교해보세요.</p>
      </div>

      <div className="result-container">
        <CompareSlider
          originalUrl={state.imageUrl}
          resultUrl={resultUrl}
        />
      </div>

      <div className="result-actions">
        <div className="result-info card">
          <div className="result-info-grid">
            <div className="result-info-item">
              <span className="info-label">선택한 무드</span>
              <span className="info-value">{state.selectedMood}</span>
            </div>
            {state.selectedMaterials?.length > 0 && (
              <div className="result-info-item">
                <span className="info-label">적용 자재</span>
                <span className="info-value">
                  {state.selectedMaterials.map((m) => m.name).join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="result-buttons">
          <button className="btn btn-secondary" onClick={handleRestart}>
            ↩ 처음부터
          </button>
          <button className="btn btn-secondary" onClick={() => navigate('/mask')}>
            마스킹 다시하기
          </button>
          <button className="btn btn-primary btn-lg" onClick={handleDownload}>
            ⬇ 이미지 다운로드
          </button>
        </div>
      </div>
    </div>
  );
}

export default ResultPage;
