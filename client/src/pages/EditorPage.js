import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAppState } from '../hooks/useAppState';
import { getCreditBalance } from '../utils/api';
import StyleTransform from '../components/editor/StyleTransform';
import MoodCopy from '../components/editor/MoodCopy';
import './EditorPage.css';

const TABS = [
  {
    id: 'circle-ai',
    label: 'Circle.ai',
    sublabel: '스타일 변환',
    description: '8가지 인테리어 스타일 프리셋으로 전체 방 분위기를 한 번에 변환',
  },
  {
    id: 'mood-copy',
    label: '분위기 Copy',
    sublabel: '레퍼런스 복사',
    description: '원하는 인테리어 사진을 업로드하면 그 분위기를 내 방에 자동 적용',
  },
];

function EditorPage() {
  const navigate           = useNavigate();
  const { projectId: pid } = useParams();
  const { state, update }  = useAppState();

  const [activeTab, setActiveTab]       = useState('circle-ai');
  const [creditBalance, setCreditBalance] = useState(null);
  const [lastResult, setLastResult]     = useState(null);

  // Resolve projectId from URL param OR state
  const projectId = pid ? parseInt(pid, 10) : state.projectId;
  const imageUrl  = state.imageUrl || null;

  useEffect(() => {
    if (!projectId) {
      toast.error('프로젝트를 먼저 생성해주세요.');
      navigate('/');
      return;
    }
    // Fetch credit balance
    getCreditBalance()
      .then((data) => setCreditBalance(data.balance))
      .catch(() => setCreditBalance(null));
  }, [projectId, navigate]);

  const handleResult = (result) => {
    setLastResult(result);
    // Persist latest result URL in app state so other pages can use it
    update({ lastResultUrl: result.result_url });
    if (result.remaining_balance !== undefined) {
      setCreditBalance(result.remaining_balance);
    }
  };

  const activeTabMeta = TABS.find((t) => t.id === activeTab);

  return (
    <div className="editor-page">
      {/* Page header */}
      <div className="editor-header">
        <div className="editor-header-left">
          <button className="btn btn-secondary btn-sm ep-back-btn" onClick={() => navigate(-1)}>
            ← 뒤로
          </button>
          <div>
            <h1 className="editor-title">AI 인테리어 에디터</h1>
            <p className="editor-subtitle">
              {activeTabMeta?.description}
            </p>
          </div>
        </div>
        <div className="ep-credit-badge">
          <span className="ep-credit-icon">💎</span>
          <span className="ep-credit-label">
            {creditBalance !== null ? creditBalance : '—'} 크레딧
          </span>
          {creditBalance !== null && creditBalance < 5 && (
            <span className="ep-credit-low">충전 필요</span>
          )}
        </div>
      </div>

      {/* Insufficient credit alert */}
      {creditBalance !== null && creditBalance < 5 && (
        <div className="ep-alert ep-alert-warning">
          크레딧이 부족합니다. AI 기능 사용에는 <strong>5 크레딧</strong>이 필요합니다.
          <button className="btn btn-outline btn-sm ep-charge-btn">충전하기</button>
        </div>
      )}

      {/* Tab navigation */}
      <div className="ep-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`ep-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="ep-tab-label">{tab.label}</span>
            <span className="ep-tab-sub">{tab.sublabel}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="ep-content">
        {activeTab === 'circle-ai' && (
          <StyleTransform
            projectId={projectId}
            originalImageUrl={imageUrl}
            creditBalance={creditBalance}
            onResult={handleResult}
          />
        )}
        {activeTab === 'mood-copy' && (
          <MoodCopy
            projectId={projectId}
            originalImageUrl={imageUrl}
            creditBalance={creditBalance}
            onResult={handleResult}
          />
        )}
      </div>

      {/* History strip — last result */}
      {lastResult && (
        <div className="ep-history card">
          <h3 className="ep-history-title">최근 결과</h3>
          <div className="ep-history-item">
            <img
              src={lastResult.result_url}
              alt="최근 변환 결과"
              className="ep-history-thumb"
            />
            <div className="ep-history-meta">
              <span className="ep-history-type">
                {lastResult.style_preset
                  ? `Circle AI — ${lastResult.style_preset}`
                  : '분위기 Copy'}
              </span>
              <span className="ep-history-time">
                처리 시간: {lastResult.elapsed_s?.toFixed(1)}s
              </span>
            </div>
            <a
              href={lastResult.result_url}
              download="result.jpg"
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

export default EditorPage;
