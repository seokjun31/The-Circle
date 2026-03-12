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

export default api;
