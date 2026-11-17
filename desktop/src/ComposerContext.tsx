import { createContext, useContext, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

export const ComposerRunContext = createContext<{ controls: ReactNode } | undefined>(undefined);

export default function ComposerContext({ environmentNavigation, onSettings, onReconnect, terminalToggle, connected, reconnecting }: {
  environmentNavigation: ReactNode;
  terminalToggle?: ReactNode;
  connected?: boolean;
  reconnecting?: boolean;
  onSettings: () => void;
  onReconnect?: () => void;
}) {
  const run = useContext(ComposerRunContext);
  return <div className={`composer-context${run ? " composer-context-run" : ""}`} data-tauri-drag-region>
    {run ? <div className="composer-context-identity" data-tauri-drag-region>{environmentNavigation}</div> : environmentNavigation}
    {run ? run.controls : <div className="composer-connection-actions">
      <span className={`composer-connection-label ${reconnecting ? 'reconnecting' : connected ? 'online' : ''}`} role="status"><span aria-hidden="true" />{reconnecting ? 'Reconnecting…' : connected ? 'Connected' : 'Offline'}</span>
      {terminalToggle}
      {!connected && !reconnecting && onReconnect && <button type="button" className="icon-button composer-reconnect" aria-label="Reconnect" title="Reconnect" onClick={onReconnect}><RefreshCw size={18} /></button>}

    </div>}
  </div>;
}
