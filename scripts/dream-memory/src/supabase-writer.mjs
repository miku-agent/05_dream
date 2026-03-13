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

const PROJECT_LINK_MIN_CONFIDENCE = 0.85;

export async function persistArchiveReport(report, config) {
  const client = createSupabaseClient(config);
  const job = await upsertDreamJob(client, report);
  const sessions = await upsertDreamSessions(client, report, job.id);
  const sessionIdByExternalId = new Map(sessions.map((row) => [row.external_session_id, row.id]));

  const projectRows = buildDreamProjectRows(report);
  let projects = [];
  if (projectRows.length > 0) {
    projects = await upsertDreamProjects(client, projectRows);
  }
  const projectIdBySlug = new Map((projects || []).map((row) => [row.slug, row.id]));

  const sessionProjectRows = buildDreamSessionProjectRows(report, sessionIdByExternalId, projectIdBySlug);
  if (sessionProjectRows.length > 0) {
    await client.request('dream_session_projects', {
      method: 'POST',
      query: '?on_conflict=session_id,project_id',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: sessionProjectRows,
    });
  }

  const messageRows = buildDreamMessages(report, sessionIdByExternalId);
  if (messageRows.length > 0) {
    await client.request('dream_messages', {
      method: 'POST',
      query: '?on_conflict=session_id,seq_no',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: messageRows,
    });
  }

  const candidateRows = buildDreamMemoryCandidateRows(report, sessionIdByExternalId);
  let candidateInsertResult = [];
  if (candidateRows.length > 0) {
    candidateInsertResult = await client.request('dream_memory_candidates', {
      method: 'POST',
      query: '?on_conflict=session_id,kind,title',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: candidateRows,
    });
  }

  const candidateIdByFingerprint = new Map(
    candidateInsertResult
      .filter((row) => row.content_fingerprint)
      .map((row) => [row.content_fingerprint, row.id])
  );

  const candidateProjectRows = buildDreamCandidateProjectRows(report, candidateIdByFingerprint, projectIdBySlug);
  if (candidateProjectRows.length > 0) {
    await client.request('dream_candidate_projects', {
      method: 'POST',
      query: '?on_conflict=candidate_id,project_id',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: candidateProjectRows,
    });
  }

  const promotionRows = buildDreamPromotionRows(report, sessionIdByExternalId, candidateIdByFingerprint);
  if (promotionRows.length > 0) {
    await client.request('dream_promotions', {
      method: 'POST',
      query: '?on_conflict=session_id,entry_slug',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: promotionRows,
    });
  }

  return {
    job,
    sessionsInserted: sessions.length,
    projectsInserted: projectRows.length,
    sessionProjectsInserted: sessionProjectRows.length,
    candidateProjectsInserted: candidateProjectRows.length,
    messagesInserted: messageRows.length,
    candidatesInserted: candidateRows.length,
    promotionsInserted: promotionRows.length,
  };
}

async function upsertDreamJob(client, report) {
  const payload = [{
    job_date: report.targetDate,
    status: 'archiving',
    sessions_discovered: report.counts.sessionsMatched,
    sessions_archived: report.counts.sessionsMatched,
    sessions_promoted: report.counts.promote,
    sessions_failed: 0,
    notes: {
      version: report.version,
      mode: report.mode,
      timeZone: report.timeZone,
      window: report.window,
    },
    finished_at: new Date().toISOString(),
  }];

  const rows = await client.request('dream_jobs', {
    method: 'POST',
    query: '?on_conflict=job_date',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: payload,
  });

  return rows[0];
}

async function upsertDreamProjects(client, rows) {
  return await client.request('dream_projects', {
    method: 'POST',
    query: '?on_conflict=slug',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: rows,
  });
}

async function upsertDreamSessions(client, report, jobId) {
  const payload = report.sessions.map((session) => ({
    external_session_id: session.externalSessionId,
    job_id: jobId,
    channel: inferChannel(session.fileName),
    agent_name: 'miku',
    started_at: session.startedAt,
    ended_at: session.lastMessageAt,
    last_message_at: session.lastMessageAt,
    message_count: session.messageCount,
    char_count: session.charCount,
    archive_status: 'archived',
    analysis_status: 'analyzed',
    promotion_status: mapPromotionStatus(session.promotionDecision),
    importance_score: session.importanceScore,
    importance_band: normalizeImportanceBand(session.importanceBand),
    retention_class: session.retentionClass,
    summary_short: session.summaryShort,
    summary_json: {
      reasons: session.reasons,
      candidateKinds: session.candidateKinds,
      sampleUserText: session.sampleUserText,
      sourceFile: session.fileName,
    },
  }));

  return await client.request('dream_sessions', {
    method: 'POST',
    query: '?on_conflict=external_session_id',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: payload,
  });
}

function buildDreamProjectRows(report) {
  const bySlug = new Map();

  for (const session of report.sessions || []) {
    for (const hint of session.projectHints || []) {
      if (!hint?.slug || (hint.confidence || 0) < PROJECT_LINK_MIN_CONFIDENCE) continue;
      const current = bySlug.get(hint.slug) || {
        slug: hint.slug,
        name: hint.label || hint.slug,
        kind: inferProjectKind(hint.slug),
        aliases_json: buildProjectAliases(hint),
        status: 'active',
      };
      bySlug.set(hint.slug, current);
    }
  }

  return Array.from(bySlug.values());
}

function buildDreamSessionProjectRows(report, sessionIdByExternalId, projectIdBySlug) {
  const rows = [];

  for (const session of report.sessions || []) {
    const sessionId = sessionIdByExternalId.get(session.externalSessionId);
    if (!sessionId) continue;

    for (const hint of session.projectHints || []) {
      if (!hint?.slug || (hint.confidence || 0) < PROJECT_LINK_MIN_CONFIDENCE) continue;
      const projectId = projectIdBySlug.get(hint.slug);
      if (!projectId) continue;

      rows.push({
        session_id: sessionId,
        project_id: projectId,
        link_source: 'inferred',
        confidence_score: hint.confidence,
        primary_project: session.primaryProjectHint?.slug === hint.slug,
        reason_json: {
          sources: hint.sources || [],
          signalTypes: hint.signalTypes || [],
          matchedTexts: hint.matchedTexts || [],
          evidenceCount: hint.evidenceCount || 0,
        },
      });
    }
  }

  return rows;
}

function buildDreamMessages(report, sessionIdByExternalId) {
  const rows = [];

  for (const session of report.sessions) {
    const sessionId = sessionIdByExternalId.get(session.externalSessionId);
    if (!sessionId || !Array.isArray(session.messages)) continue;

    for (const message of session.messages) {
      rows.push({
        session_id: sessionId,
        external_message_id: message.id,
        seq_no: message.seqNo,
        role: normalizeRole(message.role),
        author_name: message.author,
        created_at: message.timestamp,
        content_text: message.text,
        content_json: {
          charCount: message.charCount,
        },
        attachment_count: 0,
        sensitivity: 'unknown',
      });
    }
  }

  return rows;
}

function buildDreamMemoryCandidateRows(report, sessionIdByExternalId) {
  const rows = [];

  for (const session of report.sessions) {
    const sessionId = sessionIdByExternalId.get(session.externalSessionId);
    if (!sessionId || !Array.isArray(session.candidates)) continue;

    for (const candidate of session.candidates) {
      rows.push({
        session_id: sessionId,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        detail_json: candidate.detailJson,
        confidence_score: candidate.confidenceScore,
        importance_score: candidate.importanceScore,
        novelty_score: candidate.noveltyScore,
        actionability_score: candidate.actionabilityScore,
        decision: candidate.decision,
        reason_codes: candidate.reasonCodes,
        source_message_ids: candidate.sourceMessageIds,
        content_fingerprint: candidate.contentFingerprint,
      });
    }
  }

  return rows;
}

function buildDreamCandidateProjectRows(report, candidateIdByFingerprint, projectIdBySlug) {
  const rows = [];

  for (const session of report.sessions || []) {
    for (const candidate of session.candidates || []) {
      const candidateId = candidateIdByFingerprint.get(candidate.contentFingerprint);
      if (!candidateId) continue;

      const seenProjectSlugs = new Set();
      const candidateProjectHints = [];

      if (candidate.primaryProject?.slug) {
        candidateProjectHints.push({
          ...candidate.primaryProject,
          inferredPrimary: true,
        });
      }

      for (const link of candidate.projectLinks || []) {
        candidateProjectHints.push(link);
      }

      for (const hint of candidateProjectHints) {
        if (!hint?.slug || seenProjectSlugs.has(hint.slug)) continue;
        if ((hint.confidence || 0) < PROJECT_LINK_MIN_CONFIDENCE) continue;

        const projectId = projectIdBySlug.get(hint.slug);
        if (!projectId) continue;

        seenProjectSlugs.add(hint.slug);
        rows.push({
          candidate_id: candidateId,
          project_id: projectId,
          link_source: 'inherited',
          confidence_score: hint.confidence,
          reason_json: {
            primaryProject: candidate.primaryProject?.slug === hint.slug,
            sources: hint.sources || [],
            signalTypes: hint.signalTypes || [],
            matchedTexts: hint.matchedTexts || [],
            evidenceCount: hint.evidenceCount || 0,
            candidateKind: candidate.kind || null,
            candidateTitle: candidate.title || null,
          },
        });
      }
    }
  }

  return rows;
}

function buildDreamPromotionRows(report, sessionIdByExternalId, candidateIdByFingerprint) {
  const rows = [];

  for (const promotion of report.promotions || []) {
    const sessionId = sessionIdByExternalId.get(promotion.externalSessionId);
    const candidateId = candidateIdByFingerprint.get(promotion.candidateFingerprint);
    if (!sessionId || !candidateId) continue;

    rows.push({
      candidate_id: candidateId,
      session_id: sessionId,
      target_file: promotion.targetFile,
      target_section: promotion.targetSection,
      entry_slug: promotion.entrySlug,
      promotion_mode: promotion.promotionMode,
      content_markdown: promotion.contentMarkdown,
      source_refs_json: {
        externalSessionId: promotion.externalSessionId,
        kind: promotion.kind,
        title: promotion.title,
      },
    });
  }

  return rows;
}


function buildProjectAliases(hint) {
  const values = new Set([hint.slug, hint.label].filter(Boolean).map((value) => String(value).trim().toLowerCase()));
  for (const value of hint.matchedTexts || []) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) values.add(normalized);
  }
  return Array.from(values).slice(0, 12);
}

function inferProjectKind(slug) {
  const value = String(slug || '').toLowerCase();
  if (value.includes('supabase') || value.includes('infra')) return 'infra';
  if (value.includes('research')) return 'research';
  if (value.includes('personal')) return 'personal';
  if (value.includes('lib') || value.includes('sdk')) return 'library';
  return 'app';
}

function normalizeImportanceBand(value) {
  if (value === 'critical') return 'high';
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return 'low';
}

function inferChannel(fileName) {
  if (fileName.includes('topic-')) return 'discord';
  return 'cli';
}

function mapPromotionStatus(decision) {
  if (decision === 'promote') return 'promoted';
  if (decision === 'defer') return 'review_later';
  if (decision === 'archive_only') return 'archived_only';
  return 'none';
}

function normalizeRole(role) {
  if (['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) return role;
  return 'assistant';
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
