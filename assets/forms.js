/* =========================================================================
   assets/forms.js — Submissions reales vía Formspree + fallback WhatsApp
   -------------------------------------------------------------------------
   Configuración:
   - Reemplaza FORMSPREE_ID con tu ID real de Formspree (formspree.io)
   - Reservar cuentas separadas para: reserva, contacto, leadmag (opcional)
   ========================================================================= */

(function(){
  'use strict';

  // TODO: reemplazar con IDs reales de Formspree (https://formspree.io/)
  // Cuando Francisca cree su cuenta, sustituir estos endpoints
  const ENDPOINTS = {
    reserva:   'https://formspree.io/f/XXXXXXXX',  // form de reserva
    contacto:  'https://formspree.io/f/XXXXXXXX',  // form de contacto
    leadmag:   'https://formspree.io/f/XXXXXXXX',  // suscripción a la guía
  };

  const WHATSAPP = '56957663038';

  /**
   * Envía un formulario a Formspree. Devuelve { ok, error }.
   * Si el endpoint no está configurado (XXXX), hace un mock success en dev.
   */
  async function submit(kind, data) {
    const url = ENDPOINTS[kind];
    if (!url || url.includes('XXXX')) {
      // Modo demo: simula éxito para que el flujo completo sea visible
      console.warn('[forms] Endpoint no configurado para:', kind, '— simulando éxito');
      await new Promise(r => setTimeout(r, 800));
      return { ok: true, demo: true };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) return { ok: true };
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j.error || 'No se pudo enviar. Intenta de nuevo.' };
    } catch(e) {
      return { ok: false, error: 'Sin conexión. Intenta de nuevo en unos minutos.' };
    }
  }

  /**
   * Construye un mensaje de WhatsApp pre-llenado como fallback.
   */
  function whatsappFallback(text) {
    const msg = encodeURIComponent(text);
    return `https://wa.me/${WHATSAPP}?text=${msg}`;
  }

  /**
   * Convierte un FormData en un objeto plano legible.
   */
  function formToObject(form) {
    const fd = new FormData(form);
    const obj = {};
    for (const [k, v] of fd.entries()) {
      if (obj[k] !== undefined) {
        obj[k] = [].concat(obj[k], v);
      } else {
        obj[k] = v;
      }
    }
    return obj;
  }

  window.FB = window.FB || {};
  window.FB.forms = { submit, whatsappFallback, formToObject, ENDPOINTS, WHATSAPP };
})();
