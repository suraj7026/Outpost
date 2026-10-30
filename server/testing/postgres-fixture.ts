import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PostgresConfig } from '../storage/postgres.js';

const execute = promisify(execFile);
export interface PostgresFixture { config: PostgresConfig; version: string; stop(): Promise<void> }
/** Only creates/removes its own mkdtemp cluster. Never reads DATABASE_URL/PGHOST. */
export async function startPostgresFixture(binaryDirectory = '/opt/homebrew/opt/postgresql@16/bin'): Promise<PostgresFixture> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') && key !== 'DATABASE_URL'));
  const run = (binary: string, args: string[]) => execute(join(binaryDirectory, binary), args, { env: environment, timeout: 30000 });
  const version = (await run('postgres', ['--version'])).stdout.trim();
  // Short path avoids the Unix socket sockaddr limit on macOS. mkdtemp creates mode 0700.
  const root = await mkdtemp('/tmp/outpost-pg-'), data = join(root, 'data'), socket = join(root, 'socket');
  let started = false, stopped = false;
  const stop = async () => {
    if (stopped) return;
    if (started) await run('pg_ctl', ['-D',data,'-m','immediate','-w','stop']);
    await rm(root, { recursive: true, force: true }); stopped = true;
  };
  try {
    await mkdir(socket, { mode: 0o700 });
    await run('initdb', ['-D',data,'-U','outpost_fixture','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8']);
    // No TCP listener, unique private socket directory, no ambient config file.
    await run('pg_ctl', ['-D',data,'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 5432 -c fsync=on`,'-w','start']);
    started = true;
    return { version, config: { host: socket, port: 5432, database: 'postgres', user: 'outpost_fixture', password: '', ssl: false }, stop };
  } catch {
    // A startup timeout can still leave our own server running; pg_ctl status targets only this data dir.
    if (!started) { try { await run('pg_ctl', ['-D',data,'status']); started = true; } catch { /* Not running. */ } }
    await stop(); throw new Error('Private PostgreSQL fixture startup failed');
  }
}
