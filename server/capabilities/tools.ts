import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
import { Gate } from '../policy/trust.js';
import type { Tool } from '../policy/trust.js';
export const Descriptor = z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9_.]+$/),description: z.string().min(1).max(1000),pack: z.string(),version: z.number().int().positive(),trust: z.enum(['trusted-in-process','isolated-connector']),keywords: z.array(z.string()),effects: z.array(z.string()).min(1) });
export type Descriptor = z.infer<typeof Descriptor>;
export class ToolRegistry {
  private descriptors = new Map<string,Descriptor>();
  constructor(private gate: Gate) {}
  register(input: unknown, tool: Tool) {
    const descriptor = Descriptor.parse(input);
    requireThat(descriptor.version === tool.version && JSON.stringify(descriptor.effects) === JSON.stringify(tool.effects),'descriptor_mismatch');
    requireThat(!this.descriptors.has(descriptor.name),'duplicate_tool');
    this.gate.register(descriptor.name,tool); this.descriptors.set(descriptor.name,descriptor);
  }
  discover(query: string, limit = 8) {
    requireThat(Number.isInteger(limit) && limit > 0 && limit <= 20,'invalid_tool_limit');
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.descriptors.values()].map(tool => ({ tool,score: words.filter(word => `${tool.name} ${tool.description} ${tool.keywords.join(' ')}`.toLowerCase().includes(word)).length })).filter(row => row.score > 0).sort((a,b) => b.score-a.score || a.tool.name.localeCompare(b.tool.name)).slice(0,limit).map(row => row.tool);
  }
  invoke(taskId: string, name: string, args: unknown) { requireThat(this.descriptors.has(name),'unknown_tool'); return this.gate.propose(taskId,name,args); }
}
