import React from 'react';
import './ProcessingOverlay.css';

/**
 * Fullscreen semi-transparent overlay shown while AI is processing.
 * Shown over the canvas area with a message and optional cold-start warning.
 */
function ProcessingOverlay({ message, isColdStart }) {
  return (
    <div className="proc-overlay">
      <div className="proc-card">
        <div className="proc-spinner" />
        {isColdStart ? (
          <>
            <p className="proc-msg">AI 엔진을 준비하고 있습니다...</p>
            <p className="proc-hint">⏱ 처음 실행 시 최대 1분 소요될 수 있습니다</p>
          </>
        ) : (
          <p className="proc-msg">{message || 'AI가 처리 중입니다...'}</p>
        )}
      </div>
    </div>
  );
}

export default ProcessingOverlay;
