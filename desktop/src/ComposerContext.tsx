import { createContext, useContext, type ReactNode } from "react";
import { RefreshCw, Settings } from "lucide-react";

export const ComposerRunContext = createContext<{ controls: ReactNode; terminalToggle: ReactNode } | undefined>(undefined);

export default function ComposerContext({ environmentNavigation, onSettings, onReconnect }: {
  environmentNavigation: ReactNode;
  onSettings: () => void;
  onReconnect?: () => void;
}) {
  const run = useContext(ComposerRunContext);
  return <div className={`composer-context${run ? " composer-context-run" : ""}`} data-tauri-drag-region>
    {run ? <div className="composer-context-identity" data-tauri-drag-region>{environmentNavigation}{run.terminalToggle}</div> : environmentNavigation}
    {run ? run.controls : <div className="composer-connection-actions">
      {onReconnect && <button type="button" className="icon-button composer-reconnect" aria-label="Reconnect" title="Reconnect" onClick={onReconnect}><RefreshCw size={16} /></button>}
      <button type="button" className="icon-button composer-settings" aria-label="Composer connection settings" title="Connection settings" onClick={onSettings}>
        <Settings size={17} />
      </button>
    </div>}
  </div>;
}
