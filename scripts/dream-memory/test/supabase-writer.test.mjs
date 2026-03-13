import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeArchivePersistence } from '../src/supabase-writer.mjs';

test('archive summary exposes requested/returned row counts and keeps legacy aliases', () => {
  const summary = summarizeArchivePersistence({
    job: { id: 7 },
    requestedRows: {
      sessions: 2,
      projects: 1,
      sessionProjects: 1,
      candidateProjects: 0,
      messages: 4,
      candidates: 2,
      promotions: 1,
    },
    returnedRows: {
      sessions: 2,
      projects: 1,
      sessionProjects: 1,
      candidateProjects: 0,
      messages: 4,
      candidates: 2,
      promotions: 1,
    },
  });

  assert.equal(summary.semantics, 'upsert_returned_rows');
  assert.deepEqual(summary.rowsRequested, {
    sessions: 2,
    projects: 1,
    sessionProjects: 1,
    candidateProjects: 0,
    messages: 4,
    candidates: 2,
    promotions: 1,
  });
  assert.deepEqual(summary.rowsReturned, summary.rowsRequested);
  assert.equal(summary.sessionsInserted, 2);
  assert.equal(summary.legacyAliases.promotionsInserted, 1);
});
