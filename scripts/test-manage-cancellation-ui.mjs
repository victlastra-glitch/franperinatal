/**
 * /manage panel UI contract.
 *
 * The page offers a patient exactly one way forward at a time. Once a panel is
 * open it carries its own heading, its own explanation, its own confirm and its
 * own "Volver"; the entry row above it ("Reagendar" / "Cancelar hora") is then a
 * second, redundant copy of the step the patient is already inside. Production
 * showed the outlined "Cancelar hora" button sitting directly above
 * "Confirmar cancelación", which is exactly that duplicate.
 *
 * These assertions execute the real page script against a DOM built FROM the
 * committed markup — ids, classes and inline styles are read out of
 * manage.html, never invented here — and drive it through every state the
 * patient can reach: loading, normal manage, rescheduled, panel closed, panel
 * open, and the final cancelled view.
 *
 * No network, no browser, no build:
 *   node scripts/test-manage-cancellation-ui.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../manage.html', import.meta.url), 'utf8');
const script = source.slice(source.lastIndexOf('<script>') + '<script>'.length, source.lastIndexOf('</script>'));

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

// ---------------------------------------------------------------------------
// A DOM whose shape comes from the committed markup.
//
// Every element carrying an id is registered in document order with the classes
// and inline display the file actually gives it. A stub that invented its own
// element list could assert nothing about this page.
// ---------------------------------------------------------------------------
function parseMarkup(html) {
  const body = html.slice(0, html.indexOf('<script>'));
  const found = [];
  const tag = /<([a-zA-Z][\w-]*)\s([^>]*)>/g;
  let match;
  while ((match = tag.exec(body)) !== null) {
    const attributes = match[2];
    const id = (attributes.match(/\sid="([^"]+)"/) || attributes.match(/^id="([^"]+)"/) || [])[1];
    if (!id) continue;
    const className = (attributes.match(/\sclass="([^"]*)"/) || attributes.match(/^class="([^"]*)"/) || [])[1] || '';
    const style = (attributes.match(/\sstyle="([^"]*)"/) || [])[1] || '';
    const display = (style.match(/display\s*:\s*([^;]+)/) || [])[1];
    found.push({ tagName: match[1], id, classes: className.split(/\s+/).filter(Boolean),
      display: display ? display.trim() : '', hidden: /\shidden(\s|=|$)/.test(attributes) });
  }
  return found;
}

const BLUEPRINT = parseMarkup(source);
check(BLUEPRINT.some((node) => node.id === 'det-actions'),
  'the markup still has the entry-actions row this contract is about');
check(BLUEPRINT.filter((node) => node.classes.includes('mg-panel')).map((node) => node.id).join(',')
  === 'panel-cancel,panel-reschedule',
  'the markup still has exactly the cancel and reschedule panels, in that order');
check(BLUEPRINT.filter((node) => node.classes.includes('mg-view')).map((node) => node.id).join(',')
  === 'view-loading,view-error,view-detail,view-cancelled,view-rescheduled',
  'the markup still has exactly the five patient-visible views');
// Hiding the row is only equivalent to hiding both entry buttons while they
// actually live inside it. Checked against the committed markup, once.
const ENTRY_ROW = source.slice(source.indexOf('id="det-actions"'), source.indexOf('id="panel-cancel"'));
check(ENTRY_ROW.includes('id="btn-reschedule"') && ENTRY_ROW.includes('id="btn-cancel"')
  && ENTRY_ROW.indexOf('</div>') > ENTRY_ROW.indexOf('id="btn-cancel"'),
  'both entry buttons are inside #det-actions in the committed markup');

function makeElement(node) {
  const classes = new Set(node.classes || []);
  const listeners = {};
  const element = {
    tagName: node.tagName || 'div',
    id: node.id || '',
    children: [],
    textContent: '',
    value: '',
    disabled: false,
    hidden: Boolean(node.hidden),
    style: { display: node.display || '' },
    dataset: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
    },
    get className() { return [...classes].join(' '); },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n)); },
    set innerHTML(value) { element._html = String(value); if (value === '') element.children = []; },
    get innerHTML() { return element._html || ''; },
    appendChild: (child) => { element.children.push(child); return child; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
    focus: () => {}, scrollIntoView: () => {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    click: () => (listeners.click || []).forEach((fn) => fn.call(element, { preventDefault() {} })),
    matches: (selector) => selector.split('.').filter(Boolean).every((name) => classes.has(name)),
    _visible: () => element.style.display !== 'none' && element.hidden !== true,
  };
  return element;
}

function buildDocument() {
  const order = BLUEPRINT.map(makeElement);
  const byId = new Map(order.map((element) => [element.id, element]));
  const created = [];
  const matchAll = (selector) => {
    const names = String(selector).split('.').filter(Boolean);
    return order.filter((element) => names.every((name) => element.classList.contains(name)));
  };
  return {
    document: {
      getElementById: (id) => byId.get(String(id)) || null,
      querySelector: (selector) => matchAll(selector)[0] || null,
      querySelectorAll: matchAll,
      createElement: (tagName) => {
        const element = makeElement({ tagName, id: '', classes: [] });
        created.push(element);
        return element;
      },
      addEventListener: () => {},
      body: makeElement({ tagName: 'body', id: '', classes: [] }),
    },
    byId,
    order,
  };
}

const RESERVATION = Object.freeze({
  ok: true, status: 'active', nombre: 'Paciente Sintética',
  fecha: '2026-10-08', hora: '11:00', servicio: 'Sesión inicial', modalidad: 'Online',
  date: '2026-10-08', time: '11:00', serviceType: 'Sesión inicial',
  capabilityType: 'CANCEL', canReschedule: false, canCancel: true,
  managementWindow: 'open', refundEligible: true,
});

/** Run the real page script against a fresh DOM, with a scripted API. */
async function loadPage(reservation, options) {
  const pageScript = (options && options.patch) ? applyPatch(options.patch) : script;
  const dom = buildDocument();
  const requests = [];
  const sandbox = {
    document: dom.document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {},
    fetch: async (url, init) => {
      const href = String(url);
      requests.push(href);
      if (href === '/api/manage') return { ok: true, status: 200, json: async () => reservation };
      if (href === '/api/manage-cancel') {
        return { ok: true, status: 200, json: async () => ((options && options.cancelResponse)
          || { ok: true, refund: 'requested' }) };
      }
      if (href === '/api/manage-availability') return { ok: true, status: 200, json: async () => [] };
      void init;
      return { ok: false, status: 404, json: async () => ({ ok: false, code: 'REQUEST_REJECTED' }) };
    },
    Date, Intl, JSON, Math, Number, String, Object, Array, Set, Map, RegExp, Promise,
    Error, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    URLSearchParams, URL,
    navigator: { userAgent: 'manage-ui-contract' },
    location: { href: 'https://franciscabustos.cl/manage.html', search: '?token=' + 'a'.repeat(72) },
  };
  sandbox.window = {
    addEventListener() {}, scrollTo() {},
    location: sandbox.location,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pageScript, sandbox);
  await settle();
  return { dom, requests, el: (id) => dom.byId.get(id) };
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

/** Break exactly one thing in the page script, on purpose. */
function applyPatch([find, replace]) {
  if (script.indexOf(find) === -1) throw new Error('mutation anchor missing in manage.html: ' + find);
  return script.split(find).join(replace);
}

const activeView = (dom) => dom.order.filter((node) => node.classList.contains('mg-view')
  && node.classList.contains('active')).map((node) => node.id);
const openPanels = (dom) => dom.order.filter((node) => node.classList.contains('mg-panel')
  && node.classList.contains('open')).map((node) => node.id);

// ---------------------------------------------------------------------------
// 1. Normal manage state: the entry row is the only call to action.
// ---------------------------------------------------------------------------
{
  const page = await loadPage(RESERVATION);
  check(activeView(page.dom).join(',') === 'view-detail', 'a valid link lands on the reservation detail');
  check(openPanels(page.dom).length === 0, 'no panel is open before the patient chooses');
  check(page.el('det-actions')._visible() && page.el('det-actions').hidden === false,
    'NORMAL_MANAGE_ENTRY_ACTIONS=VISIBLE');
  check(page.el('btn-cancel').style.display !== 'none', 'the authorized cancel entry is offered');
  check(page.el('btn-reschedule').style.display === 'none',
    'an unauthorized reschedule entry is not offered');
  check(page.el('cancel-policy-copy').textContent.startsWith('Puedes cancelar esta sesión'),
    'the refundable policy copy is rendered into the panel');
}

// ---------------------------------------------------------------------------
// 2. Rescheduled state: the true reason is named and the entry row still obeys
//    the server verdict.
// ---------------------------------------------------------------------------
{
  const page = await loadPage(Object.assign({}, RESERVATION, {
    status: 'rescheduled', canReschedule: false, canCancel: true, capabilityType: 'CANCEL',
  }));
  check(activeView(page.dom).join(',') === 'view-detail', 'a rescheduled reservation still renders its detail');
  check(page.el('det-policy-note').hidden === false
    && page.el('det-policy-note').textContent.startsWith('Ya usaste el cambio de horario'),
    'RESCHEDULED_NOTE=ONE_MOVE_CAP');
  check(page.el('det-actions')._visible() && page.el('btn-cancel').style.display !== 'none'
    && page.el('btn-reschedule').style.display === 'none',
    'RESCHEDULED_ENTRY_ACTIONS=CANCEL_ONLY');
}

// ---------------------------------------------------------------------------
// 3 + 4. Cancellation panel closed, then open. The regression this file exists
//        for: the entry CTA must not survive alongside the panel.
// ---------------------------------------------------------------------------
{
  const page = await loadPage(RESERVATION);
  const actions = page.el('det-actions');
  const panel = page.el('panel-cancel');

  check(panel.classList.contains('open') === false && actions._visible(),
    'CANCEL_PANEL_CLOSED=ENTRY_ACTIONS_VISIBLE');

  page.el('btn-cancel').click();

  check(openPanels(page.dom).join(',') === 'panel-cancel', 'the cancellation panel is the only one open');
  check(actions.style.display === 'none' && actions.hidden === true && !actions._visible(),
    'CANCEL_PANEL_OPEN=ENTRY_ACTIONS_HIDDEN — no duplicate "Cancelar hora" above the panel');
  // What the patient is left with, and nothing else.
  check(page.el('btn-cancel-confirm')._visible() && page.el('btn-cancel-back')._visible()
    && page.el('cancel-policy-copy').textContent.length > 0,
    'CANCEL_PANEL_OPEN=HEADING_COPY_CONFIRM_VOLVER');

  // Volver restores exactly what the server authorized, and no more.
  page.el('btn-cancel-back').click();
  check(openPanels(page.dom).length === 0, 'Volver closes the panel');
  check(actions._visible() && actions.hidden === false
    && page.el('btn-cancel').style.display !== 'none'
    && page.el('btn-reschedule').style.display === 'none',
    'CANCEL_PANEL_REOPENED_CLOSED=ENTRY_ACTIONS_RESTORED_FROM_SERVER_CAPABILITIES');
}

// ---------------------------------------------------------------------------
// 5. The same rule for the reschedule panel — one derivation, not two.
// ---------------------------------------------------------------------------
{
  const page = await loadPage(Object.assign({}, RESERVATION, {
    capabilityType: 'RESCHEDULE', canReschedule: true, canCancel: false,
  }));
  const actions = page.el('det-actions');
  check(actions._visible() && page.el('btn-reschedule').style.display !== 'none',
    'a reschedule-capable link offers the reschedule entry');
  page.el('btn-reschedule').click();
  await settle();
  check(openPanels(page.dom).join(',') === 'panel-reschedule', 'the reschedule panel opens');
  check(actions.style.display === 'none' && actions.hidden === true,
    'RESCHEDULE_PANEL_OPEN=ENTRY_ACTIONS_HIDDEN');
  page.el('btn-reschedule-back2').click();
  check(openPanels(page.dom).length === 0 && actions._visible() && actions.hidden === false,
    'RESCHEDULE_PANEL_CLOSED=ENTRY_ACTIONS_RESTORED');
}

// ---------------------------------------------------------------------------
// 6. Final cancelled state: the detail view and its entry row are gone, and the
//    copy matches the refund outcome the SERVER reported.
// ---------------------------------------------------------------------------
{
  const page = await loadPage(RESERVATION);
  page.el('btn-cancel').click();
  page.el('btn-cancel-confirm').click();
  await settle();
  check(activeView(page.dom).join(',') === 'view-cancelled', 'FINAL_STATE=VIEW_CANCELLED');
  check(page.el('view-detail').classList.contains('active') === false,
    'the detail view, and with it the entry actions, is no longer displayed');
  check(page.el('cancelled-copy').textContent.startsWith('Tu sesión fue cancelada y el horario quedó disponible. El reembolso está en proceso'),
    'the refunded-pending copy comes from data.refund, not from a client guess');
  check(page.requests.filter((href) => href === '/api/manage-cancel').length === 1,
    'confirming issues a single /api/manage-cancel request, through the same-origin Worker route');
}

// A non-refundable outcome reported by the server gets the other approved copy.
{
  const page = await loadPage(Object.assign({}, RESERVATION, { refundEligible: false }),
    { cancelResponse: { ok: true, refund: 'not_required' } });
  check(page.el('cancel-policy-copy').textContent.startsWith('Esta sesión comienza en menos de 24 horas'),
    'the non-refundable policy copy is rendered into the panel');
  page.el('btn-cancel').click();
  page.el('btn-cancel-confirm').click();
  await settle();
  check(page.el('cancelled-copy').textContent.startsWith('Recibimos tu aviso'),
    'FINAL_STATE_COPY=SERVER_REFUND_OUTCOME');
}

// ---------------------------------------------------------------------------
// 7. A server that authorizes nothing keeps the entry row hidden throughout.
// ---------------------------------------------------------------------------
{
  const page = await loadPage(Object.assign({}, RESERVATION, {
    canCancel: false, canReschedule: false, capabilityType: 'CANCEL', managementWindow: 'closed',
  }));
  check(page.el('det-actions').style.display === 'none',
    'NO_CAPABILITY=ENTRY_ACTIONS_HIDDEN');
  check(page.el('det-policy-note').hidden === false
    && page.el('det-policy-note').textContent.startsWith('Esta sesión ya no admite cambios'),
    'and the page says why');
}

// ---------------------------------------------------------------------------
// Adversarial mutation: restore the shipped defect and require detection. A
// contract that cannot fail proves nothing.
// ---------------------------------------------------------------------------
{
  const page = await loadPage(RESERVATION, {
    patch: ["    actions.style.display = (!panelOpen && (showReschedule || showCancel)) ? 'flex' : 'none';",
      "    actions.style.display = (showReschedule || showCancel) ? 'flex' : 'none';"],
  });
  page.el('btn-cancel').click();
  let caught = null;
  try {
    assert.ok(page.el('det-actions').style.display === 'none',
      'the entry row must not survive an open panel');
  } catch (error) { caught = error; }
  check(caught !== null, 'MUTATION_ENTRY_ACTIONS_IGNORE_OPEN_PANEL is detected');
}
{
  const page = await loadPage(RESERVATION, {
    patch: ['    actions.hidden = panelOpen;', '    actions.hidden = false;'],
  });
  page.el('btn-cancel').click();
  let caught = null;
  try {
    assert.equal(page.el('det-actions').hidden, true,
      'the hidden entry row must also leave the accessibility tree');
  } catch (error) { caught = error; }
  check(caught !== null, 'MUTATION_ENTRY_ACTIONS_STAY_IN_A11Y_TREE is detected');
}

console.log('MANAGE_PANEL_UI_CONTRACT=PASS assertions=' + assertions);
console.log('MUTATION_ENTRY_ACTIONS_IGNORE_OPEN_PANEL=DETECTED');
console.log('MUTATION_ENTRY_ACTIONS_STAY_IN_A11Y_TREE=DETECTED');
console.log('DUPLICATE_CANCEL_ENTRY_CTA_WHILE_PANEL_OPEN=0');
console.log('ENTRY_ACTIONS_DERIVATION=SERVER_CAPABILITIES_ONLY');
console.log('STATES_COVERED=normal,rescheduled,panel_closed,panel_open,cancelled,no_capability');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');
