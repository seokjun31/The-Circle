/**
 * Converts Korean interior selection to English AI prompt
 */

const MOOD_PROMPTS = {
  modern: 'modern minimalist interior design, clean lines, neutral tones, contemporary furniture, high-end materials',
  natural: 'natural warm interior, wood textures, earthy tones, organic materials, scandinavian influence, cozy atmosphere',
  luxury: 'luxury high-end interior design, marble surfaces, gold accents, opulent furniture, sophisticated lighting, premium materials',
  nordic: 'nordic scandinavian interior, white walls, light wood, functional minimalism, hygge atmosphere, simple elegant design',
  industrial: 'industrial loft interior, exposed concrete, metal fixtures, dark tones, brick walls, urban aesthetic',
  classic: 'classic european interior design, ornate details, rich wood paneling, traditional furniture, elegant drapes, timeless style',
};

const MATERIAL_PROMPTS = {
  바닥재: 'with specified flooring material',
  벽지: 'with specified wall covering',
  타일: 'with specified tile patterns',
  가구: 'furnished with specified furniture pieces',
};

/**
 * Build full AI prompt from user selections
 * @param {string} mood - selected mood id
 * @param {Array} materials - selected material objects
 * @returns {string} - English prompt for Stable Diffusion
 */
function buildPrompt(mood, materials = []) {
  const moodDesc = MOOD_PROMPTS[mood] || MOOD_PROMPTS.modern;

  let materialDesc = '';
  if (materials.length > 0) {
    const matNames = materials.map((m) => m.name).join(', ');
    materialDesc = `, incorporating ${matNames}`;
  }

  const prompt = [
    `photorealistic interior render of a Korean apartment room`,
    moodDesc,
    materialDesc,
    `professional interior photography, 8k resolution, perfect lighting, architectural visualization`,
    `ultra detailed, sharp focus, cinematic composition`,
  ]
    .filter(Boolean)
    .join(', ');

  return prompt;
}

/**
 * Build negative prompt
 */
function buildNegativePrompt() {
  return [
    'people, persons, humans, furniture clutter',
    'low quality, blurry, artifacts, distorted',
    'cartoon, anime, illustration, painting',
    'oversaturated, unrealistic colors',
    'text, watermark, logo',
  ].join(', ');
}

module.exports = { buildPrompt, buildNegativePrompt };
