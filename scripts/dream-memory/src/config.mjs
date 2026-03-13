import fs from 'node:fs';
import path from 'node:path';

export function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) continue;

    const [key, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

export function loadConfig(args = {}) {
  const workspaceRoot = '/Users/bini/.openclaw/workspace';
  const sessionsDir = args['sessions-dir'] || process.env.DREAM_SESSIONS_DIR || '/Users/bini/.openclaw/agents/miku/sessions';
  const memoryRoot = args['memory-root'] || process.env.DREAM_MEMORY_ROOT || workspaceRoot;
  const timeZone = args.tz || process.env.DREAM_MEMORY_TZ || 'Asia/Seoul';
  const date = normalizeDateArg(args.date || process.env.DREAM_MEMORY_DATE || 'yesterday');
  const dryRun = booleanArg(args['dry-run'], true);
  const archiveToSupabase = booleanArg(args.archive ?? process.env.DREAM_ARCHIVE_TO_SUPABASE, false);
  const writePromotions = booleanArg(args.promote ?? process.env.DREAM_WRITE_PROMOTIONS, false);
  const purgeDryRun = booleanArg(args.purge ?? process.env.DREAM_PURGE_DRY_RUN, false);
  const limit = positiveIntOrNull(args.limit ?? process.env.DREAM_LIMIT);
  const envBridge = loadSupabaseBridgeEnv(workspaceRoot);

  return {
    workspaceRoot,
    sessionsDir: path.resolve(sessionsDir),
    memoryRoot: path.resolve(memoryRoot),
    timeZone,
    date,
    dryRun,
    archiveToSupabase,
    writePromotions,
    purgeDryRun,
    limit,
    knownProjects: loadKnownProjects(workspaceRoot),
    supabaseUrl: process.env.DREAM_SUPABASE_URL || envBridge.supabaseUrl || '',
    supabaseKey: process.env.DREAM_SUPABASE_SERVICE_ROLE_KEY || envBridge.supabaseKey || '',
  };
}

function normalizeDateArg(value) {
  if (!value || value === true) return 'yesterday';
  return String(value).trim();
}

function booleanArg(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function positiveIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function loadSupabaseBridgeEnv(workspaceRoot) {
  const envPath = path.join(workspaceRoot, '03_supabase', '.env');
  const parsed = safeParseEnvFile(envPath);
  return {
    supabaseUrl: parsed.API_EXTERNAL_URL || '',
    supabaseKey: parsed.SERVICE_ROLE_KEY || '',
  };
}

function loadKnownProjects(workspaceRoot) {
  try {
    const names = fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d{2}_[a-z0-9][a-z0-9_-]*$/i.test(name));

    return names.map((name) => ({
      slug: name.toLowerCase(),
      name,
      aliases: buildProjectAliases(name),
    }));
  } catch {
    return [];
  }
}

function buildProjectAliases(name) {
  const lowered = String(name || '').toLowerCase();
  const aliases = new Set([lowered]);
  const withoutPrefix = lowered.replace(/^\d{2}_/, '');
  if (withoutPrefix && withoutPrefix !== lowered) aliases.add(withoutPrefix);
  aliases.add(lowered.replace(/_/g, '-'));
  if (withoutPrefix) aliases.add(withoutPrefix.replace(/_/g, '-'));
  return Array.from(aliases).filter(Boolean);
}

function safeParseEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const entries = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      entries[key] = rest.join('=').trim();
    }
    return entries;
  } catch {
    return {};
  }
}
