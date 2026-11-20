import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
export const ModelRoles = z.strictObject({ operator: z.string().min(1),reviewer: z.string().min(1).optional(),vision: z.string().min(1),contextWindow: z.number().int().min(4096),maxTokens: z.number().int().min(256),qualified: z.boolean(),qualificationRef: z.string().min(1) });
export type ModelRoles = z.infer<typeof ModelRoles>;
export function validateRoles(input: unknown) {
  const roles = ModelRoles.parse(input); requireThat(roles.qualified,'models_not_qualified'); return roles;
}
