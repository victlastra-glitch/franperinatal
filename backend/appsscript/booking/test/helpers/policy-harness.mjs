/**
 * Shared VM harness for the patient-management policy suites.
 *
 * One Apps Script context per call, driven by a controllable server clock.
 * `patches` rewrites source before it enters the VM, which is how the mutation
 * halves of the policy suites break exactly one guard at a time.
 *
 * Nothing here reads the host clock, opens a socket, sends mail, or reaches a
 * real service: every gateway is a fake that records what it was asked to do.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const FILES = ['Code.js', 'Lifecycle.js', 'EmailTemplates.js', 'CalendarGateway.js', 'Reconciliation.js', 'RefundGateway.js'];
const SOURCE = Object.fromEntries(await Promise.all(FILES.map(async (name) => [
  name, await readFile(new URL('../../' + name, import.meta.url), 'utf8'),
])));

export const CAPABILITY_SECRET = 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz';
export const OPS_EMAIL = 'ops@example.test';
// Distinct from OPS_EMAIL on purpose: it is what lets the assertions below tell a
// patient-facing email apart from an internal operational notice.
export const PATIENT_EMAIL = 'paciente@example.test';
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

// Tuesday 2026-09-01 09:00 America/Santiago (CLT, UTC-4). Every booking below is
// a weekday inside WORKING_HOURS, the 120-minute lead time and the 90-day
// horizon relative to this instant.
export const T0 = Date.parse('2026-09-01T13:00:00.000Z');

const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));

// ---------------------------------------------------------------------------
// Harness. `patches` rewrites source before it enters the VM; that is how the
// mutation half of this file breaks exactly one guard at a time.
// ---------------------------------------------------------------------------
export function buildHarness(patches) {
  const sources = FILES.map((name) => {
    let text = SOURCE[name];
    (patches && patches[name] ? patches[name] : []).forEach(([find, replace]) => {
      if (text.indexOf(find) === -1) throw new Error('mutation anchor missing in ' + name + ': ' + find);
      text = text.split(find).join(replace);
    });
    return text;
  });

  const state = {
    nowMs: T0,
    headers: [],
    byReservation: new Map(),
    outboxRows: [],
    outboxHeaders: [],
    mail: [],
    eventsById: new Map(),
    flowByToken: new Map(),
    refundByToken: new Map(),
    refundCreateCalls: 0,
    refundCreateShouldFail: false,
    refundStatusOverride: 'accepted',
    lastRefundPayload: null,
    seq: 0,
  };
  const setNow = (value) => { state.nowMs = Number(value); };

  class MutableDate extends Date {
    constructor(...args) { if (args.length === 0) super(state.nowMs); else super(...args); }
    static now() { return state.nowMs; }
  }
  Object.defineProperty(MutableDate, 'parse', { value: Date.parse, writable: true, configurable: true });
  Object.defineProperty(MutableDate, 'UTC', { value: Date.UTC, writable: true, configurable: true });

  const currentRows = () => [...state.byReservation.values()];
  const makeRange = (getHeaders, setCell, onHeaderWrite) => (row, col) => ({
    getDisplayValues: () => [getHeaders()],
    setValue: (value) => setCell(row, col, value),
    setValues: (values) => { if (row === 1 && values && values[0] && onHeaderWrite) onHeaderWrite(values[0]); },
  });

  const sheet = {
    getLastRow: () => 1 + state.byReservation.size,
    getLastColumn: () => state.headers.length,
    getRange: makeRange(() => state.headers, (row, col, value) => {
      if (row < 2) return;
      const record = currentRows()[row - 2];
      if (!record) return;
      record[state.headers[col - 1]] = String(value == null ? '' : value);
      state.byReservation.set(record.reservation_id, record);
    }),
    getDataRange: () => ({
      getValues: () => [state.headers, ...currentRows().map((r) => state.headers.map((h) => r[h] ?? ''))],
    }),
    appendRow: (row) => {
      const record = { rowNumber: state.byReservation.size + 2 };
      state.headers.forEach((header, index) => { record[header] = row[index] == null ? '' : String(row[index]); });
      state.byReservation.set(record.reservation_id, record);
    },
    getParent: () => spreadsheet,
  };
  const outboxSheet = {
    getLastRow: () => (state.outboxHeaders.length ? 1 + state.outboxRows.length : 0),
    getLastColumn: () => state.outboxHeaders.length,
    getRange: makeRange(() => state.outboxHeaders, (row, col, value) => {
      if (row < 2) return;
      const current = state.outboxRows[row - 2];
      if (!current) return;
      current[state.outboxHeaders[col - 1]] = String(value == null ? '' : value);
    }, (values) => { state.outboxHeaders.splice(0, state.outboxHeaders.length, ...values.map(String)); }),
    getDataRange: () => ({
      getValues: () => [state.outboxHeaders, ...state.outboxRows.map((r) => state.outboxHeaders.map((h) => r[h] ?? ''))],
    }),
    appendRow: (row) => {
      const created = { rowNumber: state.outboxRows.length + 2 };
      state.outboxHeaders.forEach((header, index) => { created[header] = row[index] == null ? '' : String(row[index]); });
      state.outboxRows.push(created);
    },
    getParent: () => spreadsheet,
  };
  const spreadsheet = {
    getId: () => 'synthetic-store',
    getSheetByName: (name) => {
      if (name === 'reservations') return sheet;
      if (name === 'notification_outbox') return state.outboxHeaders.length ? outboxSheet : null;
      return null;
    },
    insertSheet: (name) => (name === 'notification_outbox' ? outboxSheet : sheet),
  };

  const context = {
    console, Date: MutableDate, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
    encodeURIComponent, decodeURIComponent,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
      computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
      computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({
          APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
          FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
          FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
          FLOW_REFUND_CALLBACK_URL: 'https://franciscabustos.cl/api/refund-confirmation',
          BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
          INTERNAL_NOTIFICATION_EMAIL: OPS_EMAIL, IDEMPOTENCY_NAMESPACE: 'fran-booking',
          STATUS_TOKEN_SECRET: 'synthetic-status-secret', CAPABILITY_TOKEN_SECRET: CAPABILITY_SECRET,
        }),
        getProperty: () => '',
        setProperty: () => {},
      }),
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
    Calendar: {
      Freebusy: { query: () => ({ calendars: { 'synthetic-calendar': { busy: [] } } }) },
      Events: {
        list: () => ({ items: [...state.eventsById.values()], nextSyncToken: 'sync-1' }),
        get: (_id, eventId) => state.eventsById.get(String(eventId)) || null,
        insert: (resource) => {
          state.seq += 1;
          const event = {
            id: 'event-' + state.seq, etag: 'etag-' + state.seq, updated: new MutableDate().toISOString(),
            status: 'confirmed', start: resource.start, end: resource.end,
            extendedProperties: resource.extendedProperties,
            conferenceData: {
              conferenceId: 'meet-' + state.seq,
              entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/opaque-' + state.seq }],
            },
          };
          state.eventsById.set(event.id, event);
          return event;
        },
        update: (resource) => {
          const current = state.eventsById.get(String(resource.id)) || resource;
          const next = Object.assign({}, current, resource, { etag: 'etag-u', updated: new MutableDate().toISOString() });
          state.eventsById.set(String(next.id), next);
          return next;
        },
        remove: (_id, eventId) => {
          const current = state.eventsById.get(String(eventId));
          if (current) state.eventsById.set(String(eventId), Object.assign({}, current, { status: 'cancelled', deleted: true }));
        },
      },
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: (url, options) => {
        const href = String(url);
        const form = () => Object.fromEntries(String(options && options.payload || '').split('&').filter(Boolean)
          .map((part) => part.split('=').map(decodeURIComponent)));
        if (href.includes('/payment/create')) {
          const body = form();
          state.seq += 1;
          const token = 'FLOWTOKENPOLICY' + String(state.seq).padStart(16, '0');
          state.flowByToken.set(token, { commerceOrder: body.commerceOrder, status: 1 });
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ url: 'https://www.flow.cl/app/web/pay', token }) };
        }
        if (href.includes('/payment/getStatus')) {
          const query = Object.fromEntries(href.split('?')[1].split('&').map((part) => part.split('=').map(decodeURIComponent)));
          const current = state.flowByToken.get(query.token);
          if (!current) return { getResponseCode: () => 404, getContentText: () => JSON.stringify({ code: 404 }) };
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: current.status, commerceOrder: current.commerceOrder }) };
        }
        if (href.includes('/refund/create')) {
          state.refundCreateCalls += 1;
          state.lastRefundPayload = form();
          if (state.refundCreateShouldFail) return { getResponseCode: () => 500, getContentText: () => JSON.stringify({ code: 500 }) };
          state.seq += 1;
          const token = 'REFUNDTOKENPOLICY' + String(state.seq).padStart(12, '0');
          state.refundByToken.set(token, { status: 'created' });
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ token, status: 'created' }) };
        }
        if (href.includes('/refund/getStatus')) {
          const query = Object.fromEntries(href.split('?')[1].split('&').map((part) => part.split('=').map(decodeURIComponent)));
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ token: query.token, status: state.refundStatusOverride }) };
        }
        throw new Error('unexpected url ' + href);
      },
    },
    GmailApp: {
      sendEmail: (to, subject, body, options) => {
        state.mail.push({ to, subject, body, htmlBody: options && options.htmlBody });
        return true;
      },
    },
    MailApp: { sendEmail: () => { throw new Error('MailApp must not be called'); } },
    // Present so the doPost/doGet routes can be exercised as the real Web App
    // does, code mapping included, rather than only their inner handlers.
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (value) => ({ value, setMimeType() { return this; } }),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
      deleteTrigger: () => {},
    },
  };

  vm.createContext(context);
  for (const source of sources) vm.runInContext(source, context);

  state.headers = [...context.RESERVATION_HEADERS];
  const phase = context.__PHASE_A_TEST_EXPORTS__;
  const worker = context.__NOTIFICATION_OUTBOX_TEST_EXPORTS__;
  state.outboxHeaders.splice(0, state.outboxHeaders.length, ...phase.OUTBOX_HEADERS);

  const schema = () => ({ headers: state.headers, columns: Object.fromEntries(state.headers.map((h, i) => [h, i + 1])) });
  const drain = () => worker.processLifecycleNotificationOutbox_({
    config: phase.readCapabilityConfig_(), resources: { sheet }, schema: schema(),
    requireCapabilitySecret_: () => CAPABILITY_SECRET,
  });
  const idempotencyKey = (n) => 'fran-booking-bbbbbb' + String(n).padStart(2, '0') + '-e89b-12d3-a456-426614174000';
  const rowFor = (n) => currentRows().find((row) => row.idempotency_key === idempotencyKey(n));

  /**
   * Create + provider-confirm a paid booking, then return it with fresh CTA tokens.
   *
   * `createLeadMs` is how long before the session the booking is made. It
   * matters because a capability lives CAPABILITY_TTL_MS (24h) from the moment
   * the confirmation is rendered, so every scenario below creates its booking
   * close enough to the instant it then acts at for the token to still be live.
   * That is production behaviour, not a test convenience.
   */
  const paidBooking = (n, date, time, createLeadMs) => {
    const startMs = Date.parse(phase.startAt_(date, time));
    if (!Number.isFinite(startMs)) throw new Error('fixture start is not resolvable: ' + date + ' ' + time);
    setNow(startMs - Number(createLeadMs));
    // Flush anything a previous scenario left queued, so the drain below can only
    // deliver THIS booking's confirmation and the tokens parsed from it are
    // unambiguously this reservation's.
    drain();
    const created = context.createFlowPayment_({
      postData: { contents: JSON.stringify({
        action: 'create_flow_payment', idempotencyKey: idempotencyKey(n), serviceType: 'initial',
        modality: 'online', date, time, name: 'Synthetic', email: PATIENT_EMAIL,
        phone: '', patientRut: '', reason: '', message: '',
      }) },
    });
    if (!created.ok) throw new Error('fixture booking rejected: ' + JSON.stringify(created));
    const row = rowFor(n);
    state.flowByToken.get(row.flow_token).status = 2;
    context.flowConfirmation_({ parameter: { token: row.flow_token } });
    state.mail.length = 0;
    drain();
    const confirmations = state.mail.filter((item) => String(item.subject).startsWith('Tu sesión está confirmada'));
    if (confirmations.length !== 1) {
      throw new Error('fixture expected exactly one confirmation email, got ' + confirmations.length);
    }
    const body = confirmations[0].body;
    const tokenFrom = (label) => {
      const match = body.match(new RegExp(label + ':.*token=([A-Za-z0-9_-]{64,256})'));
      return match && match[1];
    };
    return { n, startMs, reschedule: tokenFrom('Reagendar'), cancel: tokenFrom('Cancelar') };
  };

  /**
   * Pull the management bearers out of a delivered lifecycle email.
   *
   * Only ever read from what was actually sent, never reconstructed from stored
   * state: the whole point of the send-time mint is that the raw bearer exists
   * nowhere else.
   */
  const tokensFromMail = (subjectPrefix) => {
    const matches = state.mail.filter((item) => String(item.subject).startsWith(subjectPrefix));
    if (!matches.length) throw new Error('no delivered email with subject prefix: ' + subjectPrefix);
    const body = matches[matches.length - 1].body;
    const pick = (label) => {
      const found = body.match(new RegExp(label + ':.*token=([A-Za-z0-9_-]{64,256})'));
      return found ? found[1] : null;
    };
    return { reschedule: pick('Reagendar'), cancel: pick('Cancelar') };
  };

  return { context, phase, worker, state, setNow, sheet, schema, drain, rowFor, paidBooking,
    currentRows, tokensFromMail };
}

// ---------------------------------------------------------------------------
// Discover the real America/Santiago DST transitions rather than hardcoding one.
// ---------------------------------------------------------------------------
export function santiagoOffsetMinutes(ms) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).forEach((part) => { if (part.type !== 'literal') parts[part.type] = part.value; });
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  // formatToParts has second resolution, so round to whole minutes: an offset is
  // never finer than that, and an unrounded residue would make the transition
  // search converge on the truncation instead of the real offset change.
  return Math.round((asUtc - ms) / 60000);
}
export function santiagoHour(ms) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms)));
}
/** Binary-search the whole-minute instant a Santiago offset change takes effect. */
export function findTransition(fromMs, toMs) {
  const minute = 60000;
  let low = Math.floor(fromMs / minute) * minute;
  let high = Math.ceil(toMs / minute) * minute;
  const startOffset = santiagoOffsetMinutes(low);
  if (startOffset === santiagoOffsetMinutes(high)) return null;
  while (high - low > minute) {
    const mid = low + Math.floor((high - low) / (2 * minute)) * minute;
    if (mid === low) break;
    if (santiagoOffsetMinutes(mid) === startOffset) low = mid; else high = mid;
  }
  return high;
}

