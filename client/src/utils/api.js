import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      '서버 오류가 발생했습니다.';
    return Promise.reject(new Error(msg));
  }
);

// Upload room image
export async function uploadImage(file) {
  const form = new FormData();
  form.append('image', file);
  const { data } = await api.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data; // { imageId, imageUrl, filename }
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
 * Save a SAM mask to the server and get back a layerId.
 * @param {number} projectId
 * @param {{ maskBase64: string, label: string, layerOrder?: number }} payload
 * @returns {{ layer_id, mask_url, label }}
 */
export async function saveMask(projectId, payload) {
  const { data } = await api.post(`/v1/projects/${projectId}/masks`, {
    mask_base64: payload.maskBase64,
    label:       payload.label,
    layer_order: payload.layerOrder ?? 0,
  });
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

export default api;
