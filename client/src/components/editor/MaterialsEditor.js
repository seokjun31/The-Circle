/**
 * MaterialsEditor — Full-screen SAM + Material application page
 * Photoshop/Figma-style professional layout
 *
 * Layout:
 *   [TopNav h-16] [AreaSubBar h-12]
 *   [LeftNav 208px | LeftPanel 280px | Center flex | RightPanel 320px]
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import RoomCanvas from './RoomCanvas';
import ProcessingOverlay from './ProcessingOverlay';
import { getMaterialList, applyMaterial } from '../../utils/api';
import { roomSegmenter } from '../../lib/segmentation/semanticSegmentation';

/* ── Static data ─────────────────────────────────────────────────── */

const AREAS = [
  { id: 'wall',      label: 'Wall',      labelKo: '벽'   },
  { id: 'floor',     label: 'Floor',     labelKo: '바닥'  },
  { id: 'ceiling',   label: 'Ceiling',   labelKo: '천장'  },
  { id: 'door',      label: 'Door',      labelKo: '문'    },
  { id: 'window',    label: 'Window',    labelKo: '창문'  },
  { id: 'furniture', label: 'Furniture', labelKo: '가구'  },
];

const INPUT_MODES = [
  { id: 'lasso', label: 'Lasso', icon: 'pentagon',               enabled: true  },
  { id: 'point', label: 'Point', icon: 'near_me',                enabled: true  },
  { id: 'box',   label: 'Box',   icon: 'check_box_outline_blank', enabled: false },
  { id: 'brush', label: 'Brush', icon: 'brush',                   enabled: false },
];

const CATEGORIES = [
  { id: 'wallpaper', label: 'Wallpaper' },
  { id: 'flooring',  label: 'Floor'     },
  { id: 'tile',      label: 'Tile'      },
  { id: 'paint',     label: 'Paint'     },
  { id: 'upload',    label: '내 자재'   },
];

const STYLE_FILTERS = [
  { id: '',          label: 'All'     },
  { id: 'modern',    label: 'Modern'  },
  { id: 'classic',   label: 'Classic' },
  { id: 'nordic',    label: 'Nordic'  },
  { id: 'natural',   label: 'Natural' },
];

const NAV_TOOLS = [
  { id: 'mood',      icon: 'palette', label: 'MOOD',      sub: 'Style Transfer' },
  { id: 'materials', icon: 'texture', label: 'MATERIALS', sub: 'Material & SAM' },
  { id: 'furniture', icon: 'chair',   label: 'FURNITURE', sub: '가구 배치'       },
];

/* ─────────────────────────────────────────────────────────────────── */

export default function MaterialsEditor({
  projectId,
  projectTitle,
  imageUrl,
  creditBalance,
  layers = [],
  activeTool,
  setActiveTool,
  embedded = false,   // when true: renders within EditorPage shell (no own header/nav)
  onResult,
  onNavigateBack,
  isProcessing,
  processingMessage,
  isColdStart,
  setProcessing,
  isAnalyzing,
  onAddToLayout,
  freeRetries,
  setFreeRetries,
}) {
  /* ── State ── */
  const [selectedArea,   setSelectedArea]   = useState('wall');
  const [canvasMode,     setCanvasMode]     = useState('point');
  const [canvasSegments, setCanvasSegments] = useState([]);

  const [matCategory,    setMatCategory]    = useState('wallpaper');
  const [matFilter,      setMatFilter]      = useState('');
  const [matSearch,      setMatSearch]      = useState('');
  const [matSearchInput, setMatSearchInput] = useState('');
  const [materials,      setMaterials]      = useState([]);
  const [loadingMats,    setLoadingMats]    = useState(false);
  const [selectedMat,    setSelectedMat]    = useState(null);
  const [applyLoading,   setApplyLoading]   = useState(false);

  const [uploadedMats,   setUploadedMats]   = useState([]);

  const uploadRef = useRef(null);

  const handleEncodingChange = useCallback(({ isEncoding }) => {
    if (isEncoding) setProcessing?.(true, 'SAM 이미지 분석 중...');
    else if (!isAnalyzing) setProcessing?.(false);
  }, [setProcessing, isAnalyzing]);

  /* ── Fetch material catalog ── */
  useEffect(() => {
    if (matCategory === 'upload') return;
    setLoadingMats(true);
    getMaterialList({ category: matCategory, style: matFilter, search: matSearch, pageSize: 20 })
      .then(d => setMaterials(d.materials || []))
      .catch(() => setMaterials([]))
      .finally(() => setLoadingMats(false));
  }, [matCategory, matFilter, matSearch]);

  /* ── Area quick-select via semantic segmentation ── */
  const handleAreaPreset = useCallback((areaId) => {
    setSelectedArea(areaId);
    const seg = roomSegmenter.getSegment(areaId);
    if (seg) {
      setCanvasSegments([{ mask: seg, width: seg.width, height: seg.height, label: areaId, area: 0 }]);
      toast.success(`${areaId} 영역 자동 선택됨`);
    }
  }, []);

  /* ── Apply material ── */
  const handleApply = useCallback(async () => {
    if (!selectedMat)           { toast.error('자재를 선택해주세요.');    return; }
    if (!canvasSegments.length) { toast.error('영역을 먼저 선택해주세요.'); return; }
    const isFree = (freeRetries ?? 0) > 0;
    if (!isFree && (creditBalance ?? 0) < 3) { toast.error(`크레딧 부족 (잔액: ${creditBalance ?? 0})`); return; }
    setApplyLoading(true);
    try {
      const mask   = canvasSegments[0];
      const result = await applyMaterial(projectId, {
        material_id:  selectedMat.id,
        layer_id:     mask.layerId,
        mask_data:    mask.pngDataUrl,
      });
      if (typeof setFreeRetries === 'function') {
        if ((freeRetries ?? 0) === 0) { setFreeRetries(3); toast.success('3회 무료 변경이 적용됩니다!'); }
        else                          setFreeRetries(r => Math.max(0, r - 1));
      }
      onResult?.(result);
    } catch (err) {
      toast.error('자재 적용 실패: ' + err.message);
    } finally {
      setApplyLoading(false);
    }
  }, [selectedMat, canvasSegments, freeRetries, creditBalance, projectId, onResult, setFreeRetries]);

  /* ── Material upload ── */
  const handleUploadFile = useCallback((file) => {
    if (!file?.type.startsWith('image/')) { toast.error('이미지 파일만 가능합니다.'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const url = e.target.result;
      const mat = { id: `upload_${Date.now()}`, name: file.name, thumbnail_url: url, isCustom: true };
      setUploadedMats(prev => [mat, ...prev]);
      setSelectedMat(mat);
      if (typeof setFreeRetries === 'function' && (freeRetries ?? 0) < 3) {
        setFreeRetries(3);
        toast('새 이미지 업로드 — 무료 변경 3회 리셋!', { icon: '🎁' });
      } else {
        toast.success('자재 이미지가 추가되었습니다!');
      }
    };
    reader.readAsDataURL(file);
  }, [freeRetries, setFreeRetries]);

  const displayMats = matCategory === 'upload' ? uploadedMats : materials;

  /* ── Embedded render (inside EditorPage shell) ── */
  if (embedded) {
    return (
      <div className="flex flex-col h-full overflow-hidden text-white">

        {/* AREA bar — non-fixed, part of flow */}
        <div className="flex-shrink-0 h-12 flex items-center justify-between px-6"
          style={{ background: 'rgba(14,14,15,0.9)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: '#adaaab' }}>Area:</span>
            <div className="flex gap-1">
              {AREAS.map(area => (
                <button key={area.id}
                  className="px-3 py-1 rounded-full text-xs font-bold transition-all"
                  style={selectedArea === area.id
                    ? { background: '#ffffff', color: '#000000' }
                    : { color: '#adaaab' }}
                  onClick={() => handleAreaPreset(area.id)}
                >
                  {area.label}
                </button>
              ))}
            </div>
          </div>
          <button className="text-[10px] underline transition-colors" style={{ color: '#adaaab' }}
            onClick={() => setCanvasMode('lasso')}>
            Or select directly on canvas below
          </button>
        </div>

        {/* 3-column content */}
        <div className="flex flex-1 overflow-hidden">

          {/* Left inspector */}
          <aside className="flex-shrink-0 p-4 overflow-y-auto"
            style={{ width: '240px', background: 'rgba(24,24,27,0.6)', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="space-y-6">

              {/* Input Mode */}
              <section>
                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: '#adaaab' }}>Input Mode</h4>
                <div className="grid grid-cols-2 gap-2">
                  {INPUT_MODES.map(mode => {
                    const isActive = canvasMode === mode.id;
                    return (
                      <button key={mode.id}
                        disabled={!mode.enabled}
                        className="flex flex-col items-center justify-center p-2 rounded-xl transition-all"
                        style={{
                          background: mode.enabled ? '#201f21' : '#131314',
                          border: isActive ? '1px solid #bd9dff' : '1px solid rgba(72,72,73,0.2)',
                          opacity: mode.enabled ? 1 : 0.4,
                          cursor: mode.enabled ? 'pointer' : 'not-allowed',
                          boxShadow: isActive ? '0 0 12px rgba(189,157,255,0.3)' : 'none',
                        }}
                        onClick={() => mode.enabled && setCanvasMode(mode.id)}
                      >
                        <span className="material-symbols-outlined text-base mb-0.5"
                          style={{ color: isActive ? '#bd9dff' : '#adaaab' }}>{mode.icon}</span>
                        <span className="text-[10px] font-bold" style={{ color: isActive ? '#ffffff' : '#adaaab' }}>{mode.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Selection summary */}
              {canvasSegments.length > 0 && (
                <section className="p-3 rounded-xl" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(189,157,255,0.2)' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2 h-2 rounded-full" style={{ background: '#10b981' }} />
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#10b981' }}>선택됨</span>
                  </div>
                  <p className="text-xs font-semibold text-white">
                    {canvasSegments[0]?.label || selectedArea} — {canvasSegments.length}개 선택
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button className="flex-1 py-1 rounded-lg text-[10px] font-bold transition-all hover:opacity-80"
                      style={{ background: 'rgba(189,157,255,0.15)', color: '#bd9dff' }}
                      onClick={() => setCanvasSegments([])}>
                      취소
                    </button>
                  </div>
                </section>
              )}

              {/* Usage guide */}
              <section className="p-3 rounded-xl" style={{ background: 'rgba(14,14,15,0.8)', border: '1px solid rgba(72,72,73,0.2)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-sm" style={{ color: '#bd9dff' }}>info</span>
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#adaaab' }}>Usage Guide</span>
                </div>
                <ul className="space-y-1 text-[10px]" style={{ color: '#767576' }}>
                  <li><span style={{ color: '#10b981' }}>왼쪽 클릭:</span> 선택할 영역 추가</li>
                  <li><span style={{ color: '#ff5555' }}>오른쪽 클릭:</span> 선택 제외</li>
                  <li>여러 번 클릭해 영역을 정밀하게 조절하세요.</li>
                  <li>오른쪽 패널에서 자재 선택 후 Render 클릭.</li>
                </ul>
              </section>

            </div>
          </aside>

          {/* Center canvas */}
          <section className="flex-1 relative overflow-hidden flex items-center justify-center"
            style={{ background: '#000000' }}>
            <div className="absolute top-4 right-4 z-10 px-3 py-1 rounded-full"
              style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <span className="text-[10px] font-bold tracking-widest uppercase">Preview Mode</span>
            </div>
            <div className="relative w-full h-full rounded-xl overflow-hidden"
              style={{ border: '1px solid rgba(72,72,73,0.1)' }}>
              {imageUrl ? (
                <RoomCanvas
                  imageSrc={imageUrl}
                  projectId={projectId}
                  onMasksChange={setCanvasSegments}
                  onEncodingChange={handleEncodingChange}
                  externalMode={canvasMode}
                  hideSidebar={true}
                  lazy={true}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center" style={{ color: '#adaaab' }}>
                  이미지를 불러오는 중...
                </div>
              )}
              {(isProcessing || isAnalyzing) && (
                <ProcessingOverlay
                  message={processingMessage || (isAnalyzing ? '이미지 분석 중...' : '')}
                  isColdStart={isColdStart}
                />
              )}
            </div>
          </section>

          {/* Right panel */}
          <aside className="flex-shrink-0 flex flex-col"
            style={{ width: '300px', background: '#111111', borderLeft: '1px solid rgba(255,255,255,0.05)' }}>

            <header className="p-4" style={{ borderBottom: '1px solid rgba(72,72,73,0.1)' }}>
              <h3 className="text-base font-bold font-headline leading-none">Materials</h3>
              <p className="text-[10px] font-bold tracking-widest mt-1 uppercase" style={{ color: '#bd9dff' }}>Material &amp; SAM</p>
              <div className="flex gap-2 mt-3">
                {onAddToLayout && (
                  <button onClick={onAddToLayout}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-full border text-[10px] font-bold transition-all hover:bg-[#2c2c2d]"
                    style={{ borderColor: 'rgba(189,157,255,0.4)', color: '#bd9dff' }}>
                    <span className="material-symbols-outlined text-sm">add_photo_alternate</span>레이아웃 추가
                  </button>
                )}
                <button onClick={handleApply} disabled={applyLoading}
                  className="flex-1 px-3 py-1.5 rounded-full text-[10px] font-bold active:scale-95 transition-all shadow-lg disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #bd9dff, #8a4cfc)', color: '#3c0089' }}>
                  {applyLoading ? 'Applying…' : 'Render'}
                </button>
              </div>
            </header>

            <div className="px-4 py-3 flex gap-3 overflow-x-auto"
              style={{ borderBottom: '1px solid rgba(72,72,73,0.1)' }}>
              {CATEGORIES.map(cat => (
                <button key={cat.id}
                  className="text-xs font-bold pb-1.5 flex-shrink-0 transition-colors"
                  style={matCategory === cat.id
                    ? { color: '#ffffff', borderBottom: '2px solid #bd9dff' }
                    : { color: '#adaaab', borderBottom: '2px solid transparent' }}
                  onClick={() => setMatCategory(cat.id)}>
                  {cat.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col flex-1 overflow-y-auto p-4">
              {/* Style filters */}
              {matCategory !== 'upload' && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {STYLE_FILTERS.map(f => (
                    <button key={f.id}
                      className="px-2 py-0.5 rounded-full text-[10px] font-bold transition-all"
                      style={matFilter === f.id
                        ? { background: '#bd9dff', color: '#000' }
                        : { background: '#201f21', color: '#adaaab', border: '1px solid rgba(72,72,73,0.2)' }}
                      onClick={() => setMatFilter(f.id)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Search */}
              {matCategory !== 'upload' && (
                <div className="flex gap-2 mb-3">
                  <input
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs"
                    style={{ background: '#201f21', border: '1px solid rgba(72,72,73,0.3)', color: '#ffffff' }}
                    placeholder="Search material name..."
                    value={matSearchInput}
                    onChange={e => setMatSearchInput(e.target.value)}
                  />
                  <button className="px-3 py-1.5 rounded-lg text-xs font-bold"
                    style={{ background: 'linear-gradient(135deg, #bd9dff, #8a4cfc)', color: '#3c0089' }}
                    onClick={() => setMatSearch(matSearchInput)}>Search</button>
                </div>
              )}

              {/* Upload tab */}
              {matCategory === 'upload' ? (
                <div className="flex flex-col gap-3">
                  <input ref={uploadRef} type="file" accept="image/*" className="hidden"
                    onChange={e => handleUploadFile(e.target.files[0])} />
                  <div className="border-2 border-dashed rounded-xl p-4 flex flex-col items-center gap-2 cursor-pointer transition-all"
                    style={{ borderColor: 'rgba(189,157,255,0.3)' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = '#bd9dff'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(189,157,255,0.3)'}
                    onClick={() => uploadRef.current?.click()}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); handleUploadFile(e.dataTransfer.files[0]); }}>
                    <span className="material-symbols-outlined text-3xl" style={{ color: '#bd9dff' }}>upload_file</span>
                    <span className="text-xs font-semibold" style={{ color: '#adaaab' }}>자재 이미지 업로드</span>
                    <span className="text-[10px] text-center" style={{ color: '#767576' }}>PNG, JPG — 최대 10MB</span>
                  </div>
                  {uploadedMats.length > 0 && (
                    <div className="grid grid-cols-2 gap-2">
                      {uploadedMats.map((mat, i) => (
                        <button key={i}
                          className="p-2 rounded-xl transition-all text-left"
                          style={selectedMat?.id === mat.id
                            ? { background: 'rgba(189,157,255,0.15)', border: '1px solid #bd9dff' }
                            : { background: '#201f21', border: '1px solid rgba(72,72,73,0.2)' }}
                          onClick={() => setSelectedMat(mat)}>
                          <img src={mat.thumbnail_url || mat.tile_image_url} alt={mat.name}
                            className="w-full aspect-square object-cover rounded-lg mb-1" />
                          <p className="text-[10px] font-semibold text-white truncate">{mat.name}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : loadingMats ? (
                <div className="flex justify-center py-8">
                  <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#bd9dff', borderTopColor: 'transparent' }} />
                </div>
              ) : displayMats.length === 0 ? (
                <div className="flex flex-col items-center py-8 gap-2">
                  <span className="material-symbols-outlined text-3xl" style={{ color: '#767576' }}>texture</span>
                  <p className="text-sm font-semibold" style={{ color: '#adaaab' }}>No materials found.</p>
                  <p className="text-[10px] text-center" style={{ color: '#767576' }}>Try adjusting filters or upload a custom material.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {displayMats.map(mat => (
                    <button key={mat.id}
                      className="p-2 rounded-xl transition-all text-left"
                      style={selectedMat?.id === mat.id
                        ? { background: 'rgba(189,157,255,0.15)', border: '1px solid #bd9dff' }
                        : { background: '#201f21', border: '1px solid rgba(72,72,73,0.2)' }}
                      onClick={() => setSelectedMat(mat)}>
                      <img src={mat.thumbnail_url || mat.tile_image_url} alt={mat.name}
                        className="w-full aspect-square object-cover rounded-lg mb-1" />
                      <p className="text-[10px] font-semibold text-white truncate">{mat.name}</p>
                      {mat.brand && <p className="text-[9px]" style={{ color: '#adaaab' }}>{mat.brand}</p>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Preview section */}
            <div className="p-4" style={{ borderTop: '1px solid rgba(72,72,73,0.1)' }}>
              <div className="rounded-xl overflow-hidden aspect-square mb-2"
                style={{ background: '#0a0a0b', border: '1px solid rgba(72,72,73,0.2)' }}>
                {selectedMat?.tile_image_url || selectedMat?.thumbnail_url ? (
                  <img src={selectedMat.tile_image_url || selectedMat.thumbnail_url} alt="미리보기" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-1">
                    <span className="material-symbols-outlined text-2xl" style={{ color: '#767576' }}>preview</span>
                    <p className="text-[10px]" style={{ color: '#767576' }}>영역을 선택하면 미리보기가 표시됩니다</p>
                  </div>
                )}
              </div>
              <p className="text-[9px] text-center" style={{ color: '#767576' }}>
                {canvasSegments.length > 0 ? `${canvasSegments.length}개 영역 선택됨` : 'SAM READY'}
              </p>
            </div>
          </aside>

        </div>
      </div>
    );
  }

  /* ── Render ── */
  return (
    <div
      className="h-screen flex flex-col overflow-hidden text-white font-body"
      style={{ background: '#0a0a0b' }}
    >

      {/* ══ TOP NAV ══════════════════════════════════════════════ */}
      <nav className="fixed top-0 w-full z-50 h-16 flex justify-between items-center px-6"
        style={{ background: '#0e0e0f', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>

        {/* Left: back + title */}
        <div className="flex items-center gap-4">
          <button
            onClick={onNavigateBack}
            className="hover:bg-[#2c2c2d] p-2 rounded-full transition-all active:scale-95"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-white font-headline leading-tight">
              {projectTitle || 'Project'}
            </span>
            <span className="text-[10px] font-bold tracking-widest uppercase"
              style={{ color: '#7c3aed' }}>
              CIRCLE.AI — MATERIALS
            </span>
          </div>
        </div>

        {/* Right: credits + actions */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border"
            style={{ background: '#201f21', borderColor: 'rgba(72,72,73,0.3)' }}>
            <span className="material-symbols-outlined text-sm"
              style={{ color: '#bd9dff', fontVariationSettings: "'FILL' 1" }}>diamond</span>
            <span className="text-sm font-bold tracking-tight">{creditBalance ?? '—'}</span>
          </div>
          <div className="flex gap-2 items-center">
            {onAddToLayout && (
              <button
                onClick={onAddToLayout}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold transition-all hover:bg-[#2c2c2d]"
                style={{ borderColor: 'rgba(189,157,255,0.4)', color: '#bd9dff' }}
              >
                <span className="material-symbols-outlined text-sm">add_photo_alternate</span>
                레이아웃 추가
              </button>
            )}
            <button className="px-4 py-1.5 rounded-full text-xs font-bold border transition-all hover:bg-[#2c2c2d]"
              style={{ borderColor: '#767576' }}>
              Save
            </button>
            <button
              onClick={handleApply}
              disabled={applyLoading}
              className="px-4 py-1.5 rounded-full text-xs font-bold active:scale-95 transition-all shadow-lg disabled:opacity-50"
              style={{
                background: 'linear-gradient(135deg, #bd9dff, #8a4cfc)',
                color: '#3c0089',
                boxShadow: '0 4px 20px rgba(189,157,255,0.2)',
              }}
            >
              {applyLoading ? 'Applying…' : 'Render'}
            </button>
          </div>
          <div className="flex items-center ml-2 pl-4 gap-3"
            style={{ borderLeft: '1px solid rgba(72,72,73,0.3)' }}>
            <span className="material-symbols-outlined cursor-pointer hover:text-white transition-colors"
              style={{ color: '#adaaab' }}>account_balance_wallet</span>
            <span className="material-symbols-outlined cursor-pointer hover:text-white transition-colors"
              style={{ color: '#adaaab' }}>settings</span>
          </div>
        </div>
      </nav>

      {/* ══ AREA SUB-BAR ════════════════════════════════════════ */}
      <div className="fixed top-16 w-full h-12 flex items-center justify-between px-6 z-40"
        style={{ background: 'rgba(19,19,20,0.5)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider"
            style={{ color: '#adaaab' }}>Area:</span>
          <div className="flex gap-2">
            {AREAS.map(area => (
              <button
                key={area.id}
                className="px-4 py-1 rounded-full text-xs font-bold transition-all"
                style={
                  selectedArea === area.id
                    ? { background: '#ffffff', color: '#000000' }
                    : { color: '#adaaab' }
                }
                onMouseEnter={e => { if (selectedArea !== area.id) e.currentTarget.style.background = '#201f21'; }}
                onMouseLeave={e => { if (selectedArea !== area.id) e.currentTarget.style.background = ''; }}
                onClick={() => handleAreaPreset(area.id)}
              >
                {area.label}
              </button>
            ))}
          </div>
        </div>
        <button className="text-[10px] underline hover:text-primary transition-colors"
          style={{ color: '#adaaab' }}
          onClick={() => setCanvasMode('lasso')}>
          Or select directly on canvas below
        </button>
      </div>

      {/* ══ MAIN 4-COLUMN LAYOUT ════════════════════════════════ */}
      <main className="flex overflow-hidden" style={{ paddingTop: '112px', height: '100vh' }}>

        {/* ── LEFT SIDEBAR: Navigation (w-52) ──────────────────── */}
        <aside className="flex-shrink-0 flex flex-col py-6 px-4"
          style={{ width: '208px', background: '#0e0e0f', borderRight: '1px solid rgba(255,255,255,0.05)' }}>

          {/* Title */}
          <div className="mb-8">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] mb-1"
              style={{ color: '#adaaab' }}>Design Tools</h3>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: '#10b981' }} />
              <span className="text-[9px] font-bold tracking-widest uppercase"
                style={{ color: '#10b981' }}>AI Assistant Active</span>
            </div>
          </div>

          {/* Tool nav */}
          <nav className="flex flex-col gap-3 flex-1">
            {NAV_TOOLS.map(tool => {
              const isActive = activeTool === tool.id;
              return (
                <button key={tool.id}
                  className="flex items-center gap-3 p-3 rounded-xl transition-all text-left"
                  style={isActive
                    ? { background: 'rgba(124,58,237,0.1)', borderLeft: '2px solid #7c3aed', color: '#bd9dff', boxShadow: '0 0 15px rgba(189,157,255,0.3)' }
                    : { color: '#adaaab', border: '2px solid transparent' }
                  }
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(44,44,45,0.5)'; }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = ''; }}
                  onClick={() => setActiveTool(tool.id)}
                >
                  <span className="material-symbols-outlined"
                    style={isActive ? { fontVariationSettings: "'FILL' 1" } : {}}>
                    {tool.icon}
                  </span>
                  <div className="flex flex-col">
                    <span className="text-xs font-bold tracking-tight">{tool.label}</span>
                    <span className="text-[9px] opacity-60">{tool.sub}</span>
                  </div>
                </button>
              );
            })}
          </nav>

          {/* Bottom: Layout + Circle.ai 메이커 */}
          <div className="space-y-3 pt-4" style={{ borderTop: '1px solid rgba(72,72,73,0.2)' }}>
            <button
              className="flex items-center gap-3 p-3 rounded-xl transition-all text-left w-full"
              style={{ color: activeTool === 'layout' ? '#bd9dff' : '#adaaab', border: '2px solid transparent' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(44,44,45,0.5)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
              onClick={() => setActiveTool('layout')}
            >
              <span className="material-symbols-outlined">layers</span>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold tracking-tight">LAYOUT</span>
                <span className="text-[9px] opacity-60">Edit Layer List</span>
              </div>
            </button>

            {/* Circle.ai label */}
            <div
              className="w-full py-3 rounded-full text-xs font-extrabold text-center"
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
        </aside>

        {/* ── LEFT PANEL: Inspector (w-[280px]) ────────────────── */}
        <aside className="flex-shrink-0 p-6 overflow-y-auto"
          style={{
            width: '280px',
            background: 'rgba(24,24,27,0.6)',
            backdropFilter: 'blur(20px)',
            borderRight: '1px solid rgba(255,255,255,0.05)',
          }}>
          <div className="space-y-8">

            {/* Input Mode */}
            <section>
              <h4 className="text-[10px] font-bold uppercase tracking-widest mb-4"
                style={{ color: '#adaaab' }}>Input Mode</h4>
              <div className="grid grid-cols-2 gap-2">
                {INPUT_MODES.map(mode => {
                  const isActive = canvasMode === mode.id;
                  return (
                    <button key={mode.id}
                      disabled={!mode.enabled}
                      className="flex flex-col items-center justify-center p-3 rounded-xl transition-all"
                      style={{
                        background: mode.enabled ? '#201f21' : '#131314',
                        border: isActive ? '1px solid #bd9dff' : '1px solid rgba(72,72,73,0.2)',
                        opacity: mode.enabled ? 1 : 0.4,
                        cursor: mode.enabled ? 'pointer' : 'not-allowed',
                        boxShadow: isActive ? '0 0 15px rgba(189,157,255,0.3)' : 'none',
                      }}
                      onClick={() => mode.enabled && setCanvasMode(mode.id)}
                    >
                      <span className="material-symbols-outlined mb-1"
                        style={{ color: isActive ? '#bd9dff' : '#adaaab' }}>
                        {mode.icon}
                      </span>
                      <span className="text-[10px] font-bold"
                        style={{ color: isActive ? '#ffffff' : '#adaaab' }}>
                        {mode.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Selection summary */}
            {canvasSegments.length > 0 && (
              <section className="p-4 rounded-xl" style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(189,157,255,0.2)' }}>
                <h4 className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: '#bd9dff' }}>선택 현황</h4>
                <div className="flex flex-col gap-1.5">
                  {Object.entries(
                    canvasSegments.reduce((acc, seg) => {
                      const lbl = seg.label || selectedArea;
                      acc[lbl] = (acc[lbl] || 0) + 1;
                      return acc;
                    }, {})
                  ).map(([label, count]) => (
                    <div key={label} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ background: '#10b981' }} />
                        <span style={{ color: '#ffffff' }}>{label} 선택됨</span>
                      </span>
                      <span className="font-bold" style={{ color: '#bd9dff' }}>{count}개 선택</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Usage Guide */}
            <section className="p-4 rounded-xl"
              style={{ background: '#000000', border: '1px solid rgba(72,72,73,0.1)' }}>
              <h4 className="text-[10px] font-bold uppercase tracking-widest mb-2 flex items-center gap-2"
                style={{ color: '#bd9dff' }}>
                <span className="material-symbols-outlined text-sm">info</span>
                Usage Guide
              </h4>
              <ul className="space-y-2">
                <li className="text-[11px] leading-relaxed" style={{ color: '#10b981' }}>
                  🖱 <strong>왼쪽 클릭</strong>: 선택할 영역 추가
                </li>
                <li className="text-[11px] leading-relaxed" style={{ color: '#ef4444' }}>
                  🖱 <strong>오른쪽 클릭</strong>: 선택 제외
                </li>
                <li className="text-[11px] leading-relaxed" style={{ color: '#adaaab' }}>
                  • 여러 번 클릭해 영역을 정밀하게 조절하세요.
                </li>
                <li className="text-[11px] leading-relaxed" style={{ color: '#adaaab' }}>
                  • 오른쪽 패널에서 자재 선택 후 Render 클릭.
                </li>
                {(freeRetries ?? 0) > 0 && (
                  <li className="text-[11px] leading-relaxed" style={{ color: '#10b981' }}>
                    🎁 무료 변경 {freeRetries}회 남음
                  </li>
                )}
              </ul>
            </section>
          </div>
        </aside>

        {/* ── CENTER: Canvas ────────────────────────────────────── */}
        <section className="flex-1 relative overflow-hidden flex items-center justify-center p-6"
          style={{ background: '#000000' }}>

          {/* Preview badge */}
          <div className="absolute top-6 right-6 z-10 px-3 py-1 rounded-full"
            style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <span className="text-[10px] font-bold tracking-widest uppercase">Preview Mode</span>
          </div>

          {/* Canvas container */}
          <div className="relative w-full h-full rounded-2xl overflow-hidden shadow-2xl"
            style={{ border: '1px solid rgba(72,72,73,0.1)' }}>
            {imageUrl ? (
              <RoomCanvas
                imageSrc={imageUrl}
                projectId={projectId}
                onMasksChange={setCanvasSegments}
                onEncodingChange={handleEncodingChange}
                externalMode={canvasMode}
                hideSidebar={true}
                lazy={true}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center"
                style={{ color: '#adaaab' }}>
                이미지를 불러오는 중...
              </div>
            )}
            {(isProcessing || isAnalyzing) && (
              <ProcessingOverlay
                message={processingMessage || (isAnalyzing ? '이미지 분석 중...' : '')}
                isColdStart={isColdStart}
              />
            )}
          </div>
        </section>

        {/* ── RIGHT SIDEBAR: Material Library (w-[320px]) ──────── */}
        <aside className="flex-shrink-0 flex flex-col"
          style={{ width: '320px', background: '#111111', borderLeft: '1px solid rgba(255,255,255,0.05)' }}>

          {/* Header */}
          <header className="p-6" style={{ borderBottom: '1px solid rgba(72,72,73,0.1)' }}>
            <h3 className="text-lg font-bold font-headline leading-none">Materials</h3>
            <p className="text-[10px] font-bold tracking-widest mt-1 uppercase"
              style={{ color: '#bd9dff' }}>Material &amp; SAM</p>
            {canvasSegments.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ background: '#10b981' }} />
                <span className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: '#10b981' }}>
                  {canvasSegments[0]?.label || selectedArea} 선택됨
                </span>
              </div>
            )}
          </header>

          {/* Category tabs */}
          <div className="px-6 py-4 flex gap-4 overflow-x-auto"
            style={{ borderBottom: '1px solid rgba(72,72,73,0.1)' }}>
            {CATEGORIES.map(cat => (
              <button key={cat.id}
                className="text-xs font-bold pb-2 flex-shrink-0 transition-colors"
                style={matCategory === cat.id
                  ? { color: '#ffffff', borderBottom: '2px solid #bd9dff' }
                  : { color: '#adaaab', borderBottom: '2px solid transparent' }
                }
                onClick={() => setMatCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Upload Tab content */}
          {matCategory === 'upload' ? (
            <div className="flex flex-col flex-1 p-4 gap-4 overflow-y-auto">
              {/* Upload zone */}
              <input ref={uploadRef} type="file" accept="image/*" className="hidden"
                onChange={e => handleUploadFile(e.target.files[0])} />
              <div
                className="border-2 border-dashed rounded-xl p-6 flex flex-col items-center gap-3 cursor-pointer transition-all"
                style={{ borderColor: 'rgba(189,157,255,0.3)' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#bd9dff'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(189,157,255,0.3)'}
                onClick={() => uploadRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleUploadFile(e.dataTransfer.files[0]); }}
              >
                <span className="material-symbols-outlined text-4xl" style={{ color: '#bd9dff' }}>
                  upload_file
                </span>
                <div className="text-center">
                  <p className="text-sm font-bold text-white">자재 이미지 업로드</p>
                  <p className="text-[11px] mt-1" style={{ color: '#adaaab' }}>
                    PNG, JPG 파일 — 텍스처 이미지를 업로드하면 선택 영역에 적용합니다
                  </p>
                </div>
              </div>

              {/* Uploaded materials grid */}
              {uploadedMats.length > 0 ? (
                <div className="grid grid-cols-3 gap-2">
                  {uploadedMats.map(mat => (
                    <button key={mat.id}
                      className="relative rounded-lg overflow-hidden aspect-square border-2 transition-all"
                      style={{ borderColor: selectedMat?.id === mat.id ? '#bd9dff' : 'transparent' }}
                      onClick={() => setSelectedMat(mat)}
                    >
                      <img src={mat.thumbnail_url} alt={mat.name}
                        className="w-full h-full object-cover" />
                      {selectedMat?.id === mat.id && (
                        <div className="absolute inset-0 flex items-center justify-center"
                          style={{ background: 'rgba(189,157,255,0.3)' }}>
                          <span className="material-symbols-outlined text-white"
                            style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-center" style={{ color: '#adaaab' }}>
                  업로드한 자재가 없습니다
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Filters */}
              <div className="p-4 flex flex-wrap gap-2">
                {STYLE_FILTERS.map(f => (
                  <button key={f.id}
                    className="px-3 py-1 rounded-full text-[10px] font-bold transition-all"
                    style={matFilter === f.id
                      ? { background: '#201f21', border: '1px solid rgba(72,72,73,0.5)', color: '#ffffff' }
                      : { border: '1px solid rgba(72,72,73,0.2)', color: '#adaaab' }
                    }
                    onMouseEnter={e => { if (matFilter !== f.id) e.currentTarget.style.background = '#201f21'; }}
                    onMouseLeave={e => { if (matFilter !== f.id) e.currentTarget.style.background = ''; }}
                    onClick={() => setMatFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {/* Search */}
              <div className="px-4 mb-2">
                <div className="relative flex items-center">
                  <input
                    className="w-full h-10 rounded-lg text-xs pr-16 pl-4 outline-none focus:ring-1"
                    style={{
                      background: '#000000',
                      border: 'none',
                      color: '#ffffff',
                      '--tw-ring-color': '#bd9dff',
                    }}
                    placeholder="Search material name..."
                    value={matSearchInput}
                    onChange={e => setMatSearchInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') setMatSearch(matSearchInput); }}
                  />
                  <button
                    className="absolute right-1 top-1 bottom-1 px-3 rounded-md text-[10px] font-bold"
                    style={{ background: '#bd9dff', color: '#3c0089' }}
                    onClick={() => setMatSearch(matSearchInput)}
                  >
                    Search
                  </button>
                </div>
              </div>

              {/* Material grid */}
              <div className="flex-1 overflow-y-auto px-4 pb-4">
                {loadingMats ? (
                  <div className="flex items-center justify-center h-32">
                    <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
                      style={{ borderColor: '#bd9dff', borderTopColor: 'transparent' }} />
                  </div>
                ) : displayMats.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {displayMats.map(mat => (
                      <button key={mat.id}
                        className="relative rounded-lg overflow-hidden border-2 transition-all"
                        style={{
                          aspectRatio: '1',
                          borderColor: selectedMat?.id === mat.id ? '#bd9dff' : 'transparent',
                        }}
                        onClick={() => setSelectedMat(mat)}
                      >
                        {mat.thumbnail_url || mat.tile_image_url ? (
                          <img src={mat.thumbnail_url || mat.tile_image_url} alt={mat.name}
                            className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"
                            style={{ background: '#201f21' }}>
                            <span className="material-symbols-outlined" style={{ color: '#adaaab' }}>texture</span>
                          </div>
                        )}
                        {selectedMat?.id === mat.id && (
                          <div className="absolute inset-0 flex items-center justify-center"
                            style={{ background: 'rgba(189,157,255,0.3)' }}>
                            <span className="material-symbols-outlined text-white"
                              style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 p-1"
                          style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.8))' }}>
                          <p className="text-[9px] font-medium truncate text-white">{mat.name}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  /* Empty state */
                  <div className="flex flex-col items-center justify-center h-40 text-center">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
                      style={{ background: '#201f21' }}>
                      <span className="material-symbols-outlined text-3xl" style={{ color: '#767576' }}>texture</span>
                    </div>
                    <h5 className="text-sm font-bold text-white mb-2">No materials found.</h5>
                    <p className="text-[11px] max-w-[180px]" style={{ color: '#adaaab' }}>
                      Try adjusting filters or upload a custom material.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Footer */}
          <div className="p-4 flex justify-between items-center text-[10px] font-bold uppercase tracking-widest"
            style={{ borderTop: '1px solid rgba(72,72,73,0.1)', background: '#000000', color: '#adaaab' }}>
            <span>
              {canvasSegments.length > 0
                ? `Selected: ${canvasSegments[0]?.label || selectedArea}`
                : '영역을 선택하면 미리보기가 표시됩니다'}
            </span>
            <span style={{ color: canvasSegments.length > 0 ? '#bd9dff' : '#767576' }}>
              {canvasSegments.length > 0 ? 'SAM Active' : 'SAM Ready'}
            </span>
          </div>
        </aside>
      </main>
    </div>
  );
}
