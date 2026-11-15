import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { managementError } from './contracts.js';

export function runtimeRelease(path: string, profile: string) {
  const manifest = z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9._-]+$/), piVersion: z.string(), lockHash: z.string().length(64), profile: z.string() }).parse(JSON.parse(readFileSync(path,'utf8')));
  const root = dirname(resolve(path));
  if (manifest.piVersion !== VERSION || manifest.profile !== profile || createHash('sha256').update(readFileSync(join(root,'package-lock.json'))).digest('hex') !== manifest.lockHash)
    throw managementError('pi_release_mismatch');
  const installed = realpathSync(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  if (!installed.startsWith(realpathSync(join(root,'node_modules')) + '/')) throw managementError('pi_installation_mismatch');
  return manifest;
}
