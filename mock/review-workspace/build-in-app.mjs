import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(root, '../../desktop');
const require = createRequire(resolve(desktop, 'package.json'));
const { build } = await import(require.resolve('vite'));
const output = resolve(root, '.in-app-build');
mkdirSync(output, { recursive: true });
const script = name => readFileSync(resolve(root, name), 'utf8').replace(/<\/script/gi, '<\\/script');
const font = readFileSync(resolve(desktop, 'src/assets/fonts/GoogleSansFlex.woff2')).toString('base64');
let reviewer = readFileSync(resolve(root, 'index.html'), 'utf8');
reviewer = reviewer.replace('<link rel="stylesheet" href="../../desktop/src/fonts.css">', `<style>@font-face{font-family:"Google Sans Flex";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:1 1000}</style>`);
reviewer = reviewer.replace('<link rel="stylesheet" href="styles.css">', `<style>${readFileSync(resolve(root, 'styles.css'), 'utf8')}</style>`);
reviewer = reviewer.replace('<script src="sample-data.js"></script>', () => `<script>${script('sample-data.js')}</script>`);
reviewer = reviewer.replace('<script src="app.js"></script>', () => `<script>${script('app.js')}</script>`);
reviewer = reviewer.replace(/(<label class="file-filter">[\s\S]*?<\/label>)/, '<div class="file-filter-row">$1</div>');
reviewer = reviewer.replace('</head>', `<style>
:root{--bg:#16171a;--side:#16171a;--raised:#1c1d21;--line:#26282c;--active:#26282c;--text:#ededef;--muted:#a1a3a8}
.app{height:100dvh;min-height:0;grid-template-rows:minmax(0,1fr)}
.topbar,.mobile-nav,.chat,.statusbar{display:none!important}
.workspace,.workspace.focus,.workspace.files-hidden{height:100%;display:grid!important;grid-template-columns:minmax(0,1fr) 210px!important}
.workspace .editor{display:flex!important;height:100%;min-height:0}
.workspace .explorer{display:block!important;position:static!important;width:auto!important;box-shadow:none!important}
.tabs{background:var(--bg);height:48px;padding:0 8px}
.tab{font-size:13px;padding-inline:12px}
.document-toolbar{padding:10px 16px;flex-wrap:wrap;min-height:48px}
.crumb{font-size:11px;gap:5px;width:auto}
.modes{margin-left:auto}
.document-info{padding:9px 16px;font-size:11px;gap:5px}
.document-info .time{display:none}
.prose{padding:30px 34px;font-size:14px;max-width:790px}
.prose h1{font-size:28px}.prose .lead{font-size:14px}.prose h2{font-size:18px}
.tree details>summary{font-size:10px}.outline button{font-size:12px}
.sidebar-note{font-size:11px}
.tabs #expand{display:none}.browser-page{padding:26px}.browser-page .prose{padding-inline:0}
@media(max-width:760px){.workspace,.workspace.focus,.workspace.files-hidden{grid-template-columns:minmax(0,1fr) 178px!important}.prose{padding:26px 22px}.tree details>summary{overflow:hidden;font-size:9px}.document-info .right button{font-size:10px;padding:4px}.browser-page{padding:22px}.web-heading{font-size:12px}}
@media(max-width:520px){.workspace,.workspace.focus,.workspace.files-hidden{grid-template-columns:minmax(0,1fr)!important}.workspace .explorer{display:none!important}.workspace-files-toggle{display:none!important}}
:root[data-files-collapsed] .workspace{grid-template-columns:minmax(0,1fr)!important}
:root[data-files-collapsed] .workspace .explorer{display:none!important}
.tabs .workspace-files-toggle{align-self:center;height:30px;color:var(--muted);font-size:12px;flex:none}
.tabs .workspace-files-toggle{padding:5px 8px;gap:6px}

.tabs .workspace-files-toggle[aria-expanded=true]{color:var(--text);background:var(--raised)}

:root{--review-radius-group:12px;--review-radius-control:8px}
.tabs{height:52px;align-items:center;padding:8px;gap:4px}
.tabs .tab{height:34px;border-radius:var(--review-radius-control);padding:0 12px}
.tabs .tab.active:after{display:none}
.tabs .tab.active{background:var(--active)}
.modes{border-radius:var(--review-radius-group);padding:3px}
.modes button,.document-info button,.file-switch button,.file-row,.outline button{border-radius:var(--review-radius-control)}
.file-filter,.address,.repo-list{border-radius:var(--review-radius-group)}
.tabs .workspace-files-toggle{border-radius:var(--review-radius-control)}

.browser-foot button{border-radius:var(--review-radius-control)}
:root{--workspace-header-height:52px;--workspace-toolbar-height:52px;--workspace-meta-height:44px}
.tabs,.explorer .panel-heading{height:var(--workspace-header-height);min-height:var(--workspace-header-height);flex-shrink:0;border-bottom:1px solid var(--line)}
.document-toolbar,.browser-address,.file-filter-row{height:var(--workspace-toolbar-height);min-height:var(--workspace-toolbar-height);flex-shrink:0;border-bottom:1px solid var(--line);box-sizing:border-box}
.document-toolbar{flex-wrap:nowrap;gap:10px;padding:8px 16px}
.document-toolbar .crumb{flex:1;min-width:0}
.document-info,.browser-label,.file-switch{height:var(--workspace-meta-height);min-height:var(--workspace-meta-height);flex-shrink:0;border-bottom:1px solid var(--line);box-sizing:border-box}
.file-filter-row{display:flex;align-items:center;padding:8px 12px}
.file-filter-row .file-filter{height:34px;width:100%;margin:0;min-width:0}
.file-switch{align-items:center;padding:6px 12px;gap:4px}
.explorer .panel-heading{padding-inline:14px}
@media(max-width:680px){
  :root{--workspace-toolbar-height:84px}
  .document-toolbar{flex-wrap:wrap;gap:6px}
  .document-toolbar .crumb{flex-basis:100%;width:100%}
}
</style></head>`);
await build({
  configFile: false,
  root: desktop,
  logLevel: 'warn',
  define: { __REVIEW_DOCUMENT__: JSON.stringify(reviewer), 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: output, emptyOutDir: true, cssCodeSplit: false,
    lib: { entry: resolve(root, 'in-app-entry.js'), name: 'OutpostReviewPreview', formats: ['iife'], fileName: () => 'app.js' },

  },
});
const css = readdirSync(output).filter(name => name.endsWith('.css')).map(name => readFileSync(resolve(output, name), 'utf8')).join('\n');
const js = readFileSync(resolve(output, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
writeFileSync(resolve(root, 'in-app.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Outpost — In-app review preview</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`);
console.log('Built offline preview using the real Outpost React app: mock/review-workspace/in-app.html');
