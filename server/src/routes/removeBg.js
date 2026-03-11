const express = require('express');
const path = require('path');
const fs = require('fs');
const { runSync } = require('../utils/runpod');

const router = express.Router();

// POST /api/remove-bg
// Body: { imageId: string }
router.post('/', async (req, res) => {
  const { imageId } = req.body;

  if (!imageId) {
    return res.status(400).json({ error: 'imageId가 필요합니다.' });
  }

  // Load image as base64
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  const files = fs.readdirSync(uploadDir).filter((f) => f.startsWith(imageId));

  if (files.length === 0) {
    return res.status(404).json({ error: '이미지를 찾을 수 없습니다.' });
  }

  const imagePath = path.join(uploadDir, files[0]);
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');

  // Call rembg RunPod endpoint
  const endpointId = process.env.RUNPOD_REMBG_ENDPOINT_ID;
  if (!endpointId) {
    return res.status(500).json({ error: 'RUNPOD_REMBG_ENDPOINT_ID 환경변수가 설정되지 않았습니다.' });
  }

  const result = await runSync(endpointId, { image: imageBase64 });

  if (result.status === 'FAILED' || result.error) {
    return res.status(502).json({ error: '배경 제거 처리 중 오류가 발생했습니다.' });
  }

  const maskBase64 = result.output?.image || result.output;

  res.json({ maskBase64 });
});

module.exports = router;
