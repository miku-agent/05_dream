import test from 'node:test';
import assert from 'node:assert/strict';

import { inferProjectHints } from '../src/project-detection.mjs';

const knownProjects = [
  { slug: '05_dream', name: '05_dream', aliases: ['05_dream', '05-dream', 'dream'] },
  { slug: '03_supabase', name: '03_supabase', aliases: ['03_supabase', '03-supabase', 'supabase'] },
];

test('prefers numbered workspace project roots and ignores nested tool path slugs', () => {
  const result = inferProjectHints({
    cwd: '/Users/bini/.openclaw/workspace/05_dream/scripts/dream-memory',
    knownProjects,
  });

  assert.equal(result.primaryProjectHint?.slug, '05_dream');
  assert.ok(result.projectHints.some((hint) => hint.slug === '05_dream'));
  assert.ok(!result.projectHints.some((hint) => hint.slug === 'dream-memory'));
});

test('filters incidental slug-like text noise such as no-op and topic sample names', () => {
  const result = inferProjectHints({
    messages: [
      { role: 'user', text: 'archive summary shows no-op for this run' },
      { role: 'developer', text: 'please compare topic-sample-promotion before/after' },
    ],
    fileName: 'topic-sample-promotion.jsonl',
    knownProjects,
  });

  assert.deepEqual(result.projectHints.map((hint) => hint.slug), []);
});

test('still keeps explainable unknown slugs when repeated inside explicit project context', () => {
  const result = inferProjectHints({
    messages: [
      { role: 'user', text: 'Project repo is aurora-kit and aurora-kit needs release notes.' },
    ],
    knownProjects: [],
  });

  assert.equal(result.primaryProjectHint?.slug, 'aurora-kit');
  assert.ok(result.projectHints.some((hint) => hint.slug === 'aurora-kit'));
});
