const axios = require('axios');

const RUNPOD_BASE = 'https://api.runpod.ai/v2';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Submit a synchronous RunPod job (waits up to 60s)
 */
async function runSync(endpointId, input) {
  const url = `${RUNPOD_BASE}/${endpointId}/runsync`;
  const { data } = await axios.post(url, { input }, { headers: getHeaders(), timeout: 120000 });
  return data;
}

/**
 * Submit an asynchronous RunPod job (returns jobId immediately)
 */
async function runAsync(endpointId, input) {
  const url = `${RUNPOD_BASE}/${endpointId}/run`;
  const { data } = await axios.post(url, { input }, { headers: getHeaders(), timeout: 30000 });
  return data; // { id, status }
}

/**
 * Poll job status
 */
async function getStatus(endpointId, jobId) {
  const url = `${RUNPOD_BASE}/${endpointId}/status/${jobId}`;
  const { data } = await axios.get(url, { headers: getHeaders(), timeout: 30000 });
  return data; // { id, status, output, error }
}

/**
 * Cancel a job
 */
async function cancelJob(endpointId, jobId) {
  const url = `${RUNPOD_BASE}/${endpointId}/cancel/${jobId}`;
  const { data } = await axios.post(url, {}, { headers: getHeaders() });
  return data;
}

module.exports = { runSync, runAsync, getStatus, cancelJob };
