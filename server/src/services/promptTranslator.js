/**
 * promptTranslator — Korean interior description → English ComfyUI prompt.
 *
 * Rule-based for common terms; complex/unknown descriptions are passed through
 * with target context appended.
 */

const MATERIAL_MAP = {
  '검은색': 'black matte',      '흰색': 'white clean bright',
  '회색': 'gray neutral',       '베이지': 'beige warm sand',
  '갈색': 'brown warm',         '파란색': 'blue',
  '초록색': 'green',            '노란색': 'yellow warm',
  '대리석': 'polished marble, veined stone texture, luxury',
  '원목': 'natural wood oak, warm grain texture, solid wood',
  '타일': 'ceramic tile, clean geometric pattern',
  '콘크리트': 'exposed concrete, raw industrial texture',
  '벽돌': 'exposed brick, rustic texture',
  '나무': 'wood natural grain',
  '페인트': 'painted smooth matte surface',
  '유리': 'glass transparent glossy',
  '패브릭': 'fabric textile soft',
  '가죽': 'leather premium texture',
  '금속': 'metal brushed finish',
  '스틸': 'steel brushed metallic',
  '골드': 'gold accent luxury',
  '무광': 'matte finish',
  '유광': 'glossy sheen',
  '패턴': 'decorative pattern',
  '스트라이프': 'stripe pattern',
  '체크': 'check pattern',
  '헤링본': 'herringbone pattern',
};

const LIGHTING_MAP = {
  '밝게': 'bright well-lit, high key lighting',
  '어둡게': 'dim moody lighting, low key',
  '따뜻하게': 'warm golden hour lighting, cozy amber tones',
  '차갑게': 'cool daylight, blue-white tones',
  '아늑하게': 'warm cozy ambient lighting',
  '모던하게': 'modern architectural lighting',
};

const TARGET_CONTEXT = {
  wall:      'interior wall surface',
  floor:     'interior floor material',
  ceiling:   'interior ceiling surface',
  door:      'interior door panel',
  window:    'interior window frame',
  molding:   'interior crown molding trim',
  furniture: 'interior furniture piece',
};

const QUALITY_SUFFIX =
  'photorealistic interior render, professional photography, 8k, sharp focus, perfect lighting';

function translateToPrompt(description, target) {
  let translated = description;

  // Apply material/color translations
  for (const [kr, en] of Object.entries(MATERIAL_MAP)) {
    translated = translated.replace(new RegExp(kr, 'g'), en);
  }

  // Apply lighting translations
  for (const [kr, en] of Object.entries(LIGHTING_MAP)) {
    translated = translated.replace(new RegExp(kr, 'g'), en);
  }

  // Remove remaining Korean characters (pass-through stripped)
  translated = translated.replace(/[가-힣]+/g, '').replace(/\s+/g, ' ').trim();

  const context = TARGET_CONTEXT[target] || 'interior element';
  return [translated, context, QUALITY_SUFFIX].filter(Boolean).join(', ');
}

module.exports = { translateToPrompt };
