// Tweaks panel — editable palette / serif / density
(function () {
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "accent": "malva",
    "serif": "Fraunces",
    "density": "editorial"
  }/*EDITMODE-END*/;

  const state = { ...TWEAK_DEFAULTS };
  try {
    const saved = localStorage.getItem("fb_tweaks");
    if (saved) Object.assign(state, JSON.parse(saved));
  } catch (e) {}

  const SERIFS = {
    "Fraunces": '"Fraunces", serif',
    "Cormorant Garamond": '"Cormorant Garamond", serif',
    "Lora": '"Lora", serif',
    "DM Serif Display": '"DM Serif Display", serif',
  };

  // Load all Google Fonts for serif swap
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Lora:wght@400;500&family=DM+Serif+Display&display=swap";
  document.head.appendChild(fontLink);

  function apply() {
    const root = document.documentElement;
    root.setAttribute("data-accent", state.accent);
    root.setAttribute("data-density", state.density);
    root.style.setProperty("--serif", SERIFS[state.serif] || SERIFS.Fraunces);
    try { localStorage.setItem("fb_tweaks", JSON.stringify(state)); } catch (e) {}
  }
  apply();

  let panel;
  function buildPanel() {
    panel = document.createElement("aside");
    panel.className = "tweaks-panel";
    panel.innerHTML = `
      <header class="tp-head">
        <span>Tweaks</span>
        <button class="tp-close" aria-label="Cerrar">×</button>
      </header>
      <div class="tp-body">
        <div class="tp-group">
          <label class="tp-label">Acento</label>
          <div class="tp-swatches" data-field="accent">
            <button data-val="malva" style="background:#8A5A6B" title="Malva clínico"></button>
            <button data-val="sage" style="background:#94A38C" title="Salvia"></button>
            <button data-val="neutral" style="background:#9A9085" title="Neutro"></button>
          </div>
        </div>
        <div class="tp-group">
          <label class="tp-label">Titular serif</label>
          <select data-field="serif">
            ${Object.keys(SERIFS).map(k => `<option value="${k}">${k}</option>`).join("")}
          </select>
        </div>
        <div class="tp-group">
          <label class="tp-label">Densidad</label>
          <div class="tp-seg" data-field="density">
            <button data-val="editorial">Editorial</button>
            <button data-val="compact">Compacta</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    syncPanel();

    panel.querySelector(".tp-close").addEventListener("click", hide);
    panel.querySelectorAll(".tp-swatches button, .tp-seg button").forEach(btn => {
      btn.addEventListener("click", () => {
        const field = btn.parentElement.dataset.field;
        state[field] = btn.dataset.val;
        apply(); syncPanel(); persist();
      });
    });
    panel.querySelector('select[data-field="serif"]').addEventListener("change", (e) => {
      state.serif = e.target.value;
      apply(); persist();
    });
  }
  function syncPanel() {
    if (!panel) return;
    panel.querySelectorAll(".tp-swatches button, .tp-seg button").forEach(btn => {
      const field = btn.parentElement.dataset.field;
      btn.classList.toggle("active", state[field] === btn.dataset.val);
    });
    panel.querySelector('select[data-field="serif"]').value = state.serif;
  }
  function persist() {
    try {
      window.parent.postMessage({ type: '__edit_mode_set_keys', edits: state }, '*');
    } catch (e) {}
  }
  function show() { if (!panel) buildPanel(); panel.classList.add("visible"); }
  function hide() { if (panel) panel.classList.remove("visible"); }

  window.addEventListener("message", (ev) => {
    if (!ev.data || typeof ev.data !== "object") return;
    if (ev.data.type === "__activate_edit_mode") show();
    else if (ev.data.type === "__deactivate_edit_mode") hide();
  });
  try { window.parent.postMessage({ type: "__edit_mode_available" }, "*"); } catch (e) {}

  // Inject panel styles
  const s = document.createElement("style");
  s.textContent = `
.tweaks-panel {
  position: fixed; bottom: 20px; right: 20px; z-index: 1000;
  width: 280px; background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(45,41,38,0.18);
  font-family: var(--sans);
  transform: translateY(20px); opacity: 0; pointer-events: none;
  transition: transform .25s ease, opacity .25s ease;
}
.tweaks-panel.visible { transform: translateY(0); opacity: 1; pointer-events: auto; }
.tp-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px; border-bottom: 1px solid var(--line);
  font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-2); font-weight: 500;
}
.tp-close { background: transparent; border: 0; font-size: 22px; cursor: pointer; color: var(--ink-2); line-height: 1; padding: 0 6px; }
.tp-body { padding: 18px 16px; display: flex; flex-direction: column; gap: 18px; }
.tp-label {
  display: block; font-size: 11px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink-3); margin-bottom: 10px; font-weight: 500;
}
.tp-swatches { display: flex; gap: 8px; }
.tp-swatches button {
  width: 34px; height: 34px; border-radius: 50%;
  border: 2px solid transparent; cursor: pointer;
  transition: transform .15s ease;
}
.tp-swatches button.active { border-color: var(--ink); transform: scale(1.05); }
.tp-seg { display: flex; background: var(--bg-2); border-radius: 999px; padding: 3px; }
.tp-seg button {
  flex: 1; border: 0; background: transparent; padding: 8px 12px; border-radius: 999px;
  font-size: 13px; cursor: pointer; color: var(--ink-2);
}
.tp-seg button.active { background: var(--paper); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.tweaks-panel select {
  width: 100%; padding: 10px 12px; border: 1px solid var(--line-strong);
  border-radius: 8px; background: var(--paper); font: inherit; font-size: 14px;
}
`;
  document.head.appendChild(s);
})();
