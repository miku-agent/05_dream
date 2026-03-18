import { sanitizeApiKey } from './api-utils.mjs';
import { extractMeaningfulUserText } from './text-cleaning.mjs';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_USER_TEXT_LENGTH = 4000;
const MAX_ASSISTANT_TEXT_LENGTH = 2000;
const TIMEOUT_MS = 15_000;

const VALID_BANDS = ['critical', 'high', 'medium', 'low'];
const VALID_DECISIONS = ['promote', 'defer', 'archive_only', 'reject'];
const VALID_KINDS = ['user_preference', 'project_state', 'operation_rule', 'decision', 'todo', 'relationship', 'fact'];

export async function scoreSessionWithLLM(session, { apiKey, model }) {
  const modelName = normalizeModelName(model);
  const prompt = buildScoringPrompt(session);
  const url = `${API_BASE}/${modelName}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const sanitized = sanitizeApiKey(body);
    throw new Error(`Gemini API ${response.status}: ${sanitized.slice(0, 200)}`);
  }

  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 100)}`);
  }

  return validateLLMResponse(parsed);
}

export async function scoreSessionsWithLLM(sessions, { apiKey, model }) {
  const results = [];

  for (const session of sessions) {
    try {
      const llmResult = await scoreSessionWithLLM(session, { apiKey, model });
      results.push({ session, llmResult, ok: true });
    } catch (error) {
      results.push({ session, llmResult: null, ok: false, error: sanitizeApiKey(error.message) });
    }
  }

  return results;
}

function normalizeModelName(model) {
  return String(model || 'gemini-2.0-flash-lite').replace(/^google\//i, '');
}

function buildScoringPrompt(session) {
  const meaningfulTexts = extractMeaningfulUserText(session.messages || []);
  const userTexts = meaningfulTexts.join('\n---\n').slice(0, MAX_USER_TEXT_LENGTH) || '(발화 없음)';

  const assistantTexts = (session.messages || [])
    .filter((m) => m.role === 'assistant')
    .map((m) => String(m.text || '').trim())
    .filter((t) => t.length > 20)
    .slice(-5)
    .join('\n---\n')
    .slice(0, MAX_ASSISTANT_TEXT_LENGTH) || '(발화 없음)';

  return `당신은 AI 에이전트의 대화 세션을 분석하는 메모리 큐레이터입니다.
아래 세션을 분석하고, 장기 기억으로 보존할 가치가 있는지 평가해주세요.

## 세션 메타데이터
- 메시지 수: ${session.messageCount || 0}
- 사용자 메시지 수: ${session.roleCounts?.user || 0}
- 어시스턴트 메시지 수: ${session.roleCounts?.assistant || 0}
- 작업 디렉토리: ${session.cwd || '없음'}
- 감지된 프로젝트: ${session.primaryProjectHint?.slug || '없음'}

## 사용자 발화
${userTexts}

## 어시스턴트 응답 (마지막 5개 요약)
${assistantTexts}

## 평가 기준
1. 사용자가 명시적으로 기억/규칙을 요청했는가? (예: "기억해", "앞으로 이렇게 해")
2. 장기적으로 유효한 프로젝트 결정/아키텍처 변경이 있는가?
3. 사용자 선호도나 작업 방식 규칙이 표현되었는가?
4. 구체적인 의사결정(확정, 진행)이 이루어졌는가?
5. 실제 코드 구현이나 기능 완성이 있는가?
6. 자동화/크론 실행인가? (→ 낮은 점수)
7. 임시 디버깅/경로 탐색인가? (→ 낮은 점수)
8. 단순 인사/잡담인가? (→ 낮은 점수)

## 점수 기준
- 75-100 (critical): 반드시 기억해야 하는 핵심 결정/규칙
- 50-74 (high): 장기적으로 유용한 프로젝트 상태/선호도
- 25-49 (medium): 참고할 만하지만 필수는 아닌 정보
- 0-24 (low): 임시적이거나 자동화 세션

## promotionDecision 기준
- promote (60+): 장기 기억으로 승격
- defer (35-59): 보관하되 나중에 재평가
- archive_only (15-34): 원본만 보존
- reject (0-14): 삭제 후보

## candidateKinds (해당하는 것 모두 선택)
- user_preference: 사용자 선호도, 작업 스타일, 소통 방식
- project_state: 프로젝트 상태, 진행도, 구조 변경
- operation_rule: 운영 규칙, 정책, 워크플로우 지침
- decision: 확정된 의사결정, 기술적 선택
- todo: 미완료 작업, 다음 단계
- relationship: 사람/팀 관계 정보
- fact: 위에 해당하지 않는 기타 사실 정보

반드시 아래 JSON 형식으로만 응답하세요:
{
  "importanceScore": 0,
  "importanceBand": "low",
  "promotionDecision": "reject",
  "candidateKinds": ["fact"],
  "summary": "한국어 한 줄 요약",
  "reasoning": "판단 근거 (한국어, 2-3문장)",
  "signals": {
    "explicitMemoryRequest": false,
    "longTermDecision": false,
    "userPreference": false,
    "operationRule": false,
    "actionableFollowup": false,
    "automationSession": false,
    "temporaryContext": false,
    "novelContent": false
  }
}`;
}

function validateLLMResponse(parsed) {
  const score = Number(parsed.importanceScore);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`Invalid importanceScore: ${parsed.importanceScore}`);
  }

  const band = VALID_BANDS.includes(parsed.importanceBand)
    ? parsed.importanceBand
    : score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';

  const decision = VALID_DECISIONS.includes(parsed.promotionDecision)
    ? parsed.promotionDecision
    : score >= 60 ? 'promote' : score >= 35 ? 'defer' : score >= 15 ? 'archive_only' : 'reject';

  const kinds = Array.isArray(parsed.candidateKinds)
    ? parsed.candidateKinds.filter((k) => VALID_KINDS.includes(k))
    : ['fact'];
  if (kinds.length === 0) kinds.push('fact');

  const signals = validateSignals(parsed.signals);

  return {
    importanceScore: Math.round(score),
    importanceBand: band,
    promotionDecision: decision,
    candidateKinds: kinds,
    summary: String(parsed.summary || '').slice(0, 280),
    reasoning: String(parsed.reasoning || '').slice(0, 500),
    signals,
    reasons: mapSignalsToReasons(signals),
    scorerType: 'llm',
  };
}

const KNOWN_SIGNALS = [
  'explicitMemoryRequest', 'longTermDecision', 'userPreference',
  'operationRule', 'actionableFollowup', 'automationSession',
  'temporaryContext', 'novelContent',
];

function validateSignals(raw) {
  const signals = {};
  for (const key of KNOWN_SIGNALS) {
    signals[key] = Boolean(raw?.[key]);
  }
  return signals;
}

function mapSignalsToReasons(signals) {
  const reasons = [];
  if (signals.explicitMemoryRequest) reasons.push('explicitMemorySignal');
  if (signals.longTermDecision) reasons.push('longTermProjectSignal', 'decisionMadeSignal');
  if (signals.userPreference) reasons.push('userPreferenceSignal');
  if (signals.operationRule) reasons.push('operationRuleSignal');
  if (signals.actionableFollowup) reasons.push('actionableFollowupSignal');
  if (signals.automationSession) reasons.push('automationSession');
  if (signals.temporaryContext) reasons.push('temporaryContextSignal');
  if (signals.novelContent) reasons.push('noveltySignal');
  return [...new Set(reasons)];
}
