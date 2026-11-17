import { createContext, useContext, useState } from 'react';

export type ConversationDetail = 'compact' | 'extended';
export const ConversationDetailContext = createContext<ConversationDetail>('compact');

export function useConversationDisclosure() {
  const detail = useContext(ConversationDetailContext);
  const [choice, setChoice] = useState({ detail, open: detail === 'extended' });
  const open = choice.detail === detail ? choice.open : detail === 'extended';
  // Reset only for an explicit preference change, never for a streaming update.
  if (choice.detail !== detail) setChoice({ detail, open });
  return { open, setOpen: (value: boolean) => setChoice({ detail, open: value }) };
}

export function ThinkingIndicator({ active }: { active: boolean }) {
  return <span className="thinking-indicator" data-active={active} aria-hidden="true"><span /><span /><span /></span>;
}
