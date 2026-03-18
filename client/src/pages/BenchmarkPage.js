/**
 * SAM Transformers.js 성능 벤치마크 페이지
 *
 * 측정 항목:
 *   - 모델 로딩 시간 (IndexedDB 캐시 여부 포함)
 *   - 이미지 인코딩 시간 (SlimSAM-77 vision encoder)
 *   - 클릭당 디코딩 시간 (10회 평균)
 *   - JS Heap 메모리 (performance.memory 지원 시)
 *
 * 이전의 ONNX Runtime Web 직접 사용 방식에서
 * @xenova/transformers (samSegmenter) 기반으로 업데이트됨.
 */

import React, { useState, useRef, useCallback } from 'react';
import { samSegmenter } from '../lib/sam/SamModel';
import './BenchmarkPage.css';

// ── 합성 테스트 이미지 생성 ────────────────────────────────────────────────────
const TEST_CONFIGS = [
  { label: '소형 (512×384)',   width: 512,  height: 384  },
  { label: '중형 (1024×768)',  width: 1024, height: 768  },
  { label: '대형 (1920×1080)', width: 1920, height: 1080 },
];

function makeSyntheticCanvas(width, height) {
  const canvas  = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0,   '#f0ebe0');
  grad.addColorStop(0.5, '#d4c9b0');
  grad.addColorStop(1,   '#b8a890');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

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
  if (window.performance?.memory) {
    return (window.performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
  }
  return null;
}

const IDLE = 'idle', RUNNING = 'running', DONE = 'done', ERROR = 'error';

// ── 결과 행 컴포넌트 ──────────────────────────────────────────────────────────
function ResultRow({ label, value, unit = 'ms' }) {
  return (
    <tr>
      <td className="bm-label">{label}</td>
      <td className="bm-val">{value != null ? `${value} ${unit}` : '—'}</td>
    </tr>
  );
}

function LogLine({ entry }) {
  const cls = entry.type === 'error' ? 'bm-log-error'
    : entry.type === 'ok'   ? 'bm-log-ok'
    : entry.type === 'warn' ? 'bm-log-warn'
    : 'bm-log-info';
  return <div className={`bm-log-line ${cls}`}>{entry.text}</div>;
}

// ══════════════════════════════════════════════════════════════════════════════
export default function BenchmarkPage() {
  const [phase,   setPhase]   = useState(IDLE);
  const [log,     setLog]     = useState([]);
  const [results, setResults] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const abortRef = useRef(false);

  const addLog = useCallback((text, type = 'info') => {
    setLog(prev => [...prev, { text, type, id: Date.now() + Math.random() }]);
  }, []);

  // ── 전체 벤치마크 실행 ──────────────────────────────────────────────────────
  const runBenchmark = useCallback(async () => {
    abortRef.current = false;
    setPhase(RUNNING);
    setLog([]);
    setResults(null);
    setVerdict(null);

    addLog('SAM Transformers.js 벤치마크 시작', 'info');
    addLog(`모델: Xenova/slimsam-77-uniform (SlimSAM-77)`);
    addLog(`브라우저: ${navigator.userAgent.split(') ')[0].split('(')[1] || '알 수 없음'}`);
    const heap = heapMB();
    if (heap) addLog(`현재 JS Heap: ${heap} MB`);
    else      addLog('performance.memory 미지원 (Chrome 전용)', 'warn');

    const r = {};

    try {
      // ── 모델 로딩 ──────────────────────────────────────────────────────────
      addLog('\n── 모델 로딩 (IndexedDB 캐시 or HuggingFace Hub) ──');
      const memBefore = heapMB();
      const t0 = performance.now();

      await samSegmenter.load();
      r.loadMs  = Math.round(performance.now() - t0);
      const memAfter = heapMB();
      r.memMB   = memBefore && memAfter
        ? (parseFloat(memAfter) - parseFloat(memBefore)).toFixed(1)
        : null;

      addLog(`모델 로드: ${r.loadMs}ms${r.memMB ? `, 메모리 +${r.memMB}MB` : ''}`, 'ok');

      // ── 이미지별 인코딩 + 디코딩 ────────────────────────────────────────────
      r.imageResults = [];

      for (const cfg of TEST_CONFIGS) {
        if (abortRef.current) break;
        addLog(`\n── 테스트: ${cfg.label} ──`);

        const canvas = makeSyntheticCanvas(cfg.width, cfg.height);

        // 인코딩 시간
        addLog(`인코딩 중...`);
        const tEnc0 = performance.now();
        try {
          await samSegmenter.encodeImage(canvas);
        } catch (e) {
          addLog(`인코딩 실패 (${cfg.label}): ${e.message}`, 'error');
          r.imageResults.push({ ...cfg, encodeMs: null, decodeAvgMs: null });
          continue;
        }
        const encodeMs = Math.round(performance.now() - tEnc0);
        addLog(`인코딩: ${encodeMs}ms`, 'ok');

        // 디코딩 10회 평균
        const DECODE_RUNS = 10;
        const decodeTimes = [];
        const testPoints = [
          { x: cfg.width * 0.3, y: cfg.height * 0.5 },
          { x: cfg.width * 0.5, y: cfg.height * 0.3 },
          { x: cfg.width * 0.7, y: cfg.height * 0.6 },
        ];

        for (let i = 0; i < DECODE_RUNS; i++) {
          if (abortRef.current) break;
          const pt = testPoints[i % testPoints.length];
          const tDec0 = performance.now();
          try {
            const { pred_masks, iou_scores } = await samSegmenter.decode([pt], [1]);
            await samSegmenter.postProcess(pred_masks, iou_scores);
          } catch (e) {
            addLog(`디코딩 실패: ${e.message}`, 'warn');
            break;
          }
          decodeTimes.push(performance.now() - tDec0);
        }

        const decodeAvgMs = decodeTimes.length > 0
          ? Math.round(decodeTimes.reduce((a, b) => a + b, 0) / decodeTimes.length)
          : null;

        addLog(`디코딩 평균(${DECODE_RUNS}회): ${decodeAvgMs}ms`, 'ok');
        r.imageResults.push({ ...cfg, encodeMs, decodeAvgMs });

        // Clear image between tests
        samSegmenter.clearImage();
      }

      setResults(r);
      const v = computeVerdict(r);
      setVerdict(v);
      addLog(`\n판정: ${v.summary}`, v.ok ? 'ok' : 'warn');
      setPhase(DONE);

    } catch (e) {
      if (!abortRef.current) addLog(`오류: ${e.message}`, 'error');
      setPhase(ERROR);
    }
  }, [addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopBenchmark = () => {
    abortRef.current = true;
    setPhase(IDLE);
  };

  function computeVerdict(r) {
    const enc0 = r.imageResults?.[0]?.encodeMs  ?? Infinity;
    const dec0 = r.imageResults?.[0]?.decodeAvgMs ?? Infinity;

    if (enc0 < 3000 && dec0 < 200) {
      return { ok: true, icon: '✅', summary: '이 기기에서 SAM이 원활하게 동작합니다',
        detail: `인코딩 ${enc0}ms, 디코딩 ${dec0}ms`, color: '#22c55e' };
    } else if (enc0 < 10000) {
      return { ok: true, icon: '⚠️', summary: '동작하지만 느릴 수 있습니다',
        detail: `인코딩 ${enc0}ms, 디코딩 ${dec0}ms — 서버 fallback도 고려해보세요`, color: '#f59e0b' };
    } else {
      return { ok: false, icon: '🖥️', summary: '서버 모드를 권장합니다',
        detail: `인코딩 ${enc0}ms — 브라우저에서 SAM이 너무 느립니다`, color: '#ef4444' };
    }
  }

  // ── 렌더 ────────────────────────────────────────────────────────────────────
  return (
    <div className="bm-page">
      <div className="bm-header">
        <h1 className="bm-title">SAM Transformers.js 성능 벤치마크</h1>
        <p className="bm-subtitle">
          SlimSAM-77 (Xenova/slimsam-77-uniform) 브라우저 추론 속도 측정
        </p>
      </div>

      <div className="bm-card">
        <h2 className="bm-card-title">테스트 설정</h2>
        <div className="bm-config-grid">
          <div className="bm-config-item">
            <span className="bm-config-label">모델</span>
            <span className="bm-config-value">Xenova/slimsam-77-uniform (SlimSAM-77, ~77 MB)</span>
          </div>
          <div className="bm-config-item">
            <span className="bm-config-label">테스트 이미지</span>
            <span className="bm-config-value">{TEST_CONFIGS.map(c => c.label).join(', ')} (합성)</span>
          </div>
          <div className="bm-config-item">
            <span className="bm-config-label">디코딩 반복</span>
            <span className="bm-config-value">각 이미지 10회 평균</span>
          </div>
          <div className="bm-config-item">
            <span className="bm-config-label">백엔드</span>
            <span className="bm-config-value">WebGPU → WebGL → WASM 자동 선택</span>
          </div>
        </div>

        <div className="bm-actions">
          {phase === RUNNING ? (
            <button className="bm-btn bm-btn-stop" onClick={stopBenchmark}>중단</button>
          ) : (
            <button
              className="bm-btn bm-btn-start"
              onClick={runBenchmark}
              disabled={phase === RUNNING}
            >
              {phase === DONE ? '다시 실행' : '벤치마크 시작'}
            </button>
          )}
          {phase === RUNNING && <span className="bm-running-badge">측정 중...</span>}
        </div>
      </div>

      {log.length > 0 && (
        <div className="bm-card">
          <h2 className="bm-card-title">진행 로그</h2>
          <div className="bm-log-box">
            {log.map(entry => <LogLine key={entry.id} entry={entry} />)}
          </div>
        </div>
      )}

      {results && (
        <div className="bm-card">
          <h2 className="bm-card-title">결과</h2>
          <table className="bm-table">
            <thead>
              <tr>
                <th className="bm-th-label">측정 항목</th>
                <th className="bm-th-val">결과</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bm-section-row"><td colSpan={2}>모델 로딩</td></tr>
              <ResultRow label="전체 로딩 시간" value={results.loadMs} unit="ms" />
              <ResultRow label="메모리 증가"    value={results.memMB}  unit="MB" />

              {(results.imageResults ?? []).map((ir, idx) => (
                <React.Fragment key={ir.label}>
                  <tr className="bm-section-row"><td colSpan={2}>{ir.label}</td></tr>
                  <ResultRow label="인코딩 시간"       value={ir.encodeMs}    unit="ms" />
                  <ResultRow label="디코딩 평균 (10회)" value={ir.decodeAvgMs} unit="ms" />
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {verdict && (
        <div className="bm-card bm-verdict-card" style={{ borderColor: verdict.color }}>
          <div className="bm-verdict-icon">{verdict.icon}</div>
          <div className="bm-verdict-content">
            <div className="bm-verdict-summary" style={{ color: verdict.color }}>{verdict.summary}</div>
            <div className="bm-verdict-detail">{verdict.detail}</div>
          </div>
        </div>
      )}

      <div className="bm-card bm-note-card">
        <h3 className="bm-card-title">참고 사항</h3>
        <ul className="bm-notes">
          <li>모델 첫 로딩은 HuggingFace Hub에서 다운로드 (~77 MB). 이후 IndexedDB에서 즉시 로드.</li>
          <li>백엔드는 WebGPU → WebGL → WASM 순으로 자동 선택됩니다.</li>
          <li>인코딩 10초 초과 시 서버 fallback (<code>/api/v1/segment/encode</code>) 이 동작합니다.</li>
          <li>메모리 측정은 Chrome 전용입니다 (<code>performance.memory</code>).</li>
        </ul>
      </div>
    </div>
  );
}
