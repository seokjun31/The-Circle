const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false,
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE,
      name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      image_url TEXT,
      description TEXT,
      tags TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      image_id VARCHAR(255) NOT NULL,
      image_url TEXT NOT NULL,
      mood VARCHAR(100) NOT NULL,
      material_ids INTEGER[],
      job_id VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS render_results (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      job_id VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(50) DEFAULT 'IN_QUEUE',
      result_url TEXT,
      error TEXT,
      progress INTEGER DEFAULT 0,
      runpod_response JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_render_results_job_id ON render_results(job_id)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_orders_job_id ON orders(job_id)
  `);

  // ── Style presets ────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS style_presets (
      id                  SERIAL PRIMARY KEY,
      name                VARCHAR(100) NOT NULL,
      label               VARCHAR(100) NOT NULL,
      description         TEXT,
      reference_image_url TEXT,
      prompt              TEXT,
      ip_adapter_weight   FLOAT DEFAULT 0.6,
      tags                JSONB DEFAULT '[]',
      display_order       INT DEFAULT 0,
      is_active           BOOLEAN DEFAULT true,
      is_user_preset      BOOLEAN DEFAULT false,
      user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_style_presets_active ON style_presets(is_active, display_order)`);

  // Seed materials if empty
  const { rows } = await query('SELECT COUNT(*) FROM materials');
  if (parseInt(rows[0].count) === 0) {
    await seedMaterials();
  }

  // Seed default system presets if empty
  const { rows: presetRows } = await query('SELECT COUNT(*) FROM style_presets WHERE is_user_preset = false');
  if (parseInt(presetRows[0].count) === 0) {
    await seedPresets();
  }

  console.log('✅ Database initialized');
}

async function seedMaterials() {
  const materials = [
    { name: 'LVT 우드 베이지', category: '바닥재', description: '따뜻한 베이지톤 우드 패턴 LVT 바닥재', tags: ['우드', '베이지', '모던'] },
    { name: 'LVT 그레이 스톤', category: '바닥재', description: '고급스러운 그레이 스톤 패턴 LVT', tags: ['스톤', '그레이', '럭셔리'] },
    { name: 'LVT 다크 월넛', category: '바닥재', description: '짙은 월넛 컬러의 LVT 바닥재', tags: ['우드', '다크', '모던'] },
    { name: '헤링본 오크', category: '바닥재', description: '클래식 헤링본 패턴의 오크 우드', tags: ['우드', '헤링본', '클래식'] },
    { name: '화이트 플레인 벽지', category: '벽지', description: '깔끔한 화이트 무지 벽지', tags: ['화이트', '미니멀', '모던'] },
    { name: '라이트 그레이 벽지', category: '벽지', description: '은은한 라이트 그레이 벽지', tags: ['그레이', '모던', '심플'] },
    { name: '내추럴 린넨 벽지', category: '벽지', description: '천연 린넨 텍스처 벽지', tags: ['린넨', '내추럴', '따뜻함'] },
    { name: '마블 패턴 벽지', category: '벽지', description: '럭셔리 마블 패턴 포인트 벽지', tags: ['마블', '럭셔리', '포인트'] },
    { name: '포세린 화이트 타일', category: '타일', description: '욕실/주방용 화이트 포세린 타일', tags: ['화이트', '포세린', '욕실'] },
    { name: '헥사곤 모자이크 타일', category: '타일', description: '트렌디한 헥사곤 모자이크 타일', tags: ['모자이크', '헥사곤', '트렌디'] },
    { name: '테라코타 타일', category: '타일', description: '따뜻한 테라코타 색상의 세라믹 타일', tags: ['테라코타', '내추럴', '따뜻함'] },
    { name: '소파 (패브릭 그레이)', category: '가구', description: '스칸디나비아 스타일 패브릭 소파', tags: ['소파', '그레이', '노르딕'] },
    { name: '다이닝 테이블 (오크)', category: '가구', description: '오크 우드 원형 다이닝 테이블', tags: ['테이블', '오크', '내추럴'] },
  ];

  for (const m of materials) {
    await query(
      'INSERT INTO materials (name, category, description, tags) VALUES ($1, $2, $3, $4)',
      [m.name, m.category, m.description, m.tags]
    );
  }
  console.log('✅ Seed materials inserted');
}

async function seedPresets() {
  const presets = [
    {
      name: 'modern', label: '모던', display_order: 0,
      description: '깔끔하고 세련된 현대적 스타일. 직선과 중성 색조, 미니멀한 장식이 특징입니다.',
      prompt: 'modern interior design, clean lines, neutral tones, minimalist decor, contemporary furniture, white walls',
      ip_adapter_weight: 0.6,
      tags: JSON.stringify(['#모던', '#미니멀', '#중성색', '#심플']),
    },
    {
      name: 'scandinavian', label: '스칸디나비안', display_order: 1,
      description: '북유럽의 따뜻하고 기능적인 인테리어. 자연 소재와 밝은 색감이 편안함을 만듭니다.',
      prompt: 'scandinavian interior, light wood furniture, white walls, cozy textiles, natural light, hygge',
      ip_adapter_weight: 0.65,
      tags: JSON.stringify(['#스칸디', '#북유럽', '#우드', '#따뜻함']),
    },
    {
      name: 'japanese', label: '재팬디', display_order: 2,
      description: '일본 미니멀리즘과 북유럽 감성의 조화. 자연 소재와 절제된 아름다움이 공존합니다.',
      prompt: 'japandi interior, wabi-sabi, warm wood tones, natural materials, minimal decor, zen atmosphere, neutral palette',
      ip_adapter_weight: 0.7,
      tags: JSON.stringify(['#재팬디', '#미니멀', '#우드톤', '#젠']),
    },
    {
      name: 'industrial', label: '인더스트리얼', display_order: 3,
      description: '공장 미학에서 영감을 받은 스타일. 노출 콘크리트, 금속, 거친 텍스처가 매력적입니다.',
      prompt: 'industrial interior design, exposed brick, concrete walls, metal fixtures, dark tones, Edison bulbs, raw materials',
      ip_adapter_weight: 0.75,
      tags: JSON.stringify(['#인더스트리얼', '#노출콘크리트', '#메탈', '#어두운']),
    },
    {
      name: 'korean_modern', label: '한국 모던', display_order: 4,
      description: '한국 아파트에 최적화된 현대적 스타일. 실용성과 미적 감각을 동시에 추구합니다.',
      prompt: 'korean modern apartment interior, warm beige tones, clean design, comfortable living, soft lighting, contemporary korean style',
      ip_adapter_weight: 0.6,
      tags: JSON.stringify(['#한국모던', '#아파트', '#베이지', '#따뜻함']),
    },
    {
      name: 'classic', label: '클래식', display_order: 5,
      description: '고전적인 우아함과 품격. 풍부한 색감, 장식적인 디테일, 고급 소재가 어우러집니다.',
      prompt: 'classic elegant interior, rich colors, ornate details, luxury furniture, crown molding, traditional decor, warm lighting',
      ip_adapter_weight: 0.7,
      tags: JSON.stringify(['#클래식', '#우아함', '#럭셔리', '#전통']),
    },
    {
      name: 'coastal', label: '코스탈', display_order: 6,
      description: '해변의 자유로운 분위기. 밝고 시원한 색감과 자연 소재가 휴양지 느낌을 줍니다.',
      prompt: 'coastal beach house interior, light blue and white tones, natural textures, rattan furniture, airy and bright, ocean inspired',
      ip_adapter_weight: 0.65,
      tags: JSON.stringify(['#코스탈', '#해변', '#밝은', '#자연']),
    },
    {
      name: 'art_deco', label: '아르데코', display_order: 7,
      description: '1920년대 화려함과 기하학적 패턴의 조화. 금장 포인트와 대담한 컬러가 특징입니다.',
      prompt: 'art deco interior, geometric patterns, gold accents, bold colors, luxurious materials, dramatic lighting, 1920s glamour',
      ip_adapter_weight: 0.75,
      tags: JSON.stringify(['#아르데코', '#기하학', '#골드', '#글램']),
    },
  ];

  for (const p of presets) {
    await query(
      `INSERT INTO style_presets (name, label, description, prompt, ip_adapter_weight, tags, display_order, is_active, is_user_preset)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, true, false)`,
      [p.name, p.label, p.description, p.prompt, p.ip_adapter_weight, p.tags, p.display_order]
    );
  }
  console.log('✅ Seed style presets inserted');
}

module.exports = { query, initDb, pool };
