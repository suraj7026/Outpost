(function () {
  if (window.OutpostTheme) return;
  var KEY = 'outpost-theme';
  function get() { try { return localStorage.getItem(KEY) || 'dark'; } catch (e) { return 'dark'; } }
  function apply(t) { document.documentElement.setAttribute('data-theme', t); document.dispatchEvent(new CustomEvent('outpost-theme', { detail: t })); }
  apply(get());
  window.OutpostTheme = {
    get: get,
    set: function (t) { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); },
    toggle: function () { this.set(get() === 'dark' ? 'light' : 'dark'); }
  };
  addEventListener('storage', function (e) { if (e.key === KEY) apply(get()); });
  addEventListener('keydown', function (e) {
    var tg = e.target && e.target.tagName;
    if (tg === 'INPUT' || tg === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 't' || e.key === 'T') window.OutpostTheme.toggle();
  });

  var fitQ = 0;
  function fit() { fitQ = 0; document.querySelectorAll('[data-fit]').forEach(function (el) { var w = +el.getAttribute('data-fit'); var z = Math.min(1, (innerWidth - 8) / w); if (el.style.zoom != String(z)) el.style.zoom = z; }); }
  function qfit() { if (!fitQ) fitQ = requestAnimationFrame(fit); }
  addEventListener('resize', qfit);
  new MutationObserver(qfit).observe(document.documentElement, { childList: true, subtree: true });

  var lucideP;
  function loadLucide() {
    if (window.lucide) return Promise.resolve(window.lucide);
    if (!lucideP) lucideP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js';
      s.onload = function () { res(window.lucide); }; s.onerror = rej;
      document.head.appendChild(s);
    });
    return lucideP;
  }
  function pascal(n) { return n.replace(/(^|-)([a-z0-9])/g, function (_, a, b) { return b.toUpperCase(); }); }

  class OIcon extends HTMLElement {
    static get observedAttributes() { return ['name', 'size', 'stroke']; }
    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    render() {
      var self = this, n = this.getAttribute('name'), sz = this.getAttribute('size') || 16;
      this.style.display = 'inline-flex'; this.style.flex = 'none';
      this.style.width = sz + 'px'; this.style.height = sz + 'px';
      if (!n) return;
      loadLucide().then(function (L) {
        var node = L.icons[pascal(n)];
        if (!node || self.getAttribute('name') !== n) return;
        var el = L.createElement(node);
        el.setAttribute('width', sz); el.setAttribute('height', sz);
        el.setAttribute('stroke-width', self.getAttribute('stroke') || 1.5);
        el.setAttribute('aria-hidden', 'true');
        (self.shadowRoot || self.attachShadow({ mode: 'open' })).replaceChildren(el);
      });
    }
  }
  customElements.define('o-icon', OIcon);

  var LABEL = { running: 'Running', needs: 'Needs you', done: 'Done', failed: 'Failed', interrupted: 'Interrupted' };
  var COLOR = { running: 'var(--text-2)', done: 'var(--text-2)', failed: 'var(--danger)', interrupted: 'var(--text-3)' };
  class OStatus extends HTMLElement {
    static get observedAttributes() { return ['kind', 'label', 'size']; }
    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    render() {
      var k = this.getAttribute('kind') || 'done', lab = this.getAttribute('label'), big = this.getAttribute('size') === 'lg';
      var s = big ? 16 : 14, fs = big ? 13 : 12;
      var root = this.shadowRoot || this.attachShadow({ mode: 'open' }); var KF = '<style>@keyframes o-spin{to{transform:rotate(360deg)}}@keyframes o-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>';
      this.setAttribute('role', 'img'); this.setAttribute('aria-label', LABEL[k] || k);
      this.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex:none;font-size:' + fs + 'px;line-height:1';
      if (k === 'needs') {
        root.innerHTML = KF + '<span style="display:inline-flex;align-items:center;gap:6px;height:' + (big ? 24 : 20) + 'px;padding:0 ' + (big ? 10 : 8) + 'px 0 ' + (big ? 9 : 7) + 'px;border-radius:999px;background:var(--ink);color:var(--on-ink);font-weight:500;white-space:nowrap"><span style="width:6px;height:6px;border-radius:50%;background:var(--on-ink);animation:o-pulse 1.8s ease-in-out infinite"></span>' + (lab || LABEL.needs) + '</span>';
        return;
      }
      var g = '';
      if (k === 'running') g = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" style="animation:o-spin 1.6s linear infinite;flex:none"><circle cx="8" cy="8" r="6" stroke="var(--border-strong)" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 6 6" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round"/></svg>';
      if (k === 'done') g = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" style="flex:none"><path d="M3.5 8.5l3 3 6-7" stroke="var(--text-2)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      if (k === 'failed') g = '<span style="width:' + s + 'px;height:' + s + 'px;display:inline-flex;align-items:center;justify-content:center;flex:none"><span style="width:7px;height:7px;border-radius:50%;background:var(--danger)"></span></span>';
      if (k === 'interrupted') g = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" style="flex:none"><circle cx="8" cy="8" r="5.25" stroke="var(--text-3)" stroke-width="1.5"/></svg>';
      var show = lab !== null || k === 'failed';
      root.innerHTML = KF + g + (show ? '<span style="color:' + COLOR[k] + ';white-space:nowrap' + (k === 'failed' ? ';font-weight:500' : '') + '">' + (lab || LABEL[k]) + '</span>' : '');
    }
  }
  customElements.define('o-status', OStatus);
})();
