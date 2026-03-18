/**
 * MaskSizeSelector — UI for switching between SAM's three mask candidates.
 *
 * SAM always returns 3 masks per inference call (small / medium / large).
 * This component lets the user instantly switch between them with no extra
 * inference — the tensors are already in memory.
 *
 * Props:
 *   masks        {ort.Tensor[]}  All K candidate mask tensors [1,1,H,W]
 *   scores       {number[]}      IoU confidence score per mask
 *   selectedIdx  {number}        Currently displayed mask index
 *   bestIndex    {number}        Index chosen automatically by IoU score
 *   onSelect     {Function}      (idx: number) => void
 */

import React, { useMemo } from 'react';
import './MaskSizeSelector.css';

/**
 * Count pixels with positive logit in a SAM mask tensor.
 * Used to sort masks as S / M / L for user-friendly labelling.
 */
function countSelectedPixels(tensor) {
  const data = tensor.data;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 0) n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────

const SIZE_LABELS = ['작게', '중간', '크게'];

export default function MaskSizeSelector({ masks, scores, selectedIdx, bestIndex, onSelect }) {
  // Sort masks by pixel count (area) so buttons always go small → large.
  const sortedByArea = useMemo(() => (
    masks
      .map((tensor, idx) => ({
        idx,
        area:   countSelectedPixels(tensor),
        score:  scores[idx],
        isAuto: idx === bestIndex,
      }))
      .sort((a, b) => a.area - b.area)
  ), [masks, scores, bestIndex]);

  return (
    <div className="mss-container">
      <span className="mss-title">마스크 크기</span>
      <div className="mss-buttons">
        {sortedByArea.map(({ idx, score, isAuto }, rank) => (
          <button
            key={idx}
            className={`mss-btn ${selectedIdx === idx ? 'active' : ''} ${isAuto ? 'auto' : ''}`}
            onClick={() => onSelect(idx)}
            title={`IoU 신뢰도: ${(score * 100).toFixed(0)} %${isAuto ? ' · 자동 선택' : ''}`}
          >
            {SIZE_LABELS[rank]}
            {isAuto && <span className="mss-star" aria-hidden>★</span>}
          </button>
        ))}
      </div>
      <span className="mss-hint">★ = 자동 선택</span>
    </div>
  );
}
