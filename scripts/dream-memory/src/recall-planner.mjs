import { inferProjectHints } from './project-detection.mjs';
import { normalizeText } from './text-cleaning.mjs';
import { retrieveSemanticCandidates } from './semantic-retriever.mjs';

export async function planMemoryRecall({
  query,
  report,
  topK = 5,
  knownProjects = [],
  semanticProvider = null,
} = {}) {
  const normalizedQuery = normalizeText(query || '');
  if (!normalizedQuery) {
    return buildEmptyResult(query, semanticProvider);
  }

  const queryProjectHints = inferProjectHints({
    messages: [{ role: 'user', text: normalizedQuery }],
    sampleUserText: normalizedQuery,
    knownProjects,
  }).projectHints;

  const corpus = buildRecallCorpus(report);
  const keywordScored = corpus
    .map((item) => scoreRecallItem(item, normalizedQuery, queryProjectHints))
    .filter((item) => item.totalScore > 0);

  const semantic = await retrieveSemanticCandidates({
    query: normalizedQuery,
    report,
    rankedItems: keywordScored.slice(0, topK),
    topK,
    provider: semanticProvider,
  });

  const merged = mergeScores(keywordScored, semantic.candidates, topK);

  const items = merged.map((item) => ({
    ref: item.ref,
    sourceType: item.sourceType,
    title: item.title,
    project: item.project,
    totalScore: item.totalScore,
    metadataScore: item.metadataScore,
    keywordScore: item.keywordScore,
    semanticScore: item.semanticScore,
    why: item.why,
    audit: item.audit,
  }));

  return {
    query: String(query || ''),
    parsed: {
      normalizedQuery,
      projectHints: queryProjectHints,
    },
    items,
    semantic,
    vectorStub: semantic,
    trace: {
      steps: buildTraceSteps(semantic),
      filters: [
        queryProjectHints.length > 0
          ? `project-aware filter active: ${queryProjectHints.map((hint) => hint.slug).join(', ')}`
          : 'no project filter',
      ],
      scoring: buildTraceScoring(semantic),
    },
  };
}

function mergeScores(keywordItems, semanticCandidates, topK) {
  const semanticByRef = new Map(
    (semanticCandidates || [])
      .filter((c) => c.vectorScore != null)
      .map((c) => [c.ref, c])
  );

  const seenRefs = new Set();

  const merged = keywordItems.map((item) => {
    seenRefs.add(item.ref);
    const semantic = semanticByRef.get(item.ref);
    const vectorScore = semantic?.vectorScore;
    const semanticScore = vectorScore != null ? Math.round(vectorScore * 100) : 0;
    const bestContentScore = Math.max(item.keywordScore, semanticScore);
    const totalScore = Math.max(0, item.metadataScore + bestContentScore);
    const why = [...item.why];

    if (vectorScore != null) {
      why.push(`semantic_similarity:${vectorScore.toFixed(3)}`);
    }

    return {
      ...item,
      semanticScore,
      totalScore,
      why,
    };
  });

  for (const [ref, candidate] of semanticByRef) {
    if (seenRefs.has(ref)) continue;
    const semanticScore = Math.round(candidate.vectorScore * 100);
    merged.push({
      ref,
      sourceType: candidate.objectType,
      title: candidate.objectId,
      project: candidate.project || null,
      kind: null,
      content: null,
      importanceScore: 0,
      confidenceScore: 0,
      metadataScore: 0,
      keywordScore: 0,
      semanticScore,
      totalScore: semanticScore,
      why: [`semantic_only:${candidate.vectorScore.toFixed(3)}`],
      audit: { sourceKey: candidate.sourceKey },
    });
  }

  return merged
    .sort((a, b) => b.totalScore - a.totalScore || b.semanticScore - a.semanticScore || a.ref.localeCompare(b.ref))
    .slice(0, topK);
}

function buildEmptyResult(query, semanticProvider) {
  const emptySemanticBlock = {
    status: 'skipped',
    backend: 'empty_query',
    provider: semanticProvider?.name || null,
    model: null,
    similarityMetric: 'cosine',
    readySourceCount: 0,
    candidates: [],
    nextStep: 'query required before semantic recall can run',
  };

  return {
    query: String(query || ''),
    parsed: { normalizedQuery: '', projectHints: [] },
    items: [],
    semantic: emptySemanticBlock,
    vectorStub: { ...emptySemanticBlock },
    trace: { steps: ['empty_query'], filters: [], scoring: [] },
  };
}

function buildTraceSteps(semantic) {
  const steps = ['project_detection', 'metadata_filter', 'keyword_overlap', 'score_and_rank'];
  if (semantic.status === 'ok') {
    steps.push('semantic_embedding', 'cosine_similarity', 'score_merge');
  } else {
    steps.push('semantic_slot_reserved');
  }
  return steps;
}

function buildTraceScoring(semantic) {
  const scoring = [
    'metadata(project/kind/source)',
    'lexical overlap(title/summary/content)',
  ];
  if (semantic.status === 'ok') {
    scoring.push('semantic cosine similarity(query vs corpus embeddings)');
    scoring.push('blended: metadataScore + max(keywordScore, semanticScore)');
  } else {
    scoring.push('semantic/vector provider slot reserved above lexical ranking');
  }
  scoring.push('audit trail preserved');
  return scoring;
}

function buildRecallCorpus(report) {
  const rows = [];

  for (const session of report.sessions || []) {
    for (const candidate of session.candidates || []) {
      if (candidate.decision === 'reject') continue;
      rows.push({
        ref: `candidate:${candidate.contentFingerprint}`,
        sourceType: 'candidate',
        title: candidate.title,
        content: normalizeText(`${candidate.title}\n${candidate.summary}\n${session.summaryShort || ''}`),
        project: candidate.primaryProject?.slug || candidate.projectLinks?.[0]?.slug || null,
        kind: candidate.kind,
        importanceScore: candidate.importanceScore || 0,
        confidenceScore: candidate.confidenceScore || 0,
        audit: {
          externalSessionId: session.externalSessionId,
          sourceMessageIds: candidate.sourceMessageIds || [],
          reasonCodes: candidate.reasonCodes || [],
          decision: candidate.decision,
        },
      });
    }
  }

  for (const promotion of report.promotions || []) {
    rows.push({
      ref: `promotion:${promotion.entrySlug}`,
      sourceType: 'promotion',
      title: promotion.title,
      content: normalizeText(`${promotion.title}\n${promotion.contentMarkdown || ''}`),
      project: inferPromotionProject(promotion),
      kind: promotion.kind,
      importanceScore: 100,
      confidenceScore: 1,
      audit: {
        externalSessionId: promotion.externalSessionId,
        targetFile: promotion.targetFile,
        targetSection: promotion.targetSection,
        promotionMode: promotion.promotionMode,
      },
    });
  }

  return rows;
}

function scoreRecallItem(item, normalizedQuery, queryProjectHints) {
  const queryTokens = tokenize(normalizedQuery);
  const contentTokens = tokenize(item.content);
  const overlap = intersect(queryTokens, contentTokens);
  const projectMatch = queryProjectHints.some((hint) => hint.slug === item.project);
  const queryHasProject = queryProjectHints.length > 0;

  let metadataScore = 0;
  const why = [];

  if (projectMatch) {
    metadataScore += 40;
    why.push(`project_match:${item.project}`);
  } else if (queryHasProject && item.project) {
    metadataScore -= 10;
    why.push(`project_mismatch:${item.project}`);
  }

  if (item.sourceType === 'promotion') {
    metadataScore += 20;
    why.push('promoted_memory_boost');
  }

  if (item.kind === 'operation_rule' || item.kind === 'user_preference') {
    metadataScore += 10;
    why.push(`stable_kind:${item.kind}`);
  }

  metadataScore += Math.round((item.confidenceScore || 0) * 10);
  const keywordScore = Math.min(60, overlap.length * 12);
  if (overlap.length > 0) {
    why.push(`keyword_overlap:${overlap.join(',')}`);
  }

  const totalScore = Math.max(0, metadataScore + keywordScore);
  return {
    ...item,
    metadataScore,
    keywordScore,
    semanticScore: 0,
    totalScore,
    why,
  };
}

function inferPromotionProject(promotion) {
  const match = String(promotion.targetFile || '').match(/memory\/projects\/([^/.]+)\.md$/);
  return match ? match[1] : null;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣_/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return Array.from(new Set(left.filter((token) => rightSet.has(token))));
}
