import { VERSION } from '@earendil-works/pi-coding-agent';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { managementError } from './contracts.js';

/** Pi 1.4's lock-preserving store is internal; isolate and version-fence this reviewed adapter. */
export async function credentialStore(directory: string): Promise<CredentialStore> {
  if (VERSION !== '1.4.0') throw managementError('credential_store_adapter_requires_qualification');
  const module: { AuthStorage: { create(path: string): CredentialStore } } = await import(
    new URL('./core/auth-storage.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
  const store = module.AuthStorage.create(join(directory, 'auth.json'));
  // AuthStorage.read resolves environment templates and executes !commands. Transfers
  // must inspect the raw stored value instead, under the same cross-process lock.
  store.read = async (providerId, options) => {
    let raw: import('@earendil-works/pi-ai').Credential | undefined;
    await store.modify(providerId, async current => { raw = current ? structuredClone(current) : undefined; return undefined; },
      { ...options, signal: options?.signal ?? AbortSignal.timeout(8000) });
    return raw;
  };
  return store;
}
