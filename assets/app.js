// FranPerinatal — app.js v5
// Nav con panel mobile, reveal, WhatsApp, forms, smoothing
// v4: leadmag usa AppsScript_leadmagnet independiente (no Google Forms, no script de agenda)
// v5: analytics de lead magnet sin PII (no email en GA4/Meta).
(function () {
  // ---------- Reveal on scroll ----------
  const all = document.querySelectorAll(".reveal");
  function show(el) {
    el.classList.add("in");
    el.style.opacity = "1";
    el.style.transform = "none";
  }
  const vh = window.innerHeight;
  all.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < vh * 0.9) requestAnimationFrame(() => show(el));
  });
  try {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } });
    }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });
    all.forEach((el) => { if (!el.classList.contains("in")) io.observe(el); });
  } catch (e) {}
  setTimeout(() => all.forEach(show), 1800);
  const force = () => all.forEach(show);
  window.addEventListener("scroll", force, { once: true, passive: true });
  window.addEventListener("pointerdown", force, { once: true });

  // ---------- Mobile nav panel ----------
  const burger = document.querySelector(".nav-burger");
  const panel = document.querySelector(".nav-panel");
  function closePanel() {
    if (!panel) return;
    panel.classList.remove("open");
    if (burger) burger.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }
  function togglePanel() {
    if (!panel) return;
    const open = panel.classList.toggle("open");
    if (burger) burger.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.style.overflow = open ? "hidden" : "";
  }
  if (burger) burger.addEventListener("click", togglePanel);
  if (panel) panel.querySelectorAll("a").forEach(a => a.addEventListener("click", closePanel));
  window.addEventListener("resize", () => { if (window.innerWidth > 960) closePanel(); });

  // ---------- Leadmag form — Apps Script separado (NO Google Forms, NO script de agenda) ----------
  // IMPORTANTE: reemplazar con la URL del deployment de AppsScript_leadmagnet.gs
  // Pasos: script.google.com > "FB Lead Magnet" > Implementar > App web > copiar URL aquí
  const LEADMAG_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzEJjo0_QCW624mzbIGXYwKJBbRlUqiON8pNnHW5Jqb5xF6Lp2uNTnM-AfkUFyXcpKb/exec';

  // Destino del PDF ya creado en guia/
  const LEADMAG_PDF_URL  = 'guia/10-senales.pdf';

  const lmForm = document.querySelector("[data-leadmag-form]");
  if (lmForm) {
    lmForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const emailInput = lmForm.querySelector("input[type=email]");
      const email = (emailInput?.value || "").trim();

      // Validación básica en frontend antes de enviar
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        if (emailInput) {
          emailInput.setCustomValidity("Ingresa un correo electrónico válido.");
          emailInput.reportValidity();
          emailInput.setCustomValidity("");
        }
        return;
      }

      const submitBtn = lmForm.querySelector("button[type=submit]");
      const okMsg     = lmForm.querySelector("[data-leadmag-ok]");
      const row       = lmForm.querySelector(".field-row");

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Enviando…"; }

      let envioCorrecto = false;

      // Enviar al Apps Script de lead magnet (separado del de agenda)
      try {
        const resp = await fetch(LEADMAG_WEBAPP_URL, {
          method:  'POST',
          mode:    'cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body:    JSON.stringify({ action: 'leadmag', email }),
        });
        const result = await resp.json().catch(() => ({}));
        envioCorrecto = !!(result && result.ok);
      } catch (_) {
        envioCorrecto = false;
      }

      // Actualizar mensaje de éxito/fallback según resultado real
      if (okMsg) {
        if (envioCorrecto) {
          okMsg.innerHTML =
            '<strong>✓ Gracias.</strong> Te enviamos la guía a tu correo y la abriremos ahora. ' +
            '<a href="' + LEADMAG_PDF_URL + '" target="_blank" rel="noopener" ' +
            'style="color:var(--accent-deep);text-decoration:underline">Abrirla de nuevo →</a>';
        } else {
          okMsg.innerHTML =
            'No pudimos enviar el correo en este momento, pero puedes leer la guía ahora. ' +
            '<a href="' + LEADMAG_PDF_URL + '" target="_blank" rel="noopener" ' +
            'style="color:var(--accent-deep);text-decoration:underline">Abrir la guía →</a>';
        }
        okMsg.hidden = false;
      }
      if (row) { row.style.display = "none"; }

      // Tracking
      if (window.fbTrack) {
        const leadMagnetParams = {
          lead_magnet_id: 'guia_10_senales',
          guide_name: 'guia_10_senales',
          source: 'leadmag_form',
          page_path: window.location.pathname,
          event_context: envioCorrecto ? 'leadmag_delivery_success' : 'leadmag_pdf_fallback'
        };
        window.fbTrack('descarga_guia', leadMagnetParams);
        window.fbTrack('submit_form_guia', {
          lead_magnet_id: leadMagnetParams.lead_magnet_id,
          guide_name: leadMagnetParams.guide_name,
          source: leadMagnetParams.source,
          page_path: leadMagnetParams.page_path,
          event_context: 'leadmag_form_submitted'
        });
      }

      // Abrir PDF en nueva pestaña — siempre, independiente del resultado del correo
      try { window.open(LEADMAG_PDF_URL, "_blank", "noopener"); } catch (_) {}
    });

    // Limpiar validación personalizada cuando el usuario edita el campo
    const lmEmailInput = lmForm.querySelector("input[type=email]");
    if (lmEmailInput) {
      lmEmailInput.addEventListener("input", function () { lmEmailInput.setCustomValidity(""); });
    }
  }

  // ---------- Apply tweaks ----------
  try {
    const a = localStorage.getItem("fb_accent");
    const d = localStorage.getItem("fb_density");
    if (a) document.documentElement.setAttribute("data-accent", a);
    if (d) document.documentElement.setAttribute("data-density", d);
  } catch (e) {}
})();
