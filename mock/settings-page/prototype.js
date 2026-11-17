// Settings mock behavior. No custom motion engine: controls use the app's
// 140ms CSS timing, and the collapse preview replays the app's real sidebar
// motion (520ms spring in / 240ms ease out, from useSidebarMotion.ts).

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Theme: Auto tracks the system and keeps tracking it.
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const themeInputs = [...document.querySelectorAll('[data-theme-value]')];
const applyTheme = () => {
  const selected = themeInputs.find(input => input.checked)?.value ?? 'auto';
  document.documentElement.dataset.theme = selected === 'auto' ? (systemDark.matches ? 'dark' : 'light') : selected;
};
themeInputs.forEach(input => input.addEventListener('change', applyTheme));
systemDark.addEventListener('change', applyTheme);
applyTheme();

// Window group: the preview answers its controls directly.
const preview = document.querySelector('[data-preview]');
const sidebar = document.querySelector('[data-preview-sidebar]');
const main = document.querySelector('[data-preview-main]');
const frostToggle = document.querySelector('[data-frost-toggle]');
const collapseToggle = document.querySelector('[data-collapse-toggle]');
const slider = document.getElementById('glass-opacity');
const output = document.getElementById('glass-opacity-value');

const syncSlider = () => {
  const value = Number(slider.value);
  document.documentElement.style.setProperty('--frost', `${value}%`);
  output.textContent = `${value}%`;
};
slider.addEventListener('input', syncSlider);
syncSlider();

frostToggle.addEventListener('change', () => {
  preview.dataset.frost = frostToggle.checked ? 'on' : 'off';
  slider.disabled = !frostToggle.checked;
});

// Collapse preview: the same keyframes, offsets, easings and durations the app
// uses, starting from the current on-screen values so toggling mid-flight
// never jumps.
function setCollapsed(collapsed) {
  const current = {
    transform: getComputedStyle(sidebar).transform === 'none' ? 'translateX(0)' : getComputedStyle(sidebar).transform,
    opacity: getComputedStyle(sidebar).opacity,
    left: getComputedStyle(main).left,
  };
  sidebar.getAnimations().forEach(animation => animation.cancel());
  main.getAnimations().forEach(animation => animation.cancel());
  if (reduceMotion.matches) {
    sidebar.style.transform = collapsed ? 'translateX(-100%)' : 'translateX(0)';
    sidebar.style.opacity = collapsed ? '0' : '1';
    main.style.left = collapsed ? '8px' : '104px';
    return;
  }
  if (collapsed) {
    sidebar.animate([current, { transform: 'translateX(-100%)', opacity: 0 }], { duration: 240, easing: 'cubic-bezier(.4,0,.8,.25)', fill: 'both' });
    main.animate([{ left: current.left }, { left: '8px' }], { duration: 240, easing: 'cubic-bezier(.4,0,.8,.25)', fill: 'both' });
  } else {
    sidebar.animate([
      { transform: current.transform, opacity: current.opacity, offset: 0, easing: 'cubic-bezier(.18,.8,.25,1)' },
      { transform: 'translateX(7px)', opacity: 1, offset: .67, easing: 'ease-in-out' },
      { transform: 'translateX(-2px)', opacity: 1, offset: .86, easing: 'ease-out' },
      { transform: 'translateX(0)', opacity: 1, offset: 1 },
    ], { duration: 520, easing: 'linear', fill: 'both' });
    main.animate([
      { left: current.left, offset: 0, easing: 'cubic-bezier(.18,.8,.25,1)' },
      { left: '111px', offset: .67, easing: 'ease-in-out' },
      { left: '102px', offset: .86, easing: 'ease-out' },
      { left: '104px', offset: 1 },
    ], { duration: 520, easing: 'linear', fill: 'both' });
  }
}
collapseToggle.addEventListener('change', () => setCollapsed(collapseToggle.checked));
