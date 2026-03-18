import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildSelectiveEmbeddingPayloads } from './embedding-payloads.mjs';

const DEFAULT_PROVIDER = 'local';
const DEFAULT_MODEL = 'stub-v1';

export async function persistEmbeddingReport(report, config, options = {}) {
  const payloads = buildSelectiveEmbeddingPayloads(report, options);
  const provider = String(options.provider || config.embeddingProvider || DEFAULT_PROVIDER);
  const model = String(options.model || config.embeddingModel || DEFAULT_MODEL);
  const store = String(options.store || config.embeddingStoreMode || 'supabase').trim().toLowerCase();
  const vectorMap = options.vectorMap || new Map();

  const documentRows = buildEmbeddingDocumentRows(payloads, { provider, model, targetDate: report.targetDate });

  if (store === 'file' || store === 'json') {
    return persistEmbeddingReportToFile(report, config, { provider, model, documentRows, vectorMap });
  }

  const client = createSupabaseClient(config);
  let documents = [];
  if (documentRows.length > 0) {
    documents = await client.request('dream_embedding_documents', {
      method: 'POST',
      query: '?on_conflict=source_type,source_key',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: documentRows,
    });
  }

  const documentIdBySource = new Map(
    (documents || []).map((row) => [buildDocumentLookupKey(row.source_type, row.source_key), row.id])
  );

  const embeddingRows = buildEmbeddingRows(payloads, {
    provider,
    model,
    targetDate: report.targetDate,
    documentIdBySource,
    vectorMap,
  });

  let embeddings = [];
  if (embeddingRows.length > 0) {
    embeddings = await client.request('dream_embeddings', {
      method: 'POST',
      query: '?on_conflict=source_type,source_key,provider,model',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: embeddingRows,
    });
  }

  const vectorsGenerated = embeddingRows.filter((r) => r.status === 'completed').length;

  return {
    semantics: 'upsert_returned_rows',
    store: 'supabase',
    provider,
    model,
    vectorsGenerated,
    rowsRequested: {
      embeddingDocuments: documentRows.length,
      embeddings: embeddingRows.length,
    },
    rowsReturned: {
      embeddingDocuments: documents.length,
      embeddings: embeddings.length,
    },
    sourceKeys: documentRows.map((row) => `${row.source_type}:${row.source_key}`),
  };
}

async function persistEmbeddingReportToFile(report, config, options = {}) {
  const outFile = resolveEmbeddingOutFile(report, config);
  const documentRows = options.documentRows || [];
  const vectorMap = options.vectorMap || new Map();
  const documentIdBySource = new Map(documentRows.map((row) => [buildDocumentLookupKey(row.source_type, row.source_key), row.source_key]));
  const embeddingRows = buildEmbeddingRows(buildSelectiveEmbeddingPayloads(report, options), {
    provider: options.provider,
    model: options.model,
    targetDate: report.targetDate,
    documentIdBySource,
    vectorMap,
  });

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify({
    version: 1,
    targetDate: report.targetDate,
    store: 'file',
    provider: options.provider || DEFAULT_PROVIDER,
    model: options.model || DEFAULT_MODEL,
    documents: documentRows,
    embeddings: embeddingRows,
  }, null, 2) + '\n', 'utf8');

  const vectorsGenerated = embeddingRows.filter((r) => r.status === 'completed').length;

  return {
    semantics: 'file_snapshot',
    store: 'file',
    provider: options.provider || DEFAULT_PROVIDER,
    model: options.model || DEFAULT_MODEL,
    vectorsGenerated,
    outFile,
    rowsRequested: {
      embeddingDocuments: documentRows.length,
      embeddings: embeddingRows.length,
    },
    rowsReturned: {
      embeddingDocuments: documentRows.length,
      embeddings: embeddingRows.length,
    },
    sourceKeys: documentRows.map((row) => `${row.source_type}:${row.source_key}`),
  };
}

function resolveEmbeddingOutFile(report, config) {
  if (config.embeddingOutFile) return config.embeddingOutFile;
  return path.join(config.workspaceRoot, 'tmp', 'dream-memory', `${report.targetDate}.embeddings.json`);
}

export function buildEmbeddingDocumentRows(payloads, options = {}) {
  const provider = String(options.provider || DEFAULT_PROVIDER);
  const model = String(options.model || DEFAULT_MODEL);
  const targetDate = options.targetDate || null;

  return payloads.map((payload) => {
    const sourceKey = buildEmbeddingSourceKey(payload);
    const contentHash = hashText(payload.text);
    return {
      source_type: payload.objectType,
      source_key: sourceKey,
      external_session_id: payload.source?.externalSessionId || null,
      project_slug: payload.project || null,
      provider,
      model,
      content_text: payload.text,
      content_hash: contentHash,
      payload_fingerprint: buildPayloadFingerprint(payload),
      source_ref_json: payload.source || {},
      selection_json: {
        decision: payload.decision || null,
        audit: payload.audit || {},
        source: payload.source || {},
      },
      metadata_json: {
        ...(payload.metadata || {}),
        targetDate,
      },
      status: 'prepared',
      request_count: 1,
      last_requested_at: new Date().toISOString(),
      last_built_at: new Date().toISOString(),
    };
  });
}

export function buildEmbeddingRows(payloads, options = {}) {
  const provider = String(options.provider || DEFAULT_PROVIDER);
  const model = String(options.model || DEFAULT_MODEL);
  const targetDate = options.targetDate || null;
  const documentIdBySource = options.documentIdBySource || new Map();
  const vectorMap = options.vectorMap || new Map();

  return payloads.map((payload) => {
    const sourceType = payload.objectType;
    const sourceKey = buildEmbeddingSourceKey(payload);
    const lookupKey = buildDocumentLookupKey(sourceType, sourceKey);
    const vectorData = vectorMap.get(payload.objectId);
    const hasVector = vectorData && vectorData.vector && vectorData.vector.length > 0;
    const now = new Date().toISOString();

    return {
      document_id: documentIdBySource.get(lookupKey) || null,
      source_type: sourceType,
      source_key: sourceKey,
      provider,
      model,
      content_hash: hashText(payload.text),
      payload_fingerprint: buildPayloadFingerprint(payload),
      dimensions: hasVector ? vectorData.dimensions : null,
      vector_json: hasVector ? vectorData.vector : null,
      status: hasVector ? 'completed' : 'pending',
      requested_at: now,
      generated_at: hasVector ? now : null,
      last_error: null,
      audit_json: {
        mode: hasVector ? 'gemini-live' : 'local-stub',
        targetDate,
        source: payload.source || {},
        selectedBecause: payload.audit?.selectedBecause || [],
      },
    };
  });
}

export function buildEmbeddingSourceKey(payload) {
  return String(payload?.objectId || '').trim();
}

export function buildPayloadFingerprint(payload) {
  return hashText(JSON.stringify({
    objectType: payload?.objectType || null,
    objectId: payload?.objectId || null,
    project: payload?.project || null,
    decision: payload?.decision || null,
    text: String(payload?.text || ''),
    source: payload?.source || {},
    metadata: payload?.metadata || {},
  }));
}

function buildDocumentLookupKey(sourceType, sourceKey) {
  return `${sourceType}:${sourceKey}`;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function createSupabaseClient(config) {
  const url = config.supabaseUrl;
  const key = config.supabaseKey;

  if (!url || !key) {
    throw new Error('Missing DREAM_SUPABASE_URL or DREAM_SUPABASE_SERVICE_ROLE_KEY');
  }

  const baseUrl = `${url.replace(/\/$/, '')}/rest/v1`;

  async function request(table, { method = 'GET', query = '', body = null, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}/${table}${query}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const data = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      throw new Error(`Supabase ${method} ${table} failed: ${response.status} ${response.statusText} :: ${text}`);
    }

    return data;
  }

  return { request };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
