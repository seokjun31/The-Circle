/**
 * BeforeAfterSlider — Drag-to-compare before/after images.
 *
 * Props:
 *   beforeSrc  {string}   URL or data-URL of the BEFORE image
 *   afterSrc   {string}   URL or data-URL of the AFTER image
 *   className  {string}
 *   style      {object}
 *
 * Touch + mouse dragging supported.
 * The handle divides the viewport: left = before, right = after.
 */

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import './BeforeAfterSlider.css';

function BeforeAfterSlider({ beforeSrc, afterSrc, className = '', style }) {
  const [position, setPosition] = useState(50); // 0–100 %
  const containerRef = useRef(null);
  const dragging     = useRef(false);

  // ── Pointer → percentage conversion ─────────────────────────────────────
  const posFromEvent = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return 50;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    return Math.min(100, Math.max(0, pct));
  }, []);

  // ── Mouse ────────────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!dragging.current) return;
    setPosition(posFromEvent(e.clientX));
  }, [posFromEvent]);

  const handleMouseUp = useCallback(() => { dragging.current = false; }, []);

  // ── Touch ─────────────────────────────────────────────────────────────────
  const handleTouchStart = useCallback((e) => {
    dragging.current = true;
    setPosition(posFromEvent(e.touches[0].clientX));
  }, [posFromEvent]);

  const handleTouchMove = useCallback((e) => {
    if (!dragging.current) return;
    e.preventDefault();
    setPosition(posFromEvent(e.touches[0].clientX));
  }, [posFromEvent]);

  const handleTouchEnd = useCallback(() => { dragging.current = false; }, []);

  // Attach global move/up listeners so dragging works outside the component
  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      setPosition(posFromEvent(clientX));
    };
    const onUp = () => { dragging.current = false; };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend',  onUp);

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend',  onUp);
    };
  }, [posFromEvent]);

  return (
    <div
      ref={containerRef}
      className={`bas-root ${className}`}
      style={style}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* BEFORE layer (full width, clipped on the right) */}
      <div className="bas-layer bas-before">
        <img src={beforeSrc} alt="변경 전" draggable={false} />
        <span className="bas-label bas-label-before">Before</span>
      </div>

      {/* AFTER layer (clipped on the left to reveal only the right portion) */}
      <div
        className="bas-layer bas-after"
        style={{ clipPath: `inset(0 0 0 ${position}%)` }}
      >
        <img src={afterSrc} alt="변경 후" draggable={false} />
        <span className="bas-label bas-label-after">After</span>
      </div>

      {/* Drag handle */}
      <div
        className="bas-handle"
        style={{ left: `${position}%` }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        role="slider"
        aria-valuenow={Math.round(position)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="변경 전/후 비교 슬라이더"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft')  setPosition(p => Math.max(0,   p - 2));
          if (e.key === 'ArrowRight') setPosition(p => Math.min(100, p + 2));
        }}
      >
        <div className="bas-handle-line" />
        <div className="bas-handle-grip">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M6 10L2 6M6 10L2 14M14 10L18 6M14 10L18 14" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>
      </div>
    </div>
  );
}

export default BeforeAfterSlider;
