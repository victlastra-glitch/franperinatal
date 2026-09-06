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
const slotTaken = source.slice(source.indexOf("if (code === 'SLOT_TAKEN') {"));
const block = slotTaken.slice(0, slotTaken.indexOf('} else if'));
check(/state\.time = null;/.test(block),
  'SLOT_TAKEN clears the hour the server just rejected');
check(/confirmedDates\.delete\(isoTaken\)/.test(block),
  'SLOT_TAKEN drops the cached view of that date, so it cannot be reused');
check(/fetchDate\(isoTaken, true\)/.test(block),
  'SLOT_TAKEN re-reads that date from the server before the hour step renders again');
check(/enableNext\(4, false\)/.test(block),
  'and the step cannot be advanced until a new hour is chosen');
check(/go\(4\)/.test(block), 'the patient is returned to the hour step');

// A bare `go(4)` with no refresh is the defect this replaces.
check(!/if \(code === 'SLOT_TAKEN'\) \{\s*\/\/[^\n]*\n\s*setTimeout\(\(\) => go\(4\), 1500\);\s*\}/.test(source),
  'SLOT_TAKEN never merely navigates back without re-reading availability');

// --- The inversion itself --------------------------------------------------
check(has(/OCUPADAS/), 'the occupied-not-free contract is stated where bookedSlots is declared');
check(has(/!takenHours\.includes\(s\)/),
  'the grid is still working hours minus occupied hours');

// --- enableNext must be able to disable -----------------------------------
check(has(/function enableNext\(stepNum, enabled\)/) && has(/btn\.disabled = enabled === false/),
  'enableNext can disable, which fail-closed needs');

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

console.log('BOOKING_AVAILABILITY_CONTRACT=PASS assertions=' + assertions);
console.log('PAGE_INITIALISES_WITH_ALL_AVAILABILITY_FAILING=YES');
console.log('AVAILABILITY_SEMANTICS=SERVER_RETURNS_OCCUPIED_SLOTS');
console.log('AVAILABILITY_FETCH_FAILURE=FAIL_CLOSED');
console.log('PER_DATE_AUTHORITATIVE_READ=YES');
console.log('SLOT_TAKEN_REFRESHES_AND_CLEARS=YES');
