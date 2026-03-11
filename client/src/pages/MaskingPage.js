import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { removeBackground, startRender, saveOrder } from '../utils/api';
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
  const [removingBg, setRemovingBg] = useState(false);
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
    // Create white/black mask for AI
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

  const handleRemoveBg = async () => {
    setRemovingBg(true);
    try {
      const result = await removeBackground(state.imageId);
      // Apply returned mask to mask canvas
      const maskCanvas = maskCanvasRef.current;
      const mCtx = maskCanvas.getContext('2d');
      const img = new Image();
      img.onload = () => {
        mCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        mCtx.globalCompositeOperation = 'source-over';
        mCtx.drawImage(img, 0, 0, maskCanvas.width, maskCanvas.height);
      };
      img.src = `data:image/png;base64,${result.maskBase64}`;
      toast.success('배경이 자동으로 감지되었습니다!');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setRemovingBg(false);
    }
  };

  const handleRender = async () => {
    const maskBase64 = getMaskBase64();
    const isEmpty = maskCanvasRef.current
      .getContext('2d')
      .getImageData(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height)
      .data.some((v, i) => i % 4 === 3 && v > 0);

    if (!isEmpty) {
      toast.error('렌더링할 영역을 마스킹해주세요.');
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
      toast.success('렌더링을 시작했습니다!');
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
          인테리어를 적용할 영역을 브러시로 칠하거나, 배경 자동 제거를 사용하세요.
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

          <div className="toolbar-section">
            <button
              className="btn btn-outline w-full"
              onClick={handleRemoveBg}
              disabled={removingBg || !imageLoaded}
            >
              {removingBg ? (
                <>
                  <span className="spinner" />
                  처리 중...
                </>
              ) : (
                '🤖 배경 자동 제거'
              )}
            </button>
            <p className="tool-hint">AI가 배경을 감지해 마스크로 변환합니다</p>
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
          <p>빨간색으로 칠해진 영역에 인테리어가 적용됩니다. 바닥, 벽, 천장 등 원하는 부분을 선택하세요.</p>
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
                렌더링 요청 중...
              </>
            ) : (
              '✨ 렌더링 시작'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default MaskingPage;
