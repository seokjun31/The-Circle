import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAppState } from '../hooks/useAppState';
import { getCreditBalance } from '../utils/api';
import FurniturePanel from '../components/editor/FurniturePanel';
import FurniturePlacer from '../components/editor/FurniturePlacer';
import './FurniturePage.css';

function FurniturePage() {
  const navigate              = useNavigate();
  const { projectId: pid }    = useParams();
  const { state, update }     = useAppState();

  const [selectedFurniture, setSelected]    = useState(null);
  const [creditBalance, setCreditBalance]   = useState(null);
  const [lastResult, setLastResult]         = useState(null);
  const [panelOpen, setPanelOpen]           = useState(true);

  const projectId = pid ? parseInt(pid, 10) : state.projectId;
  const imageUrl  = state.imageUrl || null;

  useEffect(() => {
    if (!projectId) {
      toast.error('프로젝트를 먼저 생성해주세요.');
      navigate('/');
      return;
    }
    getCreditBalance()
      .then((data) => setCreditBalance(data.balance))
      .catch(() => setCreditBalance(null));
  }, [projectId, navigate]);

  const handleResult = (result) => {
    setLastResult(result);
    update({ lastResultUrl: result.result_url });
    if (result.remaining_balance !== undefined) {
      setCreditBalance(result.remaining_balance);
    }
  };

  return (
    <div className="furniture-page">
      {/* Header */}
      <div className="fp-page-header">
        <div className="fp-page-header-left">
          <button className="btn btn-secondary btn-sm" onClick={() => navigate(-1)}>
            ← 뒤로
          </button>
          <div>
            <h1>가구 배치 시뮬레이터</h1>
            <p className="fp-page-subtitle">
              가구를 드래그로 배치하고 "이 크기로 들어갈까요?"를 확인한 뒤 AI로 자연스럽게 합성하세요.
            </p>
          </div>
        </div>
        <div className="fp-credit-badge">
          <span>💎</span>
          <span>{creditBalance !== null ? creditBalance : '—'} 크레딧</span>
          {creditBalance !== null && creditBalance < 3 && (
            <span className="fp-credit-low">충전 필요</span>
          )}
        </div>
      </div>

      {/* Credit low alert */}
      {creditBalance !== null && creditBalance < 3 && (
        <div className="fp-alert">
          AI 합성에는 <strong>3 크레딧</strong>이 필요합니다.
          <button className="btn btn-outline btn-sm">충전하기</button>
        </div>
      )}

      {/* How-to guide */}
      <div className="fp-guide card">
        <div className="fp-guide-steps">
          <div className="fp-guide-step">
            <span className="fp-step-num">1</span>
            <span>왼쪽 패널에서 가구 선택 또는 직접 업로드</span>
          </div>
          <div className="fp-guide-arrow">→</div>
          <div className="fp-guide-step">
            <span className="fp-step-num">2</span>
            <span>캔버스에서 드래그로 위치 조정, 모서리 핸들로 크기 조절</span>
          </div>
          <div className="fp-guide-arrow">→</div>
          <div className="fp-guide-step">
            <span className="fp-step-num">3</span>
            <span>(선택) 스케일 보정 후 "이 크기로 들어갈까?" 확인</span>
          </div>
          <div className="fp-guide-arrow">→</div>
          <div className="fp-guide-step">
            <span className="fp-step-num">4</span>
            <span>"AI 합성" 클릭으로 자연스러운 블렌딩</span>
          </div>
        </div>
      </div>

      {/* Main layout */}
      <div className="fp-page-layout">
        {/* Furniture panel */}
        <div className={`fp-panel-wrap ${panelOpen ? 'open' : 'closed'}`}>
          <button
            className="fp-panel-toggle btn btn-secondary btn-sm"
            onClick={() => setPanelOpen(!panelOpen)}
            title={panelOpen ? '패널 닫기' : '가구 목록 열기'}
          >
            {panelOpen ? '◀' : '▶'}
          </button>
          {panelOpen && (
            <div className="fp-panel-inner card">
              <h3 className="fp-panel-title">가구 선택</h3>
              <FurniturePanel
                selectedFurniture={selectedFurniture}
                onSelect={(furn) => {
                  setSelected(furn);
                  toast.success(`"${furn.name}" 선택됨`);
                }}
              />
            </div>
          )}
        </div>

        {/* Placer canvas */}
        <div className="fp-placer-wrap">
          {selectedFurniture ? (
            <FurniturePlacer
              projectId={projectId}
              originalImageUrl={imageUrl}
              furniture={selectedFurniture}
              creditBalance={creditBalance}
              onResult={handleResult}
            />
          ) : (
            <div className="fp-no-furniture card">
              <div className="fp-no-furniture-icon">🪑</div>
              <h3>가구를 선택해주세요</h3>
              <p className="text-muted">
                왼쪽 패널에서 가구를 선택하거나
                직접 이미지를 업로드하면 이 영역에서 배치할 수 있습니다.
              </p>
              {!panelOpen && (
                <button
                  className="btn btn-primary mt-2"
                  onClick={() => setPanelOpen(true)}
                >
                  가구 목록 열기
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Last result strip */}
      {lastResult && (
        <div className="fp-last-result card">
          <div className="fp-last-result-inner">
            <img
              src={lastResult.result_url}
              alt="최근 합성 결과"
              className="fp-last-thumb"
            />
            <div className="fp-last-meta">
              <span className="fp-last-title">최근 합성 결과</span>
              <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                처리 시간: {lastResult.elapsed_s?.toFixed(1)}s
                {lastResult.fit_check && (
                  <> · 가구 {lastResult.fit_check.fits ? '적합' : '부적합'}</>
                )}
              </span>
            </div>
            <a
              href={lastResult.result_url}
              download="furniture_result.jpg"
              className="btn btn-outline btn-sm"
              target="_blank"
              rel="noreferrer"
            >
              다운로드
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default FurniturePage;
