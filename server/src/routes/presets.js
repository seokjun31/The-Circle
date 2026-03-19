/**
 * Style Presets API
 *
 * Public:
 *   GET  /api/v1/presets               List active presets (system + user's own)
 *
 * Admin (requires x-admin-key header):
 *   POST /api/v1/presets/analyze       Claude API image analysis
 *   POST /api/v1/presets               Create preset
 *   PUT  /api/v1/presets/:id           Update preset
 *   DELETE /api/v1/presets/:id         Delete preset
 *
 * Authenticated user:
 *   POST /api/v1/presets/user          Save custom style preset
 *   GET  /api/v1/presets/user          List user's custom presets
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { query } = require('../db');

const router = express.Router();

// ── Admin middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY || 'dev-admin-key';
  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== adminKey) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── User auth middleware (lightweight — reads user_id from header) ─────────────
function getUser(req, _res, next) {
  // In production this would verify a JWT; here we read x-user-id header
  // (set by the auth middleware upstream if present).
  req.userId = req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : null;
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a local or remote image to { mediaType, base64 }.
 */
async function imageToBase64(imageUrl) {
  // Local upload path  (e.g. /uploads/abc123.jpg  or  http://localhost:4000/uploads/...)
  const uploadDir   = process.env.UPLOAD_DIR || './uploads';
  const localPrefix = '/uploads/';
  let   filePath    = null;

  if (imageUrl.startsWith(localPrefix)) {
    filePath = path.resolve(uploadDir, imageUrl.slice(localPrefix.length));
  } else {
    // Try stripping the origin for localhost URLs
    try {
      const u = new URL(imageUrl);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        if (u.pathname.startsWith(localPrefix)) {
          filePath = path.resolve(uploadDir, u.pathname.slice(localPrefix.length));
        }
      }
    } catch { /* not a valid URL */ }
  }

  if (filePath && fs.existsSync(filePath)) {
    const buf  = fs.readFileSync(filePath);
    const ext  = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png'
               : ext === 'webp' ? 'image/webp'
               : 'image/jpeg';
    return { mediaType: mime, base64: buf.toString('base64') };
  }

  // Remote URL — fetch it
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: global.fetch }));
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct  = res.headers.get('content-type') || 'image/jpeg';
  return { mediaType: ct.split(';')[0], base64: buf.toString('base64') };
}

/**
 * Call Claude Haiku to analyse an interior-style image.
 * Returns parsed JSON: { name, description, prompt, tags, ip_adapter_weight }
 */
async function analyzeWithClaude(imageUrl) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { mediaType, base64 } = await imageToBase64(imageUrl);

  const message = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `You are an expert interior designer. Analyze this interior design image and return a JSON object with EXACTLY these fields:
{
  "name": "Short English style identifier (snake_case, e.g. japandi, warm_minimal)",
  "label": "Korean display name (e.g. 재팬디, 워밍 미니멀, 모던 클래식)",
  "description": "2-3 sentences in Korean describing the mood and key characteristics of this style",
  "prompt": "English comma-separated keywords for IP-Adapter image conditioning (focus on visual style elements, lighting, materials, color palette — 10-15 keywords)",
  "tags": ["#Korean", "#hashtags", "#4to6items", "#describing", "#theStyle"],
  "ip_adapter_weight": 0.65
}

For ip_adapter_weight: use 0.4-0.5 for subtle/minimal styles, 0.6-0.7 for moderate styles, 0.75-0.85 for very distinctive/dramatic styles.
Return ONLY valid JSON. No markdown, no explanation.`,
        },
      ],
    }],
  });

  const text = message.content[0]?.text?.trim() || '';
  // Strip markdown code fences if present
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/presets  — list active system presets + caller's user presets
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', getUser, async (req, res) => {
  const userId = req.userId;

  const { rows } = await query(
    `SELECT id, name, label, description, reference_image_url,
            prompt, ip_adapter_weight, tags, display_order, is_user_preset, user_id
     FROM   style_presets
     WHERE  is_active = true
       AND  (is_user_preset = false OR user_id = $1)
     ORDER  BY is_user_preset ASC, display_order ASC, created_at ASC`,
    [userId ?? -1]
  );

  // Map to the shape StyleTransform.js expects
  const presets = rows.map((r) => ({
    id:                 r.name,               // string key used for applyCircleAI
    dbId:               r.id,
    label:              r.label,
    description:        r.description || '',
    referenceImageUrl:  r.reference_image_url,
    prompt:             r.prompt,
    ipAdapterWeight:    r.ip_adapter_weight,
    tags:               r.tags || [],
    isUserPreset:       r.is_user_preset,
    credits:            5,
  }));

  res.json(presets);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/presets/user  — list current user's saved custom presets
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user', getUser, async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Auth required' });

  const { rows } = await query(
    `SELECT id, name, label, description, reference_image_url,
            prompt, ip_adapter_weight, tags, created_at
     FROM   style_presets
     WHERE  is_active = true AND is_user_preset = true AND user_id = $1
     ORDER  BY created_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/presets/analyze  — Claude image analysis (admin)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/analyze', requireAdmin, async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    const analysis = await analyzeWithClaude(image_url);
    res.json(analysis);
  } catch (err) {
    console.error('[presets/analyze]', err);
    res.status(500).json({ error: `Analysis failed: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/presets  — create system preset (admin)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  const {
    name, label, description, reference_image_url,
    prompt, ip_adapter_weight = 0.6, tags = [], display_order = 0,
  } = req.body;

  if (!name || !label) return res.status(400).json({ error: 'name and label required' });

  const { rows } = await query(
    `INSERT INTO style_presets
       (name, label, description, reference_image_url, prompt, ip_adapter_weight, tags, display_order, is_active, is_user_preset)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, true, false)
     RETURNING *`,
    [name, label, description, reference_image_url, prompt, ip_adapter_weight, JSON.stringify(tags), display_order]
  );
  res.status(201).json(rows[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/presets/:id  — update system preset (admin)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const {
    name, label, description, reference_image_url,
    prompt, ip_adapter_weight, tags, display_order, is_active,
  } = req.body;

  const { rows } = await query(
    `UPDATE style_presets SET
       name                = COALESCE($2, name),
       label               = COALESCE($3, label),
       description         = COALESCE($4, description),
       reference_image_url = COALESCE($5, reference_image_url),
       prompt              = COALESCE($6, prompt),
       ip_adapter_weight   = COALESCE($7, ip_adapter_weight),
       tags                = COALESCE($8::jsonb, tags),
       display_order       = COALESCE($9, display_order),
       is_active           = COALESCE($10, is_active)
     WHERE id = $1
     RETURNING *`,
    [id, name, label, description, reference_image_url, prompt, ip_adapter_weight,
     tags ? JSON.stringify(tags) : null, display_order, is_active]
  );

  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/presets/:id  — delete system preset (admin)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query('DELETE FROM style_presets WHERE id = $1', [id]);
  res.json({ deleted: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/presets/user  — save user custom style
// ─────────────────────────────────────────────────────────────────────────────
router.post('/user', getUser, async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Auth required' });

  const {
    name, label, description, reference_image_url,
    prompt, ip_adapter_weight = 0.6, tags = [],
  } = req.body;

  if (!reference_image_url) return res.status(400).json({ error: 'reference_image_url required' });

  // Auto-analyze if name/label not provided and ANTHROPIC_API_KEY is set
  let finalName  = name  || `custom_${Date.now()}`;
  let finalLabel = label || '나만의 스타일';
  let finalDesc  = description || '';
  let finalPrompt = prompt || '';
  let finalWeight = ip_adapter_weight;
  let finalTags   = tags;

  if ((!name || !label) && process.env.ANTHROPIC_API_KEY) {
    try {
      const analysis = await analyzeWithClaude(reference_image_url);
      finalName   = analysis.name  || finalName;
      finalLabel  = analysis.label || finalLabel;
      finalDesc   = analysis.description || finalDesc;
      finalPrompt = analysis.prompt || finalPrompt;
      finalWeight = analysis.ip_adapter_weight || finalWeight;
      finalTags   = analysis.tags || finalTags;
    } catch (err) {
      console.warn('[presets/user] auto-analyze failed, using defaults:', err.message);
    }
  }

  const { rows } = await query(
    `INSERT INTO style_presets
       (name, label, description, reference_image_url, prompt, ip_adapter_weight, tags, display_order, is_active, is_user_preset, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 0, true, true, $8)
     RETURNING *`,
    [finalName, finalLabel, finalDesc, reference_image_url, finalPrompt, finalWeight, JSON.stringify(finalTags), req.userId]
  );

  res.status(201).json({
    ...rows[0],
    // Return in the format callers expect
    id: rows[0].name,
    dbId: rows[0].id,
  });
});

module.exports = router;
