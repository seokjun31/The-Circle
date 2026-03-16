/**
 * SAM ONNX 성능 벤치마크 페이지
 *
 * 측정 항목:
 *   - 모델 로딩 시간 (encoder + decoder)
 *   - 이미지 인코딩 시간
 *   - 클릭당 디코딩 시간 (10회 평균)
 *   - JS Heap 메모리 (performance.memory 지원 시)
 * WebGL vs WASM 백엔드 비교
 */

import React, { useState, useRef, useCallback } from 'react';
import * as ort from 'onnxruntime-web';
import {
  preprocessImage,
  runEncoder,
  runDecoder,
  SAM_SIZE,
} from '../lib/sam/samUtils';
import {
  configureOrtPaths,
  ENCODER_MODEL_PATH,
  DECODER_MODEL_PATH,
} from '../lib/sam/SamModel';
import './BenchmarkPage.css';

// ── 합성 테스트 이미지 생성 ────────────────────────────────────────────────────
const TEST_CONFIGS = [
  { label: '소형 (512×384)', width: 512,  height: 384  },
  { label: '중형 (1024×768)', width: 1024, height: 768  },
  { label: '대형 (1920×1080)', width: 1920, height: 1080 },
];

function makeSyntheticImage(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // 그라디언트 배경
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0,   '#f0ebe0');
  grad.addColorStop(0.5, '#d4c9b0');
  grad.addColorStop(1,   '#b8a890');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // 기하 도형 (다양한 세그먼트 영역)
  ctx.fillStyle = '#8b7355';
  ctx.fillRect(width * 0.1, height * 0.4, width * 0.3, height * 0.5);

  ctx.fillStyle = '#c8b89a';
  ctx.fillRect(width * 0.5, height * 0.1, width * 0.4, height * 0.6);

  ctx.fillStyle = '#e8ddd0';
  ctx.beginPath();
  ctx.arc(width * 0.25, height * 0.25, width * 0.12, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

function heapMB() {
  if (window.performance && window.performance.memory) {
    return (window.performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
  }
  return null;
}

// ── 상태 타입 ──────────────────────────────────────────────────────────────────
const IDLE    = 'idle';
const RUNNING = 'running';
const DONE    = 'done';
const ERROR   = 'error';

// ── 벤치마크 결과 행 컴포넌트 ─────────────────────────────────────────────────
function ResultRow({ label, webglValue, wasmValue, unit = 'ms', highlight }) {
  const better = (a, b) => {
    if (a == null || b == null) return null;
    const aNum = parseFloat(a);
    const bNum = parseFloat(b);
    if (isNaN(aNum) || isNaN(bNum)) return null;
    return aNum <= bNum ? 'webgl' : 'wasm';
  };
  const win = highlight ? better(webglValue, wasmValue) : null;

  return (
    <tr>
      <td className="bm-label">{label}</td>
      <td className={`bm-val ${win === 'webgl' ? 'bm-winner' : ''}`}>
        {webglValue != null ? `${webglValue} ${unit}` : '—'}
      </td>
      <td className={`bm-val ${win === 'wasm' ? 'bm-winner' : ''}`}>
        {wasmValue != null ? `${wasmValue} ${unit}` : '—'}
      </td>
    </tr>
  );
}

// ── 단계 로그 컴포넌트 ─────────────────────────────────────────────────────────
function LogLine({ entry }) {
  const cls = entry.type === 'error' ? 'bm-log-error'
    : entry.type === 'ok'    ? 'bm-log-ok'
    : entry.type === 'warn'  ? 'bm-log-warn'
    : 'bm-log-info';
  return <div className={`bm-log-line ${cls}`}>{entry.text}</div>;
}

// ══════════════════════════════════════════════════════════════════════════════
//  메인 페이지 컴포넌트
// ══════════════════════════════════════════════════════════════════════════════
export default function BenchmarkPage() {
  const [phase,   setPhase]   = useState(IDLE);
  const [log,     setLog]     = useState([]);
  const [results, setResults] = useState(null);   // { webgl: {...}, wasm: {...} }
  const [verdict, setVerdict] = useState(null);
  const abortRef = useRef(false);

  const addLog = useCallback((text, type = 'info') => {
    setLog(prev => [...prev, { text, type, id: Date.now() + Math.random() }]);
  }, []);

  // ── 단일 백엔드 벤치마크 ────────────────────────────────────────────────────
  async function runBackend(backend) {
    const label = backend === 'webgl' ? 'WebGL' : 'WASM';
    addLog(`\n── ${label} 백엔드 시작 ──`, 'info');
    const r = { backend, imageResults: [] };

    // ── 모델 로딩 시간 ──────────────────────────────────────────────────────
    addLog(`[${label}] 모델 로딩 중...`);
    const memBefore = heapMB();
    const t0 = performance.now();

    let encoderSession, decoderSession;
    try {
      configureOrtPaths();
      const encoderProviders = backend === 'webgl' ? ['webgl', 'wasm'] : ['wasm'];
      encoderSession = await ort.InferenceSession.create(ENCODER_MODEL_PATH, {
        executionProviders: encoderProviders,
        graphOptimizationLevel: 'all',
      });
      decoderSession = await ort.InferenceSession.create(DECODER_MODEL_PATH, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (e) {
      addLog(`[${label}] 모델 로드 실패: ${e.message}`, 'error');
      return null;
    }

    const loadMs = Math.round(performance.now() - t0);
    const memAfter = heapMB();
    const memDelta = memBefore && memAfter
      ? (parseFloat(memAfter) - parseFloat(memBefore)).toFixed(1)
      : null;

    r.loadMs  = loadMs;
    r.memMB   = memDelta;
    addLog(`[${label}] 모델 로드: ${loadMs}ms${memDelta ? `, 메모리 +${memDelta}MB` : ''}`, 'ok');

    // ── 이미지별 인코딩 + 디코딩 ────────────────────────────────────────────
    for (const cfg of TEST_CONFIGS) {
      if (abortRef.current) break;
      addLog(`[${label}] 테스트 이미지: ${cfg.label}`);

      const canvas = makeSyntheticImage(cfg.width, cfg.height);
      const { tensor, originalSize, modelSize } = preprocessImage(canvas);

      // 인코딩 시간
      const tEnc0 = performance.now();
      let embedding;
      try {
        embedding = await runEncoder(encoderSession, tensor);
      } catch (e) {
        addLog(`[${label}] 인코딩 실패 (${cfg.label}): ${e.message}`, 'error');
        r.imageResults.push({ ...cfg, encodeMs: null, decodeAvgMs: null });
        continue;
      }
      const encodeMs = Math.round(performance.now() - tEnc0);
      addLog(`[${label}]   인코딩: ${encodeMs}ms`);

      // 디코딩 10회 평균
      const DECODE_RUNS = 10;
      const decodeTimes = [];
      const testPoints = [
        { x: cfg.width * 0.3,  y: cfg.height * 0.5 },
        { x: cfg.width * 0.5,  y: cfg.height * 0.3 },
        { x: cfg.width * 0.7,  y: cfg.height * 0.6 },
      ];

      for (let i = 0; i < DECODE_RUNS; i++) {
        if (abortRef.current) break;
        const pt = testPoints[i % testPoints.length];
        const tDec0 = performance.now();
        try {
          await runDecoder(decoderSession, embedding, [pt], [1], originalSize, modelSize);
        } catch (e) {
          addLog(`[${label}]   디코딩 실패: ${e.message}`, 'warn');
          break;
        }
        decodeTimes.push(performance.now() - tDec0);
      }

      const decodeAvgMs = decodeTimes.length > 0
        ? Math.round(decodeTimes.reduce((a, b) => a + b, 0) / decodeTimes.length)
        : null;

      addLog(`[${label}]   디코딩 평균(${DECODE_RUNS}회): ${decodeAvgMs}ms`, 'ok');
      r.imageResults.push({ ...cfg, encodeMs, decodeAvgMs });
    }

    return r;
  }

  // ── 전체 벤치마크 실행 ──────────────────────────────────────────────────────
  const runBenchmark = useCallback(async () => {
    abortRef.current = false;
    setPhase(RUNNING);
    setLog([]);
    setResults(null);
    setVerdict(null);

    addLog('SAM ONNX 벤치마크 시작', 'info');
    addLog(`브라우저: ${navigator.userAgent.split(') ')[0].split('(')[1] || '알 수 없음'}`);
    const heap = heapMB();
    if (heap) addLog(`현재 JS Heap: ${heap} MB`);
    else      addLog('performance.memory 미지원 (Firefox/Safari)', 'warn');

    let webglResult = null;
    let wasmResult  = null;

    try {
      webglResult = await runBackend('webgl');
      if (abortRef.current) throw new Error('중단됨');
      wasmResult  = await runBackend('wasm');
    } catch (e) {
      if (!abortRef.current) addLog(`오류: ${e.message}`, 'error');
      setPhase(ERROR);
      return;
    }

    const res = { webgl: webglResult, wasm: wasmResult };
    setResults(res);

    // ── 판정 ────────────────────────────────────────────────────────────────
    const v = computeVerdict(res);
    setVerdict(v);
    addLog(`\n판정: ${v.summary}`, v.ok ? 'ok' : 'warn');
    setPhase(DONE);
  }, [addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopBenchmark = () => {
    abortRef.current = true;
    setPhase(IDLE);
  };

  // ── 판정 로직 ───────────────────────────────────────────────────────────────
  function computeVerdict(res) {
    const imgIdx = 0; // 소형 이미지 기준
    const webglEnc  = res.webgl?.imageResults?.[imgIdx]?.encodeMs  ?? Infinity;
    const webglDec  = res.webgl?.imageResults?.[imgIdx]?.decodeAvgMs ?? Infinity;
    const wasmEnc   = res.wasm?.imageResults?.[imgIdx]?.encodeMs   ?? Infinity;
    const wasmDec   = res.wasm?.imageResults?.[imgIdx]?.decodeAvgMs ?? Infinity;

    const bestEnc = Math.min(webglEnc, wasmEnc);
    const bestDec = Math.min(webglDec, wasmDec);

    const ok = bestEnc < 5000 && bestDec < 100;
    const recommended = webglEnc < wasmEnc ? 'WebGL' : 'WASM';

    if (ok) {
      return {
        ok: true,
        icon: '✅',
        summary: '이 기기에서 SAM이 원활하게 동작합니다',
        detail: `인코딩 ${bestEnc}ms, 디코딩 ${bestDec}ms — 권장 백엔드: ${recommended}`,
        color: '#22c55e',
      };
    } else if (bestEnc < 15000) {
      return {
        ok: true,
        icon: '⚠️',
        summary: '동작하지만 느릴 수 있습니다',
        detail: `인코딩 ${bestEnc}ms, 디코딩 ${bestDec}ms — 서버 모드도 고려해보세요`,
        color: '#f59e0b',
      };
    } else {
      return {
        ok: false,
        icon: '🖥️',
        summary: '서버 모드를 권장합니다',
        detail: `인코딩 ${bestEnc}ms — 브라우저에서 SAM이 너무 느립니다`,
        color: '#ef4444',
      };
    }
  }

  // ── 테이블 데이터 헬퍼 ──────────────────────────────────────────────────────
  function getVal(backendResult, imgIdx, key) {
    if (!backendResult) return null;
    if (key === 'loadMs') return backendResult.loadMs;
    if (key === 'memMB')  return backendResult.memMB;
    return backendResult.imageResults?.[imgIdx]?.[key] ?? null;
  }

  // ── 렌더 ────────────────────────────────────────────────────────────────────
  return (
    <div className="bm-page">
      <div className="bm-header">
        <h1 className="bm-title">SAM ONNX 성능 벤치마크</h1>
        <p className="bm-subtitle">
          브라우저에서 Segment Anything Model의 속도와 메모리를 측정합니다
        </p>
      </div>

      {/* 설정 카드 */}
      <div className="bm-card">
        <h2 className="bm-card-title">테스트 설정</h2>
        <div className="bm-config-grid">
          <div className="bm-config-item">
            <span className="bm-config-label">테스트 이미지</span>
            <span className="bm-config-value">
              {TEST_CONFIGS.map(c => c.label).join(', ')} (합성)
            </span>
          </div>
          <div className="bm-config-item">
            <span className="bm-config-label">디코딩 반복</span>
            <span className="bm-config-value">각 이미지 10회 평균</span>
          </div>
          <div className="bm-config-item">
            <span className="bm-config-label">비교 대상</span>
            <span className="bm-config-value">WebGL vs WASM 백엔드</span>
          </div>
          <div className="bm-config-item">
            <span className="bm-config-label">메모리 측정</span>
            <span className="bm-config-value">
              {window.performance?.memory ? 'JS Heap (지원됨)' : '미지원 (Chrome만 가능)'}
            </span>
          </div>
        </div>

        <div className="bm-actions">
          {phase === RUNNING ? (
            <button className="bm-btn bm-btn-stop" onClick={stopBenchmark}>
              중단
            </button>
          ) : (
            <button
              className="bm-btn bm-btn-start"
              onClick={runBenchmark}
              disabled={phase === RUNNING}
            >
              {phase === DONE ? '다시 실행' : '벤치마크 시작'}
            </button>
          )}
          {phase === RUNNING && (
            <span className="bm-running-badge">측정 중...</span>
          )}
        </div>
      </div>

      {/* 실시간 로그 */}
      {log.length > 0 && (
        <div className="bm-card">
          <h2 className="bm-card-title">진행 로그</h2>
          <div className="bm-log-box">
            {log.map(entry => <LogLine key={entry.id} entry={entry} />)}
          </div>
        </div>
      )}

      {/* 결과 테이블 */}
      {results && (
        <div className="bm-card">
          <h2 className="bm-card-title">결과</h2>

          <table className="bm-table">
            <thead>
              <tr>
                <th className="bm-th-label">측정 항목</th>
                <th className="bm-th-val">WebGL</th>
                <th className="bm-th-val">WASM</th>
              </tr>
            </thead>
            <tbody>
              {/* 모델 로딩 */}
              <tr className="bm-section-row">
                <td colSpan={3}>모델 로딩</td>
              </tr>
              <ResultRow
                label="전체 로딩 시간"
                webglValue={getVal(results.webgl, 0, 'loadMs')}
                wasmValue={getVal(results.wasm, 0, 'loadMs')}
                unit="ms"
                highlight
              />
              <ResultRow
                label="메모리 증가"
                webglValue={getVal(results.webgl, 0, 'memMB')}
                wasmValue={getVal(results.wasm, 0, 'memMB')}
                unit="MB"
              />

              {/* 이미지별 */}
              {TEST_CONFIGS.map((cfg, idx) => (
                <React.Fragment key={cfg.label}>
                  <tr className="bm-section-row">
                    <td colSpan={3}>{cfg.label} 이미지</td>
                  </tr>
                  <ResultRow
                    label="인코딩 시간"
                    webglValue={getVal(results.webgl, idx, 'encodeMs')}
                    wasmValue={getVal(results.wasm, idx, 'encodeMs')}
                    unit="ms"
                    highlight
                  />
                  <ResultRow
                    label="디코딩 평균 (10회)"
                    webglValue={getVal(results.webgl, idx, 'decodeAvgMs')}
                    wasmValue={getVal(results.wasm, idx, 'decodeAvgMs')}
                    unit="ms"
                    highlight
                  />
                </React.Fragment>
              ))}
            </tbody>
          </table>

          <div className="bm-legend">
            <span className="bm-legend-winner">초록색</span> = 더 빠른 백엔드
          </div>
        </div>
      )}

      {/* 판정 */}
      {verdict && (
        <div className="bm-card bm-verdict-card" style={{ borderColor: verdict.color }}>
          <div className="bm-verdict-icon">{verdict.icon}</div>
          <div className="bm-verdict-content">
            <div className="bm-verdict-summary" style={{ color: verdict.color }}>
              {verdict.summary}
            </div>
            <div className="bm-verdict-detail">{verdict.detail}</div>
          </div>
        </div>
      )}

      {/* 참고 사항 */}
      <div className="bm-card bm-note-card">
        <h3 className="bm-card-title">참고 사항</h3>
        <ul className="bm-notes">
          <li>WebGL 백엔드는 GPU를 사용해 인코딩이 더 빠를 수 있지만, 메모리 사용이 더 큽니다.</li>
          <li>WASM 백엔드는 CPU 기반으로 안정적이며 모든 브라우저에서 동작합니다.</li>
          <li>디코딩(클릭 응답)은 항상 WASM 백엔드가 처리합니다 (int64 지원 문제).</li>
          <li>인코딩이 5초 이상이면 서버 사이드 SAM 추론(<code>/api/segments</code>)을 권장합니다.</li>
          <li>메모리 측정은 Chrome에서만 지원됩니다 (<code>performance.memory</code>).</li>
        </ul>
      </div>
    </div>
  );
}
