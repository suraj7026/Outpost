import { createContext, useContext, useState } from 'react';

export type ConversationDetail = 'compact' | 'extended';
export const ConversationDetailContext = createContext<ConversationDetail>('compact');

export interface ExecutionViewState {
  disclosure?: { detail: ConversationDetail; open: boolean };
  rawOpen?: boolean;
  inspectedDetail?: ConversationDetail;
}

export function useConversationDisclosure(memory?: ExecutionViewState) {
  const detail = useContext(ConversationDetailContext);
  const [choice, setChoice] = useState(() => memory?.disclosure ?? { detail, open: detail === 'extended' });
  const open = choice.detail === detail ? choice.open : detail === 'extended';
  // Run-owned memory preserves inspection when late visible text splits a stack.
  if (memory) memory.disclosure = { detail, open };
  if (choice.detail !== detail) {
    if (memory) memory.inspectedDetail = undefined;
    setChoice({ detail, open });
  }
  return { detail, open, setOpen: (value: boolean) => {
    if (memory) memory.disclosure = { detail, open: value };
    setChoice({ detail, open: value });
  } };
}

export function ThinkingIndicator({ active }: { active: boolean }) {
  return <span className="thinking-indicator" data-active={active} aria-hidden="true"><span /><span /><span /></span>;
}
