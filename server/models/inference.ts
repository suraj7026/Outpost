import { z } from 'zod';

export const InferenceConfiguration = z.strictObject({
  baseUrl: z.url(),
  model: z.string().min(1),
  contextWindow: z.number().int().min(4096).default(32768),
  maxTokens: z.number().int().min(256).default(4096),
  vision: z.boolean().default(true),
});
export type InferenceConfiguration = z.infer<typeof InferenceConfiguration>;
