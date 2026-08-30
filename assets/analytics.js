/* ============================================================
   ANALYTICS — Francisca Bustos · franciscabustos.cl
   ------------------------------------------------------------
   Centraliza GA4 + Google Ads + Meta Pixel + eventos de conversión.

   IDs activos:
     - GA4:            G-LZ9TBN34ZN      ← ACTIVO
     - Google Ads:     AW-18187430553    ← ACTIVO (tag base + Consent Mode v2)
     - Conversión reserva_click: importada desde GA4 (no requiere label directo)
     - Conversión whatsapp_click: importada desde GA4 (pendiente, se activa cuando el evento fire en el sitio)
     - Meta Pixel:     000000000000000   ← REEMPLAZAR cuando actives Meta Ads

   Cómo obtener IDs de Google Ads:
     1. Google Ads → Herramientas → Medición → Conversiones
     2. Crear conversión "Reserva completada" y "Contacto WhatsApp"
     3. Copiar los IDs (AW-XXXXXXXX/YYYYYYYYY) aquí

   Eventos dispatched:
     - reserva_click        → cada CTA "Reservar primera sesión"
     - whatsapp_click       → cada CTA WhatsApp
     - llamada_15min_click  → CTA llamada gratuita
     - formulario_submit    → envío formulario contacto
     - landing_view         → vista landing específica
     - view_service         → vista de una página/área de servicio
     - start_booking        → entrada al flujo de reserva
     - payment_started      → solicitud de inicio de pago
     - booking_completed    → pago confirmado y reserva completada

   NOTA COOKIES: GA4 ahora carga con anonymize_ip en TODAS las páginas
   (privacy-safe, no requiere consentimiento previo bajo ePrivacy Chile).
   Google Ads usa Consent Mode v2 para máxima compatibilidad.
   ============================================================ */

(function () {
  'use strict';

  /* -------- 0. Google Ads Consent Mode v2 (ANTES de cualquier gtag) -------- */
  // Debe ejecutarse antes de cargar Google Ads tag
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  // Consent Mode v2: por defecto denegado, se actualiza tras aceptar banner
  window.gtag('consent', 'default', {
    'ad_storage':          'denied',
    'analytics_storage':   'denied',
    'ad_user_data':        'denied',
    'ad_personalization':  'denied',
    'wait_for_update':     800,
    'region':              ['CL']
  });

  /* -------- 1. Google Ads -------- */
  const GADS_ID = 'AW-18187430553';      // ✓ ID real — tag base para Consent Mode v2 y GCLID
  // Conversiones importadas desde GA4 — no se necesitan labels directos
  // (reserva_click y whatsapp_click llegan a Google Ads vía integración GA4 → Google Ads)
  const GADS_CONV_RESERVA  = null; // reserva_click: vía GA4 import ✓
  const GADS_CONV_WHATSAPP = null; // whatsapp_click: vía GA4 import (pendiente datos)
  const GADS_ENABLED = true; // ✓ ACTIVO

  if (GADS_ENABLED && !GADS_ID.includes('X')) {
    const gads = document.createElement('script');
    gads.async = true;
    gads.src = 'https://www.googletagmanager.com/gtag/js?id=' + GADS_ID;
    document.head.appendChild(gads);
    window.gtag('js', new Date());
    window.gtag('config', GADS_ID);
  }

  // Helpers de conversión expuestos globalmente (lp.html y otras páginas los llaman)
  // Las conversiones llegan a Google Ads vía GA4 import — solo necesitamos
  // disparar el evento GA4 correcto (reserva_click / whatsapp_click).
  window.gadsReserva = function () {
    if (!GADS_ENABLED) return;
    window.gtag('event', 'reserva_click', {
      event_category: 'conversion',
      value: 1.0,
      currency: 'CLP'
    });
  };
  window.gadsWhatsapp = function () {
    if (!GADS_ENABLED) return;
    window.gtag('event', 'whatsapp_click', {
      event_category: 'conversion',
      value: 0.5,
      currency: 'CLP'
    });
  };

  /* -------- 2. Google Analytics 4 -------- */
  // GA4 SIEMPRE activo con anonymize_ip (privacy-safe, no requiere consentimiento
  // previo bajo normativa chilena). Permite medir sesiones y conversiones.
  const GA4_ID = 'G-LZ9TBN34ZN';
  const GA4_ENABLED = true;

  function _initGA4() {
    if (window._ga4Loaded) return;
    window._ga4Loaded = true;
    const gs = document.createElement('script');
    gs.async = true;
    gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(gs);
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID, {
      anonymize_ip: true,
      cookie_flags: 'SameSite=None;Secure'
    });
  }

  if (GA4_ENABLED) _initGA4();

  // Actualizar consent si el usuario acepta el banner (activa cookies personalizadas)
  window.FB_acceptCookies = function () {
    try { localStorage.setItem('fb_cookie_consent', 'accepted'); } catch(e) {}
    window.gtag('consent', 'update', {
      'ad_storage':         'granted',
      'analytics_storage':  'granted',
      'ad_user_data':       'granted',
      'ad_personalization': 'granted'
    });
  };
  window.FB_rejectCookies = function () {
    try { localStorage.setItem('fb_cookie_consent', 'rejected'); } catch(e) {}
    // consent permanece en 'denied' (default)
  };

  // Auto-actualizar consent si ya aceptó previamente
  try {
    if (localStorage.getItem('fb_cookie_consent') === 'accepted') {
      window.FB_acceptCookies();
    }
  } catch(e) {}

  /* -------- 2. Meta Pixel -------- */
  const META_PIXEL_ID = '000000000000000'; // ← REEMPLAZAR con Pixel ID real
  const META_ENABLED = false;              // ← cambiar a true tras configurar

  if (META_ENABLED && META_PIXEL_ID && META_PIXEL_ID !== '000000000000000') {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0';
      n.queue = []; t = b.createElement(e); t.async = !0;
      t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  } else {
    window.fbq = function () {
      if (window.console && console.debug) {
        console.debug('[meta pixel stub]', Array.from(arguments));
      }
    };
  }

  /* -------- 3. Attribution + event tracker helpers -------- */
  const ATTRIBUTION_STORAGE_KEY = 'fb_marketing_attribution';
  const ATTRIBUTION_FIELDS = Object.freeze([
    ['source', ['utm_source', 'source']],
    ['medium', ['utm_medium', 'medium']],
    ['campaign', ['utm_campaign', 'campaign']]
  ]);

  // Sólo se aceptan identificadores de campaña acotados. Nunca se leen ni
  // envían campos de contacto, formularios, tokens o parámetros arbitrarios.
  function safeAttributionValue(value) {
    const normalized = String(value || '').trim().replace(/\s+/g, '-').slice(0, 100);
    return /^[a-z0-9][a-z0-9._~:/+-]{0,99}$/i.test(normalized) ? normalized : '';
  }

  function readStoredAttribution() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY) || '{}');
      return {
        source: safeAttributionValue(stored.source),
        medium: safeAttributionValue(stored.medium),
        campaign: safeAttributionValue(stored.campaign)
      };
    } catch (_) {
      return {};
    }
  }

  function getAttribution() {
    const params = new URLSearchParams(window.location.search);
    const stored = readStoredAttribution();
    const attribution = {};

    ATTRIBUTION_FIELDS.forEach(([field, keys]) => {
      for (const key of keys) {
        const value = safeAttributionValue(params.get(key));
        if (value) {
          attribution[field] = value;
          break;
        }
      }
      if (!attribution[field] && stored[field]) attribution[field] = stored[field];
    });

    try {
      if (Object.keys(attribution).length) {
        sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
      }
    } catch (_) {}

    return attribution;
  }

  const attribution = getAttribution();

  function track(eventName, params) {
    const eventParams = Object.assign({}, attribution, params || {});
    window.gtag('event', eventName, eventParams);
    // Meta Pixel custom event
    if (window.fbq) window.fbq('trackCustom', eventName, eventParams);
  }

  // Auto-bind CTAs por selector
  document.addEventListener('DOMContentLoaded', function () {
    // Reservas
    document.querySelectorAll('a[href*="reserva.html"], a[href*="/reserva"]').forEach(el => {
      el.addEventListener('click', () => track('reserva_click', {
        page: location.pathname,
        text: (el.textContent || '').trim().slice(0, 60)
      }));
    });

    // WhatsApp
    document.querySelectorAll('a[href*="wa.me"], a[href*="api.whatsapp.com"]').forEach(el => {
      el.addEventListener('click', () => track('whatsapp_click', {
        page: location.pathname,
        text: (el.textContent || '').trim().slice(0, 60)
      }));
    });

    // Llamada 15 min (CTA secundaria)
    document.querySelectorAll('[data-cta="llamada-15min"]').forEach(el => {
      el.addEventListener('click', () => track('llamada_15min_click', {
        page: location.pathname
      }));
    });

    // Formulario contacto
    document.querySelectorAll('form[data-form="contacto"]').forEach(f => {
      f.addEventListener('submit', () => track('formulario_submit', {
        page: location.pathname,
        form: f.getAttribute('name') || 'contacto'
      }));
    });

    // Landing-specific pageview (beyond standard GA4 pageview)
    const landing = document.body.getAttribute('data-landing');
    if (landing) track('landing_view', { landing: landing });

    // Service pages expose a stable, non-PII identifier in the markup.
    const service = document.body.getAttribute('data-service');
    if (service) track('view_service', { service: service });

    // Entering the booking page is the start of the public booking funnel.
    if (document.body.hasAttribute('data-booking-page')) {
      track('start_booking', { booking_type: 'online' });
    }
  });

  // Expose for manual firing
  window.fbTrack = track;
})();
