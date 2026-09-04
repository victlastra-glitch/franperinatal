import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../manage.html', import.meta.url), 'utf8');
const script = source.slice(source.indexOf('<script'));
let assertions = 0;
const check = (fn, message) => { fn(); assertions += 1; void message; };

// Error vocabulary: the page speaks `code`, never a provider message.
check(() => assert.match(source, /data\.code/));
check(() => assert.doesNotMatch(source, /data\.error/));
check(() => assert.doesNotMatch(source, /data\.message/));
check(() => assert.match(source, /capabilityType === 'CANCEL'/));
check(() => assert.match(source, /capabilityType === 'RESCHEDULE'/));
check(() => assert.match(source, /managementErrorMessage\(data\.code\)/));
check(() => assert.match(script, /RESCHEDULE_WINDOW_CLOSED:/));
check(() => assert.match(script, /MANAGEMENT_WINDOW_CLOSED:/));

// PATIENT MANAGEMENT POLICY V2 — capabilities are the server's decision.
check(() => assert.match(script, /reserva\.canReschedule === true/));
check(() => assert.match(script, /reserva\.canCancel === true/));
check(() => assert.match(script, /reserva\.managementWindow === 'cancel_only'/));
check(() => assert.match(script, /reserva\.managementWindow === 'closed'/));
check(() => assert.match(script, /reserva\.refundEligible === true/));

// The page must not re-derive the cutoff. No 24-hour arithmetic, no comparison
// of a cutoff timestamp against a browser clock.
check(() => assert.doesNotMatch(script, /24\s*\*\s*60\s*\*\s*60/));
check(() => assert.doesNotMatch(script, /86400000/));
check(() => assert.doesNotMatch(script, /cutoffAt\s*[<>]/));
check(() => assert.doesNotMatch(script, /Date\.parse\([^)]*cutoff/i));
check(() => assert.doesNotMatch(script, /Date\.now\(\)[^;\n]*cutoff/i));

// An already-sent email link may still say ?open=reschedule; opening the panel
// is gated on the server verdict, not on the URL.
check(() => assert.match(script, /autoOpen === 'reschedule' && reserva\.canReschedule === true/));
check(() => assert.match(script, /autoOpen === 'cancel' && reserva\.canCancel === true/));

// Approved policy copy, verbatim.
const COPY = [
  'Ya no es posible reagendar esta sesión porque faltan menos de 24 horas para el horario agendado.',
  'Puedes cancelar esta sesión y recibir el reembolso completo al mismo medio de pago utilizado.',
  'Esta sesión comienza en menos de 24 horas. Puedes cancelarla para informarnos que no asistirás, pero de acuerdo con la política de cancelación no corresponde reembolso.',
];
COPY.forEach((text) => check(() => assert.ok(script.includes(text), 'missing approved copy: ' + text)));

// Non-alarmist, non-punitive: the page never threatens or blames.
check(() => assert.doesNotMatch(script, /multa|penalizaci[oó]n|castigo|no tienes derecho|perder[aá]s/i));

// No internal lifecycle state name is rendered to the patient.
check(() => assert.doesNotMatch(script, /cancellation_requested|payment_pending|refund_requested|manual_review|reconciliation_required/));

console.log('MANAGE_ERROR_CODE_CONTRACT=PASS assertions=' + assertions);
console.log('MANAGE_SERVER_POLICY_AUTHORITY=PASS');
console.log('MANAGE_CLIENT_SIDE_CUTOFF_ARITHMETIC=NONE');
