/**
 * EditorHub — shown after style onboarding is confirmed.
 *
 * Layout:
 *   ┌─────────────────────────────────────┬──────────────────────┐
 *   │                                     │  💡 사용 가이드       │
 *   │   변환된 / 원본 이미지 (main)        │  ────────────────    │
 *   │                                     │  더 수정하기          │
 *   │  ┌─────────────────────────────┐    │  [Circle.ai]         │
 *   │  │  💬 미니 채팅 팝업          │    │  [자재변경]           │
 *   │  │  [입력...]       [전송]     │    │  [가구변경]           │
 *   │  └─────────────────────────────┘    │  [조명변경]           │
 *   │                                     │  ─────────────────   │
 *   │                                     │  [변경 안할래요!]     │
 *   │                                     │  ─────────────────   │
 *   │                                     │  [✨ 고품질 출력하기] │
 *   └─────────────────────────────────────┴──────────────────────┘
 *
 * Props:
 *   projectId        {number}
 *   imageUrl         {string}   original
 *   resultUrl        {string}   after-transformation (may be null)
 *   creditBalance    {number}
 *   isProcessing     {boolean}
 *   processingMsg    {string}
 *   onSwitchService  {Function} (serviceId) → parent handles tool switch
 *   onFinalRender    {Function} () → parent opens FinalRender
 *   onMiniChatSend   {Function} (text) → chat handler
 *   chatMessages     {Array}    [{role, content}]
 */

import React, { useState, useRef, useEffect } from 'react';
import './EditorHub.css';

const USAGE_TIPS = [
  { icon: '💬', text: '이런 식으로 말해보세요', sub: '"벽 색깔 하얗게 바꿔줘"' },
  { icon: '🖼️', text: '전체 분위기 변경', sub: '"재팬디 스타일로 바꿔줘"' },
  { icon: '🧱', text: '특정 자재 적용', sub: '"바닥 대리석으로 변경해줘"' },
  { icon: '🎯', text: '특정 영역 선택', sub: '고급 에디터 → 브러시로 선택' },
];

const SERVICES = [
  { id: 'circle_ai',    icon: '🎨', label: 'Circle.ai',  sub: '전체 스타일 변환' },
  { id: 'material',     icon: '🧱', label: '자재 변경',   sub: '바닥·벽 텍스처' },
  { id: 'furniture',    icon: '🪑', label: '가구 변경',   sub: 'AI 가구 배치' },
  { id: 'mood_copy',    icon: '💡', label: '조명 변경',   sub: '분위기·조명' },
];

export default function EditorHub({
  projectId,
  imageUrl,
  resultUrl,
  creditBalance,
  isProcessing,
  processingMsg,
  onSwitchService,
  onFinalRender,
  onMiniChatSend,
  chatMessages = [],
}) {
  const [chatInput,     setChatInput]     = useState('');
  const [chatOpen,      setChatOpen]      = useState(true);
  const [imageExpanded, setImageExpanded] = useState(false);
  const chatEndRef  = useRef(null);
  const inputRef    = useRef(null);

  const displayUrl = resultUrl || imageUrl;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleSend = () => {
    const txt = chatInput.trim();
    if (!txt) return;
    onMiniChatSend?.(txt);
    setChatInput('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className="eh-root">
      {/* ── Main image area ────────────────────────────────────────────── */}
      <div className={`eh-main ${imageExpanded ? 'eh-main--expanded' : ''}`}>
        <div className="eh-image-wrap" onClick={() => setImageExpanded((v) => !v)}>
          {displayUrl ? (
            <img className="eh-image" src={displayUrl} alt="인테리어" />
          ) : (
            <div className="eh-image-placeholder">
              <span className="spinner" />
            </div>
          )}
          {isProcessing && (
            <div className="eh-image-overlay">
              <span className="spinner" />
              <span>{processingMsg || '처리 중...'}</span>
            </div>
          )}
          {resultUrl && (
            <div className="eh-image-badge">✨ AI 변환됨</div>
          )}
          <div className="eh-image-expand-hint">
            {imageExpanded ? '⊠ 축소' : '⊞ 크게 보기'}
          </div>
        </div>

        {/* ── Mini chat popup ────────────────────────────────────────── */}
        <div className={`eh-chat-popup ${chatOpen ? 'open' : ''}`}>
          <button
            className="eh-chat-toggle"
            onClick={() => setChatOpen((v) => !v)}
          >
            {chatOpen ? '💬 채팅 닫기 ▾' : '💬 채팅으로 수정하기 ▴'}
          </button>

          {chatOpen && (
            <div className="eh-chat-body">
              {chatMessages.length === 0 ? (
                <div className="eh-chat-empty">
                  <p>채팅으로 인테리어를 수정해보세요!</p>
                  <p className="eh-chat-example">"왼쪽 벽 검은색으로 바꿔줘"</p>
                </div>
              ) : (
                <div className="eh-chat-messages">
                  {chatMessages.map((m, i) => (
                    <div key={i} className={`eh-msg eh-msg--${m.role}`}>
                      <span className="eh-msg-text">{m.content}</span>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              )}
              <div className="eh-chat-input-row">
                <input
                  ref={inputRef}
                  className="eh-chat-input"
                  placeholder="수정하고 싶은 부분을 말해보세요..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKey}
                />
                <button
                  className="eh-chat-send"
                  onClick={handleSend}
                  disabled={!chatInput.trim()}
                >→</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Right nav panel ───────────────────────────────────────────────── */}
      <aside className="eh-nav">
        {/* Usage guide */}
        <section className="eh-nav-section">
          <h3 className="eh-nav-title">💡 사용 가이드</h3>
          <div className="eh-tips">
            {USAGE_TIPS.map((t, i) => (
              <div key={i} className="eh-tip">
                <span className="eh-tip-icon">{t.icon}</span>
                <div>
                  <p className="eh-tip-text">{t.text}</p>
                  <p className="eh-tip-sub">{t.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="eh-nav-divider" />

        {/* Service buttons */}
        <section className="eh-nav-section">
          <h3 className="eh-nav-title">더 수정하기</h3>
          <div className="eh-services">
            {SERVICES.map((s) => (
              <button
                key={s.id}
                className="eh-service-btn"
                onClick={() => onSwitchService?.(s.id)}
              >
                <span className="eh-service-icon">{s.icon}</span>
                <div className="eh-service-info">
                  <span className="eh-service-label">{s.label}</span>
                  <span className="eh-service-sub">{s.sub}</span>
                </div>
                <span className="eh-service-arrow">›</span>
              </button>
            ))}
          </div>
        </section>

        <div className="eh-nav-divider" />

        {/* No change option */}
        <button
          className="eh-no-change-btn"
          onClick={() => onSwitchService?.('skip')}
        >
          🙅 변경 안할래요!
        </button>

        <div className="eh-nav-divider" />

        {/* Final render */}
        <section className="eh-nav-section">
          <button className="eh-final-btn" onClick={onFinalRender}>
            <span className="eh-final-icon">✨</span>
            <div>
              <p className="eh-final-label">고품질 이미지로 출력하기</p>
              <p className="eh-final-sub">SDXL Refiner + Upscale</p>
            </div>
          </button>
        </section>

        {/* Credit display */}
        <div className="eh-credit-row">
          <span>💎</span>
          <span>잔여 크레딧</span>
          <strong>{creditBalance ?? '—'}</strong>
        </div>
      </aside>
    </div>
  );
}
