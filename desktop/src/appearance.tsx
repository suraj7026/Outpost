import { useEffect, useRef, useState } from "react";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";
import { nativeApp, recordedPreview } from "./api";

const storageKey = "outpost.appearance.v1";
const defaults = { frosted: false, opacity: 45, sidebarCollapsed: false };
type Preferences = typeof defaults;

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return {
      frosted: value?.frosted === true,
      sidebarCollapsed: value?.sidebarCollapsed === true,
      opacity: typeof value?.opacity === "number" && Number.isFinite(value.opacity)
        ? Math.max(20, Math.min(80, value.opacity)) : defaults.opacity,
    };
  } catch { return defaults; }
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
  const [preferences, setPreferences] = useState(readPreferences);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const reduced = useMediaQuery("(prefers-reduced-transparency: reduce), (prefers-contrast: more)");
  const supported = nativeApp() && !recordedPreview() && navigator.userAgent.includes("Macintosh");
  const queue = useRef<Promise<void>>(Promise.resolve());
  const attempted = useRef(false);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); setStorageError(""); }
    catch { setStorageError("Appearance changes work now but could not be saved on this device."); }
    const opacity = preferences.opacity / 100;
    const frameOpacity = opacity * .25;
    // Compensate under the reading surface so its composite stays unchanged
    // when only the surrounding frame/sidebar become more translucent.
    const readingBase = (opacity - frameOpacity) / (1 - frameOpacity);
    document.documentElement.style.setProperty("--glass-opacity", `${preferences.opacity}%`);
    document.documentElement.style.setProperty("--glass-frame-opacity", `${frameOpacity * 100}%`);
    document.documentElement.style.setProperty("--glass-reading-base-opacity", `${readingBase * 100}%`);
  }, [preferences]);
  useEffect(() => {
    let current = true;
    const root = document.documentElement;
    root.dataset.glass = "false";
    setError("");
    const enabled = supported && preferences.frosted && !reduced;
    if (enabled || attempted.current) {
      attempted.current = true;
      // Serialize native changes so a late enable cannot undo a newer disable.
      queue.current = queue.current.catch(() => {}).then(async () => {
        await getCurrentWindow().setEffects({
          effects: enabled ? [Effect.UnderWindowBackground] : [],
          state: EffectState.FollowsWindowActiveState,
        });
        if (current) root.dataset.glass = String(enabled);
      }).catch(() => {
        if (current) setError("Frosted glass could not be applied. Using a solid background; switch it off and on to retry.");
      });
    }
    return () => { current = false; root.dataset.glass = "false"; };
  }, [supported, preferences.frosted, reduced]);
  return {
    ...preferences, supported, reduced, error: error || storageError,
    setFrosted: (frosted: boolean) => setPreferences(value => ({ ...value, frosted })),
    setOpacity: (opacity: number) => setPreferences(value => ({ ...value, opacity: Math.max(20, Math.min(80, opacity)) })),
    setSidebarCollapsed: (sidebarCollapsed: boolean) => setPreferences(value => ({ ...value, sidebarCollapsed })),
  };
}
export type Appearance = ReturnType<typeof useAppearance>;

export function AppearanceSettings({ appearance }: { appearance: Appearance }) {
  return <section className="settings-section appearance-settings" aria-labelledby="appearance-heading">
    <div><h2 id="appearance-heading">Appearance</h2><p>Window and navigation preferences saved on this Mac.</p></div>
    <div className="appearance-controls">
      <label className="appearance-toggle"><span>Frosted glass<small>Blur the desktop behind the window. Text and controls stay opaque.</small></span>
        <input type="checkbox" role="switch" aria-label="Frosted glass" checked={appearance.frosted} disabled={!appearance.supported} onChange={event => appearance.setFrosted(event.target.checked)} />
      </label>
      {!appearance.supported && <p className="small">Available in the macOS desktop app.</p>}
      {appearance.reduced && <p className="small">Using a solid background to respect reduced transparency or increased contrast.</p>}
      <label className="appearance-opacity" htmlFor="glass-opacity"><span>Glass opacity <output htmlFor="glass-opacity">{appearance.opacity}%</output></span>
        <input id="glass-opacity" type="range" min="20" max="80" step="1" value={appearance.opacity} disabled={!appearance.supported || !appearance.frosted || appearance.reduced} onChange={event => appearance.setOpacity(Number(event.target.value))} />
        <small>Lower is more translucent. Blur stays on as transparency increases; text stays sharp.</small>
      </label>
      <label className="appearance-toggle"><span>Collapse sidebar<small>Hover the left edge to reveal it. Pin it inside the sidebar, or use ⌘B.</small></span>
        <input type="checkbox" role="switch" aria-label="Collapse sidebar" checked={appearance.sidebarCollapsed} onChange={event => appearance.setSidebarCollapsed(event.target.checked)} />
      </label>
      {appearance.error && <p role="alert" className="error-text">{appearance.error}</p>}
    </div>
  </section>;
}
