#!/usr/bin/env node
/**
 * Browser verification for the public web surface, driven the same way as
 * scripts/render-email-v4-previews.mjs: local headless Chrome over the DevTools
 * Protocol. Pages are served from this checkout by a throwaway HTTP server that
 * mimics Cloudflare Pages' extensionless routes and answers `/api/availability`
 * with a fixed, empty occupied-list. No other `/api/*` route is served: a call
 * to any of them is counted and fails the run. Measurement hosts are blocked at
 * the network layer, so accepting the consent banner never leaves the machine.
 *
 *   node scripts/test-web-ux-browser.mjs            # asserts only
 *   WEB_QA_SHOTS=/tmp/shots node scripts/test-web-ux-browser.mjs   # + PNGs
 *
 * What is pinned here (2026-09-19 remediation pass):
 *   A1 /reserva opens at the top, heading fully below the sticky nav
 *   A2 the summary total equals the chosen service's value
 *   B  the cookie decision can be reopened and changed from the footer,
 *      without touching unrelated storage and without loading a tag on open;
 *      the first-visit banner reserves its own height so nothing is trapped
 *   C  Home's guide section opens the guide directly: no email field, no
 *      promise of an email, no call to /api/leadmagnet, and the guide page it
 *      points at renders whole, gated by nothing
 *   D  the *4141 crisis link is a >=44px target at 390px, on Home and on /lp
 *   E  one required/optional convention on /reserva and /contacto
 *   F  no route slug as link text on the booking page
 *   G  every blog filter returns something specific; every card has a date;
 *      the author avatar is the 400w derivative
 *   I  no public page states a 50-60 minute session; /blog/primera-sesion
 *      says 50 minutes in prose, in its FAQ and in its FAQPage JSON-LD
 *   plus: no horizontal overflow, mobile menu opens with reachable links,
 *   no console errors, no external request besides Google Fonts.
 */
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const HTTP_PORT = 8766;
const CDP_PORT = 9224;
const ORIGIN = `http://${HOST}:${HTTP_PORT}`;
const SHOTS = process.env.WEB_QA_SHOTS || '';
const VIEWPORTS = [['390x844', 390, 844], ['768x1024', 768, 1024], ['1440x900', 1440, 900]];
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain', '.ico': 'image/x-icon',
};

const chrome = await (async () => {
  for (const candidate of CHROME_CANDIDATES) {
    try { await access(candidate); return candidate; } catch (_) { /* keep looking */ }
  }
  return '';
})();
if (!chrome) {
  console.log('SCREENSHOT_TOOLING=UNAVAILABLE');
  console.log('BROWSER_VERIFICATION=BLOCKED_BY_ENVIRONMENT');
  process.exit(0);
}

// --- Local static server: extensionless routes, stubbed availability ---------
const apiCalls = [];          // every /api/* hit, by path+method
const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    apiCalls.push(req.method + ' ' + url.pathname);
    if (url.pathname === '/api/availability' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slots: [] }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'not_served_in_browser_qa' }));
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  let file = path.join(REPO_ROOT, rel);
  try {
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      const asHtml = file + '.html';
      if (await stat(asHtml).then((s) => s.isFile()).catch(() => false)) file = asHtml;
      else { res.writeHead(404); res.end('not found'); return; }
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (_) {
    res.writeHead(500); res.end('error');
  }
});
await new Promise((resolve) => { server.listen(HTTP_PORT, HOST, resolve); });

// --- Chrome + CDP ------------------------------------------------------------
const profileDir = await mkdtemp(path.join(tmpdir(), 'fran-web-qa-'));
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text',
  '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profileDir, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const endpoint = await (async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const info = await (await fetch(`http://${HOST}:${CDP_PORT}/json/version`)).json();
      return info.webSocketDebuggerUrl;
    } catch (_) { await sleep(125); }
  }
  throw new Error('CHROME_DEVTOOLS_UNAVAILABLE');
})();
const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let messageId = 0;
const pending = new Map();
const listeners = [];
const consoleErrors = [];
const externalRequests = [];
const blockedRequests = [];
const BLOCKED = /googletagmanager\.com|google-analytics\.com|doubleclick\.net|facebook\.net|google\.com\/pagead/;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  listeners.forEach((fn) => fn(message));
};
const send = (method, params, sessionId) => new Promise((resolve, reject) => {
  messageId += 1;
  pending.set(messageId, { resolve, reject });
  socket.send(JSON.stringify({ id: messageId, method, params: params || {}, sessionId }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
// Measurement never leaves this machine, even if a test accepts the banner.
await send('Network.setBlockedURLs', { urls: ['*googletagmanager.com*', '*google-analytics.com*', '*doubleclick.net*', '*facebook.net*', '*google.com/pagead*'] }, sessionId);
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(currentPage + ' ' + (m.params.exceptionDetails.text || '') + ' ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || ''));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(currentPage + ' console.error ' + JSON.stringify(m.params.args.map((a) => a.value || a.description)));
  if (m.method === 'Network.requestWillBeSent') {
    const u = new URL(m.params.request.url);
    if (u.protocol === 'data:' || u.hostname === HOST || /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return;
    if (BLOCKED.test(m.params.request.url)) blockedRequests.push(m.params.requestId);
    else externalRequests.push(currentPage + ' ' + m.params.request.url);
  }
  if (m.method === 'Network.loadingFinished' && blockedRequests.includes(m.params.requestId)) {
    // A blocked request never finishes loading; one that does reached the network.
    externalRequests.push(currentPage + ' UNBLOCKED measurement request ' + m.params.requestId);
  }
});

let currentPage = '';
let assertions = 0;
const failures = [];
const check = (condition, message) => { assertions += 1; if (!condition) failures.push(currentPage + ' — ' + message); };
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const setViewport = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 }, sessionId);
const navigate = async (route, label) => {
  currentPage = label;
  const loaded = new Promise((resolve) => {
    const fn = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(fn), 1); resolve(); } };
    listeners.push(fn);
    setTimeout(() => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); resolve(); }, 10000);
  });
  await send('Page.navigate', { url: ORIGIN + route }, sessionId);
  await loaded;
  await sleep(350);
};
const clearStorage = () => evaluate('(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true; })()');
const click = async (selector) => {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!rect) throw new Error('click target missing: ' + selector);
  await sleep(120);
  const again = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: again.x, y: again.y }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: again.x, y: again.y, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: again.x, y: again.y, button: 'left', clickCount: 1 }, sessionId);
};
const pressKey = async (key, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }, sessionId);
};
const shot = async (name) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  await writeFile(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
};
const noOverflow = async () => {
  const o = await evaluate('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth');
  check(o <= 0, 'no horizontal overflow (' + o + 'px)');
};
const mobileMenu = async () => {
  await click('.nav-burger');
  await sleep(250);
  const panel = await evaluate(`(() => {
    const p = document.querySelector('.nav-panel');
    const links = [...p.querySelectorAll('a')].map((a) => a.getBoundingClientRect());
    return { open: p.classList.contains('open'), height: p.getBoundingClientRect().height,
      reachable: links.filter((r) => r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight).length, total: links.length };
  })()`);
  check(panel.open, 'mobile menu opens');
  check(panel.height > 300 && panel.reachable === panel.total, 'mobile menu links all reachable (' + panel.reachable + '/' + panel.total + ', ' + Math.round(panel.height) + 'px)');
  await pressKey('Escape', 'Escape', 27);
  await sleep(150);
  check(await evaluate("!document.querySelector('.nav-panel').classList.contains('open')"), 'Escape closes the mobile menu');
};

// --- /reserva ------------------------------------------------------------------
for (const [label, w, h] of VIEWPORTS) {
  await setViewport(w, h);
  await navigate('/reserva', 'reserva@' + label);
  await clearStorage();
  await navigate('/reserva', 'reserva@' + label);
  await sleep(900); // a smooth scroll, had one been issued, would be well under way
  const top = await evaluate(`(() => {
    const nav = document.querySelector('header.nav').getBoundingClientRect();
    const h1 = document.querySelector('.bk-header-title').getBoundingClientRect();
    const note = document.querySelector('.bk-header-note').getBoundingClientRect();
    return { scrollY: window.scrollY, navBottom: nav.bottom, h1Top: h1.top, noteBottom: note.bottom, focus: document.activeElement.tagName };
  })()`);
  check(top.scrollY < 1, 'A1 initial load stays at top (scrollY=' + top.scrollY + ')');
  check(top.h1Top >= top.navBottom && top.noteBottom <= h, 'A1 heading and reassurance line fully below the sticky nav (h1.top=' + Math.round(top.h1Top) + ', nav.bottom=' + Math.round(top.navBottom) + ')');
  check(top.focus === 'BODY', 'A1 no programmatic focus on load (active=' + top.focus + ')');
  await noOverflow();
  await shot('reserva-' + label + '-initial');

  check(await evaluate("[...document.querySelectorAll('#bk-form label')].some((l) => /\\*/.test(l.textContent)) === false"), 'E no asterisk in booking labels');
  check((await evaluate("document.querySelectorAll('#bk-form .field-optional').length")) === 2, 'E two optional fields marked "(opcional)"');
  check(await evaluate("document.querySelector('.bk-summary-list li span').textContent.trim() !== 'Precio' && [...document.querySelectorAll('.bk-summary-list li span')].some((s) => s.textContent.trim() === 'Valor')"), 'F summary uses "Valor" like the review card');
  check(await evaluate("[...document.querySelectorAll('a')].every((a) => a.textContent.trim() !== 'pago-resultado')"), 'F no route slug used as link text');
  check(await evaluate("document.body.textContent.indexOf('administrativamente') === -1"), 'F no "administrativamente" on the booking page');

  // Choose the service by a real pointer gesture (auto-advance) and check the total.
  await click('label[for="svc-primera"]');
  await sleep(700);
  const afterService = await evaluate(`(() => ({
    step: [...document.querySelectorAll('.bk-step')].find((s) => !s.hidden).dataset.step,
    price: document.querySelector('[data-field="price"]').textContent.trim(),
    total: document.querySelector('.bk-summary-total-val').textContent.trim(),
  }))()`);
  check(afterService.step === '2', 'auto-advance to the date step still works (step=' + afterService.step + ')');
  check(afterService.price === '$50.000' && afterService.total === '$50.000', 'A2 total equals the known value (price=' + afterService.price + ', total=' + afterService.total + ')');
  await shot('reserva-' + label + '-step2');

  // Pick the first selectable day, then the first hour, and reach the form.
  const day = await evaluate(`(() => { const b = [...document.querySelectorAll('.bk-day')].find((x) => !x.disabled && x.dataset.iso); return b ? b.dataset.iso : ''; })()`);
  check(!!day, 'a selectable day exists');
  if (day) {
    await click('.bk-day[data-iso="' + day + '"]');
    await sleep(900);
    const slots = await evaluate("document.querySelectorAll('.bk-slot:not([disabled])').length");
    check(slots > 0, 'hours render after the server confirmed the date (' + slots + ')');
    if (slots) {
      await click('.bk-slot:not([disabled])');
      await sleep(700);
      check((await evaluate("[...document.querySelectorAll('.bk-step')].find((s) => !s.hidden).dataset.step")) === '4', 'choosing an hour reaches the contact step');
      await shot('reserva-' + label + '-step4');

      // J: the billing step says what the billing fields are for and links to
      // /privacidad. Site links inherit colour and carry no underline, so the
      // assertion is that this one is visibly distinct from its own note.
      await evaluate(`(() => {
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('f-name', 'Prueba QA'); set('f-email', 'qa@example.cl'); set('f-phone', '+56 9 1234 5678');
        return true;
      })()`);
      await click('[data-action="submit-form"]');
      await sleep(500);
      check((await evaluate("[...document.querySelectorAll('.bk-step')].find((s) => !s.hidden).dataset.step")) === '5', 'J the billing step follows the contact step');
      const disclosure = await evaluate(`(() => {
        const step = document.querySelector('.bk-step[data-step="5"]');
        const a = step ? step.querySelector('.field-hint a[href="/privacidad"]') : null;
        if (!a) return null;
        const r = a.getBoundingClientRect();
        return { w: r.width, h: r.height, color: getComputedStyle(a).color,
          noteColor: getComputedStyle(a.parentElement).color,
          underline: getComputedStyle(a).textDecorationLine,
          boleta: /boleta/i.test(a.parentElement.textContent) };
      })()`);
      check(!!disclosure, 'J the billing step links to /privacidad');
      if (disclosure) {
        check(disclosure.w > 0 && disclosure.h > 0, 'J the privacy link is rendered (' + Math.round(disclosure.w) + 'x' + Math.round(disclosure.h) + ')');
        check(disclosure.color !== disclosure.noteColor, 'J the privacy link is distinguishable from its note (' + disclosure.color + ' vs ' + disclosure.noteColor + ')');
        check(/underline/.test(disclosure.underline), 'J the privacy link is underlined (' + disclosure.underline + ')');
        check(disclosure.boleta, 'J the note states the billing purpose');
      }
      await shot('reserva-' + label + '-step5');
    }
  }
  if (w < 700) await mobileMenu();
}
check(apiCalls.every((c) => c.startsWith('GET /api/availability')), 'only /api/availability was called (' + [...new Set(apiCalls)].join(', ') + ')');

// --- Home: lead magnet, crisis link, consent lifecycle ------------------------
for (const [label, w, h] of VIEWPORTS) {
  await setViewport(w, h);
  await navigate('/', 'home@' + label);
  await clearStorage();
  await evaluate("localStorage.setItem('qa_sentinel', 'keep'); true");
  await navigate('/', 'home@' + label);
  await noOverflow();
  const guide = await evaluate(`(() => {
    const sec = document.querySelector('.leadmag');
    const links = [...sec.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    return {
      fields: sec.querySelectorAll('input, textarea, form, button').length,
      links,
      opensGuide: links.filter((h) => /^\\/guia\\/10-senales/.test(h)).length,
      promise: /enviar|enviamos|enviaremos|envío|a tu correo|ingresa tu correo|recibirla|recibir la guía|suscri|newsletter|spam|te la mandamos/i.test(sec.textContent),
      handlers: !!sec.querySelector('[onclick], [onkeydown], [data-leadmag-form]'),
    };
  })()`);
  check(guide.fields === 0, 'C the guide section carries no form, input or submit control (' + guide.fields + ')');
  check(guide.opensGuide >= 2 && guide.links.every((h) => /^\/guia\/10-senales/.test(h)), 'C every action in the section opens the guide itself ' + JSON.stringify(guide.links));
  check(!guide.promise, 'C no copy in the section promises an email delivery or a subscription');
  check(!guide.handlers, 'C no residual lead-capture handler in the markup');
  check(await evaluate("document.querySelectorAll('script[src*=\"forms.js\"]').length === 0"), 'forms.js is no longer loaded');
  const crisis = await evaluate("(() => { const a = document.querySelector('.warning-note a[href=\"tel:*4141\"]'); const r = a.getBoundingClientRect(); return { h: r.height, text: a.textContent.trim(), lineH: document.querySelector('.warning-note').getBoundingClientRect().height }; })()");
  check(crisis.h >= 44, 'D crisis link target >= 44px (' + crisis.h.toFixed(1) + 'px)');
  check(crisis.text === '*4141', 'D crisis resource text preserved');

  // B — first visit: banner present, reserves its own height, footer link reachable.
  const banner = await evaluate(`(() => {
    const b = document.getElementById('fb-consent');
    if (!b) return null;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    const priv = document.querySelector('.footer-bottom a[href="/privacidad"]').getBoundingClientRect();
    const bh = b.getBoundingClientRect().height;
    const reserved = parseFloat(getComputedStyle(document.body).paddingBottom);
    const clipped = [...b.querySelectorAll('.consent-btn')].some((x) => x.scrollWidth > x.clientWidth + 1);
    return { bh, reserved, privBottom: priv.bottom, innerH: window.innerHeight, clipped, trigger: document.querySelector('[data-consent-open]').hidden === false };
  })()`);
  check(!!banner, 'B first-visit banner is shown');
  if (banner) {
    check(Math.abs(banner.reserved - banner.bh) < 1, 'B document reserves the banner height (' + Math.round(banner.bh) + 'px)');
    check(banner.privBottom <= banner.innerH - banner.bh + 1, 'B footer privacy link stays reachable above the banner (link.bottom=' + Math.round(banner.privBottom) + ', banner.top=' + Math.round(banner.innerH - banner.bh) + ')');
    check(!banner.clipped, 'B consent buttons not clipped');
    check(banner.trigger, 'B footer "Preferencias de cookies" is revealed by consent.js');
  }
  await shot('home-' + label + '-banner');
  await click('#fb-consent [data-consent="essentials"]');
  await sleep(200);
  check(await evaluate("!document.getElementById('fb-consent') && localStorage.getItem('fb_cookie_consent') === 'essentials' && getComputedStyle(document.body).paddingBottom === '0px'"), 'B "Solo esenciales" closes the banner, stores the decision, releases the space');
  check(await evaluate("document.querySelectorAll('script[src*=\"googletagmanager\"]').length === 0"), 'B no measurement tag after essentials');

  // Reopen from the footer: shows current choice, close changes nothing.
  await click('[data-consent-open]');
  await sleep(200);
  const prefs = await evaluate("(() => { const b = document.querySelector('#fb-consent.consent--prefs'); return b ? { status: b.querySelector('.consent-status').textContent, buttons: b.querySelectorAll('[data-consent]').length, tags: document.querySelectorAll('script[src*=\"googletagmanager\"]').length, focusInside: b.contains(document.activeElement) } : null; })()");
  check(!!prefs && /Solo esenciales/.test(prefs.status), 'B reopened panel shows the current choice');
  check(!!prefs && prefs.buttons === 3 && prefs.tags === 0 && prefs.focusInside, 'B reopening offers both choices plus close, loads nothing, takes focus');
  await shot('home-' + label + '-prefs');
  await pressKey('Escape', 'Escape', 27);
  await sleep(150);
  check(await evaluate("!document.getElementById('fb-consent') && localStorage.getItem('fb_cookie_consent') === 'essentials'"), 'B Escape closes without changing the decision');

  // Change to accepted: the tag element is created (its request is blocked here).
  await click('[data-consent-open]');
  await sleep(150);
  await click('#fb-consent [data-consent="accept"]');
  await sleep(300);
  check(await evaluate("localStorage.getItem('fb_cookie_consent') === 'accepted' && window._fbMeasurementOn === true && document.querySelectorAll('script[src*=\"googletagmanager\"]').length > 0"), 'B changing to "Aceptar medición" enables measurement');
  // And back to essentials mid-visit: Consent Mode is denied again and track() is a no-op.
  await click('[data-consent-open]');
  await sleep(150);
  check(await evaluate("/Aceptar medición/.test(document.querySelector('#fb-consent .consent-status').textContent)"), 'B reopened panel reflects the accepted state');
  await click('#fb-consent [data-consent="essentials"]');
  await sleep(200);
  const revoked = await evaluate("(() => { const last = window.dataLayer.filter((e) => e[0] === 'consent' && e[1] === 'update').pop(); return { stored: localStorage.getItem('fb_cookie_consent'), on: window._fbMeasurementOn, denied: !!last && last[2].analytics_storage === 'denied', sentinel: localStorage.getItem('qa_sentinel') }; })()");
  check(revoked.stored === 'essentials' && revoked.on === false && revoked.denied, 'B changing back to essentials revokes Consent Mode and mutes track()');
  check(revoked.sentinel === 'keep', 'B unrelated browser storage untouched');
  if (w < 700) await mobileMenu();
}

// 320px: the banner must not trap the page.
await setViewport(320, 568);
await navigate('/', 'home@320x568');
await clearStorage();
await navigate('/', 'home@320x568');
await noOverflow();
const narrow = await evaluate(`(() => {
  const b = document.getElementById('fb-consent');
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  const priv = document.querySelector('.footer-bottom a[href="/privacidad"]').getBoundingClientRect();
  const bh = b.getBoundingClientRect().height;
  return { bh, ratio: bh / window.innerHeight, reserved: parseFloat(getComputedStyle(document.body).paddingBottom), privBottom: priv.bottom, innerH: window.innerHeight,
    clipped: [...b.querySelectorAll('.consent-btn')].some((x) => x.scrollWidth > x.clientWidth + 1), overflow: b.scrollWidth - b.clientWidth };
})()`);
check(narrow.ratio < 0.4, 'B@320 banner height is bounded (' + Math.round(narrow.bh) + 'px, ' + Math.round(narrow.ratio * 100) + '% of viewport)');
check(Math.abs(narrow.reserved - narrow.bh) < 1 && narrow.privBottom <= narrow.innerH - narrow.bh + 1, 'B@320 last footer control reachable above the banner (link.bottom=' + Math.round(narrow.privBottom) + ', banner.top=' + Math.round(narrow.innerH - narrow.bh) + ')');
check(!narrow.clipped && narrow.overflow <= 0, 'B@320 banner controls not clipped');
await shot('home-320-banner');

// --- Blog hub + one article -----------------------------------------------------
for (const [label, w, h] of VIEWPORTS) {
  await setViewport(w, h);
  await navigate('/blog', 'blog@' + label);
  await evaluate("localStorage.setItem('fb_cookie_consent', 'essentials'); true");
  await navigate('/blog', 'blog@' + label);
  await noOverflow();
  const blog = await evaluate(`(() => {
    const filters = [...document.querySelectorAll('.blog-filter')].map((b) => b.dataset.filter);
    const entries = [...document.querySelectorAll('.blog-entry')];
    const counts = {};
    filters.forEach((f) => { counts[f] = entries.filter((e) => f === 'all' || (e.dataset.cat || '').split(/\\s+/).includes(f)).length; });
    const firstTwo = {};
    entries.forEach((e) => { const k = e.querySelector('.dek').textContent.trim().split(/\\s+/).slice(0, 2).join(' '); firstTwo[k] = (firstTwo[k] || 0) + 1; });
    return { filters, counts, total: entries.length, dated: entries.filter((e) => e.querySelector('time')).length, maxRepeat: Math.max(...Object.values(firstTwo)) };
  })()`);
  check(blog.filters.includes('duelo') && blog.counts.duelo === 2, 'G3 a Duelo filter exists and returns the two duelo articles');
  check(Object.entries(blog.counts).every(([f, n]) => f === 'all' || (n >= 1 && n <= Math.floor(blog.total * 0.75))), 'G3 every specific filter returns >=1 and < 75% of the corpus ' + JSON.stringify(blog.counts));
  check(blog.dated === blog.total, 'G5 every card has a date (' + blog.dated + '/' + blog.total + ')');
  check(blog.maxRepeat <= 2, 'G4 no more than two deks share their first two words (max=' + blog.maxRepeat + ')');
  await click('.blog-filter[data-filter="duelo"]');
  await sleep(150);
  check((await evaluate("[...document.querySelectorAll('.blog-entry')].filter((e) => !e.hidden).length")) === 2, 'G3 clicking Duelo shows exactly two articles');
  await shot('blog-' + label);

  await navigate('/blog/duelo-gestacional-apoyo-psicologico', 'article@' + label);
  await noOverflow();
  const author = await evaluate(`(async () => {
    const img = document.querySelector('.article-author img');
    if (!img) return null;
    if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    return { natural: img.naturalWidth, rendered: img.getBoundingClientRect().width, src: img.getAttribute('src'),
      name: document.querySelector('.article-author strong').textContent.trim(), cred: document.querySelector('.article-author span').textContent.trim() };
  })()`);
  check(!!author && author.natural === 400 && Math.round(author.rendered) === 48, 'G2 author avatar is the 400w derivative rendered at 48px (' + JSON.stringify(author) + ')');
  check(!!author && author.name === 'Francisca Bustos Maldonado' && /Registro 598177/.test(author.cred), 'G1 author block carries the shared name and credential line');
  await shot('article-' + label);
}

// --- /contacto and the EPDS page (footer trigger shared) ---------------------------
for (const [label, w, h] of VIEWPORTS) {
  await setViewport(w, h);
  await navigate('/contacto', 'contacto@' + label);
  await noOverflow();
  check(await evaluate("[...document.querySelectorAll('#contact-form label')].every((l) => !/\\*/.test(l.textContent))"), 'E no asterisk in contact labels');
  check((await evaluate("document.querySelectorAll('#contact-form .field-optional').length")) === 1, 'E the single optional contact field is marked "(opcional)"');
  check(await evaluate("document.querySelector('[data-consent-open]') && document.querySelector('[data-consent-open]').hidden === false"), 'B footer trigger present on /contacto');
  await shot('contacto-' + label);
}
await setViewport(390, 844);
await navigate('/recursos/test-edimburgo', 'epds@390x844');
await noOverflow();
check(await evaluate("!!document.querySelector('[data-consent-open]') && document.querySelector('[data-consent-open]').hidden === false"), 'B footer trigger present on the EPDS page');
check(await evaluate("typeof EPDS_QUESTIONS !== 'undefined' && EPDS_QUESTIONS.length === 10"), 'EPDS smoke: the ten-item instrument is intact');

// --- /lp: the same crisis target, and no lead-capture residue ---------------------
for (const [label, w, h] of [['390x844', 390, 844], ['1440x900', 1440, 900]]) {
  await setViewport(w, h);
  await navigate('/lp', 'lp@' + label);
  await evaluate("localStorage.setItem('fb_cookie_consent', 'essentials'); true");
  await navigate('/lp', 'lp@' + label);
  await noOverflow();
  const lp = await evaluate(`(async () => {
    const a = document.querySelector('.lp-crisis-note a[href="tel:*4141"]');
    const note = document.querySelector('.lp-crisis-note');
    // A loading="lazy" image only starts once it nears the viewport, so the page
    // is walked a screen at a time before the images are judged; each wait is
    // bounded so a never-started request cannot hang the run.
    const imgs = [...document.querySelectorAll('img')];
    for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => { setTimeout(r, 80); });
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; setTimeout(r, 3000); }))));
    return a ? { h: a.getBoundingClientRect().height, text: a.textContent.trim(),
      noteH: note.getBoundingClientRect().height, noteText: note.textContent.trim(),
      decoded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, total: imgs.length,
      broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.getAttribute('src')) } : null;
  })()`);
  check(!!lp && lp.h >= 44, 'D /lp crisis link target >= 44px (' + (lp ? lp.h.toFixed(1) : 'missing') + 'px)');
  check(!!lp && lp.text === '*4141', 'D /lp crisis resource text preserved');
  check(!!lp && /Línea de Prevención del Suicidio/.test(lp.noteText) && /servicio de urgencia/.test(lp.noteText), 'D /lp crisis wording and routing preserved');
  check(!!lp && lp.broken.length === 0, 'no broken image on /lp (' + (lp && lp.decoded) + '/' + (lp && lp.total) + ' decoded) ' + JSON.stringify(lp && lp.broken));
  await shot('lp-' + label);
}

// --- The first-session article states the real duration ---------------------------
for (const [label, w, h] of [['390x844', 390, 844], ['1440x900', 1440, 900]]) {
  await setViewport(w, h);
  await navigate('/blog/primera-sesion-psicologa-perinatal', 'primera-sesion@' + label);
  await noOverflow();
  const dur = await evaluate(`(() => {
    // A closed <details> keeps its answer out of innerText, so the copy is read
    // from a script-free clone: collapsed FAQ text counts, JSON-LD does not.
    const clone = document.body.cloneNode(true);
    [...clone.querySelectorAll('script, style')].forEach((n) => { n.remove(); });
    const text = clone.textContent;
    const faq = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((n) => { try { return JSON.parse(n.textContent); } catch (_) { return null; } })
      .find((j) => j && j['@type'] === 'FAQPage');
    const answer = faq ? faq.mainEntity.find((q) => /Cuánto dura/.test(q.name)).acceptedAnswer.text : '';
    const range = /50\\s*(?:y|a|-|–|—)\\s*60/i;
    return { range: range.test(text) || range.test(answer) || /60\\s*minutos/i.test(text + ' ' + answer),
      fifty: (text.match(/50\\s*minutos/gi) || []).length, answer };
  })()`);
  check(!dur.range, 'I the article states no 50-60 minute range');
  check(dur.fifty >= 2, 'I the article states 50 minutes in prose and in its FAQ (' + dur.fifty + ' mentions)');
  check(/^50 minutos\./.test(dur.answer), 'I the FAQPage JSON-LD answer states 50 minutos ("' + dur.answer.slice(0, 24) + '")');
  await shot('primera-sesion-' + label);
}
check(!apiCalls.some((c) => /leadmagnet/.test(c)), 'C no /api/leadmagnet request was made from any page');

// --- The guide itself, now the destination the Home section promises ----------------
for (const [label, w, h] of [['390x844', 390, 844], ['1440x900', 1440, 900]]) {
  await setViewport(w, h);
  await navigate('/guia/10-senales', 'guia@' + label);
  await noOverflow();
  const g = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('img')];
    return { title: document.title,
      heading: (document.querySelector('h1') || {}).textContent || '',
      signals: document.querySelectorAll('.signal, .urgent-signal').length,
      crisis: /\\*4141/.test(document.body.textContent),
      forms: document.querySelectorAll('form, input[type=email]').length,
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length };
  })()`);
  check(/10 señales/i.test(g.title) && /señales de que necesitas/i.test(g.heading), 'C the guide page renders its own title ("' + String(g.heading).slice(0, 40).trim() + '")');
  check(g.signals === 10, 'C the guide still carries its ten signals (' + g.signals + ')');
  check(g.crisis, 'C the guide keeps its *4141 crisis resource');
  check(g.forms === 0, 'C the guide asks for nothing before it can be read');
  check(g.broken === 0, 'no broken image on the guide');
  await shot('guia-' + label);
}

// --- /privacidad: the notice must describe the site that exists ------------------
// Every string below is a claim the current code either proves or contradicts.
const STALE_PRIVACY = [
  [/Formspree/i, 'Formspree (the contact form posts to a Google Form)'],
  [/(?<!No afirmo )cifrad[oa] de extremo a extremo/i, 'an end-to-end encryption claim'],
  [/correo mensual|darte de baja|Suscripci[oó]n a la gu[ií]a/i, 'a guide subscription'],
  [/limpiando los datos del sitio/i, 'clearing browser data as the only way to change consent'],
  [/12 meses desde el [uú]ltimo contacto|al menos 5 a[ñn]os/i, 'an invented retention period'],
  [/Ley 21\.719|Agencia de Protecci[oó]n de Datos/i, 'future legislation or authority as operative'],
  // The practice has no canonical public street address, and no fixed reply
  // deadline is promised: both were published without anything establishing them.
  [/domicilio profesional|Av\.? Las Condes|\bAvenida\b|\bcalle\b \S+ \d/i, 'a public street address'],
  [/\d+\s+d[ií]as\s+h[áa]biles/i, 'an invented fixed response deadline'],
];
for (const [label, w, h] of VIEWPORTS) {
  await setViewport(w, h);
  await navigate('/privacidad', 'privacidad@' + label);
  await noOverflow();
  const pr = await evaluate(`(() => {
    const main = document.querySelector('main').textContent.replace(/\\s+/g, ' ');
    const wrap = document.querySelector('.legal-wrap').getBoundingClientRect();
    return { main, width: wrap.width,
      sections: document.querySelectorAll('.legal h2').length,
      hrefs: [...document.querySelectorAll('main a')].map((a) => a.getAttribute('href')) };
  })()`);
  check(pr.sections >= 6 && pr.sections <= 9, 'the notice stays a readable number of sections (' + pr.sections + ')');
  check(pr.width <= 800, 'the notice keeps a comfortable measure (' + Math.round(pr.width) + 'px)');
  for (const [re, what] of STALE_PRIVACY) check(!re.test(pr.main), 'the notice no longer states ' + what);
  check(/RUT, direcci[oó]n y comuna/.test(pr.main) && /boleta de honorarios/.test(pr.main), 'billing data is described with its purpose');
  check(/no se env[ií]an a la pasarela de pago|No recibe tu RUT/.test(pr.main), 'billing data is stated not to reach the payment gateway');
  check(/formulario de Google/.test(pr.main), 'the contact path is described as it is');
  check(/se calculan en tu navegador/.test(pr.main) && /ni a ninguna herramienta de medici[oó]n/.test(pr.main), 'the Edinburgh scale is described as device-only');
  check(/tamizaje/.test(pr.main) && /no reemplaza una evaluaci[oó]n cl[ií]nica/.test(pr.main), 'screening is still distinguished from diagnosis');
  check(/Flow/.test(pr.main) && /Cloudflare/.test(pr.main), 'Flow and Cloudflare are named');
  check(/Preferencias de cookies/.test(pr.main), 'consent can be reopened, and the notice says where');
  check(/No afirmo que esa medici[oó]n sea an[oó]nima/.test(pr.main), 'measurement is not claimed to be anonymous');
  check(/No afirmo cifrado de extremo a extremo/.test(pr.main), 'protection is stated as transit encryption and restricted access');
  check(/No pido tu correo/.test(pr.main), 'the guide is stated to ask for no email');
  check(/plazos establecidos por la normativa aplicable/.test(pr.main),
    'the rights deadline defers to the applicable rules');
  check(/hola@franciscabustos\.cl/.test(pr.main), 'the contact mechanism is still the canonical email');
  await shot('privacidad-' + label);

  if (label === '1440x900') {
    for (const href of [...new Set(pr.hrefs)]) {
      if (!href || href.startsWith('mailto:') || href.startsWith('#')) continue;
      const res = await fetch(ORIGIN + href, { redirect: 'follow' }).catch(() => null);
      check(!!res && res.status < 400, 'link resolves: ' + href + ' (' + (res ? res.status : 'no response') + ')');
    }
  }
}

// --- Wrap up --------------------------------------------------------------------
socket.close();
child.kill('SIGTERM');
server.close();
await rm(profileDir, { recursive: true, force: true }).catch(() => {});

const blockedOnly = consoleErrors.filter((e) => !/ERR_BLOCKED_BY_CLIENT|googletagmanager/.test(e));
const money = apiCalls.filter((c) => /create-flow-payment|retry-flow-payment|refund/.test(c)).length;
console.log('SCREENSHOT_TOOLING=' + path.basename(chrome) + ' (CDP)' + (SHOTS ? ' shots=' + SHOTS : ''));
console.log('WEB_UX_BROWSER=' + (failures.length ? 'FAIL' : 'PASS') + ' assertions=' + assertions + ' failures=' + failures.length);
failures.forEach((f) => console.log('FAIL ' + f));
console.log('CONSOLE_ERRORS=' + blockedOnly.length + (blockedOnly.length ? ' ' + blockedOnly.join(' | ') : ''));
console.log('EXTERNAL_REQUESTS_NON_FONT=' + externalRequests.length + (externalRequests.length ? ' ' + externalRequests.join(' | ') : ''));
console.log('MEASUREMENT_REQUESTS_BLOCKED_LOCALLY=' + blockedRequests.length);
console.log('API_CALLS=' + JSON.stringify([...new Set(apiCalls)]));
console.log('REAL_MONETARY_FLOW_CALLS=' + money);
console.log('REAL_BOOKINGS_CREATED=0');
console.log('PRODUCTION_EMAILS_SENT=0');
console.log('REAL_NETWORK_SIDE_EFFECTS=' + externalRequests.length);
if (failures.length || blockedOnly.length || externalRequests.length || money) process.exit(1);
