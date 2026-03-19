/**
 * ChatPanel — Chat-based interior editing interface.
 *
 * Flow:
 *   1. User types Korean request → POST /api/v1/chat/analyze → intent
 *   2. If intent has a target, frontend loads cached mask from roomSegmenter
 *      and passes it up via onShowMask() for overlay on canvas
 *   3. "맞아요" → execute action (saveMask + applyMaterial / route to panel)
 *   4. "다시 선택" → onOpenCorrection(intent) → CorrectionMode
 *
 * Props:
 *   projectId         {number}
 *   creditBalance     {number}
 *   onShowMask        {Function}  (maskData | null) → show/clear canvas overlay
 *   onOpenCorrection  {Function}  (intent) → enters correction mode
 *   onResult          {Function}  (result) → layer refresh after execution
 */

import React, { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { roomSegmenter } from '../../lib/segmentation/semanticSegmentation';
import { binaryToPng } from '../../lib/sam/samUtils';
import { analyzeChatMessage, saveMask, applyMaterial } from '../../utils/api';
import './ChatPanel.css';

const LABEL_KR = {
  wall: '벽', floor: '바닥', ceiling: '천장',
  door: '문', window: '창문', molding: '몰딩', furniture: '가구',
};

const ACTION_ROUTES = {
  add_furniture:   { panel: 'furniture',    msg: '가구 패널에서 위치를 지정해주세요.' },
  change_lighting: { panel: 'circle_ai',    msg: 'Circle.ai 패널에서 스타일을 조정해주세요.' },
  style_copy:      { panel: 'mood_copy',    msg: '분위기 패널에서 참조 이미지를 업로드해주세요.' },
};

// ─────────────────────────────────────────────────────────────────────────────

const ChatPanel = forwardRef(function ChatPanel(
  { projectId, creditBalance, onShowMask, onOpenCorrection, onResult, onSwitchTool },
  ref,
) {
  const [messages, setMessages]       = useState([
    { id: 0, role: 'ai', text: '어떻게 바꿔드릴까요? 예: "벽 흰색으로 바꿔줘", "바닥 대리석으로 변경해줘"' },
  ]);
  const [input, setInput]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [pendingIntent, setPendingIntent] = useState(null); // intent awaiting confirm
  const listRef = useRef(null);
  const msgId   = useRef(1);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const addMsg = useCallback((role, text, extra = {}) => {
    const id = ++msgId.current;
    setMessages((prev) => [...prev, { id, role, text, ...extra }]);
    return id;
  }, []);

  // ── Send message ────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    addMsg('user', text);
    setLoading(true);

    try {
      const intent = await analyzeChatMessage(text);

      if (intent.action === 'unknown') {
        addMsg('ai', intent.confirmMessage);
        return;
      }

      // Route non-material actions to panels
      if (ACTION_ROUTES[intent.action]) {
        const { msg, panel } = ACTION_ROUTES[intent.action];
        addMsg('ai', msg);
        onSwitchTool?.(panel);
        return;
      }

      // change_material: load cached mask
      const seg = intent.target ? roomSegmenter.getSegment(intent.target) : null;
      const maskData = seg ? { ...seg, label: intent.target } : null;
      onShowMask(maskData);
      setPendingIntent({ ...intent, maskData });
      addMsg('ai', intent.confirmMessage, { awaitConfirm: true, intentId: msgId.current });
    } catch (err) {
      addMsg('ai', `오류가 발생했어요: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [input, loading, addMsg, onShowMask, onSwitchTool]);

  // ── Confirm: execute the pending intent ─────────────────────────────────────
  const handleConfirm = useCallback(async (correctedMask = null) => {
    if (!pendingIntent) return;
    const { maskData, target, prompt, action } = pendingIntent;
    const activeMask = correctedMask || maskData;

    onShowMask(null);
    setPendingIntent(null);

    if (!activeMask) {
      addMsg('ai', '선택된 영역이 없어요. 다시 선택해주세요.');
      return;
    }

    setLoading(true);
    addMsg('ai', '적용 중입니다...');

    try {
      if (action === 'change_material') {
        // 1. Save mask as PNG → get layerId
        const blob = await binaryToPng(activeMask.binary, activeMask.width, activeMask.height);
        const saved = await saveMask(projectId, { maskBlob: blob, label: target || 'custom' });

        // 2. Apply material with custom prompt
        const result = await applyMaterial(projectId, {
          layerId: saved.layer_id,
          customPrompt: prompt,
        });

        addMsg('ai', '완료했어요!');
        onResult?.(result);
      }
    } catch (err) {
      addMsg('ai', `실행 실패: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [pendingIntent, addMsg, onShowMask, onResult, projectId]);

  // ── Cancel / reselect ────────────────────────────────────────────────────────
  const handleReselect = useCallback(() => {
    if (!pendingIntent) return;
    onShowMask(null);
    onOpenCorrection(pendingIntent);
    // Keep pendingIntent so CorrectionMode can call handleConfirm with corrected mask
  }, [pendingIntent, onShowMask, onOpenCorrection]);

  const handleCancel = useCallback(() => {
    onShowMask(null);
    setPendingIntent(null);
    addMsg('ai', '취소했어요.');
  }, [onShowMask, addMsg]);

  // Expose confirmWithMask so EditorPage can call it after CorrectionMode returns
  useImperativeHandle(ref, () => ({
    confirmWithMask: (mask) => handleConfirm(mask),
  }), [handleConfirm]);

  return (
    <div className="chat-panel">
      <div className="chat-messages" ref={listRef}>
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg chat-msg--${m.role}`}>
            <span className="chat-msg-text">{m.text}</span>
            {m.awaitConfirm && pendingIntent && (
              <div className="chat-confirm-row">
                <button className="chat-btn chat-btn--confirm" onClick={() => handleConfirm()}>
                  맞아요 ✓
                </button>
                <button className="chat-btn chat-btn--reselect" onClick={handleReselect}>
                  다시 선택 ✗
                </button>
                <button className="chat-btn chat-btn--cancel" onClick={handleCancel}>
                  취소
                </button>
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="chat-msg chat-msg--ai">
            <span className="chat-thinking">분석 중...</span>
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          placeholder="예: 벽 검은색으로 바꿔줘"
          disabled={loading}
        />
        <button className="chat-send-btn" onClick={handleSend} disabled={loading || !input.trim()}>
          전송
        </button>
      </div>
    </div>
  );
}

});

export default ChatPanel;
