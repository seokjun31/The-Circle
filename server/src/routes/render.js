const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { runAsync, getStatus } = require('../utils/runpod');
const { buildPrompt, buildNegativePrompt } = require('../utils/promptBuilder');
const { buildWorkflow } = require('../utils/comfyWorkflow');
const { query } = require('../db');

const router = express.Router();

// POST /api/render — Start rendering
router.post('/', async (req, res) => {
  const { imageId, maskBase64, mood, materialIds = [], materialImage } = req.body;

  if (!imageId || !maskBase64 || !mood) {
    return res.status(400).json({ error: 'imageId, maskBase64, mood 필드가 필요합니다.' });
  }

  // Load original image as base64
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  const files = fs.readdirSync(uploadDir).filter((f) => f.startsWith(imageId));

  if (files.length === 0) {
    return res.status(404).json({ error: '원본 이미지를 찾을 수 없습니다.' });
  }

  const imagePath = path.join(uploadDir, files[0]);
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');

  // Fetch material data if IDs provided
  let materials = [];
  if (materialIds.length > 0) {
    const { rows } = await query(
      'SELECT * FROM materials WHERE id = ANY($1)',
      [materialIds]
    );
    materials = rows;
  }

  // Build prompt
  const prompt = buildPrompt(mood, materials);
  const negativePrompt = buildNegativePrompt();

  // Assemble ComfyUI workflow
  const workflow = buildWorkflow({
    imageBase64,
    maskBase64,
    prompt,
    negativePrompt,
    materialImageBase64: materialImage || null,
  });

  // Submit to RunPod
  const endpointId = process.env.RUNPOD_COMFYUI_ENDPOINT_ID;
  if (!endpointId) {
    return res.status(500).json({ error: 'RUNPOD_COMFYUI_ENDPOINT_ID 환경변수가 설정되지 않았습니다.' });
  }

  const runpodRes = await runAsync(endpointId, {
    workflow,
    prompt,
    negative_prompt: negativePrompt,
  });

  const jobId = runpodRes.id;

  // Store in DB
  await query(
    `INSERT INTO render_results (job_id, status) VALUES ($1, 'IN_QUEUE') ON CONFLICT (job_id) DO NOTHING`,
    [jobId]
  );

  res.json({ jobId });
});

// GET /api/render/:jobId — Poll status
router.get('/:jobId', async (req, res) => {
  const { jobId } = req.params;

  // Check DB cache first
  const { rows } = await query(
    'SELECT * FROM render_results WHERE job_id = $1',
    [jobId]
  );

  const cached = rows[0];

  // If completed/failed, return from DB
  if (cached && ['COMPLETED', 'FAILED'].includes(cached.status)) {
    return res.json({
      status: cached.status,
      resultUrl: cached.result_url,
      error: cached.error,
      progress: cached.progress,
    });
  }

  // Poll RunPod
  const endpointId = process.env.RUNPOD_COMFYUI_ENDPOINT_ID;
  const runpodData = await getStatus(endpointId, jobId);

  const status = runpodData.status; // IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED
  let resultUrl = null;
  let errorMsg = null;
  let progress = 0;

  if (status === 'COMPLETED') {
    const output = runpodData.output;
    // Output can be { image: "base64" } or { images: [...] }
    const base64 =
      output?.image ||
      (Array.isArray(output?.images) ? output.images[0] : null);

    if (base64) {
      // Save result image to uploads
      const filename = `result_${jobId}.png`;
      const filePath = path.join(path.resolve(process.env.UPLOAD_DIR || './uploads'), filename);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      resultUrl = `/uploads/${filename}`;
    }
    progress = 100;
  } else if (status === 'IN_PROGRESS') {
    progress = runpodData.progress || 50;
  } else if (status === 'FAILED') {
    errorMsg = runpodData.error || '렌더링 실패';
  }

  // Update DB
  await query(
    `INSERT INTO render_results (job_id, status, result_url, error, progress, runpod_response, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (job_id)
     DO UPDATE SET status=$2, result_url=$3, error=$4, progress=$5, runpod_response=$6, updated_at=NOW()`,
    [jobId, status, resultUrl, errorMsg, progress, JSON.stringify(runpodData)]
  );

  res.json({ status, resultUrl, error: errorMsg, progress });
});

module.exports = router;
