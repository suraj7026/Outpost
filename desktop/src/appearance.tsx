import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, nativeApp, recordedPreview } from "./api";
import type { ConversationDetail } from './conversation-detail';
import './appearance-width.css';

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

export function AppearanceSettings({ appearance }: { appearance: Appearance }) {
  return <section className="settings-section appearance-settings" aria-labelledby="appearance-heading">
    <div><h2 id="appearance-heading">Appearance</h2><p>Theme, window and navigation preferences saved on this Mac.</p></div>
    <div className="appearance-controls">
      <fieldset className="appearance-width" aria-describedby="startup-page-description">
        <legend>On startup</legend>
        <p className="small" id="startup-page-description">Applies next launch. New task home page is the default.</p>
        <div className="appearance-width-options appearance-detail-options">{(['home', 'last'] as const).map(startupPage => <label key={startupPage}><input type="radio" name="startup-page" value={startupPage} checked={appearance.startupPage === startupPage} onChange={() => appearance.setStartupPage(startupPage)} /><span>{startupPage === 'home' ? 'New task home page' : 'Last working page'}</span></label>)}</div>
      </fieldset>
      <fieldset className="appearance-width"><legend>Theme</legend><p className="small">Auto follows your Mac’s appearance. Light and Dark stay as selected.</p><div className="appearance-width-options">{(['auto', 'light', 'dark'] as const).map(theme => <label key={theme}><input type="radio" name="theme" value={theme} checked={appearance.theme === theme} onChange={() => appearance.setTheme(theme)} /><span>{theme[0].toUpperCase() + theme.slice(1)}</span></label>)}</div></fieldset>
      <fieldset className="appearance-width"><legend>Conversation width</legend><p className="small">Choose the text column width. Avatars sit outside it; the layout fits smaller windows automatically.</p><div className="appearance-width-options">{(['narrow', 'wide', 'large'] as const).map(width => <label key={width}><input type="radio" name="conversation-width" value={width} checked={appearance.conversationWidth === width} onChange={() => appearance.setConversationWidth(width)} /><span>{width[0].toUpperCase() + width.slice(1)}</span></label>)}</div></fieldset>
      <fieldset className="appearance-width" aria-describedby="conversation-detail-description">
        <legend>Conversation detail</legend>
        <p className="small" id="conversation-detail-description">Compact keeps all tool calls and thinking traces collapsed by default. Extended expands them by default. Every row remains individually expandable. Normal responses and execution are unchanged.</p>
        <div className="appearance-width-options appearance-detail-options">{(['compact', 'extended'] as const).map(detail => <label key={detail}><input type="radio" name="conversation-detail" value={detail} checked={appearance.conversationDetail === detail} onChange={() => appearance.setConversationDetail(detail)} /><span>{detail[0].toUpperCase() + detail.slice(1)}</span></label>)}</div>
      </fieldset>
      <label className="appearance-toggle"><span>Frosted glass<small>Blur the desktop behind the sidebar and window frame.</small></span>
        <input type="checkbox" role="switch" aria-label="Frosted glass" checked={appearance.frosted} disabled={!appearance.supported} onChange={event => appearance.setFrosted(event.target.checked)} />
      </label>
      {!appearance.supported && <p className="small">Available in the macOS desktop app.</p>}
      {appearance.reduced && <p className="small">Using a solid background to respect reduced transparency or increased contrast.</p>}
      <label className="appearance-opacity" htmlFor="glass-opacity"><span>Glass opacity <output htmlFor="glass-opacity">{appearance.opacity}%</output></span>
        <input id="glass-opacity" type="range" min={minGlassOpacity} max={maxGlassOpacity} step="1" value={appearance.opacity} disabled={!appearance.supported || !appearance.frosted || appearance.reduced} onChange={event => appearance.setOpacity(Number(event.target.value))} />
        <small>0% is clear, 100% is solid, and frost is strongest in the middle.</small>
      </label>
      <label className="appearance-toggle"><span>Collapse sidebar<small>Hover the left edge to reveal it. Pin it inside the sidebar, or use ⌘B.</small></span>
        <input type="checkbox" role="switch" aria-label="Collapse sidebar" checked={appearance.sidebarCollapsed} onChange={event => appearance.setSidebarCollapsed(event.target.checked)} />
      </label>
      {appearance.error && <p role="alert" className="error-text">{appearance.error}</p>}
    </div>
  </section>;
}
