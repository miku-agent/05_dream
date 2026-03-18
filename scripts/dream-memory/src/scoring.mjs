import { scoreSessionsWithLLM } from './llm-scorer.mjs';

const STRONG_PATTERNS = [
  /기억해/u,
  /앞으로/u,
  /규칙/u,
  /원칙/u,
  /선호/u,
  /매일/u,
  /cron/u,
  /memory\.md/i,
  /supabase/i,
  /새벽\s*2시/u,
  /dream/iu,
];

const MEDIUM_PATTERNS = [
  /프로젝트/u,
  /구현/u,
  /설계/u,
  /정리/u,
  /삭제/u,
  /보존/u,
  /archive/i,
  /promote/i,
  /retention/i,
];

export async function analyzeSessions(sessions, { targetDate, config }) {
  const scorerMode = config?.scorerMode || 'heuristic';

  if (scorerMode === 'llm' && config?.geminiApiKey) {
    return analyzeSessionsWithLLM(sessions, { targetDate, config });
  }

  if (scorerMode === 'llm' && !config?.geminiApiKey) {
    console.error('[dream-memory] WARNING: scorer=llm but GEMINI_API_KEY is not set, falling back to heuristic');
  }

  return sessions.map((session) => analyzeSessionHeuristic(session, { targetDate }));
}

async function analyzeSessionsWithLLM(sessions, { targetDate, config }) {
  const llmResults = await scoreSessionsWithLLM(sessions, {
    apiKey: config.geminiApiKey,
    model: config.llmModel,
  });

  return llmResults.map(({ session, llmResult, ok, error }) => {
    const base = buildBaseFields(session, { targetDate });

    if (ok && llmResult) {
      return {
        ...base,
        importanceScore: llmResult.importanceScore,
        importanceBand: llmResult.importanceBand,
        promotionDecision: llmResult.promotionDecision,
        candidateKinds: llmResult.candidateKinds,
        retentionClass: inferRetentionClass({
          importanceBand: llmResult.importanceBand,
          promotionDecision: llmResult.promotionDecision,
          automationSession: base.automationSession,
        }),
        summaryShort: llmResult.summary || buildSummary(session, llmResult.importanceBand),
        reasons: llmResult.reasons || [],
        scorerType: 'llm',
        llmReasoning: llmResult.reasoning,
        messages: session.messages,
      };
    }

    const heuristic = analyzeSessionHeuristic(session, { targetDate });
    return {
      ...heuristic,
      scorerType: 'heuristic-fallback',
      llmError: String(error || 'unknown').replace(/key=[^&\s"']+/gi, 'key=REDACTED'),
    };
  });
}

function buildBaseFields(session, { targetDate }) {
  const combinedText = (session.messages || []).map((message) => String(message.text || '')).join('\n');
  const automationSession = isAutomationSession(session, combinedText);
  const userMessageRatio = calculateUserMessageRatio(session);

  return {
    externalSessionId: session.externalSessionId,
    fileName: session.fileName,
    filePath: session.filePath,
    targetDate,
    startedAt: session.startedAt,
    lastMessageAt: session.lastMessageAt,
    messageCount: session.messageCount,
    charCount: session.charCount,
    transcriptChecksum: session.transcriptChecksum,
    sampleUserText: truncate(session.sampleUserText, 240),
    automationSession,
    userMessageRatio,
    roleCounts: session.roleCounts || {},
    primaryProjectHint: session.primaryProjectHint || null,
    projectHints: session.projectHints || [],
    projectSignals: session.projectSignals || [],
  };
}

function analyzeSessionHeuristic(session, { targetDate }) {
  const combinedText = (session.messages || []).map((message) => String(message.text || '')).join('\n');
  const automationSession = isAutomationSession(session, combinedText);
  const userMessageRatio = calculateUserMessageRatio(session);

  const explicitMemorySignal = countMatches(combinedText, STRONG_PATTERNS) > 0 ? 1 : 0;
  const longTermProjectSignal = includesAny(combinedText, ['supabase', 'memory', '아키텍처', '정책', '운영']) ? 1 : 0;
  const decisionMadeSignal = includesAny(combinedText, ['하자', '진행해보자', '그렇게 진행', '확정', '추천']) ? 1 : 0;
  const userPreferenceSignal = includesAny(combinedText, ['선호', '원해', '하지마', '하지 말', '좋아']) ? 1 : 0;
  const actionableFollowupSignal = includesAny(combinedText, ['다음 단계', '체크리스트', 'sql', 'runner']) ? 1 : 0;
  const recurrenceSignal = session.messageCount >= 8 ? 1 : 0;
  const noveltySignal = includesAny(combinedText, ['dream memory', '자아', '기억 시스템']) ? 1 : 0;

  const rawImportanceScore = Math.min(100,
    explicitMemorySignal * 25 +
    longTermProjectSignal * 20 +
    decisionMadeSignal * 15 +
    userPreferenceSignal * 15 +
    actionableFollowupSignal * 10 +
    recurrenceSignal * 10 +
    noveltySignal * 5 +
    Math.min(10, countMatches(combinedText, MEDIUM_PATTERNS) * 2)
  );

  const importanceScore = automationSession
    ? Math.min(rawImportanceScore, 34)
    : userMessageRatio < 0.2
      ? Math.min(rawImportanceScore, 49)
      : rawImportanceScore;

  const importanceBand =
    importanceScore >= 75 ? 'critical' :
    importanceScore >= 50 ? 'high' :
    importanceScore >= 25 ? 'medium' :
    'low';

  const promotionDecision =
    importanceScore >= 60 ? 'promote' :
    importanceScore >= 35 ? 'defer' :
    importanceScore >= 15 ? 'archive_only' :
    'reject';

  const candidateKinds = inferCandidateKinds(combinedText);
  const summary = buildSummary(session, importanceBand);

  return {
    externalSessionId: session.externalSessionId,
    fileName: session.fileName,
    filePath: session.filePath,
    targetDate,
    startedAt: session.startedAt,
    lastMessageAt: session.lastMessageAt,
    messageCount: session.messageCount,
    charCount: session.charCount,
    transcriptChecksum: session.transcriptChecksum,
    importanceScore,
    importanceBand,
    promotionDecision,
    candidateKinds,
    retentionClass: inferRetentionClass({ importanceBand, promotionDecision, automationSession }),
    summaryShort: summary,
    sampleUserText: truncate(session.sampleUserText, 240),
    automationSession,
    userMessageRatio,
    roleCounts: session.roleCounts || {},
    primaryProjectHint: session.primaryProjectHint || null,
    projectHints: session.projectHints || [],
    projectSignals: session.projectSignals || [],
    reasons: collectReasons({
      explicitMemorySignal,
      longTermProjectSignal,
      decisionMadeSignal,
      userPreferenceSignal,
      actionableFollowupSignal,
      recurrenceSignal,
      noveltySignal,
      automationSession: automationSession ? 1 : 0,
      userLedSession: userMessageRatio >= 0.2 ? 1 : 0,
    }),
    scorerType: 'heuristic',
    messages: session.messages,
  };
}

function inferCandidateKinds(text) {
  const kinds = new Set();
  if (includesAny(text, ['선호', '말투', '호칭'])) kinds.add('user_preference');
  if (includesAny(text, ['프로젝트', '로드맵', '우선순위'])) kinds.add('project_state');
  if (includesAny(text, ['규칙', '정책', '운영'])) kinds.add('operation_rule');
  if (includesAny(text, ['결정', '확정', '하자'])) kinds.add('decision');
  if (kinds.size === 0) kinds.add('fact');
  return [...kinds];
}

function inferRetentionClass({ importanceBand, promotionDecision, automationSession = false }) {
  if (promotionDecision === 'promote') return 'promoted';
  if (automationSession && promotionDecision === 'archive_only') return 'ephemeral';
  if (importanceBand === 'low') return 'ephemeral';
  return 'standard';
}

function buildSummary(session, band) {
  const preview = truncate(session.sampleUserText || '요약 가능한 user text 없음', 140);
  return `[${band}] ${session.messageCount} messages · ${preview}`;
}

function isAutomationSession(session, combinedText) {
  const lower = combinedText.toLowerCase();
  const cwd = String(session.cwd || '').toLowerCase();
  const userCount = Number(session.roleCounts?.user || 0);
  const assistantCount = Number(session.roleCounts?.assistant || 0) + Number(session.roleCounts?.system || 0) + Number(session.roleCounts?.tool || 0);

  if (lower.includes('[cron:') || lower.includes('__cron')) return true;
  if (lower.includes('task: 1) determine today\'s date')) return true;
  if (lower.includes('do not read inbox_rules.md')) return true;
  if (cwd.includes('/00_blog'.toLowerCase())) return true;
  if (userCount === 0 && assistantCount > 0) return true;
  if (userCount > 0 && assistantCount >= userCount * 4) return true;
  return false;
}

function calculateUserMessageRatio(session) {
  const total = Math.max(session.messageCount || 0, 1);
  const userCount = Number(session.roleCounts?.user || 0);
  return Number((userCount / total).toFixed(2));
}

function collectReasons(signals) {
  return Object.entries(signals)
    .filter(([, value]) => value > 0)
    .map(([key]) => key);
}

function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function includesAny(text, terms) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(String(term).toLowerCase()));
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
