import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import ChatPanel from '../components/editor/ChatPanel';
import CorrectionMode from '../components/editor/CorrectionMode';
import SegmentOverlay from '../components/editor/SegmentOverlay';
import StyleOnboarding from '../components/editor/StyleOnboarding';
import { useSemanticSegmentation } from '../hooks/useSemanticSegmentation';
import './EditorPage.css';

const TOOLS = [
  { id: 'circle_ai',    icon: 'auto_awesome', label: 'Circle.ai',  sub: '스타일 변환'   },
  { id: 'material',     icon: 'texture',      label: '자재',        sub: '영역 텍스처'   },
  { id: 'mood_copy',    icon: 'photo_library',label: '분위기',      sub: '레퍼런스 복사' },
  { id: 'furniture',    icon: 'chair',        label: '가구',        sub: 'AI 합성'       },
  { id: 'final_render', icon: 'download',     label: '렌더링',      sub: '고품질 출력'   },
  { id: 'layers',       icon: 'layers',       label: '레이어',      sub: '히스토리'      },
];

const SIDE_NAV = [
  { id: 'layout',    icon: 'grid_view',      label: 'Layout'    },
  { id: 'material',  icon: 'texture',        label: 'Materials' },
  { id: 'mood_copy', icon: 'wb_incandescent',label: 'Lighting'  },
  { id: 'furniture', icon: 'chair',          label: 'Furniture' },
  { id: 'chat',      icon: 'auto_awesome',   label: 'AI Chat'   },
];

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
  const [loadingProject, setLoadingProject]   = useState(false);
  const [advancedMode,   setAdvancedMode]     = useState(false);
  const [editorStep,     setEditorStep]       = useState('onboarding');
  const [chatInput,      setChatInput]        = useState('');

  const { isAnalyzing, analyzeRoom } = useSemanticSegmentation();
  const imageCanvasRef = useRef(null);

  const [chatPreviewMask,  setChatPreviewMask]  = useState(null);
  const [correctionIntent, setCorrectionIntent] = useState(null);
  const chatPanelRef = useRef(null);

  const handleOpenCorrection = useCallback((intent) => {
    setCorrectionIntent(intent);
  }, []);

  const handleCorrectionComplete = useCallback((mask) => {
    setCorrectionIntent(null);
    if (chatPanelRef.current?.confirmWithMask) {
      chatPanelRef.current.confirmWithMask(mask);
    }
  }, []);

  const projectId = pid ? parseInt(pid, 10) : project?.id;
  const imageUrl  = project?.original_image_url || null;
  const displayUrl = lastResult?.result_url || imageUrl;

  const handleEncodingChange = useCallback(
    ({ isEncoding }) => {
      if (isEncoding) setProcessing(true, 'SAM 이미지 분석 중...');
      else if (!isAnalyzing) setProcessing(false);
    },
    [setProcessing, isAnalyzing]
  );

  useEffect(() => {
    if (!projectId) {
      toast.error('프로젝트를 먼저 생성해주세요.');
      navigate('/dashboard');
      return;
    }
    if (project?.id === projectId) {
      getCreditBalance().then((d) => setCreditBalance(d.balance)).catch(() => {});
      return;
    }
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

  useEffect(() => {
    if (!imageUrl) return;
    analyzeRoom(imageUrl, imageCanvasRef.current);
  }, [imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshLayers = useCallback(() => {
    if (!projectId) return;
    getProjectLayers(projectId)
      .then((d) => setLayers(d.layers || []))
      .catch(() => {});
  }, [projectId, setLayers]);

  useEffect(() => { refreshLayers(); }, [refreshLayers]);

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

  const handleOnboardingDone = useCallback((result) => {
    if (result) {
      setLastResult(result);
      refreshLayers();
      getCreditBalance().then((d) => setCreditBalance(d.balance)).catch(() => {});
    }
    setEditorStep('chat');
  }, [setLastResult, refreshLayers, setCreditBalance]);

  const handleChatSend = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    setChatInput('');
    if (chatPanelRef.current?.sendMessage) {
      chatPanelRef.current.sendMessage(text);
    }
  }, [chatInput]);

  const activeMeta = TOOLS.find((t) => t.id === activeTool);

  const renderAdvancedPanel = () => {
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
    <div className="h-screen flex flex-col overflow-hidden bg-background text-on-surface font-body selection:bg-primary/30">

      {/* ── TopNavBar ─────────────────────────────────────────────────────── */}
      <header className="fixed top-0 w-full z-50 bg-[#0e0e0f]/80 backdrop-blur-xl flex justify-between items-center px-8 h-20 shadow-[0_24px_48px_rgba(0,0,0,0.4)]">
        <div className="flex items-center gap-6">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-on-surface-variant hover:text-white transition-transform active:scale-95"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div className="flex flex-col">
            <h1 className="font-headline text-lg font-bold tracking-tight text-white leading-tight">
              {project?.title || 'AI 인테리어 에디터'}
            </h1>
            <p className="font-label text-xs tracking-widest text-primary uppercase">
              Circle.ai — {advancedMode ? 'Advanced Editor' : 'Style Transfer'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {editorStep === 'chat' && (
            <div className="flex bg-surface-container rounded-full p-1">
              <button
                className={`px-4 py-1.5 text-sm font-medium rounded-full transition-colors ${
                  !advancedMode
                    ? 'text-primary border-b-2 border-[#7c3aed]'
                    : 'text-on-surface-variant hover:text-white'
                }`}
                onClick={() => setAdvancedMode(false)}
              >
                Style Transfer
              </button>
              <button
                className={`px-4 py-1.5 text-sm font-medium rounded-full transition-colors ${
                  advancedMode
                    ? 'text-primary border-b-2 border-[#7c3aed]'
                    : 'text-on-surface-variant hover:text-white'
                }`}
                onClick={() => setAdvancedMode(true)}
              >
                Advanced Editor
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 bg-surface-container-high px-4 py-2 rounded-full border border-outline-variant/20">
            <span
              className="material-symbols-outlined text-primary text-sm"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              generating_tokens
            </span>
            <span className="font-headline font-bold text-sm tracking-tight text-white">
              {creditBalance !== null ? creditBalance : '—'}
            </span>
          </div>
        </div>
      </header>

      {/* ── Main Content ──────────────────────────────────────────────────── */}
      <main className="pt-20 h-screen flex overflow-hidden">

        {/* Left Tool Area (Narrow) */}
        <aside className="w-16 flex-shrink-0 flex flex-col items-center py-8 gap-8 bg-surface-container-low border-r border-outline-variant/10 z-10">
          <div className="relative group cursor-pointer" onClick={() => { setEditorStep('onboarding'); }}>
            <div className="absolute -inset-2 bg-primary/20 rounded-full blur opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <span
              className="material-symbols-outlined text-primary relative"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              auto_awesome
            </span>
          </div>
          <span
            className="material-symbols-outlined text-on-surface-variant hover:text-white cursor-pointer transition-colors"
            onClick={() => { setAdvancedMode(true); setActiveTool('layers'); setEditorStep('chat'); }}
          >
            layers
          </span>
          <span
            className="material-symbols-outlined text-on-surface-variant hover:text-white cursor-pointer transition-colors"
            onClick={() => { setAdvancedMode(true); setActiveTool('material'); setEditorStep('chat'); }}
          >
            palette
          </span>
          <span
            className="material-symbols-outlined text-on-surface-variant hover:text-white cursor-pointer transition-colors"
            onClick={() => { setAdvancedMode(true); setActiveTool('final_render'); setEditorStep('chat'); }}
          >
            crop_free
          </span>
        </aside>

        {/* Center Viewport */}
        <section className="flex-1 flex flex-col relative bg-surface-container-lowest p-6 min-w-0">

          {/* Advanced Editor mode */}
          {editorStep === 'chat' && advancedMode && (
            <div className="flex flex-col flex-1 overflow-hidden">
              {imageUrl ? (
                <div className="relative flex-1">
                  <RoomCanvas
                    imageSrc={imageUrl}
                    projectId={projectId}
                    onMasksChange={setCanvasSegments}
                    onEncodingChange={handleEncodingChange}
                  />
                  {chatPreviewMask && (
                    <SegmentOverlay
                      masks={[{ ...chatPreviewMask, color: '#f59e0b' }]}
                      width={chatPreviewMask.width}
                      height={chatPreviewMask.height}
                      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 10 }}
                    />
                  )}
                  {isProcessing && (
                    <ProcessingOverlay message={processingMessage} isColdStart={isColdStart} />
                  )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 text-on-surface-variant">
                  {loadingProject
                    ? <><span className="spinner spinner-lg" /><p>프로젝트 불러오는 중...</p></>
                    : <p>이미지를 불러오는 중...</p>
                  }
                </div>
              )}
            </div>
          )}

          {/* Style Transfer / Chat mode */}
          {editorStep === 'chat' && !advancedMode && (
            <>
              <div className="relative w-full flex-1 rounded-xl overflow-hidden shadow-2xl bg-surface-container border border-outline-variant/20 group">
                {displayUrl ? (
                  <img
                    className="w-full h-full object-cover"
                    src={displayUrl}
                    alt="Interior design"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                    {loadingProject ? '불러오는 중...' : '이미지를 불러오는 중...'}
                  </div>
                )}

                {/* AI Transformed badge */}
                {lastResult?.result_url && (
                  <div className="absolute top-6 left-6 flex items-center gap-2 glass-effect px-4 py-2 rounded-full border border-primary/30 violet-glow">
                    <span
                      className="material-symbols-outlined text-primary text-sm"
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      colors_spark
                    </span>
                    <span className="text-xs font-headline font-bold tracking-tight text-white uppercase">
                      AI Transformed
                    </span>
                  </div>
                )}

                {/* View Layers button */}
                <button
                  className="absolute bottom-6 right-6 glass-effect px-4 py-2 rounded-lg text-sm font-medium text-white hover:bg-white/10 transition-all flex items-center gap-2"
                  onClick={() => { setAdvancedMode(true); setActiveTool('layers'); }}
                >
                  <span className="material-symbols-outlined text-sm">filter_none</span>
                  View Layers
                </button>

                {/* Comparison slider (shown when there is a result) */}
                {lastResult?.result_url && imageUrl && (
                  <div className="absolute inset-y-0 left-1/2 w-0.5 bg-primary/50 flex items-center justify-center">
                    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shadow-lg cursor-ew-resize active:scale-90 transition-transform">
                      <span className="material-symbols-outlined text-on-primary text-sm">unfold_more</span>
                    </div>
                  </div>
                )}

                {/* Processing overlay */}
                {(isProcessing || isAnalyzing) && (
                  <ProcessingOverlay
                    message={processingMessage || (isAnalyzing ? '이미지 분석 중...' : '')}
                    isColdStart={isColdStart}
                  />
                )}
              </div>

              {/* Bottom Chat Area */}
              <div className="mt-6 flex flex-col gap-4 max-w-3xl mx-auto w-full flex-shrink-0">
                <div className="flex flex-col items-center gap-1 text-center">
                  <p className="text-sm font-medium text-white">Edit your interior with chat!</p>
                  <button
                    className="text-xs text-on-surface-variant hover:text-primary transition-colors italic"
                    onClick={() => setChatInput('Change the left wall to black')}
                  >
                    "Change the left wall to black"
                  </button>
                </div>
                <div className="relative group">
                  <input
                    className="w-full bg-surface-container-high border border-outline-variant/50 focus:border-primary focus:outline-none text-on-surface px-6 py-4 pr-36 rounded-xl transition-all"
                    placeholder="Type a request to refine your design..."
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleChatSend();
                    }}
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-3">
                    <div className="flex items-center gap-1.5 px-3 py-1 bg-surface-container-highest rounded-full border border-outline-variant/10">
                      <span
                        className="material-symbols-outlined text-[14px] text-primary"
                        style={{ fontVariationSettings: "'FILL' 1" }}
                      >
                        generating_tokens
                      </span>
                      <span className="text-[10px] font-bold text-white uppercase tracking-tighter">
                        {creditBalance !== null ? creditBalance : '—'}
                      </span>
                    </div>
                    <button
                      className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-primary-dim flex items-center justify-center text-on-primary-fixed shadow-lg hover:shadow-primary/20 transition-all active:scale-90"
                      onClick={handleChatSend}
                    >
                      <span className="material-symbols-outlined font-bold">arrow_upward</span>
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Placeholder when on onboarding step */}
          {editorStep === 'onboarding' && (
            <div className="flex-1 flex items-center justify-center text-on-surface-variant text-sm">
              분위기 설정 중...
            </div>
          )}
        </section>

        {/* Right Sidebar */}
        <aside className="w-[400px] flex-shrink-0 bg-surface-container-low border-l border-outline-variant/10 p-6 flex flex-col gap-8 overflow-y-auto">

          {/* Advanced mode: show tool panel */}
          {editorStep === 'chat' && advancedMode && (
            <div className="flex flex-col flex-1 gap-4 overflow-y-auto">
              <div className="flex flex-col gap-1">
                {activeMeta && (
                  <>
                    <h3 className="font-headline text-base font-bold text-white">{activeMeta.label}</h3>
                    <p className="text-xs text-on-surface-variant">{activeMeta.sub}</p>
                  </>
                )}
              </div>
              <div className="flex-1 overflow-y-auto">
                {renderAdvancedPanel()}
              </div>
            </div>
          )}

          {/* Style Transfer mode: show guide + actions + export */}
          {editorStep === 'chat' && !advancedMode && (
            <>
              {/* Usage Guide */}
              <div>
                <h3 className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-4">
                  Usage Guide
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div
                    className="bg-surface-container p-4 rounded-xl border border-outline-variant/5 hover:border-primary/30 transition-all cursor-pointer group"
                    onClick={() => setEditorStep('onboarding')}
                  >
                    <p className="text-[10px] font-bold text-on-surface-variant uppercase mb-2">Try saying:</p>
                    <p className="text-sm text-white font-medium group-hover:text-primary transition-colors">Change mood</p>
                  </div>
                  <div
                    className="bg-surface-container p-4 rounded-xl border border-outline-variant/5 hover:border-primary/30 transition-all cursor-pointer group"
                    onClick={() => { setAdvancedMode(true); setActiveTool('material'); }}
                  >
                    <p className="text-[10px] font-bold text-on-surface-variant uppercase mb-2">Refine:</p>
                    <p className="text-sm text-white font-medium group-hover:text-primary transition-colors">Apply material</p>
                  </div>
                  <div
                    className="bg-surface-container p-4 rounded-xl border border-outline-variant/5 hover:border-primary/30 transition-all cursor-pointer group col-span-2"
                    onClick={() => { setAdvancedMode(true); setActiveTool('material'); }}
                  >
                    <p className="text-sm text-white font-medium group-hover:text-primary transition-colors">Select specific area to edit</p>
                  </div>
                </div>
              </div>

              {/* More Actions */}
              <div className="flex flex-col gap-3">
                <h3 className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-1">
                  More actions
                </h3>
                <button
                  className="flex items-center justify-between p-4 bg-surface-container-high rounded-xl border border-outline-variant/10 hover:bg-surface-bright transition-all text-left"
                  onClick={() => setEditorStep('onboarding')}
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-primary">circle</span>
                    <span className="text-sm font-medium text-white">Circle.ai</span>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant text-sm">chevron_right</span>
                </button>
                <button
                  className="flex items-center justify-between p-4 bg-surface-container-high rounded-xl border border-outline-variant/10 hover:bg-surface-bright transition-all text-left"
                  onClick={() => { setAdvancedMode(true); setActiveTool('material'); }}
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-on-surface-variant">texture</span>
                    <span className="text-sm font-medium text-white">Material Change</span>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant text-sm">chevron_right</span>
                </button>
                <button
                  className="flex items-center justify-between p-4 bg-surface-container-high rounded-xl border border-outline-variant/10 hover:bg-surface-bright transition-all text-left"
                  onClick={() => { setAdvancedMode(true); setActiveTool('furniture'); }}
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-on-surface-variant">chair</span>
                    <span className="text-sm font-medium text-white">Furniture Change</span>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant text-sm">chevron_right</span>
                </button>
                <button
                  className="flex items-center justify-between p-4 bg-surface-container-high rounded-xl border border-outline-variant/10 hover:bg-surface-bright transition-all text-left"
                  onClick={() => { setAdvancedMode(true); setActiveTool('mood_copy'); }}
                >
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-on-surface-variant">wb_incandescent</span>
                    <span className="text-sm font-medium text-white">Lighting Change</span>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant text-sm">chevron_right</span>
                </button>
              </div>

              {/* Export Card */}
              <div className="mt-auto pt-6">
                <button
                  className="w-full relative group overflow-hidden rounded-2xl p-6 transition-all active:scale-[0.98]"
                  onClick={() => { setAdvancedMode(true); setActiveTool('final_render'); }}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-[#7c3aed] to-[#bd9dff] group-hover:opacity-90 transition-opacity"></div>
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/10 rounded-full blur-2xl group-hover:scale-150 transition-transform duration-500"></div>
                  <div className="relative flex flex-col items-start gap-1">
                    <div className="flex items-center justify-between w-full mb-2">
                      <span
                        className="material-symbols-outlined text-white"
                        style={{ fontVariationSettings: "'FILL' 1" }}
                      >
                        download
                      </span>
                      <span className="bg-black/20 text-[10px] text-white font-bold py-1 px-2 rounded-full uppercase">Pro</span>
                    </div>
                    <p className="text-lg font-headline font-bold text-white tracking-tight">Export High Quality Image</p>
                    <p className="text-xs text-white/80 font-medium">SDXL Refiner + Upscale 4K</p>
                  </div>
                </button>
              </div>
            </>
          )}

          {/* Onboarding step: show guide */}
          {editorStep === 'onboarding' && (
            <div className="flex flex-col items-center justify-center flex-1 text-on-surface-variant text-sm gap-2">
              <span className="material-symbols-outlined text-primary text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
              <p>스타일을 선택해주세요</p>
            </div>
          )}
        </aside>
      </main>

      {/* Desktop SideNavBar */}
      <nav className="hidden md:flex fixed left-0 top-20 h-[calc(100vh-80px)] w-64 bg-[#0e0e0f] flex-col py-6 border-r border-outline-variant/10 z-40">
        <div className="px-6 mb-8">
          <h2 className="font-headline text-lg font-bold text-white">Design Tools</h2>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
            <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
              AI Assistant Active
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {SIDE_NAV.map((item) => {
            const isActive = item.id !== 'chat' && activeTool === item.id && advancedMode && editorStep === 'chat';
            return (
              <a
                key={item.id}
                href="#"
                className={`px-6 py-4 flex items-center gap-4 hover:bg-white/5 transition-all ${
                  isActive
                    ? 'bg-[#7c3aed]/20 text-[#bd9dff] border-r-4 border-[#7c3aed]'
                    : 'text-[#adaaab]'
                }`}
                onClick={(e) => {
                  e.preventDefault();
                  if (item.id === 'chat') {
                    setAdvancedMode(false);
                    setEditorStep('chat');
                  } else {
                    setAdvancedMode(true);
                    setActiveTool(item.id);
                    setEditorStep('chat');
                  }
                }}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                <span className="font-body text-sm uppercase tracking-[0.1em]">{item.label}</span>
              </a>
            );
          })}
        </div>
        <div className="mt-auto px-6 flex flex-col gap-4">
          <button
            className="w-full bg-gradient-to-r from-primary to-primary-dim text-on-primary-fixed font-headline font-bold py-3 rounded-xl shadow-lg shadow-primary/10 hover:shadow-primary/20 transition-all"
            onClick={() => { setAdvancedMode(true); setActiveTool('final_render'); setEditorStep('chat'); }}
          >
            Export Render
          </button>
          <div className="flex justify-between pt-4 border-t border-outline-variant/10">
            <button className="text-on-surface-variant hover:text-white flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider">
              <span className="material-symbols-outlined text-sm">help</span> Help
            </button>
            <button
              className="text-on-surface-variant hover:text-white flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider"
              onClick={() => { setAdvancedMode(true); setActiveTool('layers'); setEditorStep('chat'); }}
            >
              <span className="material-symbols-outlined text-sm">history</span> History
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile BottomNavBar */}
      <nav className="md:hidden fixed bottom-0 left-0 w-full flex justify-around items-center h-20 bg-[#0e0e0f]/90 backdrop-blur-2xl z-50 rounded-t-3xl border-t border-white/10 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
        <a
          href="#"
          className="flex flex-col items-center justify-center text-[#adaaab] px-6 py-2 hover:text-white transition-all"
          onClick={(e) => { e.preventDefault(); navigate('/dashboard'); }}
        >
          <span className="material-symbols-outlined">home</span>
          <span className="font-body text-[10px] font-bold uppercase tracking-widest">Home</span>
        </a>
        <a
          href="#"
          className={`flex flex-col items-center justify-center px-6 py-2 transition-all ${
            !advancedMode && editorStep === 'chat'
              ? 'text-[#bd9dff] bg-[#7c3aed]/20 rounded-xl scale-110'
              : 'text-[#adaaab] hover:text-white'
          }`}
          onClick={(e) => { e.preventDefault(); setAdvancedMode(false); setEditorStep('chat'); }}
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>edit_note</span>
          <span className="font-body text-[10px] font-bold uppercase tracking-widest">Editor</span>
        </a>
        <a
          href="#"
          className="flex flex-col items-center justify-center text-[#adaaab] px-6 py-2 hover:text-white transition-all"
          onClick={(e) => { e.preventDefault(); setEditorStep('onboarding'); }}
        >
          <span className="material-symbols-outlined">compare</span>
          <span className="font-body text-[10px] font-bold uppercase tracking-widest">Compare</span>
        </a>
        <a
          href="#"
          className="flex flex-col items-center justify-center text-[#adaaab] px-6 py-2 hover:text-white transition-all"
          onClick={(e) => { e.preventDefault(); navigate('/dashboard'); }}
        >
          <span className="material-symbols-outlined">person</span>
          <span className="font-body text-[10px] font-bold uppercase tracking-widest">Profile</span>
        </a>
      </nav>

      {/* Hidden ChatPanel for logic — renders off-screen */}
      {editorStep === 'chat' && (
        <div style={{ position: 'absolute', left: '-9999px', top: 0, width: 1, height: 1, overflow: 'hidden' }}>
          <ChatPanel
            ref={chatPanelRef}
            projectId={projectId}
            imageUrl={imageUrl}
            creditBalance={creditBalance}
            onShowMask={setChatPreviewMask}
            onOpenCorrection={handleOpenCorrection}
            onResult={handleResult}
            onSwitchTool={(toolId) => { setAdvancedMode(true); setActiveTool(toolId); }}
          />
        </div>
      )}

      {/* StyleOnboarding overlay */}
      {editorStep === 'onboarding' && (
        <div className="fixed inset-0 z-30 pt-20">
          <StyleOnboarding
            projectId={projectId}
            imageUrl={imageUrl}
            creditBalance={creditBalance}
            onDone={handleOnboardingDone}
          />
        </div>
      )}

      {/* Correction Mode modal */}
      {correctionIntent && (
        <CorrectionMode
          imageUrl={imageUrl}
          initialLabel={correctionIntent.target}
          onComplete={handleCorrectionComplete}
          onCancel={() => setCorrectionIntent(null)}
        />
      )}
    </div>
  );
}

export default EditorPage;
