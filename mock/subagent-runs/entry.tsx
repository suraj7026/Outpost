import './fixture.js';
import '../../desktop/src/main.tsx';
import { createRoot, type Root } from 'react-dom/client';
import SubagentDemo from './SubagentDemo';
import './subagents.css';

let selectedInitial = false;
let root: Root | undefined;
let mount: HTMLDivElement | undefined;
let controls: HTMLDivElement | undefined;
function install() {
  if (!selectedInitial) {
    const task = document.querySelector<HTMLButtonElement>('[data-task-id="subagent-ui-preview"]');
    if (task) { selectedInitial = true; task.click(); }
  }
  const anchor = document.querySelector<HTMLElement>('[data-record-id="delegation-intro"]');
  if (mount && !mount.isConnected) { root?.unmount(); root = undefined; mount = undefined; controls?.remove(); controls = undefined; }
  if (!anchor || mount) return;
  const columns = document.querySelector<HTMLElement>('.task-columns');
  const sidebarFooter = document.querySelector<HTMLElement>('.sidebar-bottom');
  if (!columns || !sidebarFooter) return;
  mount = document.createElement('div'); mount.className = 'subagent-demo-mount';
  anchor.after(mount);
  controls = document.createElement('div'); sidebarFooter.prepend(controls);
  root = createRoot(mount);
  root.render(<SubagentDemo columns={columns} footer={controls} />);
  requestAnimationFrame(() => { const transcript = columns.querySelector('.conversation'); if (transcript) transcript.scrollTop = 0; });
}
new MutationObserver(install).observe(document.getElementById('root')!, { childList: true, subtree: true });
install();
