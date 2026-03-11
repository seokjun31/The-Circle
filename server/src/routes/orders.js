const express = require('express');
const { query } = require('../db');

const router = express.Router();

// POST /api/orders — Create order
router.post('/', async (req, res) => {
  const { imageId, imageUrl, mood, materialIds = [], jobId } = req.body;

  if (!imageId || !mood) {
    return res.status(400).json({ error: 'imageId와 mood는 필수입니다.' });
  }

  const { rows } = await query(
    `INSERT INTO orders (image_id, image_url, mood, material_ids, job_id, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [imageId, imageUrl || '', mood, materialIds, jobId || null]
  );

  res.status(201).json({ orderId: rows[0].id });
});

// GET /api/orders — List orders
router.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT 50'
  );
  res.json(rows);
});

// GET /api/orders/:id — Single order
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT o.*, rr.status as render_status, rr.result_url, rr.progress
     FROM orders o
     LEFT JOIN render_results rr ON rr.job_id = o.job_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
  }
  res.json(rows[0]);
});

module.exports = router;
