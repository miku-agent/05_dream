import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeMeaningfulText } from './text-cleaning.mjs';
import { inferProjectHints } from './project-detection.mjs';

export async function discoverSessionsForDate({ sessionsDir, startMs, endMs, limit = null, knownProjects = [] }) {
  const names = await readdir(sessionsDir);
  const files = names
    .filter((name) => name.endsWith('.jsonl'))
    .filter((name) => !name.includes('.deleted.') && !name.includes('.reset.'))
    .filter((name) => !name.endsWith('.lock'))
    .sort();

  const sessions = [];
  let filesScanned = 0;

  for (const name of files) {
    if (limit && sessions.length >= limit) break;
    filesScanned += 1;

    const filePath = path.join(sessionsDir, name);
    const transcript = await readJsonl(filePath);
    if (transcript.length === 0) continue;

    const session = normalizeSessionFile(name, transcript, filePath, { knownProjects });
    if (!session.lastMessageAtMs) continue;
    if (session.lastMessageAtMs < startMs || session.lastMessageAtMs > endMs) continue;

    sessions.push(session);
  }

  return { filesScanned, sessions };
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeSessionFile(fileName, rows, filePath, { knownProjects = [] } = {}) {
  const sessionRow = rows.find((row) => row.type === 'session') || rows[0];
  const messageRows = rows.filter((row) => row.type === 'message' && row.message);

  const normalizedMessages = messageRows.map((row, index) => {
    const text = extractText(row.message?.content);
    return {
      id: row.id || `${fileName}:${index + 1}`,
      seqNo: index + 1,
      role: row.message?.role || 'unknown',
      timestamp: row.timestamp || row.message?.timestamp || null,
      author: row.message?.author || null,
      text,
      charCount: text.length,
    };
  });

  const lastMessage = normalizedMessages.at(-1);
  const meaningfulUserText = summarizeMeaningfulText(normalizedMessages, '요약 가능한 user text 없음');
  const roleCounts = normalizedMessages.reduce((acc, message) => {
    acc[message.role] = (acc[message.role] || 0) + 1;
    return acc;
  }, {});
  const projectDetection = inferProjectHints({
    cwd: sessionRow.cwd || null,
    messages: normalizedMessages,
    sampleUserText: meaningfulUserText,
    fileName,
    knownProjects,
  });

  return {
    externalSessionId: sessionRow.id || fileName.replace(/\.jsonl$/, ''),
    fileName,
    filePath,
    cwd: sessionRow.cwd || null,
    startedAt: sessionRow.timestamp || null,
    startedAtMs: safeMs(sessionRow.timestamp),
    lastMessageAt: lastMessage?.timestamp || null,
    lastMessageAtMs: safeMs(lastMessage?.timestamp),
    messageCount: normalizedMessages.length,
    charCount: normalizedMessages.reduce((sum, message) => sum + message.charCount, 0),
    roles: Array.from(new Set(normalizedMessages.map((message) => message.role))),
    roleCounts,
    sampleUserText: meaningfulUserText,
    messages: normalizedMessages,
    transcriptChecksum: buildTranscriptChecksum(normalizedMessages),
    primaryProjectHint: projectDetection.primaryProjectHint,
    projectHints: projectDetection.projectHints,
    projectSignals: projectDetection.projectSignals,
  };
}

function buildTranscriptChecksum(messages) {
  const seed = messages
    .map((message) => `${message.seqNo}|${message.role}|${message.timestamp || ''}|${message.text}`)
    .join('\n');

  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }

  return `v0-${hash.toString(16)}`;
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function safeMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
