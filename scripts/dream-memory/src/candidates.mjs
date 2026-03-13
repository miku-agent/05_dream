import { extractMeaningfulUserText, isLowSignal, looksLikeTemporaryContext } from './text-cleaning.mjs';

export function buildMemoryCandidates(report) {
  const rows = [];

  for (const session of report.sessions) {
    const confidenceScore = normalizeConfidence(session.importanceScore);
    const baseDecision = session.promotionDecision;
    const meaningfulTexts = extractMeaningfulUserText(session.messages || []);
    const primaryText = meaningfulTexts[meaningfulTexts.length - 1] || session.sampleUserText || session.summaryShort;

    for (const kind of session.candidateKinds || ['fact']) {
      const title = buildCandidateTitle(session, kind, primaryText);
      const summary = buildCandidateSummary(session, kind, primaryText);
      const decision = mapDecisionForKind(session, baseDecision, kind, primaryText);
      if (!title || !summary) continue;

      rows.push({
        externalSessionId: session.externalSessionId,
        kind,
        title,
        summary,
        primaryProject: session.primaryProjectHint || null,
        projectLinks: (session.projectHints || []).slice(0, 3),
        detailJson: {
          targetDate: session.targetDate,
          fileName: session.fileName,
          filePath: session.filePath,
          importanceBand: session.importanceBand,
          reasons: session.reasons,
          sampleUserText: session.sampleUserText,
          primaryText,
          primaryProject: session.primaryProjectHint || null,
          projectHints: (session.projectHints || []).slice(0, 5),
        },
        confidenceScore,
        importanceScore: session.importanceScore,
        noveltyScore: estimateNoveltyScore(session, kind),
        actionabilityScore: estimateActionabilityScore(session, kind),
        decision,
        reasonCodes: session.reasons || [],
        sourceMessageIds: collectSourceMessageIds(session.messages || []),
        contentFingerprint: buildContentFingerprint(session, kind, primaryText),
      });
    }
  }

  return rows;
}

function buildCandidateTitle(session, kind, primaryText) {
  const compact = String(primaryText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72);

  if (!compact || isLowSignal(compact)) return null;
  return `${kind}: ${compact}`;
}

function buildCandidateSummary(session, kind, primaryText) {
  const prefixMap = {
    project_state: 'Project state',
    user_preference: 'User preference',
    operation_rule: 'Operation rule',
    decision: 'Decision',
    todo: 'Todo',
    relationship: 'Relationship',
    fact: 'Fact',
  };

  const compact = String(primaryText || '').replace(/\s+/g, ' ').trim();
  if (!compact || isLowSignal(compact)) return null;
  return `${prefixMap[kind] || 'Memory'}: ${compact.slice(0, 220)}`;
}

function normalizeConfidence(importanceScore) {
  const normalized = Math.max(0, Math.min(1, (importanceScore || 0) / 100));
  return Number(normalized.toFixed(2));
}

function estimateNoveltyScore(session, kind) {
  let score = 20;
  if (kind === 'decision') score += 20;
  if (kind === 'operation_rule') score += 20;
  if ((session.reasons || []).includes('noveltySignal')) score += 20;
  if ((session.reasons || []).includes('explicitMemorySignal')) score += 20;
  return Math.min(100, score);
}

function estimateActionabilityScore(session, kind) {
  let score = 10;
  if (kind === 'project_state' || kind === 'todo') score += 30;
  if ((session.reasons || []).includes('actionableFollowupSignal')) score += 30;
  if ((session.reasons || []).includes('decisionMadeSignal')) score += 20;
  return Math.min(100, score);
}

function mapDecisionForKind(session, baseDecision, kind, primaryText) {
  const normalized = String(primaryText || '').toLowerCase();
  if (session.automationSession) return 'archive_only';
  if ((session.userMessageRatio || 0) < 0.2) return 'archive_only';
  if (!primaryText || isLowSignal(primaryText)) return 'archive_only';
  if (looksLikeTemporaryContext(primaryText)) return 'archive_only';
  if (normalized.includes('__cron') || normalized.startsWith('[cron:')) return 'archive_only';
  if (kind === 'operation_rule' && !hasStableRuleSignal(primaryText)) return 'archive_only';
  if (kind === 'decision' && !hasDecisionSignal(primaryText)) return 'archive_only';
  if (kind === 'project_state' && !hasProjectStateSignal(primaryText)) return 'archive_only';
  if (kind === 'fact' && !hasLongTermFactSignal(primaryText, session)) return 'archive_only';
  if (baseDecision === 'reject') return 'reject';
  if (baseDecision === 'archive_only') return 'archive_only';
  if (kind === 'fact' && baseDecision === 'defer') return 'archive_only';
  return baseDecision;
}

function collectSourceMessageIds(messages) {
  return messages
    .filter((message) => message.role === 'user' && !isLowSignal(message.text))
    .slice(0, 20)
    .map((message) => String(message.id || message.seqNo));
}

function hasStableRuleSignal(text) {
  const lower = String(text || '').toLowerCase();
  return ['규칙', '원칙', '앞으로', '반드시', '금지', '지침'].some((term) => lower.includes(term));
}

function hasDecisionSignal(text) {
  const lower = String(text || '').toLowerCase();
  return ['하자', '진행', '확정', '결정', '하자고', '하기로'].some((term) => lower.includes(term));
}

function hasProjectStateSignal(text) {
  const lower = String(text || '').toLowerCase();
  return ['프로젝트', '구현', '추가', '연결', '상태', '다음 단계', '붙였', '남은'].some((term) => lower.includes(term));
}

function hasLongTermFactSignal(text, session) {
  const lower = String(text || '').toLowerCase();
  if (looksLikeTemporaryContext(text)) return false;
  if ((session.reasons || []).includes('automationSession')) return false;
  return ['기억', '앞으로', '항상', '중요', '남겨', '기록', '원칙', '정책', '선호'].some((term) => lower.includes(term));
}

function buildContentFingerprint(session, kind, primaryText) {
  const seed = `${session.externalSessionId}|${kind}|${session.transcriptChecksum || ''}|${primaryText || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  }
  return `cand-${hash.toString(16)}`;
}
