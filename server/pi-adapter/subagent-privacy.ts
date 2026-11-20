export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export const nativeId = (value: unknown) => typeof value === 'string' && value !== '.' && value !== '..' && /^[a-zA-Z0-9_.:|+-]{1,256}$/.test(value) ? value : undefined;
const privateKey = /auth|secret|password|passwd|token|credential|cookie|api.?key|signature|thinking|reasoning|system.?prompt|capability|controlInbox|session(File|Path|Root|Dir|Id)|asyncDir|transcriptPath|artifactPaths|environment|^env$|headers/i;

/** Content is untrusted: this is a bounded public projection, never a raw JSON dump. */
export class SubagentPrivacy {
  truncated = false;
  redacted = false;
  constructor(private secrets: readonly string[] = []) {}
  text(value: unknown, limit = 8192): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    if (value.length > 65536) { this.truncated = true; this.redacted = true; return undefined; }
    let text = value;
    for (const secret of this.secrets) if (secret) text = text.split(secret).join('[redacted]');
    text = text
      .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '[redacted]')
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '$1 [redacted]')
      .replace(/(["']?(?:authorization|[a-z0-9_-]*(?:api[_-]?key|token|password|passwd|secret|cookie|credential|signature|thinking|reasoning|system[_-]?prompt|capability|controlInbox|session(?:File|Path|Root|Dir|Id)|asyncDir|transcriptPath|artifactPaths|environment|headers)[a-z0-9_-]*|env)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{\["'][\s\S]*|[^\s,;}]+)/gi, '$1[redacted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
      .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
      .replace(/(?:file:\/\/|[A-Za-z]:[\\/]|~\/|(?<![\w/])\/(?!\/))[^\s"'<>`,;)}\]]+/g, '[path]')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
    if (text !== value.slice(0, 65536)) this.redacted = true;
    if (text.length > limit) { this.truncated = true; text = text.slice(0, limit); }
    return text || undefined;
  }
  arguments(value: unknown): string | undefined {
    let budget = 256;
    const visit = (item: unknown, depth: number): unknown => {
      if (--budget < 0 || depth > 6) { this.truncated = true; return '[omitted]'; }
      if (typeof item === 'string') return this.text(item, 2048);
      if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
      if (Array.isArray(item)) { if (item.length > 32) this.truncated = true; return item.slice(0, 32).map(value => visit(value, depth + 1)); }
      const result: Record<string, unknown> = Object.create(null);
      const entries = Object.entries(object(item));
      if (entries.length > 32) this.truncated = true;
      for (const [key, child] of entries.slice(0, 32)) {
        if (privateKey.test(key)) { this.redacted = true; continue; }
        const safe = this.text(key, 128);
        if (safe) result[safe] = visit(child, depth + 1);
      }
      return result;
    };
    if (value === undefined) return undefined;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return this.text(value, 4096); }
    }
    return this.text(JSON.stringify(visit(value, 0)), 4096);
  }
}

export function sensitiveToolArguments(value: unknown): boolean {
  const seen = new Set<object>();
  let budget = 256;
  const visit = (item: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 6) return true;
    if (typeof item === 'string') return item.length > 65536 || /(?:^|[\\/\s"'])\.env(?:[.\\/\s"']|$)|(?:auth|credentials|secrets)\.json|(?:^|[\\/\s"'])\.(?:aws|ssh|azure)[\\/]|PRIVATE KEY|(?:api[_-]?key|password|secret|token)\s*[:=]/i.test(item);
    if (!item || typeof item !== 'object') return false;
    if (seen.has(item)) return true;
    seen.add(item);
    const entries = Object.entries(item);
    return entries.length > 32 || entries.some(([key, value]) => privateKey.test(key) || visit(value, depth + 1));
  };
  if (typeof value === 'string') {
    if (value.length > 65536) return true;
    try { value = JSON.parse(value); } catch { return true; }
  }
  return !value || typeof value !== 'object' || Array.isArray(value) || visit(value, 0);
}

export function relativeFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f\\:]/.test(value) || value.startsWith('/') || value.startsWith('~')) return undefined;
  const parts = value.split('/');
  return parts.some(part => part === '..' || part === '' || part.startsWith('.env') || /^(auth|credentials|secrets)(\.|$)/i.test(part)) ? undefined : value;
}
