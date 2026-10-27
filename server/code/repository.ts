import { createHash } from 'node:crypto';
import { Workspace } from '../artifacts/files.js';
import { execute } from '../processes/runner.js';
import { digest, requireThat } from '../core/contracts.js';
export class Repository {
  constructor(readonly workspace: Workspace) {}
  async inspect(signal = new AbortController().signal) {
    const run = (args: string[]) => execute(['/usr/bin/git',...args],this.workspace.root,signal);
    const [head,status,diff] = await Promise.all([run(['rev-parse','HEAD']),run(['status','--porcelain=v1','--untracked-files=all']),run(['diff','HEAD','--no-ext-diff','--'])]);
    requireThat(head.exitCode === 0 && status.exitCode === 0 && diff.exitCode === 0,'repository_inspection_failed');
    const state = { head: head.stdout.trim(),status: status.stdout,diff: diff.stdout };
    return { ...state,revisionDigest: digest(state) };
  }
  patch(path: string, before: string, after: string, expectedHash: string) {
    const text = this.workspace.read(path);
    requireThat(before.length > 0 && text.split(before).length === 2,'patch_not_unique');
    return this.workspace.write(path,text.replace(before,() => after),expectedHash);
  }
  async check(argv: string[], signal = new AbortController().signal) {
    const before = await this.inspect(signal), result = await execute(argv,this.workspace.root,signal);
    const after = await this.inspect(signal);
    return { revisionDigest: before.revisionDigest,result,verified: result.exitCode === 0 && !result.outputLimitReached && before.revisionDigest === after.revisionDigest };
  }
}
export const fileHash = (text: string) => createHash('sha256').update(text).digest('hex');
