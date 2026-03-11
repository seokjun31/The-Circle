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

  // Seed materials if empty
  const { rows } = await query('SELECT COUNT(*) FROM materials');
  if (parseInt(rows[0].count) === 0) {
    await seedMaterials();
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

module.exports = { query, initDb, pool };
