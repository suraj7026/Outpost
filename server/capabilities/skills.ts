import { z } from 'zod';
import type { ResourceLoader } from '@earendil-works/pi-coding-agent';
import { readSkillFile, SkillError, skillCheck, skillHash, skillRelativePath } from './skills-files.js';
export { SkillError, skillHash } from './skills-files.js';

export const SKILL_LIMITS = Object.freeze({ metadataBytes: 32 * 1024, instructionBytes: 64 * 1024,
  resourceBytes: 1024 * 1024, bundleBytes: 8 * 1024 * 1024, files: 64, selection: 32, registryEntries: 1024 });
const Name = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Label = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const RelativePath = z.string().max(512).refine(path => {
  try { skillRelativePath(path); return true; } catch { return false; }
});
const Requirement = z.strictObject({ kind: z.enum(['tool', 'credential', 'capability']), id: Label, version: Label.optional() });
export const SkillManifest = z.strictObject({
  schemaVersion: z.literal(1), name: Name, version: Label,
  description: z.string().min(1).max(1024), source: z.string().min(1).max(512), license: z.string().min(1).max(128),
  requirements: z.array(Requirement).max(32),
  files: z.array(z.strictObject({ path: RelativePath, sha256: Hash, bytes: z.number().int().positive().max(SKILL_LIMITS.resourceBytes) })).min(1).max(SKILL_LIMITS.files),
}).superRefine((manifest, ctx) => {
  const paths = manifest.files.map(file => file.path.toLowerCase());
  if (new Set(paths).size !== paths.length || !manifest.files.some(file => file.path === 'SKILL.md') ||
    paths.includes('skill.json') || manifest.files.reduce((sum, file) => sum + file.bytes, 0) > SKILL_LIMITS.bundleBytes ||
    manifest.files.some(file => file.path === 'SKILL.md' && file.bytes > SKILL_LIMITS.instructionBytes)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid skill inventory' });
  }
});
export type SkillManifest = z.infer<typeof SkillManifest>;
export type SkillRequirement = z.infer<typeof Requirement>;
const Pin = z.strictObject({ rootId: Label, directory: RelativePath, name: Name, version: Label, digest: Hash });
export type SkillPin = Readonly<z.infer<typeof Pin>>;
const Approval = Pin.extend({ approved: z.boolean(), revoked: z.boolean(), active: z.boolean() });
export type SkillApproval = Readonly<z.infer<typeof Approval>>;
const State = z.strictObject({ scope: Label, revision: z.number().int().nonnegative().safe(), entries: z.array(Approval).max(SKILL_LIMITS.registryEntries) });

/** Trusted repository boundary. Return one atomic, fresh, scope-authorized view, not a cache.
 * Keep approvals for retained versions; active controls NEW admissions only. Revoke/delete
 * stops existing selections too. The owner must enforce immutable (scope,name,version) pins,
 * monotonic revocation, authenticated scopes and CAS/audit on authorized registry writes.
 */
export interface SkillRegistryStorage {
  read(scope: string): Promise<{ scope: string; revision: number; entries: readonly SkillApproval[] }>;
}
export interface SkillReadinessProbe {
  // Only availability facts, never credential values, executable discovery or installation.
  check(scope: string, requirement: Readonly<SkillRequirement>): Promise<'ready' | 'missing' | 'version-mismatch' | 'disabled'>;
}
export interface SkillReadinessReason {
  readonly kind: SkillRequirement['kind']; readonly id: string; readonly requiredVersion: string | null;
  readonly code: 'missing' | 'version-mismatch' | 'disabled' | 'probe-unavailable';
}
export interface SkillMetadata {
  readonly name: string; readonly version: string; readonly digest: string; readonly description: string;
  readonly source: string; readonly license: string; readonly ready: boolean;
  readonly reasons: readonly SkillReadinessReason[];
}
export interface SkillRunContext { readonly scope: string; readonly runId: string }
export interface SkillSelectionEvidence extends SkillRunContext {
  readonly registryRevision: number; readonly pins: readonly SkillPin[];
}
export interface SkillContent {
  readonly name: string; readonly version: string; readonly digest: string; readonly path: string;
  readonly sha256: string; readonly trust: 'instructions-only'; readonly bytes: Uint8Array;
}
/** Explicit bridge for Pi: advertise async metadata and route content through Outpost's gate.
 * Never put native paths in getSkills: Pi 1.4.0 /skill directly reopens them synchronously.
 */
export interface SkillRunAdapter {
  readonly evidence: SkillSelectionEvidence;
  readonly nativePiSkills: Pick<ResourceLoader, 'getSkills'>;
  metadata(context: SkillRunContext): Promise<readonly SkillMetadata[]>;
  loadInstructions(context: SkillRunContext, name: string): Promise<SkillContent>;
  loadResource(context: SkillRunContext, name: string, path: string): Promise<SkillContent>;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SkillError('skill_invalid_metadata');
  return result.data;
}
function pinKey(pin: SkillPin): string { return JSON.stringify([pin.rootId, pin.directory, pin.name, pin.version, pin.digest]); }
function freezePin(pin: SkillPin): SkillPin { return Object.freeze(parse(Pin, pin)); }

export class ApprovedSkills {
  readonly #roots: ReadonlyMap<string, string>;
  constructor(private readonly registry: SkillRegistryStorage, roots: Readonly<Record<string, string>>, private readonly readiness: SkillReadinessProbe) {
    this.#roots = new Map(Object.entries(roots).map(([id, path]) => [parse(Label, id), path]));
  }
  private root(pin: Pick<SkillPin, 'rootId'>): string {
    const root = this.#roots.get(pin.rootId);
    skillCheck(root, 'skill_root_not_approved');
    return root;
  }
  private async manifest(location: { rootId: string; directory: string }, digest?: string): Promise<{ manifest: SkillManifest; digest: string }> {
    const bytes = await readSkillFile(this.root(location), location.directory, 'skill.json', SKILL_LIMITS.metadataBytes);
    const actual = skillHash(bytes);
    skillCheck(!digest || digest === actual, 'skill_content_drift');
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new SkillError('skill_invalid_metadata'); }
    return { manifest: parse(SkillManifest, input), digest: actual };
  }
  private async file(pin: SkillPin, manifest: SkillManifest, path: string): Promise<Buffer> {
    skillRelativePath(path);
    const entry = manifest.files.find(file => file.path === path);
    skillCheck(entry, 'skill_resource_not_declared');
    const bytes = await readSkillFile(this.root(pin), pin.directory, path,
      path === 'SKILL.md' ? SKILL_LIMITS.instructionBytes : SKILL_LIMITS.resourceBytes);
    skillCheck(bytes.length === entry.bytes && skillHash(bytes) === entry.sha256, 'skill_content_drift');
    return bytes;
  }
  /** Reviewed staging helper only. It does NOT approve or activate anything. */
  async inspect(rootId: string, directory: string): Promise<SkillPin> {
    const { manifest, digest } = await this.manifest({ rootId, directory });
    const pin = freezePin({ rootId, directory, name: manifest.name, version: manifest.version, digest });
    for (const file of manifest.files) await this.file(pin, manifest, file.path);
    return pin;
  }
  private async state(scope: string) {
    parse(Label, scope);
    let input: unknown;
    try { input = await this.registry.read(scope); }
    catch { throw new SkillError('skill_registry_unavailable'); }
    const state = parse(State, input);
    skillCheck(state.scope === scope, 'skill_scope_mismatch');
    const keys = state.entries.map(pinKey);
    skillCheck(new Set(keys).size === keys.length, 'skill_registry_collision');
    // A version is immutable, even after deactivation. Publish changed content as a new version.
    const versions = state.entries.map(entry => JSON.stringify([entry.name, entry.version]));
    skillCheck(new Set(versions).size === versions.length, 'skill_version_collision');
    return state;
  }
  private async current(scope: string, pins: readonly SkillPin[], requireActive = false) {
    const state = await this.state(scope);
    if (requireActive) this.active(state);
    for (const pin of pins) {
      const entry = state.entries.find(entry => pinKey(entry) === pinKey(pin));
      skillCheck(entry?.approved && !entry.revoked && (!requireActive || entry.active), 'skill_not_approved');
    }
    return state;
  }
  private async metadataFor(scope: string, pin: SkillPin): Promise<{ metadata: SkillMetadata; manifest: SkillManifest }> {
    const { manifest } = await this.manifest(pin, pin.digest);
    skillCheck(manifest.name === pin.name && manifest.version === pin.version, 'skill_identity_mismatch');
    const reasons: SkillReadinessReason[] = [];
    for (const requirement of manifest.requirements) {
      let status: SkillReadinessReason['code'] | 'ready';
      try { status = await this.readiness.check(scope, Object.freeze({ ...requirement })); }
      catch { status = 'probe-unavailable'; }
      if (!['ready', 'missing', 'version-mismatch', 'disabled'].includes(status)) status = 'probe-unavailable';
      if (status !== 'ready') reasons.push(Object.freeze({ kind: requirement.kind, id: requirement.id, requiredVersion: requirement.version ?? null, code: status }));
    }
    const metadata: SkillMetadata = Object.freeze({ name: pin.name, version: pin.version, digest: pin.digest,
      description: manifest.description, source: manifest.source, license: manifest.license,
      ready: reasons.length === 0, reasons: Object.freeze(reasons) });
    return { metadata, manifest };
  }
  private active(state: z.infer<typeof State>): SkillPin[] {
    const active = state.entries.filter(entry => entry.active && entry.approved && !entry.revoked);
    const names = active.map(entry => entry.name);
    skillCheck(new Set(names).size === names.length, 'skill_name_collision');
    return active.map(entry => freezePin({ rootId: entry.rootId, directory: entry.directory, name: entry.name, version: entry.version, digest: entry.digest }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  async discover(scope: string): Promise<readonly SkillMetadata[]> {
    const pins = this.active(await this.state(scope));
    const results: SkillMetadata[] = [];
    for (const pin of pins) results.push((await this.metadataFor(scope, pin)).metadata);
    await this.current(scope, pins, true);
    return Object.freeze(results);
  }
  /** New run is the only refresh boundary. Existing adapters never resolve active versions again. */
  async admit(context: SkillRunContext, names: readonly string[]): Promise<SkillRunAdapter> {
    const selectedNames = [...names];
    const scope = parse(Label, context.scope), runId = parse(Label, context.runId);
    skillCheck(selectedNames.length <= SKILL_LIMITS.selection && new Set(selectedNames).size === selectedNames.length, 'skill_invalid_selection');
    const state = await this.state(scope), active = this.active(state);
    const pins = Object.freeze(selectedNames.sort().map(name => {
      const pin = active.find(pin => pin.name === name);
      skillCheck(pin, 'skill_not_approved');
      return pin;
    }));
    for (const pin of pins) skillCheck((await this.metadataFor(scope, pin)).metadata.ready, 'skill_not_ready');
    await this.current(scope, pins, true);
    const evidence = Object.freeze({ scope, runId, registryRevision: state.revision, pins });
    const check = async (context: SkillRunContext) => {
      skillCheck(context.scope === scope && context.runId === runId, 'skill_scope_mismatch');
      await this.current(scope, pins);
    };
    const load = async (context: SkillRunContext, name: string, path: string): Promise<SkillContent> => {
      await check(context);
      const pin = pins.find(pin => pin.name === name);
      skillCheck(pin, 'skill_not_selected');
      const { metadata, manifest } = await this.metadataFor(scope, pin);
      skillCheck(metadata.ready, 'skill_not_ready');
      const bytes = await this.file(pin, manifest, path);
      // Re-read after asynchronous IO: a revocation during loading must not return content.
      await check(context);
      return Object.freeze({ name, version: pin.version, digest: pin.digest, path, sha256: skillHash(bytes), trust: 'instructions-only', bytes });
    };
    return Object.freeze({ evidence, nativePiSkills: Object.freeze({ getSkills: () => ({ skills: [], diagnostics: [] }) }),
      metadata: async (context: SkillRunContext) => {
        await check(context);
        const result: SkillMetadata[] = [];
        for (const pin of pins) result.push((await this.metadataFor(scope, pin)).metadata);
        await check(context);
        return Object.freeze(result);
      },
      loadInstructions: (context: SkillRunContext, name: string) => load(context, name, 'SKILL.md'),
      loadResource: load,
    });
  }
}
