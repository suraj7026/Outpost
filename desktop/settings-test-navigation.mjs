import { readFileSync } from 'node:fs';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise current source without a Vite/native build or stale dist artifacts.
// The resulting assets exist only in memory and all IPC is supplied by each test.
export async function settingsTestAssets() {
  const { build } = await import('esbuild');
  const root = dirname(fileURLToPath(import.meta.url));
  const output = resolve(root, '.settings-test-memory');
  const result = await build({
    absWorkingDir: root, entryPoints: ['src/main.tsx'], outdir: output,
    bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'dataurl', '.png': 'file' },
  });
  const assets = new Map(result.outputFiles.map(file => [`/${relative(output, file.path)}`, file.contents]));
  assets.set('/index.html', Buffer.from(readFileSync(resolve(root, 'index.html'), 'utf8').replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="/main.css"><script type="module" src="/main.js"></script>')));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png' };
  return (request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    const content = assets.get(path === '/' ? '/index.html' : path);
    if (!content) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', types[extname(path === '/' ? '/index.html' : path)] || 'application/octet-stream');
    response.end(content);
  };
}

// Exercise the same navigation links as the desktop UI; never touch live IPC.
export async function openSettings(page, { server = 'legacy', tab = 'general', page: destination = 'server' } = {}) {
  const setup = page.getByRole('dialog', { name: 'Server setup', exact: true });
  if (await setup.isVisible()) await setup.getByRole('button', { name: 'Close server setup', exact: true }).click();
  await page.locator(page.viewportSize().width <= 780 ? '.app-shell.sidebar-overlay' : '.app-shell.sidebar-push').waitFor();
  if (await page.locator('.web-sidebar').getAttribute('aria-hidden') === 'true') {
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  }
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  if (destination === 'home' || destination === 'appearance') {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.settings-link-list a[href="#machines"]').waitFor();
    if (destination === 'appearance') {
      await page.locator('.settings-link-list a[href="#settings/appearance"]').click();
      await page.getByRole('heading', { name: 'Appearance', level: 1, exact: true }).waitFor();
    }
    return;
  }
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Machines', exact: true }).click();
  await page.locator('.server-settings-list').waitFor();
  if (destination === 'servers') return;
  if (destination === 'add') {
    await page.getByRole('link', { name: 'Add server', exact: true }).click();
    await page.getByRole('heading', { name: 'Add server', level: 1, exact: true }).waitFor();
    await setup.getByRole('button', { name: 'Connect with a URL', exact: true }).click();
    return;
  }
  await page.locator(`.server-settings-list a[data-server-id="${server}"]`).click();
  await page.locator('.server-settings-tabs').waitFor();
  if (tab !== 'general') await serverTab(page, tab);
}
export async function serverTab(page, tab) {
  await page.locator(`.server-settings-tabs a[href$="/${tab}"]`).click();
  await page.locator(`.server-settings-tabs a[aria-current="page"][href$="/${tab}"]`).waitFor();
}
