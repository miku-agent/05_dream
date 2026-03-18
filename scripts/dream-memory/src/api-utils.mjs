export function sanitizeApiKey(text) {
  return String(text || '').replace(/key=[^&\s"']+/gi, 'key=REDACTED');
}
