/**
 * SegmentLabel — Inline label picker for a SAM-segmented region.
 *
 * Renders colored label chips grouped by category.
 * Selecting '직접입력' reveals a free-text input.
 *
 * Exported constants:
 *   SEGMENT_LABELS   — master list of { id, label, color, category, group }
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
  // 구조
  { id: 'wall',       label: '벽',          color: '#1e90ff', category: 'wallpaper', group: '구조' },
  { id: 'floor',      label: '바닥',        color: '#22c55e', category: 'flooring',  group: '구조' },
  { id: 'ceiling',    label: '천장',        color: '#f59e0b', category: 'ceiling',   group: '구조' },
  { id: 'door',       label: '문',          color: '#8b5cf6', category: null,        group: '구조' },
  { id: 'window',     label: '창문',        color: '#06b6d4', category: null,        group: '구조' },
  { id: 'molding',    label: '몰딩/트림',   color: '#64748b', category: null,        group: '구조' },
  { id: 'stairs',     label: '계단',        color: '#d97706', category: null,        group: '구조' },
  { id: 'pillar',     label: '기둥',        color: '#9ca3af', category: null,        group: '구조' },
  // 가구
  { id: 'sofa',       label: '소파',        color: '#f97316', category: null,        group: '가구' },
  { id: 'bed',        label: '침대',        color: '#ec4899', category: null,        group: '가구' },
  { id: 'table',      label: '테이블/책상', color: '#84cc16', category: null,        group: '가구' },
  { id: 'chair',      label: '의자',        color: '#a78bfa', category: null,        group: '가구' },
  { id: 'cabinet',    label: '수납장',      color: '#14b8a6', category: null,        group: '가구' },
  { id: 'shelf',      label: '선반',        color: '#0ea5e9', category: null,        group: '가구' },
  { id: 'vanity',     label: '화장대',      color: '#f472b6', category: null,        group: '가구' },
  { id: 'wardrobe',   label: '옷장',        color: '#818cf8', category: null,        group: '가구' },
  { id: 'tv-stand',   label: 'TV장',        color: '#6366f1', category: null,        group: '가구' },
  // 주방
  { id: 'kitchen',    label: '주방가구',    color: '#fb7185', category: null,        group: '주방' },
  { id: 'fridge',     label: '냉장고',      color: '#34d399', category: null,        group: '주방' },
  { id: 'countertop', label: '조리대',      color: '#fbbf24', category: null,        group: '주방' },
  { id: 'sink-k',     label: '싱크대',      color: '#4ade80', category: null,        group: '주방' },
  // 욕실
  { id: 'bathtub',    label: '욕조',        color: '#38bdf8', category: null,        group: '욕실' },
  { id: 'toilet',     label: '변기',        color: '#94a3b8', category: null,        group: '욕실' },
  { id: 'sink-b',     label: '세면대',      color: '#67e8f9', category: null,        group: '욕실' },
  // 패브릭/기타
  { id: 'curtain',    label: '커튼/블라인드', color: '#c084fc', category: null,      group: '기타' },
  { id: 'carpet',     label: '카펫/러그',   color: '#86efac', category: null,        group: '기타' },
  { id: 'lighting',   label: '조명',        color: '#fde68a', category: null,        group: '기타' },
  { id: 'radiator',   label: '라디에이터',  color: '#fca5a5', category: null,        group: '기타' },
  { id: 'custom',     label: '직접입력',    color: '#ec4899', category: null,        group: '기타' },
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

const GROUPS = [...new Set(SEGMENT_LABELS.map((l) => l.group))];

export default function SegmentLabel({ value, onChange }) {
  // '직접입력' chip selected → show text input
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

  const handleChipClick = (id) => { onChange(id); };

  const handleCustomInput = (e) => {
    const text = e.target.value;
    setCustomText(text);
    onChange(text || 'custom');
  };

  return (
    <div className="seg-label-root">
      {GROUPS.map((group) => (
        <div key={group} className="seg-label-group">
          <span className="seg-label-group-title">{group}</span>
          <div className="seg-label-chips">
            {SEGMENT_LABELS.filter((l) => l.group === group).map(({ id, label, color }) => {
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
        </div>
      ))}

      {/* Custom text input — shown when '직접입력' is active */}
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
