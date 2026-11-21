import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(desktop, '..');
const directory = resolve(desktop, 'tests');
const [mode = '--all', ...filters] = process.argv.slice(2);
if (!['--all', '--unit', '--browser'].includes(mode)) {
  console.error('Usage: npm --prefix desktop test -- [--all|--unit|--browser] [test filenames...]');
  process.exit(2);
}

const manual = new Set(['test-stream-ui.mjs', 'test-ui.mjs']);
const tests = readdirSync(directory).sort().filter(name => {
  if (!/^test-.*\.(ts|mjs)$/.test(name) || manual.has(name)) return false;
  const browser = /from ['"]playwright['"]/.test(readFileSync(resolve(directory, name), 'utf8'));
  return mode === '--all' || browser === (mode === '--browser');
});
const selected = filters.length ? [...new Set(filters)] : tests;
if (!selected.length || selected.some(name => !tests.includes(name))) {
  console.error('No matching automated tests (use exact test filenames; recording-based tests are manual).');
  process.exit(2);
}

const failed = [];
for (const name of selected) {
  const browser = /from ['"]playwright['"]/.test(readFileSync(resolve(directory, name), 'utf8'));
  const args = browser ? [] : ['--import', 'tsx', '--test'];
  const cwd = ['test-dialog-consistency.mjs', 'test-workspace-refinement.mjs'].includes(name) ? desktop : root;
  console.log(`\n== ${name} ==`);
  const result = spawnSync(process.execPath, [...args, resolve(directory, name)], {
    cwd, stdio: 'inherit', timeout: 180_000, killSignal: 'SIGKILL',
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(desktop, 'tsconfig.json') },
  });
  if (result.status !== 0) {
    if (result.error || result.signal) console.error(result.error?.message ?? result.signal);
    failed.push(name);
  }
}
console.log(`\n${selected.length - failed.length}/${selected.length} desktop test files passed.`);
if (failed.length) console.error(`Failed: ${failed.join(', ')}`);
process.exitCode = Number(failed.length > 0);
