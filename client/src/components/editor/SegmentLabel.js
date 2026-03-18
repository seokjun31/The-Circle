/**
 * SegmentLabel — Inline label picker for a SAM-segmented region.
 *
 * Renders colored label chips; selecting '기타' reveals a free-text input.
 * The component is intentionally compact so it fits inside the action bar.
 *
 * Exported constants:
 *   SEGMENT_LABELS   — master list of { id, label, color, category }
 *   LABEL_TO_CATEGORY — map from label id → MaterialPanel category id (or null)
 *   labelColor(id)   — returns hex color for a label id
 *   labelText(id)    — returns display text for a label id (or raw id if custom)
 *
 * Props:
 *   value      string    — current label id (e.g. 'wall') or custom text
 *   onChange   Function  — (labelId: string) => void
 */

import React, { useState, useEffect } from 'react';
import './SegmentLabel.css';

// ── Master label list ─────────────────────────────────────────────────────────

export const SEGMENT_LABELS = [
  { id: 'wall',    label: '벽',        color: '#1e90ff', category: 'wallpaper' },
  { id: 'floor',   label: '바닥',      color: '#22c55e', category: 'flooring'  },
  { id: 'ceiling', label: '천장',      color: '#f59e0b', category: 'ceiling'   },
  { id: 'door',    label: '문',        color: '#8b5cf6', category: null        },
  { id: 'window',  label: '창문',      color: '#06b6d4', category: null        },
  { id: 'molding', label: '몰딩/트림',  color: '#64748b', category: null        },
  { id: 'custom',  label: '기타',      color: '#ec4899', category: null        },
];

/** Map label id → MaterialPanel category id for auto-tab switching. */
export const LABEL_TO_CATEGORY = Object.fromEntries(
  SEGMENT_LABELS.map(({ id, category }) => [id, category])
);

/** Hex color for a given label id (falls back to pink for unknowns). */
export function labelColor(id) {
  return SEGMENT_LABELS.find((l) => l.id === id)?.color ?? '#ec4899';
}

/** Display text: built-in label text, or the id itself for custom strings. */
export function labelText(id) {
  return SEGMENT_LABELS.find((l) => l.id === id)?.label ?? id;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function SegmentLabel({ value, onChange }) {
  // '기타' chip selected → show text input
  const isCustom = value === 'custom' || (
    value && !SEGMENT_LABELS.some((l) => l.id === value)
  );
  const [customText, setCustomText] = useState(
    isCustom && value !== 'custom' ? value : ''
  );

  // When value switches away from custom, reset the text buffer
  useEffect(() => {
    if (!isCustom) setCustomText('');
  }, [isCustom]);

  const handleChipClick = (id) => {
    onChange(id);
  };

  const handleCustomInput = (e) => {
    const text = e.target.value;
    setCustomText(text);
    onChange(text || 'custom');
  };

  return (
    <div className="seg-label-root">
      <div className="seg-label-chips">
        {SEGMENT_LABELS.map(({ id, label, color }) => {
          const active = id === 'custom' ? isCustom : value === id;
          return (
            <button
              key={id}
              className={`seg-label-chip ${active ? 'active' : ''}`}
              style={{ '--chip-color': color }}
              onClick={() => handleChipClick(id)}
              type="button"
              title={label}
            >
              <span className="seg-label-dot" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Custom text input — shown when '기타' is active */}
      {isCustom && (
        <input
          className="seg-label-custom-input"
          type="text"
          placeholder="영역 이름 입력..."
          value={customText}
          onChange={handleCustomInput}
          autoFocus
          maxLength={40}
        />
      )}
    </div>
  );
}
