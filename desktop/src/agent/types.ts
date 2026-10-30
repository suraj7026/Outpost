export type ModelRef = { providerId: string; modelId: string };
export type Provider = { id: string; name: string; configured: boolean; storedMethod: 'api_key' | 'oauth' | null;
  methods: { type: 'api_key' | 'oauth'; label: string; subscription: boolean; interactive: boolean }[] };
export type Catalogue = { protocolVersion: number; piVersion: string; releaseId?: string; profilePath: string; generation: string;
  providers: Provider[]; models: (ModelRef & { name: string; reasoning: boolean })[]; defaultModel: ModelRef | null;
  refreshedAt: number | null; refreshErrors: string[]; capabilities: { providerPackages: boolean; callbackRelay: boolean } };
export type Login = { id: string; providerId: string; method: string; expiresAt: number;
  state: 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'expired'; error: string | null;
  prompt: { id: string; input: { type: 'text' | 'secret' | 'manual_code' | 'select'; message: string; placeholder?: string; options?: { id: string; label: string }[] } } | null;
  events: ({ type: 'info' | 'progress'; message: string; links?: { url: string; label?: string }[] } |
    { type: 'auth_url'; url: string; instructions?: string } |
    { type: 'device_code'; userCode: string; verificationUri: string })[] };
export const providerLabel = (id: string) => id === 'ollama-cloud' ? 'Ollama' : id === 'outpost-ollama' ? 'Ollama (previous connection)' : id;
export const sameModel = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId;
export function chosenModel(catalogue: Catalogue | null, selected: ModelRef | null, initial?: ModelRef | null): ModelRef | null {
  // An explicit or historical choice disappearing must block, not silently select another account.
  const wanted = selected ?? initial ?? catalogue?.defaultModel;
  return catalogue?.models.find(model => sameModel(model, wanted)) ?? null;
}
