// FranPerinatal — app.js v6
// Nav con panel mobile, reveal, smoothing
// v6: la guía se lee directamente desde el sitio; sin captura de correo, sin
//     llamada a /api/leadmagnet y sin analytics de descarga.
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

  // ---------- Guía "10 señales" ----------
  // No hay formulario: la guía se abre desde el marcado (/guia/10-senales y su
  // PDF). Mientras /api/leadmagnet no sea una capacidad real, el sitio no pide
  // un correo ni promete un envío, así que aquí no queda nada que ejecutar.

})();
