export const FAST_POLL_MS = 250;
export const DEFAULT_POLL_MS = 1000;
export const IDLE_POLL_MS = 2000;
export const INPUT_BOOST_MS = 3000;

export interface BrowserControlLease {
  leaseId: string;
  holder: string;
  state: 'pending' | 'human' | 'releasing' | 'released' | 'expired';
  expiresAt: number;
}

export interface BrowserFrame {
  unchanged?: boolean;
  session?: { state?: string; mode?: string; action?: string; url?: string } | null;
  frame?: string | null;
  capturedAt: string | null;
  frameId?: string;
  width?: number;
  height?: number;
  tabs?: { tab: number; url: string; active: boolean }[];
  control?: BrowserControlLease | null;
  controlEpoch?: string;
}

export interface PollScheduleInput {
  now: number;
  boostUntil: number;
  sessionState: string;
  controlState?: string;
  unchanged: boolean;
  hasError: boolean;
}

export function nextBrowserPollDelayMs({
  now,
  boostUntil,
  sessionState,
  controlState,
  unchanged,
  hasError,
}: PollScheduleInput): number {
  if (hasError) return DEFAULT_POLL_MS;
  if (now < boostUntil || sessionState === 'running' || sessionState === 'starting') return FAST_POLL_MS;
  if (controlState === 'pending' || controlState === 'releasing') return FAST_POLL_MS;
  if (unchanged || sessionState === 'closed' || sessionState === 'interrupted') return IDLE_POLL_MS;
  return DEFAULT_POLL_MS;
}

export function mergeBrowserFrame(previous: BrowserFrame | null, next: BrowserFrame): BrowserFrame {
  if (next.unchanged && previous?.frame) {
    return {
      ...previous,
      ...next,
      frame: previous.frame,
      frameId: next.frameId ?? previous.frameId,
      width: next.width ?? previous.width,
      height: next.height ?? previous.height,
      tabs: next.tabs ?? previous.tabs,
      session: next.session !== undefined ? next.session : previous.session,
      control: next.control !== undefined ? next.control : previous.control,
      controlEpoch: next.controlEpoch !== undefined ? next.controlEpoch : previous.controlEpoch,
      capturedAt: next.capturedAt ?? previous.capturedAt,
    };
  }
  return next;
}
