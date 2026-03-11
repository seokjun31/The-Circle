-- =============================================================
-- AI Interior Rendering Service — PostgreSQL Schema
-- =============================================================

-- Users
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE,
  name       VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Materials catalog
CREATE TABLE IF NOT EXISTS materials (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  category    VARCHAR(100) NOT NULL,  -- '바닥재' | '벽지' | '타일' | '가구'
  image_url   TEXT,
  description TEXT,
  tags        TEXT[],
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Orders (one per rendering session)
CREATE TABLE IF NOT EXISTS orders (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  image_id     VARCHAR(255) NOT NULL,
  image_url    TEXT NOT NULL,
  mood         VARCHAR(100) NOT NULL,  -- 'modern' | 'natural' | 'luxury' | ...
  material_ids INTEGER[],
  job_id       VARCHAR(255),           -- RunPod job ID
  status       VARCHAR(50) DEFAULT 'pending',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Render results
CREATE TABLE IF NOT EXISTS render_results (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  job_id          VARCHAR(255) NOT NULL UNIQUE,
  status          VARCHAR(50) DEFAULT 'IN_QUEUE',
  result_url      TEXT,
  error           TEXT,
  progress        INTEGER DEFAULT 0,
  runpod_response JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_render_results_job_id ON render_results(job_id);
CREATE INDEX IF NOT EXISTS idx_orders_job_id         ON orders(job_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id        ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_materials_category    ON materials(category);
