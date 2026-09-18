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
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/booking.js', import.meta.url), 'utf8');
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
    dispatchEvent() { return true; },
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

const fire = (node, type) => {
  // Faithful to the browser: a disabled control receives no activation.
  if (node.disabled && type === 'click') return false;
  (node.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, target: node }));
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

  // Seven steps, each with a Continue button; step 1's starts disabled exactly
  // as reserva.html ships it.
  const nextButtons = {};
  for (let step = 1; step <= 7; step += 1) {
    const section = el('section');
    section.className = 'bk-step';
    section.dataset.step = String(step);
    const next = el('button');
    next.dataset.action = 'next';
    next.disabled = step === 1 || step === 4;
    section.appendChild(next);
    nextButtons[step] = next;
    stage.appendChild(section);
  }

  const service = el('input');
  service.attrs.name = 'service';
  service.value = 'primera';
  service.dataset.label = 'Primera sesión';
  service.dataset.duration = '50 min';
  service.dataset.price = '$45.000';
  const serviceLabel = el('label');
  serviceLabel.appendChild(service);
  stage.children[0].appendChild(serviceLabel);

  const modality = el('input');
  modality.attrs.name = 'modality';
  modality.value = 'online';
  modality.dataset.label = 'Online';
  const modalityLabel = el('label');
  modalityLabel.appendChild(modality);
  stage.children[1].appendChild(modalityLabel);

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
    stage, byId, getEl, nextButtons, service, serviceLabel, modality, modalityLabel,
    requested, runTimers, tick,
    days: () => byId.get('cal-grid').children.filter((c) => c.dataset.iso),
    day: (iso) => byId.get('cal-grid').children.find((c) => c.dataset.iso === iso) || null,
    slotButtons: () => byId.get('bk-slots').children.filter((c) => c.tagName === 'button'),
    slotMessage: () => (byId.get('bk-slots').children.find((c) => c.tagName === 'p') || {}).textContent || '',
    async openCalendar() {
      fire(this.serviceLabel, 'pointerdown');
      fire(this.service, 'change');
      this.runTimers();
      fire(this.modalityLabel, 'pointerdown');
      fire(this.modality, 'change');
      this.runTimers();
      await this.tick();
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
  check(page.nextButtons[4].disabled === true,
    'and Continue on the hour step is disabled');
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
  check(page.nextButtons[4].disabled === true, 'Continue stays disabled');
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
  check(page.nextButtons[4].disabled === true, 'Continue is still off until an hour is picked');

  fire(buttons.find((b) => b.textContent === '11:00'), 'click');
  page.runTimers();
  check(page.nextButtons[4].disabled === false, 'picking a free hour enables Continue');

  // The loosening must not have reached the hours: an occupied one is inert.
  check(fire(buttons.find((b) => b.textContent === '14:00'), 'click') === false,
    'an occupied hour cannot be clicked');
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

console.log('BOOKING_CALENDAR_SELECTION=PASS assertions=' + assertions);
console.log('OVERVIEW_GATES_DATE_SELECTION=NO');
console.log('PENDING_OR_FAILED_OVERVIEW_DAY_STATE=unknown');
console.log('PAST_WEEKEND_HOLIDAY=STILL_DISABLED');
console.log('HOURS_AUTHORITY=PER_DATE_FETCH_ONLY');
console.log('HOURS_FAIL_CLOSED=YES');
console.log('ADVERSARIAL_MUTANTS_DETECTED=4');
