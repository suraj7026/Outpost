import { PiProfile } from '../pi-management/profile.js';
import type { AccessVerifiers } from '../pi-management/model-access.js';

/** In-process synthetic verifier registrations for transport/auth tests, never used by server startup. */
export class VerifiedFixtureProfile extends PiProfile {
  constructor(directory: string) {
    const verifiers: AccessVerifiers = new Map(['fixture','alpha','beta','ollama-cloud','outpost-ollama'].map(id => [id, provider => provider]));
    super(directory, 'unmanaged', verifiers);
  }
}
