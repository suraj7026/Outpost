import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { Devices } from '../policy/trust.js';
import { Installation } from './installation.js';

const Enrollment = z.strictObject({ environmentId: z.uuid(), deviceId: z.uuid(), publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), name: z.string().min(1).max(80) });

/** Publish a new, pre-enrolled ledger atomically; never reopen bootstrap on existing data. */
export function initializeInstallation(root: string, input: unknown) {
  const enrollment = Enrollment.parse(input);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const destination = join(root, 'ledger.sqlite');
  if (existsSync(destination)) throw new Error('existing_installation_enrollment_forbidden');
  const temporary = join(root, 'ledger.initialize.sqlite');
  closeSync(openSync(temporary, 'wx', 0o600));
  const db = new Ledger(temporary);
  try {
    db.transaction(() => {
      db.db.exec('CREATE TABLE installation_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), environment_id TEXT NOT NULL)');
      db.db.prepare('INSERT INTO installation_identity VALUES(1,?)').run(enrollment.environmentId);
      new Devices(db).pair(enrollment.deviceId, enrollment.name, enrollment.publicKey);
    });
    new Installation(db).requireTarget(enrollment.environmentId);
  } finally { db.close(); }
  const file = openSync(temporary, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
  linkSync(temporary, destination); // Fails rather than replacing an existing authority.
  unlinkSync(temporary);
  const directory = openSync(root, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  return { environmentId: enrollment.environmentId, deviceId: enrollment.deviceId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 8192) throw new Error('enrollment_too_large'); chunks.push(Buffer.from(chunk));
  }
  const root = process.env.OUTPOST_DATA;
  if (!root?.startsWith('/')) throw new Error('absolute_data_directory_required');
  initializeInstallation(root, JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
