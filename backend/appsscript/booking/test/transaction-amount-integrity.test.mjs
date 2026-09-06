/**
 * TRANSACTION AMOUNT INTEGRITY.
 *
 * Two numbers that used to be one:
 *
 *   CATALOG price      what a NEW order costs today   — consultationAmountClp_
 *   TRANSACTION amount what THIS reservation actually committed to, frozen at
 *                      order creation — column 58, transaction_amount_clp
 *
 * Before this change every money-bearing read (payment/create, payment-status,
 * the confirmation email, refund/create) re-derived the amount from the live
 * catalog, so moving the catalog silently rewrote the money of orders that were
 * already paid. This suite pins the separation and requires deliberately broken
 * builds to be detected.
 *
 * Deterministic: no network, no mail, no Flow, no clock read.
 */
import assert from 'node:assert/strict';
import { buildHarness, DAY_MS } from './helpers/policy-harness.mjs';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

// Rewrite the catalog constants in BOTH files: Lifecycle.js re-declares them
// after Code.js, so patching one alone leaves the other binding in force.
const catalogAt = (clp) => ({
  'Code.js': [['var INITIAL_PRICE_CLP = 50000;', 'var INITIAL_PRICE_CLP = ' + clp + ';'],
    ['var FOLLOWUP_PRICE_CLP = 50000;', 'var FOLLOWUP_PRICE_CLP = ' + clp + ';']],
  'Lifecycle.js': [['var INITIAL_PRICE_CLP = 50000;', 'var INITIAL_PRICE_CLP = ' + clp + ';'],
    ['var FOLLOWUP_PRICE_CLP = 50000;', 'var FOLLOWUP_PRICE_CLP = ' + clp + ';']],
});

/** Move the running catalog without touching anything already persisted. */
const moveCatalog = (h, clp) => {
  h.context.INITIAL_PRICE_CLP = clp;
  h.context.FOLLOWUP_PRICE_CLP = clp;
  check(h.context.consultationAmountClp_('initial') === clp
    && h.context.consultationAmountClp_('followup') === clp,
    'catalog moved to ' + clp + ' for both service types');
};

const emailFor = (h, record, eventType) => {
  const input = { notification: { eventType: eventType, meet: null }, record: record,
    capabilityTokens: {}, previewOrigin: 'https://franciscabustos.cl' };
  return { html: h.context.renderLifecycleEmailHtml_(input), text: h.context.renderLifecycleEmailText_(input) };
};

// ---------------------------------------------------------------------------
// Schema: append-only, column 58.
// ---------------------------------------------------------------------------
const base = buildHarness(null);
const headers = base.phase.HEADERS;
check(headers.length === 58, 'schema is 58 columns after the append-only addition');
check(headers[headers.length - 1] === 'transaction_amount_clp',
  'transaction_amount_clp is appended last, never inserted');
check(new Set(headers).size === headers.length, 'no duplicate column names');
['reservation_id', 'commerce_order', 'payment_status', 'refund_status', 'created_at', 'updated_at']
  .forEach((column) => check(headers.indexOf(column) !== -1 && headers.indexOf(column) < headers.length - 1,
    'pre-existing column "' + column + '" keeps its position ahead of the appended one'));

// ---------------------------------------------------------------------------
// The three accessors, in isolation.
// ---------------------------------------------------------------------------
const ctx = base.context;
check(ctx.consultationAmountClp_('initial') === 50000 && ctx.consultationAmountClp_('followup') === 50000,
  'catalog price is 50000 for both service types');
check(ctx.transactionAmountClp_({ transaction_amount_clp: '500' }) === 500
  && ctx.transactionAmountClp_({ transaction_amount_clp: '50000' }) === 50000,
  'transactionAmountClp_ reads the persisted amount');
['', undefined, null, 'abc', '0', '-500', '12.5', ' ', '1234567890'].forEach((value) => {
  check(ctx.transactionAmountClp_({ transaction_amount_clp: value }) === null,
    'transactionAmountClp_ reports UNKNOWN for unusable "' + String(value) + '"');
});
check(ctx.transactionAmountClp_({}) === null && ctx.transactionAmountClp_(null) === null,
  'a record with no column at all is unknown, not a price');
check(ctx.displayAmountClp_({ transaction_amount_clp: '500', service_type: 'initial' }) === 500,
  'display prefers the bound amount over the catalog');
check(ctx.displayAmountClp_({ service_type: 'initial' }) === 50000,
  'display falls back to the catalog ONLY for a legacy row with no bound amount');

// ---------------------------------------------------------------------------
// A. Created and paid at 500. The catalog later moves to 50000.
//    Status, both email renderings and the refund must all stay 500.
// ---------------------------------------------------------------------------
const a = buildHarness(catalogAt(500));
const aBooking = a.paidBooking(70, '2026-09-24', '11:00', 10 * DAY_MS);
check(a.rowFor(70).transaction_amount_clp === '500',
  'A: order creation froze the then-current catalog price onto the reservation');
check(a.state.lastRefundPayload === null, 'A: nothing has been refunded yet');
moveCatalog(a, 50000);

const aRow = () => a.rowFor(70);
check(a.context.displayAmountClp_(aRow()) === 500,
  'A: payment-status still reports 500 after the catalog moved to 50000');
const aMail = emailFor(a, aRow(), 'BOOKING_CONFIRMED');
check(aMail.html.includes('$500') && aMail.text.includes('Valor: $500'),
  'A: the confirmation email still shows $500');
check(!aMail.html.includes('$50.000') && !aMail.text.includes('$50.000'),
  'A: the confirmation email never shows the new catalog price');
check(a.context.transactionAmountClp_(aRow()) === 500,
  'A: refund authority is still the bound 500');

const aStart = Date.parse(aRow().current_start_at);
a.setNow(aStart - 3 * DAY_MS);
a.context.patientCancel_({ postData: { contents: JSON.stringify({ token: aBooking.cancel }) } });
check(a.state.refundCreateCalls === 1, 'A: exactly one refund/create');
check(a.state.lastRefundPayload.amount === '500',
  'A: the refund asked Flow for 500, not the 50000 the catalog now says');

// ---------------------------------------------------------------------------
// B. Paid at 50000. The catalog later drops to 500. The refund stays 50000.
// ---------------------------------------------------------------------------
const b = buildHarness(null);
const bBooking = b.paidBooking(71, '2026-09-24', '12:00', 10 * DAY_MS);
check(b.rowFor(71).transaction_amount_clp === '50000', 'B: bound at the 50000 catalog price');
moveCatalog(b, 500);
check(b.context.displayAmountClp_(b.rowFor(71)) === 50000,
  'B: payment-status still reports 50000 after the catalog dropped');
const bMail = emailFor(b, b.rowFor(71), 'BOOKING_CONFIRMED');
check(bMail.html.includes('$50.000') && !bMail.html.includes('>$500<'),
  'B: the confirmation email still shows $50.000');
const bStart = Date.parse(b.rowFor(71).current_start_at);
b.setNow(bStart - 3 * DAY_MS);
b.context.patientCancel_({ postData: { contents: JSON.stringify({ token: bBooking.cancel }) } });
check(b.state.refundCreateCalls === 1, 'B: exactly one refund/create');
check(b.state.lastRefundPayload.amount === '50000',
  'B: the refund asked Flow for 50000, not the 500 the catalog now says');

// A and B ran against catalogs that ended up swapped, yet each kept its own
// money. That is only possible because the amount is bound per transaction.
check(a.state.lastRefundPayload.amount !== b.state.lastRefundPayload.amount,
  'A and B refund different amounts under mirrored catalog moves');

// ---------------------------------------------------------------------------
// C. The provider says a different amount than the reservation bound.
//    No confirmation, no Calendar/Meet, no patient email.
// ---------------------------------------------------------------------------
const match = ctx.providerAmountMatchesTransaction_;
const bound = (clp) => ({ service_type: 'initial', transaction_amount_clp: String(clp) });
check(match(bound(500), { amount: 500, currency: 'CLP' }).ok === true, 'C: an exact match reconciles');
check(match(bound(500), { amount: '500', currency: 'clp' }).ok === true,
  'C: a string amount and a lowercase currency still reconcile — case is presentation');
check(match(bound(500), { amount: 500, currency: ' CLP ' }).ok === true,
  'C: surrounding whitespace on the currency is presentation too');

// The currency must be STATED. Silence is not CLP.
[undefined, null, '', '   '].forEach((value) => check(
  match(bound(500), { amount: 500, currency: value }).code === 'PROVIDER_CURRENCY_UNREADABLE',
  'C: an absent or blank currency fails closed, it is never assumed to be CLP ("' + String(value) + '")'));
check(match(bound(500), { amount: 500 }).code === 'PROVIDER_CURRENCY_UNREADABLE',
  'C: a response with no currency field at all fails closed');
['USD', 'EUR', 'ARS', 'CLF'].forEach((value) => check(
  match(bound(500), { amount: 500, currency: value }).code === 'PROVIDER_CURRENCY_MISMATCH',
  'C: ' + value + ' is refused'));

[[50000, 'the catalog price instead of the bound amount'], [499, 'one peso short'], [501, 'one peso over']]
  .forEach(([amount, why]) => check(match(bound(500), { amount, currency: 'CLP' }).code === 'PROVIDER_AMOUNT_MISMATCH',
    'C: provider ' + amount + ' is refused (' + why + ')'));

// CLP has no minor unit, so a fractional amount is not a CLP amount and must
// never be rounded into agreement.
[500.4, 500.5, 499.6, '500.4', '499.5'].forEach((value) => check(
  match(bound(500), { amount: value, currency: 'CLP' }).code === 'PROVIDER_AMOUNT_UNREADABLE',
  'C: a fractional provider amount is refused rather than rounded (' + String(value) + ')'));
check(match(bound(500), { amount: 500.0, currency: 'CLP' }).ok === true,
  'C: an exact integer expressed as 500.0 is still 500');

['', null, undefined, 'abc', 0, -1, '  ', {}, []].forEach((value) => check(
  match(bound(500), { amount: value, currency: 'CLP' }).code === 'PROVIDER_AMOUNT_UNREADABLE',
  'C: an unreadable provider amount fails closed ("' + String(value) + '")'));
check(match({ service_type: 'initial' }, { amount: 50000, currency: 'CLP' }).code === 'TRANSACTION_AMOUNT_UNKNOWN',
  'C: a legacy row with no bound amount fails closed even when the provider looks right');
check(match(bound(500), null).code === 'PROVIDER_AMOUNT_UNREADABLE',
  'C: no provider status at all fails closed');

// End to end through the real webhook: the provider confirms a DIFFERENT amount.
const c = buildHarness(null);
c.setNow(Date.parse(c.phase.startAt_('2026-09-24', '15:00')) - 10 * DAY_MS);
const cCreated = c.context.createFlowPayment_({ postData: { contents: JSON.stringify({
  action: 'create_flow_payment', idempotencyKey: 'fran-booking-bbbbbb72-e89b-12d3-a456-426614174000',
  serviceType: 'initial', modality: 'online', date: '2026-09-24', time: '15:00',
  name: 'Synthetic', email: 'paciente@example.test', phone: '', patientRut: '', reason: '', message: '',
}) } });
check(cCreated.ok === true, 'C: the reservation was created');
const cRow = () => c.currentRows().find((row) => row.reservation_id === c.currentRows()[0].reservation_id);
check(cRow().transaction_amount_clp === '50000', 'C: bound at 50000');
c.state.flowByToken.get(cRow().flow_token).status = 2;
c.state.providerAmountOverride = 1;          // provider settled ONE peso
c.state.mail.length = 0;
const cConfirm = c.context.flowConfirmation_({ parameter: { token: cRow().flow_token } });
check(cConfirm.ok === false && cConfirm.code === 'PROVIDER_AMOUNT_MISMATCH',
  'C: the webhook refuses the confirmation on an amount mismatch');
check(cRow().booking_status === 'manual_review', 'C: the booking is parked for a human');
check(cRow().reconciliation_state === 'PROVIDER_AMOUNT_MISMATCH', 'C: the reason is recorded');
check(cRow().payment_status !== 'paid', 'C: payment was never marked paid');
check(!cRow().calendar_event_id, 'C: no Calendar event was created');
c.drain();
check(c.state.mail.filter((m) => String(m.subject).startsWith('Tu sesión está confirmada')).length === 0,
  'C: no confirmation email reached the patient');

// The refusal is idempotent: Flow retries the webhook, and each retry lands on
// the same verdict without a second parking write or any side effect.
const cReplay = c.context.flowConfirmation_({ parameter: { token: cRow().flow_token } });
check(cReplay.ok === false && cReplay.code === 'PROVIDER_AMOUNT_MISMATCH',
  'C: a webhook retry reaches the same verdict');
check(cRow().payment_status !== 'paid' && !cRow().calendar_event_id,
  'C: the retry produced no side effect either');

// And a later callback that DOES agree cannot resurrect it: manual_review is a
// human's decision to make, not something a provider message reverses.
c.state.providerAmountOverride = null;
let resurrected = null;
try { resurrected = c.context.flowConfirmation_({ parameter: { token: cRow().flow_token } }); }
catch (error) { resurrected = { threw: String(error && error.code) }; }
check(resurrected.threw === 'INVALID_STATE_TRANSITION' || resurrected.ok !== true,
  'C: a parked reservation is never auto-confirmed by a later agreeing callback');
check(cRow().booking_status === 'manual_review', 'C: it is still parked');
check(c.state.mail.filter((m) => String(m.subject).startsWith('Tu sesi\u00f3n est\u00e1 confirmada')).length === 0,
  'C: still no confirmation email');

// ---------------------------------------------------------------------------
// D. A legacy row with no persisted amount must never produce a guessed refund.
// ---------------------------------------------------------------------------
const d = buildHarness(null);
const dBooking = d.paidBooking(73, '2026-09-24', '16:00', 10 * DAY_MS);
d.rowFor(73).transaction_amount_clp = '';    // as a pre-migration row reads
check(d.context.displayAmountClp_(d.rowFor(73)) === 50000,
  'D: display still renders something for a legacy row');
check(d.context.transactionAmountClp_(d.rowFor(73)) === null,
  'D: but that fallback is never refund authority');
const dBefore = d.state.refundCreateCalls;
d.setNow(Date.parse(d.rowFor(73).current_start_at) - 3 * DAY_MS);
d.context.patientCancel_({ postData: { contents: JSON.stringify({ token: dBooking.cancel }) } });
check(d.state.refundCreateCalls === dBefore,
  'D: the refund never reached Flow on an unknown amount');
check(d.rowFor(73).refund_status === 'manual_review', 'D: the reservation is parked for a human');
check(d.rowFor(73).refund_last_error_code === 'REFUND_AMOUNT_UNKNOWN', 'D: the reason is recorded');
check(d.rowFor(73).schedule_status === 'cancelled',
  'D: cancellation still released the slot — it never depended on the refund');

// ---------------------------------------------------------------------------
// E. Refund replay: exactly one effective refund, at the bound amount.
// ---------------------------------------------------------------------------
const e = buildHarness(null);
const eBooking = e.paidBooking(74, '2026-09-24', '17:00', 10 * DAY_MS);
e.setNow(Date.parse(e.rowFor(74).current_start_at) - 3 * DAY_MS);
const eBefore = e.state.refundCreateCalls;
e.context.patientCancel_({ postData: { contents: JSON.stringify({ token: eBooking.cancel }) } });
e.context.patientCancel_({ postData: { contents: JSON.stringify({ token: eBooking.cancel }) } });
e.context.patientCancel_({ postData: { contents: JSON.stringify({ token: eBooking.cancel }) } });
check(e.state.refundCreateCalls === eBefore + 1,
  'E: three cancel attempts produce exactly one refund/create');
check(e.state.lastRefundPayload.amount === '50000', 'E: at the bound amount');
check(e.rowFor(74).transaction_amount_clp === '50000',
  'E: the bound amount is never rewritten by a refund');

// ---------------------------------------------------------------------------
// F. An ordinary 50000 booking still flows green, reschedule included, and the
//    bound amount survives the move.
// ---------------------------------------------------------------------------
const f = buildHarness(null);
const fBooking = f.paidBooking(75, '2026-09-25', '11:00', 10 * DAY_MS);
check(f.rowFor(75).booking_status === 'confirmed' && f.rowFor(75).payment_status === 'paid',
  'F: a 50000 booking confirms as before');
check(f.rowFor(75).transaction_amount_clp === '50000', 'F: bound at 50000');
f.setNow(Date.parse(f.rowFor(75).current_start_at) - 3 * DAY_MS);
const fMoved = f.context.patientReschedule_({ postData: { contents: JSON.stringify({
  token: fBooking.reschedule, fecha: '2026-10-09', hora: '11:00' }) } });
check(fMoved.ok === true, 'F: reschedule succeeds');
check(f.rowFor(75).transaction_amount_clp === '50000', 'F: a reschedule preserves the bound amount');
check(f.rowFor(75).patient_reschedule_count === '1', 'F: the one-move cap is consumed as before');
f.setNow(Date.parse(f.rowFor(75).current_start_at) - 3 * DAY_MS);
f.context.patientCancel_({ postData: { contents: JSON.stringify({ token: fBooking.cancel }) } });
check(f.state.lastRefundPayload.amount === '50000',
  'F: the post-reschedule refund is still the originally bound 50000');

// ---------------------------------------------------------------------------
// G. payment/create is priced from the reservation, never from the catalog.
//    There is no fallback: a reservation that cannot prove its amount cannot
//    be charged, and nothing reaches Flow.
// ---------------------------------------------------------------------------
const g = buildHarness(null);

// (b) a new reservation always has its amount bound BEFORE payment/create.
g.setNow(Date.parse(g.phase.startAt_('2026-09-30', '11:00')) - 10 * DAY_MS);
const gCreated = g.context.createFlowPayment_({ postData: { contents: JSON.stringify({
  action: 'create_flow_payment', idempotencyKey: 'fran-booking-bbbbbb50-e89b-12d3-a456-426614174000',
  serviceType: 'initial', modality: 'online', date: '2026-09-30', time: '11:00',
  name: 'Synthetic', email: 'paciente@example.test', phone: '', patientRut: '', reason: '', message: '',
}) } });
check(gCreated.ok === true, 'G(b): the booking was created');
const gRow = () => g.rowFor(50);
check(gRow().transaction_amount_clp === '50000',
  'G(b): the amount is bound before Flow is contacted');
const gOrder = g.state.flowByToken.get(gRow().flow_token);
check(Number(gOrder.amount) === 50000, 'G(b): and payment/create asked Flow for exactly that amount');

// (c) a retry charges the SAME amount, even after the catalog moves under it.
const gRetryBefore = gRow().transaction_amount_clp;
moveCatalog(g, 12345);
const gRetryOrders = g.state.flowByToken.size;
g.context.createProductionFlowPayment_(
  g.phase.readConfig_(),
  { email: gRow().patient_email, idempotencyKey: gRow().idempotency_key },
  gRow(), { commerceOrder: 'fp-retry-same-amount', publicStatusToken: 'tok', timeoutSeconds: 600 });
check(g.state.flowByToken.size === gRetryOrders + 1, 'G(c): the retry created one new Flow order');
const gRetryOrder = [...g.state.flowByToken.values()].pop();
check(Number(gRetryOrder.amount) === 50000,
  'G(c): the retry asked Flow for the originally bound 50000, not the 12345 catalog');
check(gRow().transaction_amount_clp === gRetryBefore,
  'G(c): and the bound amount itself is never rewritten');

// (d) a lane-style reservation bound below the catalog retries at ITS amount.
const gLane = buildHarness(null);
gLane.setNow(Date.parse(gLane.phase.startAt_('2026-09-30', '12:00')) - 10 * DAY_MS);
gLane.context.createFlowPayment_({ postData: { contents: JSON.stringify({
  action: 'create_flow_payment', idempotencyKey: 'fran-booking-bbbbbb51-e89b-12d3-a456-426614174000',
  serviceType: 'initial', modality: 'online', date: '2026-09-30', time: '12:00',
  name: 'Synthetic', email: 'paciente@example.test', phone: '', patientRut: '', reason: '', message: '',
}) } });
const laneRow = gLane.rowFor(51);
laneRow.transaction_amount_clp = '500';          // as a 500-lane reservation reads
const laneAmount = gLane.context.transactionAmountClp_(laneRow);
check(laneAmount === 500, 'G(d): a 500 reservation reports 500');
check(gLane.context.displayAmountClp_(laneRow) === 500,
  'G(d): and every downstream read follows it, not the 50000 catalog');

// (a) a legacy reservation with no bound amount cannot be charged at all, and
//     a catalog change does not give it one.
const gLegacy = buildHarness(null);
gLegacy.setNow(Date.parse(gLegacy.phase.startAt_('2026-09-30', '13:00')) - 10 * DAY_MS);
gLegacy.context.createFlowPayment_({ postData: { contents: JSON.stringify({
  action: 'create_flow_payment', idempotencyKey: 'fran-booking-bbbbbb52-e89b-12d3-a456-426614174000',
  serviceType: 'initial', modality: 'online', date: '2026-09-30', time: '13:00',
  name: 'Synthetic', email: 'paciente@example.test', phone: '', patientRut: '', reason: '', message: '',
}) } });
const legacyRow = gLegacy.rowFor(52);
legacyRow.transaction_amount_clp = '';
moveCatalog(gLegacy, 99999);
const ordersBefore = gLegacy.state.flowByToken.size;
let refused = null;
try {
  gLegacy.context.createProductionFlowPayment_(
    gLegacy.phase.readConfig_(),
    { email: legacyRow.patient_email, idempotencyKey: legacyRow.idempotency_key },
    legacyRow, { commerceOrder: 'fp-legacy-retry', publicStatusToken: 'tok', timeoutSeconds: 600 });
} catch (error) { refused = String(error && error.code); }
check(refused === 'PAYMENT_AMOUNT_UNAUTHORIZED',
  'G(a): a reservation with no bound amount refuses to be priced');
check(gLegacy.state.flowByToken.size === ordersBefore,
  'G(a): and zero payment orders reached Flow');
check(legacyRow.transaction_amount_clp === '',
  'G(a): the refusal did not quietly bind the current catalog price');

// ---------------------------------------------------------------------------
// H. Deterministic backfill from stored history — never from the catalog.
// ---------------------------------------------------------------------------
const backfillSource = base.context.HISTORICAL_AMOUNT_SOURCE_COLUMN;
check(backfillSource === 'priceClp',
  'H: the only backfill source is the amount the v7 runtime stored per row');

const planFor = (rows, columns) => base.context.transactionAmountBackfillPlan_(
  { getDataRange: () => ({ getValues: () => rows }) },
  { kind: 'v7_compat', headers: columns, columns: Object.fromEntries(columns.map((c, i) => [c, i + 1])) },
  Date.parse('2026-09-06T12:00:00.000Z'));

const cols = ['reservation_id', 'payment_status', 'schedule_status', 'current_start_at',
  'transaction_amount_clp', 'priceClp'];
const header = cols.slice();
const futureStart = '2026-12-01T14:00:00.000Z';
const pastStart = '2026-01-01T14:00:00.000Z';

const plan = planFor([header,
  ['r1', 'paid', 'scheduled', futureStart, '', '50000'],   // backfillable, active
  ['r2', 'paid', 'scheduled', futureStart, '', ''],        // BLOCKER: active, unprovable
  ['r3', 'paid', 'cancelled', futureStart, '', '50000'],   // backfillable, not active
  ['r4', 'paid', 'scheduled', pastStart, '', ''],          // past, not active
  ['r5', 'paid', 'scheduled', futureStart, '500', '50000'],// already bound, untouched
  ['r6', 'pending', 'hold', futureStart, '', '50000'],     // unpaid, not active
], cols);
check(plan.total === 6, 'H: HISTORICAL_ROWS_TOTAL counts every data row');
check(plan.activeOrFuturePaid === 3, 'H: ACTIVE_OR_FUTURE_PAID_ROWS counts paid, uncancelled, still ahead of the clock');
check(plan.backfillable === 3, 'H: DETERMINISTIC_AMOUNT_BACKFILLABLE counts rows that can prove an amount');
check(plan.unknownActive === 1, 'H: AMOUNT_UNKNOWN_ACTIVE_ROWS is the blocker count');
check(plan.writes.every((w) => w.rowNumber !== 6), 'H: an already-bound row is never rewritten');
check(plan.writes.every((w) => w.amount === 50000), 'H: each write carries the amount that row itself stored');

// The catalog is not a source, at any price.
[1, 50000, 99999].forEach((price) => {
  const h = buildHarness(null);
  moveCatalog(h, price);
  const p2 = h.context.transactionAmountBackfillPlan_(
    { getDataRange: () => ({ getValues: () => [header, ['r1', 'paid', 'scheduled', futureStart, '', '']] }) },
    { kind: 'v7_compat', headers: cols, columns: Object.fromEntries(cols.map((c, i) => [c, i + 1])) },
    Date.parse('2026-09-06T12:00:00.000Z'));
  check(p2.backfillable === 0 && p2.unknownActive === 1,
    'H: with the catalog at ' + price + ' an unprovable row is STILL unprovable');
});

// Malformed stored values prove nothing.
['0', '-1', 'abc', '50.000', '5e4', ' ', '1234567890'].forEach((raw) => {
  const p3 = planFor([header, ['r1', 'paid', 'scheduled', futureStart, '', raw]], cols);
  check(p3.backfillable === 0 && p3.unknownActive === 1,
    'H: "' + raw + '" is not a provable historical amount');
});

// Idempotent: the plan for an already-backfilled sheet is empty.
const p4 = planFor([header, ['r1', 'paid', 'scheduled', futureStart, '50000', '50000']], cols);
check(p4.backfillable === 0 && p4.unknownActive === 0, 'H: a second run has nothing to do');

// A sheet with no historical column at all backfills nothing and says so.
const noSource = ['reservation_id', 'payment_status', 'schedule_status', 'current_start_at', 'transaction_amount_clp'];
const p5 = base.context.transactionAmountBackfillPlan_(
  { getDataRange: () => ({ getValues: () => [noSource, ['r1', 'paid', 'scheduled', futureStart, '']] }) },
  { kind: 'v2_native', headers: noSource, columns: Object.fromEntries(noSource.map((c, i) => [c, i + 1])) },
  Date.parse('2026-09-06T12:00:00.000Z'));
check(p5.backfillable === 0 && p5.unknownActive === 1,
  'H: with no historical column, nothing is backfillable and the blocker is reported');

// ---------------------------------------------------------------------------
// Adversarial mutations — each deliberately broken build must be DETECTED.
// ---------------------------------------------------------------------------
function probes(h) {
  const out = [];
  const p = (name, fn) => { try { out.push({ name, ok: fn() === true }); }
    catch (error) { out.push({ name, ok: false, error: String(error && error.message) }); } };
  const rec = (clp) => ({ service_type: 'initial', transaction_amount_clp: String(clp) });

  p('status_uses_bound_amount', () => h.context.displayAmountClp_(rec(500)) === 500
    && h.context.displayAmountClp_(rec(50000)) === 50000);
  p('unknown_amount_is_null', () => h.context.transactionAmountClp_({ service_type: 'initial' }) === null);
  p('provider_mismatch_rejected', () =>
    h.context.providerAmountMatchesTransaction_(rec(500), { amount: 50000, currency: 'CLP' }).ok === false);
  p('create_persists_amount', () => {
    h.paidBooking(90, '2026-09-28', '11:00', 10 * DAY_MS);
    return h.rowFor(90).transaction_amount_clp === '50000';
  });
  p('email_uses_bound_amount', () => {
    const row = Object.assign({}, h.rowFor(90), { transaction_amount_clp: '500' });
    const mail = emailFor(h, row, 'BOOKING_CONFIRMED');
    return mail.html.includes('$500') && !mail.html.includes('$50.000')
      && mail.text.includes('Valor: $500');
  });
  p('refund_fails_closed_when_unknown', () => {
    const booking = h.paidBooking(91, '2026-09-28', '12:00', 10 * DAY_MS);
    h.rowFor(91).transaction_amount_clp = '';
    h.setNow(Date.parse(h.rowFor(91).current_start_at) - 3 * DAY_MS);
    const before = h.state.refundCreateCalls;
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    return h.state.refundCreateCalls === before
      && h.rowFor(91).refund_last_error_code === 'REFUND_AMOUNT_UNKNOWN';
  });
  p('fractional_provider_amount_rejected', () =>
    h.context.providerAmountMatchesTransaction_(rec(500), { amount: 500.4, currency: 'CLP' }).ok === false);
  p('absent_currency_rejected', () =>
    h.context.providerAmountMatchesTransaction_(rec(500), { amount: 500 }).ok === false);
  p('unbound_reservation_cannot_be_charged', () => {
    const before = h.state.flowByToken.size;
    let code = null;
    try {
      h.context.createProductionFlowPayment_(h.phase.readConfig_(),
        { email: 'paciente@example.test', idempotencyKey: 'fran-booking-bbbbbb60-e89b-12d3-a456-426614174000' },
        { service_type: 'initial', transaction_amount_clp: '', patient_email: 'paciente@example.test' },
        { commerceOrder: 'fp-probe', publicStatusToken: 't', timeoutSeconds: 600 });
    } catch (error) { code = String(error && error.code); }
    return code === 'PAYMENT_AMOUNT_UNAUTHORIZED' && h.state.flowByToken.size === before;
  });
  p('backfill_never_invents_an_amount', () => {
    const cols2 = ['reservation_id', 'payment_status', 'schedule_status', 'current_start_at',
      'transaction_amount_clp', 'priceClp'];
    const out = h.context.transactionAmountBackfillPlan_(
      { getDataRange: () => ({ getValues: () => [cols2,
        ['r1', 'paid', 'scheduled', '2026-12-01T14:00:00.000Z', '', '']] }) },
      { kind: 'v7_compat', headers: cols2, columns: Object.fromEntries(cols2.map((c, i) => [c, i + 1])) },
      Date.parse('2026-09-06T12:00:00.000Z'));
    return out.backfillable === 0 && out.unknownActive === 1;
  });
  p('refund_uses_bound_amount', () => {
    const booking = h.paidBooking(92, '2026-09-29', '11:00', 10 * DAY_MS);
    h.rowFor(92).transaction_amount_clp = '500';
    h.setNow(Date.parse(h.rowFor(92).current_start_at) - 3 * DAY_MS);
    h.context.patientCancel_({ postData: { contents: JSON.stringify({ token: booking.cancel }) } });
    return h.state.lastRefundPayload.amount === '500';
  });
  return out;
}

probes(buildHarness(null)).forEach((probe) => check(probe.ok === true,
  'BASELINE probe ' + probe.name + (probe.error ? ' — ' + probe.error : '')));

const MUTATIONS = [
  ['MUTATION_STATUS_FALLS_BACK_TO_CATALOG', {
    'Code.js': [['  return bound === null ? consultationAmountClp_(record && record.service_type) : bound;',
      '  return consultationAmountClp_(record && record.service_type);']],
  }, ['status_uses_bound_amount', 'email_uses_bound_amount']],

  ['MUTATION_UNKNOWN_BECOMES_CATALOG', {
    'Code.js': [['  if (!/^[0-9]{1,9}$/.test(raw)) return null;',
      '  if (!/^[0-9]{1,9}$/.test(raw)) return consultationAmountClp_(record && record.service_type);']],
  }, ['unknown_amount_is_null', 'refund_fails_closed_when_unknown']],

  ['MUTATION_NO_PROVIDER_AMOUNT_RECONCILIATION', {
    'Code.js': [["  if (providerAmount !== bound) return { ok: false, code: 'PROVIDER_AMOUNT_MISMATCH' };",
      '']],
  }, ['provider_mismatch_rejected']],

  ['MUTATION_PROVIDER_AMOUNT_ROUNDED', {
    'Code.js': [["  if (providerAmount !== bound) return { ok: false, code: 'PROVIDER_AMOUNT_MISMATCH' };",
      "  if (Math.round(providerAmount) !== bound) return { ok: false, code: 'PROVIDER_AMOUNT_MISMATCH' };"],
      ["  if (!Number.isFinite(providerAmount) || !Number.isInteger(providerAmount) || providerAmount <= 0) {",
       "  if (!Number.isFinite(providerAmount) || providerAmount <= 0) {"]],
  }, ['fractional_provider_amount_rejected']],

  // The regression this guards against is the old code: an absent currency
  // silently becoming CLP. Deleting the explicit check alone changes nothing,
  // because a blank string is still not 'CLP' — the danger is the default.
  ['MUTATION_MISSING_CURRENCY_DEFAULTS_TO_CLP', {
    'Code.js': [["  const currency = String(rawCurrency === null || rawCurrency === undefined ? '' : rawCurrency).trim().toUpperCase();",
      "  const currency = String(rawCurrency || 'CLP').trim().toUpperCase();"]],
  }, ['absent_currency_rejected']],

  ['MUTATION_PAYMENT_CREATE_FALLS_BACK_TO_CATALOG', {
    'Code.js': [['  const boundAmount = transactionAmountClp_(reservation);\n  if (boundAmount === null) fail_(PAYMENT_AMOUNT_UNAUTHORIZED);',
      '  const boundAmount = transactionAmountClp_(reservation)\n    || consultationAmountClp_(reservation && reservation.service_type);']],
  }, ['unbound_reservation_cannot_be_charged']],

  ['MUTATION_BACKFILL_USES_CATALOG', {
    'Code.js': [['  const raw = String(cellFromRow_(row, column) || \'\').trim();\n  if (!/^[0-9]{1,9}$/.test(raw)) return null;',
      '  const raw = String(cellFromRow_(row, column) || \'\').trim();\n  if (!/^[0-9]{1,9}$/.test(raw)) return consultationAmountClp_(\'initial\');']],
  }, ['backfill_never_invents_an_amount']],

  ['MUTATION_CREATE_DOES_NOT_PERSIST_AMOUNT', {
    'Code.js': [['    transaction_amount_clp: String(consultationAmountClp_(payload.serviceType)),', '']],
  }, ['create_persists_amount']],

  ['MUTATION_REFUND_GUESSES_THE_CATALOG', {
    'Code.js': [['  const boundRefundAmount = transactionAmountClp_(record);\n  if (boundRefundAmount === null) {',
      '  const boundRefundAmount = transactionAmountClp_(record) || consultationAmountClp_(record.service_type);\n  if (boundRefundAmount === null) {']],
  }, ['refund_fails_closed_when_unknown']],

  ['MUTATION_REFUND_USES_CATALOG_NOT_BOUND', {
    'Code.js': [['    amount: String(boundRefundAmount),',
      '    amount: String(consultationAmountClp_(record.service_type)),']],
  }, ['refund_uses_bound_amount']],

  ['MUTATION_EMAIL_READS_THE_CATALOG', {
    'EmailTemplates.js': [['  const amount = displayAmountClp_(record);',
      '  const amount = consultationAmountClp_(record && record.service_type);']],
  }, ['email_uses_bound_amount']],
];

const detected = [];
MUTATIONS.forEach(([name, patches, expected]) => {
  let results;
  try { results = probes(buildHarness(patches)); }
  catch (error) { results = [{ name: 'harness_build', ok: false, error: String(error && error.message) }]; }
  const failing = results.filter((probe) => !probe.ok).map((probe) => probe.name);
  check(failing.length > 0, name + ' MUST be detected by at least one probe');
  expected.forEach((probe) => check(failing.indexOf(probe) !== -1 || failing.indexOf('harness_build') !== -1,
    name + ' must be caught by probe "' + probe + '"'));
  detected.push(name + '=DETECTED_BY[' + failing.join(',') + ']');
});

console.log('TRANSACTION_AMOUNT_INTEGRITY=PASS assertions=' + assertions);
console.log('REFUND_USES_TRANSACTION_AMOUNT=PASS');
console.log('EMAIL_USES_TRANSACTION_AMOUNT=PASS');
console.log('PROVIDER_AMOUNT_RECONCILIATION=PASS');
console.log('SCHEMA_COLUMNS=58 APPEND_ONLY=YES');
console.log('CATALOG_PRICE_CLP=50000 TRANSACTION_AMOUNT_SOURCE=transaction_amount_clp');
console.log('CATALOG_FALLBACK_ON_EXISTING_PAYMENT=NO');
console.log('MISSING_PROVIDER_CURRENCY_FAILS_CLOSED=YES');
console.log('PROVIDER_AMOUNT_ROUNDING=REJECTED');
console.log('HISTORICAL_AMOUNT_SOURCE=priceClp');
console.log('MUTATION_CASES=' + MUTATIONS.length);
detected.forEach((line) => console.log(line));
console.log('PRODUCTION_PAYMENT_CREATE_CALLS=0');
console.log('PRODUCTION_REFUND_CREATE_CALLS=0');
console.log('PRODUCTION_EMAILS_SENT=0');
console.log('REAL_MONETARY_FLOW_CALLS=0');
