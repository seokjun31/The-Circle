import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import useEditorStore from '../stores/editorStore';
import { getCreditBalance, getProject, getProjectLayers } from '../utils/api';
import MoodPanel      from '../components/editor/MoodPanel';
import LightingPanel  from '../components/editor/LightingPanel';
import MaterialPanel  from '../components/editor/MaterialPanel';
import LayerPanel     from '../components/editor/LayerPanel';
import ProcessingOverlay from '../components/editor/ProcessingOverlay';
import RoomCanvas     from '../components/editor/RoomCanvas';
import CorrectionMode from '../components/editor/CorrectionMode';
import SegmentOverlay from '../components/editor/SegmentOverlay';
import { useSemanticSegmentation } from '../hooks/useSemanticSegmentation';
import { roomSegmenter } from '../lib/segmentation/semanticSegmentation';

/* ── Navigation tabs ─────────────────────────────────────────────── */
const SIDE_NAV = [
  { id: 'mood',      icon: 'palette',         label: 'Mood',      sub: '분위기 변환'  },
  { id: 'materials', icon: 'texture',         label: 'Materials', sub: '자재 & SAM'  },
  { id: 'lighting',  icon: 'wb_incandescent', label: 'Lighting',  sub: '조명 조절'   },
  { id: 'layout',    icon: 'grid_view',       label: 'Layout',    sub: '변경 기록'   },
];

/* Preset area buttons for Materials tab */
const AREA_PRESETS = [
  { label: '벽',   seg: 'wall'      },
  { label: '바닥', seg: 'floor'     },
  { label: '천장', seg: 'ceiling'   },
  { label: '문',   seg: 'door'      },
  { label: '창문', seg: 'window'    },
  { label: '가구', seg: 'furniture' },
];

/* ─────────────────────────────────────────────────────────────────── */

function EditorPage() {
  const navigate = useNavigate();
  const { projectId: pid } = useParams();

  const {
    project, activeTool, isProcessing, processingMessage,
    isColdStart, creditBalance, lastResult, layers,
    setProject, setActiveTool, setCreditBalance,
    setLayers, setLastResult, setProcessing,
    pushHistory,
  } = useEditorStore();

  /* ── local state ── */
  const [loadingProject, setLoadingProject] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const [canvasSegments, setCanvasSegments]  = useState([]);

  /* Mood tab state (lifted so center viewport can use it) */
  const [moodPhase,      setMoodPhase]      = useState('select'); // 'select'|'result'|'done'
  const [moodResultUrl,  setMoodResultUrl]  = useState(null);
  const [moodRetries,    setMoodRetries]    = useState(0);

  /* Materials tab: free retries after first coin spend */
  const [matFreeRetries, setMatFreeRetries] = useState(0);

  /* Correction Mode */
  const [correctionIntent, setCorrectionIntent] = useState(null);
  const [chatPreviewMask,  setChatPreviewMask]  = useState(null);

  const { isAnalyzing, analyzeRoom } = useSemanticSegmentation();
  const imageCanvasRef = useRef(null);

  const projectId = pid ? parseInt(pid, 10) : project?.id;
  const imageUrl  = project?.original_image_url || null;

  /* active tool defaults to 'mood' */
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
    getProject(projectId)
      .then(proj => { setProject(proj); getCreditBalance().then(d => setCreditBalance(d.balance)).catch(() => {}); })
      .catch(() => { toast.error('프로젝트를 불러오지 못했습니다.'); navigate('/dashboard'); })
      .finally(() => setLoadingProject(false));
  }, [projectId]); // eslint-disable-line

  /* ── Auto analyze on image load ── */
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

  /* ── Mood tab handlers ── */
  const handleMoodPhaseChange = useCallback((phase, resultUrl) => {
    setMoodPhase(phase);
    if (resultUrl) setMoodResultUrl(resultUrl);
  }, []);

  const handleMoodResult = useCallback((result) => {
    handleResult(result);
  }, [handleResult]);

  /* ── Materials: first paid spend → grant free retries ── */
  const handleMaterialResult = useCallback((result) => {
    if (matFreeRetries === 0) {
      setMatFreeRetries(3);
      toast.success('3회 무료로 변경 가능합니다!');
    } else {
      setMatFreeRetries(r => Math.max(0, r - 1));
    }
    handleResult(result);
  }, [matFreeRetries, handleResult]);

  /* ── SAM encoding state ── */
  const handleEncodingChange = useCallback(({ isEncoding }) => {
    if (isEncoding) setProcessing(true, 'SAM 이미지 분석 중...');
    else if (!isAnalyzing) setProcessing(false);
  }, [setProcessing, isAnalyzing]);

  /* ── Correction Mode ── */
  const handleCorrectionComplete = useCallback((mask) => {
    setCorrectionIntent(null);
    setChatPreviewMask(mask);
  }, []);

  /* ── Quick area segment for Materials tab ── */
  const handleAreaPreset = useCallback((segLabel) => {
    const segment = roomSegmenter.getSegment(segLabel);
    if (!segment) {
      toast('해당 영역이 아직 분석되지 않았습니다. 직접 선택해주세요.');
      return;
    }
    const syntheticMask = {
      mask: segment,
      width: segment.width,
      height: segment.height,
      label: segLabel,
      area: 0,
    };
    setCanvasSegments([syntheticMask]);
    toast.success(`${segLabel} 영역이 선택되었습니다.`);
  }, []);

  /* ── Display URL for center viewport ── */
  const displayUrl = lastResult?.result_url || imageUrl;

  /* ─────────────────────────────────────────────────── render ─── */
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-on-surface font-body selection:bg-primary/30">

      {/* ── TopNavBar ─────────────────────────────────────────── */}
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
              Circle.ai — {SIDE_NAV.find(n => n.id === activeTool)?.label || 'Editor'}
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

      {/* ── Desktop Left Nav (fixed, w-64) ────────────────────── */}
      <nav className="hidden md:flex fixed left-0 top-20 h-[calc(100vh-80px)] w-64 bg-[#0e0e0f] flex-col py-6 border-r border-outline-variant/10 z-40">
        <div className="px-6 mb-8">
          <h2 className="font-headline text-lg font-bold text-white">Design Tools</h2>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
              AI Assistant Active
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1 flex-1">
          {SIDE_NAV.filter(n => n.id !== 'layout').map(item => {
            const isActive = activeTool === item.id;
            return (
              <button key={item.id}
                className={`px-6 py-4 flex items-center gap-4 hover:bg-white/5 transition-all text-left ${
                  isActive ? 'bg-[#7c3aed]/20 text-[#bd9dff] border-r-4 border-[#7c3aed]' : 'text-[#adaaab]'
                }`}
                onClick={() => setActiveTool(item.id)}
              >
                <span className="material-symbols-outlined"
                  style={isActive ? { fontVariationSettings: "'FILL' 1" } : {}}>{item.icon}</span>
                <div>
                  <p className="font-body text-sm uppercase tracking-[0.1em]">{item.label}</p>
                  <p className="text-[10px] text-on-surface-variant mt-0.5">{item.sub}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Layout (layers) at the bottom */}
        <div className="border-t border-outline-variant/10 pt-4">
          <button
            className={`w-full px-6 py-4 flex items-center gap-4 hover:bg-white/5 transition-all text-left ${
              activeTool === 'layout' ? 'bg-[#7c3aed]/20 text-[#bd9dff] border-r-4 border-[#7c3aed]' : 'text-[#adaaab]'
            }`}
            onClick={() => setActiveTool('layout')}
          >
            <span className="material-symbols-outlined"
              style={activeTool === 'layout' ? { fontVariationSettings: "'FILL' 1" } : {}}>
              {SIDE_NAV.find(n => n.id === 'layout').icon}
            </span>
            <div>
              <p className="font-body text-sm uppercase tracking-[0.1em]">Layout</p>
              <p className="text-[10px] text-on-surface-variant mt-0.5">변경 전체 목록</p>
            </div>
          </button>

          <div className="px-6 pt-4">
            <button
              className="w-full bg-gradient-to-r from-primary to-primary-dim text-on-primary-fixed font-headline font-bold py-3 rounded-xl shadow-lg shadow-primary/10 hover:shadow-primary/20 transition-all text-sm"
              onClick={() => setActiveTool('lighting')}
            >
              Export Render
            </button>
          </div>
        </div>
      </nav>

      {/* ── Main (offset by nav width on desktop) ─────────────── */}
      <main className="pt-20 h-screen flex overflow-hidden md:pl-64">

        {/* ── Center Viewport ── */}
        <section className="flex-1 flex flex-col relative bg-surface-container-lowest p-6 min-w-0">

          {/* ── MOOD center: image + before/after ── */}
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
                  <img className="w-full h-full object-cover" src={displayUrl} alt="Interior" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                    {loadingProject ? '불러오는 중...' : '이미지를 불러오는 중...'}
                  </div>
                )}

                {/* AI badge */}
                {(moodResultUrl || lastResult?.result_url) && (
                  <div className="absolute top-6 left-6 flex items-center gap-2 bg-[#1a191b]/60 backdrop-blur-xl px-4 py-2 rounded-full border border-primary/30"
                    style={{ boxShadow: '0 0 20px rgba(124,58,237,0.2)' }}>
                    <span className="material-symbols-outlined text-primary text-sm"
                      style={{ fontVariationSettings: "'FILL' 1" }}>colors_spark</span>
                    <span className="text-xs font-headline font-bold tracking-tight text-white uppercase">AI Transformed</span>
                  </div>
                )}

                {/* Comparison labels when in result phase */}
                {moodPhase === 'result' && (
                  <>
                    <span className="absolute top-4 right-4 text-[10px] font-bold bg-primary/20 backdrop-blur-sm px-2 py-1 rounded-full text-primary border border-primary/30">
                      AI 변환
                    </span>
                    <span className="absolute top-4 left-16 text-[10px] font-bold bg-black/50 backdrop-blur-sm px-2 py-1 rounded-full text-white">
                      원본
                    </span>
                  </>
                )}

                {(isProcessing || isAnalyzing) && (
                  <ProcessingOverlay
                    message={processingMessage || (isAnalyzing ? '이미지 분석 중...' : '')}
                    isColdStart={isColdStart}
                  />
                )}
              </div>

              {/* Hint text */}
              {moodPhase === 'select' && (
                <p className="text-center text-xs text-on-surface-variant mt-4 flex-shrink-0">
                  오른쪽 패널에서 참조 이미지를 업로드하고 변환하세요
                </p>
              )}
            </>
          )}

          {/* ── MATERIALS center: area presets + RoomCanvas ── */}
          {activeTool === 'materials' && (
            <div className="flex flex-col flex-1 gap-3 overflow-hidden">
              {/* Area preset buttons */}
              <div className="flex-shrink-0 flex gap-2 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center pr-2">영역:</span>
                {AREA_PRESETS.map(preset => (
                  <button key={preset.seg}
                    className="px-3 py-1.5 rounded-full text-xs font-medium border border-outline-variant/30 text-on-surface-variant hover:border-primary/50 hover:text-primary transition-all bg-surface-container"
                    onClick={() => handleAreaPreset(preset.seg)}
                  >
                    {preset.label}
                  </button>
                ))}
                <span className="text-[10px] text-on-surface-variant flex items-center ml-auto">
                  또는 아래 캔버스에서 직접 선택
                </span>
              </div>

              {imageUrl ? (
                <div className="relative flex-1 overflow-hidden">
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
                <div className="flex-1 flex items-center justify-center text-on-surface-variant">
                  {loadingProject ? <span className="spinner spinner-lg" /> : '이미지를 불러오는 중...'}
                </div>
              )}
            </div>
          )}

          {/* ── LIGHTING center: image ── */}
          {activeTool === 'lighting' && (
            <div className="relative w-full flex-1 rounded-xl overflow-hidden shadow-2xl bg-surface-container border border-outline-variant/20">
              {displayUrl ? (
                <img className="w-full h-full object-cover" src={displayUrl} alt="Interior" />
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
              {isProcessing && (
                <ProcessingOverlay message={processingMessage} isColdStart={isColdStart} />
              )}
            </div>
          )}

          {/* ── LAYOUT center: current image + layer thumbnails ── */}
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

              {/* Layer thumbnail strip */}
              {layers.length > 0 && (
                <div className="flex-shrink-0 flex gap-3 overflow-x-auto pb-1">
                  {[...layers].reverse().map((layer, i) => (
                    <div key={layer.id}
                      className={`flex-shrink-0 w-24 flex flex-col gap-1 cursor-pointer group ${
                        selectedLayerId === layer.id ? 'opacity-100' : 'opacity-70 hover:opacity-100'
                      }`}
                      onClick={() => setSelectedLayerId(layer.id)}
                    >
                      <div className={`relative rounded-lg overflow-hidden h-16 border transition-all ${
                        selectedLayerId === layer.id ? 'border-primary' : 'border-outline-variant/20'
                      }`}>
                        {layer.result_url ? (
                          <img src={layer.result_url} alt={layer.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full bg-surface-container-high flex items-center justify-center">
                            <span className="material-symbols-outlined text-on-surface-variant text-sm">image</span>
                          </div>
                        )}
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

        {/* ── Right Panel (400px) ─────────────────────────────── */}
        <aside className="w-[400px] flex-shrink-0 bg-surface-container-low border-l border-outline-variant/10 p-6 flex flex-col gap-6 overflow-y-auto">

          {/* Panel title */}
          <div className="flex-shrink-0">
            {(() => {
              const nav = SIDE_NAV.find(n => n.id === activeTool);
              return nav ? (
                <div className="flex flex-col gap-1">
                  <h3 className="font-headline text-base font-bold text-white">{nav.label}</h3>
                  <p className="text-xs text-on-surface-variant">{nav.sub}</p>
                </div>
              ) : null;
            })()}
          </div>

          {/* ── MOOD panel ── */}
          {activeTool === 'mood' && (
            <MoodPanel
              projectId={projectId}
              creditBalance={creditBalance}
              onResult={handleMoodResult}
              onPhaseChange={handleMoodPhaseChange}
              phase={moodPhase}
              retriesLeft={moodRetries}
              setRetries={setMoodRetries}
            />
          )}

          {/* ── MATERIALS panel ── */}
          {activeTool === 'materials' && (
            <div className="flex flex-col gap-4 flex-1 overflow-y-auto">
              {matFreeRetries > 0 && (
                <div className="p-3 bg-primary/10 rounded-xl border border-primary/20 flex-shrink-0">
                  <p className="text-xs text-primary">
                    🎁 무료 변경 <strong>{matFreeRetries}회</strong> 남음
                  </p>
                </div>
              )}
              <div className="flex-1 overflow-y-auto">
                <MaterialPanel
                  projectId={projectId}
                  originalImageUrl={imageUrl}
                  creditBalance={creditBalance}
                  confirmedMasks={canvasSegments}
                  onResult={handleMaterialResult}
                />
              </div>
            </div>
          )}

          {/* ── LIGHTING panel ── */}
          {activeTool === 'lighting' && (
            <LightingPanel
              projectId={projectId}
              originalImageUrl={imageUrl}
              creditBalance={creditBalance}
              onResult={handleResult}
            />
          )}

          {/* ── LAYOUT panel (LayerPanel) ── */}
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

          {/* ── Export card (bottom of mood/lighting/layout panel) ── */}
          {(activeTool === 'mood' || activeTool === 'layout') && (
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

      {/* ── Mobile Bottom Nav ─────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 w-full flex justify-around items-center h-20 bg-[#0e0e0f]/90 backdrop-blur-2xl z-50 rounded-t-3xl border-t border-white/10 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
        <a href="#" onClick={e => { e.preventDefault(); navigate('/dashboard'); }}
          className="flex flex-col items-center justify-center text-[#adaaab] px-4 py-2 hover:text-white transition-all">
          <span className="material-symbols-outlined">home</span>
          <span className="font-body text-[10px] font-bold uppercase tracking-widest">Home</span>
        </a>
        {SIDE_NAV.slice(0, 3).map(item => (
          <a key={item.id} href="#"
            className={`flex flex-col items-center justify-center px-4 py-2 transition-all ${
              activeTool === item.id
                ? 'text-[#bd9dff] bg-[#7c3aed]/20 rounded-xl scale-110'
                : 'text-[#adaaab] hover:text-white'
            }`}
            onClick={e => { e.preventDefault(); setActiveTool(item.id); }}
          >
            <span className="material-symbols-outlined"
              style={activeTool === item.id ? { fontVariationSettings: "'FILL' 1" } : {}}>
              {item.icon}
            </span>
            <span className="font-body text-[10px] font-bold uppercase tracking-widest">{item.label}</span>
          </a>
        ))}
        <a href="#"
          className={`flex flex-col items-center justify-center px-4 py-2 transition-all ${
            activeTool === 'layout'
              ? 'text-[#bd9dff] bg-[#7c3aed]/20 rounded-xl scale-110'
              : 'text-[#adaaab] hover:text-white'
          }`}
          onClick={e => { e.preventDefault(); setActiveTool('layout'); }}
        >
          <span className="material-symbols-outlined"
            style={activeTool === 'layout' ? { fontVariationSettings: "'FILL' 1" } : {}}>
            grid_view
          </span>
          <span className="font-body text-[10px] font-bold uppercase tracking-widest">Layout</span>
        </a>
      </nav>

      {/* ── Correction Mode modal ─────────────────────────────── */}
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
