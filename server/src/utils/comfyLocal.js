/**
 * Local ComfyUI API client
 * Used when COMFY_LOCAL_URL is set (e.g. http://127.0.0.1:8188)
 * Mimics the RunPod async interface so render.js needs minimal changes.
 *
 * ComfyUI API:
 *   POST /prompt        → { prompt_id }
 *   GET  /history/{id}  → {} (pending) | { [id]: { status, outputs } } (done)
 *   GET  /view?filename=...&type=output → image binary
 */

const axios = require('axios');

function getBase() {
  return (process.env.COMFY_LOCAL_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
}

/**
 * Submit workflow to local ComfyUI.
 * Returns { id: promptId } to match RunPod runAsync shape.
 */
async function submitWorkflow(workflow) {
  const base = getBase();
  const { data } = await axios.post(
    `${base}/prompt`,
    { prompt: workflow },
    { timeout: 30000 }
  );

  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(`ComfyUI node errors: ${JSON.stringify(data.node_errors)}`);
  }

  return { id: data.prompt_id };
}

/**
 * Poll local ComfyUI history for a prompt_id.
 * Returns RunPod-compatible shape:
 *   { status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED', output: { image: base64 } }
 */
async function getStatus(promptId) {
  const base = getBase();

  // Check queue position first (running vs queued)
  const [historyRes, queueRes] = await Promise.all([
    axios.get(`${base}/history/${promptId}`, { timeout: 15000 }),
    axios.get(`${base}/queue`, { timeout: 15000 }),
  ]);

  const historyEntry = historyRes.data[promptId];

  // Not in history yet — check if it's queued or running
  if (!historyEntry) {
    const queue = queueRes.data;
    const isRunning = (queue.queue_running || []).some((item) => item[1] === promptId);
    return { status: isRunning ? 'IN_PROGRESS' : 'IN_QUEUE' };
  }

  // ComfyUI status_str: 'success' | 'error'
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

  // Find SaveImage output (node 13)
  const outputs = historyEntry.outputs || {};
  let imageFilename = null;
  let imageSubfolder = '';

  for (const nodeOutput of Object.values(outputs)) {
    const images = nodeOutput.images;
    if (Array.isArray(images) && images.length > 0) {
      imageFilename = images[0].filename;
      imageSubfolder = images[0].subfolder || '';
      break;
    }
  }

  if (!imageFilename) {
    return { status: 'FAILED', error: '결과 이미지를 찾을 수 없습니다.' };
  }

  // Download image and convert to base64
  const viewUrl = `${base}/view?filename=${encodeURIComponent(imageFilename)}&subfolder=${encodeURIComponent(imageSubfolder)}&type=output`;
  const imgRes = await axios.get(viewUrl, { responseType: 'arraybuffer', timeout: 60000 });
  const imageBase64 = Buffer.from(imgRes.data).toString('base64');

  return { status: 'COMPLETED', output: { image: imageBase64 } };
}

module.exports = { submitWorkflow, getStatus };
