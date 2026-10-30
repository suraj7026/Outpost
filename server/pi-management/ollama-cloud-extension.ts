import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ollamaCloudConfiguration } from './ollama-cloud.js';

/** The CLI uses the same pinned provider registration as the worker and Settings. */
export default async function (pi: ExtensionAPI) {
  pi.registerProvider('ollama-cloud', await ollamaCloudConfiguration());
}
