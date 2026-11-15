import { z } from 'zod';

export const HumanInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('click'), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.strictObject({ action: z.literal('text'), text: z.string().min(1).max(20000) }),
  z.strictObject({ action: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'ControlOrMeta+A']) }),
  z.strictObject({ action: z.literal('scroll'), x: z.number().min(-5000).max(5000), y: z.number().min(-5000).max(5000) }),
  z.strictObject({ action: z.literal('navigate'), url: z.url().max(8000) }),
  z.strictObject({ action: z.literal('switch_tab'), tab: z.number().int().nonnegative() }),
]);
const base = { requestId: z.uuid(), epoch: z.uuid(), taskId: z.uuid() };
export const BrowserControlRequest = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('take') }),
  z.strictObject({ ...base, type: z.literal('renew'), leaseId: z.uuid() }),
  z.strictObject({ ...base, type: z.literal('release'), leaseId: z.uuid() }),
  z.strictObject({ ...base, type: z.literal('input'), leaseId: z.uuid(), frameId: z.uuid(), input: HumanInput }),
]);
