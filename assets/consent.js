/* ============================================================
   CONSENT — Francisca Bustos · franciscabustos.cl
   ------------------------------------------------------------
   Fuente ÚNICA del banner de consentimiento y de su texto. Antes existían
   diez copias del mismo bloque incrustadas en el HTML, con dos redacciones
   distintas, y la medición se cargaba en muchas más rutas de las que
   mostraban banner. Ahora: un archivo, una redacción, una decisión.

   Reglas:
     - No se afirma anonimato: el sitio no puede demostrarlo técnicamente.
     - No se afirma cumplimiento legal de ninguna norma.
     - Sin decisión → sólo funcionamiento esencial; ninguna etiqueta de
       medición se inicializa (lo garantiza assets/analytics.js).
     - "Solo esenciales" es una decisión válida y persistente, no un aplazamiento.
     - La decisión se puede revisar: cualquier control con [data-consent-open]
       (el enlace "Preferencias de cookies" del pie) vuelve a abrir el panel
       con la elección vigente y las dos mismas opciones. Abrirlo no mide nada
       ni toca otro almacenamiento del navegador; sólo decidir escribe la clave.

   Este archivo sólo dibuja y registra la decisión. Quién enciende o apaga la
   medición es assets/analytics.js, que debe cargarse en la misma página.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'fb_cookie_consent';
  var VALID = { accepted: 1, essentials: 1, rejected: 1 };

  function stored() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  // 'rejected' es el valor legado de "Solo esenciales".
  function current() {
    var v = stored();
    return v === 'accepted' ? 'accepted' : (VALID[v] ? 'essentials' : '');
  }

  var el = null;
  var opener = null;

  // El banner es fijo al pie: reserva su altura al final del documento para
  // que ningún control de la página quede tapado sin poder desplazarse
  // (en 320px de ancho el banner ocupa ~1/4 del alto). La variable la lee
  // assets/styles.css (body padding-bottom, html scroll-padding-bottom).
  function reserve() {
    var root = document.documentElement;
    if (el && el.offsetHeight) root.style.setProperty('--consent-h', el.offsetHeight + 'px');
    else root.style.removeProperty('--consent-h');
  }

  function close(restoreFocus) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    reserve();
    if (restoreFocus && opener && typeof opener.focus === 'function') opener.focus();
    opener = null;
  }

  function decide(choice) {
    if (choice === 'accept') {
      if (window.FB_acceptCookies) window.FB_acceptCookies();
      else { try { localStorage.setItem(KEY, 'accepted'); } catch (e) {} }
    } else if (choice === 'essentials') {
      if (window.FB_rejectCookies) window.FB_rejectCookies();
      else { try { localStorage.setItem(KEY, 'essentials'); } catch (e) {} }
    }
    close(true);
  }

  // mode: 'first' (sin decisión previa) | 'prefs' (revisión desde el pie).
  function build(mode) {
    if (el) close(false);
    var prefs = mode === 'prefs';
    var state = current();

    el = document.createElement('section');
    el.id = 'fb-consent';
    el.className = 'consent' + (prefs ? ' consent--prefs' : '');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Preferencias de medición');
    el.innerHTML =
      '<div class="consent-inner">' +
        '<p class="consent-copy">' +
          'Cookies esenciales para que el sitio funcione. Con tu permiso, medimos ' +
          'visitas y campañas. ' +
          '<a class="consent-link" href="/privacidad">Aviso de privacidad</a>' +
        '</p>' +
        (prefs
          ? '<p class="consent-status">Tu elección actual: <strong>' +
              (state === 'accepted' ? 'Aceptar medición' : 'Solo esenciales') +
            '</strong>. Puedes cambiarla aquí.</p>'
          : '') +
        '<div class="consent-actions">' +
          '<button type="button" class="consent-btn consent-btn--quiet" data-consent="essentials">Solo esenciales</button>' +
          '<button type="button" class="consent-btn consent-btn--solid" data-consent="accept">Aceptar medición</button>' +
        '</div>' +
        (prefs
          ? '<button type="button" class="consent-close" data-consent="close" aria-label="Cerrar sin cambiar">' +
              '<span aria-hidden="true">×</span>' +
            '</button>'
          : '') +
      '</div>';

    document.body.appendChild(el);
    reserve();

    el.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-consent]');
      if (!btn) return;
      var choice = btn.getAttribute('data-consent');
      if (choice === 'close') close(true);
      else decide(choice);
    });

    if (prefs) {
      // El panel se abrió a petición: el foco entra en él y Escape lo cierra
      // sin cambiar nada.
      var first = el.querySelector('[data-consent="' + (state === 'accepted' ? 'accept' : 'essentials') + '"]');
      if (first) first.focus();
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(true); }
      });
    }
  }

  function openPreferences(trigger) {
    opener = trigger || null;
    build('prefs');
  }

  function init() {
    // Los disparadores de revisión existen en el HTML pero nacen ocultos: sólo
    // se muestran cuando este archivo puede atenderlos.
    var triggers = document.querySelectorAll('[data-consent-open]');
    for (var i = 0; i < triggers.length; i += 1) {
      triggers[i].hidden = false;
      triggers[i].addEventListener('click', function (ev) {
        ev.preventDefault();
        openPreferences(ev.currentTarget);
      });
    }
    // Ya hay decisión (incluido el valor legado 'rejected') → no se dibuja nada.
    if (!current()) build('first');
    window.addEventListener('resize', reserve);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
