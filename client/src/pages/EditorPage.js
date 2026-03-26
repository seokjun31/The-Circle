import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import useEditorStore from '../stores/editorStore';
import { getCreditBalance, getProject, getProjectLayers } from '../utils/api';
import MoodPanel       from '../components/editor/MoodPanel';
import LightingPanel   from '../components/editor/LightingPanel';
import LayerPanel      from '../components/editor/LayerPanel';
import FurniturePanel  from '../components/editor/FurniturePanel';
import FurniturePlacer from '../components/editor/FurniturePlacer';
import ProcessingOverlay from '../components/editor/ProcessingOverlay';
import CorrectionMode from '../components/editor/CorrectionMode';
import MaterialsEditor from '../components/editor/MaterialsEditor';
import { useSemanticSegmentation } from '../hooks/useSemanticSegmentation';

/* ── Nav tabs (non-materials) ────────────────────────────────────── */
const SIDE_NAV = [
  { id: 'mood',      icon: 'palette',         label: 'Mood',      sub: '분위기 변환' },
  { id: 'lighting',  icon: 'wb_incandescent', label: 'Lighting',  sub: '조명 조절'   },
  { id: 'furniture', icon: 'chair',           label: 'Furniture', sub: '가구 배치'   },
];

/* ─────────────────────────────────────────────────────────────────── */

function EditorPage() {
  const navigate   = useNavigate();
  const { projectId: pid } = useParams();

  const {
    project, activeTool, isProcessing, processingMessage,
    isColdStart, creditBalance, lastResult, layers,
    setProject, setActiveTool, setCreditBalance,
    setLayers, setLastResult, setProcessing, pushHistory,
  } = useEditorStore();

  const [loadingProject, setLoadingProject] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState(null);

  /* Mood state (lifted for center viewport) */
  const [moodPhase,      setMoodPhase]      = useState('select');
  const [moodResultUrl,  setMoodResultUrl]  = useState(null);   // compare slider (reference transform)
  const [moodPreviewUrl, setMoodPreviewUrl] = useState(null);   // preset result (stays in select phase)
  const [moodRetries,    setMoodRetries]    = useState(0);

  /* Furniture state */
  const [selectedFurniture, setSelectedFurniture] = useState(null);

  /* Materials free retries */
  const [matFreeRetries, setMatFreeRetries] = useState(0);

  /* Correction Mode */
  const [correctionIntent, setCorrectionIntent] = useState(null);

  /* Layout: only explicitly added layers are shown (one per tool) */
  const [layoutLayerIds, setLayoutLayerIds] = useState(new Set());
  const [toolLayerMap,   setToolLayerMap]   = useState({});   // { mood: layerId, lighting: layerId, ... }
  /* Base image override: when user clicks a layout layer from another tool */
  const [selectedLayoutUrl, setSelectedLayoutUrl] = useState(null);

  const { isAnalyzing, analyzeRoom } = useSemanticSegmentation();
  const imageCanvasRef = useRef(null);

  const projectId = pid ? parseInt(pid, 10) : project?.id;
  const imageUrl  = project?.original_image_url || null;

  /* activeTool default */
  useEffect(() => {
    if (!activeTool) setActiveTool('mood');
  }, []); // eslint-disable-line

  /* ── Load project ── */
  useEffect(() => {
    if (!projectId) { toast.error('프로젝트를 먼저 생성해주세요.'); navigate('/dashboard'); return; }
    if (project?.id === projectId) {
      getCreditBalance().then(d => setCreditBalance(d.balance)).catch(() => {});
      return;
    }
    setLoadingProject(true);
    setLastResult(null);
    setMoodResultUrl(null);
    setMoodPhase('select');
    getProject(projectId)
      .then(proj => { setProject(proj); getCreditBalance().then(d => setCreditBalance(d.balance)).catch(() => {}); })
      .catch(() => { toast.error('프로젝트를 불러오지 못했습니다.'); navigate('/dashboard'); })
      .finally(() => setLoadingProject(false));
  }, [projectId]); // eslint-disable-line

  /* ── Auto-analyze room on image load ── */
  useEffect(() => {
    if (!imageUrl) return;
    analyzeRoom(imageUrl, imageCanvasRef.current);
  }, [imageUrl]); // eslint-disable-line

  /* ── Refresh layers ── */
  const refreshLayers = useCallback(() => {
    if (!projectId) return;
    getProjectLayers(projectId)
      .then(d => setLayers(d.layers || []))
      .catch(() => {});
  }, [projectId, setLayers]);

  useEffect(() => { refreshLayers(); }, [refreshLayers]);

  /* ── Generic result handler — does NOT auto-add to layout ── */
  const handleResult = useCallback((result) => {
    setLastResult(result);
    if (result.remaining_balance !== undefined) setCreditBalance(result.remaining_balance);
    pushHistory?.();
    // Do NOT call refreshLayers() here — layers only appear when user explicitly adds them
    getCreditBalance().then(d => setCreditBalance(d.balance)).catch(() => {});
  }, [setLastResult, setCreditBalance, pushHistory]);

  /* ── Mood handlers ── */
  const handleMoodPhaseChange = useCallback((phase, resultUrl) => {
    setMoodPhase(phase);
    if (resultUrl) setMoodResultUrl(resultUrl);
    // Going back to select for retry → clear preview so original shows
    if (phase === 'select') setMoodPreviewUrl(null);
  }, []);

  /* Called by MoodPanel when a preset is applied (stays in select phase) */
  const handlePresetResult = useCallback((url) => {
    setMoodPreviewUrl(url);
  }, []);

  /* ── Layout: add current result (one per tool, replaces existing) ── */
  const handleAddToLayout = useCallback(() => {
    const layerId = lastResult?.layer_id;
    if (!layerId) { toast.error('추가할 이미지가 없습니다.'); return; }
    setLayoutLayerIds(prev => {
      const next = new Set(prev);
      const oldId = toolLayerMap[activeTool];
      if (oldId) next.delete(oldId);
      next.add(layerId);
      return next;
    });
    setToolLayerMap(prev => ({ ...prev, [activeTool]: layerId }));
    refreshLayers(); // ensure layer data is loaded
    toast.success('레이아웃에 추가되었습니다!', { icon: '✅' });
  }, [lastResult, activeTool, toolLayerMap, refreshLayers]);

  /* ── Layout layer click: show in viewport, and use as base for other tools ── */
  const handleLayoutLayerClick = useCallback((layer) => {
    setSelectedLayerId(layer.id);
    if (layer.result_url) {
      setSelectedLayoutUrl(layer.result_url);
      if (activeTool !== 'layout') {
        toast(`레이어 이미지를 기준으로 작업합니다`, { icon: '🔗' });
      }
    }
  }, [activeTool]);

  /* ── Correction Mode ── */
  const handleCorrectionComplete = useCallback((mask) => {
    setCorrectionIntent(null);
  }, []);

  // displayUrl: layout-selected layer > last result > original
  const displayUrl = selectedLayoutUrl || lastResult?.result_url || imageUrl;

  /* ── MATERIALS: render standalone full-page MaterialsEditor ── */
  if (activeTool === 'materials') {
    return (
      <MaterialsEditor
        projectId={projectId}
        projectTitle={project?.title}
        imageUrl={imageUrl}
        creditBalance={creditBalance}
        layers={layers}
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        onResult={handleResult}
        onNavigateBack={() => navigate('/dashboard')}
        isProcessing={isProcessing}
        processingMessage={processingMessage}
        isColdStart={isColdStart}
        setProcessing={setProcessing}
        isAnalyzing={isAnalyzing}
        onAddToLayout={handleAddToLayout}
        freeRetries={matFreeRetries}
        setFreeRetries={setMatFreeRetries}
      />
    );
  }

  /* ── All other tabs: shared layout ── */
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-on-surface font-body selection:bg-primary/30">

      {/* ══ TOP NAV (h-20) ════════════════════════════════════════ */}
      <header className="fixed top-0 w-full z-50 bg-[#0e0e0f]/80 backdrop-blur-xl flex justify-between items-center px-8 h-20 shadow-[0_24px_48px_rgba(0,0,0,0.4)]">
        <div className="flex items-center gap-6">
          <button onClick={() => navigate('/dashboard')}
            className="text-on-surface-variant hover:text-white transition-transform active:scale-95">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div className="flex flex-col">
            <h1 className="font-headline text-lg font-bold tracking-tight text-white leading-tight">
              {project?.title || 'AI 인테리어 에디터'}
            </h1>
            <p className="font-label text-xs tracking-widest text-primary uppercase">
              Circle.ai — {activeTool === 'mood' ? 'Mood' : activeTool === 'lighting' ? 'Lighting' : activeTool === 'furniture' ? 'Furniture' : 'Layout'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-surface-container-high px-4 py-2 rounded-full border border-outline-variant/20">
            <span className="material-symbols-outlined text-primary text-sm"
              style={{ fontVariationSettings: "'FILL' 1" }}>generating_tokens</span>
            <span className="font-headline font-bold text-sm tracking-tight text-white">
              {creditBalance !== null ? creditBalance : '—'}
            </span>
          </div>
        </div>
      </header>

      {/* ══ ALWAYS-VISIBLE LAYOUT BAR (h-12, top-20) ════════════ */}
      <div className="fixed top-20 left-0 w-full z-40 h-12 flex items-center gap-3 bg-[#0e0e0f]/90 backdrop-blur-md border-b border-outline-variant/10 md:pl-[200px]"
        style={{ paddingLeft: 'max(200px, 0px)' }}>
        <div className="flex items-center gap-2 px-4 flex-shrink-0">
          <span className="material-symbols-outlined text-sm text-on-surface-variant">layers</span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">레이아웃</span>
        </div>
        {/* Thumbnail strip — original + explicitly added layers */}
        <div className="flex gap-2 overflow-x-auto flex-1 py-1 pr-2">
          {/* 원본 버튼 */}
          {imageUrl && (
            <div
              title="원본 이미지"
              className={`flex-shrink-0 w-8 h-8 rounded-lg overflow-hidden border transition-all cursor-pointer relative ${
                !selectedLayoutUrl ? 'border-primary ring-1 ring-primary' : 'border-outline-variant/20 hover:border-primary/60'
              }`}
              onClick={() => { setSelectedLayoutUrl(null); setSelectedLayerId(null); }}
            >
              <img src={imageUrl} alt="원본" className="w-full h-full object-cover" />
              <span className="absolute bottom-0 left-0 right-0 text-[7px] text-center bg-black/70 text-white leading-tight py-0.5">원본</span>
            </div>
          )}
          {layers.filter(l => layoutLayerIds.has(l.id)).map(layer => (
            <div key={layer.id}
              title={layer.name || layer.layer_type}
              className={`flex-shrink-0 w-8 h-8 rounded-lg overflow-hidden border transition-all cursor-pointer ${
                selectedLayoutUrl && selectedLayerId === layer.id ? 'border-primary ring-1 ring-primary' : 'border-outline-variant/20 hover:border-primary/60'
              }`}
              onClick={() => handleLayoutLayerClick(layer)}
            >
              {layer.result_url
                ? <img src={layer.result_url} alt="" className="w-full h-full object-cover" />
                : <div className="w-full h-full bg-surface-container-high" />
              }
            </div>
          ))}
          {layoutLayerIds.size === 0 && (
            <span className="text-[10px] text-on-surface-variant/50 self-center pl-2">
              변환 완료 후 레이아웃에 추가하세요
            </span>
          )}
        </div>
      </div>

      {/* ══ DESKTOP LEFT NAV (w-[200px], fixed) ════════════════ */}
      <nav className="hidden md:flex fixed left-0 top-32 h-[calc(100vh-128px)] flex-col py-6 px-4 border-r border-outline-variant/10 z-40"
        style={{ width: '200px', background: '#0e0e0f' }}>

        <div className="mb-8">
          <h2 className="font-headline text-sm font-bold text-white">Design Tools</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
              AI Assistant Active
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 flex-1">
          {/* Mood */}
          {SIDE_NAV.map(item => {
            const isActive = activeTool === item.id;
            return (
              <button key={item.id}
                className={`flex items-center gap-3 p-3 rounded-xl transition-all text-left ${
                  isActive
                    ? 'text-[#bd9dff] border-l-4 border-[#7c3aed]'
                    : 'text-[#adaaab] border-l-4 border-transparent hover:bg-white/5'
                }`}
                style={isActive ? { background: 'rgba(124,58,237,0.1)' } : {}}
                onClick={() => setActiveTool(item.id)}
              >
                <span className="material-symbols-outlined"
                  style={isActive ? { fontVariationSettings: "'FILL' 1" } : {}}>
                  {item.icon}
                </span>
                <div>
                  <p className="text-xs font-bold tracking-tight">{item.label}</p>
                  <p className="text-[9px] opacity-60">{item.sub}</p>
                </div>
              </button>
            );
          })}

          {/* Materials — navigates to full MaterialsEditor */}
          <button
            className="flex items-center gap-3 p-3 rounded-xl transition-all text-left text-[#adaaab] hover:bg-white/5 border-l-4 border-transparent"
            onClick={() => setActiveTool('materials')}
          >
            <span className="material-symbols-outlined">texture</span>
            <div>
              <p className="text-xs font-bold tracking-tight">Materials</p>
              <p className="text-[9px] opacity-60">자재 &amp; SAM</p>
            </div>
          </button>
        </div>

        {/* Bottom: Layout + Circle.ai 메이커 */}
        <div className="border-t border-outline-variant/10 pt-4 space-y-3">
          <button
            className={`flex items-center gap-3 p-3 rounded-xl transition-all text-left w-full border-l-4 ${
              activeTool === 'layout'
                ? 'text-[#bd9dff] border-[#7c3aed]'
                : 'text-[#adaaab] border-transparent hover:bg-white/5'
            }`}
            style={activeTool === 'layout' ? { background: 'rgba(124,58,237,0.1)' } : {}}
            onClick={() => setActiveTool('layout')}
          >
            <span className="material-symbols-outlined"
              style={activeTool === 'layout' ? { fontVariationSettings: "'FILL' 1" } : {}}>
              grid_view
            </span>
            <div>
              <p className="text-[10px] font-bold tracking-tight">Layout</p>
              <p className="text-[9px] opacity-60">변경 전체 목록</p>
            </div>
          </button>

          <div
            className="w-full py-2.5 rounded-full text-xs font-extrabold text-center"
            style={{
              background: 'linear-gradient(135deg, #bd9dff, #8a4cfc)',
              color: '#3c0089',
              boxShadow: '0 4px 20px rgba(189,157,255,0.2)',
              cursor: 'default',
            }}
          >
            Circle.ai
          </div>
        </div>
      </nav>

      {/* ══ MAIN (offset for nav + layout bar) ════════════════════ */}
      {/* top-20 (nav) + h-12 (layout bar) = pt-32 */}
      <main className="pt-32 h-screen flex overflow-hidden md:pl-[200px]">

        {/* ── CENTER Viewport ── */}
        <section className="flex-1 flex flex-col relative bg-surface-container-lowest p-6 min-w-0">

          {/* MOOD center */}
          {activeTool === 'mood' && (
            <>
              <div className="relative w-full flex-1 rounded-xl overflow-hidden shadow-2xl bg-surface-container border border-outline-variant/20 flex items-center justify-center">
                {(moodPhase === 'result' || moodPhase === 'done') && moodResultUrl && imageUrl ? (
                  /* Compare slider — fills viewport exactly like the original image */
                  <ReactCompareSlider
                    itemOne={<ReactCompareSliderImage src={imageUrl} alt="원본" style={{ objectFit: 'contain' }} />}
                    itemTwo={<ReactCompareSliderImage src={moodResultUrl} alt="변환" style={{ objectFit: 'contain' }} />}
                    style={{ width: '100%', height: '100%' }}
                  />
                ) : moodPreviewUrl ? (
                  /* Preset result preview (stays in select phase) */
                  <img className="w-full h-full object-contain" src={moodPreviewUrl} alt="프리셋 변환" />
                ) : imageUrl ? (
                  /* Original image */
                  <img className="w-full h-full object-contain" src={imageUrl} alt="Interior" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                    {loadingProject ? '불러오는 중...' : '이미지를 불러오는 중...'}
                  </div>
                )}

                {moodPreviewUrl && moodPhase === 'select' && (
                  <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#1a191b]/60 backdrop-blur-xl px-4 py-2 rounded-full border border-primary/30"
                    style={{ boxShadow: '0 0 20px rgba(124,58,237,0.2)' }}>
                    <span className="material-symbols-outlined text-primary text-sm"
                      style={{ fontVariationSettings: "'FILL' 1" }}>colors_spark</span>
                    <span className="text-xs font-headline font-bold tracking-tight text-white uppercase">AI Transformed</span>
                  </div>
                )}

                {(moodPhase === 'result' || moodPhase === 'done') && (
                  <>
                    <span className="absolute top-4 right-4 text-[10px] font-bold bg-primary/20 backdrop-blur-sm px-2 py-1 rounded-full text-primary border border-primary/30">AI 변환</span>
                    <span className="absolute top-4 left-16 text-[10px] font-bold bg-black/50 backdrop-blur-sm px-2 py-1 rounded-full text-white">원본</span>
                  </>
                )}

                {(isProcessing || isAnalyzing) && (
                  <ProcessingOverlay
                    message={processingMessage || (isAnalyzing ? '이미지 분석 중...' : '')}
                    isColdStart={isColdStart}
                  />
                )}
              </div>

              {moodPhase === 'select' && !moodPreviewUrl && (
                <p className="text-center text-xs text-on-surface-variant mt-3 flex-shrink-0">
                  오른쪽 패널에서 스타일을 선택하거나 참조 이미지를 업로드하세요
                </p>
              )}
            </>
          )}

          {/* LIGHTING center */}
          {activeTool === 'lighting' && (
            <div className="relative w-full flex-1 rounded-xl overflow-hidden shadow-2xl bg-surface-container border border-outline-variant/20">
              {displayUrl ? (
                <img className="w-full h-full object-contain" src={displayUrl} alt="Interior" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                  {loadingProject ? '불러오는 중...' : '이미지를 불러오는 중...'}
                </div>
              )}
              <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#1a191b]/60 backdrop-blur-xl px-4 py-2 rounded-full border border-outline-variant/20">
                <span className="material-symbols-outlined text-primary text-sm"
                  style={{ fontVariationSettings: "'FILL' 1" }}>wb_incandescent</span>
                <span className="text-xs font-headline font-bold text-white uppercase tracking-wider">Lighting</span>
              </div>
              {isProcessing && <ProcessingOverlay message={processingMessage} isColdStart={isColdStart} />}
            </div>
          )}

          {/* FURNITURE center */}
          {activeTool === 'furniture' && (
            <div className="relative w-full flex-1 rounded-xl overflow-hidden shadow-2xl bg-surface-container border border-outline-variant/20">
              {selectedFurniture ? (
                <FurniturePlacer
                  projectId={projectId}
                  originalImageUrl={displayUrl}
                  furniture={selectedFurniture}
                  creditBalance={creditBalance}
                  onResult={handleResult}
                />
              ) : displayUrl ? (
                <img className="w-full h-full object-contain" src={displayUrl} alt="Interior" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                  {loadingProject ? '불러오는 중...' : '이미지를 불러오는 중...'}
                </div>
              )}
              <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#1a191b]/60 backdrop-blur-xl px-4 py-2 rounded-full border border-outline-variant/20">
                <span className="material-symbols-outlined text-primary text-sm"
                  style={{ fontVariationSettings: "'FILL' 1" }}>chair</span>
                <span className="text-xs font-headline font-bold text-white uppercase tracking-wider">Furniture</span>
              </div>
              {isProcessing && <ProcessingOverlay message={processingMessage} isColdStart={isColdStart} />}
            </div>
          )}

          {/* LAYOUT center */}
          {activeTool === 'layout' && (
            <div className="flex flex-col flex-1 gap-4 overflow-hidden">
              <div className="relative flex-1 rounded-xl overflow-hidden shadow-2xl bg-surface-container border border-outline-variant/20">
                {displayUrl ? (
                  <img className="w-full h-full object-cover" src={displayUrl} alt="Interior" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                    {loadingProject ? '불러오는 중...' : '이미지를 불러오는 중...'}
                  </div>
                )}
                <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#1a191b]/60 backdrop-blur-xl px-4 py-2 rounded-full border border-outline-variant/20">
                  <span className="material-symbols-outlined text-primary text-sm"
                    style={{ fontVariationSettings: "'FILL' 1" }}>layers</span>
                  <span className="text-xs font-headline font-bold text-white uppercase tracking-wider">
                    {layoutLayerIds.size}개의 레이아웃 레이어
                  </span>
                </div>
              </div>
              {/* Thumbnail strip — 원본 + pinned layers */}
              <div className="flex-shrink-0 flex gap-3 overflow-x-auto pb-1">
                {/* 원본 썸네일 */}
                {imageUrl && (
                  <div
                    className="flex-shrink-0 w-24 flex flex-col gap-1 cursor-pointer"
                    onClick={() => { setSelectedLayoutUrl(null); setSelectedLayerId(null); }}
                  >
                    <div className={`relative rounded-lg overflow-hidden h-16 border transition-all ${
                      !selectedLayoutUrl ? 'border-primary ring-1 ring-primary' : 'border-outline-variant/20 hover:border-primary/60'
                    }`}>
                      <img src={imageUrl} alt="원본" className="w-full h-full object-cover" />
                      <span className="absolute bottom-1 left-1 text-[9px] bg-black/70 px-1 py-0.5 rounded text-white">원본</span>
                    </div>
                    <p className="text-[10px] text-on-surface-variant truncate text-center">원본</p>
                  </div>
                )}
                {layers.filter(l => layoutLayerIds.has(l.id)).map((layer, i) => (
                  <div key={layer.id}
                    className="flex-shrink-0 w-24 flex flex-col gap-1 cursor-pointer"
                    onClick={() => handleLayoutLayerClick(layer)}
                  >
                    <div className={`relative rounded-lg overflow-hidden h-16 border transition-all ${
                      selectedLayoutUrl && selectedLayerId === layer.id ? 'border-primary ring-1 ring-primary' : 'border-outline-variant/20 hover:border-primary/60'
                    }`}>
                      {layer.result_url
                        ? <img src={layer.result_url} alt={layer.name} className="w-full h-full object-cover" />
                        : <div className="w-full h-full bg-surface-container-high flex items-center justify-center">
                            <span className="material-symbols-outlined text-on-surface-variant text-sm">image</span>
                          </div>
                      }
                      <span className="absolute bottom-1 left-1 text-[9px] bg-black/70 px-1 py-0.5 rounded text-white">
                        {i + 1}
                      </span>
                    </div>
                    <p className="text-[10px] text-on-surface-variant truncate text-center">
                      {layer.name || `레이어 ${i + 1}`}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── RIGHT PANEL ── */}
        <aside className="w-[400px] flex-shrink-0 bg-surface-container-low border-l border-outline-variant/10 p-6 flex flex-col gap-6 overflow-y-auto">

          {/* Panel title */}
          {activeTool === 'mood' && (
            <div className="flex-shrink-0 flex flex-col gap-1">
              <h3 className="font-headline text-base font-bold text-white">Mood</h3>
              <p className="text-xs text-on-surface-variant">분위기 변환</p>
            </div>
          )}
          {activeTool === 'lighting' && (
            <div className="flex-shrink-0 flex flex-col gap-1">
              <h3 className="font-headline text-base font-bold text-white">Lighting</h3>
              <p className="text-xs text-on-surface-variant">조명 조절</p>
            </div>
          )}
          {activeTool === 'furniture' && (
            <div className="flex-shrink-0 flex flex-col gap-1">
              <h3 className="font-headline text-base font-bold text-white">Furniture</h3>
              <p className="text-xs text-on-surface-variant">가구 배치</p>
            </div>
          )}
          {activeTool === 'layout' && (
            <div className="flex-shrink-0 flex flex-col gap-1">
              <h3 className="font-headline text-base font-bold text-white">Layout</h3>
              <p className="text-xs text-on-surface-variant">변경 전체 목록</p>
            </div>
          )}

          {/* MOOD panel */}
          {activeTool === 'mood' && (
            <MoodPanel
              projectId={projectId}
              creditBalance={creditBalance}
              onResult={handleResult}
              onPhaseChange={handleMoodPhaseChange}
              onPresetResult={handlePresetResult}
              onAddToLayout={handleAddToLayout}
              phase={moodPhase}
              retriesLeft={moodRetries}
              setRetries={setMoodRetries}
            />
          )}

          {/* FURNITURE panel */}
          {activeTool === 'furniture' && (
            <FurniturePanel
              selectedFurniture={selectedFurniture}
              onSelect={setSelectedFurniture}
            />
          )}

          {/* LIGHTING panel */}
          {activeTool === 'lighting' && (
            <LightingPanel
              projectId={projectId}
              originalImageUrl={displayUrl}
              creditBalance={creditBalance}
              onResult={handleResult}
            />
          )}

          {/* LAYOUT panel */}
          {activeTool === 'layout' && (
            <div className="flex-1 overflow-y-auto">
              {layoutLayerIds.size === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 gap-3 text-on-surface-variant">
                  <span className="material-symbols-outlined text-4xl opacity-40">layers</span>
                  <p className="text-sm text-center">레이아웃이 비어 있습니다.<br />각 탭에서 변환 후 "레이아웃에 추가" 버튼을 눌러주세요.</p>
                </div>
              ) : (
                <LayerPanel
                  projectId={projectId}
                  layers={layers.filter(l => layoutLayerIds.has(l.id))}
                  selected={selectedLayerId}
                  onSelect={(id) => {
                    const layer = layers.find(l => l.id === id);
                    if (layer) handleLayoutLayerClick(layer);
                  }}
                  onLayersChange={refreshLayers}
                />
              )}
            </div>
          )}

          {/* Export card: only shown from MoodPanel done phase */}
        </aside>
      </main>

      {/* ══ MOBILE BOTTOM NAV ═════════════════════════════════════ */}
      <nav className="md:hidden fixed bottom-0 left-0 w-full flex justify-around items-center h-20 bg-[#0e0e0f]/90 backdrop-blur-2xl z-50 rounded-t-3xl border-t border-white/10 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
        <a href="#" onClick={e => { e.preventDefault(); navigate('/dashboard'); }}
          className="flex flex-col items-center justify-center text-[#adaaab] px-4 py-2 hover:text-white transition-all">
          <span className="material-symbols-outlined">home</span>
          <span className="text-[10px] font-bold uppercase tracking-widest">Home</span>
        </a>
        {['mood', 'materials', 'lighting', 'furniture', 'layout'].map(tool => {
          const icons = { mood: 'palette', materials: 'texture', lighting: 'wb_incandescent', furniture: 'chair', layout: 'grid_view' };
          return (
            <a key={tool} href="#"
              className={`flex flex-col items-center justify-center px-4 py-2 transition-all ${
                activeTool === tool
                  ? 'text-[#bd9dff] bg-[#7c3aed]/20 rounded-xl scale-110'
                  : 'text-[#adaaab] hover:text-white'
              }`}
              onClick={e => { e.preventDefault(); setActiveTool(tool); }}
            >
              <span className="material-symbols-outlined"
                style={activeTool === tool ? { fontVariationSettings: "'FILL' 1" } : {}}>{icons[tool]}</span>
              <span className="text-[10px] font-bold uppercase tracking-widest capitalize">{tool}</span>
            </a>
          );
        })}
      </nav>

      {/* ══ CORRECTION MODE ═══════════════════════════════════════ */}
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
