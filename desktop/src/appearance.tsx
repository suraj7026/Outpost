import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, nativeApp, recordedPreview } from "./api";
import type { ConversationDetail } from './conversation-detail';
import { ArrowLeftRight, Contrast, Droplet, House, PanelLeft, Sparkles, TextAlignStart } from 'lucide-react';
import { Section, SettingRow } from './Interface';
import AppearancePreview from './AppearancePreview';
import './appearance-width.css';
import './appearance-settings.css';

const storageKey = "outpost.appearance.v1";
const minGlassOpacity = 0;
const maxGlassOpacity = 100;
const maxBlurRadius = 32;
export const conversationWidths = { narrow: 672, wide: 864, large: 1056 } as const;
export type ConversationWidth = keyof typeof conversationWidths;
const isConversationWidth = (value: unknown): value is ConversationWidth => value === 'narrow' || value === 'wide' || value === 'large';
export type StartupPage = 'home' | 'last';
const isStartupPage = (value: unknown): value is StartupPage => value === 'home' || value === 'last';
export type ThemePreference = 'auto' | 'light' | 'dark';
const isThemePreference = (value: unknown): value is ThemePreference => value === 'auto' || value === 'light' || value === 'dark';
const isConversationDetail = (value: unknown): value is ConversationDetail => value === 'compact' || value === 'extended';
const defaults = { startupPage: 'home' as StartupPage, theme: 'auto' as ThemePreference, frosted: false, opacity: 45, sidebarCollapsed: false, conversationWidth: 'narrow' as ConversationWidth, conversationDetail: 'compact' as ConversationDetail };
type Preferences = typeof defaults;
// App remounts when switching chats; retain choices even when storage is blocked.
let sessionPreferences: Preferences | undefined;

function clampGlassOpacity(opacity: number) {
  return Math.max(minGlassOpacity, Math.min(maxGlassOpacity, opacity));
}

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return {
      startupPage: isStartupPage(value?.startupPage) ? value.startupPage : defaults.startupPage,
      theme: isThemePreference(value?.theme) ? value.theme : defaults.theme,
      frosted: value?.frosted === true,
      sidebarCollapsed: value?.sidebarCollapsed === true,
      conversationWidth: isConversationWidth(value?.conversationWidth) ? value.conversationWidth : defaults.conversationWidth,
      conversationDetail: isConversationDetail(value?.conversationDetail) ? value.conversationDetail : defaults.conversationDetail,
      opacity: typeof value?.opacity === "number" && Number.isFinite(value.opacity)
        ? clampGlassOpacity(value.opacity) : defaults.opacity,
    };
  } catch { return defaults; }
}

export function readStartupPage(): StartupPage {
  return (sessionPreferences ?? readPreferences()).startupPage;
}

function applyTheme(theme: ThemePreference, systemDark: boolean) {
  document.documentElement.dataset.themePreference = theme;
  document.documentElement.dataset.theme = theme === 'auto' ? systemDark ? 'dark' : 'light' : theme;
}

export function initializeAppearance() {
  applyTheme(readPreferences().theme, matchMedia('(prefers-color-scheme: dark)').matches);
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useAppearance() {
  const [preferences, setPreferences] = useState(() => sessionPreferences ?? readPreferences());
  useLayoutEffect(() => { sessionPreferences = preferences; }, [preferences]);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [themeError, setThemeError] = useState("");
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const nativeThemeQueue = useRef<Promise<void>>(Promise.resolve());
  useLayoutEffect(() => applyTheme(preferences.theme, systemDark), [preferences.theme, systemDark]);
  useEffect(() => {
    if (!nativeApp() || recordedPreview()) return;
    let current = true;
    setThemeError('');
    nativeThemeQueue.current = nativeThemeQueue.current.catch(() => {}).then(async () => {
      if (!current) return;
      await getCurrentWindow().setTheme(preferences.theme === 'auto' ? null : preferences.theme);
    }).catch(() => {
      if (current) setThemeError('The window theme could not be applied. Choose another theme and try again.');
    });
    return () => { current = false; };
  }, [preferences.theme]);
  const reduced = useMediaQuery("(prefers-reduced-transparency: reduce), (prefers-contrast: more)");
  const supported = nativeApp() && !recordedPreview() && navigator.userAgent.includes("Macintosh");
  const glassEnabled = supported && preferences.frosted && !reduced && preferences.opacity < maxGlassOpacity;
  const opacity = preferences.opacity / maxGlassOpacity;
  // Frost is strongest halfway between clear glass and the solid background.
  const blurRadius = Math.round(4 * maxBlurRadius * opacity * (1 - opacity));
  const queue = useRef<Promise<void>>(Promise.resolve());
  const attempted = useRef(false);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); setStorageError(""); }
    catch { setStorageError("Appearance changes work now but could not be saved on this device."); }
    document.documentElement.style.setProperty("--glass-opacity", `${preferences.opacity}%`);
    document.documentElement.style.setProperty("--conversation-width", `${conversationWidths[preferences.conversationWidth]}px`);
    document.documentElement.dataset.conversationWidth = preferences.conversationWidth;
  }, [preferences]);
  useEffect(() => {
    let current = true;
    const root = document.documentElement;
    if (!glassEnabled) root.dataset.glass = "false";
    setError("");
    if (glassEnabled || attempted.current) {
      attempted.current = true;
      // Serialize native changes and skip slider positions superseded while waiting.
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (!current) return;
        await call<void>("set_window_blur", { radius: glassEnabled ? blurRadius : 0 });
        if (current) {
          root.style.setProperty("--glass-blur-radius", `${blurRadius}px`);
          root.dataset.glass = String(glassEnabled);
        }
      }).catch(() => {
        if (current) {
          root.dataset.glass = "false";
          setError("Frosted glass could not be applied. Using a solid background; switch it off and on to retry.");
        }
      });
    }
    return () => { current = false; };
  }, [glassEnabled, blurRadius]);
  return {
    ...preferences, supported, reduced, error: [error, storageError, themeError].filter(Boolean).join(' '),
    setStartupPage: (startupPage: StartupPage) => setPreferences(value => ({ ...value, startupPage })),
    setTheme: (theme: ThemePreference) => setPreferences(value => ({ ...value, theme })),
    setFrosted: (frosted: boolean) => setPreferences(value => ({ ...value, frosted })),
    setOpacity: (opacity: number) => setPreferences(value => ({ ...value, opacity: clampGlassOpacity(opacity) })),
    setSidebarCollapsed: (sidebarCollapsed: boolean) => setPreferences(value => ({ ...value, sidebarCollapsed })),
    setConversationWidth: (conversationWidth: ConversationWidth) => setPreferences(value => ({ ...value, conversationWidth })),
    setConversationDetail: (conversationDetail: ConversationDetail) => setPreferences(value => ({ ...value, conversationDetail })),
  };
}
export type Appearance = ReturnType<typeof useAppearance>;

function AppearanceChoiceRow({ title, description, icon, className = '', children }: {
  title: string; description: string; icon: ReactNode; className?: string; children: ReactNode;
}) {
  const descriptionId = useId();
  return <SettingRow className={`appearance-choice-row ${className}`} title={title} icon={icon}
    description={<span id={descriptionId}>{description}</span>}>
    <fieldset className="appearance-width" aria-describedby={descriptionId}>
      <legend className="sr-only">{title}</legend>
      {children}
    </fieldset>
  </SettingRow>;
}

function AppearanceToggleRow({ title, description, icon, checked, disabled, onChange }: {
  title: string; description: ReactNode; icon: ReactNode; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  const descriptionId = useId();
  return <label className="ui-row appearance-toggle">
    <span className="ui-row-icon" aria-hidden="true">{icon}</span>
    <span className="ui-row-content"><strong>{title}</strong><span className="ui-row-description" id={descriptionId}>{description}</span></span>
    <span className="ui-row-actions"><input type="checkbox" role="switch" aria-label={title} aria-describedby={descriptionId}
      checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></span>
  </label>;
}

export function AppearanceSettings({ appearance }: { appearance: Appearance }) {
  return <div className="appearance-settings appearance-preferences">
    <div className="appearance-controls ui-stack">
      <Section title="Startup" description="What Outpost opens when it starts.">
        <AppearanceChoiceRow title="On startup" className="appearance-startup-row" icon={<House size={18} />}
          description="Applies next launch. New task home page is the default.">
          <div className="appearance-width-options appearance-detail-options">{(['home', 'last'] as const).map(startupPage => <label key={startupPage}><input type="radio" name="startup-page" value={startupPage} checked={appearance.startupPage === startupPage} onChange={() => appearance.setStartupPage(startupPage)} /><span>{startupPage === 'home' ? 'New task home page' : 'Last working page'}</span></label>)}</div>
        </AppearanceChoiceRow>
      </Section>
      <Section title="Theme" description="Auto follows your Mac’s appearance.">
        <AppearanceChoiceRow title="Theme" icon={<Contrast size={18} />} description="Light and Dark stay as selected.">
          <div className="appearance-width-options">{(['auto', 'light', 'dark'] as const).map(theme => <label key={theme}><input type="radio" name="theme" value={theme} checked={appearance.theme === theme} onChange={() => appearance.setTheme(theme)} /><span>{theme[0].toUpperCase() + theme.slice(1)}</span></label>)}</div>
        </AppearanceChoiceRow>
      </Section>
      <Section title="Conversation" description="Text measure and how much execution detail is expanded.">
        <AppearanceChoiceRow title="Conversation width" icon={<ArrowLeftRight size={18} />}
          description="Avatars sit outside the text column; smaller windows adapt automatically.">
          <div className="appearance-width-options">{(['narrow', 'wide', 'large'] as const).map(width => <label key={width}><input type="radio" name="conversation-width" value={width} checked={appearance.conversationWidth === width} onChange={() => appearance.setConversationWidth(width)} /><span>{width[0].toUpperCase() + width.slice(1)}</span></label>)}</div>
        </AppearanceChoiceRow>
        <AppearanceChoiceRow title="Conversation detail" className="appearance-detail-row" icon={<TextAlignStart size={18} />}
          description="Compact collapses tool calls and thinking by default. Extended expands them. Every row remains individually expandable; responses and execution are unchanged.">
          <div className="appearance-width-options appearance-detail-options">{(['compact', 'extended'] as const).map(detail => <label key={detail}><input type="radio" name="conversation-detail" value={detail} checked={appearance.conversationDetail === detail} onChange={() => appearance.setConversationDetail(detail)} /><span>{detail[0].toUpperCase() + detail.slice(1)}</span></label>)}</div>
        </AppearanceChoiceRow>
      </Section>
      <Section title="Window" description="Sidebar behavior and the window material.">
        <AppearancePreview frosted={appearance.supported && appearance.frosted} opacity={appearance.opacity}
          collapsed={appearance.sidebarCollapsed} reducedTransparency={appearance.reduced} />
        <AppearanceToggleRow title="Frosted glass" icon={<Sparkles size={18} />} checked={appearance.frosted}
          disabled={!appearance.supported} onChange={appearance.setFrosted}
          description={<>Blur the desktop behind the sidebar and window frame.
            {!appearance.supported && <span className="appearance-support-note">Available in the macOS desktop app.</span>}
            {appearance.reduced && <span className="appearance-support-note">Using a solid background to respect reduced transparency or increased contrast.</span>}
          </>} />
        <SettingRow className="appearance-opacity-row" title={<label htmlFor="glass-opacity">Glass opacity</label>} icon={<Droplet size={18} />}
          description={<span id="glass-opacity-description">0% is clear, 100% is solid, and frost is strongest in the middle.</span>}>
          <div className="appearance-opacity">
            <input id="glass-opacity" aria-describedby="glass-opacity-description" type="range" min={minGlassOpacity} max={maxGlassOpacity} step="1" value={appearance.opacity}
              disabled={!appearance.supported || !appearance.frosted || appearance.reduced} onChange={event => appearance.setOpacity(Number(event.target.value))} />
            <output htmlFor="glass-opacity">{appearance.opacity}%</output>
          </div>
        </SettingRow>
        <AppearanceToggleRow title="Collapse sidebar" icon={<PanelLeft size={18} />} checked={appearance.sidebarCollapsed}
          onChange={appearance.setSidebarCollapsed} description="Hover the left edge to reveal it. Pin it inside the sidebar, or use ⌘B." />
      </Section>
      {appearance.error && <p role="alert" className="error-text">{appearance.error}</p>}
    </div>
  </div>;
}
