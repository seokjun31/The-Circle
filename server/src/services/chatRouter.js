/**
 * chatRouter — 2-stage intent classifier for chat-based interior editing.
 *
 * Stage 1 (free): keyword matching
 *   Returns { action, target, description } or null on no match.
 *
 * Stage 2 (fallback): LLM stub
 *   Placeholder — extend with Claude Haiku / Gemini Flash call when API key is available.
 */

// ── Target surface keywords → canonical label ─────────────────────────────────
const MATERIAL_TARGETS = {
  '벽지': 'wall', '벽': 'wall', '담': 'wall',
  '바닥': 'floor', '마루': 'floor', '플로어': 'floor',
  '천장': 'ceiling',
  '문': 'door',
  '창문': 'window', '창': 'window',
  '몰딩': 'molding',
};

const MATERIAL_ACTIONS   = ['바꿔', '변경', '교체', '칠해', '깔아', '도배'];
const FURNITURE_ACTIONS  = ['넣어', '추가', '배치', '놓아', '올려', '가져다', '들여'];
const LIGHTING_WORDS     = ['밝게', '어둡게', '따뜻하게', '차갑게', '조명', '빛'];
const STYLE_WORDS        = ['느낌', '스타일', '분위기', '비슷하게'];

const LABEL_KR = {
  wall: '벽', floor: '바닥', ceiling: '천장',
  door: '문', window: '창문', molding: '몰딩', furniture: '가구',
};

// ── Stage 1: Keyword matching ─────────────────────────────────────────────────

function routeByKeywords(message) {
  const msg = message.trim();

  // Resolve target surface
  let target = null;
  for (const [kr, en] of Object.entries(MATERIAL_TARGETS)) {
    if (msg.includes(kr)) { target = en; break; }
  }

  const isMaterial  = MATERIAL_ACTIONS.some((w) => msg.includes(w));
  const isFurniture = FURNITURE_ACTIONS.some((w) => msg.includes(w));
  const isLighting  = LIGHTING_WORDS.some((w)  => msg.includes(w));
  const isStyle     = STYLE_WORDS.some((w)     => msg.includes(w));

  if (target && isMaterial) {
    return { action: 'change_material', target, description: msg };
  }
  if (isFurniture) {
    return { action: 'add_furniture', target: target || 'furniture', description: msg };
  }
  if (isLighting) {
    return { action: 'change_lighting', target: null, description: msg };
  }
  if (isStyle) {
    return { action: 'style_copy', target: null, description: msg };
  }

  return null;
}

// ── Stage 2: LLM fallback (stub) ──────────────────────────────────────────────

async function routeByLLM(message) {
  // TODO: Replace with Claude Haiku / Gemini Flash API call.
  // System prompt:
  //   "사용자의 인테리어 수정 요청을 분석해서 JSON으로 반환해.
  //    action: change_material / add_furniture / change_lighting / style_copy / unknown
  //    target: wall / floor / ceiling / door / window / furniture / null
  //    description: 영어로 변환된 구체적 설명"
  return {
    action: 'unknown',
    target: null,
    description: message,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function analyzeIntent(message) {
  const intent = routeByKeywords(message) || (await routeByLLM(message));

  const targetKr = intent.target ? (LABEL_KR[intent.target] || intent.target) : null;
  const confirmMessage = targetKr
    ? `${targetKr} 영역을 변경할까요?`
    : intent.action !== 'unknown'
    ? '이 작업을 실행할까요?'
    : '죄송해요, 요청을 이해하지 못했어요. 다시 말씀해 주세요.';

  return { ...intent, confirmMessage };
}

module.exports = { analyzeIntent };
