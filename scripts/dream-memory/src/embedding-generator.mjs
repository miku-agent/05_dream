import { sanitizeApiKey } from './api-utils.mjs';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const BATCH_SIZE = 100;
const MAX_TEXT_CHARS = 8000;
const TIMEOUT_MS = 30_000;

export async function generateEmbeddings(payloads, { apiKey, model }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY required for embedding generation');
  if (!payloads || payloads.length === 0) return new Map();

  const modelName = normalizeModel(model);
  const vectorMap = new Map();
  const batches = chunk(payloads, BATCH_SIZE);

  for (const batch of batches) {
    const vectors = await embedBatch(batch, { apiKey, modelName });
    for (let i = 0; i < batch.length; i++) {
      const vec = vectors[i];
      if (vec && vec.length > 0) {
        vectorMap.set(batch[i].objectId, {
          vector: vec,
          dimensions: vec.length,
        });
      }
    }
  }

  return vectorMap;
}

async function embedBatch(payloads, { apiKey, modelName }) {
  const url = `${API_BASE}/${modelName}:batchEmbedContents?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: payloads.map((p) => ({
        model: `models/${modelName}`,
        content: { parts: [{ text: String(p.text || '').slice(0, MAX_TEXT_CHARS) }] },
      })),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const sanitized = sanitizeApiKey(body);
    throw new Error(`Gemini Embedding API ${response.status}: ${sanitized.slice(0, 200)}`);
  }

  const result = await response.json();
  const embeddings = (result.embeddings || []).map((e) => e?.values || null);

  if (embeddings.length !== payloads.length) {
    console.error(`[dream-memory] Embedding batch size mismatch: sent ${payloads.length}, received ${embeddings.length}`);
  }

  return embeddings;
}

function normalizeModel(model) {
  return String(model || 'text-embedding-004').replace(/^google\//i, '');
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
