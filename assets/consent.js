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

   Este archivo sólo dibuja y registra la decisión. Quién enciende la medición
   es assets/analytics.js, que debe cargarse en la misma página.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'fb_cookie_consent';
  var VALID = { accepted: 1, essentials: 1, rejected: 1 };

  function stored() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }

  // Ya hay decisión (incluido el valor legado 'rejected') → no se dibuja nada.
  if (VALID[stored()]) return;

  function build() {
    if (document.getElementById('fb-consent')) return;

    var el = document.createElement('section');
    el.id = 'fb-consent';
    el.className = 'consent';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Preferencias de medición');
    el.innerHTML =
      '<div class="consent-inner">' +
        '<p class="consent-copy">' +
          'Cookies esenciales para que el sitio funcione. Con tu permiso, medimos ' +
          'visitas y campañas. ' +
          '<a class="consent-link" href="/privacidad">Aviso de privacidad</a>' +
        '</p>' +
        '<div class="consent-actions">' +
          '<button type="button" class="consent-btn consent-btn--quiet" data-consent="essentials">Solo esenciales</button>' +
          '<button type="button" class="consent-btn consent-btn--solid" data-consent="accept">Aceptar medición</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(el);

    function decide(choice) {
      if (choice === 'accept') {
        if (window.FB_acceptCookies) window.FB_acceptCookies();
        else { try { localStorage.setItem(KEY, 'accepted'); } catch (e) {} }
      } else {
        if (window.FB_rejectCookies) window.FB_rejectCookies();
        else { try { localStorage.setItem(KEY, 'essentials'); } catch (e) {} }
      }
      el.parentNode && el.parentNode.removeChild(el);
    }

    el.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-consent]');
      if (btn) decide(btn.getAttribute('data-consent'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
