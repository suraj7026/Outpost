import { z } from 'zod';
import { Fault, id, requireThat } from '../core/contracts.js';
import type { Ledger } from '../core/ledger.js';
import { EnvironmentDescriptor, EnvironmentOptions, environmentProtocolVersion } from './contracts.js';

export class Installation {
  readonly environmentId: string;
  private readonly options: z.output<typeof EnvironmentOptions>;

  constructor(db: Ledger, options: EnvironmentOptions = {}) {
    this.options = EnvironmentOptions.parse(options);
    this.environmentId = db.transaction(() => {
      const initialized = db.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='installation_identity'").get();
      db.db.exec(`CREATE TABLE IF NOT EXISTS installation_identity(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), environment_id TEXT NOT NULL
      )`);
      const stored = db.db.prepare('SELECT environment_id FROM installation_identity WHERE singleton=1').get();
      if (stored) {
        const parsed = z.uuid().safeParse(stored.environment_id);
        requireThat(parsed.success, 'invalid_environment_identity', 'Stored installation identity is invalid; restore it rather than creating a new identity.');
        return parsed.data;
      }
      requireThat(!initialized, 'missing_environment_identity', 'Stored installation identity is missing; restore it rather than creating a new identity.');
      const environmentId = id();
      db.db.prepare('INSERT INTO installation_identity(singleton,environment_id) VALUES(1,?)').run(environmentId);
      return environmentId;
    });
  }

  requireProtocol(version: number) {
    if (version !== 1 && version !== environmentProtocolVersion) {
      throw new Fault('unsupported_protocol', 'Use a supported protocol from the environment descriptor.', 426);
    }
    if (version === 1 && !this.options.allowLegacyProtocol) {
      throw new Fault('legacy_protocol_disabled', 'This environment requires an environment-bound client. Update the app before reconnecting.', 426);
    }
  }

  requireTarget(environmentId: unknown) {
    requireThat(environmentId === this.environmentId, 'environment_mismatch', 'This route reaches a different Outpost environment. Verify the saved connection before retrying.');
  }

  descriptor(services: { worker: boolean; hostAdministration: boolean }): EnvironmentDescriptor {
    const status = (configured: boolean) => configured
      ? { configured: true as const, readiness: 'unknown' as const }
      : { configured: false as const, readiness: 'not_configured' as const };
    return EnvironmentDescriptor.parse({
      descriptorVersion: 1,
      environmentId: this.environmentId,
      label: this.options.label,
      protocolVersion: environmentProtocolVersion,
      recordProtocolVersion: 1,
      supportedProtocolVersions: this.options.allowLegacyProtocol ? [1, 2] : [2],
      legacyUnboundRequests: this.options.allowLegacyProtocol,
      runtime: { release: this.options.runtimeRelease, platform: process.platform, architecture: process.arch },
      capabilities: {
        environmentBoundRequests: true, snapshots: true, eventStream: true, artifacts: true,
        deviceEnrollment: true, historyReplication: false, taskHandoff: false,
      },
      services: { worker: status(services.worker), hostAdministration: status(services.hostAdministration) },
    });
  }
}
