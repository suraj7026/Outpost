import { z } from 'zod';
import { id, digest, requireThat } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
export const MailDraft = z.strictObject({ taskId: z.string(),identityId: z.string(),to: z.array(z.email()).min(1).max(50),subject: z.string().min(1).max(500).refine(value => !/[\r\n]/.test(value)),body: z.string().max(100000),attachments: z.array(z.strictObject({ artifactId: z.string(),hash: z.string().regex(/^[a-f0-9]{64}$/) })) });
export function prepareMail(db: Ledger, input: unknown) {
  const draft = MailDraft.parse(input);
  for (const attachment of draft.attachments) { const artifact = db.need('artifact',attachment.artifactId); requireThat(artifact.data.hash === attachment.hash && artifact.data.taskId === draft.taskId,'attachment_changed'); }
  return db.put('mail_draft',id(),0,{ ...draft,digest: digest(draft),state: 'draft',sent: false });
}
export function calendarProposal(input: { title: string; start: string; end: string; timezone: string; attendees: string[] }) {
  new Intl.DateTimeFormat('en',{ timeZone: input.timezone }).format();
  requireThat(/(Z|[+-]\d{2}:\d{2})$/.test(input.start) && /(Z|[+-]\d{2}:\d{2})$/.test(input.end),'explicit_offset_required');
  requireThat(Date.parse(input.end) > Date.parse(input.start),'invalid_event_range');
  z.array(z.email()).parse(input.attendees);
  return { ...input,sendsInvitations: input.attendees.length > 0,digest: digest(input) };
}
