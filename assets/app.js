// FranPerinatal — app.js v5
// Nav con panel mobile, reveal, forms, smoothing
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
  // El panel es un disclosure modal: el foco no debe escaparse al contenido de
  // fondo mientras esta abierto, Escape lo cierra y el foco vuelve al disparador.
  const burger = document.querySelector(".nav-burger");
  const panel = document.querySelector(".nav-panel");

  function panelFocusables() {
    if (!panel) return [];
    return Array.from(panel.querySelectorAll('a[href], button:not([disabled])'))
      .filter(el => el.offsetParent !== null || el.getClientRects().length);
  }

  function isOpen() { return !!panel && panel.classList.contains("open"); }

  function closePanel(restoreFocus) {
    if (!panel || !isOpen()) return;
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    if (burger) {
      burger.setAttribute("aria-expanded", "false");
      burger.setAttribute("aria-label", "Abrir menú");
      if (restoreFocus) burger.focus();
    }
    document.body.style.overflow = "";
  }

  function openPanel() {
    if (!panel || isOpen()) return;
    panel.classList.add("open");
    panel.removeAttribute("aria-hidden");
    if (burger) {
      burger.setAttribute("aria-expanded", "true");
      burger.setAttribute("aria-label", "Cerrar menú");
    }
    document.body.style.overflow = "hidden";
    const first = panelFocusables()[0];
    if (first) window.setTimeout(() => first.focus(), 60);
  }

  function togglePanel() { isOpen() ? closePanel(true) : openPanel(); }

  if (burger) {
    // <button> ya activa con Enter/Space via click nativo.
    burger.addEventListener("click", togglePanel);
  }
  if (panel) {
    panel.setAttribute("aria-hidden", "true");
    panel.querySelectorAll("a").forEach(a => a.addEventListener("click", () => closePanel(false)));
  }

  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); closePanel(true); return; }
    if (e.key !== "Tab") return;
    // Contencion de foco: el panel cubre la pagina, tabular no debe salir de el.
    const items = panelFocusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === burger || !panel.contains(active))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault(); first.focus();
    }
  });

  window.addEventListener("resize", () => { if (window.innerWidth > 960) closePanel(false); });

  // ---------- Una sola acción dominante en el primer viewport ----------
  // En Home conviven la acción del header y la del hero. Mientras el hero
  // está a la vista, la del header se mantiene contenida; al dejar atrás el
  // hero pasa a ser la acción primaria persistente. Sin animación.
  const heroEl = document.querySelector(".hero");
  const navEl = document.querySelector("header.nav");
  if (heroEl && navEl) {
    navEl.classList.add("nav--hero-visible");
    try {
      const hio = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          navEl.classList.toggle("nav--hero-visible", e.isIntersecting);
        });
      }, { threshold: 0 });
      hio.observe(heroEl);
    } catch (e) {
      navEl.classList.remove("nav--hero-visible");
    }
  }

  // ---------- Leadmag form — mismo origen; el Worker controla cualquier upstream ----------
  const LEADMAG_API_URL = '/api/leadmagnet';

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

      // El Worker decide si esta función está disponible en el ambiente actual.
      try {
        const resp = await fetch(LEADMAG_API_URL, {
          method:  'POST',
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

})();
