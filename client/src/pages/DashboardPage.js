import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { listProjects, uploadImage, deleteProject, getCreditBalance } from '../utils/api';
import useEditorStore from '../stores/editorStore';
import './DashboardPage.css';

const STATUS_LABEL = {
  draft:      { text: '편집 중',   cls: 'draft'      },
  processing: { text: '처리 중',   cls: 'processing' },
  done:       { text: '완료',      cls: 'done'       },
};

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── New Project Modal ─────────────────────────────────────────────────────────
function NewProjectModal({ onClose, onCreated }) {
  const [file, setFile]         = useState(null);
  const [preview, setPreview]   = useState(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef();

  const handleFile = (f) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast.error('이미지 파일만 가능합니다.'); return; }
    if (f.size > 20 * 1024 * 1024) { toast.error('20MB 이하 파일만 가능합니다.'); return; }
    setFile(f);
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target.result);
    reader.readAsDataURL(f);
  };

  const handleDrop = (e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const result = await uploadImage(file);
      toast.success('프로젝트가 생성됐습니다!');
      onCreated(result);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="db-modal-backdrop" onClick={onClose}>
      <div className="db-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <h2>새 프로젝트</h2>
          <button className="db-modal-close" onClick={onClose}>✕</button>
        </div>

        {!preview ? (
          <div
            className={`db-dropzone ${dragging ? 'dragging' : ''}`}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onClick={() => inputRef.current?.click()}
          >
            <div className="db-dropzone-icon">📷</div>
            <p>클릭하거나 사진을 드래그하세요</p>
            <span>JPG, PNG, WEBP · 최대 20MB</span>
            <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files[0])} />
          </div>
        ) : (
          <div className="db-preview-wrap">
            <img src={preview} alt="미리보기" />
            <button className="db-reselect" onClick={() => { setFile(null); setPreview(null); }}>다시 선택</button>
          </div>
        )}

        <div className="db-modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={uploading}>취소</button>
          <button className="btn btn-primary" onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? <><span className="spinner" /> 업로드 중...</> : '에디터로 이동 →'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function DashboardPage() {
  const navigate = useNavigate();
  const { user }  = useAuth();
  const setProject = useEditorStore((s) => s.setProject);

  const [projects, setProjects]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [showModal, setShowModal]       = useState(false);
  const [creditBalance, setCreditBalance] = useState(null);
  const [page, setPage]                 = useState(1);
  const [total, setTotal]               = useState(0);
  const PAGE_SIZE = 12;

  const loadProjects = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const data = await listProjects(p, PAGE_SIZE);
      setProjects(data.items);
      setTotal(data.total);
      setPage(p);
    } catch {
      toast.error('프로젝트를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects(1);
    getCreditBalance().then((d) => setCreditBalance(d.balance)).catch(() => {});
  }, [loadProjects]);

  const handleCreated = (result) => {
    // result = { imageId, imageUrl, filename }
    setShowModal(false);
    navigate(`/editor/${result.imageId}`);
  };

  const handleOpen = (project) => {
    setProject(project);
    navigate(`/editor/${project.id}`);
  };

  const handleDelete = async (e, projectId) => {
    e.stopPropagation();
    if (!window.confirm('프로젝트를 삭제할까요?')) return;
    try {
      await deleteProject(projectId);
      toast.success('삭제됐습니다.');
      loadProjects(page);
    } catch {
      toast.error('삭제에 실패했습니다.');
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="db-page">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="db-topbar">
        <div className="db-topbar-inner">
          <div>
            <h1>내 프로젝트</h1>
            <p>총 {total}개의 프로젝트</p>
          </div>
          <div className="db-topbar-right">
            <div className="db-credit-badge">
              <span>💎</span>
              <span>{creditBalance !== null ? creditBalance : '—'} 크레딧</span>
            </div>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              + 새 프로젝트
            </button>
          </div>
        </div>
      </div>

      {/* ── Project grid ─────────────────────────────────────────────────── */}
      <div className="db-content">
        {loading ? (
          <div className="db-loading">
            <span className="spinner spinner-lg" />
            <p>불러오는 중...</p>
          </div>
        ) : projects.length === 0 ? (
          <div className="db-empty">
            <div className="db-empty-icon">🏠</div>
            <h3>아직 프로젝트가 없습니다</h3>
            <p>첫 번째 방 사진을 업로드하고 AI 인테리어를 시작하세요</p>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>새 프로젝트 만들기</button>
          </div>
        ) : (
          <>
            <div className="db-grid">
              {projects.map((proj) => {
                const status = STATUS_LABEL[proj.status] || STATUS_LABEL.draft;
                return (
                  <div key={proj.id} className="db-card" onClick={() => handleOpen(proj)}>
                    <div className="db-card-thumb">
                      {proj.thumbnail_url ? (
                        <img src={proj.thumbnail_url} alt={proj.title} />
                      ) : (
                        <div className="db-card-placeholder">🏠</div>
                      )}
                      <span className={`db-status-badge ${status.cls}`}>{status.text}</span>
                    </div>
                    <div className="db-card-body">
                      <h3 className="db-card-title">{proj.title}</h3>
                      <p className="db-card-date">{formatDate(proj.created_at)}</p>
                    </div>
                    <div className="db-card-actions">
                      <button
                        className="db-card-del"
                        onClick={(e) => handleDelete(e, proj.id)}
                        title="삭제"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className="db-pagination">
                <button disabled={page <= 1} onClick={() => loadProjects(page - 1)} className="btn btn-secondary btn-sm">← 이전</button>
                <span>{page} / {totalPages}</span>
                <button disabled={page >= totalPages} onClick={() => loadProjects(page + 1)} className="btn btn-secondary btn-sm">다음 →</button>
              </div>
            )}
          </>
        )}
      </div>

      {showModal && (
        <NewProjectModal onClose={() => setShowModal(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}

export default DashboardPage;
