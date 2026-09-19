/**
 * Booking picker availability contract.
 *
 * The endpoint returns the hours that are OCCUPIED; the page subtracts them
 * from the working grid. That inversion is easy to get wrong in one direction
 * only, and the wrong direction is dangerous: if the page ends up with an empty
 * occupied-list it shows every hour as free, and a patient can select an hour
 * the server will refuse with SLOT_TAKEN.
 *
 * That is exactly what happened in Production on 2026-09-06. The page issued
 * one date-less availability request covering the whole 90-day horizon, that
 * request returned 502, the failure was swallowed, and the picker offered every
 * hour including one that was genuinely busy.
 *
 * These assertions pin the fix: availability for a date is authoritative, is
 * fetched per date, and its absence makes the picker offer nothing at all.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/booking.js', import.meta.url), 'utf8');
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const has = (re) => re.test(source);

// --- Fail closed -----------------------------------------------------------
check(has(/const confirmedDates = new Set\(\)/),
  'the page tracks which dates the server actually confirmed');
check(has(/if \(!confirmedDates\.has\(isoForGuard\)\)/),
  'renderSlots refuses to offer hours for a date the server has not confirmed');
check(has(/confirmedDates\.add\(iso\)/) && has(/if \(!ok\) confirmedDates\.delete\(iso\)/),
  'a date is confirmed only on a successful read, and un-confirmed on failure');

// The old shape: one date-less fetch whose failure left bookedSlots empty and
// slotsLoaded true, so every hour rendered as free.
check(!/if \(resp\.ok\) \{\s*const data = await resp\.json\(\);\s*bookedSlots = data/.test(source),
  'the swallowed date-less fetch no longer decides whether hours are selectable');
check(has(/overviewFailed/),
  'a failed horizon overview is recorded rather than silently treated as "nothing is booked"');

// --- Per-date, authoritative ----------------------------------------------
check(has(/async function fetchDate\(iso, force\)/), 'there is a per-date availability read');
check(has(/BOOKING_API\.availability \+ '\?date=' \+ encodeURIComponent\(iso\)/),
  'the per-date read asks the server for that exact date');
check(has(/fetchDate\(iso, false\);/),
  'choosing a date asks the server about it before the hour step renders');

// --- SLOT_TAKEN cannot leave a stale hour selectable ----------------------
// The hour step is step 3 since the single-option "Modalidad" step was removed;
// the guarantees below are about behaviour, not about that number.
const slotTakenBlock = (text) => {
  const from = text.slice(text.indexOf("if (code === 'SLOT_TAKEN') {"));
  return from.slice(0, from.indexOf('} else if'));
};
const SLOT_TAKEN_GUARANTEES = [
  ['clears the hour the server just rejected', (t) => /state\.time = null;/.test(slotTakenBlock(t))],
  ['drops the cached view of that date, so it cannot be reused', (t) => /confirmedDates\.delete\(isoTaken\)/.test(slotTakenBlock(t))],
  ['re-reads that date from the server before the hour step renders again', (t) => /fetchDate\(isoTaken, true\)/.test(slotTakenBlock(t))],
  ['returns the patient to the hour step', (t) => /go\(3\)/.test(slotTakenBlock(t))],
];
for (const [what, holds] of SLOT_TAKEN_GUARANTEES) check(holds(source), 'SLOT_TAKEN ' + what);

// A bare `go(...)` with no refresh is the defect this replaces.
check(!/if \(code === 'SLOT_TAKEN'\) \{\s*\/\/[^\n]*\n\s*setTimeout\(\(\) => go\(\d\), 1500\);\s*\}/.test(source),
  'SLOT_TAKEN never merely navigates back without re-reading availability');

// An unconfirmed date must also forget any hour already chosen for it, or a
// stale selection survives a failed re-read.
check(/if \(!confirmedDates\.has\(isoForGuard\)\) \{\s*\n\s*state\.time = null;/.test(source),
  'an unconfirmed date clears the selected hour before the step renders');

// --- The inversion itself --------------------------------------------------
check(has(/OCUPADAS/), 'the occupied-not-free contract is stated where bookedSlots is declared');
check(has(/!takenHours\.includes\(s\)/),
  'the grid is still working hours minus occupied hours');

// --- Choosing IS advancing, so there is nothing to leave enabled ----------
// This replaces the old `enableNext(4, false)` guard. That guard disabled a
// "Continuar" button on the hour step; the step no longer has one, because a
// single unambiguous selection advances by itself. The invariant it protected —
// a cleared hour can never be carried forward — is now structural: with no
// advance control on the date and hour steps, the only way past them is to
// choose, and choosing is what sets state.date / state.time.
const page = await readFile(new URL('../reserva.html', import.meta.url), 'utf8');
const stepMarkup = (text, n) => {
  const start = text.indexOf('<div class="bk-step" data-step="' + n + '"');
  const end = text.indexOf('<div class="bk-step" data-step="', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
};
const STEP_GUARANTEES = [
  ['the date step has no advance control', (t) => stepMarkup(t, 2).indexOf('data-action="next"') === -1],
  ['the hour step has no advance control', (t) => stepMarkup(t, 3).indexOf('data-action="next"') === -1],
];
for (const [what, holds] of STEP_GUARANTEES) check(holds(page), what);
check(/data-step1-actions hidden/.test(page),
  'the one remaining advance control is hidden until a URL prefill needs it');

// --- No client-side authority ---------------------------------------------
check(!/slots\.filter\([^)]*free/i.test(source), 'the page never re-derives freeness from anything but the server list');

// ---------------------------------------------------------------------------
// The page must still load and initialise. A contract expressed as source
// patterns proves nothing if the file throws on the way up, so this executes it
// against a strict stub with no browser conveniences.
// ---------------------------------------------------------------------------
const stubElement = (tag) => {
  const node = {
    tagName: tag || 'div', _children: [], _html: '', _listeners: {},
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }, toggle(c, f) { if (f) this._s.add(c); else this._s.delete(c); } },
    style: { cssText: '' }, dataset: {}, textContent: '', value: '',
    disabled: false, checked: false, hidden: false,
    set innerHTML(v) { this._html = v; if (v === '') this._children = []; },
    get innerHTML() { return this._html; },
    appendChild(c) { this._children.push(c); return c; },
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    hasAttribute() { return false; },
    focus() {}, scrollIntoView() {}, closest() { return null; },
    querySelector() { return stubElement(); }, querySelectorAll() { return []; },
  };
  return node;
};
const byId = new Map();
const requested = [];
const documentStub = {
  getElementById(id) { if (!byId.has(id)) byId.set(id, stubElement()); return byId.get(id); },
  querySelector() { return stubElement(); }, querySelectorAll() { return []; },
  createElement(tag) { return stubElement(tag); },
  addEventListener() {}, body: stubElement(),
};
const sandbox = {
  document: documentStub,
  window: { addEventListener() {}, location: { href: '', search: '' }, scrollTo() {},
    setTimeout: () => 0, clearTimeout() {} },
  console: { log() {}, warn() {}, error() {} },
  setTimeout: () => 0, clearTimeout() {},
  // Every availability read fails, which is the dangerous case: the page must
  // come up without offering a single hour rather than treating silence as free.
  fetch: async (url) => { requested.push(String(url)); return { ok: false, status: 502, json: async () => ({}) }; },
  Date, Intl, JSON, Math, Number, String, Object, Array, Set, Map, RegExp, Promise,
  Error, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  URLSearchParams, URL,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  navigator: { userAgent: 'contract-test' }, location: { href: '', search: '' },
};
sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
let loadError = null;
try { vm.runInContext(source, sandbox); } catch (error) { loadError = error; }
check(loadError === null, 'the page initialises with every availability read failing'
  + (loadError ? ' — ' + loadError.message : ''));
check(requested.length >= 1 && requested.some((u) => u.indexOf('/api/availability') === 0),
  'it still asks the server for availability');
check(requested.every((u) => !/[?&](email|token|rut|name)=/i.test(u)),
  'availability requests carry no identifying data');
check(requested.every((u) => u.indexOf('script.google.com') === -1),
  'and never address the upstream directly');

// --- Data minimisation: the page collects no patient RUT -------------------
// No current path — availability, reserve, Flow create/verify, Calendar/Meet,
// notification or management — reads a RUT, and no row stores one, so the page
// must not ask for one, validate one, or put one in the create request.
const RUT_PAGE_GUARANTEES = [
  ['the booking page has no RUT input', (t) => !/id="f-rut"/.test(t)],
  ['the review summary has no RUT row', (t) => !/id="rv-rut"/.test(t)],
  ['the booking page never asks for a RUT', (t) => !/\bRUT\b/i.test(t)],
];
const RUT_SOURCE_GUARANTEES = [
  ['the page runs no RUT validation', (t) => !/isValidChileanRut|formatRut|cleanRut/.test(t)],
  ['the create request carries no patientRut', (t) => !/patientRut/.test(t)],
  ['no RUT rejection code is handled client-side', (t) => !/PATIENT_RUT_REQUIRED|INVALID_PATIENT_RUT/.test(t)],
];
RUT_PAGE_GUARANTEES.forEach(([message, holds]) => check(holds(page), message));
RUT_SOURCE_GUARANTEES.forEach(([message, holds]) => check(holds(source), message));

// ---------------------------------------------------------------------------
// Adversarial mutations. A contract written as patterns proves nothing unless
// breaking the thing on purpose makes it fail, so each guarantee is checked
// against a source in which exactly that guarantee has been removed.
// ---------------------------------------------------------------------------
const mutations = [
  ['SLOT_TAKEN_KEEPS_CACHED_DATE', source.replace('confirmedDates.delete(isoTaken);', ''),
    SLOT_TAKEN_GUARANTEES, 'source'],
  ['SLOT_TAKEN_SKIPS_REFRESH', source.replace('fetchDate(isoTaken, true);', ''),
    SLOT_TAKEN_GUARANTEES, 'source'],
  ['SLOT_TAKEN_KEEPS_REJECTED_HOUR',
    source.replace(/const isoTaken = state\.date \? dateKeyFromDate\(state\.date\) : '';\n(\s*)state\.time = null;/,
      "const isoTaken = state.date ? dateKeyFromDate(state.date) : '';"),
    SLOT_TAKEN_GUARANTEES, 'source'],
  ['RUT_FIELD_REGROWN',
    page.replace('<label for="f-phone">Teléfono</label>',
      '<label for="f-rut">RUT Paciente</label>\n                <input class="input" type="text" id="f-rut" name="patient_rut" required />\n                <label for="f-phone">Teléfono</label>'),
    RUT_PAGE_GUARANTEES, 'page'],
  ['RUT_SENT_AGAIN',
    source.replace('      phone:       state.form.phone,\n',
      '      phone:       state.form.phone,\n      patientRut:  state.form.patientRut,\n'),
    RUT_SOURCE_GUARANTEES, 'source'],
  ['HOUR_STEP_REGROWS_AN_ADVANCE_BUTTON',
    page.replace('<div class="bk-actions bk-actions--back">\n            <button class="btn btn-ghost" data-action="prev">← Volver</button>\n          </div>\n        </div>\n\n        <!-- ── PASO 4: Datos de contacto',
      '<div class="bk-actions">\n            <button class="btn btn-ghost" data-action="prev">← Volver</button>\n            <button class="btn btn-primary" data-action="next">Continuar</button>\n          </div>\n        </div>\n\n        <!-- ── PASO 4: Datos de contacto'),
    STEP_GUARANTEES, 'page'],
];
let detected = 0;
for (const [name, mutated, guarantees, kind] of mutations) {
  const original = kind === 'source' ? source : page;
  assert.notEqual(mutated, original, 'mutation ' + name + ' did not change anything');
  const stillAllTrue = guarantees.every(([, holds]) => holds(mutated));
  assert.equal(stillAllTrue, false, 'mutation ' + name + ' went undetected');
  detected += 1;
  console.log('MUTATION_' + name + '=DETECTED');
}
console.log('MUTATIONS_DETECTED=' + detected + '/' + mutations.length);

console.log('BOOKING_AVAILABILITY_CONTRACT=PASS assertions=' + assertions);
console.log('PAGE_INITIALISES_WITH_ALL_AVAILABILITY_FAILING=YES');
console.log('AVAILABILITY_SEMANTICS=SERVER_RETURNS_OCCUPIED_SLOTS');
console.log('AVAILABILITY_FETCH_FAILURE=FAIL_CLOSED');
console.log('PER_DATE_AUTHORITATIVE_READ=YES');
console.log('SLOT_TAKEN_REFRESHES_AND_CLEARS=YES');
