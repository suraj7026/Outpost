import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright-camoufox';
import type { LaunchOptions } from 'playwright-camoufox';
import { z } from 'zod';

export const browserEngine = 'camoufox' as const;
const execute = promisify(execFile);
const launcher = fileURLToPath(new URL('../browser-engine/launch.py', import.meta.url));
const defaultPython = fileURLToPath(new URL('../browser-engine/.venv/bin/python', import.meta.url));
const Options = z.strictObject({
  executable_path: z.string().min(1), args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  firefox_user_prefs: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])),
  headless: z.literal(true),
});

export async function camoufoxOptions(python = defaultPython, signal?: AbortSignal): Promise<LaunchOptions> {
  const environment = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'].flatMap(key =>
    process.env[key] ? [[key, process.env[key]!]] : []));
  let stdout: string;
  try {
    ({ stdout } = await execute(python, [launcher], { env: environment, timeout: 45000, maxBuffer: 2 * 1024 * 1024, signal }));
  } catch {
    signal?.throwIfAborted();
    throw new Error('Camoufox is unavailable. Install the pinned browser engine and its browser build before starting browser work.');
  }
  const options = Options.parse(JSON.parse(stdout));
  if (Object.keys(options.env).some(key => !key.startsWith('CAMOU_') && !key.startsWith('FONTCONFIG_'))) {
    throw new Error('Unexpected Camoufox launch environment');
  }
  return { executablePath: options.executable_path, args: options.args, headless: true,
    firefoxUserPrefs: options.firefox_user_prefs, env: { ...environment, ...options.env } };
}

export async function openTaskBrowser(directory: string, python?: string, signal?: AbortSignal) {
  const options = await camoufoxOptions(python, signal);
  signal?.throwIfAborted();
  const context = await firefox.launchPersistentContext(directory, {
    ...options, viewport: { width: 1280, height: 800 }, acceptDownloads: true,
  });
  if (signal?.aborted) { await context.close(); signal.throwIfAborted(); }
  return context;
}

export async function openBrowser() {
  return firefox.launch(await camoufoxOptions());
}
