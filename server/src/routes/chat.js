/**
 * Chat API — intent analysis for chat-based interior editing.
 *
 * POST /api/v1/chat/analyze
 *   Body: { message: string, projectId: number }
 *   Returns: { action, target, description, prompt, confirmMessage }
 *
 * Execution (apply-material, place-furniture, etc.) uses existing
 * project endpoints — the frontend calls those directly after user confirmation.
 */

const express = require('express');
const { analyzeIntent } = require('../services/chatRouter');
const { translateToPrompt } = require('../services/promptTranslator');

const router = express.Router();

// POST /api/v1/chat/analyze
router.post('/analyze', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message 필드가 필요합니다.' });
  }

  const intent = await analyzeIntent(message.trim());
  const prompt = intent.action !== 'unknown'
    ? translateToPrompt(intent.description, intent.target)
    : null;

  res.json({ ...intent, prompt });
});

module.exports = router;
