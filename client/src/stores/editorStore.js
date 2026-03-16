import { create } from 'zustand';

/**
 * Editor global state (Zustand)
 * Shared across EditorPage, tool panels, and canvas components.
 */
const useEditorStore = create((set, get) => ({
  // ── Project ──────────────────────────────────────────────────────────────
  project: null,          // { id, title, original_image_url, thumbnail_url, ... }
  layers: [],             // EditLayer[]

  // ── Active tool ──────────────────────────────────────────────────────────
  activeTool: 'circle_ai', // 'circle_ai'|'material'|'mood_copy'|'furniture'|'final_render'|'layers'

  // ── SAM / segmentation ────────────────────────────────────────────────────
  selectedSegments: [],   // confirmed segment masks
  samEmbedding: null,     // Float32Array | null (cached per image)

  // ── Scale reference ───────────────────────────────────────────────────────
  referenceScale: null,   // { pxPerCm: number } | null

  // ── Processing ────────────────────────────────────────────────────────────
  isProcessing: false,
  processingMessage: '',
  isColdStart: false,     // show "AI 엔진 준비 중..." banner

  // ── History (undo/redo) ────────────────────────────────────────────────────
  history: [],            // HistoryEntry[]
  historyIndex: -1,

  // ── Credit balance ────────────────────────────────────────────────────────
  creditBalance: null,

  // ── Last AI result ────────────────────────────────────────────────────────
  lastResult: null,

  // ── Actions ───────────────────────────────────────────────────────────────
  setProject: (project) => set({ project }),

  setLayers: (layers) => set({ layers }),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setSelectedSegments: (segs) => set({ selectedSegments: segs }),

  setSamEmbedding: (emb) => set({ samEmbedding: emb }),

  setReferenceScale: (scale) => set({ referenceScale: scale }),

  setProcessing: (isProcessing, message = '', coldStart = false) =>
    set({ isProcessing, processingMessage: message, isColdStart: coldStart }),

  setCreditBalance: (balance) => set({ creditBalance: balance }),

  setLastResult: (result) => set({ lastResult: result }),

  // Push a snapshot to history (stores current layers)
  pushHistory: () => {
    const { layers, history, historyIndex } = get();
    const entry = { layers: JSON.parse(JSON.stringify(layers)), ts: Date.now() };
    const trimmed = history.slice(0, historyIndex + 1);
    set({ history: [...trimmed, entry], historyIndex: trimmed.length });
  },

  undo: () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const prev = history[historyIndex - 1];
    set({ layers: prev.layers, historyIndex: historyIndex - 1 });
  },

  redo: () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const next = history[historyIndex + 1];
    set({ layers: next.layers, historyIndex: historyIndex + 1 });
  },

  canUndo: () => get().historyIndex > 0,
  canRedo: () => get().historyIndex < get().history.length - 1,

  reset: () => set({
    project: null, layers: [], activeTool: 'circle_ai',
    selectedSegments: [], samEmbedding: null, referenceScale: null,
    isProcessing: false, processingMessage: '', isColdStart: false,
    history: [], historyIndex: -1, creditBalance: null, lastResult: null,
  }),
}));

export default useEditorStore;
