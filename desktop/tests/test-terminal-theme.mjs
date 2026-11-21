import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';

// Exercise the actual controller and xterm in a browser; only native IPC is synthetic.
// No app build, SSH connection, credentials, or external requests are needed.
const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('../src/server-terminal/controller.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`terminal theme lifecycle (${name})`, { timeout: 30_000 }, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ colorScheme: 'dark' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.abort());
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addStyleTag({ path: require.resolve('@xterm/xterm/css/xterm.css') });
      await page.addScriptTag({ path: require.resolve('@xterm/xterm') });
      await page.addScriptTag({ path: require.resolve('@xterm/addon-fit') });
      const checks = await page.evaluate(async source => {
        let checks = 0;
        const check = (value, label) => { if (!value) throw new Error(label); checks++; };
        const equal = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label);
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const settle = async () => { await frame(); await frame(); };
        const themeObservers = new Set();
        const NativeMutationObserver = window.MutationObserver;
        window.MutationObserver = class extends NativeMutationObserver {
          observe(target, options) {
            if (target === document.documentElement && options.attributeFilter?.includes('data-theme')) themeObservers.add(this);
            super.observe(target, options);
          }
          disconnect() { themeObservers.delete(this); super.disconnect(); }
        };
        const calls = [];
        let serial = 0;
        const target = { setupId: 'fixture', label: 'Fixture', host: 'fixture.invalid', user: 'fixture', port: 22, fingerprint: 'synthetic' };
        const modules = {
          '@xterm/xterm': { Terminal: window.Terminal },
          '@xterm/addon-fit': window.FitAddon,
          '../api': {
            nativeApp: () => true, recordedPreview: () => false,
            call: async (command, args) => {
              calls.push({ command, args });
              if (command === 'terminal_target') return target;
              if (command === 'terminal_open') return { sessionId: `session-${++serial}`, target };
              if (command === 'terminal_read') return new Promise(() => {});
              if (command === 'terminal_close' || command === 'terminal_resize') return;
              throw new Error(`Unexpected native command: ${command}`);
            },
          },
        };
        const exports = {};
        new Function('require', 'exports', source)(id => {
          if (!(id in modules)) throw new Error(`Unexpected import: ${id}`);
          return modules[id];
        }, exports);
        const { TerminalController, terminalFor, retainTerminals } = exports;
        const host = () => {
          const element = document.createElement('div');
          element.style.cssText = 'width:640px;height:240px';
          document.body.append(element);
          return element;
        };
        const setTheme = async theme => {
          if (theme === undefined) delete document.documentElement.dataset.theme;
          else document.documentElement.dataset.theme = theme;
          await settle();
        };
        const dark = { background: '#101113', foreground: '#ededef', cursor: '#c7c9cf', selectionBackground: '#44464b' };
        // Inspect effective xterm colors as well as public options: omitted dark ANSI
        // entries must restore defaults, not leave the previous light palette behind.
        const colors = terminal => {
          const value = terminal._core._themeService.colors;
          return {
            ansi: value.ansi.map(color => color.rgba),
            cursorAccent: value.cursorAccent.rgba,
            selectionForeground: value.selectionForeground?.rgba,
          };
        };
        let darkColors;
        for (const theme of [undefined, 'dark', 'light']) {
          await setTheme(theme);
          const controller = new TerminalController(`startup-${theme}`);
          const element = host();
          const detach = controller.attach(element);
          check(controller.terminal, 'terminal created');
          const palette = controller.terminal.options.theme;
          if (theme === 'light') {
            equal(palette.background, '#f1f2f4', 'light background matches app');
            equal(palette.foreground, '#24272d', 'light foreground matches app');
            equal(palette.cursorAccent, '#f1f2f4', 'light cursor text is legible');
            equal(palette.selectionForeground, '#24272d', 'light selection text is legible');
            const luminance = hex => {
              const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
                .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
            for (const key of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
              'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) {
              check(contrast(palette[key], palette.background) >= 4.5, `light ANSI ${key} contrast`);
            }
            check(contrast(palette.selectionForeground, palette.selectionBackground) >= 4.5, 'selection contrast');
          } else {
            equal(palette, dark, 'dark startup and missing attribute preserve current palette');
            darkColors = colors(controller.terminal);
          }
          detach(); controller.dispose(); element.remove();
          equal(themeObservers.size, 0, 'startup observer disposed');
        }
        equal(calls.length, 0, 'appearance alone never calls native IPC');

        await setTheme('dark');
        const controllers = [terminalFor('owner-a'), terminalFor('owner-b')];
        const hosts = controllers.map(host);
        const detaches = controllers.map((controller, index) => controller.attach(hosts[index]));
        await Promise.all(controllers.map(controller => controller.open()));
        await settle();
        equal(themeObservers.size, 2, 'one observer per retained emulator');
        const saved = [];
        for (const controller of controllers) {
          const terminal = controller.terminal;
          await new Promise(resolve => terminal.write('scrollback\r\n'.repeat(60) + '\x1b[31mred\x1b[0m\r\n$ ', resolve));
          terminal.scrollToLine(3);
          terminal.select(0, 4, 6);
          saved.push({ terminal, container: controller.container, session: controller.sessionId, snapshot: controller.getSnapshot() });
        }
        const state = terminal => {
          const buffer = terminal.buffer.active;
          return {
            lines: Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString()),
            cursor: [buffer.cursorX, buffer.cursorY], viewport: buffer.viewportY,
            selection: terminal.getSelection(), size: [terminal.cols, terminal.rows], stdin: terminal.options.disableStdin,
          };
        };
        const before = saved.map(({ terminal }) => state(terminal));
        const callsBefore = JSON.stringify(calls);
        detaches[1]();
        for (const theme of ['light', 'dark', 'light']) {
          await setTheme(theme);
          controllers.forEach((controller, index) => {
            equal(controller.terminal.options.theme.background, theme === 'light' ? '#f1f2f4' : '#101113', 'live and detached terminals follow theme');
            check(controller.terminal === saved[index].terminal && controller.container === saved[index].container, 'no emulator remount');
            check(controller.sessionId === saved[index].session && controller.getSnapshot() === saved[index].snapshot, 'session and connection state unchanged');
            equal(state(controller.terminal), before[index], 'buffer, cursor, scroll, selection, geometry and input unchanged');
            if (theme === 'dark') equal(colors(controller.terminal), darkColors, 'dark ANSI and optional colors restored');
          });
        }
        equal(JSON.stringify(calls), callsBefore, 'theme changes do not open, close, resize or write to native sessions');
        const detachAgain = controllers[1].attach(hosts[1]);
        await settle();
        equal(themeObservers.size, 2, 'reattachment does not duplicate observers');
        check(controllers[1].terminal === saved[1].terminal, 'reattachment preserves emulator');
        detaches[0](); detachAgain();
        await Promise.all(controllers.map(controller => controller.disconnect()));
        await setTheme('dark');
        equal(controllers[0].terminal.options.theme, dark, 'disconnected retained buffer still follows theme');

        // Fill the retention limit and evict an idle, detached emulator.
        for (const id of ['owner-c', 'owner-d', 'owner-e']) {
          const controller = terminalFor(id);
          const element = host();
          controller.attach(element)(); element.remove();
        }
        check(!controllers[0].terminal, 'old idle emulator evicted');
        equal(themeObservers.size, 4, 'eviction disconnects observer');
        await setTheme('light');
        controllers[0].attach(hosts[0])();
        equal(controllers[0].terminal.options.theme.background, '#f1f2f4', 'recreated emulator uses latest theme');
        equal(themeObservers.size, 4, 'recreation keeps observer count bounded');

        // Same-commit root replacement must not destroy retained shells/observers.
        const release = retainTerminals(); release();
        const releaseReplacement = retainTerminals();
        await new Promise(resolve => setTimeout(resolve, 10));
        equal(themeObservers.size, 4, 'root replacement retains observers');
        releaseReplacement();
        await new Promise(resolve => setTimeout(resolve, 10));
        equal(themeObservers.size, 0, 'root disposal disconnects all observers');
        const final = terminalFor('pagehide-owner');
        final.attach(host());
        equal(themeObservers.size, 1, 'fresh emulator after root disposal');
        window.dispatchEvent(new Event('pagehide'));
        equal(themeObservers.size, 0, 'pagehide disconnects observer');
        await setTheme('dark');
        return checks;
      }, source);
      assert.deepEqual(errors, [], 'no browser errors');
      console.log(`${name}: ${checks} terminal theme assertions passed`);
    } finally {
      await browser.close();
    }
  });
}
