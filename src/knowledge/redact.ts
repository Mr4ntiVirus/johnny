// Redaction. Two levels:
//   redactSecrets — ALWAYS applied before anything is stored as a fact /
//     observation / model, so credentials pasted into sessions never get
//     promoted into the durable knowledge layer.
//   redactPII — additionally applied before any text leaves the machine for an
//     external service: emails, phone numbers, IPs.

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bre_[A-Za-z0-9_]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, '$1:[REDACTED]@'],
  // password: xxx / secret=xxx / token = xxx / api_key: xxx
  [/\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b(\s*[:=]\s*)(["']?)[^\s"',;]{6,}\3/gi, '$1$2[REDACTED]'],
];

const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [/(?<!\d)(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, '[PHONE]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

export function redactPII(text: string): string {
  let out = redactSecrets(text);
  for (const [re, sub] of PII_PATTERNS) out = out.replace(re, sub);
  return out;
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
