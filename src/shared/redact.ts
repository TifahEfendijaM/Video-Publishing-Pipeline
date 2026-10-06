// Redaction for anything that may reach logs or the GitHub Summary.

const PATTERNS: [RegExp, string][] = [
  [/(authorization:\s*)(bearer|oauth|token)\s+[^\s"',]+/gi, "$1$2 [REDACTED]"],
  [/\b(bearer|oauth)\s+[A-Za-z0-9._\-~+/=]{8,}/gi, "$1 [REDACTED]"],
  [/([?&](access_token|input_token|refresh_token|client_secret|code|key|token|sig|signature|X-Amz-[A-Za-z-]+)=)[^&\s"']+/gi, "$1[REDACTED]"],
  [/("?(access_token|refresh_token|id_token|client_secret|api_key|apiKey|token|password|secret|private_key|claim_token)"?\s*[:=]\s*")[^"]*"/gi, '$1[REDACTED]"'],
  [/\bEAA[A-Za-z0-9]{20,}/g, "[REDACTED_META_TOKEN]"],
  [/\bya29\.[A-Za-z0-9._\-]+/g, "[REDACTED_GOOGLE_TOKEN]"],
  [/\b1\/\/[A-Za-z0-9._\-]{20,}/g, "[REDACTED_GOOGLE_REFRESH]"],
  [/\bsk-ant-[A-Za-z0-9_\-]+/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/https:\/\/[^\s"']*r2\.cloudflarestorage\.com[^\s"']*/g, "[REDACTED_SIGNED_URL]"],
];

const registered = new Set<string>();

/** Register exact secret values (from env) so they are always replaced, whatever their format. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) registered.add(value);
}

export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : safeStringify(input);
  for (const v of registered) s = s.split(v).join("[REDACTED]");
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Shorten provider error text to a safe single-line summary (no raw dumps). */
export function summarizeError(e: unknown, max = 300): string {
  const s = redact(e).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
