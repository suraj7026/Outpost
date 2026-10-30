import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebResearchError, webAbortable, webRequire } from './web-contracts.js';

export type WebResolver = (hostname: string) => Promise<readonly string[]>;
export const resolveWebHost: WebResolver = async hostname => (await lookup(hostname, { all: true })).map(item => item.address);

/** Conservative public-unicast filter. URL parsing first normalizes octal/hex/integer IPv4.
 * IPv6 transition/embedded IPv4 and special-purpose allocations are deliberately refused.
 */
export function isPublicWebAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 88 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
    && !/^200[12]:/i.test(address) && !/^3fff:/i.test(address);
}

export function canonicalWebUrl(raw: string): string {
  webRequire(typeof raw === 'string' && raw.length <= 2048 && !/[\s\\\u0000-\u001f\u007f]/.test(raw), 'unsafe_url');
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebResearchError('unsafe_url'); }
  webRequire(url.protocol === 'https:' || url.protocol === 'http:', 'unsafe_url');
  // No opaque credential guessing: query strings and fragments are not accepted in this slice.
  webRequire(!url.username && !url.password && !raw.includes('?') && !raw.includes('#'), 'unsafe_url');
  webRequire(!url.port || url.port === '80' || url.port === '443', 'unsafe_url');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new WebResearchError('unsafe_url'); }
  webRequire(!/%[0-9a-f]{2}/i.test(path) && !/(?:token|secret|password|passwd|api[-_]?key|authorization|bearer|credential|signature)[=:/_-]/i.test(path), 'unsafe_url');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  webRequire(host.length > 0 && (isIP(host) !== 0 || host.includes('.')), 'unsafe_url');
  webRequire(!/(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host), 'unsafe_url');
  webRequire(!isIP(host) || isPublicWebAddress(host), 'unsafe_url');
  url.hostname = isIP(host) === 6 ? `[${host}]` : host;
  return url.href;
}

export async function validateWebTarget(raw: string, resolver: WebResolver, signal: AbortSignal): Promise<string> {
  const canonical = canonicalWebUrl(raw);
  const host = new URL(canonical).hostname.replace(/^\[|\]$/g, '');
  webRequire(!signal.aborted, 'cancelled');
  let addresses: readonly string[];
  try { addresses = isIP(host) ? [host] : await webAbortable(resolver(host), signal); } catch { throw new WebResearchError(signal.aborted ? 'cancelled' : 'target_resolution_failed'); }
  webRequire(!signal.aborted, 'cancelled');
  webRequire(addresses.length > 0 && addresses.every(isPublicWebAddress), 'unsafe_url');
  return canonical;
}
