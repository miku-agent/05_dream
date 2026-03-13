import path from 'node:path';

const GENERIC_SEGMENTS = new Set([
  'users',
  'bini',
  '.openclaw',
  'workspace',
  'apps',
  'sessions',
  'agents',
  'miku',
  'tmp',
  'src',
  'dist',
  'build',
  'node_modules',
]);

const GENERIC_SLUGS = new Set([
  'unknown',
  'project',
  'projects',
  'app',
  'repo',
  'dream',
]);

export function inferProjectHints({ cwd, messages = [], sampleUserText = '', fileName = '', knownProjects = [] }) {
  const signals = [];
  const registry = buildKnownProjectRegistry(knownProjects);
  const observedTexts = collectObservedTexts(messages, sampleUserText, fileName);

  if (cwd) {
    const cwdSignals = inferFromCwd(cwd, registry);
    signals.push(...cwdSignals);
  }

  for (const text of observedTexts) {
    const textSignals = inferFromText(text, registry);
    signals.push(...textSignals);
  }

  const projectHints = rankSignals(signals);
  const primaryProjectHint = projectHints[0] || null;

  return {
    primaryProjectHint,
    projectHints,
    projectSignals: signals,
  };
}

function buildKnownProjectRegistry(knownProjects) {
  const registry = new Map();

  for (const item of knownProjects || []) {
    const slug = slugify(item?.slug || item?.name || '');
    if (!slug) continue;

    const aliases = new Set([
      slug,
      String(item?.name || '').trim().toLowerCase(),
      ...(Array.isArray(item?.aliases) ? item.aliases.map((alias) => String(alias).trim().toLowerCase()) : []),
    ].filter(Boolean));

    registry.set(slug, {
      slug,
      name: item?.name || slug,
      aliases: Array.from(aliases),
    });
  }

  return registry;
}

function collectObservedTexts(messages, sampleUserText, fileName) {
  const values = new Set();
  if (sampleUserText) values.add(sampleUserText);
  if (fileName) values.add(fileName);

  for (const message of messages || []) {
    if (!message?.text) continue;
    if (message.role !== 'user' && message.role !== 'system' && message.role !== 'developer') continue;
    values.add(message.text);
  }

  return Array.from(values);
}

function inferFromCwd(cwd, registry) {
  const normalized = String(cwd || '').trim();
  if (!normalized) return [];

  const segments = normalized
    .split(path.sep)
    .map((segment) => String(segment).trim())
    .filter(Boolean)
    .filter((segment) => !GENERIC_SEGMENTS.has(segment.toLowerCase()));

  const signals = [];
  for (const segment of segments) {
    const slug = normalizeProjectToken(segment);
    if (!slug || GENERIC_SLUGS.has(slug)) continue;

    const known = matchKnownProject(slug, registry);
    signals.push({
      slug: known?.slug || slug,
      label: known?.name || segment,
      source: 'cwd',
      signalType: 'path_segment',
      confidence: known ? 0.96 : 0.82,
      matchedText: segment,
    });
  }

  return dedupeSignals(signals);
}

function inferFromText(text, registry) {
  const normalizedText = String(text || '').toLowerCase();
  if (!normalizedText) return [];

  const signals = [];
  const tokens = tokenize(normalizedText);

  for (const token of tokens) {
    const slug = normalizeProjectToken(token);
    if (!slug || GENERIC_SLUGS.has(slug)) continue;

    const known = matchKnownProject(slug, registry);
    if (known) {
      signals.push({
        slug: known.slug,
        label: known.name,
        source: 'text',
        signalType: 'known_alias',
        confidence: 0.88,
        matchedText: token,
      });
      continue;
    }

    if (looksLikeProjectSlug(slug)) {
      signals.push({
        slug,
        label: token,
        source: 'text',
        signalType: 'slug_pattern',
        confidence: 0.58,
        matchedText: token,
      });
    }
  }

  return dedupeSignals(signals);
}

function matchKnownProject(slug, registry) {
  if (registry.has(slug)) return registry.get(slug);

  for (const entry of registry.values()) {
    if (entry.aliases.includes(slug)) return entry;
  }

  return null;
}

function rankSignals(signals) {
  const grouped = new Map();

  for (const signal of signals || []) {
    const key = signal.slug;
    const current = grouped.get(key) || {
      slug: signal.slug,
      label: signal.label,
      confidence: 0,
      sources: new Set(),
      signalTypes: new Set(),
      matchedTexts: new Set(),
      evidenceCount: 0,
    };

    current.confidence += signal.confidence;
    current.sources.add(signal.source);
    current.signalTypes.add(signal.signalType);
    current.matchedTexts.add(signal.matchedText);
    current.evidenceCount += 1;
    grouped.set(key, current);
  }

  return Array.from(grouped.values())
    .map((item) => {
      const normalizedConfidence = Math.min(1, Number((item.confidence / Math.max(item.evidenceCount, 1)).toFixed(2)));
      const multiSourceBonus = item.sources.size >= 2 ? 0.08 : 0;
      const finalConfidence = Math.min(1, Number((normalizedConfidence + multiSourceBonus).toFixed(2)));

      return {
        slug: item.slug,
        label: item.label,
        confidence: finalConfidence,
        sources: Array.from(item.sources),
        signalTypes: Array.from(item.signalTypes),
        matchedTexts: Array.from(item.matchedTexts).slice(0, 8),
        evidenceCount: item.evidenceCount,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || b.evidenceCount - a.evidenceCount || a.slug.localeCompare(b.slug));
}

function dedupeSignals(signals) {
  const seen = new Set();
  return (signals || []).filter((signal) => {
    const key = [signal.slug, signal.source, signal.signalType, signal.matchedText].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenize(text) {
  return String(text || '')
    .replace(/[^a-z0-9_\-\/]+/gi, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap((token) => token.split('/').filter(Boolean));
}

function looksLikeProjectSlug(value) {
  if (!value) return false;
  if (/^\d{2}_[a-z0-9][a-z0-9_-]*$/i.test(value)) return true;
  if (/^[a-z0-9][a-z0-9_-]{2,}$/i.test(value) && /[_-]/.test(value)) return true;
  return false;
}

function normalizeProjectToken(value) {
  return slugify(String(value || '').replace(/\.git$/i, ''));
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
