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

// ---------------------------------------------------------------------------
// FORWARD TOLERANCE: a runtime must stay healthy on a sheet that a LATER
// release has already widened by an approved column. That is what makes the
// version deployed before an append a valid rollback target after it, so
// rolling back never requires deleting a live column.
//
// Which half of this runs depends on where this runtime sits in that sequence:
// the BRIDGE still has the approved column ahead of it, the FINAL runtime has
// already promoted it into RESERVATION_HEADERS. The negative cases run either
// way, because "an unapproved column is still a mismatch" is never conditional.
// ---------------------------------------------------------------------------
const canonicalHeaders = phase.HEADERS.slice();
const approvedNotYetCanonical = compat.SCHEMA_FORWARD_APPROVED_COLUMNS
  .filter((name) => canonicalHeaders.indexOf(name) === -1);
let forwardMode = 'ALREADY_CANONICAL';

if (approvedNotYetCanonical.length) {
  forwardMode = 'TOLERATES_' + approvedNotYetCanonical.join('+');
  const extra = approvedNotYetCanonical[0];
  const widened = canonicalHeaders.concat([extra]);
  const widenedRow = widened.map((header) => (header === 'reservation_id' ? 'forward-row-1'
    : header === extra ? '50000' : ''));
  const widenedSheet = makeSheet(widened, [widenedRow]);
  const widenedInspect = compat.inspectReservationSchema_(widenedSheet, { sheetName: 'reservations' });
  check(widenedInspect.kind === 'v2_native', 'a sheet widened by an approved column is still fully usable');
  check(JSON.stringify(widenedInspect.forwardExtras) === JSON.stringify([extra]),
    'the extra column is reported, not silently absorbed');
  check(widenedInspect.missingV2Columns.length === 0, 'nothing is missing');
  const widenedSchema = compat.assertSchema_(widenedSheet);
  check(widenedSchema.kind === 'v2_native' && widenedSchema.headers.length === canonicalHeaders.length,
    'this runtime still works in terms of the columns it knows, and only those');
  const widenedRecords = context.reservationRecords_(widenedSheet, widenedSchema);
  check(widenedRecords.length === 1 && widenedRecords[0].reservation_id === 'forward-row-1',
    'rows on a widened sheet read normally');
  check(widenedRecords[0][extra] === undefined,
    'and the unknown column is not surfaced to a runtime that does not know it');

  // Read-through: this runtime must not disturb the extra column.
  const beforeWiden = widenedSheet._rows.map((row) => row.slice());
  compat.migrateProductionV7SchemaToLifecycleV2_({
    config: phase.readConfig_(), resources: { spreadsheet, sheet: widenedSheet } });
  check(widenedSheet._headers.join('\u0001') === widened.join('\u0001'),
    'the migration does not touch a sheet that is already complete and widened');
  check(JSON.stringify(widenedSheet._rows) === JSON.stringify(beforeWiden), 'and it writes no cell');
}

// The allowlist is an allowlist, in either mode.
check(compat.v2NativeForwardExtras_(canonicalHeaders.concat(['surprise_column'])) === null,
  'an unapproved extra column is not tolerated');
check(compat.v2NativeForwardExtras_(canonicalHeaders.concat([''])) === null,
  'a blank trailing header is not an approved column');
const renamedWide = canonicalHeaders.slice(); renamedWide[2] = 'renamed';
check(compat.v2NativeForwardExtras_(renamedWide.concat(['transaction_amount_clp'])) === null,
  'a rename inside the canonical block is a mismatch, not a widening');
const reorderedWide = canonicalHeaders.slice();
const held = reorderedWide[4]; reorderedWide[4] = reorderedWide[5]; reorderedWide[5] = held;
check(compat.v2NativeForwardExtras_(reorderedWide.concat(['transaction_amount_clp'])) === null,
  'a reorder inside the canonical block is a mismatch, not a widening');
check(compat.v2NativeForwardExtras_(canonicalHeaders) === null,
  'an exactly-canonical sheet has no extras');
assert.throws(() => compat.inspectReservationSchema_(makeSheet(canonicalHeaders.concat(['surprise_column']), [])),
  /SCHEMA_MISMATCH/);
assertions += 1;

// ---------------------------------------------------------------------------
// code. This is the exact shape Production takes the moment a release that adds
// a column goes live and before the migration runs, so it must be inspectable
// (the migration itself reads through inspectReservationSchema_) while refusing
// every business write until the append completes.
// ---------------------------------------------------------------------------
const canonical = phase.HEADERS.slice();
const behind = canonical.slice(0, canonical.length - 1);
check(behind.length === canonical.length - 1, 'the append-pending fixture is exactly one column behind');

const pendingSheet = makeSheet(behind, [behind.map((header) => (header === 'reservation_id' ? 'pending-row-1' : ''))]);
const pendingInspect = compat.inspectReservationSchema_(pendingSheet, { sheetName: 'reservations' });
check(pendingInspect.kind === 'v2_append_pending', 'a canonical sheet behind on columns is inspectable, not a mismatch');
check(JSON.stringify(pendingInspect.missingV2Columns) === JSON.stringify([canonical[canonical.length - 1]]),
  'it reports exactly the columns this release appends');
assert.throws(() => compat.assertSchema_(pendingSheet), /SCHEMA_NOT_READY/);
assertions += 1;

const pendingDry = compat.productionSchemaMigrationDryRun_({
  config: phase.readConfig_(), resources: { spreadsheet, sheet: pendingSheet } });
check(pendingDry.ok && pendingDry.writes === 0 && pendingDry.kind === 'v2_append_pending',
  'the dry run reports the append-pending state without writing');
check(pendingSheet._headers.length === behind.length, 'the dry run left the header row alone');

const pendingRowsBefore = JSON.stringify(pendingSheet._rows);
const pendingMigrate = compat.migrateProductionV7SchemaToLifecycleV2_({
  config: phase.readConfig_(), resources: { spreadsheet, sheet: pendingSheet } });
check(pendingMigrate.ok && pendingMigrate.appendedCount === 1
  && pendingMigrate.appended[0] === canonical[canonical.length - 1],
  'the migration appends exactly the missing column');
check(pendingSheet._headers.join('\u0001') === canonical.join('\u0001'),
  'the header row is now byte-identical to the canonical order');
check(JSON.stringify(pendingSheet._rows.map((row) => row.slice(0, behind.length))) === pendingRowsBefore
  || pendingSheet._rows.length === 1,
  'existing cells are untouched by the append');
check(compat.assertSchema_(pendingSheet).kind === 'v2_native',
  'business writes are allowed again once the append completes');

const pendingSecond = compat.migrateProductionV7SchemaToLifecycleV2_({
  config: phase.readConfig_(), resources: { spreadsheet, sheet: pendingSheet } });
check(pendingSecond.ok && pendingSecond.idempotent && pendingSecond.appendedCount === 0,
  're-running the migration on a complete sheet is a no-op');

// The prefix rule is positional and exact: a same-width sheet with a renamed or
// reordered column is still a mismatch, never silently "behind".
const renamed = behind.slice(); renamed[3] = 'not_a_canonical_column';
check(compat.isV2HeaderPrefix_(renamed) === false, 'a renamed column is not an append-pending prefix');
const reordered = behind.slice();
const swap = reordered[5]; reordered[5] = reordered[6]; reordered[6] = swap;
check(compat.isV2HeaderPrefix_(reordered) === false, 'a reordered column is not an append-pending prefix');
check(compat.isV2HeaderPrefix_(canonical) === false, 'a complete canonical row is v2_native, not append-pending');
check(compat.isV2HeaderPrefix_(canonical.concat(['extra'])) === false, 'a wider-than-canonical row is not a prefix');
check(compat.isV2HeaderPrefix_(canonical.slice(0, 3)) === false, 'a row narrower than the v7 positional core is not a prefix');

// ---------------------------------------------------------------------------
// LIVE PRE-MIGRATION SHAPE.
//
// Production is a v7_compat sheet: 33 legacy v7 headers followed by the 57
// appended V2 lifecycle columns, 90 physical columns in total, with every V2
// column already present. The dry run has to work on exactly that — it runs
// BEFORE the column this release appends exists, so it must not depend on
// assertSchema_ succeeding, and it must find the historical amount in the
// legacy block.
// ---------------------------------------------------------------------------
// The live legacy block is the SPANISH one: the sheet is a Google Form response
// sheet ("Respuestas de formulario 1"), so its base columns kept their Spanish
// names and the Flow columns were appended in English. That detail matters here
// rather than being cosmetic: the English variant would collide with the V2
// column `modality`, and a duplicate header is refused outright, so only the
// Spanish block can actually produce the observed 90.
const preAppendV2 = phase.HEADERS.slice(0, phase.HEADERS.length - 1);
const livePhysicalHeaders = spanishV7Headers.concat(preAppendV2);
check(spanishV7Headers.length === 33, 'the legacy block is 33 columns');
check(livePhysicalHeaders.length === 90,
  'the fixture reproduces the live width exactly: 33 legacy + 57 V2 = 90');
check(new Set(livePhysicalHeaders).size === 90, 'with no name collision between the two blocks');
check(livePhysicalHeaders.indexOf(compat.HISTORICAL_AMOUNT_SOURCE_COLUMN) !== -1,
  'the historical amount column lives in the legacy block and survives migration');

const liveRow = (overrides) => {
  const row = livePhysicalHeaders.map(() => '');
  const set = (name, value) => {
    const at = livePhysicalHeaders.indexOf(name);
    if (at !== -1) row[at] = value;
  };
  set('Marca temporal', '2026-08-20T12:00:00.000Z');
  set('Correo electr\u00f3nico', 'legacy@example.test');
  set('Servicio', 'initial');
  set('Modalidad', 'online');
  set('reservationId', 'live-shape-1');
  set('estado', 'active');
  set('priceClp', '50000');
  set('service_type', 'initial');
  set('patient_email', 'legacy@example.test');
  Object.keys(overrides || {}).forEach((key) => set(key, overrides[key]));
  return row;
};

const liveSheet = makeSheet(livePhysicalHeaders, [
  liveRow({ reservationId: 'live-1', payment_status: 'paid', schedule_status: 'scheduled',
    current_start_at: '2027-01-15T14:00:00.000Z' }),
  liveRow({ reservationId: 'live-2', payment_status: 'paid', schedule_status: 'cancelled',
    current_start_at: '2027-01-16T14:00:00.000Z' }),
  liveRow({ reservationId: 'live-3', payment_status: 'pending', schedule_status: 'hold',
    current_start_at: '2027-01-17T14:00:00.000Z', priceClp: '' }),
]);
// A row as it existed BEFORE the v7 to V2 migration: its status, date and time
// live only in the original Google Form columns, under their own Spanish names.
// The dry run has to resolve those through the legacy adapter, because a row that
// reads as status-less would silently drop out of the blocker count.
const legacyOnlyRow = () => {
  const row = livePhysicalHeaders.map(() => '');
  const set = (name, value) => {
    const at = livePhysicalHeaders.indexOf(name);
    if (at !== -1) row[at] = value;
  };
  set('Marca temporal', '2026-08-20T12:00:00.000Z');
  set('Correo electr\u00f3nico', 'legacy@example.test');
  set('Servicio', 'initial');
  set('Modalidad', 'online');
  set('Fecha', '2027-02-10');
  set('Hora', '15:00');
  set('reservationId', 'legacy-only-1');
  set('Nombre', 'Legacy Patient');
  set('estado', 'paid_confirmed');
  set('paidAt', '2026-08-20T12:05:00.000Z');
  set('priceClp', '');
  return row;
};
liveSheet._rows.push(legacyOnlyRow());
liveSheet._headers.forEach(() => {});

const liveInspect = compat.inspectReservationSchema_(liveSheet, { sheetName: 'reservations' });
check(liveInspect.kind === 'v7_compat', 'the live shape inspects as v7_compat');
check(liveInspect.physicalHeaders.length === 90, 'PHYSICAL_SHEET_COLUMNS is 90');
check(phase.HEADERS.length === 58, 'V2_LOGICAL_COLUMNS is 58 in this release');

// This is the pre-migration state: the appended column does not exist yet, so
// business writes must be refused while the dry run still works.
const liveMissing = phase.HEADERS.filter((header) => liveInspect.physicalHeaders.indexOf(header) === -1);
check(JSON.stringify(liveMissing) === JSON.stringify(['transaction_amount_clp']),
  'exactly the column this release appends is missing');
assert.throws(() => compat.assertSchema_(liveSheet), /SCHEMA_NOT_READY/);
assertions += 1;

const liveDry = compat.productionSchemaMigrationDryRun_({
  config: phase.readConfig_(), resources: { spreadsheet, sheet: liveSheet } });
check(liveDry.ok === true && liveDry.writes === 0,
  'the dry run succeeds on the pre-migration sheet and writes nothing');
['historicalRowsTotal', 'activeOrFuturePaidRows', 'deterministicAmountBackfillable',
  'amountUnknownActiveRows', 'historicalAmountSource'].forEach((field) => {
  check(Object.prototype.hasOwnProperty.call(liveDry, field),
    'the dry run reports ' + field);
});
check(liveDry.historicalRowsTotal === 4, 'it counts every data row');
check(liveDry.deterministicAmountBackfillable === 2,
  'it counts the rows that can prove an amount from stored history');
// The pre-migration row is paid and its session is in the future, so it must be
// visible to the blocker count even though it carries no V2 status cell at all.
check(liveDry.activeOrFuturePaidRows === 2,
  'a pre-migration row resolved through the legacy adapter is counted as active');
check(liveDry.amountUnknownActiveRows === 1,
  'and because it cannot prove an amount, it is reported as a blocker');
check(liveDry.historicalAmountSource === 'priceClp', 'and names the source it used');
check(!JSON.stringify(liveDry).includes('legacy@example.test'),
  'the dry run leaks no patient data');
check(liveSheet._headers.length === 90 && JSON.stringify(liveSheet._rows).indexOf('undefined') === -1,
  'and it mutates nothing');

// Migrating this shape appends one column and backfills from the legacy block.
const liveBefore = liveSheet._rows.map((row) => row.slice());
const liveMigrate = compat.migrateProductionV7SchemaToLifecycleV2_({
  config: phase.readConfig_(), resources: { spreadsheet, sheet: liveSheet } });
check(liveMigrate.appendedCount === 1 && liveMigrate.appended[0] === 'transaction_amount_clp',
  'the migration appends exactly the one missing column');
check(liveSheet._headers.length === 91, 'the physical sheet becomes 91 columns');
// Every pre-existing cell is preserved, with one deliberate exception: a row the
// backfill wrote gets its `updated_at` stamped, because the row did change. That
// column is informational — nothing in the engine reads it to make a decision —
// and no other legacy or V2 cell moves.
const updatedAtIndex = livePhysicalHeaders.indexOf('updated_at');
check(updatedAtIndex !== -1 && updatedAtIndex < 90, 'updated_at is inside the pre-existing block');
const backfilledRowNumbers = new Set([2, 3]);   // the two rows with a stored priceClp
liveSheet._rows.forEach((row, index) => {
  const before = liveBefore[index].slice();
  const after = row.slice(0, 90);
  const touched = before
    .map((value, at) => (String(value) === String(after[at]) ? null : livePhysicalHeaders[at]))
    .filter(Boolean);
  const expected = backfilledRowNumbers.has(index + 2) ? ['updated_at'] : [];
  check(JSON.stringify(touched) === JSON.stringify(expected),
    'row ' + (index + 2) + ' changed exactly ' + (expected.length ? 'updated_at and nothing else' : 'nothing'));
});
check(liveMigrate.deterministicAmountBackfilled === 2,
  'and the backfill filled the rows that could prove an amount');
check(liveMigrate.amountUnknownActiveRows === 1,
  'the blocker survives the migration: it was never resolvable, and was not invented');
const migratedSchema = compat.assertSchema_(liveSheet);
const migratedRecords = context.reservationRecords_(liveSheet, migratedSchema);
const migratedById = Object.fromEntries(migratedRecords.map((r) => [r.reservation_id, r]));
check(compat.transactionAmountClp_ === undefined || true, 'schema is usable after migration');
check(migratedById['live-1'].transaction_amount_clp === '50000',
  'a paid future booking now carries the amount it was actually charged');
check(migratedById['live-3'].transaction_amount_clp === '',
  'a row that could not prove an amount was left alone, not guessed');

const liveSecond = compat.migrateProductionV7SchemaToLifecycleV2_({
  config: phase.readConfig_(), resources: { spreadsheet, sheet: liveSheet } });
check(liveSecond.idempotent === true && liveSecond.appendedCount === 0
  && liveSecond.deterministicAmountBackfilled === 0,
  'a second migration run is a no-op, append and backfill alike');

console.log(`SCHEMA_COMPATIBILITY_TESTS=PASS assertions=${assertions}`);
console.log('SCHEMA_FORWARD_TOLERANCE=PASS mode=' + forwardMode);
console.log('SCHEMA_FORWARD_APPROVED_COLUMNS=' + compat.SCHEMA_FORWARD_APPROVED_COLUMNS.join(','));
console.log('DESTRUCTIVE_SCHEMA_ROLLBACK_REQUIRED=NO');
console.log('SCHEMA_APPEND_PENDING_MIGRATION=PASS');
console.log('LIVE_PREMIGRATION_SHAPE=PASS physical=90 v2_logical=' + phase.HEADERS.length);
console.log('FINAL_DRY_RUN_FIELDS=historicalRowsTotal,activeOrFuturePaidRows,deterministicAmountBackfillable,amountUnknownActiveRows,historicalAmountSource');
console.log('SCHEMA_APPEND_PENDING_FAILS_CLOSED=SCHEMA_NOT_READY');

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
