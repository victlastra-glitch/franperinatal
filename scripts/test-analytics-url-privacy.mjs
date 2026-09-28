#!/usr/bin/env node
/**
 * Analítica · la medición nunca recibe la query ni el fragmento de una URL.
 *
 * Carga assets/analytics.js en un contexto node:vm con un navegador mínimo
 * (location, document, localStorage, sessionStorage) y sin red: las etiquetas
 * que el archivo intenta cargar sólo se anotan, nunca se descargan, y los
 * hits de gtag se leen en window.dataLayer, que es exactamente lo que
 * gtag.js consumiría. Todos los valores son sintéticos.
 *
 * Contrato:
 *   - con medición aceptada, cada entrada de dataLayer carece de '?', '#',
 *     del parámetro ?servicio=… y de cualquier portador (token, st);
 *   - GA4 y Google Ads reciben page_location = origin + pathname y un
 *     page_referrer recortado (propio: origin + pathname; externo: origin),
 *     fijados con 'set' antes de cualquier 'config' y repetidos en cada 'config';
 *   - la campaña viaja como campaign_* acotados, no dentro de la URL;
 *   - en /manage, /pago y /pago-resultado no se inicializa nada, ni con una
 *     decisión 'accepted' almacenada ni al aceptar en la misma visita;
 *   - esas tres páginas no cargan analytics.js ni consent.js.
 *
 * Después rompe la guarda a propósito y exige que el contrato lo detecte.
 *
 *   node scripts/test-analytics-url-privacy.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(REPO_ROOT, 'assets/analytics.js'), 'utf8');
const SENSITIVE_PAGES = ['manage.html', 'pago.html', 'pago-resultado.html'];
const PAGES = Object.fromEntries(SENSITIVE_PAGES.map((p) => [p, readFileSync(path.join(REPO_ROOT, p), 'utf8')]));

const GA4_ID = 'G-LZ9TBN34ZN';
const GADS_ID = 'AW-18187430553';
// Nada de esto puede llegar a la medición: parámetros, fragmentos y portadores.
const FORBIDDEN = [/\?/, /#/, /servicio=/i, /duelo/i, /token/i, /\bst=/, /SYNTH/, /gclid/i, /utm_/i];

function storage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/* Un navegador mínimo: sólo lo que analytics.js usa. createElement/appendChild
   anotan la etiqueta en vez de ejecutarla, así nunca hay red. */
function run(source, { url, referrer = '', consent = '', accept = false }) {
  const u = new URL(url);
  const loadedScripts = [];
  const listeners = [];
  const sandbox = {
    console: { debug() {}, log() {}, warn() {} },
    URL, URLSearchParams, Date, JSON, Object, Array, String, Map,
    location: { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash },
    localStorage: storage(consent ? { fb_cookie_consent: consent } : {}),
    sessionStorage: storage(),
    document: {
      referrer,
      head: { appendChild: (el) => { loadedScripts.push(el.src || ''); } },
      createElement: () => ({}),
      getElementsByTagName: () => [{ parentNode: { insertBefore: (el) => { loadedScripts.push(el.src || ''); } } }],
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') listeners.push(fn); },
      querySelectorAll: () => [],
      body: { getAttribute: () => null, hasAttribute: () => false },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'analytics.js' }).runInContext(sandbox);
  if (accept) sandbox.FB_acceptCookies();
  listeners.forEach((fn) => fn());
  if (typeof sandbox.fbTrack === 'function') sandbox.fbTrack('probe_event', {});
  const entries = (sandbox.dataLayer || []).map((args) => Array.from(args));
  return { entries, loadedScripts, on: sandbox._fbMeasurementOn === true };
}

function contract(source) {
  const failures = [];
  let assertions = 0;
  const check = (ok, message) => { assertions += 1; if (!ok) failures.push(message); };

  const leakFree = (label, r) => {
    for (const entry of r.entries) {
      const text = JSON.stringify(entry);
      for (const re of FORBIDDEN) check(!re.test(text), label + ': dataLayer entry leaks ' + re + ' → ' + text.slice(0, 160));
    }
  };
  const configs = (r, id) => r.entries.filter((e) => e[0] === 'config' && e[1] === id);

  // 1. Motivo de consulta en la query, fragmento, referente propio con query.
  {
    const r = run(source, {
      url: 'https://franciscabustos.cl/reserva?servicio=duelo#paso-4',
      referrer: 'https://franciscabustos.cl/servicios?servicio=duelo#duelo',
      consent: 'accepted',
    });
    check(r.on && r.loadedScripts.length === 2, 'reserva: accepted consent loads GA4 and Ads (non-vacuous) ' + JSON.stringify(r.loadedScripts));
    leakFree('reserva', r);
    const setIdx = r.entries.findIndex((e) => e[0] === 'set');
    const firstConfig = r.entries.findIndex((e) => e[0] === 'config');
    check(setIdx >= 0 && firstConfig > setIdx, 'reserva: page fields are set before the first config');
    const set = r.entries[setIdx] || [];
    check(set[1] && set[1].page_location === 'https://franciscabustos.cl/reserva', 'reserva: set.page_location is origin + pathname ' + JSON.stringify(set[1]));
    check(set[1] && set[1].page_referrer === 'https://franciscabustos.cl/servicios', 'reserva: set.page_referrer is the same-origin path only ' + JSON.stringify(set[1]));
    for (const id of [GA4_ID, GADS_ID]) {
      const c = configs(r, id);
      check(c.length === 1, id + ': configured once (' + c.length + ')');
      const p = (c[0] || [])[2] || {};
      check(p.page_location === 'https://franciscabustos.cl/reserva', id + ': config.page_location is explicit and sanitized ' + JSON.stringify(p));
      check(p.page_referrer === 'https://franciscabustos.cl/servicios', id + ': config.page_referrer is explicit and sanitized ' + JSON.stringify(p));
    }
    const ga = ((configs(r, GA4_ID)[0] || [])[2]) || {};
    check(ga.anonymize_ip === true, 'GA4: existing anonymize_ip is preserved');
  }

  // 2. Campaña + gclid + referente externo con búsqueda.
  {
    const r = run(source, {
      url: 'https://franciscabustos.cl/servicios?utm_source=google&utm_medium=cpc&utm_campaign=perinatal&gclid=SYNTHgclid&servicio=duelo',
      referrer: 'https://www.google.com/search?q=depresion+posparto+SYNTH',
      consent: 'accepted',
    });
    leakFree('campaign', r);
    const p = ((configs(r, GA4_ID)[0] || [])[2]) || {};
    check(p.page_location === 'https://franciscabustos.cl/servicios', 'campaign: page_location drops the whole query ' + JSON.stringify(p));
    check(p.page_referrer === 'https://www.google.com/', 'campaign: an external referrer is reduced to its origin ' + JSON.stringify(p));
    check(p.campaign_source === 'google' && p.campaign_medium === 'cpc' && p.campaign_name === 'perinatal',
      'campaign: attribution travels as bounded campaign_* fields ' + JSON.stringify(p));
  }

  // 3. Aceptar en la misma visita, con portador y fragmento en la URL.
  {
    const r = run(source, { url: 'https://franciscabustos.cl/faq?token=SYNTHtoken#privacidad', accept: true });
    check(r.on, 'same-visit accept: measurement turns on');
    leakFree('same-visit accept', r);
  }

  // 4. Sin decisión: nada se carga y sólo existe el 'consent default'.
  {
    const r = run(source, { url: 'https://franciscabustos.cl/reserva?servicio=duelo' });
    check(!r.on && r.loadedScripts.length === 0, 'no decision: no tag loads');
    check(r.entries.every((e) => e[0] === 'consent' && e[1] === 'default'), 'no decision: only the consent default reaches dataLayer');
    leakFree('no decision', r);
  }

  // 5. Rutas con portadores o estado de pago: nunca se inicializa.
  for (const url of [
    'https://franciscabustos.cl/manage?token=SYNTHtoken',
    'https://franciscabustos.cl/manage/?token=SYNTHtoken',
    'https://franciscabustos.cl/manage.html?token=SYNTHtoken',
    'https://franciscabustos.cl/pago-resultado?st=SYNTHst',
    'https://franciscabustos.cl/pago-resultado.html?st=SYNTHst',
    'https://franciscabustos.cl/pago?order=SYNTHorder',
  ]) {
    for (const mode of [{ consent: 'accepted' }, { accept: true }]) {
      const r = run(source, Object.assign({ url }, mode));
      const label = new URL(url).pathname + (mode.accept ? ' (accept)' : ' (stored)');
      check(!r.on, label + ': measurement stays off');
      check(r.loadedScripts.length === 0, label + ': no tag is loaded ' + JSON.stringify(r.loadedScripts));
      check(!r.entries.some((e) => e[0] === 'config' || e[0] === 'set' || e[0] === 'event'), label + ': no config, set or event');
      check(!r.entries.some((e) => e[0] === 'consent' && e[1] === 'update'), label + ': consent is never granted');
    }
  }
  // A path that merely starts like a sensitive one keeps measurement.
  {
    const r = run(source, { url: 'https://franciscabustos.cl/pagos-y-valores', consent: 'accepted' });
    check(r.on, 'the route guard is anchored (a /pagos-… path is not blocked)');
  }

  // 6. El código fuente no lee la URL completa ni el fragmento.
  check(!/location\.href/.test(source), 'analytics.js never reads location.href');
  check(!/location\.hash/.test(source), 'analytics.js never reads location.hash');

  return { failures, assertions };
}

function pagesContract(pages) {
  const failures = [];
  let assertions = 0;
  for (const [name, html] of Object.entries(pages)) {
    assertions += 2;
    if (/<script[^>]+src="[^"]*(?:analytics|consent)\.js/i.test(html)) failures.push(name + ' loads analytics.js or consent.js');
    if (/<script[^>]+src="[^"]*googletagmanager/i.test(html)) failures.push(name + ' loads a Google tag directly');
  }
  return { failures, assertions };
}

const base = contract(SOURCE);
const pages = pagesContract(PAGES);

// ---------------------------------------------------------------------------
// Mutaciones: cada una rompe la guarda y el contrato tiene que notarlo.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  ['PAGE_LOCATION_FULL_HREF', 'src', 'return window.location.origin + window.location.pathname;', 'return window.location.origin + window.location.pathname + window.location.search;'],
  ['ROUTE_GUARD_REMOVED', 'src', 'if (!MEASUREMENT_ALLOWED) return;', ''],
  ['ROUTE_GUARD_UNANCHORED', 'src', '/^\\/(?:manage|pago|pago-resultado)(?:\\.html)?\\/?$/', '/^\\/(?:manage|pago|pago-resultado)/'],
  ['SET_BEFORE_CONFIG_REMOVED', 'src', "window.gtag('set', pageFields());", ''],
  ['GA4_CONFIG_WITHOUT_PAGE_FIELDS', 'src', '}, pageFields(), campaignFields()));', '}, campaignFields()));'],
  ['ADS_CONFIG_WITHOUT_PAGE_FIELDS', 'src', "window.gtag('config', GADS_ID, pageFields());", "window.gtag('config', GADS_ID);"],
  ['REFERRER_UNSANITIZED', 'src', "return ref.origin === window.location.origin ? ref.origin + ref.pathname : ref.origin + '/';", 'return document.referrer;'],
  ['CAMPAIGN_DROPPED', 'src', '}, pageFields(), campaignFields()));', '}, pageFields()));'],
  ['PAGO_RESULTADO_TAG_RESTORED', 'page', 'pago-resultado.html', '<script src="assets/analytics.js?v=5" defer></script>'],
];

const mutationResults = [];
for (const [name, kind, target, replacement] of MUTATIONS) {
  let detected;
  let note = '';
  if (kind === 'page') {
    const mutatedPages = Object.assign({}, PAGES, { [target]: PAGES[target] + replacement });
    const r = pagesContract(mutatedPages);
    detected = r.failures.length > 0;
    note = ' failures=' + r.failures.length;
  } else {
    const mutated = SOURCE.replace(target, replacement);
    if (mutated === SOURCE) {
      detected = false;
      note = ' (the mutation did not find its target)';
    } else {
      try {
        const r = contract(mutated);
        detected = r.failures.length > 0;
        note = ' failures=' + r.failures.length;
      } catch (error) {
        detected = true;
        note = ' threw=' + String(error).slice(0, 60);
      }
    }
  }
  mutationResults.push([name, detected, note]);
}

const allFailures = [...base.failures, ...pages.failures];
const undetected = mutationResults.filter(([, d]) => !d);
console.log('ANALYTICS_URL_PRIVACY=' + (allFailures.length ? 'FAIL' : 'PASS') +
  ' assertions=' + (base.assertions + pages.assertions) + ' failures=' + allFailures.length);
allFailures.forEach((f) => console.log('FAIL ' + f));
mutationResults.forEach(([name, d, note]) => console.log('MUTATION_' + name + '=' + (d ? 'DETECTED' : 'UNDETECTED') + note));
console.log('NO_NETWORK_TESTS=PASS count=' + (base.assertions + pages.assertions + MUTATIONS.length));
console.log('REAL_ANALYTICS_HITS=0');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');
if (allFailures.length || undetected.length) process.exit(1);
