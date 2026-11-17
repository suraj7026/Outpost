import { createContext, useContext, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

export const ComposerRunContext = createContext<{ controls: ReactNode } | undefined>(undefined);

export default function ComposerContext({ environmentNavigation, onSettings, onReconnect, terminalToggle, connected }: {
  environmentNavigation: ReactNode;
  terminalToggle?: ReactNode;
  connected?: boolean;
  onSettings: () => void;
  onReconnect?: () => void;
}) {
  const run = useContext(ComposerRunContext);
  return <div className={`composer-context${run ? " composer-context-run" : ""}`} data-tauri-drag-region>
    {run ? <div className="composer-context-identity" data-tauri-drag-region>{environmentNavigation}</div> : environmentNavigation}
    {run ? run.controls : <div className="composer-connection-actions">
      <span className={`composer-connection-label ${connected ? 'online' : ''}`}><span aria-hidden="true" />{connected ? 'Connected' : 'Offline'}</span>
      {terminalToggle}
      {!connected && onReconnect && <button type="button" className="icon-button composer-reconnect" aria-label="Reconnect" title="Reconnect" onClick={onReconnect}><RefreshCw size={18} /></button>}

    </div>}
  </div>;
}
