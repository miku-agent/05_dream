#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, parseArgs } from './src/config.mjs';
import { getTargetDateWindow } from './src/date-window.mjs';
import { ensureMemoryBootstrap } from './src/memory-bootstrap.mjs';
import { discoverSessionsForDate } from './src/session-discovery.mjs';
import { analyzeSessions } from './src/scoring.mjs';
import { buildMemoryCandidates } from './src/candidates.mjs';
import { applyPromotions } from './src/promotion-writer.mjs';
import { buildPurgePlan } from './src/purge-planner.mjs';
import { persistArchiveReport } from './src/supabase-writer.mjs';
import { buildSelectiveEmbeddingPayloads } from './src/embedding-payloads.mjs';
import { persistEmbeddingReport } from './src/embedding-store.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);
  const window = getTargetDateWindow({ date: config.date, timeZone: config.timeZone });

  await ensureMemoryBootstrap(config.memoryRoot, { dryRun: config.dryRun });

  const discovered = await discoverSessionsForDate({
    sessionsDir: config.sessionsDir,
    startMs: window.startMs,
    endMs: window.endMs,
    limit: config.limit,
    knownProjects: config.knownProjects,
  });

  const scored = await analyzeSessions(discovered.sessions, { targetDate: window.date, config });
  const analyzed = scored.map((session) => {
    const candidates = buildMemoryCandidates({ sessions: [session] });
    const effectivePromotionDecision = deriveEffectivePromotionDecision(session.promotionDecision, candidates);

    return {
      ...session,
      candidates,
      effectivePromotionDecision,
    };
  });

  const promotions = await applyPromotions({ sessions: analyzed, targetDate: window.date }, config);
  const purge = buildPurgePlan({ sessions: analyzed, promotions, targetDate: window.date }, config);
  const embeddingPayloads = buildSelectiveEmbeddingPayloads({ sessions: analyzed, promotions });

  const scorerStats = buildScorerStats(analyzed);

  const report = {
    version: 4,
    mode: config.dryRun ? 'dry-run' : 'write-ready',
    scorer: scorerStats,
    targetDate: window.date,
    timeZone: config.timeZone,
    window: {
      start: new Date(window.startMs).toISOString(),
      end: new Date(window.endMs).toISOString(),
    },
    counts: {
      filesScanned: discovered.filesScanned,
      sessionsMatched: analyzed.length,
      candidatesExtracted: analyzed.reduce((sum, s) => sum + ((s.candidates || []).length), 0),
      projectsDetected: countDistinctProjects(analyzed),
      sessionsWithProjectLinks: analyzed.filter((s) => (s.projectHints || []).length > 0).length,
      candidatesWithProjectLinks: analyzed.reduce((sum, s) => {
        const hasProjects = (s.projectHints || []).length > 0;
        return sum + (hasProjects ? ((s.candidates || []).length) : 0);
      }, 0),
      promotionsPlanned: promotions.length,
      embeddingPayloadsPlanned: embeddingPayloads.length,
      purgeCandidates: (purge.actions || []).filter((action) => action.action === 'purge_candidate').length,
      keep: (purge.actions || []).filter((action) => action.action === 'keep').length,
      review: (purge.actions || []).filter((action) => action.action === 'review').length,
      promote: analyzed.filter((s) => s.effectivePromotionDecision === 'promote').length,
      defer: analyzed.filter((s) => s.effectivePromotionDecision === 'defer').length,
      archiveOnly: analyzed.filter((s) => s.effectivePromotionDecision === 'archive_only').length,
      reject: analyzed.filter((s) => s.effectivePromotionDecision === 'reject').length,
    },
    promotions,
    embeddingPreview: {
      count: embeddingPayloads.length,
      payloads: embeddingPayloads,
    },
    purge,
    sessions: analyzed,
  };

  const outDir = path.join(config.workspaceRoot, 'tmp', 'dream-memory');
  const outFile = path.join(outDir, `${window.date}.report.json`);

  if (!config.dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  let archive = null;
  if (config.archiveToSupabase) {
    archive = await persistArchiveReport(report, config);
  }

  let embeddingArchive = null;
  if (config.persistEmbeddings) {
    embeddingArchive = await persistEmbeddingReport(report, config, {
      provider: config.embeddingProvider,
      model: config.embeddingModel,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    targetDate: window.date,
    mode: report.mode,
    scorer: scorerStats,
    outFile: config.dryRun ? null : outFile,
    archivedToSupabase: Boolean(archive),
    embeddingsPersisted: Boolean(embeddingArchive),
    archive,
    embeddingArchive,
    counts: report.counts,
  }, null, 2));
}

function deriveEffectivePromotionDecision(baseDecision, candidates) {
  const decisions = new Set((candidates || []).map((candidate) => candidate.decision));
  if (decisions.has('promote')) return 'promote';
  if (decisions.has('defer')) return 'defer';
  if (decisions.has('archive_only')) return 'archive_only';
  return baseDecision;
}

function buildScorerStats(sessions) {
  const types = {};
  for (const s of sessions) {
    const t = s.scorerType || 'unknown';
    types[t] = (types[t] || 0) + 1;
  }
  return { scorerTypes: types, total: sessions.length };
}

function countDistinctProjects(sessions) {
  const slugs = new Set();
  for (const session of sessions || []) {
    for (const hint of session.projectHints || []) {
      if (hint?.slug) slugs.add(hint.slug);
    }
  }
  return slugs.size;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    stack: error?.stack || null,
  }, null, 2));
  process.exitCode = 1;
});
