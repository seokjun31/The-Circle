const express = require('express');
const { query } = require('../db');

const router = express.Router();

// GET /api/materials — List all materials, optional ?category= filter
router.get('/', async (req, res) => {
  const { category } = req.query;

  let sql = 'SELECT * FROM materials ORDER BY category, name';
  const params = [];

  if (category) {
    sql = 'SELECT * FROM materials WHERE category = $1 ORDER BY name';
    params.push(category);
  }

  const { rows } = await query(sql, params);
  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    imageUrl: r.image_url,
    description: r.description,
    tags: r.tags,
  })));
});

// GET /api/materials/:id — Single material
router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM materials WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: '자재를 찾을 수 없습니다.' });
  }
  const r = rows[0];
  res.json({
    id: r.id,
    name: r.name,
    category: r.category,
    imageUrl: r.image_url,
    description: r.description,
    tags: r.tags,
  });
});

module.exports = router;
