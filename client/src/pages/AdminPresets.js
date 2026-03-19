/**
 * AdminPresets — Style preset management page.
 *
 * Flow:
 *   1. Upload reference image
 *   2. "자동 분석" → Claude API analyzes → fills form
 *   3. Admin confirms/edits → "저장"
 *   4. Shows existing presets in an editable list
 *
 * Access: /admin/presets
 * Auth:   x-admin-key header (set via input on page)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  getStylePresets,
  analyzeStyleImage,
  createStylePreset,
  updateStylePreset,
  deleteStylePreset,
} from '../utils/api';
import { uploadImage } from '../utils/api';
import './AdminPresets.css';

const EMPTY_FORM = {
  name: '', label: '', description: '',
  prompt: '', ip_adapter_weight: 0.65,
  tags: [], display_order: 0,
  reference_image_url: '',
};

export default function AdminPresets() {
  const navigate = useNavigate();
  const [adminKey,   setAdminKey]   = useState(localStorage.getItem('admin_key') || '');
  const [presets,    setPresets]    = useState([]);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [editId,     setEditId]     = useState(null);   // null = new, number = existing
  const [analyzing,  setAnalyzing]  = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const fileInputRef = useRef(null);

  const saveKey = (k) => { setAdminKey(k); localStorage.setItem('admin_key', k); };

  const loadPresets = useCallback(async () => {
    try {
      const data = await getStylePresets();
      // Show all presets including inactive in admin view
      setPresets(data);
    } catch (err) {
      toast.error('프리셋 불러오기 실패: ' + err.message);
    }
  }, []);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  // ── Image upload ────────────────────────────────────────────────────────────
  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    try {
      const data = await uploadImage(file);
      setForm((f) => ({ ...f, reference_image_url: data.image_url }));
      toast.success('이미지 업로드 완료');
    } catch (err) {
      toast.error('업로드 실패: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  // ── Claude analysis ─────────────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!form.reference_image_url) { toast.error('먼저 이미지를 업로드하세요.'); return; }
    if (!adminKey) { toast.error('Admin Key를 입력하세요.'); return; }
    setAnalyzing(true);
    try {
      const result = await analyzeStyleImage(form.reference_image_url, adminKey);
      setForm((f) => ({
        ...f,
        name:               result.name        || f.name,
        label:              result.label        || f.label,
        description:        result.description  || f.description,
        prompt:             result.prompt       || f.prompt,
        ip_adapter_weight:  result.ip_adapter_weight ?? f.ip_adapter_weight,
        tags:               result.tags         || f.tags,
      }));
      toast.success('Claude API 분석 완료!');
    } catch (err) {
      toast.error('분석 실패: ' + err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Save / Update ───────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.name || !form.label) { toast.error('name과 label은 필수입니다.'); return; }
    if (!adminKey) { toast.error('Admin Key를 입력하세요.'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        tags: typeof form.tags === 'string'
          ? form.tags.split(',').map((t) => t.trim()).filter(Boolean)
          : form.tags,
        ip_adapter_weight: parseFloat(form.ip_adapter_weight),
        display_order:     parseInt(form.display_order, 10),
      };
      if (editId) {
        await updateStylePreset(editId, payload, adminKey);
        toast.success('프리셋 수정됨');
      } else {
        await createStylePreset(payload, adminKey);
        toast.success('프리셋 생성됨');
      }
      setForm(EMPTY_FORM);
      setEditId(null);
      await loadPresets();
    } catch (err) {
      toast.error('저장 실패: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (preset) => {
    setEditId(preset.dbId);
    setForm({
      name:               preset.id,             // preset.id is the name string
      label:              preset.label,
      description:        preset.description,
      prompt:             preset.prompt || '',
      ip_adapter_weight:  preset.ipAdapterWeight ?? 0.65,
      tags:               preset.tags || [],
      display_order:      0,
      reference_image_url: preset.referenceImageUrl || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (dbId) => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    try {
      await deleteStylePreset(dbId, adminKey);
      toast.success('삭제됨');
      await loadPresets();
    } catch (err) {
      toast.error('삭제 실패: ' + err.message);
    }
  };

  const tagsDisplay = Array.isArray(form.tags) ? form.tags.join(', ') : form.tags;

  return (
    <div className="ap-root">
      <header className="ap-header">
        <button className="ap-back" onClick={() => navigate('/dashboard')}>← 대시보드</button>
        <h1>🎨 스타일 프리셋 관리</h1>
        <div className="ap-key-row">
          <label>Admin Key</label>
          <input
            type="password"
            className="ap-key-input"
            value={adminKey}
            onChange={(e) => saveKey(e.target.value)}
            placeholder="ADMIN_API_KEY"
          />
        </div>
      </header>

      {/* ── Form ─────────────────────────────────────────────────────────── */}
      <section className="ap-form-section">
        <h2>{editId ? '프리셋 수정' : '새 프리셋 추가'}</h2>

        {/* Reference image */}
        <div className="ap-field">
          <label>참조 이미지</label>
          <div className="ap-img-row">
            {form.reference_image_url && (
              <img className="ap-preview-img" src={form.reference_image_url} alt="preview" />
            )}
            <div className="ap-img-actions">
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
              <button className="ap-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? '업로드 중...' : '📤 이미지 업로드'}
              </button>
              <button
                className="ap-btn ap-btn--analyze"
                onClick={handleAnalyze}
                disabled={analyzing || !form.reference_image_url}
              >
                {analyzing ? '🔄 분석 중...' : '✨ Claude 자동 분석'}
              </button>
            </div>
          </div>
          <input
            className="ap-input"
            value={form.reference_image_url}
            onChange={(e) => setForm((f) => ({ ...f, reference_image_url: e.target.value }))}
            placeholder="또는 이미지 URL 직접 입력"
          />
        </div>

        <div className="ap-grid-2">
          <div className="ap-field">
            <label>Name (영문, snake_case)</label>
            <input className="ap-input" value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="japandi" />
          </div>
          <div className="ap-field">
            <label>Label (한국어)</label>
            <input className="ap-input" value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="재팬디" />
          </div>
        </div>

        <div className="ap-field">
          <label>설명 (한국어)</label>
          <textarea className="ap-input ap-textarea" value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="스타일 설명..." rows={3} />
        </div>

        <div className="ap-field">
          <label>IP-Adapter Prompt (영문, comma-separated)</label>
          <textarea className="ap-input ap-textarea" value={form.prompt}
            onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            placeholder="japandi interior, warm wood tones, minimal decor..." rows={2} />
        </div>

        <div className="ap-grid-3">
          <div className="ap-field">
            <label>IP-Adapter Weight ({form.ip_adapter_weight})</label>
            <input type="range" min="0.3" max="0.9" step="0.05"
              value={form.ip_adapter_weight}
              onChange={(e) => setForm((f) => ({ ...f, ip_adapter_weight: parseFloat(e.target.value) }))} />
          </div>
          <div className="ap-field">
            <label>Display Order</label>
            <input className="ap-input" type="number" value={form.display_order}
              onChange={(e) => setForm((f) => ({ ...f, display_order: e.target.value }))} />
          </div>
          <div className="ap-field">
            <label>Tags (쉼표 구분)</label>
            <input className="ap-input" value={tagsDisplay}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder="#미니멀, #우드톤" />
          </div>
        </div>

        <div className="ap-form-actions">
          {editId && (
            <button className="ap-btn ap-btn--cancel"
              onClick={() => { setForm(EMPTY_FORM); setEditId(null); }}>
              취소
            </button>
          )}
          <button className="ap-btn ap-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? '저장 중...' : editId ? '✅ 수정 저장' : '✅ 프리셋 생성'}
          </button>
        </div>
      </section>

      {/* ── Preset list ──────────────────────────────────────────────────── */}
      <section className="ap-list-section">
        <h2>등록된 프리셋 ({presets.length})</h2>
        <div className="ap-preset-list">
          {presets.map((p) => (
            <div key={p.dbId} className={`ap-preset-row ${p.isUserPreset ? 'user' : ''}`}>
              {p.referenceImageUrl
                ? <img className="ap-row-thumb" src={p.referenceImageUrl} alt={p.label} />
                : <div className="ap-row-thumb ap-row-thumb--placeholder">🎨</div>
              }
              <div className="ap-row-info">
                <strong>{p.label}</strong>
                <code>{p.id}</code>
                <span>{p.description?.slice(0, 60)}…</span>
                {p.isUserPreset && <span className="ap-user-badge">사용자</span>}
              </div>
              <div className="ap-row-meta">
                <span>IP-w: {p.ipAdapterWeight}</span>
              </div>
              <div className="ap-row-actions">
                <button className="ap-btn ap-btn--edit" onClick={() => handleEdit(p)}>수정</button>
                <button className="ap-btn ap-btn--delete" onClick={() => handleDelete(p.dbId)}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
