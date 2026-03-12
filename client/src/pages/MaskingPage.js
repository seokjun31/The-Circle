import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { startRender, saveOrder } from '../utils/api';
import { useAppState } from '../hooks/useAppState';
import './MaskingPage.css';

const BRUSH_SIZES = [8, 16, 32, 64];
const MODES = [
  { id: 'brush', label: '브러시', icon: '🖌️' },
  { id: 'eraser', label: '지우개', icon: '⬜' },
];

function MaskingPage() {
  const navigate = useNavigate();
  const { state, update } = useAppState();

  const canvasRef = useRef(null);
  const maskCanvasRef = useRef(null);
  const containerRef = useRef(null);

  const [brushSize, setBrushSize] = useState(32);
  const [mode, setMode] = useState('brush');
  const [isDrawing, setIsDrawing] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastPos, setLastPos] = useState(null);

  const imageRef = useRef(null);
  const maskHistory = useRef([]);

  useEffect(() => {
    if (!state.imageId) {
      toast.error('먼저 방 사진을 업로드해주세요.');
      navigate('/');
      return;
    }
    if (!state.selectedMood) {
      toast.error('스타일을 먼저 선택해주세요.');
      navigate('/style');
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageRef.current = img;
      initCanvas(img);
      setImageLoaded(true);
    };
    img.onerror = () => toast.error('이미지를 불러오지 못했습니다.');
    img.src = state.imageUrl;
  }, [state.imageId, state.imageUrl, state.selectedMood, navigate]);

  const initCanvas = useCallback((img) => {
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!canvas || !maskCanvas) return;

    const maxW = containerRef.current?.clientWidth || 800;
    const scale = Math.min(1, maxW / img.naturalWidth);
    const w = Math.floor(img.naturalWidth * scale);
    const h = Math.floor(img.naturalHeight * scale);

    canvas.width = w;
    canvas.height = h;
    maskCanvas.width = w;
    maskCanvas.height = h;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    const mCtx = maskCanvas.getContext('2d');
    mCtx.clearRect(0, 0, w, h);
  }, []);

  const getPos = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const drawStroke = useCallback((from, to) => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext('2d');

    ctx.save();
    if (mode === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 100, 100, 0.65)';
    }
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }, [brushSize, mode]);

  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    const pos = getPos(e, maskCanvasRef.current);
    setIsDrawing(true);
    setLastPos(pos);

    // Save snapshot for undo
    const mCtx = maskCanvasRef.current.getContext('2d');
    maskHistory.current.push(
      mCtx.getImageData(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height)
    );
    if (maskHistory.current.length > 30) maskHistory.current.shift();

    drawStroke(pos, pos);
  }, [drawStroke]);

  const handlePointerMove = useCallback((e) => {
    e.preventDefault();
    if (!isDrawing) return;
    const pos = getPos(e, maskCanvasRef.current);
    if (lastPos) drawStroke(lastPos, pos);
    setLastPos(pos);
  }, [isDrawing, lastPos, drawStroke]);

  const handlePointerUp = useCallback(() => {
    setIsDrawing(false);
    setLastPos(null);
  }, []);

  const handleUndo = () => {
    if (maskHistory.current.length === 0) return;
    const snapshot = maskHistory.current.pop();
    const mCtx = maskCanvasRef.current.getContext('2d');
    mCtx.putImageData(snapshot, 0, 0);
  };

  const handleClearMask = () => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const mCtx = maskCanvas.getContext('2d');
    maskHistory.current.push(
      mCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    );
    mCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  };

  const getMaskBase64 = () => {
    const maskCanvas = maskCanvasRef.current;
    // Create white/black hint mask to send as SAM2 prompt
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = maskCanvas.width;
    tempCanvas.height = maskCanvas.height;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.fillStyle = '#000';
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    const mCtx = maskCanvas.getContext('2d');
    const imgData = mCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    for (let i = 3; i < imgData.data.length; i += 4) {
      if (imgData.data[i] > 0) {
        const px = (i - 3) / 4;
        const x = px % maskCanvas.width;
        const y = Math.floor(px / maskCanvas.width);
        tCtx.fillStyle = '#fff';
        tCtx.fillRect(x, y, 1, 1);
      }
    }
    return tempCanvas.toDataURL('image/png').split(',')[1];
  };

  const handleRender = async () => {
    const maskBase64 = getMaskBase64();
    const isEmpty = maskCanvasRef.current
      .getContext('2d')
      .getImageData(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height)
      .data.some((v, i) => i % 4 === 3 && v > 0);

    if (!isEmpty) {
      toast.error('인테리어를 적용할 영역을 대충이라도 칠해주세요. SAM2가 알아서 정밀하게 다듬어줍니다!');
      return;
    }

    setSubmitting(true);
    try {
      const materialImage =
        state.selectedMaterials?.length > 0
          ? state.selectedMaterials[0].imageUrl
          : null;

      const { jobId } = await startRender({
        imageId: state.imageId,
        maskBase64,
        mood: state.selectedMood,
        materialIds: state.selectedMaterials?.map((m) => m.id) || [],
        materialImage,
      });

      await saveOrder({
        imageId: state.imageId,
        mood: state.selectedMood,
        materialIds: state.selectedMaterials?.map((m) => m.id) || [],
        jobId,
      });

      update({ jobId, maskBase64 });
      toast.success('렌더링을 시작했습니다! SAM2가 마스크를 다듬고 있어요.');
      navigate('/result');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="masking-page">
      <div className="page-header">
        <h1>마스킹 영역 지정</h1>
        <p>
          인테리어를 적용할 바닥·벽·천장 위를 <strong>대충 칠하기만</strong> 하세요.
          정밀한 경계선은 <strong>SAM2</strong>가 자동으로 잡아줍니다.
        </p>
      </div>

      <div className="masking-layout">
        {/* Toolbar */}
        <div className="masking-toolbar card">
          <div className="toolbar-section">
            <h3 className="toolbar-label">모드</h3>
            <div className="mode-buttons">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`tool-btn ${mode === m.id ? 'active' : ''}`}
                  onClick={() => setMode(m.id)}
                >
                  <span>{m.icon}</span>
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-section">
            <h3 className="toolbar-label">브러시 크기</h3>
            <div className="brush-sizes">
              {BRUSH_SIZES.map((size) => (
                <button
                  key={size}
                  className={`brush-size-btn ${brushSize === size ? 'active' : ''}`}
                  onClick={() => setBrushSize(size)}
                  title={`${size}px`}
                >
                  <span
                    className="brush-preview"
                    style={{ width: Math.max(6, size / 3), height: Math.max(6, size / 3) }}
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-section">
            <h3 className="toolbar-label">편집</h3>
            <div className="edit-buttons">
              <button className="btn btn-sm btn-secondary" onClick={handleUndo}>
                ↩ 되돌리기
              </button>
              <button className="btn btn-sm btn-secondary" onClick={handleClearMask}>
                🗑 전체 지우기
              </button>
            </div>
          </div>

          {/* SAM2 info badge */}
          <div className="toolbar-section">
            <div className="sam2-badge">
              <span className="sam2-icon">🎯</span>
              <div>
                <strong>SAM2 자동 정밀화</strong>
                <p>러프하게 칠해도 됩니다. 렌더링 시 ComfyUI 내 SAM2가 정확한 경계를 자동으로 추출합니다.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Canvas Area */}
        <div className="canvas-container" ref={containerRef}>
          {!imageLoaded && (
            <div className="loading-overlay">
              <div className="spinner spinner-lg" />
              <p>이미지 불러오는 중...</p>
            </div>
          )}
          <div className="canvas-wrapper" style={{ display: imageLoaded ? 'block' : 'none' }}>
            <canvas ref={canvasRef} className="base-canvas" />
            <canvas
              ref={maskCanvasRef}
              className="mask-canvas"
              style={{ cursor: mode === 'eraser' ? 'cell' : 'crosshair' }}
              onMouseDown={handlePointerDown}
              onMouseMove={handlePointerMove}
              onMouseUp={handlePointerUp}
              onMouseLeave={handlePointerUp}
              onTouchStart={handlePointerDown}
              onTouchMove={handlePointerMove}
              onTouchEnd={handlePointerUp}
            />
          </div>
        </div>
      </div>

      <div className="masking-footer">
        <div className="masking-info card">
          <span className="info-icon">💡</span>
          <p>
            빨간색으로 <strong>대략적으로</strong> 칠한 영역을 SAM2가 분석해 정밀 마스크로 변환한 뒤
            인페인팅을 진행합니다. 바닥·벽·천장 어디든 원하는 부분을 칠해보세요.
          </p>
        </div>

        <div className="page-actions" style={{ paddingTop: 0, borderTop: 'none', marginTop: '1rem' }}>
          <button className="btn btn-secondary" onClick={() => navigate('/style')}>
            ← 이전
          </button>
          <button
            className="btn btn-primary btn-lg"
            onClick={handleRender}
            disabled={submitting || !imageLoaded}
          >
            {submitting ? (
              <>
                <span className="spinner" />
                SAM2 정밀화 + 렌더링 중...
              </>
            ) : (
              '✨ SAM2로 렌더링 시작'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MaskingPage;
