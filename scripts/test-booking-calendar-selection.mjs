/**
 * THE OVERVIEW MUST NOT GATE DATE SELECTION.
 *
 * Two layers decide different things in assets/booking.js:
 *
 *   fetchOverview()  best-effort, whole-horizon, only attenuates the calendar;
 *   fetchDate(iso)   authoritative for one date, and the only thing that may
 *                    make an hour selectable.
 *
 * The code said so in its own comments and then did the opposite:
 * `availabilityFor` returned "loading" while `!slotsLoaded`, `renderCalendar`
 * disabled every "loading" day, and `renderSlots` returned early on the same
 * flag. A slow horizon read therefore froze the whole picker — which is what
 * a patient met in Production on 2026-09-18, when that read was taking 3-12s
 * and timing out outright about a third of the time.
 *
 * Pinned here, against a real (small) DOM rather than source patterns:
 *   A. overview pending  -> a valid future weekday is selectable
 *   B. overview failed   -> same
 *   C. past dates        -> still disabled
 *   D. weekends          -> still disabled
 *   E. holidays          -> still disabled
 *   F. date chosen, per-date read in flight -> no hour selectable, Continue off
 *   G. per-date read failed                 -> no hour offered at all
 *   H. per-date read succeeded -> only the hours the server left free
 *
 * F-H are the fail-closed half: the loosening above must not reach the hours.
 *
 * INTEGRATION (v3.2 auto-advance wizard).
 *
 * This file was written against the earlier wizard, in which the hour step
 * carried a "Continuar" button and the proof that an hour was usable was that
 * the button became enabled. That control no longer exists: the modality step
 * is gone, the hour step is step 3, and an unambiguous choice IS the advance —
 * so there is no second action to enable.
 *
 * Nothing above is weakened by that. The invariant the old assertion protected
 * — that no hour can be carried forward until the server has confirmed its date
 * — is now structural rather than a property of a button: with no advance
 * control on the date and hour steps, the only way past them is to choose, and
 * choosing is what sets state.date / state.time. So the button assertions are
 * replaced by the stronger statement they were standing in for:
 *
 *   I. the date and hour steps expose no advance control at all
 *   J. choosing a free hour advances by itself, to the contact step
 *   K. an occupied hour advances nothing, and Back still walks the steps
 *
 * The advance controls the fixture builds are read out of reserva.html rather
 * than invented here, so a "Continuar" regrowing on the hour step grows in this
 * fixture too and assertion I fails.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/booking.js', import.meta.url), 'utf8');
const pageHtml = await readFile(new URL('../reserva.html', import.meta.url), 'utf8');

// The real wizard's shape, read from the page rather than assumed.
const STEP_OPEN = /<div class="bk-step" data-step="(\d)"/g;
const stepBounds = [...pageHtml.matchAll(STEP_OPEN)].map((m) => [m.index, Number(m[1])]);
const TOTAL_STEPS = stepBounds.length;
const stepMarkup = (n) => {
  const i = stepBounds.findIndex(([, num]) => num === n);
  if (i === -1) return '';
  return pageHtml.slice(stepBounds[i][0], i + 1 < stepBounds.length ? stepBounds[i + 1][0] : undefined);
};
const stepActions = (n) => [...stepMarkup(n).matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]);
// Step 1's next lives inside [data-step1-actions hidden] and is revealed only by
// a URL prefill, so it is not an advance control the patient meets by default.
const stepHasVisibleNext = (n) =>
  stepActions(n).indexOf('next') !== -1 && stepMarkup(n).indexOf('data-step1-actions hidden') === -1;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

// Monday 2026-09-14 10:00 America/Santiago. Everything below is in the month
// the calendar opens on, so no month navigation is needed.
const NOW_MS = Date.parse('2026-09-14T13:00:00.000Z');
const TARGET = '2026-09-24';      // Thursday, free, the incident's own date
const PAST = '2026-09-11';        // Friday, before today
const SATURDAY = '2026-09-19';
const SUNDAY = '2026-09-20';
const HOLIDAY = '2026-09-18';     // Friday, Independencia, still in the future

// ---------------------------------------------------------------------------
// A small DOM: real children, real dataset, real listener dispatch. Enough for
// the calendar and the hour grid, and honest about `disabled` — a disabled
// button does not fire click, which is half of what fail-closed means here.
// ---------------------------------------------------------------------------
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function el(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag || 'div').toLowerCase(),
    children: [], parentElement: null, dataset: {}, attrs: {}, listeners: {},
    style: { cssText: '' }, textContent: '', value: '',
    disabled: false, checked: false, hidden: false,
    classList: {
      add(...c) { c.forEach((x) => classes.add(x)); },
      remove(...c) { c.forEach((x) => classes.delete(x)); },
      contains(c) { return classes.has(c); },
      toggle(c, f) { if (f) classes.add(c); else classes.delete(c); },
    },
    appendChild(child) { child.parentElement = node; node.children.push(child); return child; },
    addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
    removeEventListener() {}, focus() {}, scrollIntoView() {},
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
    removeAttribute(k) { delete node.attrs[k]; },
    closest() { return null; },
    // Faithful to the browser: dispatching runs the listeners. booking.js's
    // keyboard path selects the radio and then dispatches 'change' itself, so a
    // stub that swallowed it would have silently skipped assertion K2.
    dispatchEvent(event) {
      const type = event && event.type;
      if (type) (node.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, target: node, type }));
      return true;
    },
    querySelector(sel) { return queryAll(node, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(node, sel); },
  };
  Object.defineProperty(node, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(node, 'innerHTML', {
    get: () => node.htmlValue || '',
    set: (v) => { node.htmlValue = v; if (v === '') node.children = []; },
  });
  return node;
}

function attrValue(node, name) {
  if (name.indexOf('data-') === 0) return node.dataset[camel(name.slice(5))];
  if (name === 'name' || name === 'value') return name in node.attrs ? node.attrs[name] : node[name];
  return node.attrs[name];
}

function matchesCompound(node, compound) {
  const tag = (compound.match(/^[a-zA-Z][\w-]*/) || [null])[0];
  if (tag && node.tagName !== tag.toLowerCase()) return false;
  const rest = tag ? compound.slice(tag.length) : compound;
  const re = /\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g;
  let m;
  while ((m = re.exec(rest))) {
    if (m[1]) { if (!node.classList.contains(m[1])) return false; continue; }
    const value = attrValue(node, m[2]);
    const wanted = m[3] !== undefined ? m[3] : m[4];
    if (wanted === undefined) { if (value === undefined || value === null) return false; }
    else if (String(value) !== wanted) return false;
  }
  return true;
}

function descendants(node, out) {
  out = out || [];
  node.children.forEach((child) => { out.push(child); descendants(child, out); });
  return out;
}

function queryAll(root, selector) {
  const found = [];
  String(selector).split(',').forEach((group) => {
    const steps = group.trim().split(/\s+/).filter(Boolean);
    let current = [root];
    steps.forEach((step) => {
      const next = [];
      current.forEach((ctx) => descendants(ctx).forEach((d) => { if (matchesCompound(d, step) && next.indexOf(d) === -1) next.push(d); }));
      current = next;
    });
    current.forEach((n) => { if (found.indexOf(n) === -1) found.push(n); });
  });
  return found;
}

const fire = (node, type, init) => {
  // Faithful to the browser: a disabled control receives no activation.
  if (node.disabled && type === 'click') return false;
  const event = Object.assign({ preventDefault() {}, target: node, type }, init || {});
  (node.listeners[type] || []).forEach((fn) => fn(event));
  return true;
};

// ---------------------------------------------------------------------------
// Fixture + sandbox.
// ---------------------------------------------------------------------------
function buildPage(options) {
  let pageSource = source;
  (options.patches || []).forEach(([find, replace]) => {
    if (pageSource.indexOf(find) === -1) throw new Error('mutation anchor missing: ' + find);
    pageSource = pageSource.split(find).join(replace);
  });
  const byId = new Map();
  const getEl = (id) => { if (!byId.has(id)) byId.set(id, el('div')); return byId.get(id); };

  const stage = el('div');
  byId.set('bk-stage', stage);
  byId.set('bk-summary', el('div'));
  byId.set('cal-grid', el('div'));
  byId.set('cal-month', el('div'));
  byId.set('cal-prev', el('button'));
  byId.set('cal-next', el('button'));
  byId.set('bk-slots', el('div'));
  byId.set('bk-time-subtitle', el('div'));

  // The steps and their controls come from reserva.html, not from an assumption
  // here: each step gets exactly the data-action buttons the real page gives it.
  // A "Continuar" regrowing on the hour step therefore regrows in this fixture.
  const nextButtons = {};
  const prevButtons = {};
  const sections = {};
  for (let step = 1; step <= TOTAL_STEPS; step += 1) {
    const section = el('section');
    section.className = 'bk-step';
    section.dataset.step = String(step);
    section.hidden = step !== 1;
    (options.stepActions || stepActions)(step).forEach((action) => {
      const btn = el('button');
      btn.dataset.action = action;
      section.appendChild(btn);
      if (action === 'next') nextButtons[step] = btn;
      if (action === 'prev') prevButtons[step] = btn;
    });
    sections[step] = section;
    stage.appendChild(section);
  }

  const service = el('input');
  service.attrs.name = 'service';
  service.value = options.service || 'primera';
  service.dataset.label = options.service === 'followup' ? 'Sesión de seguimiento' : 'Primera sesión';
  service.dataset.duration = '50 min';
  service.dataset.price = '$45.000';
  const serviceLabel = el('label');
  serviceLabel.appendChild(service);
  stage.children[0].appendChild(serviceLabel);

  const timers = [];
  class FixedDate extends Date {
    constructor(...args) { if (args.length === 0) super(NOW_MS); else super(...args); }
    static now() { return NOW_MS; }
  }
  Object.defineProperty(FixedDate, 'parse', { value: Date.parse, writable: true, configurable: true });

  const requested = [];
  const sandbox = {
    document: {
      getElementById: getEl,
      querySelector: (sel) => queryAll(stage, sel)[0] || null,
      querySelectorAll: (sel) => queryAll(stage, sel),
      createElement: el, addEventListener() {}, body: el('body'),
    },
    window: {
      addEventListener() {}, location: { href: '', search: '' }, scrollTo() {},
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url) => { requested.push(String(url)); return options.respond(String(url)); },
    Date: FixedDate, Intl, JSON, Math, Number, String, Object, Array, Set, Map, RegExp, Promise,
    Error, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    URLSearchParams, URL, Event: class { constructor(type) { this.type = type; } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    navigator: { userAgent: 'calendar-selection-test' }, location: { href: '', search: '' },
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pageSource, sandbox);

  const runTimers = () => {
    for (let guard = 0; guard < 50 && timers.some(Boolean); guard += 1) {
      const pending = timers.splice(0, timers.length).filter(Boolean);
      pending.forEach((fn) => fn());
    }
  };
  const tick = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); };

  return {
    stage, byId, getEl, nextButtons, prevButtons, sections, service, serviceLabel,
    requested, runTimers, tick,
    // go() hides every step but the current one, so the visible step is a real
    // signal from the code under test, not something this fixture decides.
    currentStep() {
      const shown = Object.keys(sections).filter((n) => sections[n].hidden === false);
      return shown.length === 1 ? Number(shown[0]) : shown.map(Number);
    },
    stepHasAdvanceControl(n) {
      return sections[n].children.some((c) => c.dataset.action === 'next');
    },
    days: () => byId.get('cal-grid').children.filter((c) => c.dataset.iso),
    day: (iso) => byId.get('cal-grid').children.find((c) => c.dataset.iso === iso) || null,
    slotButtons: () => byId.get('bk-slots').children.filter((c) => c.tagName === 'button'),
    slotMessage: () => (byId.get('bk-slots').children.find((c) => c.tagName === 'p') || {}).textContent || '',
    // One gesture: picking the session type. There is no modality step any
    // more — modality is a constant in booking.js — and picking the type is
    // itself the advance to the date step.
    async openCalendar() {
      fire(this.serviceLabel, 'pointerdown');
      fire(this.service, 'change');
      this.runTimers();
      await this.tick();
      this.runTimers();
    },
    // The same choice made from the keyboard, which must be equivalent.
    async openCalendarByKeyboard() {
      fire(this.service, 'keydown', { key: 'Enter' });
      this.runTimers();
      await this.tick();
      this.runTimers();
    },
    async chooseDay(iso) {
      const button = this.day(iso);
      const fired = fire(button, 'click');
      this.runTimers();
      await this.tick();
      this.runTimers();
      await this.tick();
      return fired;
    },
  };
}

// Response helpers. `never` models the exact Production symptom: a request that
// is still in flight, which is what "pending" has to mean for this to be a test
// of the defect rather than of a fast failure.
const never = () => new Promise(() => {});
const jsonOk = (slots) => ({ ok: true, status: 200, json: async () => ({ ok: true, slots }) });
const httpFail = () => ({ ok: false, status: 502, json: async () => ({}) });
const isOverview = (url) => url.indexOf('?date=') === -1;

// ---------------------------------------------------------------------------
// A. Overview still pending: the picker is usable anyway.
// ---------------------------------------------------------------------------
{
  const page = buildPage({ respond: (url) => (isOverview(url) ? never() : never()) });
  await page.openCalendar();

  check(page.days().length === 30, 'the September grid rendered its 30 days');
  const target = page.day(TARGET);
  check(target !== null, 'the target Thursday is in the grid');
  check(target.disabled === false,
    'a valid future weekday is selectable while the overview is still in flight');
  check(target.dataset.state === 'unknown',
    'and it claims nothing about how free it is — the overview has not answered');
  check(page.requested.some(isOverview), 'the overview was in fact requested');
}

// ---------------------------------------------------------------------------
// B. Overview failed: same answer. A failure is not evidence of anything.
// ---------------------------------------------------------------------------
{
  const page = buildPage({ respond: (url) => (isOverview(url) ? httpFail() : never()) });
  await page.openCalendar();

  const target = page.day(TARGET);
  check(target.disabled === false, 'a valid future weekday is selectable after the overview failed');
  check(target.dataset.state === 'unknown',
    'and a failed overview is still not read as "nothing is booked"');
  check(target.dataset.state !== 'avail' && target.dataset.state !== 'few',
    'in particular it is never presented as confirmed-free');
}

// ---------------------------------------------------------------------------
// C/D/E. Past, weekend and holiday stay shut — in the worst case for them,
// which is the overview never answering.
// ---------------------------------------------------------------------------
{
  const page = buildPage({ respond: () => never() });
  await page.openCalendar();

  const past = page.day(PAST);
  check(past.disabled === true && past.dataset.state === 'past',
    'a past weekday is still disabled (' + PAST + ')');
  check(fire(past, 'click') === false, 'and clicking it does nothing');

  [SATURDAY, SUNDAY].forEach((iso) => {
    const day = page.day(iso);
    check(day.disabled === true && day.dataset.state === 'none',
      'the weekend is still disabled (' + iso + ')');
    check(fire(day, 'click') === false, 'and cannot be chosen (' + iso + ')');
  });

  const holiday = page.day(HOLIDAY);
  check(holiday.disabled === true && holiday.dataset.state === 'none',
    'a future weekday holiday is still disabled (' + HOLIDAY + ')');
  check(fire(holiday, 'click') === false, 'and cannot be chosen');

  // Every enabled day is a future weekday that is not a holiday.
  const holidays = new Set(JSON.parse(JSON.stringify((source.match(/holidays: \[([\s\S]*?)\]/) || [null, ''])[1].match(/\d{4}-\d{2}-\d{2}/g) || [])));
  page.days().filter((d) => !d.disabled).forEach((d) => {
    const at = new Date(d.dataset.iso + 'T12:00:00Z');
    check(at.getUTCDay() !== 0 && at.getUTCDay() !== 6 && !holidays.has(d.dataset.iso)
      && d.dataset.iso >= '2026-09-14',
      'every selectable day is a future non-holiday weekday (' + d.dataset.iso + ')');
  });
}

// ---------------------------------------------------------------------------
// F. A date is chosen while its authoritative read is in flight.
// ---------------------------------------------------------------------------
{
  const page = buildPage({ respond: () => never() });
  await page.openCalendar();
  check(await page.chooseDay(TARGET) === true, 'the target date accepts the click');

  check(page.requested.some((u) => u.indexOf('?date=' + TARGET) !== -1),
    'choosing it triggered the authoritative per-date read');
  check(page.slotButtons().length === 0,
    'no hour is offered while that read is in flight');
  check(page.slotMessage().indexOf('Comprobando') === 0,
    'the hour step says it is still checking, rather than showing nothing');
  check(page.currentStep() === 3,
    'the patient is on the hour step and stays there while the read is in flight');
  check(page.stepHasAdvanceControl(3) === false,
    'and there is no advance control to leave it with');
}

// ---------------------------------------------------------------------------
// G. The authoritative read fails: nothing is offered. Fail-closed holds.
// ---------------------------------------------------------------------------
{
  let dateCalls = 0;
  const page = buildPage({
    // Fails once, then stays in flight — otherwise renderSlots' own retry
    // would spin forever and the test would never settle.
    respond: (url) => {
      if (isOverview(url)) return httpFail();
      dateCalls += 1;
      return dateCalls === 1 ? httpFail() : never();
    },
  });
  await page.openCalendar();
  await page.chooseDay(TARGET);

  check(dateCalls >= 1, 'the per-date read was attempted');
  check(page.slotButtons().length === 0, 'a failed per-date read offers no hour at all');
  check(page.slotMessage().indexOf('No pudimos comprobar') === 0,
    'and says so, which is the message the incident reported');
  check(page.currentStep() === 3 && page.stepHasAdvanceControl(3) === false,
    'a failed per-date read leaves the patient on the hour step with no way forward');
}

// ---------------------------------------------------------------------------
// H. The authoritative read succeeds: only the hours the server left free.
// ---------------------------------------------------------------------------
{
  const OCCUPIED = [{ date: TARGET, time: '14:00' }, { date: TARGET, time: '15:00' }];
  const page = buildPage({
    // The overview never answers, so everything offered below came from the
    // per-date read alone.
    respond: (url) => (isOverview(url) ? never() : jsonOk(OCCUPIED)),
  });
  await page.openCalendar();
  await page.chooseDay(TARGET);

  const buttons = page.slotButtons();
  check(buttons.length === 9, 'the working grid is rendered once the date is confirmed');
  const selectable = buttons.filter((b) => !b.disabled).map((b) => b.textContent);
  const blocked = buttons.filter((b) => b.disabled).map((b) => b.textContent);
  check(blocked.length === 2 && blocked.indexOf('14:00') !== -1 && blocked.indexOf('15:00') !== -1,
    'the two hours the server reported occupied are not selectable');
  check(selectable.length === 7 && selectable.indexOf('14:00') === -1 && selectable.indexOf('15:00') === -1,
    'and the other seven are');
  check(page.currentStep() === 3, 'the patient is on the hour step, with nothing else offered');

  // The loosening must not have reached the hours: an occupied one is inert,
  // and being inert it advances nothing.
  check(fire(buttons.find((b) => b.textContent === '14:00'), 'click') === false,
    'an occupied hour cannot be clicked');
  page.runTimers();
  check(page.currentStep() === 3, 'and an occupied hour does not advance the wizard');

  fire(buttons.find((b) => b.textContent === '11:00'), 'click');
  page.runTimers();
  check(page.currentStep() === 4,
    'picking a free hour is itself the advance, to the contact step');
}

// ---------------------------------------------------------------------------
// I. The approved UX: no redundant advance control on an unambiguous choice.
//    Read from reserva.html, so this is a statement about the shipped page.
// ---------------------------------------------------------------------------
{
  check(TOTAL_STEPS === 6, 'the wizard is six steps — the single-option modality step is gone');
  check(stepHasVisibleNext(2) === false, 'the date step exposes no explicit advance control');
  check(stepHasVisibleNext(3) === false, 'the hour step exposes no explicit advance control');
  check(stepActions(2).indexOf('prev') !== -1 && stepActions(3).indexOf('prev') !== -1,
    'both still offer Back, which is the only navigation they need');
  // Step 1 keeps a next, but hidden: it is revealed only when a URL prefill has
  // already chosen the service, so it is never a second action after a choice.
  check(stepMarkup(1).indexOf('data-step1-actions hidden') !== -1,
    'the one remaining next control is hidden until a URL prefill needs it');
  check(source.indexOf('scheduleAdvance(2)') !== -1
    && source.indexOf('scheduleAdvance(3)') !== -1
    && source.indexOf('scheduleAdvance(4)') !== -1,
    'session type, date and hour each advance by being chosen');
}

// ---------------------------------------------------------------------------
// J. Choosing is advancing, all the way down, and from the keyboard too.
// ---------------------------------------------------------------------------
{
  const OCCUPIED = [{ date: TARGET, time: '14:00' }];
  const page = buildPage({ respond: (url) => (isOverview(url) ? never() : jsonOk(OCCUPIED)) });

  check(page.currentStep() === 1, 'the wizard opens on the session-type step');
  await page.openCalendar();
  check(page.currentStep() === 2, 'choosing the session type advances to the date step');

  await page.chooseDay(TARGET);
  check(page.currentStep() === 3, 'choosing a valid date advances to the hour step');

  const free = page.slotButtons().find((b) => !b.disabled);
  fire(free, 'click');
  page.runTimers();
  check(page.currentStep() === 4, 'choosing a free hour advances to the contact step');
}

{
  // Both session types behave the same way: neither is ambiguous, so neither
  // asks for a second confirmation.
  for (const svc of ['primera', 'followup']) {
    const page = buildPage({ respond: () => never(), service: svc });
    await page.openCalendar();
    check(page.currentStep() === 2, 'choosing "' + svc + '" advances to the date step');
  }
}

{
  // K2 — the keyboard must reach the same place as the pointer. booking.js
  // checks the radio and dispatches 'change' itself on Enter.
  const page = buildPage({ respond: () => never() });
  await page.openCalendarByKeyboard();
  check(page.currentStep() === 2,
    'Enter on the session type advances exactly as the pointer gesture does');
}

// ---------------------------------------------------------------------------
// K. Back still walks the wizard, so auto-advance is never a one-way door.
// ---------------------------------------------------------------------------
{
  const page = buildPage({ respond: (url) => (isOverview(url) ? never() : jsonOk([])) });
  await page.openCalendar();
  await page.chooseDay(TARGET);
  const free = page.slotButtons().find((b) => !b.disabled);
  fire(free, 'click');
  page.runTimers();
  check(page.currentStep() === 4, 'on the contact step after three choices');

  fire(page.prevButtons[4], 'click'); page.runTimers();
  check(page.currentStep() === 3, 'Back returns to the hour step');
  fire(page.prevButtons[3], 'click'); page.runTimers();
  check(page.currentStep() === 2, 'Back returns to the date step');
  fire(page.prevButtons[2], 'click'); page.runTimers();
  check(page.currentStep() === 1, 'Back returns to the session-type step');
}

// ---------------------------------------------------------------------------
// I. Adversarial mutation. Each of the three lines this fix touches is put
//    back the way it was; each must break the assertion that covers it. A
//    suite that passes against the defect proves nothing.
// ---------------------------------------------------------------------------
const GATE = 'if (!slotsLoaded || overviewFailed) return "unknown";';
const DISABLE = 'if (state_ === "past" || state_ === "none" || state_ === "empty") btn.disabled = true;';
const SLOTS_GATE = 'if (!state.date) return;';

{
  // M1 — the calendar gate goes back to blocking on the pending overview.
  const mutant = buildPage({
    respond: () => never(),
    patches: [[GATE, 'if (!slotsLoaded) return "loading";'],
      [DISABLE, 'if (state_ === "past" || state_ === "none" || state_ === "empty" || state_ === "loading") btn.disabled = true;']],
  });
  await mutant.openCalendar();
  const target = mutant.day(TARGET);
  check(target.disabled === true && target.dataset.state === 'loading',
    'M1: with the old gate restored the target date really is blocked, so assertion A is load-bearing');
}

{
  // M2 — a failed overview is treated as knowledge again.
  const mutant = buildPage({
    respond: (url) => (isOverview(url) ? httpFail() : never()),
    patches: [[GATE, 'if (!slotsLoaded) return "unknown";']],
  });
  await mutant.openCalendar();
  check(mutant.day(TARGET).dataset.state === 'avail',
    'M2: without the overviewFailed guard an empty failed overview reads as confirmed-free, which assertion B forbids');
}

{
  // M3 — the hour step goes back to waiting on the overview.
  const mutant = buildPage({
    respond: (url) => (isOverview(url) ? never() : never()),
    patches: [[SLOTS_GATE, 'if (!state.date || !slotsLoaded) return;']],
  });
  await mutant.openCalendar();
  await mutant.chooseDay(TARGET);
  check(mutant.slotButtons().length === 0 && mutant.slotMessage() === '',
    'M3: with the old hour-step gate restored the step renders nothing at all, not even the checking notice');
}

{
  // The fail-closed half must not be reachable by loosening the calendar: drop
  // the confirmedDates guard and the hour grid appears without any server say-so.
  const mutant = buildPage({
    respond: (url) => (isOverview(url) ? never() : never()),
    patches: [['if (!confirmedDates.has(isoForGuard)) {', 'if (false) {']],
  });
  await mutant.openCalendar();
  await mutant.chooseDay(TARGET);
  check(mutant.slotButtons().length > 0,
    'M4: removing the confirmedDates guard does offer hours, so assertions F-H are load-bearing');
}

{
  // M5 — choosing an hour no longer advances. Assertions H and J claim it does,
  // so removing the call must strand the patient on the hour step.
  const mutant = buildPage({
    respond: (url) => (isOverview(url) ? never() : jsonOk([])),
    patches: [['scheduleAdvance(4); // elegir la hora avanza al formulario de datos', '']],
  });
  await mutant.openCalendar();
  await mutant.chooseDay(TARGET);
  const free = mutant.slotButtons().find((b) => !b.disabled);
  fire(free, 'click');
  mutant.runTimers();
  check(mutant.currentStep() === 3,
    'M5: without scheduleAdvance(4) a chosen hour goes nowhere, so "choosing is advancing" is load-bearing');
}

{
  // M6 — choosing a date no longer advances.
  const mutant = buildPage({
    respond: () => never(),
    patches: [['scheduleAdvance(3); // elegir el día avanza al paso de horario', '']],
  });
  await mutant.openCalendar();
  await mutant.chooseDay(TARGET);
  check(mutant.currentStep() === 2,
    'M6: without scheduleAdvance(3) a chosen date goes nowhere either');
}

{
  // M7 — a "Continuar" regrows on the hour step. The fixture builds its
  // controls from reserva.html, so this models the real regression: the step
  // would carry a second action after an already unambiguous choice.
  const regrown = (n) => (n === 3 ? stepActions(3).concat('next') : stepActions(n));
  const mutant = buildPage({ respond: () => never(), stepActions: regrown });
  await mutant.openCalendar();
  await mutant.chooseDay(TARGET);
  check(mutant.stepHasAdvanceControl(3) === true,
    'M7: an hour-step advance control really would be visible to the fixture, so assertions F/G/I are load-bearing');
}

console.log('BOOKING_CALENDAR_SELECTION=PASS assertions=' + assertions);
console.log('OVERVIEW_GATES_DATE_SELECTION=NO');
console.log('PENDING_OR_FAILED_OVERVIEW_DAY_STATE=unknown');
console.log('PAST_WEEKEND_HOLIDAY=STILL_DISABLED');
console.log('HOURS_AUTHORITY=PER_DATE_FETCH_ONLY');
console.log('HOURS_FAIL_CLOSED=YES');
console.log('WIZARD_STEPS=' + TOTAL_STEPS + ' HOUR_STEP=3');
console.log('DATE_AND_HOUR_ADVANCE_CONTROLS=NONE');
console.log('CHOOSING_IS_ADVANCING=YES (pointer and keyboard)');
console.log('BACK_NAVIGATION=INTACT');
console.log('ADVERSARIAL_MUTANTS_DETECTED=7');
