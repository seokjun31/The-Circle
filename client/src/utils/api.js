import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
});

// Attach saved JWT on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const detail = err.response?.data?.detail;
    const msg =
      (typeof detail === 'object' ? detail?.message : detail) ||
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      '서버 오류가 발생했습니다.';
    return Promise.reject(new Error(msg));
  }
);

// Upload room image — creates a project via FastAPI and returns legacy shape
export async function uploadImage(file) {
  const form = new FormData();
  form.append('file', file);
  form.append('title', file.name || '새 프로젝트');
  form.append('image_type', 'single');
  const { data } = await api.post('/v1/projects', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return {
    imageId:  data.id,
    imageUrl: data.original_image_url,
    filename: file.name,
  };
}

// Get materials list
export async function getMaterials() {
  const { data } = await api.get('/materials');
  return data; // [{ id, name, category, imageUrl, ... }]
}

// Start rendering
export async function startRender(payload) {
  const { data } = await api.post('/render', payload);
  return data; // { jobId }
}

// Poll render status
export async function getRenderStatus(jobId) {
  const { data } = await api.get(`/render/${jobId}`);
  return data; // { status, resultUrl, progress }
}

// Save order
export async function saveOrder(orderData) {
  const { data } = await api.post('/orders', orderData);
  return data; // { orderId }
}

// ── Material apply (Phase 4) ──────────────────────────────────────────────────

/**
 * Save a SAM mask to the server via multipart upload.
 *
 * @param {number} projectId
 * @param {{
 *   maskBlob:    Blob,         // PNG blob (white=selected, black=background)
 *   label:       string,       // machine label ID (wall|floor|ceiling|door|window|molding|custom)
 *   customLabel?: string,      // free-text when label === 'custom'
 *   layerOrder?: number,
 * }} payload
 * @returns {{ mask_id, layer_id, mask_url, label, area_percentage }}
 */
export async function saveMask(projectId, payload) {
  const form = new FormData();
  form.append('mask_image', payload.maskBlob, 'mask.png');
  form.append('label',       payload.label);
  form.append('layer_order', String(payload.layerOrder ?? 0));
  if (payload.label === 'custom' && payload.customLabel) {
    form.append('custom_label', payload.customLabel);
  }
  const { data } = await api.post(`/v1/projects/${projectId}/masks`, form);
  return data;
}

/**
 * Apply a material to a masked region via AI (IP-Adapter + ControlNet Depth).
 * @param {number} projectId
 * @param {{ layerId: number, materialId: number, customPrompt?: string }} payload
 * @returns {{ result_url, layer_id, elapsed_s }}
 */
export async function applyMaterial(projectId, payload) {
  const { data } = await api.post(
    `/v1/projects/${projectId}/apply-material`,
    {
      layer_id:    payload.layerId,
      material_id: payload.materialId,
      custom_prompt: payload.customPrompt,
    },
    { timeout: 120_000 },
  );
  return data;
}

/**
 * Fetch material list with optional filters.
 * @param {{ category?, style?, search?, page?, pageSize? }} params
 * @returns {MaterialListResponse}
 */
export async function getMaterialList(params = {}) {
  const q = new URLSearchParams();
  if (params.category) q.set('category',  params.category);
  if (params.style)    q.set('style',     params.style);
  if (params.search)   q.set('search',    params.search);
  q.set('page',      String(params.page     ?? 1));
  q.set('page_size', String(params.pageSize ?? 20));
  const { data } = await api.get(`/v1/materials?${q}`);
  return data;
}

// ── Phase 6: Furniture ────────────────────────────────────────────────────────

/**
 * Fetch furniture catalog with optional filters.
 * @param {{ category?, style?, search?, page?, pageSize? }} params
 * @returns {FurnitureListResponse}
 */
export async function getFurnitureList(params = {}) {
  const q = new URLSearchParams();
  if (params.category) q.set('category',  params.category);
  if (params.style)    q.set('style',     params.style);
  if (params.search)   q.set('search',    params.search);
  q.set('page',      String(params.page     ?? 1));
  q.set('page_size', String(params.pageSize ?? 20));
  const { data } = await api.get(`/v1/furniture?${q}`);
  return data;
}

/**
 * Remove background from a furniture image using rembg.
 * @param {File} file
 * @returns {{ url: string, width_px: number, height_px: number }}
 */
export async function removeFurnitureBg(file) {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/v1/furniture/remove-bg', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60_000,
  });
  return data;
}

/**
 * Upload a custom furniture image (background-removed PNG).
 * @param {File} file
 * @returns {{ furniture_image_url, width_px, height_px, file_size_kb }}
 */
export async function uploadFurnitureImage(file) {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/v1/furniture/upload-image', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 30_000,
  });
  return data;
}

/**
 * Place furniture onto a project room with AI blending.
 * @param {number} projectId
 * @param {{
 *   furnitureId?: number,
 *   furnitureImageUrl?: string,
 *   furnitureWidthCm?: number,
 *   furnitureHeightCm?: number,
 *   spaceWidthCm?: number,
 *   positionX: number,
 *   positionY: number,
 *   targetWidthPx: number,
 * }} payload
 * @returns {{ result_url, layer_id, elapsed_s, fit_check, credits_used, remaining_balance }}
 */
export async function placeFurniture(projectId, payload) {
  const { data } = await api.post(
    `/v1/projects/${projectId}/place-furniture`,
    {
      furniture_id:         payload.furnitureId        ?? null,
      furniture_image_url:  payload.furnitureImageUrl  ?? null,
      furniture_width_cm:   payload.furnitureWidthCm   ?? null,
      furniture_height_cm:  payload.furnitureHeightCm  ?? null,
      space_width_cm:       payload.spaceWidthCm        ?? null,
      position_x:           payload.positionX,
      position_y:           payload.positionY,
      target_width_px:      payload.targetWidthPx,
    },
    { timeout: 120_000 },
  );
  return data;
}

// ── Phase 5: Circle AI & Mood Copy ───────────────────────────────────────────

/**
 * Fetch current user's credit balance.
 * @returns {{ balance: number, user_id: number }}
 */
export async function getCreditBalance() {
  const { data } = await api.get('/v1/credits/balance');
  return data;
}

/**
 * Fetch all available Circle AI style presets.
 * @returns {StylePresetInfo[]}
 */
export async function getStylePresets() {
  const { data } = await api.get('/v1/presets');
  return data;
}

/**
 * Analyze a reference image with Claude API (admin only).
 * @param {string} imageUrl
 * @param {string} adminKey
 * @returns {{ name, label, description, prompt, tags, ip_adapter_weight }}
 */
export async function analyzeStyleImage(imageUrl, adminKey) {
  const { data } = await api.post(
    '/v1/presets/analyze',
    { image_url: imageUrl },
    { headers: { 'x-admin-key': adminKey } },
  );
  return data;
}

/**
 * Create a new system style preset (admin only).
 */
export async function createStylePreset(payload, adminKey) {
  const { data } = await api.post('/v1/presets', payload, {
    headers: { 'x-admin-key': adminKey },
  });
  return data;
}

/**
 * Update a system preset (admin only).
 */
export async function updateStylePreset(id, payload, adminKey) {
  const { data } = await api.put(`/v1/presets/${id}`, payload, {
    headers: { 'x-admin-key': adminKey },
  });
  return data;
}

/**
 * Delete a system preset (admin only).
 */
export async function deleteStylePreset(id, adminKey) {
  const { data } = await api.delete(`/v1/presets/${id}`, {
    headers: { 'x-admin-key': adminKey },
  });
  return data;
}

/**
 * Save a user custom style preset.
 * Auto-analyzes with Claude if name/label are omitted.
 * @param {{ reference_image_url, name?, label?, description?, prompt?, tags?, ip_adapter_weight? }} payload
 */
export async function saveUserPreset(payload) {
  const { data } = await api.post('/v1/presets/user', payload);
  return data;
}

/**
 * List the authenticated user's saved custom presets.
 */
export async function getUserPresets() {
  const { data } = await api.get('/v1/presets/user');
  return data;
}

/**
 * Transform the full room using a style preset (Circle AI).
 * @param {number} projectId
 * @param {{ stylePreset: string, strength: number }} payload
 * @returns {{ result_url, layer_id, elapsed_s, style_preset, credits_used, remaining_balance }}
 */
export async function applyCircleAI(projectId, payload) {
  const { data } = await api.post(
    `/v1/projects/${projectId}/circle-ai`,
    {
      style_preset: payload.stylePreset,
      strength:     payload.strength,
    },
    { timeout: 180_000 },
  );
  return data;
}

/**
 * Apply a curated style preset to the project room (no reference image needed).
 * @param {number} projectId
 * @param {{ preset: string, strength: number }} payload
 *   preset — 'wood_white' | 'mid_century' | 'japandi'
 * @returns {{ result_url, layer_id, elapsed_s, credits_used, remaining_balance }}
 */
export async function applyMoodPreset(projectId, payload) {
  const { data } = await api.post(
    `/v1/projects/${projectId}/mood-preset`,
    {
      preset:   payload.preset,
      strength: payload.strength,
    },
    { timeout: 180_000 },
  );
  return data;
}

/**
 * Copy the mood / atmosphere of a reference image onto the project room.
 * @param {number} projectId
 * @param {{ referenceImage: string, strength: number }} payload
 *   referenceImage — HTTP URL, base64 data URL, or raw base64 string
 * @returns {{ result_url, layer_id, elapsed_s, credits_used, remaining_balance }}
 */
export async function copyMood(projectId, payload) {
  const { data } = await api.post(
    `/v1/projects/${projectId}/mood`,
    {
      reference_image: payload.referenceImage,
      strength:        payload.strength,
    },
    { timeout: 180_000 },
  );
  return data;
}

// ── Room Analysis ─────────────────────────────────────────────────────────────

/**
 * Analyze the project's room image with Claude Vision to detect the room type.
 * @param {number} projectId
 * @returns {{ room_type, room_type_kr, confidence, project_id }}
 */
export async function analyzeRoom(projectId) {
  const { data } = await api.post(
    `/v1/projects/${projectId}/analyze-room`,
    {},
    { timeout: 30_000 },
  );
  return data;
}

/**
 * Store the user-confirmed (or manually entered) room type.
 * @param {number} projectId
 * @param {string} roomType  — English term, e.g. "living room"
 * @returns {{ project_id, room_type, room_type_kr }}
 */
export async function updateRoomType(projectId, roomType) {
  const { data } = await api.patch(
    `/v1/projects/${projectId}/room-type`,
    { room_type: roomType },
  );
  return data;
}

// ── Projects list ─────────────────────────────────────────────────────────────

export async function getProject(projectId) {
  const { data } = await api.get(`/v1/projects/${projectId}`);
  return data; // full project object
}

export async function listProjects(page = 1, pageSize = 12) {
  const { data } = await api.get(`/v1/projects?page=${page}&page_size=${pageSize}`);
  return data; // { items, total, page, page_size }
}

export async function deleteProject(projectId) {
  await api.delete(`/v1/projects/${projectId}`);
}

// ── Phase 7: Layer management ─────────────────────────────────────────────────

/**
 * Get all layers for a project.
 * @param {number} projectId
 * @returns {{ layers: EditLayerResponse[], total: number }}
 */
export async function getProjectLayers(projectId) {
  const { data } = await api.get(`/v1/projects/${projectId}/layers`);
  return data;
}

/**
 * Update a layer's visibility or order.
 * @param {number} projectId
 * @param {number} layerId
 * @param {{ is_visible?: boolean, order?: number, name?: string }} payload
 * @returns {EditLayerResponse}
 */
export async function updateLayer(projectId, layerId, payload) {
  const { data } = await api.patch(
    `/v1/projects/${projectId}/layers/${layerId}`,
    payload,
  );
  return data;
}

/**
 * Delete a layer permanently.
 * @param {number} projectId
 * @param {number} layerId
 */
export async function deleteLayer(projectId, layerId) {
  await api.delete(`/v1/projects/${projectId}/layers/${layerId}`);
}

/**
/**
 * Apply a lighting preset to a project (1 credit).
 * @param {number} projectId
 * @param {{ lighting: string, strength?: number }} payload
 * @returns {{ result_url, layer_id, elapsed_s, lighting, credits_used, remaining_balance }}
 */
export async function applyLightingPreset(projectId, payload) {
  const { data } = await api.post(`/v1/projects/${projectId}/lighting`, payload);
  return data;
}

/**
 * Run final render pipeline with SSE streaming progress.
 *
 * Uses the native fetch API so the caller can read the response body as a
 * stream (axios does not support SSE natively).
 *
 * @param {number} projectId
 * @param {{ lighting: string, quality: string }} payload
 * @param {function(event: object)} onEvent  — called for each SSE event object
 * @param {AbortSignal} [signal]             — optional abort signal
 */
export async function runFinalRender(projectId, payload, onEvent, signal) {
  const token = localStorage.getItem('token') || '';

  const response = await fetch(`/api/v1/projects/${projectId}/final-render`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body:   JSON.stringify({
      lighting: payload.lighting,
      quality:  payload.quality,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      err?.detail?.message || err?.message || `렌더링 요청 실패 (${response.status})`,
    );
  }

  // Read SSE stream line by line
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep potentially incomplete last line

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const evt = JSON.parse(line.slice(6));
          onEvent(evt);
          if (evt.done || evt.error) return;
        } catch {
          // ignore malformed SSE event
        }
      }
    }
  }
}

// ── Chat-based editing ────────────────────────────────────────────────────────

/**
 * Analyze a Korean chat message → intent.
 * @param {string} message
 * @returns {{ action, target, description, prompt, confirmMessage }}
 */
export async function analyzeChatMessage(message) {
  const { data } = await api.post('/v1/chat/analyze', { message });
  return data;
}

export default api;
