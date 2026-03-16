import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAppState } from '../hooks/useAppState';
import { getCreditBalance, getProjectLayers } from '../utils/api';
import StyleTransform from '../components/editor/StyleTransform';
import MoodCopy from '../components/editor/MoodCopy';
import FinalRender from '../components/editor/FinalRender';
import LayerPanel from '../components/editor/LayerPanel';
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
  {
    id: 'final-render',
    label: '✨ 최종 렌더링',
    sublabel: '마무리 합성',
    description: '모든 변경사항을 통합하여 고품질 최종 이미지를 생성합니다',
  },
];

function EditorPage() {
  const navigate           = useNavigate();
  const { projectId: pid } = useParams();
  const { state, update }  = useAppState();

  const [activeTab, setActiveTab]         = useState('circle-ai');
  const [creditBalance, setCreditBalance] = useState(null);
  const [lastResult, setLastResult]       = useState(null);
  const [layers, setLayers]               = useState([]);
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const [layerPanelOpen, setLayerPanelOpen]   = useState(true);

  const projectId = pid ? parseInt(pid, 10) : state.projectId;
  const imageUrl  = state.imageUrl || null;

  // ── Load credit balance ────────────────────────────────────────────────────
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

  // ── Load layers ────────────────────────────────────────────────────────────
  const refreshLayers = useCallback(() => {
    if (!projectId) return;
    getProjectLayers(projectId)
      .then((data) => setLayers(data.layers || []))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    refreshLayers();
  }, [refreshLayers]);

  // ── Handle AI result ───────────────────────────────────────────────────────
  const handleResult = (result) => {
    setLastResult(result);
    update({ lastResultUrl: result.result_url });
    if (result.remaining_balance !== undefined) {
      setCreditBalance(result.remaining_balance);
    }
    // Refresh credit balance and layers after each operation
    getCreditBalance()
      .then((data) => setCreditBalance(data.balance))
      .catch(() => {});
    refreshLayers();
  };

  // Handle FinalRender result (different shape)
  const handleFinalRenderResult = ({ resultUrl, layerId, creditsUsed }) => {
    setLastResult({ result_url: resultUrl, layer_id: layerId });
    update({ lastResultUrl: resultUrl });
    getCreditBalance()
      .then((data) => setCreditBalance(data.balance))
      .catch(() => {});
    refreshLayers();
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
            <p className="editor-subtitle">{activeTabMeta?.description}</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="ep-credit-badge">
            <span className="ep-credit-icon">💎</span>
            <span className="ep-credit-label">
              {creditBalance !== null ? creditBalance : '—'} 크레딧
            </span>
            {creditBalance !== null && creditBalance < 5 && (
              <span className="ep-credit-low">충전 필요</span>
            )}
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setLayerPanelOpen(v => !v)}
            title="레이어 패널 토글"
            style={{ flexShrink: 0 }}
          >
            {layerPanelOpen ? '◀ 레이어' : '▶ 레이어'}
          </button>
        </div>
      </div>

      {/* Insufficient credit alert */}
      {creditBalance !== null && creditBalance < 3 && (
        <div className="ep-alert ep-alert-warning">
          크레딧이 부족합니다. AI 기능 사용에는 최소 <strong>3 크레딧</strong>이 필요합니다.
          <button className="btn btn-outline btn-sm ep-charge-btn">충전하기</button>
        </div>
      )}

      {/* Two-column layout: main + layer panel */}
      <div className="ep-workspace">
        {/* Left — tab content */}
        <div className="ep-main">
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
            {activeTab === 'final-render' && (
              <FinalRender
                projectId={projectId}
                originalImageUrl={imageUrl}
                creditBalance={creditBalance}
                onResult={handleFinalRenderResult}
              />
            )}
          </div>

          {/* History strip */}
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
                      : lastResult.layer_id
                        ? `레이어 #${lastResult.layer_id}`
                        : '변환 결과'}
                  </span>
                  <span className="ep-history-time">
                    {lastResult.elapsed_s
                      ? `처리 시간: ${lastResult.elapsed_s.toFixed(1)}s`
                      : ''}
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

        {/* Right — layer panel */}
        {layerPanelOpen && (
          <div className="ep-layer-sidebar">
            <LayerPanel
              projectId={projectId}
              layers={layers}
              selected={selectedLayerId}
              onSelect={setSelectedLayerId}
              onLayersChange={refreshLayers}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default EditorPage;
