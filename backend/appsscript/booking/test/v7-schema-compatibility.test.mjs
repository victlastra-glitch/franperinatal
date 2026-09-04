import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js', '../CalendarGateway.js', '../Reconciliation.js', '../RefundGateway.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));

const propertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', PUBLIC_RETURN_URL: 'https://franciscabustos.cl/pago-resultado',
  FLOW_CONFIRMATION_URL: 'https://franciscabustos.cl/api/flow-confirmation',
  SHEET_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz',
  FLOW_REFUND_CALLBACK_URL: 'https://franciscabustos.cl/api/refund-confirmation',
};
const bytes = (value) => [...value].map((byte) => (byte > 127 ? byte - 256 : byte));

function makeSheet(initialHeaders, initialRows) {
  const headers = [...initialHeaders];
  const rows = initialRows.map((row) => {
    const copy = [...row];
    while (copy.length < headers.length) copy.push('');
    return copy;
  });
  const sheet = {
    name: 'Respuestas de formulario 1',
    getLastRow: () => 1 + rows.length,
    getLastColumn: () => headers.length,
    getRange: (row, col, numRows, numCols) => ({
      getDisplayValues: () => [headers.slice(col - 1, (numCols ? col - 1 + numCols : headers.length))],
      getValues: () => [headers.slice(col - 1, (numCols ? col - 1 + numCols : headers.length))],
      setValue: (value) => {
        if (row === 1) {
          while (headers.length < col) headers.push('');
          headers[col - 1] = String(value == null ? '' : value);
          rows.forEach((entry) => { while (entry.length < headers.length) entry.push(''); });
          return;
        }
        const target = rows[row - 2];
        if (!target) return;
        while (target.length < col) target.push('');
        target[col - 1] = value;
      },
      setValues: (values) => {
        if (row === 1 && values && values[0]) {
          values[0].forEach((value, index) => {
            const at = col - 1 + index;
            while (headers.length <= at) headers.push('');
            headers[at] = String(value == null ? '' : value);
          });
          rows.forEach((entry) => { while (entry.length < headers.length) entry.push(''); });
        }
      },
    }),
    getDataRange: () => ({
      getValues: () => [headers.slice(), ...rows.map((row) => {
        const copy = [...row];
        while (copy.length < headers.length) copy.push('');
        return copy;
      })],
    }),
    appendRow: (row) => {
      const copy = [...row];
      while (copy.length < headers.length) copy.push('');
      rows.push(copy);
    },
    getParent: () => spreadsheet,
    _headers: headers,
    _rows: rows,
  };
  return sheet;
}

const englishV7Headers = [
  'timestamp', 'phone', 'email', 'service', 'modality', 'date', 'time', 'message',
  'reservationId', 'name', 'googleMeetLink', 'calendarEventId', 'manageToken',
  'status', 'cancelledAt', 'replacedByReservationId',
  'commerceOrder', 'flowOrder', 'flowToken', 'priceClp', 'paidAt',
  'rawFlowStatus', 'serviceType', 'patientRut', 'paymentUrl', 'publicStatusToken',
  'calendarCreated', 'emailPatientSent', 'emailInternalSent',
  'emailPatientSentAt', 'emailInternalSentAt', 'paymentExpiresAt', 'reviewReason',
];
const spanishV7Headers = [
  'Marca temporal', 'Teléfono', 'Correo electrónico', 'Servicio', 'Modalidad', 'Fecha', 'Hora', 'Motivo',
  'reservationId', 'Nombre', 'googleMeetLink', 'calendar event ID', 'manageToken',
  'estado', 'cancelledAt', 'replacedByReservationId',
  ...englishV7Headers.slice(16),
];

function v7Row(overrides) {
  const row = englishV7Headers.map(() => '');
  const set = (name, value) => { row[englishV7Headers.indexOf(name)] = value; };
  set('timestamp', '2026-08-20T12:00:00.000Z');
  set('phone', '+56900000000');
  set('email', 'legacy@example.test');
  set('service', 'initial');
  set('modality', 'online');
  set('date', '2026-09-07');
  set('time', '10:00');
  set('message', '');
  set('reservationId', 'legacy-reservation-active');
  set('name', 'Legacy Patient');
  set('googleMeetLink', 'https://meet.google.com/legacy-meet');
  set('calendarEventId', 'legacy-cal-event-1');
  set('manageToken', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  set('status', 'active');
  set('commerceOrder', 'FB-20260907-1000-1111');
  set('flowToken', 'legacy-flow-token');
  set('priceClp', '50000');
  set('paidAt', '2026-08-20T12:05:00.000Z');
  set('rawFlowStatus', '2');
  set('serviceType', 'initial');
  set('paymentUrl', 'https://www.flow.cl/app/web/pay');
  set('paymentExpiresAt', '2026-08-20T12:15:00.000Z');
  Object.keys(overrides || {}).forEach((key) => set(key, overrides[key]));
  return row;
}

const legacyRows = [
  v7Row({ reservationId: 'legacy-active', status: 'active', manageToken: '11111111-2222-4333-8444-555555555555' }),
  v7Row({
    reservationId: 'legacy-pending', status: 'pending_payment', paidAt: '', rawFlowStatus: '1',
    googleMeetLink: '', calendarEventId: '', date: '2026-09-07', time: '11:00',
    manageToken: '21111111-2222-4333-8444-555555555555',
  }),
  v7Row({
    reservationId: 'legacy-paid', status: 'paid_confirmed', date: '2026-09-07', time: '12:00',
    calendarEventId: 'legacy-cal-paid', googleMeetLink: 'https://meet.google.com/legacy-paid',
    manageToken: '31111111-2222-4333-8444-555555555555',
  }),
  v7Row({
    reservationId: 'legacy-rejected', status: 'payment_rejected', paidAt: '', rawFlowStatus: '3',
    date: '2026-09-07', time: '13:00', googleMeetLink: '', calendarEventId: '',
    manageToken: '41111111-2222-4333-8444-555555555555',
  }),
  v7Row({
    reservationId: 'legacy-review', status: 'payment_review_required', rawFlowStatus: '',
    date: '2026-09-07', time: '14:00',
    manageToken: '51111111-2222-4333-8444-555555555555',
  }),
  v7Row({
    reservationId: 'legacy-rescheduled', status: 'rescheduled', replacedByReservationId: 'legacy-active',
    date: '2026-09-07', time: '15:00',
    manageToken: '61111111-2222-4333-8444-555555555555',
  }),
  v7Row({
    reservationId: 'legacy-cancelled', status: 'cancelled', cancelledAt: '2026-08-21T12:00:00.000Z',
    date: '2026-09-07', time: '16:00',
    manageToken: '71111111-2222-4333-8444-555555555555',
  }),
];

const bookingSheet = makeSheet(englishV7Headers, legacyRows.map((row) => [...row]));
const outboxHeaders = [];
const outboxRows = [];
const outboxSheet = {
  getLastRow: () => (outboxHeaders.length ? 1 + outboxRows.length : 0),
  getLastColumn: () => outboxHeaders.length,
  getRange: (row, col, numRows, numCols) => ({
    getDisplayValues: () => [outboxHeaders.slice(col - 1, numCols ? col - 1 + numCols : outboxHeaders.length)],
    getValues: () => [outboxHeaders.slice()],
    setValue: (value) => {
      if (row === 1) {
        while (outboxHeaders.length < col) outboxHeaders.push('');
        outboxHeaders[col - 1] = String(value == null ? '' : value);
      }
    },
    setValues: (values) => {
      if (row === 1 && values && values[0]) outboxHeaders.splice(0, outboxHeaders.length, ...values[0].map(String));
    },
  }),
  getDataRange: () => ({ getValues: () => [outboxHeaders.slice(), ...outboxRows.map((row) => [...row])] }),
  appendRow: (row) => outboxRows.push([...row]),
};
const spreadsheet = {
  getId: () => 'synthetic-store',
  getSheetByName: (name) => {
    if (name === 'Respuestas de formulario 1') return bookingSheet;
    if (name === 'notification_outbox') return outboxHeaders.length ? outboxSheet : null;
    return null;
  },
  insertSheet: (name) => (name === 'notification_outbox' ? outboxSheet : bookingSheet),
};

const context = {
  console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
  encodeURIComponent, decodeURIComponent,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: randomUUID,
    computeDigest: (_algorithm, value) => bytes(createHash('sha256').update(String(value)).digest()),
    computeHmacSha256Signature: (value, key) => bytes(createHmac('sha256', String(key)).update(String(value)).digest()),
    formatDate: (date, _tz, pattern) => {
      if (pattern === 'yyyy-MM-dd') return date.toISOString().slice(0, 10);
      if (pattern === 'HH:mm') return date.toISOString().slice(11, 16);
      return String(date);
    },
  },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
  SpreadsheetApp: { openById: () => spreadsheet },
  CalendarApp: { getCalendarById: (id) => ({ getId: () => id }) },
  Calendar: { Events: { insert: () => { throw new Error('Calendar must stay stubbed'); } } },
  Logger: { log: () => {} },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  UrlFetchApp: { fetch: () => { throw new Error('network must not be called'); } },
  GmailApp: { sendEmail: () => { throw new Error('mail must not be called'); } },
  MailApp: { sendEmail: () => { throw new Error('MailApp must not be called'); } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }), deleteTrigger: () => {} },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (value) => ({ value, setMimeType() { return this; } }) },
};
vm.createContext(context);
for (const source of sources) vm.runInContext(source, context);

const compat = context.__COMPATIBILITY_TEST_EXPORTS__;
const phase = context.__PHASE_A_TEST_EXPORTS__;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

check(compat.SCHEMA_MIGRATION_STRATEGY === 'APPEND_ONLY_V7_COMPATIBILITY', 'schema strategy is append-only v7 compatibility');
check(compat.PRODUCTION.sheetName === 'Respuestas de formulario 1', 'canonical sheet name is recovered v7 name');
check(compat.PRODUCTION.equivalentSheetNames.includes('reservations'), 'reservations remains an equivalent existing sheet alias');

const snapshotRows = bookingSheet._rows.map((row) => row.slice());
const snapshotHeaders = bookingSheet._headers.slice();
const dry = compat.productionSchemaMigrationDryRun_({ config: phase.readConfig_(), resources: { spreadsheet, sheet: bookingSheet } });
check(dry.ok && dry.writes === 0 && dry.kind === 'v7_compat', 'MIGRATION_DRY_RUN reports v7 schema without writes');
check(dry.rowCount === 7 && dry.headerCount === englishV7Headers.length, 'dry-run counts headers/rows only');
check(!JSON.stringify(dry).includes('legacy@example.test'), 'dry-run metadata contains no row PII');
check(bookingSheet._headers.join('\u0001') === snapshotHeaders.join('\u0001'), 'dry-run does not mutate headers');
check(JSON.stringify(bookingSheet._rows) === JSON.stringify(snapshotRows), 'dry-run does not mutate rows');

const expectedAppended = phase.HEADERS.filter((header) => !englishV7Headers.includes(header));
const first = compat.migrateProductionV7SchemaToLifecycleV2_({ config: phase.readConfig_(), resources: { spreadsheet, sheet: bookingSheet } });
check(first.ok && first.appendedCount === expectedAppended.length, 'MIGRATION_FIRST_RUN_SYNTHETIC appends missing V2 columns');
check(bookingSheet._headers.slice(0, englishV7Headers.length).join('\u0001') === englishV7Headers.join('\u0001'),
  'exact old-column order is preserved');
check(JSON.stringify(bookingSheet._rows.map((row) => row.slice(0, englishV7Headers.length))) === JSON.stringify(snapshotRows),
  'LEGACY_ROWS_PRESERVED exact old cells');
check(phase.HEADERS.every((header) => bookingSheet._headers.includes(header)), 'V2 columns are appended');

const second = compat.migrateProductionV7SchemaToLifecycleV2_({ config: phase.readConfig_(), resources: { spreadsheet, sheet: bookingSheet } });
check(second.ok && second.idempotent && second.appendedCount === 0
  && second.headerFingerprintAfter === first.headerFingerprintAfter,
  'MIGRATION_SECOND_RUN_IDEMPOTENT');

const schema = compat.assertSchema_(bookingSheet);
check(schema.kind === 'v7_compat', 'migrated schema remains v7_compat extended');
const records = context.reservationRecords_(bookingSheet, schema);
const byId = Object.fromEntries(records.map((record) => [record.reservation_id, record]));
check(byId['legacy-active'].booking_status === 'confirmed' && byId['legacy-active'].payment_status === 'paid'
  && byId['legacy-active'].meet_url.includes('legacy-meet') && byId['legacy-active'].calendar_event_id === 'legacy-cal-event-1'
  && phase.reservationOccupiesSlot_(byId['legacy-active']) === true,
  'EXISTING_ACTIVE_BOOKINGS_COMPATIBILITY active occupies capacity and keeps Meet/calendar ids');
check(byId['legacy-pending'].booking_status === 'payment_pending' && byId['legacy-pending'].payment_status === 'pending',
  'pending_payment remains readable');
check(byId['legacy-paid'].booking_status === 'confirmed' && byId['legacy-paid'].payment_status === 'paid'
  && byId['legacy-paid'].commerce_order === 'FB-20260907-1000-1111',
  'paid_confirmed preserves payment history');
check(byId['legacy-rejected'].booking_status === 'payment_pending' && byId['legacy-rejected'].payment_status === 'rejected',
  'payment_rejected remains readable');
check(byId['legacy-review'].booking_status === 'manual_review', 'payment_review_required remains readable');
check(byId['legacy-rescheduled'].booking_status === 'cancelled'
  && byId['legacy-rescheduled'].replaced_by_reservation_id === 'legacy-active'
  && phase.reservationOccupiesSlot_(byId['legacy-rescheduled']) === false,
  'rescheduled legacy row does not occupy capacity');
check(byId['legacy-cancelled'].booking_status === 'cancelled' && byId['legacy-cancelled'].cancelled_at
  && phase.reservationOccupiesSlot_(byId['legacy-cancelled']) === false,
  'cancelled legacy row remains cancelled');
check(compat.isLegacyV7ManageToken_(byId['legacy-active'].manage_token)
  && byId['legacy-active'].manage_token === '11111111-2222-4333-8444-555555555555',
  'v7 manageToken UUID is preserved');

const gateway = {
  isSlotAvailable: () => true,
};
const created = context.reserveOnce_(bookingSheet, schema, {
  idempotencyKey: 'fran-booking-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  serviceType: 'followup', modality: 'online', email: 'new@example.test', date: '2026-09-08', time: '10:00',
}, gateway);
check(created.ok && created.booking_status === 'initiated' && created.current_end_at === phase.sessionEndAt_(created.current_start_at),
  'NEW_BOOKING_V2_SCHEMA_TESTS uses canonical extended schema and 50-minute end');
const createdRecord = context.findBy_(bookingSheet, schema, 'reservation_id', created.reservation_id);
check(createdRecord.patient_email === 'new@example.test' && createdRecord.service_type === 'followup',
  'new V2 booking is readable on the extended sheet');

check(context.inspectOutboxSchema_(spreadsheet).ready === true, 'OUTBOX_SCHEMA_TESTS outbox created/recognized independently');

const ambiguous = makeSheet(['idempotency_key', 'extra'], [['a', 'b']]);
assert.throws(() => compat.inspectReservationSchema_(ambiguous), /SCHEMA_MISMATCH/);
assertions += 1;
const unexpected = makeSheet(['foo', 'bar', 'baz', 'qux', 'quux', 'corge', 'grault', 'garply', 'waldo', 'fred', 'plugh', 'xyzzy', 'thud', 'alpha', 'beta', 'gamma'], [Array(16).fill('x')]);
assert.throws(() => compat.inspectReservationSchema_(unexpected), /SCHEMA_MISMATCH/);
assertions += 1;

const spanishSheet = makeSheet(spanishV7Headers, [v7Row({ reservationId: 'legacy-spanish', status: 'active' })]);
const spanishInspect = compat.inspectReservationSchema_(spanishSheet);
check(spanishInspect.kind === 'v7_compat', 'Spanish recovered v7 aliases are recognized');

console.log(`SCHEMA_COMPATIBILITY_TESTS=PASS assertions=${assertions}`);
console.log('MIGRATION_DRY_RUN=PASS');
console.log('MIGRATION_FIRST_RUN_SYNTHETIC=PASS');
console.log('MIGRATION_SECOND_RUN_IDEMPOTENT=PASS');
console.log('LEGACY_ROWS_PRESERVED=PASS');
console.log('EXISTING_ACTIVE_BOOKINGS_COMPATIBILITY=PASS');
console.log('ACTIVE_BOOKING_COMPATIBILITY_TESTS=PASS');
console.log('NEW_BOOKING_V2_SCHEMA_TESTS=PASS');
console.log('OUTBOX_SCHEMA_TESTS=PASS');
console.log('RC_SCHEMA_COMPATIBILITY=PASS');
console.log('MIGRATION_DRY_RUN_IMPLEMENTED=YES');
console.log('MIGRATION_IDEMPOTENT_IMPLEMENTED=YES');
console.log('LEGACY_V7_ADAPTER_IMPLEMENTED=YES');
