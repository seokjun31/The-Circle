import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { deleteLayer, updateLayer } from '../../utils/api';
import './LayerPanel.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_META = {
  wall:      { label: '벽',     icon: '🧱', badge: 'badge-wall' },
  floor:     { label: '바닥',   icon: '🪵', badge: 'badge-floor' },
  ceiling:   { label: '천장',   icon: '⬜', badge: 'badge-ceiling' },
  furniture: { label: '가구',   icon: '🛋️', badge: 'badge-furniture' },
  style:     { label: '스타일', icon: '✨', badge: 'badge-style' },
};

function layerDisplayName(layer) {
  const params = layer.parameters || {};
  if (params.name) return params.name;
  if (params.source === 'final_render') return `최종 렌더링 (${params.lighting ?? ''})`;
  if (params.material_name) return params.material_name;
  if (params.style_preset) return `스타일: ${params.style_preset}`;
  const meta = TYPE_META[layer.layer_type];
  return meta?.label ?? layer.layer_type;
}

function layerSubText(layer) {
  const params = layer.parameters || {};
  if (params.label) return params.label;
  if (params.source) return params.source.replace(/_/g, ' ');
  return '';
}

// ── LayerPanel ────────────────────────────────────────────────────────────────

/**
 * LayerPanel — Photoshop-style layer list.
 *
 * Props:
 *   projectId   {number}
 *   layers      {EditLayerResponse[]}
 *   selected    {number|null}  layer id
 *   onSelect    {function(id)}
 *   onLayersChange {function()}  called after any mutation
 */
export default function LayerPanel({
  projectId,
  layers = [],
  selected,
  onSelect,
  onLayersChange,
}) {
  const [dragOver, setDragOver] = useState(null);  // layer id being dragged over
  const dragSrcId = React.useRef(null);

  // ── Visibility toggle ──────────────────────────────────────────────────────
  async function handleToggleVisibility(layer, e) {
    e.stopPropagation();
    try {
      await updateLayer(projectId, layer.id, { is_visible: !layer.is_visible });
      onLayersChange?.();
    } catch (err) {
      toast.error('가시성 변경 실패: ' + err.message);
    }
  }

  // ── Delete layer ───────────────────────────────────────────────────────────
  async function handleDelete(layer, e) {
    e.stopPropagation();
    if (!window.confirm(`"${layerDisplayName(layer)}" 레이어를 삭제할까요?`)) return;
    try {
      await deleteLayer(projectId, layer.id);
      onLayersChange?.();
      toast.success('레이어 삭제됨');
    } catch (err) {
      toast.error('레이어 삭제 실패: ' + err.message);
    }
  }

  // ── Drag-and-drop reorder ──────────────────────────────────────────────────
  function handleDragStart(e, layer) {
    dragSrcId.current = layer.id;
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragEnd() {
    dragSrcId.current = null;
    setDragOver(null);
  }

  function handleDragOver(e, layer) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(layer.id);
  }

  function handleDragLeave() {
    setDragOver(null);
  }

  async function handleDrop(e, targetLayer) {
    e.preventDefault();
    setDragOver(null);
    if (dragSrcId.current === targetLayer.id) return;

    const srcIdx    = layers.findIndex(l => l.id === dragSrcId.current);
    const targetIdx = layers.findIndex(l => l.id === targetLayer.id);
    if (srcIdx === -1 || targetIdx === -1) return;

    // Build new order values: swap the two layers' orders
    const srcLayer    = layers[srcIdx];
    const newSrcOrder = targetLayer.order;
    const newTgtOrder = srcLayer.order;

    try {
      await Promise.all([
        updateLayer(projectId, srcLayer.id,    { order: newSrcOrder }),
        updateLayer(projectId, targetLayer.id, { order: newTgtOrder }),
      ]);
      onLayersChange?.();
    } catch (err) {
      toast.error('순서 변경 실패: ' + err.message);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="layer-panel">
      <div className="layer-panel-header">
        <h4>레이어</h4>
        <span className="layer-count">{layers.length}</span>
      </div>

      <div className="layer-list">
        {layers.length === 0 ? (
          <div className="layer-empty">
            아직 레이어가 없습니다.<br />
            자재 적용이나 스타일 변환을 먼저 해보세요.
          </div>
        ) : (
          /* Render in reverse order (top layer first, like Photoshop) */
          [...layers].reverse().map(layer => {
            const meta    = TYPE_META[layer.layer_type] ?? TYPE_META.style;
            const name    = layerDisplayName(layer);
            const subtext = layerSubText(layer);

            return (
              <div
                key={layer.id}
                className={[
                  'layer-item',
                  selected === layer.id ? 'selected' : '',
                  !layer.is_visible ? 'hidden' : '',
                  dragOver === layer.id ? 'drag-over' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onSelect?.(layer.id)}
                draggable
                onDragStart={e => handleDragStart(e, layer)}
                onDragEnd={handleDragEnd}
                onDragOver={e => handleDragOver(e, layer)}
                onDragLeave={handleDragLeave}
                onDrop={e => handleDrop(e, layer)}
              >
                {/* Drag handle */}
                <span className="drag-handle" title="드래그로 순서 변경">⠿</span>

                {/* Thumbnail */}
                <div className="layer-thumb">
                  {layer.result_image_url ? (
                    <img
                      src={layer.result_image_url}
                      alt={name}
                      loading="lazy"
                    />
                  ) : (
                    <span className="layer-thumb-placeholder">{meta.icon}</span>
                  )}
                </div>

                {/* Info */}
                <div className="layer-info">
                  <span className="layer-name">{name}</span>
                  <span className="layer-sub">
                    <span className={`layer-type-badge ${meta.badge}`}>
                      {meta.label}
                    </span>
                    {subtext && <span style={{ marginLeft: 4 }}>{subtext}</span>}
                  </span>
                </div>

                {/* Controls */}
                <div className="layer-controls">
                  <button
                    className="layer-eye-btn"
                    title={layer.is_visible ? '레이어 숨기기' : '레이어 보이기'}
                    onClick={e => handleToggleVisibility(layer, e)}
                  >
                    {layer.is_visible ? '👁️' : '🙈'}
                  </button>
                  <button
                    className="layer-delete-btn"
                    title="레이어 삭제"
                    onClick={e => handleDelete(layer, e)}
                  >
                    🗑
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
