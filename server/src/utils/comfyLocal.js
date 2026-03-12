/**
 * Local ComfyUI API client
 * Used when COMFY_LOCAL_URL is set (e.g. http://127.0.0.1:8188)
 *
 * Workflow is loaded from server/workflows/interior.json (export API format from ComfyUI).
 * Injection points (which node/field gets which dynamic value) are in interior.config.json.
 * Swap the JSON file anytime — no code changes needed.
 *
 * ComfyUI API used:
 *   POST /upload/image          → upload room photo with mask as alpha channel
 *   POST /prompt                → submit workflow, returns prompt_id
 *   GET  /history/{prompt_id}   → poll completion
 *   GET  /view?filename=...     → download result image
 */

const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.resolve(__dirname, '../../workflows/interior.json');
const CONFIG_PATH   = path.resolve(__dirname, '../../workflows/interior.config.json');

function getBase() {
  return (process.env.COMFY_LOCAL_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
}

/** Load workflow JSON fresh from disk every call (no caching = hot-swap friendly) */
function loadWorkflow() {
  return JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * Compose room photo (RGB) + mask (grayscale) → RGBA PNG
 * Alpha channel = mask: white (255) = inpaint area, black (0) = keep
 * ComfyUI LoadImage node outputs this alpha as the MASK tensor.
 */
async function buildInpaintImage(imageBase64, maskBase64) {
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const maskBuffer  = Buffer.from(maskBase64,  'base64');

  const { width, height } = await sharp(imageBuffer).metadata();

  const [rgbRaw, maskRaw] = await Promise.all([
    sharp(imageBuffer).resize(width, height).removeAlpha().raw().toBuffer(),
    sharp(maskBuffer).resize(width, height).grayscale().raw().toBuffer(),
  ]);

  // Interleave R G B A manually
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4 + 0] = rgbRaw[i * 3 + 0];
    rgba[i * 4 + 1] = rgbRaw[i * 3 + 1];
    rgba[i * 4 + 2] = rgbRaw[i * 3 + 2];
    // ComfyUI LoadImage: mask = 1.0 - (alpha/255)
    // So white mask (255) must become alpha=0 → mask=1.0 (inpaint)
    rgba[i * 4 + 3] = 255 - maskRaw[i];
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Upload a PNG buffer to ComfyUI's input directory.
 * Returns the filename as ComfyUI stored it.
 */
async function uploadToComfy(base, pngBuffer, filename) {
  const blob = new Blob([pngBuffer], { type: 'image/png' });
  const form = new FormData();
  form.append('image', blob, filename);
  form.append('type', 'input');
  form.append('overwrite', 'true');

  const { data } = await axios.post(`${base}/upload/image`, form, { timeout: 30000 });
  return data.name; // filename as stored in ComfyUI
}

/**
 * Inject dynamic values into a workflow copy based on interior.config.json.
 * Values: { input_image, positive_prompt, negative_prompt, seed }
 */
function injectValues(workflow, config, values) {
  const result = JSON.parse(JSON.stringify(workflow)); // deep copy

  for (const [key, injection] of Object.entries(config.injections)) {
    const { node, field } = injection;
    if (!result[node]) continue;

    const value = key === 'seed'
      ? Math.floor(Math.random() * 2 ** 32)
      : values[key];

    if (value !== undefined && value !== null) {
      result[node].inputs[field] = value;
    }
  }

  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compose image+mask, upload to ComfyUI, inject workflow values, submit job.
 * Returns { id: promptId }
 */
async function submitJob({ imageBase64, maskBase64, prompt, negativePrompt }) {
  const base = getBase();

  // 1. Combine image + mask → RGBA PNG → upload
  const rgbaPng = await buildInpaintImage(imageBase64, maskBase64);
  const uploadedFilename = await uploadToComfy(base, rgbaPng, `inpaint_${Date.now()}.png`);

  // 2. Load workflow + config, inject values
  const workflow = loadWorkflow();
  const config   = loadConfig();
  const injected = injectValues(workflow, config, {
    input_image:     uploadedFilename,
    positive_prompt: prompt,
    negative_prompt: negativePrompt,
  });

  // 3. Submit
  const { data } = await axios.post(
    `${base}/prompt`,
    { prompt: injected },
    { timeout: 30000 }
  );

  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(`ComfyUI node errors: ${JSON.stringify(data.node_errors)}`);
  }

  return { id: data.prompt_id };
}

/**
 * Poll job status. Returns RunPod-compatible shape:
 *   { status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED', output?, error? }
 */
async function getStatus(promptId) {
  const base = getBase();

  const [historyRes, queueRes] = await Promise.all([
    axios.get(`${base}/history/${promptId}`, { timeout: 15000 }),
    axios.get(`${base}/queue`,               { timeout: 15000 }),
  ]);

  const historyEntry = historyRes.data[promptId];

  if (!historyEntry) {
    const isRunning = (queueRes.data.queue_running || []).some((item) => item[1] === promptId);
    return { status: isRunning ? 'IN_PROGRESS' : 'IN_QUEUE' };
  }

  const statusStr = historyEntry.status?.status_str;

  if (statusStr === 'error') {
    const msgs = (historyEntry.status?.messages || [])
      .filter(([type]) => type === 'execution_error')
      .map(([, msg]) => msg?.exception_message || JSON.stringify(msg));
    return { status: 'FAILED', error: msgs.join('; ') || '알 수 없는 오류' };
  }

  if (statusStr !== 'success') {
    return { status: 'IN_PROGRESS' };
  }

  // Find image output from any SaveImage node
  const outputs = historyEntry.outputs || {};
  let imageFilename = null;
  let imageSubfolder = '';

  for (const nodeOutput of Object.values(outputs)) {
    const images = nodeOutput.images;
    if (Array.isArray(images) && images.length > 0) {
      imageFilename  = images[0].filename;
      imageSubfolder = images[0].subfolder || '';
      break;
    }
  }

  if (!imageFilename) {
    return { status: 'FAILED', error: '결과 이미지를 찾을 수 없습니다.' };
  }

  // Download result image → base64
  const viewUrl = `${base}/view?filename=${encodeURIComponent(imageFilename)}&subfolder=${encodeURIComponent(imageSubfolder)}&type=output`;
  const imgRes  = await axios.get(viewUrl, { responseType: 'arraybuffer', timeout: 60000 });
  const imageBase64 = Buffer.from(imgRes.data).toString('base64');

  return { status: 'COMPLETED', output: { image: imageBase64 } };
}

module.exports = { submitJob, getStatus };
