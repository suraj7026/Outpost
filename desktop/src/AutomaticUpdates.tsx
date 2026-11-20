import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { call, nativeApp, recordedPreview } from './api';
import { Badge, Button, Dialog, Section, SettingRow } from './Interface';
import type { Metadata } from './Environments';
import type { Connection } from './useConnection';
import {
  automaticUpdateConnections, automaticUpdatePresentation, automaticUpdateTargets, automaticUpdatesAllowed,
  automaticUpdatesPending, createAutomaticUpdatesController, type AutomaticUpdatesInput, type AutomaticUpdatesSnapshot,
} from './automatic-updates';

type Controller = ReturnType<typeof createAutomaticUpdatesController>;
interface AutomaticUpdatesContextValue extends AutomaticUpdatesSnapshot {
  available: boolean;
  environments: Metadata['environments'];
  targetIds: string[];
  connectedIds: string[];
  enable: Controller['enable'];
  disable: Controller['disable'];
  refresh: Controller['refresh'];
  updateServer: Controller['updateServer'];
  recoverServer: Controller['recoverServer'];
}
const AutomaticUpdatesContext = createContext<AutomaticUpdatesContextValue | null>(null);
export const useAutomaticUpdates = () => useContext(AutomaticUpdatesContext);

export function AutomaticUpdatesProvider({ registry, connections, children }: {
  registry: Metadata; connections: Record<string, Connection>; children: ReactNode;
}) {
  const input: AutomaticUpdatesInput = { native: nativeApp(), recordedPreview: recordedPreview(), environments: Object.values(registry.environments), connections };
  const current = useRef(input);
  current.current = input;
  const working = useRef(false);
  const [controller] = useState(() => createAutomaticUpdatesController({ input: () => current.current, invoke: call, working }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const available = automaticUpdatesAllowed(input);
  const targetIds = automaticUpdateTargets(input), connectedIds = automaticUpdateConnections(input);
  const scope = JSON.stringify([targetIds, connectedIds]);
  useEffect(() => {
    if (available) controller.start();
    return () => controller.stop();
  }, [controller, available]);
  useEffect(() => { controller.connectionsChanged(); }, [controller, scope]);
  return <AutomaticUpdatesContext.Provider value={{ ...snapshot, available, environments: registry.environments, targetIds, connectedIds,
    enable: controller.enable, disable: controller.disable, refresh: controller.refresh, updateServer: controller.updateServer, recoverServer: controller.recoverServer }}>{children}</AutomaticUpdatesContext.Provider>;
}

export function AutomaticUpdatesSection() {
  const updates = useAutomaticUpdates();
  const [dialog, setDialog] = useState<'enable' | 'disable' | null>(null);
  const [approved, setApproved] = useState(false), [password, setPassword] = useState(true);
  const [reviewedIds, setReviewedIds] = useState<string[]>([]);
  const [enrollmentAttempted, setEnrollmentAttempted] = useState(false);
  const status = updates?.status;
  const enrolling = status?.servers.some(server => server.state === 'enrolling');
  const enrollmentNotice = enrolling
    ? 'Enrollment is not confirmed for all servers. Native reconciliation only inspects the existing grant; it does not repeat enrollment or enable the remaining servers. Check supervisor status before reviewing enrollment again.'
    : enrollmentAttempted ? 'Automatic updates have not been confirmed enabled for all reviewed servers. Check supervisor status before approving enrollment again. Existing server grants may remain; enrollment is never automatically repeated.' : '';
  const blocked = !updates?.available || updates.busy;
  const pending = automaticUpdatesPending(status ?? null);
  const scopeChanged = JSON.stringify(reviewedIds) !== JSON.stringify(updates?.targetIds ?? []);
  const canEnable = !blocked && !!status && !status.enabled && !updates?.uncertain && !pending && !!updates?.targetIds.length;
  const ids = [...new Set([...(updates?.targetIds ?? []), ...(status?.targets ?? []), ...(status?.servers.map(server => server.environmentId) ?? []), ...(status?.activeEnvironmentId ? [status.activeEnvironmentId] : [])])];
  const close = () => { setDialog(null); setApproved(false); setEnrollmentAttempted(false); };
  const open = (kind: 'enable' | 'disable') => {
    setApproved(false); setPassword(true); setEnrollmentAttempted(false); setReviewedIds(updates?.targetIds ?? []); setDialog(kind);
  };
  return <Section title="Automatic server updates" description="Global setting for all saved servers on this Mac, not just the selected connection.">
    <SettingRow title="Unattended Outpost releases" description="After a one-time opt-in for all saved servers, checks run only while this app is open and the server is connected. The native supervisor updates servers one at a time and restores update status across app restarts.">
      <Badge tone={updates?.uncertain || enrolling ? 'warning' : 'neutral'}>{!updates?.available ? 'Desktop app only' : updates.uncertain ? 'Status uncertain' : !status ? 'Status unknown' : enrolling ? 'Enrollment unconfirmed' : status.enabled ? 'Enabled' : 'Off'}</Badge>
    </SettingRow>
    <div className="provider-runtime-footer">
      {status?.enabled ? <Button disabled={blocked} onClick={() => open('disable')}>Turn off automatic updates…</Button> : <Button disabled={!canEnable} onClick={() => open('enable')}>Enable for all saved servers…</Button>}
      <Button disabled={blocked} onClick={() => void updates?.refresh()}>Check supervisor status</Button>
    </div>
    {!updates?.available && <p className="provider-runtime-note">Open the installed Outpost app to manage updates. Browser and recorded previews never contact the update supervisor.</p>}
    {updates?.available && !updates.targetIds.length && <p className="provider-runtime-note">No saved, nonretired servers are available for enrollment.</p>}
    {updates?.error && <p role="alert" className="provider-runtime-note">{updates.error}</p>}
    {enrollmentNotice && <p role="status" className="provider-runtime-note">{enrollmentNotice}</p>}
    {updates?.busy && <p role="status" className="provider-runtime-note">Contacting the native supervisor. Enrollment may require a protected native password dialog for each server.</p>}
    <div role="status" aria-live="polite">
      {ids.map(id => {
        const server = status?.servers.find(server => server.environmentId === id);
        const connected = updates?.connectedIds.includes(id) ?? false;
        const presentation = automaticUpdatePresentation(server, connected && !!updates?.available && !updates.uncertain);
        return <SettingRow key={id} title={updates?.environments[id]?.label ?? id} description={<>
          <span>{connected ? 'Connected' : 'Disconnected or connection information unavailable'} · {!status || updates?.uncertain ? 'Target status unknown' : status.targets.includes(id) ? 'Automatic-update target' : 'Not targeted for automatic updates'}</span>
          <p>{presentation.message}</p>
          {server?.releaseId && <p>Last reported release: <code>{server.releaseId}</code></p>}
          {status?.activeEnvironmentId === id && <p>Last reported active supervisor operation. Other updates stay queued until native reconciliation confirms its outcome.</p>}
          {presentation.uncertain && <p>The outcome is uncertain. Native reconciliation must confirm it; do not relaunch or reinstall.</p>}
        </>}><Badge tone={presentation.uncertain ? 'warning' : 'neutral'}>{presentation.label}</Badge></SettingRow>;
      })}
    </div>
    <p className="provider-runtime-note">Only signed, compatible Outpost server releases bundled with this app are eligible—not the latest release online. Newly saved servers are not silently enrolled; review all-server enrollment again to include them. Short service interruptions occur after existing work drains. A restricted updater grant does not allow unrestricted sudo, and no sudo password is stored. Offline and uncertain attempts remain in the native journal for reconciliation, not blind retries.</p>
    {!status?.enabled && pending && <p className="provider-runtime-note">Automatic launches are off, but a previous operation still needs reconciliation. Turning updates off does not cancel it.</p>}
    {dialog && <Dialog title={dialog === 'enable' ? 'Enable updates for all saved servers?' : 'Turn off automatic server updates?'} onClose={close} busy={updates?.busy} className="provider-runtime-dialog runtime-update-dialog">
      {dialog === 'enable' ? <>
        <p>This is a one-time opt-in for all saved, nonretired servers below—including offline servers—not only the connection currently selected. Native enrollment verifies each server’s SSH access.</p>
        <ul>{reviewedIds.map(id => <li key={id}>{updates?.environments[id]?.label ?? id}</li>)}</ul>
        <p>Checks run only while this app is open and the server is connected. Outpost may install only signed, compatible server releases bundled with this app, not the latest release online. The native supervisor updates servers sequentially; newly saved servers are not silently enrolled. Expect short service interruptions after existing tasks, sign-ins and imports drain.</p>
        <p>One-time enrollment uses a protected native password dialog for each server that needs it. It grants a restricted updater, not unrestricted sudo. No password enters this page or is stored.</p>
        <label className="provider-runtime-check"><input type="checkbox" checked={password} disabled={blocked} onChange={event => setPassword(event.target.checked)} />Ask for the remote sudo password in protected native dialogs</label>
        <p>Uncheck only for root or accounts with appropriate passwordless sudo.</p>
        <label className="provider-runtime-check"><input type="checkbox" checked={approved} disabled={blocked || scopeChanged} onChange={event => setApproved(event.target.checked)} />I approve unattended signed, compatible Outpost updates and short service interruptions for every server listed.</label>
        {scopeChanged && <p role="alert">The saved server list changed. Close this dialog and review all servers again before approving.</p>}
      </> : <p>This stops future automatic update launches from this Mac. It does not cancel an ongoing update or remove the restricted updater grant on any server. Existing operations continue to be reconciled.</p>}
      {updates?.error && <p role="alert">{updates.error}</p>}
      {dialog === 'enable' && enrollmentNotice && <p role="status">{enrollmentNotice}</p>}
      {updates?.busy && <p role="status">Waiting for the native supervisor. Complete any protected native enrollment dialogs.</p>}
      <div className="ui-dialog-actions runtime-update-actions">
        <Button disabled={updates?.busy} onClick={close}>Back</Button>
        {dialog === 'enable' ? <Button variant="primary" disabled={!canEnable || !approved || scopeChanged} onClick={() => {
          setApproved(false); setEnrollmentAttempted(true);
          void updates?.enable(approved, password, reviewedIds).then(confirmed => { if (confirmed) close(); });
        }}>Approve all-server automatic updates</Button> : <Button disabled={blocked} onClick={() => {
          void updates?.disable().then(confirmed => { if (confirmed) close(); });
        }}>Turn off future automatic updates</Button>}
      </div>
    </Dialog>}
  </Section>;
}

export function ServerUpdateIndicator({ environmentId, navigation = false }: { environmentId?: string | null; navigation?: boolean }) {
  const updates = useAutomaticUpdates();
  const rows = updates?.status?.servers.filter(server => environmentId === undefined || server.environmentId === environmentId) ?? [];
  const attention = rows.some(server => !['complete', 'idle', 'not_enabled'].includes(server.state));
  if (!attention && !updates?.uncertain) return null;
  return <span className="server-update-indicator" title="Server update needs attention" aria-label="Server update needs attention"><span className="environment-status" /><ServerUpdateIcon size={navigation ? 14 : 17} aria-hidden="true" /></span>;
}

export function ServerUpdateIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8V4h16v4M12 20V8m-5 5 5-5 5 5" /></svg>;
}
