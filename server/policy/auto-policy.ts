import { extname } from 'node:path';
import { digest } from '../core/contracts.js';
import type { Data } from '../core/contracts.js';
import type { Gate, Tool } from './trust.js';

export type Classification = 'routine' | 'financial' | 'destructive' | 'security' | 'unclassified';
type Classifier = (args: Data) => Classification;
// Certification is attached to the actual built-in implementation, never its name,
// descriptor, model arguments, connector trust declaration, or claimed effects.
const certified = new WeakMap<Tool, Classifier>();
export function registerBuiltin(gate: Gate, name: string, tool: Tool, classify: Classifier = () => 'routine') {
  certified.set(tool, classify);
  gate.register(name, tool);
}
export function classifyAction(tool: Tool, args: Data): Classification {
  const classify = certified.get(tool);
  if (classify) return classify(args);
  // Claimed risks can only increase review specificity; they cannot certify safety.
  if (tool.effects.some(effect => /^(financial|purchase|subscription|transfer)\./.test(effect))) return 'financial';
  if (tool.effects.some(effect => /^(security|credential|access|protection)\./.test(effect))) return 'security';
  if (tool.effects.some(effect => /^(destructive|delete)\./.test(effect))) return 'destructive';
  return 'unclassified';
}

const readArgv = new Set([
  ...['/bin/ls', '/usr/bin/ls'].flatMap(path => [[path], [path, '-l'], [path, '-la'], [path, '-a']]),
  ...['/bin/pwd', '/usr/bin/pwd'].flatMap(path => [[path], [path, '-P']]),
  ...['/usr/bin/id', '/bin/id'].flatMap(path => [[path], [path, '-u'], [path, '-g']]),
].map(argv => digest(argv)));
export function classifyCommand(args: Data): Classification {
  return readArgv.has(digest(args.argv)) ? 'routine' : 'unclassified';
}

export function securityPath(path: string) {
  return path.split(/[\\/]/).some(part => part.startsWith('.') ||
    /auth|credential|secret|token|password|permission|policy|policies|security|protection|settings|config|hook|login|access|middleware|keychain|certificate/i.test(part) ||
    /^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|dockerfile|makefile|justfile|agents\.md)$/i.test(part) ||
    /\.(pem|key|p12|pfx|crt|keystore)$/i.test(part));
}
export function classifyWorkspaceWrite(path: string, text: string, previous: string | null): Classification {
  if (securityPath(path)) return 'security';
  if (!text.trim() || (previous !== null && (text.length < previous.length / 2 || previous.length > 65536))) return 'destructive';
  if (previous !== null && previous !== text) {
    const lines = new Set(text.split('\n'));
    const removed = previous.split('\n').filter(line => !lines.has(line)).join('\n').length;
    if (removed > 8192 || (previous.length > 1024 && removed > previous.length / 2)) return 'destructive';
  }
  if (!/^[a-zA-Z0-9_\-/ .]+$/.test(path) || text.length > 65536 ||
    !['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.css', '.html', '.md', '.txt', '.csv'].includes(extname(path).toLowerCase()) ||
    path.split('/').some(part => /^(scripts?|bin|sbin|migrations?|deploy|infra|automation)$/i.test(part))) return 'unclassified';
  return 'routine';
}
