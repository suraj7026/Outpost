import { useEffect, useState } from 'react';
import { CalendarClock, CheckCheck, ChevronRight, MessageSquare, NotebookPen, PanelLeft, Plus, Server } from 'lucide-react';
import ComposerPages from './ComposerPages';
import SettingsPages from './SettingsPages';
import WorkspacePages, { type WorkspacePage } from './WorkspacePages';
import { Badge, Button, Modal, NoticeProvider } from './ui';
import './styles.css';

const settingsTabs = [{id:'general',label:'General'},{id:'connection',label:'Connection'},{id:'models',label:'Models & providers'},{id:'runtime',label:'Pi & extensions'},{id:'devices',label:'Devices'},{id:'recovery',label:'Recovery'}];
const navigation = [{id:'new',label:'New task',icon:Plus},{id:'chat',label:'Conversation',icon:MessageSquare},{id:'machines',label:'Machines',icon:Server},{id:'chats',label:'All chats',icon:PanelLeft},{id:'approvals',label:'Approvals',icon:CheckCheck},{id:'automations',label:'Automations',icon:CalendarClock},{id:'memory',label:'Memory',icon:NotebookPen}];
const known = new Set([...navigation.map(item=>item.id),...settingsTabs.map(tab=>`settings/${tab.id}`)]);
const getRoute = () => { const route = location.hash.slice(1); return known.has(route) ? route : 'new'; };
export default function App() {
  const [route,setRoute] = useState(getRoute);
  const [about,setAbout] = useState(false);
  useEffect(()=>{ const hash=()=>setRoute(getRoute()); const navigate=(event:Event)=>{const value=(event as CustomEvent).detail; if(known.has(value)){event.preventDefault(); location.hash=value;setRoute(value);}}; window.addEventListener('hashchange',hash);window.addEventListener('review:navigate',navigate);return()=>{window.removeEventListener('hashchange',hash);window.removeEventListener('review:navigate',navigate);};},[]);
  const go=(next:string)=>{location.hash=next;setRoute(next);};
  useEffect(() => { document.querySelector('.review-tabs [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [route]);
  const settings=route==='machines'||route.startsWith('settings/');
  const activeTab=route==='machines'?'general':route.split('/')[1];
  const composer=route==='new'||route==='chat';
  return <NoticeProvider><div className="review-shell"><aside className="review-sidebar"><div className="review-sidebar-top"><span className="review-traffic" aria-hidden="true"><i/><i/><i/></span><span className="review-sidebar-caption">DESIGN REVIEW</span></div>
    <nav aria-label="Workspace">{navigation.map(item=><Button key={item.id} variant="ghost" aria-current={route===item.id||(item.id==='machines'&&settings)?'page':undefined} aria-label={item.label} title={item.label} onClick={()=>go(item.id)}><item.icon size={18}/><span>{item.label}</span></Button>)}</nav>

    <div className="review-sidebar-note">One shared control system.<br/>Existing Graphite styling.<br/><br/>Sample data only.<br/>Screens reset on navigation.</div>
  </aside><main className="review-main"><div className="review-topbar"><span className="inline"><Badge>Interactive mock</Badge><span>No live connections</span></span><Button variant="ghost" onClick={()=>setAbout(true)} style={{fontSize:11,minHeight:28,padding:'2px 8px'}}>Review notes <ChevronRight size={12}/></Button></div>
    {composer?<div className="review-composer-page"><ComposerPages mode={route as 'new'|'chat'}/></div>:<div className="review-scroll" key={route}><div className="review-page">{settings?<><div className="review-settings-header"><span className="review-settings-icon"><Server size={20}/></span><div className="grow"><h1>Development</h1><p>Server settings</p></div><Badge tone="success">Sample server</Badge></div><nav className="review-tabs" aria-label="Server settings tabs">{settingsTabs.map(tab=><button key={tab.id} aria-current={activeTab===tab.id?'page':undefined} onClick={()=>go(`settings/${tab.id}`)}>{tab.label}</button>)}</nav><SettingsPages tab={activeTab}/><div className="review-settings-footer">Design preview · all changes affect sample data only</div></>:<WorkspacePages page={route as WorkspacePage}/>}</div></div>}
  </main></div>{about&&<Modal title="Outpost consistency review" onClose={()=>setAbout(false)}><div className="stack review-about"><p>Built from Outpost’s existing Google Sans typography, Graphite palette, Lucide icons, and three-bar logo.</p><div><h3>Contributors</h3><ul><li>GPT‑6.1 Sol — settings, workspace flows, and consistency review</li><li>GLM‑5.3 Flash — composer, terminal, and cross-screen review</li></ul></div><p className="muted small">This is a local design proposal, not an installed app update. Provider access, runtime management, scheduling, and approvals are simulated. No credentials are requested; no network requests or server commands run.</p><Button onClick={()=>setAbout(false)}>Back to preview</Button></div></Modal>}</NoticeProvider>;
}
