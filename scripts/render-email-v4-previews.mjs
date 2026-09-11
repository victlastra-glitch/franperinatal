#!/usr/bin/env node
/**
 * Deterministic local preview renderer for FRAN_EMAIL_DESIGN_SYSTEM_V4.
 *
 * Drives local headless Chrome over the DevTools Protocol so each PNG is a
 * full-page capture of the committed email fixture at a review viewport.
 * Synthetic fixtures only: no network, no Production email, no Flow call.
 *
 *   node scripts/render-email-v4-previews.mjs
 */
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(REPO_ROOT, 'backend/appsscript/booking/test/fixtures/email-preview');
const SHOTS = path.join(FIXTURES, 'screenshots');
// 648 = the 600px email plus its 24px desktop outer padding on each side.
const VIEWPORTS = [['desktop-600', 648], ['430', 430], ['390', 390], ['375', 375], ['320', 320]];
const PATIENT_CASES = ['booking-confirmed', 'session-rescheduled', 'session-clinician-change', 'session-cancelled',
  'session-cancelled-refunded', 'refund-requested'];
const INTERNAL_CASE = 'internal-manual-review';
const INTERNAL_VIEWPORTS = [['desktop-600', 648], ['390', 390]];
const DARK_CASES = ['booking-confirmed', 'session-rescheduled', 'session-cancelled', 'session-cancelled-refunded', 'refund-requested', INTERNAL_CASE];
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const chrome = await (async () => {
  for (const candidate of CHROME_CANDIDATES) {
    try { await access(candidate); return candidate; } catch (_) { /* keep looking */ }
  }
  return '';
})();

if (!chrome) {
  console.log('SCREENSHOT_TOOLING=UNAVAILABLE');
  console.log('EMAIL_PREVIEW_HTML_ONLY=' + FIXTURES);
  process.exit(0);
}

const PORT = 9223;
await rm(SHOTS, { recursive: true, force: true });
await mkdir(SHOTS, { recursive: true });
const profileDir = await mkdtemp(path.join(tmpdir(), 'fran-email-v4-'));
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profileDir,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const endpoint = await (async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const info = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json();
      return info.webSocketDebuggerUrl;
    } catch (_) { await sleep(125); }
  }
  throw new Error('CHROME_DEVTOOLS_UNAVAILABLE');
})();

const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let messageId = 0;
const pending = new Map();
const events = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  events.push(message);
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

// Layout QA: no horizontal overflow at the viewport, no text below 12px, every
// action link at least 44px tall. Reported per capture; the run fails on any hit.
const AUDIT = `(() => {
  const doc = document.documentElement;
  const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth) - window.innerWidth;
  const small = [...document.querySelectorAll('td,a,span,div')].filter((el) => {
    const size = parseFloat(getComputedStyle(el).fontSize);
    return el.textContent.trim().length > 1 && size > 1 && size < 12 && getComputedStyle(el).display !== 'none';
  }).length;
  const shortLinks = [...document.querySelectorAll('a')].filter((a) => {
    const r = a.getBoundingClientRect();
    return r.height > 0 && r.height < 44 && /^[A-ZÁÉÍÓÚÑ ]{6,}$/.test(a.textContent.trim());
  }).length;
  return JSON.stringify({ overflow, small, shortLinks });
})()`;

const problems = [];
const capture = async (name, source, width, dark) => {
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  }, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width, height: 800, deviceScaleFactor: 1, mobile: width < 600,
  }, sessionId);
  const loaded = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (events.some((item) => item.method === 'Page.loadEventFired' && item.sessionId === sessionId)) {
        clearInterval(timer);
        events.length = 0;
        resolve();
      }
    }, 25);
    setTimeout(() => { clearInterval(timer); resolve(); }, 8000);
  });
  await send('Page.navigate', { url: 'file://' + source }, sessionId);
  await loaded;
  await sleep(200);
  const audit = JSON.parse((await send('Runtime.evaluate', { expression: AUDIT, returnByValue: true }, sessionId)).result.value);
  if (audit.overflow > 0 || audit.small > 0 || audit.shortLinks > 0) problems.push(name + ' ' + JSON.stringify(audit));
  const { data } = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, optimizeForSpeed: false,
  }, sessionId);
  await writeFile(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
};

for (const base of PATIENT_CASES) {
  const source = path.join(FIXTURES, base + '.html');
  for (const [label, width] of VIEWPORTS) await capture(base + '-' + label, source, width, false);
}
for (const [label, width] of INTERNAL_VIEWPORTS) {
  await capture(INTERNAL_CASE + '-' + label, path.join(FIXTURES, INTERNAL_CASE + '.html'), width, false);
}
for (const base of DARK_CASES) {
  await capture(base + '-desktop-600-dark', path.join(FIXTURES, base + '.html'), 648, true);
}

socket.close();
child.kill('SIGTERM');
await rm(profileDir, { recursive: true, force: true }).catch(() => {});

const listed = (await readdir(SHOTS)).filter((name) => name.endsWith('.png')).sort();
console.log('SCREENSHOT_TOOLING=' + path.basename(chrome) + ' (CDP full-page)');
console.log('SCREENSHOT_COUNT=' + listed.length);
for (const name of listed) console.log('PNG=' + path.join(SHOTS, name));
console.log('LAYOUT_AUDIT=' + (problems.length ? 'FAIL ' + problems.join(' | ') : 'PASS (no horizontal overflow, no text <12px, no short action link)'));
console.log('PRODUCTION_EMAILS_SENT=0');
if (problems.length) process.exit(1);
