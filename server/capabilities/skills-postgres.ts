import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
import type { Repository, CoordinatorOwnership } from '../storage/contracts.js';
import { SKILL_LIMITS } from './skills.js';
import type { SkillRegistryStorage } from './skills.js';
import { skillRelativePath } from './skills-files.js';

export const SKILL_REGISTRY_KIND = 'op007.skills.registry.v1';
export const SKILL_REGISTRY_AUDIT_KIND = 'op007.skills.registry-audit.v1';
const Label = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const Revision = z.number().int().nonnegative().safe();
const Pin = z.strictObject({
  rootId: Label,
  directory: z.string().max(512).refine(value => { try { skillRelativePath(value); return true; } catch { return false; } }),
  name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: Label,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const Entry = Pin.extend({ approved: z.boolean(), revoked: z.boolean(), active: z.boolean(), deleted: z.boolean() });
const State = z.strictObject({ schemaVersion: z.literal(1), scope: Label, entries: z.array(Entry).max(SKILL_LIMITS.registryEntries) });
const Change = z.strictObject({ scope: Label, expectedRevision: Revision, operation: z.enum(['approve', 'activate', 'deactivate', 'revoke', 'delete']), pin: Pin });
const Authorization = z.strictObject({ actorId: Label, authorizationId: Label });
export type SkillRegistryChange = Readonly<Omit<z.infer<typeof Change>, 'pin'> & { readonly pin: Readonly<z.infer<typeof Pin>> }>;
export type SkillRegistryAuthorization = Readonly<z.infer<typeof Authorization>>;
/** Trusted owner/common-gate hook, NOT a manifest permission or model-facing callback.
 * Called anew under the fenced writer lock with an immutable exact request. Must throw
 * unless currently authorized; no external IO, side effects, or asynchronous work here.
 */
export type AuthorizeSkillRegistryChange = (change: SkillRegistryChange) => SkillRegistryAuthorization;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  requireThat(result.success, 'skill_registry_invalid');
  return result.data;
}
function key(scope: string): string { return JSON.stringify(['op007.skills', scope]); }
function samePin(a: z.infer<typeof Pin>, b: z.infer<typeof Pin>): boolean {
  return a.name === b.name && a.version === b.version && a.rootId === b.rootId && a.directory === b.directory && a.digest === b.digest;
}
function state(input: unknown, scope: string): z.infer<typeof State> {
  const value = parse(State, input);
  requireThat(value.scope === scope, 'skill_scope_mismatch');
  const versions = new Set<string>(), active = new Set<string>();
  for (const entry of value.entries) {
    const identity = JSON.stringify([entry.name, entry.version]);
    requireThat(!versions.has(identity), 'skill_version_collision'); versions.add(identity);
    requireThat(!entry.active || entry.approved && !entry.revoked && !entry.deleted, 'skill_registry_invalid');
    requireThat(!entry.revoked || !entry.approved, 'skill_registry_invalid');
    requireThat(!entry.deleted || entry.revoked, 'skill_registry_invalid');
    if (entry.active) { requireThat(!active.has(entry.name), 'skill_name_collision'); active.add(entry.name); }
  }
  return value;
}

/** Construct only with a scope resolved by the trusted authenticated owner. Possession
 * of this read capability permits that scope, not arbitrary caller-supplied scopes.
 * One bounded record/get is one atomic current snapshot; no approval cache or list scan.
 */
export class PostgresSkillRegistry implements SkillRegistryStorage {
  readonly #scope: string;
  constructor(private readonly repository: Pick<Repository, 'get'>, trustedScope: string) {
    this.#scope = parse(Label, trustedScope);
  }
  async read(scope: string) {
    requireThat(scope === this.#scope, 'skill_scope_mismatch');
    const record = await this.repository.get<unknown>(SKILL_REGISTRY_KIND, key(this.#scope));
    if (!record) return { scope: this.#scope, revision: 0, entries: [] };
    const revision = parse(Revision, record.revision);
    requireThat(revision > 0, 'skill_registry_invalid');
    const current = state(record.data, this.#scope);
    return { scope: this.#scope, revision, entries: current.entries.filter(entry => !entry.deleted).map(({ deleted: _deleted, ...entry }) => entry) };
  }
}

/** Trusted administration capability, deliberately separate from model-facing reads.
 * Construction/authorizer injection is server-only. The caller must not expose it as
 * an unchecked HTTP API. Repository ownership is fencing, not user authorization.
 */
export class AuthorizedSkillRegistryWriter {
  readonly #scope: string;
  constructor(private readonly repository: Repository, private readonly owner: CoordinatorOwnership,
    trustedScope: string, private readonly authorize: AuthorizeSkillRegistryChange) {
    this.#scope = parse(Label, trustedScope);
  }
  async writeAuthorized(input: SkillRegistryChange): Promise<number> {
    // Snapshot caller-owned data before the first await, including nested pin fields.
    const parsed = parse(Change, input);
    const change = Object.freeze({ ...parsed, pin: Object.freeze(parsed.pin) });
    requireThat(change.scope === this.#scope, 'skill_scope_mismatch');
    requireThat(change.expectedRevision < Number.MAX_SAFE_INTEGER, 'skill_registry_revision_exhausted');
    return this.repository.transaction(this.owner, async tx => {
      requireThat(this.owner.active, 'ownership_lost');
      const authorization = parse(Authorization, this.authorize(change));
      requireThat(this.owner.active, 'ownership_lost');
      const previous = await tx.get<unknown>(SKILL_REGISTRY_KIND, key(this.#scope));
      requireThat((previous?.revision ?? 0) === change.expectedRevision, 'stale_revision');
      const current = previous ? state(previous.data, this.#scope) : { schemaVersion: 1 as const, scope: this.#scope, entries: [] as z.infer<typeof Entry>[] };
      let entry = current.entries.find(value => value.name === change.pin.name && value.version === change.pin.version);
      if (entry) requireThat(samePin(entry, change.pin), 'skill_pin_mismatch');
      if (change.operation === 'approve') {
        if (entry) {
          requireThat(!entry.revoked && !entry.deleted, 'skill_revoked');
          requireThat(!entry.approved, 'skill_registry_no_change');
          entry.approved = true;
        } else {
          requireThat(current.entries.length < SKILL_LIMITS.registryEntries, 'skill_registry_full');
          entry = { ...change.pin, approved: true, revoked: false, active: false, deleted: false };
          current.entries.push(entry);
        }
      } else {
        requireThat(entry, 'skill_pin_not_found');
        requireThat(!entry.revoked && !entry.deleted, 'skill_revoked');
        if (change.operation === 'activate') {
          requireThat(entry.approved, 'skill_not_approved');
          requireThat(!entry.active, 'skill_registry_no_change');
          for (const other of current.entries) if (other.name === entry.name) other.active = false;
          entry.active = true;
        } else if (change.operation === 'deactivate') {
          requireThat(entry.active, 'skill_registry_no_change'); entry.active = false;
        } else {
          entry.active = false; entry.approved = false; entry.revoked = true;
          entry.deleted = change.operation === 'delete';
        }
      }
      // State + audit and both repository change events commit or roll back together.
      const updated = await tx.put(SKILL_REGISTRY_KIND, key(this.#scope), change.expectedRevision, state(current, this.#scope), 'op007.skills.registry.changed');
      await tx.put(SKILL_REGISTRY_AUDIT_KIND, JSON.stringify(['op007.skills.audit', this.#scope, updated.revision]), 0,
        { schemaVersion: 1, ...change, revision: updated.revision, ...authorization, ownerEpoch: this.owner.epoch }, 'op007.skills.registry.audited');
      requireThat(this.owner.active, 'ownership_lost');
      return updated.revision;
    });
  }
}
