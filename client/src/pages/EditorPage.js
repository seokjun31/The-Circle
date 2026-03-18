import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import useEditorStore from '../stores/editorStore';
import { getCreditBalance, getProject, getProjectLayers } from '../utils/api';
import StyleTransform from '../components/editor/StyleTransform';
import MoodCopy from '../components/editor/MoodCopy';
import MaterialPanel from '../components/editor/MaterialPanel';
import FurniturePanel from '../components/editor/FurniturePanel';
import FinalRender from '../components/editor/FinalRender';
import LayerPanel from '../components/editor/LayerPanel';
import ProcessingOverlay from '../components/editor/ProcessingOverlay';
import RoomCanvas from '../components/editor/RoomCanvas';
import './EditorPage.css';

// ── Sidebar tool definitions ──────────────────────────────────────────────────
const TOOLS = [
  { id: 'circle_ai',    icon: '🎨', label: 'Circle.ai',  sub: '스타일 변환'   },
  { id: 'material',     icon: '🧱', label: '자재',        sub: '영역 텍스처'   },
  { id: 'mood_copy',    icon: '🖼️', label: '분위기',      sub: '레퍼런스 복사' },
  { id: 'furniture',    icon: '🪑', label: '가구',        sub: 'AI 합성'       },
  { id: 'final_render', icon: '✨', label: '렌더링',      sub: '고품질 출력'   },
  { id: 'layers',       icon: '📋', label: '레이어',      sub: '히스토리'      },
];

// ─────────────────────────────────────────────────────────────────────────────

function EditorPage() {
  const navigate = useNavigate();
  const { projectId: pid } = useParams();

  const {
    project,
    activeTool,
    isProcessing,
    processingMessage,
    isColdStart,
    creditBalance,
    lastResult,
    layers,
    setProject,
    setActiveTool,
    setCreditBalance,
    setLayers,
    setLastResult,
    setProcessing,
    pushHistory,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useEditorStore();

  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const [canvasSegments, setCanvasSegments]   = useState([]);
  const [rightPanelOpen, setRightPanelOpen]   = useState(true);
  const [loadingProject, setLoadingProject]   = useState(false);

  const projectId = pid ? parseInt(pid, 10) : project?.id;
  // imageUrl: use store if already set, otherwise wait for fetch
  const imageUrl  = project?.original_image_url || null;

  const handleEncodingChange = useCallback(
    ({ isEncoding }) =>
      isEncoding ? setProcessing(true, 'SAM 이미지 분석 중...') : setProcessing(false),
    [setProcessing]
  );

  // ── Bootstrap: fetch project if not in store ───────────────────────────────
  useEffect(() => {
    if (!projectId) {
      toast.error('프로젝트를 먼저 생성해주세요.');
      navigate('/dashboard');
      return;
    }

    // Already loaded in store for this project
    if (project?.id === projectId) {
      getCreditBalance().then((d) => setCreditBalance(d.balance)).catch(() => {});
      return;
    }

    // Fetch from server
    setLoadingProject(true);
    getProject(projectId)
      .then((proj) => {
        setProject(proj);
        getCreditBalance().then((d) => setCreditBalance(d.balance)).catch(() => {});
      })
      .catch(() => {
        toast.error('프로젝트를 불러오지 못했습니다.');
        navigate('/dashboard');
      })
      .finally(() => setLoadingProject(false));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshLayers = useCallback(() => {
    if (!projectId) return;
    getProjectLayers(projectId)
      .then((d) => setLayers(d.layers || []))
      .catch(() => {});
  }, [projectId, setLayers]);

  useEffect(() => { refreshLayers(); }, [refreshLayers]);

  // ── AI result handler ──────────────────────────────────────────────────────
  const handleResult = useCallback((result) => {
    setLastResult(result);
    if (result.remaining_balance !== undefined) setCreditBalance(result.remaining_balance);
    pushHistory();
    refreshLayers();
    getCreditBalance().then((d) => setCreditBalance(d.balance)).catch(() => {});
  }, [setLastResult, setCreditBalance, pushHistory, refreshLayers]);

  const handleFinalRenderResult = useCallback(({ resultUrl, layerId }) => {
    setLastResult({ result_url: resultUrl, layer_id: layerId });
    getCreditBalance().then((d) => setCreditBalance(d.balance)).catch(() => {});
    refreshLayers();
  }, [setLastResult, setCreditBalance, refreshLayers]);

  const activeMeta = TOOLS.find((t) => t.id === activeTool);

  // ── Right panel content ────────────────────────────────────────────────────
  const renderPanel = () => {
    const common = { projectId, originalImageUrl: imageUrl, creditBalance, onResult: handleResult };
    switch (activeTool) {
      case 'circle_ai':    return <StyleTransform  {...common} />;
      case 'material':     return <MaterialPanel   {...common} confirmedMasks={canvasSegments} />;
      case 'mood_copy':    return <MoodCopy        {...common} />;
      case 'furniture':    return <FurniturePanel  projectId={projectId} originalImageUrl={imageUrl} creditBalance={creditBalance} onResult={handleResult} />;
      case 'final_render': return <FinalRender     {...common} onResult={handleFinalRenderResult} />;
      case 'layers':       return (
        <LayerPanel
          projectId={projectId}
          layers={layers}
          selected={selectedLayerId}
          onSelect={setSelectedLayerId}
          onLayersChange={refreshLayers}
        />
      );
      default: return null;
    }
  };

  return (
    <div className="ep-root">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="ep-topbar">
        <div className="ep-topbar-left">
          <button className="ep-back-btn" onClick={() => navigate('/dashboard')} title="대시보드로">←</button>
          <div className="ep-title-group">
            <span className="ep-project-name">{project?.title || 'AI 인테리어 에디터'}</span>
            {activeMeta && <span className="ep-tool-name">{activeMeta.icon} {activeMeta.label} — {activeMeta.sub}</span>}
          </div>
        </div>
        <div className="ep-topbar-center">
          <button className="ep-hist-btn" onClick={undo} disabled={!canUndo()} title="실행 취소">↩</button>
          <button className="ep-hist-btn" onClick={redo} disabled={!canRedo()} title="다시 실행">↪</button>
        </div>
        <div className="ep-topbar-right">
          {creditBalance !== null && creditBalance < 5 && (
            <span className="ep-low-credit-warn">크레딧 부족</span>
          )}
          <div className="ep-credit-chip">
            <span>💎</span>
            <span>{creditBalance !== null ? creditBalance : '—'}</span>
          </div>
          <button className="ep-panel-toggle" onClick={() => setRightPanelOpen((v) => !v)} title="옵션 패널 토글">
            {rightPanelOpen ? '⊳' : '⊲'}
          </button>
        </div>
      </header>

      {/* ── Workspace ────────────────────────────────────────────────────── */}
      <div className="ep-workspace">

        {/* Left sidebar */}
        <aside className="ep-sidebar">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`ep-tool-btn ${activeTool === t.id ? 'active' : ''}`}
              onClick={() => setActiveTool(t.id)}
              title={`${t.label} — ${t.sub}`}
            >
              <span className="ep-tool-icon">{t.icon}</span>
              <span className="ep-tool-label">{t.label}</span>
            </button>
          ))}
        </aside>

        {/* Canvas */}
        <main className="ep-canvas-area">
          {imageUrl ? (
            <div className="ep-canvas-wrap">
              <RoomCanvas
                imageSrc={imageUrl}
                onMasksChange={setCanvasSegments}
                onEncodingChange={handleEncodingChange}
              />
              {isProcessing && (
                <ProcessingOverlay message={processingMessage} isColdStart={isColdStart} />
              )}
            </div>
          ) : (
            <div className="ep-canvas-placeholder">
              {loadingProject ? (
                <><span className="spinner spinner-lg" /><p>프로젝트 불러오는 중...</p></>
              ) : (
                <><span>🏠</span><p>이미지를 불러오는 중...</p></>
              )}
            </div>
          )}

          {lastResult?.result_url && (
            <div className="ep-result-strip">
              <img src={lastResult.result_url} alt="최근 결과" />
              <div className="ep-result-meta">
                <span>
                  {lastResult.style_preset
                    ? `Circle AI — ${lastResult.style_preset}`
                    : `레이어 #${lastResult.layer_id || '?'}`}
                </span>
                {lastResult.elapsed_s && <span>{lastResult.elapsed_s.toFixed(1)}s</span>}
              </div>
              <button
                className="ep-download-btn"
                onClick={async () => {
                  try {
                    const token = localStorage.getItem('auth_token');
                    const res  = await fetch(lastResult.result_url, {
                      credentials: 'include',
                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                    });
                    const blob = await res.blob();
                    const href = URL.createObjectURL(blob);
                    const a    = document.createElement('a');
                    a.href = href; a.download = 'result.jpg';
                    document.body.appendChild(a); a.click();
                    document.body.removeChild(a); URL.revokeObjectURL(href);
                  } catch { window.open(lastResult.result_url, '_blank'); }
                }}
              >
                ↓ 다운로드
              </button>
            </div>
          )}
        </main>

        {/* Right panel */}
        {rightPanelOpen && (
          <aside className="ep-options-panel">
            <div className="ep-options-header">
              {activeMeta && <><span>{activeMeta.icon} {activeMeta.label}</span><span className="ep-options-sub">{activeMeta.sub}</span></>}
            </div>
            <div className="ep-options-body">
              {renderPanel()}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export default EditorPage;
