import { useLayoutEffect, useRef, type CSSProperties } from "react";
import "./appearance-preview.css";

export interface AppearancePreviewProps {
  frosted: boolean;
  opacity: number;
  collapsed: boolean;
  reducedTransparency: boolean;
}

type PreviewStyle = CSSProperties & {
  "--appearance-preview-opacity": string;
  "--appearance-preview-filter": string;
};

const revealDuration = 520;
const hideDuration = 240;

export default function AppearancePreview({ frosted, opacity, collapsed, reducedTransparency }: AppearancePreviewProps) {
  const root = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const previousCollapsed = useRef(collapsed);
  const animations = useRef<Animation[]>([]);
  const percent = Number.isFinite(opacity) ? Math.max(0, Math.min(100, opacity)) : 100;
  const glass = frosted && !reducedTransparency && percent < 100;
  const fraction = percent / 100;
  const blur = glass ? Math.round(4 * 32 * fraction * (1 - fraction)) : 0;
  const style: PreviewStyle = {
    "--appearance-preview-opacity": `${glass ? percent : 100}%`,
    "--appearance-preview-filter": blur > 0 ? `blur(${blur}px) saturate(150%)` : "none",
  };

  useLayoutEffect(() => {
    const preview = root.current, panel = sidebar.current, content = main.current;
    if (!preview || !panel || !content) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let current = true;
    const changed = previousCollapsed.current !== collapsed;
    previousCollapsed.current = collapsed;

    const cancel = () => {
      animations.current.forEach(animation => animation.cancel());
      animations.current = [];
    };
    const settle = () => {
      panel.style.transform = collapsed ? "translateX(-100%)" : "translateX(0)";
      panel.style.opacity = collapsed ? "0" : "1";
      content.style.left = collapsed ? "8px" : "104px";
      cancel();
      preview.dataset.motion = "idle";
    };
    const updateReducedMotion = () => {
      preview.dataset.reducedMotion = String(reduced.matches);
      if (reduced.matches) settle();
    };
    preview.dataset.reducedMotion = String(reduced.matches);
    reduced.addEventListener("change", updateReducedMotion);

    if (!changed || reduced.matches || typeof panel.animate !== "function") {
      settle();
    } else {
      const presentation = getComputedStyle(panel);
      const start = {
        transform: presentation.transform === "none" ? "translateX(0)" : presentation.transform,
        opacity: presentation.opacity,
        left: getComputedStyle(content).left,
      };
      const timing: KeyframeAnimationOptions = {
        duration: collapsed ? hideDuration : revealDuration,
        easing: collapsed ? "cubic-bezier(.4,0,.8,.25)" : "linear",
        fill: "both",
      };
      const motion = panel.animate(collapsed ? [
        { transform: start.transform, opacity: start.opacity },
        { transform: "translateX(-100%)", opacity: 0 },
      ] : [
        { transform: start.transform, opacity: start.opacity, offset: 0, easing: "cubic-bezier(.18,.8,.25,1)" },
        { transform: "translateX(7px)", opacity: 1, offset: .67, easing: "ease-in-out" },
        { transform: "translateX(-2px)", opacity: 1, offset: .86, easing: "ease-out" },
        { transform: "translateX(0)", opacity: 1, offset: 1 },
      ], timing);
      const layout = content.animate(collapsed ? [
        { left: start.left }, { left: "8px" },
      ] : [
        { left: start.left, offset: 0, easing: "cubic-bezier(.18,.8,.25,1)" },
        { left: "111px", offset: .67, easing: "ease-in-out" },
        { left: "102px", offset: .86, easing: "ease-out" },
        { left: "104px", offset: 1 },
      ], timing);
      animations.current = [motion, layout];
      preview.dataset.motion = collapsed ? "collapsing" : "expanding";
      void Promise.all(animations.current.map(animation => animation.finished)).then(() => {
        if (current) settle();
      }).catch(() => {});
    }

    return () => {
      current = false;
      reduced.removeEventListener("change", updateReducedMotion);
      if (animations.current.length) {
        // Freeze presentation before canceling: the next effect starts here, not at the old target.
        const presentation = getComputedStyle(panel);
        const transform = presentation.transform, opacity = presentation.opacity;
        const left = getComputedStyle(content).left;
        panel.style.transform = transform;
        panel.style.opacity = opacity;
        content.style.left = left;
        cancel();
      }
    };
  }, [collapsed]);

  return <div
    ref={root}
    className="appearance-preview"
    aria-hidden="true"
    data-frost={glass ? "on" : "off"}
    data-collapsed={String(collapsed)}
    data-reduced-transparency={String(reducedTransparency)}
    data-opacity={percent}
    data-effective-opacity={glass ? percent : 100}
    data-blur-radius={blur}
    data-material={!glass ? "solid" : percent === 0 ? "clear" : "frosted"}
    style={style}
  >
    <span className="appearance-preview-wall" />
    <div ref={sidebar} className="appearance-preview-sidebar">
      <div className="appearance-preview-lights"><span /><span /><span /></div>
      <span className="appearance-preview-bar appearance-preview-bar-strong" />
      <span className="appearance-preview-bar" />
      <span className="appearance-preview-bar" />
      <span className="appearance-preview-bar" />
    </div>
    <div ref={main} className="appearance-preview-main">
      <div className="appearance-preview-content">
        <span className="appearance-preview-line" />
        <span className="appearance-preview-line appearance-preview-line-short" />
        <span className="appearance-preview-line" />
      </div>
    </div>
  </div>;
}
