import { buildSelectiveEmbeddingPayloads } from './embedding-payloads.mjs';
import { embedText, generateEmbeddings } from './embedding-generator.mjs';
import { sanitizeApiKey } from './api-utils.mjs';

const DEFAULT_TOP_K = 5;
const MIN_SIMILARITY_THRESHOLD = 0.1;

export async function retrieveSemanticCandidates({
  query,
  report,
  rankedItems = [],
  topK = DEFAULT_TOP_K,
  provider = null,
} = {}) {
  const effectiveProvider = provider || createSemanticRecallProvider();
  const result = await effectiveProvider.retrieve({ query, report, rankedItems, topK });

  return {
    status: result?.status || 'stub',
    backend: result?.backend || effectiveProvider.name || 'unknown',
    provider: result?.provider || effectiveProvider.name || null,
    model: result?.model || null,
    similarityMetric: result?.similarityMetric || 'cosine',
    readySourceCount: Number.isFinite(result?.readySourceCount) ? result.readySourceCount : countReadySources(report),
    candidates: Array.isArray(result?.candidates) ? result.candidates : [],
    nextStep: result?.nextStep || null,
  };
}

export function createSemanticRecallProvider(options = {}) {
  const mode = String(options.mode || options.provider || 'stub').trim().toLowerCase();

  if (mode === 'gemini') {
    return createGeminiSemanticProvider(options);
  }

  if (mode === 'stub' || mode === 'local' || mode === 'none') {
    return createStubSemanticRecallProvider(options);
  }

  return {
    name: mode,
    async retrieve() {
      return {
        status: 'unavailable',
        backend: mode,
        provider: mode,
        model: options.model || null,
        similarityMetric: 'cosine',
        readySourceCount: 0,
        candidates: [],
        nextStep: `provider "${mode}" is reserved but not implemented yet`,
      };
    },
  };
}

export function createGeminiSemanticProvider(options = {}) {
  const apiKey = options.apiKey || '';
  const model = options.model || 'text-embedding-004';

  return {
    name: 'gemini',
    async retrieve({ query, report, topK = DEFAULT_TOP_K }) {
      if (!apiKey) {
        return {
          status: 'error',
          backend: 'gemini',
          provider: 'gemini',
          model,
          similarityMetric: 'cosine',
          readySourceCount: 0,
          candidates: [],
          nextStep: 'GEMINI_API_KEY required for semantic recall',
        };
      }

      try {
        const payloads = buildSelectiveEmbeddingPayloads(report);
        if (payloads.length === 0) {
          return {
            status: 'empty_corpus',
            backend: 'gemini',
            provider: 'gemini',
            model,
            similarityMetric: 'cosine',
            readySourceCount: 0,
            candidates: [],
            nextStep: 'no embedding payloads in report',
          };
        }

        const queryVector = await embedText(query, { apiKey, model });
        const corpusVectors = await generateEmbeddings(payloads, { apiKey, model });

        const scored = payloads
          .map((payload) => {
            const vecData = corpusVectors.get(payload.objectId);
            if (!vecData) return null;

            const similarity = cosineSimilarity(queryVector, vecData.vector);
            return {
              ref: toRecallRef(payload),
              sourceKey: `${payload.objectType}:${payload.objectId}`,
              objectType: payload.objectType,
              objectId: payload.objectId,
              project: payload.project || null,
              vectorScore: Math.round(similarity * 1000) / 1000,
              reason: 'semantic_similarity',
            };
          })
          .filter((item) => item && item.vectorScore > MIN_SIMILARITY_THRESHOLD)
          .sort((a, b) => b.vectorScore - a.vectorScore)
          .slice(0, topK)
          .map((item, index) => ({ ...item, rankHint: index + 1 }));

        return {
          status: 'ok',
          backend: 'gemini',
          provider: 'gemini',
          model,
          similarityMetric: 'cosine',
          readySourceCount: payloads.length,
          candidates: scored,
          nextStep: null,
        };
      } catch (error) {
        const safeMsg = sanitizeApiKey(error.message);
        return {
          status: 'error',
          backend: 'gemini',
          provider: 'gemini',
          model,
          similarityMetric: 'cosine',
          readySourceCount: 0,
          candidates: [],
          nextStep: `semantic recall failed: ${safeMsg}`,
        };
      }
    },
  };
}

export function createStubSemanticRecallProvider(options = {}) {
  const providerName = String(options.provider || 'stub').trim() || 'stub';
  const model = options.model || null;

  return {
    name: providerName,
    async retrieve({ report, rankedItems = [], topK = DEFAULT_TOP_K }) {
      const payloads = buildSelectiveEmbeddingPayloads(report);
      const payloadByRef = new Map(payloads.map((payload) => [toRecallRef(payload), payload]));

      const candidates = rankedItems
        .filter((item) => payloadByRef.has(item.ref))
        .slice(0, topK)
        .map((item, index) => {
          const payload = payloadByRef.get(item.ref);
          return {
            ref: item.ref,
            sourceKey: `${payload.objectType}:${payload.objectId}`,
            objectType: payload.objectType,
            objectId: payload.objectId,
            project: payload.project || null,
            vectorScore: null,
            rankHint: index + 1,
            reason: 'lexical_rank_seed',
          };
        });

      return {
        status: 'stub',
        backend: 'not_configured',
        provider: providerName,
        model,
        similarityMetric: 'cosine',
        readySourceCount: payloads.length,
        candidates,
        nextStep: 'replace with gemini provider for real semantic recall',
      };
    },
  };
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function countReadySources(report) {
  return buildSelectiveEmbeddingPayloads(report).length;
}

function toRecallRef(payload) {
  return `${payload.objectType}:${payload.objectId}`;
}
