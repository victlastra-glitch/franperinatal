#!/usr/bin/env node
/**
 * Verificación en navegador del test de Edimburgo, con la misma mecánica que
 * scripts/test-web-ux-browser.mjs: Chrome headless local por DevTools Protocol
 * sobre un servidor de este checkout. Ninguna ruta /api/* se sirve: una llamada
 * cuenta como fallo. Los hosts de medición están bloqueados a nivel de red.
 *
 *   node scripts/test-epds-browser.mjs
 *   EPDS_QA_SHOTS=/tmp/shots node scripts/test-epds-browser.mjs   # + PNGs
 *
 * Qué se fija aquí:
 *   · la etapa se pregunta antes de empezar, sin preselección, y con teclado
 *   · sin etapa no se entra al test ni se obtiene interpretación
 *   · las diez preguntas se responden y el resultado corresponde a la etapa
 *   · ítem 10 > 0 muestra los recursos de ayuda antes de cualquier CTA
 *   · los teléfonos de ayuda son objetivos táctiles de 44px
 *   · NADA clínico sale del navegador: ni petición, ni evento, ni storage,
 *     ni siquiera con la medición aceptada
 */
import { access, mkdir, readFile, stat, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const HTTP_PORT = 8768;
const CDP_PORT = 9226;
const ORIGIN = `http://${HOST}:${HTTP_PORT}`;
const ROUTE = '/recursos/test-edimburgo';
const SHOTS = process.env.EPDS_QA_SHOTS || '';
const VIEWPORTS = [['390x844', 390, 844], ['768x1024', 768, 1024], ['1440x900', 1440, 900]];
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
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

const apiCalls = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    apiCalls.push(req.method + ' ' + url.pathname);
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'not_served_in_epds_qa' }));
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

const profileDir = await mkdtemp(path.join(tmpdir(), 'fran-epds-qa-'));
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
const requests = [];          // toda petición que sale de la página
const blockedIds = [];        // peticiones a hosts de medición, frenadas aquí
const unblocked = [];         // una de ellas que sí llegó a la red: fallo duro
const MEASUREMENT = /googletagmanager\.com|google-analytics\.com|doubleclick\.net|facebook\.net|google\.com\/pagead/;
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
await send('Network.setBlockedURLs', { urls: ['*googletagmanager.com*', '*google-analytics.com*', '*doubleclick.net*', '*facebook.net*', '*google.com/pagead*'] }, sessionId);

let currentPage = '';
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(currentPage + ' ' + (m.params.exceptionDetails.text || ''));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(currentPage + ' console.error ' + JSON.stringify(m.params.args.map((a) => a.value || a.description)));
  }
  if (m.method === 'Network.requestWillBeSent') {
    requests.push({
      page: currentPage,
      method: m.params.request.method,
      url: m.params.request.url,
      postData: m.params.request.postData || '',
    });
    if (MEASUREMENT.test(m.params.request.url)) blockedIds.push(m.params.requestId);
  }
  // Una petición bloqueada nunca termina de cargar; la que termina, salió.
  if (m.method === 'Network.loadingFinished' && blockedIds.includes(m.params.requestId)) {
    unblocked.push(m.params.requestId);
  }
});

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
/* Un gesto real: la posición se vuelve a leer justo antes de soltar, porque un
   scroll suave en curso deja obsoletas las coordenadas leídas antes. */
const click = async (selector) => {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) throw new Error('click target missing: ' + selector);
  await sleep(120);
  const again = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!again) throw new Error('click target vanished: ' + selector);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: again.x, y: again.y }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: again.x, y: again.y, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: again.x, y: again.y, button: 'left', clickCount: 1 }, sessionId);
};
const pressKey = async (key, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }, sessionId);
};
const shot = async (name) => {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  await writeFile(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
};
/* La decisión de cookies se fija antes de medir nada: el banner fijo al pie
   no debe interceptar un clic, y cada sección declara con qué consentimiento
   corre. No es estado clínico: es la decisión de cookies. */
const openPage = async (label, consent) => {
  await navigate(ROUTE, label);
  const already = await evaluate("(() => { try { return localStorage.getItem('fb_cookie_consent') || ''; } catch (e) { return ''; } })()");
  if (already !== consent) {
    await evaluate(`try { localStorage.setItem('fb_cookie_consent', ${JSON.stringify(consent)}); } catch (e) {} true`);
    await navigate(ROUTE, label);
  }
  await evaluate("(() => { const b = document.getElementById('fb-consent'); if (b) b.remove(); return true; })()");
};
const noOverflow = async () => {
  const o = await evaluate('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth');
  check(o <= 0, 'sin desborde horizontal (' + o + 'px)');
};

/* Responde las diez preguntas con un vector de índices de opción, por puntero,
   respetando el auto-avance de 260 ms que hace la página. */
const answerAll = async (indexes) => {
  for (let i = 0; i < indexes.length; i += 1) {
    const ready = await evaluate(`document.getElementById('counter').textContent.trim() === ${JSON.stringify((i + 1) + ' / 10')}`);
    check(ready, 'la pregunta ' + (i + 1) + ' está en pantalla antes de responderla');
    await click(`#options .epds-option:nth-child(${indexes[i] + 1})`);
    await sleep(420);
  }
  await sleep(700);
};
const readResult = () => evaluate(`(() => {
  const band = document.getElementById('band');
  const crisis = document.getElementById('crisis-box');
  const next = document.querySelector('.epds-next');
  const cta = document.querySelector('.epds-next-actions a[href="/reserva"]');
  const result = document.getElementById('result');
  return {
    active: result.classList.contains('active'),
    introHidden: getComputedStyle(document.getElementById('intro')).display === 'none',
    band: band.textContent.trim(),
    tone: band.className.replace('epds-result-band', '').trim(),
    score: document.getElementById('score-num').textContent.trim(),
    title: document.getElementById('result-title').textContent.trim(),
    body: document.getElementById('result-body').textContent.trim(),
    nextText: document.getElementById('result-next').textContent.trim(),
    crisisVisible: getComputedStyle(crisis).display !== 'none',
    crisisTop: crisis.getBoundingClientRect().top + window.scrollY,
    ctaTop: cta ? cta.getBoundingClientRect().top + window.scrollY : -1,
    nextTop: next.getBoundingClientRect().top + window.scrollY,
    bottom: Math.max(...[...document.querySelectorAll('#result *')].map((e) => e.getBoundingClientRect().right)),
    telTargets: [...document.querySelectorAll('.epds-crisis-lines a[href^="tel:"]')].map((a) => ({
      href: a.getAttribute('href'), h: a.getBoundingClientRect().height, text: a.textContent.trim(),
    })),
  };
})()`);

// =============================================================================
// 1 · Intro, etapa y teclado, en los tres anchos
// =============================================================================
for (const [label, w, h] of VIEWPORTS) {
  await setViewport(w, h);
  await openPage('epds@' + label, 'essentials');
  await noOverflow();

  const intro = await evaluate(`(() => {
    const fs = document.getElementById('epds-stage');
    const inputs = [...document.querySelectorAll('input[name="epds-stage"]')];
    const begin = document.getElementById('epds-begin');
    const r = fs.getBoundingClientRect();
    const nav = document.querySelector('header.nav').getBoundingClientRect();
    return {
      legend: fs.querySelector('legend').textContent.trim(),
      options: inputs.map((i) => ({ value: i.value, checked: i.checked, label: i.closest('label').textContent.trim(),
        h: i.closest('label').getBoundingClientRect().height })),
      hintHidden: document.getElementById('epds-stage-hint').hidden,
      beginBelowStage: begin.getBoundingClientRect().top >= r.bottom,
      stageVisible: r.top >= 0 && r.width > 0,
      navBottom: nav.bottom,
      scrollY: window.scrollY,
    };
  })()`);
  check(/¿En qué etapa estás actualmente\?/.test(intro.legend), 'la intro pregunta la etapa ("' + intro.legend + '")');
  check(intro.options.length === 2 && intro.options[0].value === 'embarazo' && intro.options[1].value === 'posparto',
    'ofrece Embarazo y Posparto ' + JSON.stringify(intro.options.map((o) => o.value)));
  check(intro.options.every((o) => !o.checked), 'ninguna etapa viene preseleccionada');
  check(intro.options.every((o) => o.h >= 44), 'cada opción de etapa es un objetivo de 44px ' + JSON.stringify(intro.options.map((o) => Math.round(o.h))));
  check(intro.hintHidden, 'el aviso de etapa sólo aparece cuando hace falta');
  check(intro.beginBelowStage, 'la etapa se pregunta antes del botón de comenzar');
  check(intro.scrollY < 1, 'la página abre arriba (scrollY=' + intro.scrollY + ')');
  await shot('epds-' + label + '-intro');

  // Sin etapa no se entra al test: aviso visible y foco en la primera opción.
  await click('#epds-begin');
  await sleep(300);
  const blocked = await evaluate(`(() => ({
    running: document.getElementById('test').classList.contains('active'),
    hintHidden: document.getElementById('epds-stage-hint').hidden,
    hintText: document.getElementById('epds-stage-hint').textContent.trim(),
    focus: document.activeElement.name || document.activeElement.id || document.activeElement.tagName,
  }))()`);
  check(!blocked.running, 'sin etapa el test no comienza');
  check(!blocked.hintHidden && /Elige una etapa/.test(blocked.hintText), 'sin etapa se explica por qué ("' + blocked.hintText.slice(0, 40) + '")');
  check(blocked.focus === 'epds-stage', 'el foco va a la primera opción de etapa (' + blocked.focus + ')');
  await shot('epds-' + label + '-stage-required');

  // Teclado: llegar a las opciones con Tab, elegir con Espacio, mover con flecha.
  await evaluate("document.querySelector('.epds-breadcrumb a').focus(); true");
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    await pressKey('Tab', 'Tab', 9);
    reached = await evaluate("document.activeElement.name === 'epds-stage'");
  }
  check(reached, 'las opciones de etapa se alcanzan con Tab');
  await pressKey(' ', 'Space', 32);
  await sleep(120);
  const afterSpace = await evaluate(`(() => {
    const input = document.activeElement;
    const label = input.closest('label');
    return { value: input.value, checked: input.checked,
      outline: getComputedStyle(label).outlineStyle,
      border: getComputedStyle(label).borderColor,
      otherBorder: getComputedStyle([...document.querySelectorAll('.epds-stage-option')].find((l) => l !== label)).borderColor };
  })()`);
  check(afterSpace.checked && afterSpace.value === 'embarazo', 'Espacio selecciona la etapa enfocada (' + afterSpace.value + ')');
  check(afterSpace.outline !== 'none', 'el foco de teclado es visible (outline=' + afterSpace.outline + ')');
  check(afterSpace.border !== afterSpace.otherBorder, 'la etapa elegida se distingue de la otra (' + afterSpace.border + ' vs ' + afterSpace.otherBorder + ')');
  await pressKey('ArrowRight', 'ArrowRight', 39);
  await sleep(120);
  const afterArrow = await evaluate("(() => { const i = document.activeElement; return { value: i.value, checked: i.checked }; })()");
  check(afterArrow.checked && afterArrow.value === 'posparto', 'la flecha mueve la selección a la otra etapa (' + afterArrow.value + ')');
  check(await evaluate("document.getElementById('epds-stage-hint').hidden"), 'elegir etapa retira el aviso');
  await evaluate("document.getElementById('epds-stage').scrollIntoView({ block: 'center', behavior: 'instant' }); true");
  await sleep(150);
  await shot('epds-' + label + '-stage-chosen');
  await evaluate("window.scrollTo({ top: 0, behavior: 'instant' }); true");
  await sleep(150);

  // Comenzar: la primera pregunta queda bajo el header y dentro del viewport.
  await click('#epds-begin');
  await sleep(900);
  const started = await evaluate(`(() => {
    const nav = document.querySelector('header.nav').getBoundingClientRect();
    const q = document.getElementById('qtext').getBoundingClientRect();
    const options = [...document.querySelectorAll('.epds-option')];
    return { running: document.getElementById('test').classList.contains('active'),
      introHidden: getComputedStyle(document.getElementById('intro')).display === 'none',
      qTop: q.top, qBottom: q.bottom, navBottom: nav.bottom,
      focus: document.activeElement.id,
      optionCount: options.length,
      optionsBelow: options.every((o) => o.getBoundingClientRect().top >= q.bottom),
      lastOptionBottom: options.length ? options[options.length - 1].getBoundingClientRect().bottom : 0,
      counter: document.getElementById('counter').textContent.trim() };
  })()`);
  check(started.running && started.introHidden, 'el test abre y la intro desaparece');
  check(started.qTop >= started.navBottom - 1, 'la pregunta 1 queda bajo el header (q.top=' + Math.round(started.qTop) + ', nav.bottom=' + Math.round(started.navBottom) + ')');
  check(started.focus === 'qtext', 'el foco va al enunciado (' + started.focus + ')');
  check(started.optionCount === 4 && started.optionsBelow, 'las cuatro opciones se muestran bajo el enunciado (' + started.optionCount + ')');
  check(started.lastOptionBottom <= h, 'las cuatro opciones caben en el primer viewport (' + Math.round(started.lastOptionBottom) + ' <= ' + h + ')');
  check(started.counter === '1 / 10', 'el contador parte en 1 / 10 (' + started.counter + ')');
  await noOverflow();
  await shot('epds-' + label + '-q1');

  // Posparto, total 12, ítem 10 = 0 → punto de referencia alcanzado.
  await answerAll([2, 2, 2, 2, 1, 1, 1, 1, 0, 0]);
  const result = await readResult();
  check(result.active && result.introHidden, 'el resultado se muestra en lugar del test');
  check(result.score === '12', 'el puntaje mostrado es 12 (' + result.score + ')');
  check(result.tone === 'attention' && /Evaluación recomendada/.test(result.band), 'posparto 12 recomienda evaluación (' + result.band + '/' + result.tone + ')');
  check(/sobre el punto de referencia/.test(result.title), 'el título nombra el punto de referencia ("' + result.title.slice(0, 48) + '")');
  check(/10 o más/.test(result.body), 'el cuerpo usa el punto de referencia de posparto');
  check(!/no necesariamente/.test(result.body + result.nextText), 'no reaparece la tranquilización retirada');
  check(/tamizaje/.test(result.body) && /no constituye un diagnóstico/.test(result.body), 'se preserva tamizaje ≠ diagnóstico');
  check(!result.crisisVisible, 'sin ítem 10 no se muestran los recursos de urgencia');
  await noOverflow();
  check(result.bottom <= w + 1, 'el resultado cabe a lo ancho (' + Math.round(result.bottom) + ' <= ' + w + ')');
  await shot('epds-' + label + '-result-reference');

  // Volver a empezar limpia la etapa: se vuelve a preguntar.
  await click('#epds-restart');
  await sleep(700);
  const afterRestart = await evaluate(`(() => ({
    intro: document.getElementById('intro').classList.contains('active'),
    checked: [...document.querySelectorAll('input[name="epds-stage"]')].filter((i) => i.checked).length,
    hintHidden: document.getElementById('epds-stage-hint').hidden,
  }))()`);
  check(afterRestart.intro && afterRestart.checked === 0 && afterRestart.hintHidden, 'reiniciar vuelve a preguntar la etapa sin preselección');
}

// =============================================================================
// 2 · Ítem 10 > 0 con puntaje bajo: la seguridad manda, en móvil
// =============================================================================
await setViewport(390, 844);
await openPage('epds-safety@390x844', 'essentials');
await click('.epds-stage-option:nth-child(1)');   // Embarazo
await sleep(150);
await click('#epds-begin');
await sleep(900);
await answerAll([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]); // total 1, ítem 10 = 1
const safety = await readResult();
check(safety.score === '1', 'el total es 1 (' + safety.score + ')');
check(safety.tone === 'safety', 'ítem 10 > 0 con total 1 entra a la vía de seguridad (' + safety.tone + ')');
check(safety.crisisVisible, 'los recursos de ayuda se muestran');
check(safety.crisisTop < safety.ctaTop && safety.crisisTop < safety.nextTop, 'los recursos van antes que la invitación a reservar (' + Math.round(safety.crisisTop) + ' < ' + Math.round(safety.ctaTop) + ')');
check(/pronto/.test(safety.title + safety.body), 'se recomienda evaluación pronta');
check(/no es un diagnóstico/.test(safety.body), 'no se diagnostica desde el ítem 10');
check(/no es un servicio de urgencia/.test(safety.nextText), 'se aclara que la consulta online no es urgencia');
check(safety.telTargets.length === 3, 'los tres teléfonos de ayuda están presentes (' + safety.telTargets.length + ')');
safety.telTargets.forEach((t) => {
  check(t.h >= 44, 'el teléfono ' + t.href + ' es un objetivo de 44px (' + t.h.toFixed(1) + 'px)');
});
check(safety.telTargets.some((t) => t.href === 'tel:*4141'), 'se conserva *4141');
check(safety.telTargets.some((t) => /600\s*360\s*7777/.test(t.text)), 'se conserva Salud Responde 600 360 7777');
check(safety.telTargets.some((t) => t.href === 'tel:131'), 'se conserva SAMU 131');
await noOverflow();
await shot('epds-390-result-safety');
await evaluate("document.getElementById('crisis-box').scrollIntoView({ block: 'center', behavior: 'instant' }); true");
await sleep(150);
await shot('epds-390-result-safety-resources');

// =============================================================================
// 3 · Puntaje alto con ítem 10 = 0: prioridad, nunca crisis — con medición ACEPTADA
// =============================================================================
await openPage('epds-priority@390x844', 'accepted');
await sleep(400);
const measuring = await evaluate('window._fbMeasurementOn === true');
check(measuring, 'la medición quedó aceptada para esta corrida (peor caso de privacidad)');
await click('.epds-stage-option:nth-child(2)');   // Posparto
await sleep(150);
await click('#epds-begin');
await sleep(900);
await answerAll([3, 3, 3, 3, 3, 3, 3, 3, 3, 0]); // total 27, ítem 10 = 0
const priority = await readResult();
check(priority.score === '27', 'el total es 27 (' + priority.score + ')');
check(priority.tone === 'priority' && /prioridad/i.test(priority.band), 'un total alto con ítem 10 = 0 es prioridad (' + priority.band + '/' + priority.tone + ')');
check(!priority.crisisVisible, 'un total alto por sí solo no abre los recursos de urgencia');
check(/elevado/.test(priority.title + priority.body), 'se dice que el resultado es elevado');
check(/no permite establecer un diagnóstico ni determinar una situación de emergencia/.test(priority.body), 'se niega explícitamente diagnóstico y emergencia');
check(!/\bcrisis\b/i.test(priority.title + priority.body + priority.nextText), 'no se usa la palabra crisis');
check(!/riesgo suicida/i.test(priority.title + priority.body + priority.nextText), 'no se afirma riesgo suicida desde el puntaje');
await noOverflow();
await shot('epds-390-result-priority');

// =============================================================================
// 4 · Nada clínico salió del navegador
// =============================================================================
const trace = await evaluate(`(() => ({
  dataLayer: JSON.stringify(window.dataLayer || []),
  ls: Object.keys(localStorage), ss: Object.keys(sessionStorage),
  lsValues: Object.keys(localStorage).map((k) => k + '=' + localStorage.getItem(k)).join(' | '),
  url: location.href,
  measuring: window._fbMeasurementOn === true,
}))()`);
const CLINICAL = /embarazo|posparto|etapa|stage|score|puntaje|banda|\bband\b|item10|safety|priority|respuesta|answers|epds_|edinburgh/i;
check(!CLINICAL.test(trace.dataLayer), 'ningún evento de medición lleva estado clínico: ' + trace.dataLayer.slice(0, 200));
check(trace.ls.every((k) => k === 'fb_cookie_consent'), 'no se guardó nada salvo la decisión de cookies ' + JSON.stringify(trace.ls));
check(trace.ss.length === 0, 'sessionStorage queda vacío ' + JSON.stringify(trace.ss));
check(!CLINICAL.test(trace.lsValues.replace('fb_cookie_consent=accepted', '')), 'el almacenamiento no contiene estado clínico');
check(trace.url === ORIGIN + ROUTE, 'la URL no acumula estado (' + trace.url + ')');

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const isStaticOfThisPage = (url) => {
  if (!url.startsWith(ORIGIN)) return false;
  const rel = url.slice(ORIGIN.length);
  if (rel === ROUTE) return true;
  return /^\/assets\/[a-z0-9.-]+\.(js|css|png|jpe?g|webp|svg)(\?v=\d+)?$/.test(rel);
};
/* La corrida 3 acepta la medición a propósito: la etiqueta se pide y queda
   frenada en el borde. Se separa del resto para poder afirmar dos cosas
   distintas: que no llegó a la red, y que no llevaba nada clínico. */
const measurementRequests = requests.filter((r) => MEASUREMENT.test(r.url));
const offending = requests.filter((r) => {
  if (MEASUREMENT.test(r.url)) return false;
  if (r.method !== 'GET') return true;
  if (r.postData) return true;
  if (FONTS.test(r.url) || r.url.startsWith('data:')) return false;
  return !isStaticOfThisPage(r.url);
});
check(unblocked.length === 0, 'ninguna petición de medición llegó a la red (' + unblocked.length + ')');
check(measurementRequests.every((r) => !CLINICAL.test(r.url.replace(/[?&]id=[^&]*/g, '') + ' ' + r.postData)),
  'la etiqueta de medición no lleva estado clínico ' + JSON.stringify(measurementRequests.map((r) => r.url).slice(0, 2)));
const clinicalRequests = requests.filter((r) => {
  const probe = r.url.replace(ORIGIN + '/assets/epds-scoring.js', '').replace(ORIGIN + ROUTE, '') + ' ' + r.postData;
  return CLINICAL.test(probe);
});
check(offending.length === 0, 'sólo se pidieron la página, sus assets y las fuentes ' + JSON.stringify(offending.slice(0, 4).map((r) => r.method + ' ' + r.url)));
check(clinicalRequests.length === 0, 'ninguna petición lleva estado clínico ' + JSON.stringify(clinicalRequests.slice(0, 4).map((r) => r.url)));
check(apiCalls.length === 0, 'no se llamó a ninguna ruta /api/* ' + JSON.stringify(apiCalls));

// =============================================================================
socket.close();
child.kill('SIGTERM');
server.close();
await rm(profileDir, { recursive: true, force: true }).catch(() => {});

const realErrors = consoleErrors.filter((e) => !/ERR_BLOCKED_BY_CLIENT|googletagmanager/.test(e));
console.log('SCREENSHOT_TOOLING=' + path.basename(chrome) + ' (CDP)' + (SHOTS ? ' shots=' + SHOTS : ''));
console.log('EPDS_BROWSER_QA=' + (failures.length ? 'FAIL' : 'PASS') + ' assertions=' + assertions + ' failures=' + failures.length);
failures.forEach((f) => console.log('FAIL ' + f));
console.log('CONSOLE_ERRORS=' + realErrors.length + (realErrors.length ? ' ' + realErrors.join(' | ') : ''));
console.log('CLINICAL_DATA_NETWORK_CALLS=' + clinicalRequests.length);
console.log('CLINICAL_ANALYTICS_EVENTS=' + (CLINICAL.test(trace.dataLayer) ? 'UNKNOWN' : 0));
console.log('NON_STATIC_REQUESTS=' + offending.length);
console.log('MEASUREMENT_REQUESTS_BLOCKED_LOCALLY=' + measurementRequests.length + ' unblocked=' + unblocked.length);
console.log('API_CALLS=' + JSON.stringify(apiCalls));
console.log('REAL_NETWORK_SIDE_EFFECTS=' + offending.length);
console.log('REAL_BOOKINGS_CREATED=0');
console.log('REAL_MONETARY_FLOW_CALLS=0');
console.log('PRODUCTION_EMAILS_SENT=0');
if (failures.length || realErrors.length) process.exit(1);
