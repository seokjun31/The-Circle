import React, { useState, useRef, useCallback } from 'react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import toast from 'react-hot-toast';
import { copyMood } from '../../utils/api';
import './MoodCopy.css';

const CREDITS_PER_MOOD_COPY = 5;

/** Convert File → base64 data URL */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function CreditConfirmModal({ strength, creditCost, onConfirm, onCancel }) {
  return (
    <div className="mc-modal-overlay" onClick={onCancel}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <h3>분위기 복사 확인</h3>
        <p className="mc-modal-desc">
          참조 이미지의 분위기를 내 방에 적용합니다.
        </p>
        <div className="mc-modal-info">
          <div className="mc-modal-row">
            <span>적용 강도</span>
            <span>{Math.round(strength * 100)}%</span>
          </div>
          <div className="mc-modal-row">
            <span>크레딧 차감</span>
            <span className="mc-credit-cost">{creditCost} 크레딧</span>
          </div>
        </div>
        <div className="mc-modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>취소</button>
          <button className="btn btn-primary" onClick={onConfirm}>적용 시작</button>
        </div>
      </div>
    </div>
  );
}

function MoodCopy({ projectId, originalImageUrl, creditBalance, onResult }) {
  const [referenceFile, setReferenceFile]     = useState(null);
  const [referencePreview, setRefPreview]     = useState(null);
  const [referenceDataUrl, setRefDataUrl]     = useState(null);
  const [strength, setStrength]               = useState(0.5);
  const [isDragging, setIsDragging]           = useState(false);
  const [loading, setLoading]                 = useState(false);
  const [showConfirm, setShowConfirm]         = useState(false);
  const [resultUrl, setResultUrl]             = useState(null);

  const fileInputRef = useRef(null);

  const handleFileSelect = useCallback(async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('이미지 파일만 업로드 가능합니다.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('파일 크기는 10MB 이하여야 합니다.');
      return;
    }
    setReferenceFile(file);
    const dataUrl = await fileToDataURL(file);
    setRefPreview(dataUrl);
    setRefDataUrl(dataUrl);
    setResultUrl(null);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    handleFileSelect(file);
  }, [handleFileSelect]);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleApplyClick = () => {
    if (!referenceDataUrl) {
      toast.error('참조 이미지를 먼저 업로드해주세요.');
      return;
    }
    if ((creditBalance ?? 0) < CREDITS_PER_MOOD_COPY) {
      toast.error(`크레딧이 부족합니다. (잔액: ${creditBalance ?? 0}, 필요: ${CREDITS_PER_MOOD_COPY})`);
      return;
    }
    setShowConfirm(true);
  };

  const handleConfirm = async () => {
    setShowConfirm(false);
    setLoading(true);
    setResultUrl(null);
    try {
      const result = await copyMood(projectId, {
        referenceImage: referenceDataUrl,
        strength,
      });
      setResultUrl(result.result_url);
      if (onResult) onResult(result);
      toast.success(`분위기 복사 완료! 남은 크레딧: ${result.remaining_balance}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mood-copy">
      {showConfirm && (
        <CreditConfirmModal
          strength={strength}
          creditCost={CREDITS_PER_MOOD_COPY}
          onConfirm={handleConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      <div className="mc-layout">
        {/* Left panel — controls */}
        <div className="mc-controls card">

          {/* Reference image upload */}
          <div className="mc-section">
            <h3 className="mc-section-title">참조 이미지 업로드</h3>

            <div
              className={`mc-dropzone ${isDragging ? 'dragging' : ''} ${referencePreview ? 'has-image' : ''}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
            >
              {referencePreview ? (
                <>
                  <img
                    src={referencePreview}
                    alt="참조 이미지"
                    className="mc-ref-preview"
                  />
                  <div className="mc-ref-overlay">
                    <span>클릭하여 변경</span>
                  </div>
                </>
              ) : (
                <div className="mc-dropzone-inner">
                  <div className="mc-upload-icon">📷</div>
                  <p>참조 이미지를 드래그하거나 클릭하여 업로드</p>
                  <p className="text-muted" style={{ fontSize: '0.8rem' }}>
                    JPEG, PNG, WEBP — 최대 10MB
                  </p>
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="mc-file-input"
              onChange={(e) => handleFileSelect(e.target.files[0])}
            />
          </div>

          {/* Strength slider */}
          <div className="mc-section">
            <h3 className="mc-section-title">
              적용 강도
              <span className="mc-strength-value">{Math.round(strength * 100)}%</span>
            </h3>
            <input
              type="range"
              className="mc-slider"
              min="0.3"
              max="0.8"
              step="0.05"
              value={strength}
              onChange={(e) => setStrength(parseFloat(e.target.value))}
            />
            <div className="mc-slider-labels">
              <span>은은하게</span>
              <span>강하게</span>
            </div>
          </div>

          {/* Credit info */}
          <div className="mc-section mc-credit-info">
            <span>잔여 크레딧: <strong>{creditBalance ?? '—'}</strong></span>
            <span>차감 예정: <strong className="text-accent">{CREDITS_PER_MOOD_COPY}</strong></span>
          </div>

          <button
            className="btn btn-primary w-full btn-lg"
            onClick={handleApplyClick}
            disabled={loading || !referenceDataUrl}
          >
            {loading ? (
              <>
                <span className="spinner" />
                분위기 복사 중...
              </>
            ) : (
              '🎨 분위기 적용'
            )}
          </button>

          {referenceFile && (
            <p className="mc-file-name text-muted">
              {referenceFile.name} ({(referenceFile.size / 1024).toFixed(0)} KB)
            </p>
          )}
        </div>

        {/* Right panel — before/after preview */}
        <div className="mc-preview">
          {loading && (
            <div className="mc-loading-overlay">
              <div className="spinner spinner-lg" />
              <p>AI가 분위기를 분석하고 적용하고 있습니다...</p>
              <p className="text-muted" style={{ fontSize: '0.85rem' }}>약 20–40초 소요</p>
            </div>
          )}

          {!loading && resultUrl ? (
            <div className="mc-result">
              <p className="mc-result-label">적용 결과 — 슬라이더로 비교하세요</p>
              <ReactCompareSlider
                className="mc-compare-slider"
                itemOne={
                  <ReactCompareSliderImage
                    src={originalImageUrl}
                    alt="적용 전"
                    style={{ objectFit: 'cover' }}
                  />
                }
                itemTwo={
                  <ReactCompareSliderImage
                    src={resultUrl}
                    alt="적용 후"
                    style={{ objectFit: 'cover' }}
                  />
                }
              />
              <div className="mc-result-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => { setResultUrl(null); }}
                >
                  다시 설정
                </button>
                <a
                  href={resultUrl}
                  download="mood_copy_result.jpg"
                  className="btn btn-outline btn-sm"
                  target="_blank"
                  rel="noreferrer"
                >
                  다운로드
                </a>
              </div>
            </div>
          ) : !loading && (
            <div className="mc-split-preview">
              <div className="mc-split-half">
                <div className="mc-split-label">내 방 (변환될 이미지)</div>
                {originalImageUrl ? (
                  <img src={originalImageUrl} alt="내 방" className="mc-split-img" />
                ) : (
                  <div className="mc-split-empty">방 사진 없음</div>
                )}
              </div>
              <div className="mc-split-arrow">→</div>
              <div className="mc-split-half">
                <div className="mc-split-label">분위기 참조 이미지</div>
                {referencePreview ? (
                  <img src={referencePreview} alt="참조 이미지" className="mc-split-img" />
                ) : (
                  <div className="mc-split-empty">참조 이미지를 업로드해주세요</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MoodCopy;
