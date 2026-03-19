import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { listProjects, uploadImage, deleteProject, getCreditBalance } from '../utils/api';
import useEditorStore from '../stores/editorStore';
import './DashboardPage.css';

const STATUS_CONFIG = {
  draft:      { text: 'Editing',    dotColor: '#fbbf24', bgColor: 'rgba(251,191,36,0.15)',  textColor: '#fbbf24', borderColor: 'rgba(251,191,36,0.3)' },
  processing: { text: 'Processing', dotColor: '#bd9dff', bgColor: 'rgba(189,157,255,0.15)', textColor: '#bd9dff', borderColor: 'rgba(189,157,255,0.3)' },
  done:       { text: 'Complete',   dotColor: '#4ade80', bgColor: 'rgba(74,222,128,0.15)',  textColor: '#4ade80', borderColor: 'rgba(74,222,128,0.3)',  pulse: true },
};

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── New Project Modal ─────────────────────────────────────────────────────────
function NewProjectModal({ onClose, onCreated }) {
  const [file, setFile]           = useState(null);
  const [preview, setPreview]     = useState(null);
  const [dragging, setDragging]   = useState(false);
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
          <div>
            <h2>New Project</h2>
            <p className="db-modal-sub">Upload a room photo to begin</p>
          </div>
          <button className="db-modal-close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {!preview ? (
          <div
            className={`db-dropzone ${dragging ? 'dragging' : ''}`}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onClick={() => inputRef.current?.click()}
          >
            <span className="material-symbols-outlined db-dropzone-icon">add_photo_alternate</span>
            <p>클릭하거나 사진을 드래그하세요</p>
            <span>JPG, PNG, WEBP · 최대 20MB</span>
            <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files[0])} />
          </div>
        ) : (
          <div className="db-preview-wrap">
            <img src={preview} alt="미리보기" />
            <button className="db-reselect" onClick={() => { setFile(null); setPreview(null); }}>
              <span className="material-symbols-outlined" style={{ fontSize: '0.9rem' }}>refresh</span>
              다시 선택
            </button>
          </div>
        )}

        <div className="db-modal-footer">
          <button className="db-btn-cancel" onClick={onClose} disabled={uploading}>취소</button>
          <button className="db-btn-upload" onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? (
              <><span className="spinner" /> 업로드 중...</>
            ) : (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>arrow_forward</span>
                에디터로 이동
              </>
            )}
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

  const [projects, setProjects]           = useState([]);
  const [loading, setLoading]             = useState(true);
  const [showModal, setShowModal]         = useState(false);
  const [creditBalance, setCreditBalance] = useState(null);
  const [page, setPage]                   = useState(1);
  const [total, setTotal]                 = useState(0);
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
      {/* ── Header section ──────────────────────────────────────────────── */}
      <div className="db-header-section">
        <div className="db-header-inner">
          <div>
            <h1 className="db-heading">My Projects</h1>
            <p className="db-subheading">
              <span className="material-symbols-outlined db-subheading-icon">grid_view</span>
              Total {total} projects
            </p>
          </div>
          <button className="db-new-btn" onClick={() => setShowModal(true)}>
            <span className="material-symbols-outlined">add</span>
            <span>New Project</span>
          </button>
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
            <span className="material-symbols-outlined db-empty-icon">home</span>
            <h3>아직 프로젝트가 없습니다</h3>
            <p>첫 번째 방 사진을 업로드하고 AI 인테리어를 시작하세요</p>
            <button className="db-new-btn" onClick={() => setShowModal(true)}>
              <span className="material-symbols-outlined">add</span>
              새 프로젝트 만들기
            </button>
          </div>
        ) : (
          <>
            <div className="db-grid">
              {projects.map((proj) => {
                const status = STATUS_CONFIG[proj.status] || STATUS_CONFIG.draft;
                return (
                  <div key={proj.id} className="db-card" onClick={() => handleOpen(proj)}>
                    {/* Thumbnail */}
                    <div className="db-card-thumb">
                      {proj.thumbnail_url ? (
                        <img src={proj.thumbnail_url} alt={proj.title} className="db-card-img" />
                      ) : (
                        <div className="db-card-placeholder">
                          <span className="material-symbols-outlined">home</span>
                        </div>
                      )}

                      {/* Gradient overlay */}
                      <div className="db-card-gradient" />

                      {/* Status badge */}
                      <div className="db-status-badge" style={{
                        background: status.bgColor,
                        color: status.textColor,
                        border: `1px solid ${status.borderColor}`,
                      }}>
                        <span
                          className="db-status-dot"
                          style={{
                            background: status.dotColor,
                            animation: status.pulse ? 'pulse 1.5s infinite' : 'none',
                          }}
                        />
                        {status.text}
                      </div>

                      {/* Card footer (title + date + delete) */}
                      <div className="db-card-footer">
                        <div className="db-card-info">
                          <h3 className="db-card-title">{proj.title}</h3>
                          <p className="db-card-date">{formatDate(proj.created_at)}</p>
                        </div>
                        <button
                          className="db-card-del"
                          onClick={(e) => handleDelete(e, proj.id)}
                          title="삭제"
                        >
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="db-pagination">
                <button
                  className="db-page-arrow"
                  disabled={page <= 1}
                  onClick={() => loadProjects(page - 1)}
                >
                  <span className="material-symbols-outlined">chevron_left</span>
                </button>
                <div className="db-page-nums">
                  {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      className={`db-page-num ${p === page ? 'active' : ''}`}
                      onClick={() => loadProjects(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <button
                  className="db-page-arrow"
                  disabled={page >= totalPages}
                  onClick={() => loadProjects(page + 1)}
                >
                  <span className="material-symbols-outlined">chevron_right</span>
                </button>
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
