import { useEffect, useRef, useState } from "react";
import { call, nativeApp, recordedPreview } from "./api";

const storageKey = "outpost.appearance.v1";
const minGlassOpacity = 0;
const maxGlassOpacity = 100;
const maxBlurRadius = 32;
const defaults = { frosted: false, opacity: 45, sidebarCollapsed: false };
type Preferences = typeof defaults;

function clampGlassOpacity(opacity: number) {
  return Math.max(minGlassOpacity, Math.min(maxGlassOpacity, opacity));
}

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return {
      frosted: value?.frosted === true,
      sidebarCollapsed: value?.sidebarCollapsed === true,
      opacity: typeof value?.opacity === "number" && Number.isFinite(value.opacity)
        ? clampGlassOpacity(value.opacity) : defaults.opacity,
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
    ...preferences, supported, reduced, error: error || storageError,
    setFrosted: (frosted: boolean) => setPreferences(value => ({ ...value, frosted })),
    setOpacity: (opacity: number) => setPreferences(value => ({ ...value, opacity: clampGlassOpacity(opacity) })),
    setSidebarCollapsed: (sidebarCollapsed: boolean) => setPreferences(value => ({ ...value, sidebarCollapsed })),
  };
}
export type Appearance = ReturnType<typeof useAppearance>;

export function AppearanceSettings({ appearance }: { appearance: Appearance }) {
  return <section className="settings-section appearance-settings" aria-labelledby="appearance-heading">
    <div><h2 id="appearance-heading">Appearance</h2><p>Window and navigation preferences saved on this Mac.</p></div>
    <div className="appearance-controls">
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
