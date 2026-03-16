import React, { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { uploadImage } from '../utils/api';
import { useAppState } from '../hooks/useAppState';
import useEditorStore from '../stores/editorStore';
import './UploadPage.css';

function UploadPage() {
  const navigate = useNavigate();
  const { update } = useAppState();
  const setProject = useEditorStore((s) => s.setProject);
  const [preview, setPreview] = useState(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  const handleFile = useCallback((f) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      toast.error('이미지 파일만 업로드 가능합니다.');
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      toast.error('파일 크기는 20MB 이하여야 합니다.');
      return;
    }
    setFile(f);
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target.result);
    reader.readAsDataURL(f);
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      handleFile(f);
    },
    [handleFile]
  );

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const handleInputChange = (e) => handleFile(e.target.files[0]);

  const handleNext = async () => {
    if (!file) {
      toast.error('먼저 방 사진을 업로드해주세요.');
      return;
    }
    setUploading(true);
    try {
      const result = await uploadImage(file);
      update({
        imageId: result.imageId,
        imageUrl: result.imageUrl,
        originalFilename: result.filename,
      });
      // 새 에디터 스토어에도 project 세팅
      setProject({
        id: result.imageId,
        title: file.name,
        original_image_url: result.imageUrl,
      });
      toast.success('이미지가 업로드되었습니다.');
      navigate(`/editor/${result.imageId}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="upload-page">
      <div className="page-header">
        <h1>빈 방 사진 업로드</h1>
        <p>AI가 인테리어를 적용할 방의 사진을 업로드해주세요. 빈 공간이 잘 보이는 사진일수록 좋습니다.</p>
      </div>

      <div className="upload-area-wrapper">
        {!preview ? (
          <div
            className={`drop-zone ${dragging ? 'dragging' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => inputRef.current?.click()}
          >
            <div className="drop-zone-icon">📷</div>
            <p className="drop-zone-title">클릭하거나 사진을 드래그하세요</p>
            <p className="drop-zone-hint">JPG, PNG, WEBP · 최대 20MB</p>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="file-input-hidden"
              onChange={handleInputChange}
            />
          </div>
        ) : (
          <div className="preview-container">
            <div className="preview-header">
              <span className="preview-filename">{file?.name}</span>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setPreview(null);
                  setFile(null);
                }}
              >
                다시 선택
              </button>
            </div>
            <div className="preview-image-wrap">
              <img src={preview} alt="미리보기" className="preview-image" />
            </div>
            <div className="preview-tips card mt-2">
              <h3>좋은 결과를 위한 팁</h3>
              <ul>
                <li>방의 전체 구조가 보이도록 촬영된 사진을 사용하세요</li>
                <li>밝고 자연광이 들어오는 조건이 이상적입니다</li>
                <li>벽, 바닥, 천장이 모두 포함된 사진을 권장합니다</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="page-actions">
        <button
          className="btn btn-primary btn-lg"
          onClick={handleNext}
          disabled={!file || uploading}
        >
          {uploading ? (
            <>
              <span className="spinner" />
              업로드 중...
            </>
          ) : (
            '다음 단계로 →'
          )}
        </button>
      </div>
    </div>
  );
}

export default UploadPage;
