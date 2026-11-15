import { z } from 'zod';

export const environmentProtocolVersion = 2;
export const EnvironmentOptions = z.strictObject({
  label: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/).default('Outpost'),
  runtimeRelease: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).nullable().default(null),
  allowLegacyProtocol: z.boolean().default(true),
});
export type EnvironmentOptions = z.input<typeof EnvironmentOptions>;

const ServiceStatus = z.discriminatedUnion('configured', [
  z.strictObject({ configured: z.literal(false), readiness: z.literal('not_configured') }),
  z.strictObject({ configured: z.literal(true), readiness: z.literal('unknown') }),
]);
export const EnvironmentDescriptor = z.strictObject({
  descriptorVersion: z.literal(1),
  environmentId: z.uuid(),
  label: z.string().min(1).max(80),
  protocolVersion: z.literal(environmentProtocolVersion),
  recordProtocolVersion: z.literal(1),
  supportedProtocolVersions: z.union([z.tuple([z.literal(1), z.literal(2)]), z.tuple([z.literal(2)])]),
  legacyUnboundRequests: z.boolean(),
  runtime: z.strictObject({
    release: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).nullable(),
    platform: z.string().min(1).max(32),
    architecture: z.string().min(1).max(32),
  }),
  capabilities: z.strictObject({
    environmentBoundRequests: z.literal(true),
    snapshots: z.literal(true),
    eventStream: z.literal(true),
    artifacts: z.literal(true),
    deviceEnrollment: z.literal(true),
    historyReplication: z.literal(false),
    taskHandoff: z.literal(false),
  }),
  services: z.strictObject({ worker: ServiceStatus, hostAdministration: ServiceStatus }),
}).refine(value => value.legacyUnboundRequests === value.supportedProtocolVersions.some(version => version === 1), 'Legacy compatibility must match supported versions');
export type EnvironmentDescriptor = z.infer<typeof EnvironmentDescriptor>;

export const LegacyQuery = z.strictObject({
  deviceId: z.uuid(), issuedAt: z.number().int(), type: z.string(), payload: z.record(z.string(), z.json()),
});
export const EnvironmentQuery = LegacyQuery.extend({
  protocolVersion: z.literal(environmentProtocolVersion), environmentId: z.uuid(),
});
export const LegacyPairing = z.strictObject({
  deviceId: z.uuid(), name: z.string().min(1).max(80), publicKey: z.string(), token: z.string().max(1000),
});
export const EnvironmentPairing = LegacyPairing.extend({
  protocolVersion: z.literal(environmentProtocolVersion), environmentId: z.uuid(),
});
