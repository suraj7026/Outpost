// These are Ollama's cloud tag forms, not a hard-coded model catalogue.
export function ollamaCloudModels(advertised: readonly string[]): string[] {
  return [...new Set(advertised.filter((name) => name.endsWith(":cloud") || name.endsWith("-cloud")))];
}

export function preferredCloudModel(available: readonly string[], selected: string, serverDefault: string | null): string {
  if (available.includes(selected)) return selected;
  if (serverDefault && available.includes(serverDefault)) return serverDefault;
  return available[0] ?? "";
}
