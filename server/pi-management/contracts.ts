import { z } from 'zod';
import { TransferRequest } from './transfer-contracts.js';
import { UpdateRequest } from './update-contracts.js';

export const managementProtocol = 1;
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine(value => !['__proto__','prototype','constructor'].includes(value));
const modelId = z.string().min(1).max(512).refine(value => value === value.trim() && !/[\x00-\x1f]/.test(value));
export const ModelRef = z.strictObject({ providerId: identifier, modelId });
export type ModelRef = z.infer<typeof ModelRef>;
export const Secret = z.string().min(1).max(32768);
export const AuthMethod = z.enum(['api_key','oauth']);
export const LoginPrompt = z.discriminatedUnion('type',[
  z.strictObject({ type: z.literal('text'), message: z.string(), placeholder: z.string().optional() }),
  z.strictObject({ type: z.literal('secret'), message: z.string(), placeholder: z.string().optional() }),
  z.strictObject({ type: z.literal('manual_code'), message: z.string(), placeholder: z.string().optional() }),
  z.strictObject({ type: z.literal('select'), message: z.string(), options: z.array(z.strictObject({ id: z.string(), label: z.string(), description: z.string().optional() })).max(256) }),
]);
export type LoginPrompt = z.infer<typeof LoginPrompt>;
export const LoginEvent = z.discriminatedUnion('type',[
  z.strictObject({ type: z.literal('info'), message: z.string(), links: z.array(z.strictObject({ url: z.string(), label: z.string().optional() })).optional() }),
  z.strictObject({ type: z.literal('auth_url'), url: z.string(), instructions: z.string().optional() }),
  z.strictObject({ type: z.literal('device_code'), userCode: z.string(), verificationUri: z.string(), intervalSeconds: z.number().optional(), expiresInSeconds: z.number().optional() }),
  z.strictObject({ type: z.literal('progress'), message: z.string() }),
]);
export type LoginEvent = z.infer<typeof LoginEvent>;
export const LoginState = z.strictObject({
  id: z.uuid(), providerId: identifier, method: AuthMethod, expiresAt: z.number(),
  state: z.enum(['running','waiting','succeeded','failed','cancelled','expired']),
  prompt: z.strictObject({ id: z.uuid(), input: LoginPrompt }).nullable(),
  events: z.array(LoginEvent).max(32), error: z.string().nullable(),
});
export type LoginState = z.infer<typeof LoginState>;
export const CompatibleProvider = z.strictObject({
  providerId: identifier, baseUrl: z.url().max(2048),
  api: z.enum(['openai-completions','openai-responses','anthropic-messages','google-generative-ai']),
  allowInsecureHttp: z.boolean().default(false),
  models: z.array(z.strictObject({
    id: modelId, name: z.string().min(1).max(256), reasoning: z.boolean().default(false),
    input: z.array(z.enum(['text','image'])).min(1).max(2).default(['text']),
    contextWindow: z.number().int().min(1024).max(10000000),
    maxTokens: z.number().int().min(1).max(1000000),
  }).refine(model => model.maxTokens <= model.contextWindow)).min(1).max(1000),
}).superRefine((value, context) => {
  const url = new URL(value.baseUrl);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /^169\.254\./.test(url.hostname) || /^\[fe[89ab]/i.test(url.hostname)
    || (url.protocol === 'http:' && !loopback && !value.allowInsecureHttp)) {
    context.addIssue({ code: 'custom', message: 'Use an explicit HTTPS endpoint, or acknowledge private HTTP; no embedded credentials or link-local endpoints.' });
  }
  if (new Set(value.models.map(model => model.id)).size !== value.models.length)
    context.addIssue({ code: 'custom', message: 'Model IDs must be unique within a provider.' });
});
export type CompatibleProvider = z.infer<typeof CompatibleProvider>;
export const ProviderRequest = z.discriminatedUnion('type',[
  z.strictObject({ type: z.literal('catalogue') }),
  z.strictObject({ type: z.literal('refresh'), providerId: identifier.optional() }),
  z.strictObject({ type: z.literal('login.start'), operationId: z.uuid(), providerId: identifier, method: AuthMethod }),
  z.strictObject({ type: z.literal('login.status'), flowId: z.uuid() }),
  z.strictObject({ type: z.literal('login.answer'), flowId: z.uuid(), promptId: z.uuid(), value: Secret }),
  z.strictObject({ type: z.literal('login.cancel'), flowId: z.uuid() }),
  z.strictObject({ type: z.literal('provider.logout'), operationId: z.uuid(), providerId: identifier }),
  z.strictObject({ type: z.literal('provider.configure'), operationId: z.uuid(), expectedGeneration: z.string().length(64), configuration: CompatibleProvider }),
  z.strictObject({ type: z.literal('default.set'), operationId: z.uuid(), expectedGeneration: z.string().length(64), model: ModelRef }),
]);
export const ManagementRequest = z.discriminatedUnion('type', [...ProviderRequest.options, ...TransferRequest.options, ...UpdateRequest.options]);
export type ManagementRequest = z.infer<typeof ManagementRequest>;
export interface OllamaAuthentication {
  state: 'missing' | 'unverified' | 'validated' | 'invalid_key' | 'account_suspended' | 'rate_limited' | 'unavailable';
  quota?: 'available' | 'exhausted'; checkedAt?: number; retryAt?: number;
}
export interface ProviderView {
  id: string; name: string;
  methods: { type: 'api_key' | 'oauth'; label: string; subscription: boolean; interactive: boolean }[];
  configured: boolean; storedMethod: 'api_key' | 'oauth' | null;
  authentication?: OllamaAuthentication;
}
export interface ModelView extends ModelRef {
  name: string; reasoning: boolean; input: readonly string[]; contextWindow: number; maxTokens: number;
}
export interface Catalogue {
  protocolVersion: number; piVersion: string; releaseId: string; profilePath: string; generation: string;
  providers: ProviderView[]; models: ModelView[]; defaultModel: ModelRef | null;
  refreshedAt: number | null; refreshErrors: string[];
  capabilities: { providerPackages: boolean; callbackRelay: boolean; providerTransfer?: boolean };
}
export class ManagementError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function managementError(code: string): ManagementError { return new ManagementError(code); }
