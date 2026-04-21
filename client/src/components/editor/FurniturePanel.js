import React, { useState, useRef } from 'react';
import toast from 'react-hot-toast';
import { uploadFurnitureImage, removeFurnitureBg } from '../../utils/api';
import './FurniturePanel.css';

function FurniturePanel({ selectedFurniture, onSelect }) {
  const [uploading, setUploading]           = useState(false);
  const [removingBg, setRemovingBg]         = useState(false);
  const [customFile, setCustomFile]         = useState(null);
  const [customPreview, setCustomPreview]   = useState(null);
  const [customWidthCm, setCustomW]         = useState('');
  const [customHeightCm, setCustomH]        = useState('');
  const [customName, setCustomName]         = useState('');

  const fileInputRef = useRef(null);

  const handleFileChange = (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('이미지 파일만 업로드 가능합니다.');
      return;
    }
    setCustomFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setCustomPreview(e.target.result);
    reader.readAsDataURL(file);
    if (!customName) setCustomName(file.name.replace(/\.[^.]+$/, ''));
  };

  const handleUpload = async () => {
    if (!customFile) {
      toast.error('이미지를 먼저 선택해주세요.');
      return;
    }

    let fileToUpload = customFile;

    // 배경 자동 제거
    setRemovingBg(true);
    try {
      const bgResult = await removeFurnitureBg(customFile);
      const resp = await fetch(bgResult.url);
      const blob = await resp.blob();
      fileToUpload = new File([blob], 'furniture_nobg.png', { type: 'image/png' });
      const reader = new FileReader();
      reader.onload = (e) => setCustomPreview(e.target.result);
      reader.readAsDataURL(fileToUpload);
      toast.success('배경이 제거되었습니다.');
    } catch {
      toast('배경 제거에 실패했습니다. 원본 이미지를 사용합니다.', { icon: '⚠️' });
    } finally {
      setRemovingBg(false);
    }

    // S3 업로드
    setUploading(true);
    try {
      const result = await uploadFurnitureImage(fileToUpload);
      onSelect({
        id:                  null,
        name:                customName || '커스텀 가구',
        image_url:           result.furniture_image_url,
        thumbnail_url:       customPreview,
        width_cm:            customWidthCm ? parseFloat(customWidthCm) : null,
        height_cm:           customHeightCm ? parseFloat(customHeightCm) : null,
        isCustom:            true,
        furniture_image_url: result.furniture_image_url,
      });
      toast.success('커스텀 가구가 준비되었습니다.');
    } catch (err) {
      toast.error(err.message || '업로드에 실패했습니다.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="furniture-panel">
      <div className="fp-upload-form card">
        <h4>가구 이미지 업로드</h4>
        <p className="text-muted" style={{ fontSize: '0.8rem' }}>
          이미지를 업로드하면 배경이 자동으로 제거됩니다 (최대 10 MB)
        </p>

        <div
          className={`fp-upload-dropzone ${customPreview ? 'has-image' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleFileChange(e.dataTransfer.files[0]); }}
        >
          {customPreview ? (
            <img src={customPreview} alt="미리보기" className="fp-upload-preview" />
          ) : (
            <div className="fp-upload-placeholder">
              <span>📦</span>
              <span>클릭하여 이미지 선택</span>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => handleFileChange(e.target.files[0])}
        />

        <input
          type="text"
          placeholder="가구 이름 (선택)"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
        />
        <div className="fp-dim-row">
          <input
            type="number"
            placeholder="너비 (cm)"
            value={customWidthCm}
            onChange={(e) => setCustomW(e.target.value)}
            min="1"
          />
          <span>×</span>
          <input
            type="number"
            placeholder="높이 (cm)"
            value={customHeightCm}
            onChange={(e) => setCustomH(e.target.value)}
            min="1"
          />
        </div>

        <button
          className="btn btn-primary w-full"
          onClick={handleUpload}
          disabled={removingBg || uploading || !customFile}
        >
          {removingBg
            ? <><span className="spinner" /> 배경 제거 중...</>
            : uploading
            ? <><span className="spinner" /> 업로드 중...</>
            : '배치 준비 (배경 자동 제거)'}
        </button>
      </div>
    </div>
  );
}

export default FurniturePanel;
