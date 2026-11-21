import { z } from 'zod';
import { BrowserAction, BrowserSessions } from './sessions.js';
import type { Gate } from '../policy/trust.js';
import { registerBuiltin } from '../policy/auto-policy.js';
import type { Artifacts } from '../artifacts/files.js';

const Empty = z.strictObject({});
const Open = z.strictObject({ url: z.url() });
const Act = z.strictObject({ observation: z.number().int().nonnegative(), input: BrowserAction });

export function registerDirectBrowser(gate: Gate, sessions: BrowserSessions, artifacts: Artifacts, taskId: string) {
  gate.register('browser.open', {
    version: 1, effects: ['unknown'], inputSchema: z.toJSONSchema(Open),
    description: 'Direct Pi control: open an HTTP(S) URL in this task’s browser. Returns a fresh observation, numbered element refs and tabs. The owner views this same session.',
    parse: input => Open.parse(input), target: args => String(args.url),
    execute: async (args, signal) => sessions.open(taskId, Open.parse(args).url, signal),
  });
  registerBuiltin(gate, 'browser.observe', {
    version: 1, effects: ['browser.read'], inputSchema: z.toJSONSchema(Empty),
    description: 'Direct Pi control: read the current page and actionable element refs. Use the returned observation for the next browser.act; old observations are invalid after any action or owner interaction.',
    parse: input => Empty.parse(input), target: () => 'Task browser',
    execute: async (_, signal) => sessions.execute(taskId, 'direct', 'Observe page', signal, session => sessions.observe(session)),
  });
  registerBuiltin(gate, 'browser.act', {
    version: 1, effects: ['unknown'], inputSchema: z.toJSONSchema(Act),
    description: 'Direct Pi control: execute one action with a fresh observation. Example: {observation:1,input:{action:"click",ref:"2"}}. Returns the changed page. Navigation, tabs, fill, select, press and scroll are also supported.',
    parse: input => Act.parse(input), target: () => 'Task browser',
    execute: async (args, signal) => {
      const input = Act.parse(args);
      return sessions.execute(taskId, 'direct', input.input.action, signal, session => sessions.act(session, input.observation, input.input));
    },
// Scrolling dispatches real wheel events; a page can observe them and act. No browser
// interaction is certified routine: side effects like payment submits can ride a scroll.
  }, args => 'unclassified');
  registerBuiltin(gate, 'browser.capture', {
    version: 1, effects: ['browser.read', 'workspace.write'], inputSchema: z.toJSONSchema(Empty),
    description: 'Save a PNG screenshot of this task browser as an evidence artifact. Live viewing itself does not save screenshots.',
    parse: input => Empty.parse(input), target: () => 'Task browser screenshot',
    execute: async (_, signal) => sessions.execute(taskId, 'direct', 'Save screenshot', signal, async session => {
      const artifact = artifacts.publish(taskId, `browser-${Date.now()}.png`, 'image/png', await sessions.capture(session));
      return { artifactIds: [artifact.id] };
    }),
  });
  gate.register('browser.close', {
    version: 1, effects: ['browser.write'], inputSchema: z.toJSONSchema(Empty),
    description: 'Close this task browser while retaining its task profile and saved files. Does not reverse actions already performed.',
    parse: input => Empty.parse(input), target: () => 'Task browser',
    execute: async () => { await sessions.stop(taskId); return { closed: true }; },
  });
}
