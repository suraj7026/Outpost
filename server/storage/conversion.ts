import { canonical, requireThat } from '../core/contracts.js';
import type { Json } from '../core/contracts.js';

/** Wire/import counters must round-trip exactly, including PostgreSQL int8 text. */
export function safeInteger(value: unknown, minimum = 0): number {
  requireThat(typeof value === 'number' || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)), 'invalid_integer');
  const number = Number(value);
  requireThat(Number.isSafeInteger(number) && number >= minimum, 'invalid_integer');
  return number;
}
export function jsonText(value: unknown): string {
  const visit = (item: unknown): void => {
    if (typeof item === 'number') requireThat(Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)), 'invalid_json_number');
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  // canonical rejects non-JSON types before recursive numeric validation.
  const text = canonical(value); visit(value); return text;
}
export function parseJson(text: string): Json {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('invalid_stored_json'); }
  jsonText(value);
  // JSON.parse silently rounds oversized numeric literals before validation. Compare each
  // source number with its shortest JS round-trip decimal, ignoring harmless notation changes.
  const decimal = (token: string): string => {
    const [mantissa = '', exponent = '0'] = token.toLowerCase().split('e');
    const [whole = '', fraction = ''] = mantissa.split('.');
    const negative = whole.startsWith('-');
    let digits = (whole.replace('-', '') + fraction).replace(/^0+/, '');
    if (!digits) return '0';
    let scale = BigInt(exponent) - BigInt(fraction.length);
    while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale++; }
    return `${negative ? '-' : ''}${digits}e${scale}`;
  };
  const tokens = /"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  for (const token of text.matchAll(tokens)) {
    if (token[1]) requireThat(decimal(token[1]) === decimal(JSON.stringify(Number(token[1]))), 'invalid_json_number');
  }
  return value as Json;
}
/** Store original ISO text, never a driver Date (which loses original formatting). */
export function timestampText(value: unknown): string {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'invalid_timestamp');
  return value;
}
