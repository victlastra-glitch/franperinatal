/**
 * FRAN_EMAIL_DESIGN_SYSTEM_V4 contract — Editorial Clinical Human.
 *
 * Focused, deterministic, no-network. Renders every lifecycle state from
 * synthetic data, asserts the V4 contract (tokens, type floors, single primary,
 * action hierarchy, cancellation/refund decoupling in copy, operator alert),
 * runs adversarial mutations against the templates, and writes the reviewable
 * preview fixtures under test/fixtures/email-preview/.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const FILES = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js'];
const SOURCE = Object.fromEntries(await Promise.all(FILES.map(async (path) => [
  path, await readFile(new URL(path, import.meta.url), 'utf8'),
])));
const origin = 'https://franciscabustos.cl';
const propertyValues = {
  APP_ENV: 'production', FLOW_API_KEY: 'synthetic-flow-key', FLOW_SECRET_KEY: 'synthetic-flow-secret',
  FLOW_BASE_URL: 'https://www.flow.cl/api', FLOW_RETURN_URL: origin + '/pago-resultado',
  FLOW_CONFIRMATION_URL: origin + '/api/flow-confirmation',
  FLOW_REFUND_CALLBACK_URL: origin + '/api/refund-confirmation',
  BOOKING_STORE_ID: 'synthetic-store', CALENDAR_ID: 'synthetic-calendar',
  INTERNAL_NOTIFICATION_EMAIL: 'ops@example.test',
  IDEMPOTENCY_NAMESPACE: 'fran-booking', STATUS_TOKEN_SECRET: 'synthetic-status-secret',
  CAPABILITY_TOKEN_SECRET: 'synthetic-capability-secret-20260823-abcdefghijklmnopqrstuvwxyz',
};

/** One VM per build; `patches` rewrites EmailTemplates.js so mutations break exactly one rule. */
function build(patches) {
  const context = {
    console, Date, Intl, Set, Number, String, Object, Array, JSON, RegExp, Math,
    encodeURIComponent, decodeURIComponent,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => [...Buffer.from(String(value))].map((b) => (b > 127 ? b - 256 : b)),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...propertyValues }) }) },
    UrlFetchApp: { fetch: () => { throw new Error('network must not be called'); } },
    SpreadsheetApp: { openById: () => { throw new Error('store must not be opened'); } },
    GmailApp: { sendEmail: () => { throw new Error('EMAIL_MUST_NOT_BE_SENT'); } },
    MailApp: { sendEmail: () => { throw new Error('EMAIL_MUST_NOT_BE_SENT'); } },
  };
  vm.createContext(context);
  for (const path of FILES) {
    let text = SOURCE[path];
    ((patches && patches[path]) || []).forEach(([find, replace]) => {
      if (text.indexOf(find) === -1) throw new Error('mutation anchor missing in ' + path + ': ' + find);
      text = text.split(find).join(replace);
    });
    vm.runInContext(text, context);
  }
  return context;
}
const context = build(null);

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

// ---------------------------------------------------------------------------
// Synthetic fixtures. Production-canonical values only.
// ---------------------------------------------------------------------------
const MEET_URL = 'https://meet.google.com/opaque-meet';
const RESCHEDULE_TOKEN = 'r'.repeat(64);
const CANCEL_TOKEN = 'c'.repeat(64);
const ORIGINAL_START = '2026-09-16T14:00:00.000Z'; // miércoles 16 de septiembre de 2026, 11:00 (Chile)
const CURRENT_START = '2026-09-16T18:00:00.000Z';  // miércoles 16 de septiembre de 2026, 15:00 (Chile)

const baseRecord = {
  reservation_id: 'fran-booking-reservation-synthetic',
  service_type: 'initial', modality: 'online', booking_status: 'confirmed',
  original_start_at: ORIGINAL_START, current_start_at: ORIGINAL_START, current_end_at: '2026-09-16T14:50:00.000Z',
};
const movedRecord = Object.assign({}, baseRecord, {
  current_start_at: CURRENT_START, current_end_at: '2026-09-16T18:50:00.000Z',
});
const renderWith = (ctx) => (eventType, record, tokens, meet) => ctx.renderLifecycleNotificationEmail_({
  notification: { eventType, meet: meet === undefined ? { meetUrl: MEET_URL } : meet },
  record, capabilityTokens: tokens || {}, previewOrigin: origin,
});
const render = renderWith(context);

const confirmed = render('BOOKING_CONFIRMED', baseRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
const confirmedFollowup = render('BOOKING_CONFIRMED', Object.assign({}, baseRecord, { service_type: 'followup' }),
  { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
const confirmedNoMeet = render('BOOKING_CONFIRMED', Object.assign({}, baseRecord, { modality: 'presencial' }),
  { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }, null);
const rescheduled = render('PATIENT_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN });
// A revoked-but-still-supplied RESCHEDULE token must not resurrect the action.
const rescheduledLeaky = render('PATIENT_RESCHEDULED', movedRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
const clinicianChange = render('CLINICIAN_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN });
// Neutral cancellation: refund requested / pending / rejected / parked / not required — all identical copy.
const pendingRecord = Object.assign({}, baseRecord, { payment_status: 'paid', refund_status: 'refund_pending' });
const rejectedRecord = Object.assign({}, baseRecord, { payment_status: 'paid', refund_status: 'manual_review',
  refund_last_error_code: 'PROVIDER_REFUND_REJECTED', refund_commerce_order: 'fp-rf-synthetic', refund_provider_reference: 'REFUNDTOKENSYNTHETIC0000001' });
const lateRecord = Object.assign({}, baseRecord, { payment_status: 'paid', refund_status: 'not_required',
  refund_last_error_code: 'PATIENT_CANCEL_LATE_NON_REFUNDABLE' });
const cancelled = render('SESSION_CANCELLED', pendingRecord, {}, null);
const cancelledRejected = render('SESSION_CANCELLED', rejectedRecord, {}, null);
const cancelledLate = render('SESSION_CANCELLED', lateRecord, {}, null);
// Provider-confirmed REFUNDED: the refund-confirmed communication.
const refundedRecord = Object.assign({}, baseRecord, { payment_status: 'paid', refund_status: 'refunded' });
const cancelledRefunded = render('PATIENT_CANCELLED', refundedRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }, null);
const cancelledClinicianRefunded = render('CLINICIAN_CANCELLED', refundedRecord, {}, null);
// A refund-confirmed event whose record is NOT refunded must fail closed to the neutral email.
const cancelledMisrouted = render('PATIENT_CANCELLED', rejectedRecord, {}, null);
const internal = render('REFUND_FAILED_MANUAL_REVIEW', rejectedRecord, {}, null);
const internalTbd = render('REFUND_FAILED_MANUAL_REVIEW', Object.assign({}, baseRecord, {
  payment_status: 'paid', refund_status: 'manual_review', refund_last_error_code: 'BUSINESS_POLICY_TBD',
}), {}, null);

const patientStates = {
  BOOKING_CONFIRMED: confirmed,
  BOOKING_CONFIRMED_FOLLOWUP: confirmedFollowup,
  BOOKING_CONFIRMED_NO_MEET: confirmedNoMeet,
  PATIENT_RESCHEDULED: rescheduled,
  CLINICIAN_RESCHEDULED: clinicianChange,
  SESSION_CANCELLED: cancelled,
  SESSION_CANCELLED_REJECTED_REFUND: cancelledRejected,
  SESSION_CANCELLED_LATE: cancelledLate,
  PATIENT_CANCELLED_REFUNDED: cancelledRefunded,
  CLINICIAN_CANCELLED_REFUNDED: cancelledClinicianRefunded,
  PATIENT_CANCELLED_MISROUTED: cancelledMisrouted,
};
const allStates = Object.assign({}, patientStates, { REFUND_FAILED_MANUAL_REVIEW: internal, REFUND_FAILED_TBD: internalTbd });

// ---------------------------------------------------------------------------
// Global V4 contract
// ---------------------------------------------------------------------------
const LEGACY_PALETTE = /#8A5A6B|#6D4454|#C9A8B3|#FAF6F0|#FDFBF7|#231F1C|#5A534D|#8A8178|#E5DED1|#B46E6A/i;
const SPACING_SCALE = new Set([0, 2, 4, 8, 12, 14, 16, 24, 28, 32, 40, 48]);
const TYPE_SCALE = new Set([0, 1, 12, 14, 16, 20, 22, 30, 38]);
const MARKETING = /instagram|linkedin|testimoni|s[ií]guenos|reserva ya|oferta|descuento|diagn[oó]stico|trastorno|cura|garantiz/i;
const DISPLAY_STACK = "'Fraunces', 'Cormorant Garamond', Georgia, 'Times New Roman', serif";
const SANS_STACK = "Inter, 'DM Sans', Arial, Helvetica, sans-serif";
const PRIMARY = 'background-color:#2F3236;border:1px solid #2F3236;border-radius:2px';
const SECONDARY = 'background-color:#FFFCF9;border:1px solid #A89E93;border-radius:2px';
const TERTIARY_CANCEL = /<a href="[^"]+" target="_blank" class="v4-cancel" style="display:block;padding:14px 12px;line-height:20px;[^"]*color:#8C4F4B;">CANCELAR SESIÓN<\/a>/;
const primaryCount = (html) => (html.match(/background-color:#2F3236;border:1px solid #2F3236/g) || []).length;

for (const [name, rendered] of Object.entries(allStates)) {
  const html = rendered.htmlBody;
  const text = rendered.body;
  const both = html + '\n' + text;

  check(Boolean(rendered.subject && text && html), name + ': subject + text/plain + html all exist');
  check(html.includes('FRANCISCA BUSTOS M.') && text.includes('FRANCISCA BUSTOS M.'), name + ': wordmark FRANCISCA BUSTOS M.');
  check(html.includes('PSICOLOGÍA PERINATAL') && text.includes('PSICOLOGÍA PERINATAL'), name + ': descriptor PSICOLOGÍA PERINATAL');
  check(html.includes('width="40" height="2"') && html.includes('background-color:#DCCBB9'), name + ': editorial sand signature rule under the header');
  check(html.includes('max-width:600px'), name + ': max-width is 600px');
  check(html.includes('font-size:16px'), name + ': 16px body type is present');

  // Zero image dependency, robust email HTML.
  check(!/<img|background-image|url\(/i.test(html), name + ': renders with zero images');
  check(!/<svg|<script|<form|<input|onclick=|javascript:/i.test(html), name + ': no SVG, JS, forms, or inline handlers');
  check(!/display:\s*grid|display:\s*flex|grid-template|flex-direction/i.test(html), name + ': no CSS Grid or Flexbox');
  check(!/box-shadow|text-shadow|filter:|backdrop-filter|linear-gradient|radial-gradient/i.test(html), name + ': no shadows, glass or gradients');
  check(!LEGACY_PALETTE.test(html), name + ': no legacy palette, and no #B46E6A anywhere');
  check(!MARKETING.test(both), name + ': no marketing, testimonial, or diagnostic claims');
  check(/<table role="presentation"/.test(html) && html.includes('cellpadding="0" cellspacing="0" border="0"'), name + ': presentation tables, Outlook-safe');
  check(html.includes('<meta name="color-scheme" content="light">') && html.includes('prefers-color-scheme:dark'), name + ': colour scheme + dark-mode block');
  check(html.includes('@media only screen and (max-width:599px)'), name + ': ships the mobile media query');

  // Radius, spacing and type scales; type floor.
  const radii = [...html.matchAll(/border-radius:(\d+)px/g)].map((match) => Number(match[1]));
  check(radii.length > 0 && radii.every((value) => value <= 4), name + ': no radius above 4px');
  const spacing = [...html.matchAll(/padding(?:-top|-bottom|-left|-right)?:([^;"]+)/g)]
    .flatMap((match) => match[1].trim().split(/\s+/)).map((token) => token.replace(/\s*!important$/, ''))
    .filter((token) => /^\d+px$/.test(token)).map((token) => Number(token.replace('px', '')));
  const offScale = [...new Set(spacing)].filter((value) => !SPACING_SCALE.has(value));
  check(offScale.length === 0, name + ': spacing uses the V4 scale only (off-scale: ' + offScale.join(',') + ')');
  const sizes = [...new Set([...html.matchAll(/font-size:(\d+)px/g)].map((match) => Number(match[1])))];
  const offType = sizes.filter((value) => !TYPE_SCALE.has(value));
  check(offType.length === 0, name + ': type uses the V4 scale only (off-scale: ' + offType.join(',') + ')');
  check(sizes.filter((value) => value > 1).every((value) => value >= 12), name + ': no meaningful text below 12px (only the 1px hidden preheader)');
  check(!/font-size:(8|9|10|11)px/.test(html), name + ': the V3 8/9/10px labels are gone');

  // Typography stacks must survive with no webfont loaded; no remote font.
  check(html.includes(DISPLAY_STACK), name + ': display stack is Fraunces → Cormorant → Georgia');
  check(html.includes(SANS_STACK), name + ': sans stack is Inter → DM Sans → Arial');
  check(!/@import|fonts\.googleapis\.com|fonts\.gstatic\.com|<link|@font-face/i.test(html), name + ': no remote font or @font-face');

  // Links.
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  check(hrefs.every((href) => /^(https:\/\/|mailto:)/.test(href)), name + ': every href is absolute HTTPS or mailto');
  check(/REFUND_FAILED/.test(name) ? hrefs.length === 0 : hrefs.length > 0, name + ': patient states link out; the internal alert does not');
  check(text.length > 200 && !/<[a-z]/i.test(text), name + ': text/plain is a real plain-text equivalent');
  check(primaryCount(html) <= 1, name + ': at most one primary action');
  if (html.includes('min-height:48px')) {
    check(html.includes('min-height:48px;line-height:48px') && html.includes('height="48"'), name + ': button target is 48px');
    check(html.includes('font-size:12px;font-weight:600;letter-spacing:.18em;text-transform:uppercase'), name + ': button type is 12/600/.18em uppercase');
  }
  check(!html.includes('color:#FFFFFF;">') || html.includes(PRIMARY), name + ': white text only on the charcoal primary');
}

// Preheaders: hidden, real copy, never the headline or the subject.
const preheaderOf = (html) => { const m = html.match(/<div style="display:none;[^"]*">([^<]*)<\/div>/); return m ? m[1] : ''; };
for (const [name, rendered] of Object.entries(patientStates)) {
  const preheader = preheaderOf(rendered.htmlBody);
  check(preheader && !rendered.htmlBody.includes('>' + preheader + '</td>'), name + ': preheader is hidden text, not the visible headline');
  check(preheader !== rendered.subject && !rendered.subject.includes(preheader), name + ': preheader complements the subject, does not repeat it');
}
check(preheaderOf(cancelled.htmlBody) === 'La hora quedó liberada. Puedes agendar una nueva sesión cuando quieras.', 'neutral cancellation preheader');
check(preheaderOf(cancelledRefunded.htmlBody) === 'El reembolso fue procesado al mismo medio de pago.', 'refund-confirmed preheader');
// Live-v20 subject contract: lifecycleNotificationSubject_(eventType, dateParts).
// The subject cannot depend on the record, so every cancellation event shares one
// subject and the refund is carried by the body block only.
check(cancelledRefunded.subject === 'Tu sesión fue cancelada', 'refund-confirmed keeps the live-v20 cancellation subject');

// Layout tokens.
check(confirmed.htmlBody.includes('class="v4-outer" align="center" style="padding:24px;"')
  && confirmed.htmlBody.includes('.v4-outer{padding:12px !important;}'), 'outer padding is 24 desktop / 12 mobile');
check(confirmed.htmlBody.includes('padding:28px 28px 0 28px')
  && confirmed.htmlBody.includes('.v4-pad{padding-left:16px !important;padding-right:16px !important;}'), 'inner padding 28 / 16');
check(confirmed.htmlBody.includes('font-size:38px;font-weight:500;line-height:1.08')
  && confirmed.htmlBody.includes('.v4-h1{font-size:30px !important;}'), 'H1 is 38 desktop / 30 mobile');
check(confirmed.htmlBody.includes('font-size:22px;font-weight:500') && confirmed.htmlBody.includes('.v4-wordmark{font-size:20px !important;}'), 'wordmark 22 / 20');
check(confirmed.htmlBody.includes('font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.18em'), 'descriptor is 12/600/.18em (was 10)');
check(confirmed.htmlBody.includes('font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.16em'), 'eyebrow is 12px (was 10)');
check(confirmed.htmlBody.includes('font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.12em'), 'labels are 12px (was 10)');
check(confirmed.htmlBody.includes('.v4-lbl{display:block !important;width:100% !important') && confirmed.htmlBody.includes('.v4-val{display:block !important;width:100% !important'),
  'detail rows stack label-over-value on mobile');
check(confirmed.htmlBody.includes('color:#8C6B52;text-decoration:underline'), 'textual links are #8C6B52 underlined');

// ---------------------------------------------------------------------------
// Subjects — short, locale-safe, no hardcoded dates
// ---------------------------------------------------------------------------
const T = context.__EMAIL_TEMPLATE_TEST_EXPORTS__;
check(T.lifecycleEmailShortDate_(ORIGINAL_START) === 'mié 16 sep' && T.lifecycleEmailShortDate_('2026-09-03T17:00:00.000Z') === 'jue 3 sep'
  && T.lifecycleEmailShortDate_('2026-12-25T15:00:00.000Z') === 'vie 25 dic' && T.lifecycleEmailShortDate_('garbage') === '',
  'short date formatter renders "mié 16 sep" style in Chile time and fails to empty on garbage');
check(confirmed.subject === 'Tu sesión está confirmada · mié 16 sep · 11:00', 'confirmed subject');
check(confirmedFollowup.subject === confirmed.subject, 'follow-up confirmation shares the subject shape');
check(rescheduled.subject === 'Tu sesión fue reagendada · mié 16 sep · 15:00', 'rescheduled subject');
check(clinicianChange.subject === 'Hubo un cambio en tu próxima sesión', 'clinician change subject');
for (const [name, rendered] of Object.entries({ SESSION_CANCELLED: cancelled, REJECTED: cancelledRejected, LATE: cancelledLate, MISROUTED: cancelledMisrouted })) {
  check(rendered.subject === 'Tu sesión fue cancelada', name + ': neutral cancellation subject');
}
check(cancelledRefunded.subject === 'Tu sesión fue cancelada'
  && cancelledClinicianRefunded.subject === 'Tu sesión fue cancelada', 'every cancellation event shares the live-v20 subject');
// The live-v20 subject contract has no record, so both internal manual-review
// shapes share one subject. The provider-failure vs policy-review distinction is
// preserved where the operator actually reads it: the headline and the body rows.
check(internal.subject === 'Acción requerida: la reserva necesita revisión manual'
  && internalTbd.subject === 'Acción requerida: la reserva necesita revisión manual',
  'internal alerts share the live-v20 subject contract');
check(/El reembolso no pudo procesarse automáticamente\./.test(internal.htmlBody + internal.body)
  && /La reserva necesita revisión manual\./.test(internalTbd.htmlBody + internalTbd.body),
  'internal headline still separates provider failure from policy review');
check(!/a las \d{2}:\d{2}/.test(confirmed.subject + rescheduled.subject), 'subjects no longer carry the long "a las" form');

// ---------------------------------------------------------------------------
// CONFIRMED — information order and action hierarchy
// ---------------------------------------------------------------------------
const UNIVERSAL_COPY = 'No necesitas preparar nada especial para la sesión. '
  + 'Puedes llegar con lo que tengas hoy, aunque todavía sea difícil ponerlo en palabras.';
const POLICY_COPY = 'Puedes reagendar o cancelar tu sesión hasta 24 horas antes del horario agendado.';
check(T.EMAIL_V4_SESSION_COPY === UNIVERSAL_COPY, 'approved human copy is the exact string');
check(T.emailV4ManagementPolicyCopy_() === POLICY_COPY, 'policy reminder reads the canonical 24 from the constant');
{
  const html = confirmed.htmlBody;
  const order = ['FRANCISCA BUSTOS M.', '>TU SESIÓN ESTÁ CONFIRMADA<', '>Tu sesión está confirmada.<', 'Te esperamos el miércoles 16 de septiembre de 2026 a las 11:00.',
    '>Fecha</td>', '>ENTRAR A LA SESIÓN</a>', '>' + MEET_URL + '</a>', '>REAGENDAR SESIÓN</a>', '>CANCELAR SESIÓN</a>', POLICY_COPY, UNIVERSAL_COPY, '¿Necesitas ayuda?'];
  let at = -1;
  for (const needle of order) { const i = html.indexOf(needle); check(i > at, 'confirmed order holds at "' + needle + '"'); at = i; }
  for (const label of ['Fecha', 'Hora', 'Modalidad', 'Duración', 'Valor']) {
    check(html.includes('>' + label + '</td>') && confirmed.body.includes(label + ': '), 'confirmed detail row ' + label + ' in html and text');
  }
  check(html.includes('>50 minutos<') && html.includes('>$50.000<') && html.includes('>Online<'), 'confirmed facts: 50 minutos, $50.000, Online');
  check(primaryCount(html) === 1 && html.includes('>ENTRAR A LA SESIÓN</a>'), 'confirmed: exactly one primary and it is ENTRAR A LA SESIÓN');
  check(html.includes(SECONDARY) && html.indexOf(SECONDARY) < html.indexOf('>REAGENDAR SESIÓN</a>')
    && (html.match(new RegExp(SECONDARY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1,
    'confirmed: REAGENDAR is the single outline secondary button');
  check(TERTIARY_CANCEL.test(html), 'confirmed: CANCELAR is a destructive text link in #8C4F4B with a 48px block target');
  check(!html.includes('class="v4-col"') && !/width="50%"/.test(html), 'confirmed: REAGENDAR and CANCELAR are not two equivalent side-by-side buttons');
  check(html.includes('open=reschedule') && html.includes('open=cancel'), 'confirmed: both management capabilities are linked');
  check(confirmed.body.includes(MEET_URL) && confirmed.body.includes('Reagendar: ') && confirmed.body.includes('Cancelar: ')
    && confirmed.body.includes(POLICY_COPY) && confirmed.body.includes(UNIVERSAL_COPY), 'confirmed text/plain is equivalent');
  check(!/Agregar al calendario|pagar|pendiente de pago|transferencia/i.test(html + confirmed.body), 'confirmed: no calendar CTA, no payment instructions');
}
for (const [name, rendered] of Object.entries({ INITIAL: confirmed, FOLLOWUP: confirmedFollowup, NO_MEET: confirmedNoMeet })) {
  check(rendered.htmlBody.includes(UNIVERSAL_COPY) && rendered.body.includes(UNIVERSAL_COPY) && !/primera sesión/i.test(rendered.htmlBody), name + ': universal human copy, no first-session claim');
}
check(!confirmedNoMeet.htmlBody.includes('ENTRAR A LA SESIÓN') && primaryCount(confirmedNoMeet.htmlBody) === 0
  && !/meet\.google\.com/i.test(confirmedNoMeet.htmlBody + confirmedNoMeet.body), 'no-Meet confirmed invents no primary and no Meet fallback');
check(confirmedNoMeet.htmlBody.includes('>REAGENDAR SESIÓN</a>') && TERTIARY_CANCEL.test(confirmedNoMeet.htmlBody), 'no-Meet confirmed keeps the management hierarchy');

// ---------------------------------------------------------------------------
// RESCHEDULED — ANTES → NUEVA FECHA, no second reschedule anywhere
// ---------------------------------------------------------------------------
{
  const html = rescheduled.htmlBody;
  check(html.includes('>TU SESIÓN FUE REAGENDADA<') && html.includes('>Tu sesión fue reagendada.<') && html.includes('Te esperamos en tu nueva fecha.'), 'rescheduled eyebrow, H1, lead');
  check(html.includes('>ANTES<') && html.includes('>NUEVA FECHA<') && html.includes('&#8594;'), 'rescheduled renders ANTES → NUEVA FECHA with a textual arrow');
  check(html.includes('text-decoration:line-through;">miércoles 16 de septiembre de 2026 · 11:00</td>'), 'ANTES is muted and struck through');
  check(html.includes('font-size:20px;font-weight:600;line-height:1.4;color:#2F3236;">miércoles 16 de septiembre de 2026 · 15:00</td>'), 'NUEVA FECHA carries the weight (20/600)');
  check(html.indexOf('>ANTES<') < html.indexOf('>Fecha</td>'), 'comparison comes before the detail block');
  check(html.includes('>ENTRAR A LA SESIÓN</a>') && html.includes('>' + MEET_URL + '</a>') && primaryCount(html) === 1, 'rescheduled keeps the single Meet primary and its fallback');
  check(TERTIARY_CANCEL.test(html), 'rescheduled offers CANCELAR as the tertiary link');
  check(!html.includes(SECONDARY), 'rescheduled has no secondary button at all');
  check(!html.includes(POLICY_COPY) && !rescheduled.body.includes(POLICY_COPY), 'policy reminder is confirmation-only');
  check(rescheduled.body.includes('ANTES: miércoles 16 de septiembre de 2026 · 11:00') && rescheduled.body.includes('NUEVA FECHA: miércoles 16 de septiembre de 2026 · 15:00')
    && rescheduled.body.includes('Hora: 15:00 (Chile)') && rescheduled.body.includes('Cancelar: '), 'rescheduled text/plain is equivalent');
}
for (const [name, rendered] of Object.entries({ PATIENT_RESCHEDULED: rescheduled, LEAKY_TOKEN: rescheduledLeaky, CLINICIAN_RESCHEDULED: clinicianChange })) {
  const both = rendered.htmlBody + '\n' + rendered.body;
  check(!/REAGENDAR SESIÓN|open=reschedule|^Reagendar: /m.test(both), name + ': no reschedule action after a reschedule');
}
check(clinicianChange.htmlBody.includes('>NUEVA FECHA<') && !/ANTES|&#8594;/.test(clinicianChange.htmlBody) && !/ANTES: /.test(clinicianChange.body),
  'clinician change shows NUEVA FECHA alone, never a misleading ANTES');
check(!/11:00/.test(clinicianChange.htmlBody + clinicianChange.body), 'clinician change never surfaces original_start_at');

// ---------------------------------------------------------------------------
// CANCELLED — neutral email independent of refund truth
// ---------------------------------------------------------------------------
const REFUND_COPY = 'El reembolso fue procesado al mismo medio de pago utilizado. '
  + 'Dependiendo de tu banco o emisor, puede tardar hasta 10 días hábiles en verse reflejado.';
check(T.EMAIL_V4_REFUND_COPY === REFUND_COPY, 'approved refund copy is the exact string');
const ECONOMIC = /(pago|cobro|valor|devoluci[oó]n|reembolso|en proceso|procesad|\$50\.000|50000)/i;
const CLAIMS_PROCESSED_REFUND = /(reembolso[^.]{0,40}(fue|ha sido|est[aá])\s+(procesad|complet|realiz|devuelt|emitid|en proceso))|(te (hemos )?devolvimos|dinero devuelto|reembolso completado|reembolso realizado|reembolso confirmado)/i;
const HUMAN_CANCEL_COPY = 'Si necesitas apoyo o tienes dudas, puedes escribirnos. Estamos aquí para acompañarte cuando lo necesites.';

const NEUTRAL_CANCELLED = { SESSION_CANCELLED: cancelled, REJECTED_REFUND: cancelledRejected, LATE: cancelledLate, MISROUTED: cancelledMisrouted };
const REFUND_CONFIRMED = { PATIENT_CANCELLED_REFUNDED: cancelledRefunded, CLINICIAN_CANCELLED_REFUNDED: cancelledClinicianRefunded };
for (const [name, rendered] of Object.entries(NEUTRAL_CANCELLED)) {
  const html = rendered.htmlBody;
  check(html.includes('>TU SESIÓN FUE CANCELADA<') && html.includes('>Tu sesión fue cancelada.<'), name + ': cancellation eyebrow and H1');
  check(html.includes('bgcolor="#F6E6E6"') && html.includes('color:#8C4F4B;">TU SESIÓN FUE CANCELADA<'), name + ': cancellation band uses the accessible accent #8C4F4B');
}
for (const [name, rendered] of Object.entries(Object.assign({}, NEUTRAL_CANCELLED, REFUND_CONFIRMED))) {
  const html = rendered.htmlBody; const both = html + '\n' + rendered.body;
  check(html.includes('La sesión agendada para el miércoles 16 de septiembre de 2026 a las 11:00 fue cancelada. La hora quedó liberada.'), name + ': lead names the slot and says it was released');
  check(html.includes('>Fecha</td>') && html.includes('>miércoles 16 de septiembre de 2026<') && html.includes('>Hora</td>') && html.includes('>11:00 (Chile)<'), name + ': shows Fecha and Hora');
  check(!/>Modalidad<\/td>|>Duración<\/td>|>Valor<\/td>/.test(html) && !/\$50\.000|(?<!\d)50000(?!\d)/.test(both), name + ': hides modality, duration and value');
  check(!/meet\.google\.com|ENTRAR A LA SESIÓN/i.test(both), name + ': hides Meet');
  check(!/manage\.html|open=reschedule|open=cancel|REAGENDAR SESIÓN|CANCELAR SESIÓN|[a-z]{64}/.test(both), name + ': carries no management link or token');
  // The cancellation is the completed job: re-booking is a quiet outline action,
  // never a charcoal primary that reads as conversion recovery.
  check(primaryCount(html) === 0 && !html.includes('color:#FFFFFF;">'), name + ': cancelled states have ZERO charcoal primary CTA');
  check(html.includes('>AGENDAR NUEVA SESIÓN</a>') && html.includes('href="https://franciscabustos.cl/reserva"'), name + ': the re-booking action remains available');
  const rebook = html.slice(html.lastIndexOf('<table', html.indexOf('>AGENDAR NUEVA SESIÓN</a>')), html.indexOf('>AGENDAR NUEVA SESIÓN</a>'));
  check(rebook.includes(SECONDARY) && rebook.includes('height="48"') && rebook.includes('min-height:48px;line-height:48px'), name + ': re-booking is the 48px outline secondary');
  check((html.match(/min-height:48px/g) || []).length === 1, name + ': exactly one action button in the whole email');
  check(html.includes(HUMAN_CANCEL_COPY) && rendered.body.includes(HUMAN_CANCEL_COPY), name + ': human copy');
  check(rendered.body.includes('Agendar nueva sesión: https://franciscabustos.cl/reserva') && rendered.body.includes('Fecha: miércoles 16 de septiembre de 2026') && rendered.body.includes('Hora: 11:00 (Chile)'),
    name + ': text/plain is equivalent');
  check(!/ver reembolso|estado del reembolso|te enviaremos|te contactaremos/i.test(both), name + ': promises no further email');
}
// Neutral variants: zero economic vocabulary, whatever the refund state (pending, rejected, late, misrouted).
for (const [name, rendered] of Object.entries({ SESSION_CANCELLED: cancelled, REJECTED_REFUND: cancelledRejected, LATE: cancelledLate, MISROUTED: cancelledMisrouted })) {
  const both = rendered.htmlBody + '\n' + rendered.body;
  check(!ECONOMIC.test(both), name + ': neutral cancellation carries no economic vocabulary at all');
  check(!CLAIMS_PROCESSED_REFUND.test(both) && !/REEMBOLSO/.test(both), name + ': neutral cancellation makes no refund claim and has no REEMBOLSO block');
}
check(cancelled.htmlBody === cancelledRejected.htmlBody && cancelled.body === cancelledRejected.body, 'the neutral email is byte-identical whether the refund is pending or rejected');
// Refund-confirmed variant, live-v20 structure: the cancellation still leads the
// email and the approved refund copy is an information block underneath. V4 only
// restyles it. Only ever rendered under a provider-confirmed REFUNDED record.
const countOf = (text, needle) => text.split(needle).length - 1;
for (const [name, rendered] of Object.entries(REFUND_CONFIRMED)) {
  const html = rendered.htmlBody; const body = rendered.body;
  check(html.includes('>TU SESIÓN FUE CANCELADA<') && html.includes('>Tu sesión fue cancelada.<'),
    name + ': cancellation still leads the email');
  check(html.indexOf('La sesión agendada para el') < html.indexOf('>Fecha</td>')
    && html.indexOf('>Fecha</td>') < html.indexOf(REFUND_COPY)
    && html.indexOf(REFUND_COPY) < html.indexOf(HUMAN_CANCEL_COPY),
    name + ': the refund block sits under the session details, before the human copy');
  check(html.includes('>REEMBOLSO<'), name + ': the refund information block is labelled REEMBOLSO');
  check(countOf(html, REFUND_COPY) === 1 && countOf(body, REFUND_COPY) === 1,
    name + ': the approved refund copy appears exactly once in html and in text');
  check(body.includes('\nREEMBOLSO\n' + REFUND_COPY), name + ': text/plain carries the labelled refund section');
  check(!/✔|✅|💸|🎉/.test(html), name + ': no icon on the refund block');
}
check(cancelledMisrouted.subject === 'Tu sesión fue cancelada' && !cancelledMisrouted.htmlBody.includes('REEMBOLSO'), 'a refund-confirmed event on a non-REFUNDED record renders the neutral email (fail-closed)');

// ---------------------------------------------------------------------------
// INTERNAL — operator tool, human-first
// ---------------------------------------------------------------------------
{
  const html = internal.htmlBody; const body = internal.body;
  check(html.includes('>ACCIÓN REQUERIDA<') && html.includes('color:#8C4F4B;">ACCIÓN REQUERIDA<'), 'internal eyebrow ACCIÓN REQUERIDA in the accent');
  check(html.includes('>El reembolso no pudo procesarse automáticamente.<'), 'internal H1 states the problem in human terms');
  check(/Este aviso es interno\. No es confirmación de reembolso al paciente/.test(html) && /No es confirmación de reembolso al paciente/.test(body), 'internal disclaimer in html and text');
  const rows = ['>Pago</td>', '>Confirmado<', '>Reembolso</td>', '>Rechazado por el proveedor<', '>Acción</td>', '>Revisar manualmente. No reintentar automáticamente.<'];
  let at = -1; for (const needle of rows) { const i = html.indexOf(needle); check(i > at, 'internal human row order holds at "' + needle + '"'); at = i; }
  check(html.indexOf('>Acción</td>') < html.indexOf('>DATOS OPERATIVOS<') && html.indexOf('>DATOS OPERATIVOS<') < html.indexOf('>Referencia</td>'), 'human rows come before the operational metadata');
  check(html.includes('>fran-booking-reservation-synthetic<') && html.includes('>PROVIDER_REFUND_REJECTED<') && html.includes('>intentado<') && html.includes('>payment=paid · refund=manual_review<'),
    'metadata carries reference, error code, provider attempt and raw states');
  check(body.includes('Pago: Confirmado') && body.includes('Reembolso: Rechazado por el proveedor') && body.includes('Acción: Revisar manualmente. No reintentar automáticamente.')
    && body.includes('Referencia: fran-booking-reservation-synthetic') && body.includes('Código: PROVIDER_REFUND_REJECTED'), 'internal text/plain mirrors the rows');
  check(!/Pago: paid|Reembolso: manual_review|Reembolso: refund_failed/.test(body) && !/>paid<|>manual_review<|>refund_failed</.test(html), 'raw states are never the primary information');
  check(!html.includes('min-height:48px') && !/AGENDAR NUEVA SESIÓN|ENTRAR A LA SESIÓN|¿Necesitas ayuda\?|wa\.me/.test(html), 'internal alert has no patient CTA and no patient footer');
  check(html.includes('AVISO INTERNO'), 'internal footer says AVISO INTERNO');
  check(!/en proceso|fue procesado|reembolso confirmado/i.test(html + body), 'internal alert never implies the refund is confirmed or in progress');
  check(internalTbd.htmlBody.includes('>Fuera de la política automática<') && internalTbd.htmlBody.includes('>no intentado<'), 'policy-review variant translates BUSINESS_POLICY_TBD and shows no provider attempt');
  check(context.lifecycleNotificationRecipient_({ internalNotificationEmail: 'ops@example.test' }, { patient_email: 'p@example.test' }, 'REFUND_FAILED_MANUAL_REVIEW') === 'ops@example.test',
    'REFUND_FAILED_MANUAL_REVIEW is delivered to the internal recipient only');
}

// Footer: ~25% shorter — help, WhatsApp, Email, one identification line; no promise, no site link.
{
  const html = confirmed.htmlBody;
  const order = ['¿Necesitas ayuda?', '>WhatsApp<', '>Email<', 'FRANCISCA BUSTOS M. &middot; PSICOLOGÍA PERINATAL'];
  let at = -1; for (const needle of order) { const i = html.indexOf(needle); check(i > at, 'footer order holds at "' + needle + '"'); at = i; }
  check(!html.includes('Acompañamiento psicológico en embarazo') && !html.includes('>franciscabustos.cl<'), 'footer drops the promise line and the site link');
  check(html.includes('href="https://wa.me/56957663038"') && html.includes('href="mailto:hola@franciscabustos.cl"'), 'footer keeps WhatsApp and Email');
  const footer = html.slice(html.lastIndexOf('¿Necesitas ayuda?'));
  check((footer.match(/<tr>/g) || []).length <= 4, 'footer is at most four rows');
}

// ---------------------------------------------------------------------------
// Adversarial mutations — the contract must fail when the rule is broken.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  ['MUTATION_REFUND_COPY_ON_NEUTRAL_CANCELLATION', [
    ["(refundConfirmed ? emailV4InfoBlock_('REEMBOLSO', EMAIL_V4_REFUND_COPY) : '')", "emailV4InfoBlock_('REEMBOLSO', EMAIL_V4_REFUND_COPY)"]],
    (ctx) => { const r = renderWith(ctx)('SESSION_CANCELLED', rejectedRecord, {}, null); return ECONOMIC.test(r.htmlBody) ? 'refund_copy_leaked_into_neutral_cancellation' : null; }],
  ['MUTATION_SECOND_PRIMARY_CTA', [
    ["(actions.reschedule ? emailV4SecondaryRow_(actions.reschedule.href, actions.reschedule.label) : '')", "(actions.reschedule ? emailV4PrimaryRow_(actions.reschedule.href, actions.reschedule.label) : '')"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }); return primaryCount(r.htmlBody) > 1 ? 'two_primary_buttons' : null; }],
  ['MUTATION_LEGACY_CANCEL_ACCENT_RESTORED', [["cancelAccent: '#8C4F4B',", "cancelAccent: '#B46E6A',"]],
    (ctx) => { const r = renderWith(ctx)('SESSION_CANCELLED', pendingRecord, {}, null); return LEGACY_PALETTE.test(r.htmlBody) || !r.htmlBody.includes('#8C4F4B') ? 'B46E6A_small_text_contrast' : null; }],
  ['MUTATION_RESCHEDULE_AFTER_PATIENT_RESCHEDULE', [["reschedule: kind === 'confirmed' && tokens.RESCHEDULE", "reschedule: tokens.RESCHEDULE"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_RESCHEDULED', movedRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }); return /REAGENDAR SESIÓN|open=reschedule/.test(r.htmlBody + r.body) ? 'reschedule_offered_after_move' : null; }],
  ['MUTATION_PROVIDER_REJECTED_SAYS_EN_PROCESO', [
    ["'La sesión agendada para el ' + parts.date + ' a las ' + parts.time + ' fue cancelada. La hora quedó liberada.'\n      : 'La sesión que tenías agendada fue cancelada. La hora quedó liberada.';\n    const refundConfirmed",
     "'La sesión agendada para el ' + parts.date + ' a las ' + parts.time + ' fue cancelada. Tu reembolso está en proceso.'\n      : 'La sesión que tenías agendada fue cancelada. Tu reembolso está en proceso.';\n    const refundConfirmed"]],
    (ctx) => { const r = renderWith(ctx)('SESSION_CANCELLED', rejectedRecord, {}, null); return /en proceso|reembolso/i.test(r.htmlBody) ? 'en_proceso_claimed_after_rejection' : null; }],
  ['MUTATION_REFUND_CLAIM_WITHOUT_REFUNDED_RECORD', [["return confirmedEvent && String(record && record.refund_status || '') === LIFECYCLE.REFUND_STATUS.REFUNDED;", 'return confirmedEvent;']],
    (ctx) => { const r = renderWith(ctx)('PATIENT_CANCELLED', rejectedRecord, {}, null); return /REEMBOLSO/.test(r.htmlBody + r.body) || ECONOMIC.test(r.htmlBody + r.body) ? 'refund_claimed_on_rejected_record' : null; }],
  ['MUTATION_REFUND_PROMOTED_TO_H1', [["emailV4Headline_('Tu sesión fue cancelada.')", "emailV4Headline_('Tu reembolso fue confirmado.')"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_CANCELLED', refundedRecord, {}, null); return !r.htmlBody.includes('>Tu sesión fue cancelada.<') ? 'refund_promoted_over_cancellation_h1' : null; }],
  ['MUTATION_CANCELLED_PRIMARY_REBOOK_CTA', [["emailV4SecondaryRow_(emailV4BookingUrl_(origin), 'AGENDAR NUEVA SESIÓN', 24)", "emailV4PrimaryRow_(emailV4BookingUrl_(origin), 'AGENDAR NUEVA SESIÓN')"]],
    (ctx) => { const r = renderWith(ctx)('SESSION_CANCELLED', pendingRecord, {}, null); return primaryCount(r.htmlBody) > 0 ? 'charcoal_primary_on_cancelled' : null; }],
  ['MUTATION_REMOTE_FONT_DEPENDENCY', [["+ emailV4Style_()\n    + '</head>'", "+ emailV4Style_()\n    + '<link href=\"https://fonts.googleapis.com/css2?family=Fraunces\" rel=\"stylesheet\">'\n    + '</head>'"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return /fonts\.googleapis\.com|<link/i.test(r.htmlBody) ? 'remote_font_loaded' : null; }],
  ['MUTATION_LABEL_BELOW_FLOOR', [["font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.16em;", "font-size:10px;font-weight:600;line-height:1.4;letter-spacing:.16em;"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return /font-size:(8|9|10|11)px/.test(r.htmlBody) ? 'label_below_12px' : null; }],
];
for (const [name, patches, detect] of MUTATIONS) {
  const detectedBy = detect(build({ '../EmailTemplates.js': patches }));
  check(Boolean(detectedBy), name + ' must be detected by the contract');
  console.log(name + '=DETECTED_BY[' + detectedBy + ']');
}

// ---------------------------------------------------------------------------
// Deterministic preview artifacts
// ---------------------------------------------------------------------------
const fixtureDir = new URL('./fixtures/email-preview/', import.meta.url);
await mkdir(fixtureDir, { recursive: true });
const artifacts = {
  'booking-confirmed': confirmed,
  'session-rescheduled': rescheduled,
  'session-clinician-change': clinicianChange,
  'session-cancelled': cancelled,
  'session-cancelled-refunded': cancelledRefunded,
  'internal-manual-review': internal,
};
for (const [base, rendered] of Object.entries(artifacts)) {
  await writeFile(new URL(base + '.html', fixtureDir), rendered.htmlBody);
  await writeFile(new URL(base + '.txt', fixtureDir), rendered.body);
}

console.log(`EMAIL_DESIGN_SYSTEM_V4_CONTRACT=PASS assertions=${assertions}`);
console.log('EMAIL_PREVIEW_FIXTURES=' + fileURLToPath(fixtureDir));
console.log('PRODUCTION_EMAILS_SENT=0');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');
