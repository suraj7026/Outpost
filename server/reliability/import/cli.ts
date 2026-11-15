import { readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { jsonText } from '../../storage/conversion.js';
import { dryRun } from './dry-run.js';
import { check, SourceError } from './contracts.js';

/** Archive keys are exactly 32 raw bytes on stdin, never argv or environment. */
export function runCli(args: string[]): string {
  if (args.length === 6 && args[0] === 'sqlite' && args[1] === '--database' && args[3] === '--artifacts' && args[5] === '--frozen') {
    return jsonText(dryRun({ type: 'sqlite', database: args[2]!, artifactRoot: args[4]!, frozen: true }));
  }
  check(args.length === 3 && args[0] === 'outpost1' && args[1] === '--archive', 'invalid_arguments');
  const key = Buffer.alloc(33); let length = 0;
  try {
    while (length < key.length) { const n = readSync(0, key, length, key.length - length, null); if (!n) break; length += n; }
    check(length === 32, 'invalid_key_input');
    return jsonText(dryRun({ type: 'outpost1', archive: args[2]!, key: key.subarray(0, 32) }));
  } finally { key.fill(0); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(runCli(process.argv.slice(2)) + '\n'); }
  catch (error) { process.stderr.write((error instanceof SourceError ? error.code : 'source_validation_failed') + '\n'); process.exitCode = 1; }
}
