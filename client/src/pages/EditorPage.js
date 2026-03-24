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
  const [moodPhase,    setMoodPhase]    = useState('select');
  const [moodResultUrl,setMoodResultUrl]= useState(null);
  const [moodRetries,  setMoodRetries]  = useState(0);

  /* Furniture state */
  const [selectedFurniture, setSelectedFurniture] = useState(null);

  /* Materials free retries */
  const [matFreeRetries, setMatFreeRetries] = useState(0);

  /* Correction Mode */
  const [correctionIntent, setCorrectionIntent] = useState(null);

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

  /* ── Generic result handler ── */
  const handleResult = useCallback((result) => {
    setLastResult(result);
    if (result.remaining_balance !== undefined) setCreditBalance(result.remaining_balance);
    pushHistory?.();
    refreshLayers();
    getCreditBalance().then(d => setCreditBalance(d.balance)).catch(() => {});
  }, [setLastResult, setCreditBalance, pushHistory, refreshLayers]);

  /* ── Mood handlers ── */
  const handleMoodPhaseChange = useCallback((phase, resultUrl) => {
    setMoodPhase(phase);
    if (resultUrl) setMoodResultUrl(resultUrl);
  }, []);

  /* ── Layout bar: add current result to layout ── */
  const handleAddToLayout = useCallback(() => {
    const url = lastResult?.result_url || imageUrl;
    if (!url) { toast.error('추가할 이미지가 없습니다.'); return; }
    refreshLayers();
    toast.success('레이아웃에 추가되었습니다!', { icon: '✅' });
  }, [lastResult, imageUrl, refreshLayers]);

  /* ── Correction Mode ── */
  const handleCorrectionComplete = useCallback((mask) => {
    setCorrectionIntent(null);
  }, []);

  const displayUrl = lastResult?.result_url || imageUrl;

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
          {/* Layout add button (always visible in nav) */}
          {lastResult?.result_url && (
            <button
              onClick={handleAddToLayout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-primary/30 text-primary text-xs font-bold hover:bg-primary/10 transition-all"
            >
              <span className="material-symbols-outlined text-sm">add_photo_alternate</span>
              레이아웃 추가
            </button>
          )}
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
        {/* Thumbnail strip */}
        <div className="flex gap-2 overflow-x-auto flex-1 py-1 pr-2">
          {[...layers].reverse().map(layer => (
            <div key={layer.id}
              className={`flex-shrink-0 w-8 h-8 rounded-lg overflow-hidden border transition-all cursor-pointer ${
                selectedLayerId === layer.id ? 'border-primary' : 'border-outline-variant/20 hover:border-outline-variant/60'
              }`}
              onClick={() => { setSelectedLayerId(layer.id); setActiveTool('layout'); }}
            >
              {layer.result_url
                ? <img src={layer.result_url} alt="" className="w-full h-full object-cover" />
                : <div className="w-full h-full bg-surface-container-high" />
              }
            </div>
          ))}
        </div>
        {/* "레이아웃 추가" button */}
        <button
          onClick={handleAddToLayout}
          className="flex-shrink-0 flex items-center gap-1.5 mr-3 px-3 py-1 rounded-lg border border-outline-variant/30 text-on-surface-variant text-[10px] font-bold hover:border-primary/50 hover:text-primary transition-all"
        >
          <span className="material-symbols-outlined text-sm">add</span>
          레이아웃 추가
        </button>
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
              <div className="relative w-full flex-1 rounded-xl overflow-hidden shadow-2xl bg-surface-container border border-outline-variant/20">
                {moodPhase === 'result' && moodResultUrl && imageUrl ? (
                  <ReactCompareSlider
                    itemOne={<ReactCompareSliderImage src={imageUrl} alt="원본" style={{ objectFit: 'cover' }} />}
                    itemTwo={<ReactCompareSliderImage src={moodResultUrl} alt="변환" style={{ objectFit: 'cover' }} />}
                    style={{ width: '100%', height: '100%' }}
                  />
                ) : displayUrl ? (
                  <img className="w-full h-full object-contain" src={displayUrl} alt="Interior" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                    {loadingProject ? '불러오는 중...' : '이미지를 불러오는 중...'}
                  </div>
                )}

                {(moodResultUrl || lastResult?.result_url) && (
                  <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#1a191b]/60 backdrop-blur-xl px-4 py-2 rounded-full border border-primary/30"
                    style={{ boxShadow: '0 0 20px rgba(124,58,237,0.2)' }}>
                    <span className="material-symbols-outlined text-primary text-sm"
                      style={{ fontVariationSettings: "'FILL' 1" }}>colors_spark</span>
                    <span className="text-xs font-headline font-bold tracking-tight text-white uppercase">AI Transformed</span>
                  </div>
                )}

                {moodPhase === 'result' && (
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

              {moodPhase === 'select' && (
                <p className="text-center text-xs text-on-surface-variant mt-3 flex-shrink-0">
                  오른쪽 패널에서 참조 이미지를 업로드하고 변환하세요
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
                    {layers.length}개의 변경 레이어
                  </span>
                </div>
              </div>
              {/* Thumbnail strip */}
              {layers.length > 0 && (
                <div className="flex-shrink-0 flex gap-3 overflow-x-auto pb-1">
                  {[...layers].reverse().map((layer, i) => (
                    <div key={layer.id}
                      className={`flex-shrink-0 w-24 flex flex-col gap-1 cursor-pointer`}
                      onClick={() => setSelectedLayerId(layer.id)}
                    >
                      <div className={`relative rounded-lg overflow-hidden h-16 border transition-all ${
                        selectedLayerId === layer.id ? 'border-primary' : 'border-outline-variant/20'
                      }`}>
                        {layer.result_url
                          ? <img src={layer.result_url} alt={layer.name} className="w-full h-full object-cover" />
                          : <div className="w-full h-full bg-surface-container-high flex items-center justify-center">
                              <span className="material-symbols-outlined text-on-surface-variant text-sm">image</span>
                            </div>
                        }
                        <span className="absolute bottom-1 left-1 text-[9px] bg-black/70 px-1 py-0.5 rounded text-white">
                          {layers.length - i}
                        </span>
                      </div>
                      <p className="text-[10px] text-on-surface-variant truncate text-center">
                        {layer.name || `레이어 ${layers.length - i}`}
                      </p>
                    </div>
                  ))}
                </div>
              )}
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
              {layers.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 gap-3 text-on-surface-variant">
                  <span className="material-symbols-outlined text-4xl opacity-40">layers</span>
                  <p className="text-sm text-center">아직 변경 내역이 없습니다.<br />Mood, Materials, Lighting 탭에서 편집을 시작하세요.</p>
                </div>
              ) : (
                <LayerPanel
                  projectId={projectId}
                  layers={layers}
                  selected={selectedLayerId}
                  onSelect={setSelectedLayerId}
                  onLayersChange={refreshLayers}
                />
              )}
            </div>
          )}

          {/* Export card for mood/furniture/layout */}
          {(activeTool === 'mood' || activeTool === 'furniture' || activeTool === 'layout') && (
            <div className="mt-auto pt-4 flex-shrink-0">
              <button
                className="w-full relative group overflow-hidden rounded-2xl p-6 transition-all active:scale-[0.98]"
                onClick={() => setActiveTool('lighting')}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-[#7c3aed] to-[#bd9dff] group-hover:opacity-90 transition-opacity" />
                <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/10 rounded-full blur-2xl group-hover:scale-150 transition-transform duration-500" />
                <div className="relative flex flex-col items-start gap-1">
                  <div className="flex items-center justify-between w-full mb-2">
                    <span className="material-symbols-outlined text-white"
                      style={{ fontVariationSettings: "'FILL' 1" }}>download</span>
                    <span className="bg-black/20 text-[10px] text-white font-bold py-1 px-2 rounded-full uppercase">Pro</span>
                  </div>
                  <p className="text-lg font-headline font-bold text-white tracking-tight">Export High Quality Image</p>
                  <p className="text-xs text-white/80 font-medium">SDXL Refiner + Upscale 4K</p>
                </div>
              </button>
            </div>
          )}
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
