/**
 * FRAN_EMAIL_DESIGN_SYSTEM_V4 contract — Editorial Clinical Human.
 * Carries the V4.1 compaction and dark-mode rules on top of the V4 contract.
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
// Approved presentation copy, restated here as an independent oracle so a silent
// edit to the template constants fails instead of re-deriving itself.
const MEET_FALLBACK_LEAD = '¿No funciona el botón?';
const MEET_FALLBACK_LABEL = 'Abrir Google Meet';
// V4.1 retired the two-row fallback. Asserted absent so it cannot come back, and
// so the link text can never decay into a destination-free "haz clic aquí".
const RETIRED_MEET_FALLBACK_LEAD = 'Si el botón no funciona:';
const RETIRED_MEET_FALLBACK_LABEL = 'Abrir enlace alternativo de Google Meet';
const FORBIDDEN_LINK_TEXT = /haz clic aqu[ií]|clic aqu[ií]|click aqu[ií]|pincha aqu[ií]/i;
const REBOOK_LABEL = 'Agendar una nueva sesión';
// Compaction: MODALIDAD, DURACIÓN and — on the confirmation only — VALOR collapse
// into one discreet line. These literals are the expected *presentation* of the
// fixture, restated independently; the values behind them must still come from
// patientFacingModalityLabel_, SESSION_DURATION_MINUTES and displayAmountClp_,
// which the derivation checks and MUTATION_LOGISTICS_LINE_* below enforce.
const LOGISTICS_LINE = 'Online · 50 minutos';
const CONFIRMED_LOGISTICS_LINE = 'Online · 50 minutos · $50.000';
// V4.1 states the appointment once, on one compact line built from the same
// short-date helper the subject reads.
const CONFIRMED_WHEN = 'Mié 16 sep · 11:00 (Chile)';
const RESCHEDULED_WHEN = 'Mié 16 sep · 15:00 (Chile)';
const SUPERSEDED_WHEN = 'Mié 16 sep · 11:00';
// The V4 lead sentences that restated a fact the WHEN line already carries.
const RETIRED_LEADS = [
  'Te esperamos el miércoles 16 de septiembre de 2026 a las 11:00.',
  'Te esperamos en tu nueva fecha.',
  'Actualicé el horario. Revisa a continuación la nueva fecha.',
  'La sesión agendada para el miércoles 16 de septiembre de 2026 a las 11:00 fue cancelada.',
];
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
// The schema stores no patient name, so every Production send is the nameless
// path; this record exercises the personalised branch of the existing input.
const namedRecord = Object.assign({}, baseRecord, { patient_first_name: 'Ana Sofía' });
// A booking whose persisted transaction differs from the catalog price. The
// compact line must show what THIS transaction was worth, never today's list.
const amountRecord = Object.assign({}, baseRecord, { transaction_amount_clp: '38000' });
const confirmedNamed = render('BOOKING_CONFIRMED', namedRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
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
// The single refund communication, sent when the application accepts the request.
const refundRequestedRecord = Object.assign({}, baseRecord, { payment_status: 'paid', refund_status: 'refund_requested' });
const refundRequested = render('REFUND_REQUESTED', refundRequestedRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }, null);
const refundRequestedPending = render('REFUND_REQUESTED', pendingRecord, {}, null);
// The dormant operational state. V4 printed "ACTUALIZACIÓN DE TU RESERVA" above
// the identical headline, so it is rendered here and held to the same rules.
const genericState = render('REFUND_COMPLETED', refundedRecord, {}, null);
const internal = render('REFUND_FAILED_MANUAL_REVIEW', rejectedRecord, {}, null);
const internalTbd = render('REFUND_FAILED_MANUAL_REVIEW', Object.assign({}, baseRecord, {
  payment_status: 'paid', refund_status: 'manual_review', refund_last_error_code: 'BUSINESS_POLICY_TBD',
}), {}, null);

const patientStates = {
  BOOKING_CONFIRMED: confirmed,
  BOOKING_CONFIRMED_FOLLOWUP: confirmedFollowup,
  BOOKING_CONFIRMED_NO_MEET: confirmedNoMeet,
  BOOKING_CONFIRMED_NAMED: confirmedNamed,
  PATIENT_RESCHEDULED: rescheduled,
  CLINICIAN_RESCHEDULED: clinicianChange,
  SESSION_CANCELLED: cancelled,
  SESSION_CANCELLED_REJECTED_REFUND: cancelledRejected,
  SESSION_CANCELLED_LATE: cancelledLate,
  PATIENT_CANCELLED_REFUNDED: cancelledRefunded,
  CLINICIAN_CANCELLED_REFUNDED: cancelledClinicianRefunded,
  PATIENT_CANCELLED_MISROUTED: cancelledMisrouted,
  REFUND_REQUESTED: refundRequested,
  REFUND_REQUESTED_PENDING: refundRequestedPending,
  REFUND_COMPLETED_GENERIC: genericState,
};
const allStates = Object.assign({}, patientStates, { REFUND_FAILED_MANUAL_REVIEW: internal, REFUND_FAILED_TBD: internalTbd });

// ---------------------------------------------------------------------------
// Global V4 contract
// ---------------------------------------------------------------------------
const LEGACY_PALETTE = /#8A5A6B|#6D4454|#C9A8B3|#FAF6F0|#FDFBF7|#231F1C|#5A534D|#8A8178|#E5DED1|#B46E6A/i;
// V4.1 retired the cream page and the cream card. They are the large warm
// surfaces Gmail iOS dark mode rendered muddy, and they do not come back.
const RETIRED_V4_SURFACES = /#FFF7F2|#FFFCF9|#E7DDD3|#E8EEE6/i;
const SPACING_SCALE = new Set([0, 2, 4, 8, 12, 14, 16, 24, 28, 32, 40, 48]);
const TYPE_SCALE = new Set([0, 1, 12, 14, 16, 20, 22, 30, 38]);
const MARKETING = /instagram|linkedin|testimoni|s[ií]guenos|reserva ya|oferta|descuento|diagn[oó]stico|trastorno|cura|garantiz/i;
const DISPLAY_STACK = "'Fraunces', 'Cormorant Garamond', Georgia, 'Times New Roman', serif";
const SANS_STACK = "Inter, 'DM Sans', Arial, Helvetica, sans-serif";
const PRIMARY = 'background-color:#2F3236;border:1px solid #2F3236;border-radius:2px';
const SECONDARY = 'background-color:#FFFFFF;border:1px solid #A89E93;border-radius:2px';
const TERTIARY_CANCEL = /<a href="[^"]+" target="_blank" class="v4-cancel" style="display:block;padding:14px 12px;line-height:20px;[^"]*color:#8C4F4B;">CANCELAR SESIÓN<\/a>/;
const primaryCount = (html) => (html.match(/background-color:#2F3236;border:1px solid #2F3236/g) || []).length;
// Text nodes only. Every tag — and therefore every href attribute — is removed,
// so this is what the reader actually sees on screen. It is the oracle for "the
// destination is unchanged but the raw URL is no longer printed".
const visibleText = (html) => html.replace(/<[^>]*>/g, '\n');
const countOf = (text, needle) => text.split(needle).length - 1;

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
  check(!RETIRED_V4_SURFACES.test(html), name + ': no retired V4 cream ground, cream card or warm border');
  // Every tint is a chip sized to its own text; no cell spanning the card carries
  // a background. This is the rule that keeps dark mode from going muddy.
  check(!/<td class="v4-pad[^"]*" bgcolor=/.test(html), name + ': no full-width tinted band');
  check(!FORBIDDEN_LINK_TEXT.test(html + '\n' + text), name + ': no destination-free "haz clic aquí" link text');
  check(!html.includes(RETIRED_MEET_FALLBACK_LABEL) && !html.includes(RETIRED_MEET_FALLBACK_LEAD),
    name + ': the retired two-row Meet fallback is gone from the html');
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
check(confirmed.htmlBody.includes('padding:24px 28px 0 28px')
  && confirmed.htmlBody.includes('.v4-pad{padding-left:16px !important;padding-right:16px !important;}'), 'inner padding 28 / 16');
check(!confirmed.htmlBody.includes('padding:28px 28px 0 28px'), 'V4.1: the 28px vertical steps are gone from the card rhythm');
check(confirmed.htmlBody.includes('font-size:38px;font-weight:500;line-height:1.08')
  && confirmed.htmlBody.includes('.v4-h1{font-size:30px !important;}'), 'H1 is 38 desktop / 30 mobile');
check(confirmed.htmlBody.includes('font-size:22px;font-weight:500') && confirmed.htmlBody.includes('.v4-wordmark{font-size:20px !important;}'), 'wordmark 22 / 20');
check(confirmed.htmlBody.includes('font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.18em'), 'descriptor is 12/600/.18em (was 10)');
check(confirmed.htmlBody.includes('font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.16em'), 'chip is 12px (was 10)');
check(confirmed.htmlBody.includes('<td class="v4-chip-ok" bgcolor="#E6EDE6" style="padding:4px 8px;background-color:#E6EDE6;border-radius:2px;'),
  'the confirmed status is a small chip, not a full-width band');
check(rescheduled.htmlBody.includes('font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.12em')
  && internal.htmlBody.includes('font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.12em'),
  'labels are 12px (was 10), on the ANTES label and on the operator detail rows');
check(!confirmed.htmlBody.includes('<td class="v4-lbl'),
  'the confirmation renders no labelled detail row at all: the compaction removed them');
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
// FRA-9 compaction: one sentence. The dropped second clause is asserted absent
// so it cannot be reinstated silently.
const UNIVERSAL_COPY = 'No necesitas preparar nada especial para la sesión.';
const DROPPED_SESSION_CLAUSE = 'Puedes llegar con lo que tengas hoy, aunque todavía sea difícil ponerlo en palabras.';
const POLICY_COPY = 'Puedes reagendar o cancelar hasta 24 horas antes de tu sesión.';
check(T.EMAIL_V4_SESSION_COPY === UNIVERSAL_COPY, 'approved human copy is the exact string');
check(T.emailV4ManagementPolicyCopy_() === POLICY_COPY, 'policy reminder reads the canonical 24 from the constant');
{
  const html = confirmed.htmlBody;
  // V4.1 information architecture: STATE -> WHEN -> JOIN -> MANAGE -> HELP.
  // The reader gets what happened, when the session is, how to enter it, how to
  // change it, and where to ask for help — each fact stated exactly once.
  const order = ['FRANCISCA BUSTOS M.', '>RESERVA CONFIRMADA<', '>Tu sesión está confirmada.<',
    '>' + CONFIRMED_WHEN + '<', '>' + CONFIRMED_LOGISTICS_LINE + '<',
    '>ENTRAR A LA SESIÓN</a>', MEET_FALLBACK_LEAD, '>' + MEET_FALLBACK_LABEL + '</a>',
    '>REAGENDAR SESIÓN</a>', '>CANCELAR SESIÓN</a>', POLICY_COPY, UNIVERSAL_COPY, '¿Necesitas ayuda?'];
  let at = -1;
  for (const needle of order) { const i = html.indexOf(needle); check(i > at, 'confirmed order holds at "' + needle + '"'); at = i; }
  // The compact HTML abbreviates; text/plain keeps every fact under its label.
  for (const label of ['Fecha', 'Hora', 'Modalidad', 'Duración', 'Valor']) {
    check(confirmed.body.includes(label + ': '), 'confirmed detail ' + label + ' survives in text/plain');
    check(!html.includes('>' + label + '</td>'), 'confirmed: ' + label + ' is no longer a labelled row in the html');
  }
  check(html.indexOf('>' + CONFIRMED_WHEN + '<') < html.indexOf('>ENTRAR A LA SESIÓN</a>'),
    'confirmed: the WHEN line precedes the Meet CTA');
  check(countOf(html, '>' + CONFIRMED_WHEN + '<') === 1 && countOf(html, CONFIRMED_LOGISTICS_LINE) === 1,
    'confirmed: the appointment and the logistics line are each stated exactly once');
  check(html.includes(CONFIRMED_LOGISTICS_LINE), 'confirmed facts: Online, 50 minutos and $50.000 on one line');
  check(html.includes(UNIVERSAL_COPY) && confirmed.body.includes(UNIVERSAL_COPY), 'confirmed: the supportive copy is the approved single sentence');
  check(!html.includes(DROPPED_SESSION_CLAUSE) && !confirmed.body.includes(DROPPED_SESSION_CLAUSE),
    'confirmed: the retired second supportive clause is gone from html and text');
  // (Chile) belongs to the WHEN line and to nothing else on this email.
  check(countOf(html, '(Chile)') === 1, 'confirmed: (Chile) is stated exactly once, on the WHEN line');
  check(!/Tu sesión está confirmada[^<]*\(Chile\)/.test(html), 'confirmed: the H1 does not carry (Chile)');
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
  // V4.1: the chip states the outcome ("there is a new date and it is settled"),
  // the H1 states what happened to the patient. Neither repeats the other.
  check(html.includes('>NUEVA FECHA CONFIRMADA<') && html.includes('>Tu sesión fue reagendada.<'), 'rescheduled chip and H1');
  check(!html.includes('>TU SESIÓN FUE REAGENDADA<'), 'rescheduled: the duplicated shouted headline is gone');
  check(html.includes('>ANTES</span>&nbsp;&nbsp;<span style="text-decoration:line-through;">' + SUPERSEDED_WHEN + '</span>'),
    'the superseded time is one muted, struck-through, labelled line');
  check(html.includes('font-size:20px;font-weight:600;line-height:1.4;color:#2F3236;">' + RESCHEDULED_WHEN + '</td>'),
    'the new time carries the weight (20/600) and owns the explicit Chile zone');
  check(!html.includes('&#8594;</td>') && !html.includes('>NUEVA FECHA<'),
    'the bordered five-row comparison card and its arrow are gone');
  check(html.indexOf('>ANTES</span>') < html.indexOf('>' + RESCHEDULED_WHEN + '<')
    && html.indexOf('>' + RESCHEDULED_WHEN + '<') < html.indexOf(LOGISTICS_LINE),
    'superseded time, then the new time, then the compact logistics line');
  check(html.includes('>ENTRAR A LA SESIÓN</a>') && html.includes('>' + MEET_FALLBACK_LABEL + '</a>') && primaryCount(html) === 1,
    'rescheduled keeps the single Meet primary and its named fallback');
  check(TERTIARY_CANCEL.test(html), 'rescheduled offers CANCELAR as the tertiary link');
  check(!html.includes(SECONDARY), 'rescheduled has no secondary button at all');
  check(!html.includes(POLICY_COPY) && !rescheduled.body.includes(POLICY_COPY), 'policy reminder is confirmation-only');
  check(rescheduled.body.includes('NUEVA FECHA CONFIRMADA') && rescheduled.body.includes('Tu sesión fue reagendada.')
    && rescheduled.body.includes('ANTES: miércoles 16 de septiembre de 2026 · 11:00') && rescheduled.body.includes('NUEVA FECHA: miércoles 16 de septiembre de 2026 · 15:00')
    && rescheduled.body.includes('Hora: 15:00 (Chile)') && rescheduled.body.includes('Cancelar: '), 'rescheduled text/plain is equivalent');
}
for (const [name, rendered] of Object.entries({ PATIENT_RESCHEDULED: rescheduled, LEAKY_TOKEN: rescheduledLeaky, CLINICIAN_RESCHEDULED: clinicianChange })) {
  const both = rendered.htmlBody + '\n' + rendered.body;
  check(!/REAGENDAR SESIÓN|open=reschedule|^Reagendar: /m.test(both), name + ': no reschedule action after a reschedule');
}
check(clinicianChange.htmlBody.includes('>CAMBIO DE HORARIO<') && clinicianChange.htmlBody.includes('>Hubo un cambio en tu próxima sesión.<'),
  'clinician change: the chip adds context and the H1 carries the message');
check(!clinicianChange.htmlBody.includes('>HUBO UN CAMBIO EN TU PRÓXIMA SESIÓN<'),
  'clinician change: the duplicated shouted headline is gone');
check(clinicianChange.htmlBody.includes('>' + RESCHEDULED_WHEN + '<') && !/ANTES|&#8594;/.test(clinicianChange.htmlBody) && !/ANTES: /.test(clinicianChange.body),
  'clinician change shows the new time alone, never a misleading ANTES');
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
  check(html.includes('>RESERVA CANCELADA<') && html.includes('>Tu sesión fue cancelada.<'), name + ': cancellation chip and H1');
  check(!html.includes('>TU SESIÓN FUE CANCELADA<'), name + ': the duplicated shouted headline is gone');
  check(html.includes('class="v4-chip-cancel" bgcolor="#F6E6E6"') && html.includes('color:#8C4F4B;">RESERVA CANCELADA<'),
    name + ': the cancellation chip uses the accessible accent #8C4F4B');
}
for (const [name, rendered] of Object.entries(Object.assign({}, NEUTRAL_CANCELLED, REFUND_CONFIRMED))) {
  const html = rendered.htmlBody; const both = html + '\n' + rendered.body;
  // V4.1: V4 named the slot in a lead sentence and then again in a FECHA row and
  // a HORA row. The slot is now stated once and the released clause stands alone.
  check(html.includes('>' + CONFIRMED_WHEN + '<') && countOf(html, CONFIRMED_WHEN) === 1,
    name + ': the cancelled slot is stated exactly once, on the WHEN line');
  check(html.includes('>La hora quedó liberada.<'), name + ': says the hour was released');
  check(!html.includes('La sesión agendada para el'), name + ': the lead sentence that restated the slot is gone');
  check(!/>Fecha<\/td>|>Hora<\/td>/.test(html), name + ': FECHA and HORA are no longer labelled rows in the html');
  check(rendered.body.includes('Fecha: miércoles 16 de septiembre de 2026') && rendered.body.includes('Hora: 11:00 (Chile)'),
    name + ': text/plain keeps the long, unambiguous date under its label');
  check(!/>Modalidad<\/td>|>Duración<\/td>|>Valor<\/td>/.test(html) && !/\$50\.000|(?<!\d)50000(?!\d)/.test(both), name + ': hides modality, duration and value');
  check(!/meet\.google\.com|ENTRAR A LA SESIÓN/i.test(both), name + ': hides Meet');
  check(!/manage\.html|open=reschedule|open=cancel|REAGENDAR SESIÓN|CANCELAR SESIÓN|[a-z]{64}/.test(both), name + ': carries no management link or token');
  // The cancellation is the completed job: re-booking is a quiet text link,
  // never a button and never a primary that reads as conversion recovery.
  check(primaryCount(html) === 0 && !html.includes('color:#FFFFFF;">'), name + ': cancelled states have ZERO charcoal primary CTA');
  check(html.includes('>' + REBOOK_LABEL + ' &#8594;</a>') && html.includes('href="https://franciscabustos.cl/reserva"'),
    name + ': the re-booking action remains available at the same destination');
  check(!/AGENDAR NUEVA SESIÓN/.test(html) && !html.includes(SECONDARY) && !html.includes('height="48"'),
    name + ': re-booking is no longer an outline button');
  check((html.match(/min-height:48px/g) || []).length === 0, name + ': the closed states carry no action button at all');
  check(html.includes(HUMAN_CANCEL_COPY) && rendered.body.includes(HUMAN_CANCEL_COPY), name + ': human copy');
  check(rendered.body.includes('RESERVA CANCELADA') && rendered.body.includes('Tu sesión fue cancelada.')
    && rendered.body.includes('La hora quedó liberada.')
    && rendered.body.includes('Agendar nueva sesión: https://franciscabustos.cl/reserva'),
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
for (const [name, rendered] of Object.entries(REFUND_CONFIRMED)) {
  const html = rendered.htmlBody; const body = rendered.body;
  check(html.includes('>RESERVA CANCELADA<') && html.includes('>Tu sesión fue cancelada.<'),
    name + ': cancellation still leads the email');
  check(html.indexOf('>Tu sesión fue cancelada.<') < html.indexOf('>' + CONFIRMED_WHEN + '<')
    && html.indexOf('>' + CONFIRMED_WHEN + '<') < html.indexOf(REFUND_COPY)
    && html.indexOf(REFUND_COPY) < html.indexOf(HUMAN_CANCEL_COPY),
    name + ': the refund block sits under the session details, before the human copy');
  check(html.includes('>REEMBOLSO<'), name + ': the refund information block is labelled REEMBOLSO');
  check(countOf(html, REFUND_COPY) === 1 && countOf(body, REFUND_COPY) === 1,
    name + ': the approved refund copy appears exactly once in html and in text');
  check(body.includes('\nREEMBOLSO\n' + REFUND_COPY), name + ': text/plain carries the labelled refund section');
  check(!/✔|✅|💸|🎉/.test(html), name + ': no icon on the refund block');
}
// ---------------------------------------------------------------------------
// The single refund communication: confirms the REQUEST, never the settlement.
// ---------------------------------------------------------------------------
const SETTLEMENT_CLAIM = /reembolso fue procesado|reembolso fue confirmado|reembolso fue completado|dinero ya fue reembolsado|ya fue reembolsado/i;
for (const [name, rendered] of Object.entries({ REQUESTED: refundRequested, PENDING: refundRequestedPending })) {
  const html = rendered.htmlBody; const body = rendered.body; const both = html + '\n' + body;
  check(rendered.subject === 'Tu solicitud de reembolso fue gestionada', name + ': subject confirms the request');
  check(html.includes('>SOLICITUD DE REEMBOLSO<'), name + ': eyebrow is SOLICITUD DE REEMBOLSO');
  check(html.includes('>Tu solicitud de reembolso fue gestionada.<'), name + ': H1 confirms the request was handled');
  check(both.includes('El abono puede tardar hasta 10 días hábiles en verse reflejado, según tu banco o emisor.'),
    name + ': carries the approved 10-business-day copy verbatim');
  check(!SETTLEMENT_CLAIM.test(both), name + ': never claims the money has already settled');
  // The headline here is about the refund, not the appointment, so the session
  // keeps its label: a bare date under this H1 would be ambiguous.
  check(html.includes('>SESIÓN</span>&nbsp;&nbsp;' + CONFIRMED_WHEN + '</td>'),
    name + ': the session is secondary context behind an explicit SESIÓN label');
  check(!/>Fecha<\/td>|>Hora<\/td>/.test(html) && body.includes('Fecha: miércoles 16 de septiembre de 2026')
    && body.includes('Hora: 11:00 (Chile)'),
    name + ': the labelled rows collapse in html and survive in text/plain');
  check(primaryCount(html) === 0 && !html.includes('color:#FFFFFF;">'), name + ': no primary CTA');
  check(html.includes('>' + REBOOK_LABEL + ' &#8594;</a>') && html.includes('href="https://franciscabustos.cl/reserva"')
    && (html.match(/min-height:48px/g) || []).length === 0,
    name + ': re-booking is a quiet text link, not a button');
  check(!/meet\.google\.com|ENTRAR A LA SESIÓN/i.test(both), name + ': hides Meet');
  check(!/manage\.html|open=reschedule|open=cancel|REAGENDAR SESIÓN|CANCELAR SESIÓN|[a-z]{64}/.test(both),
    name + ': carries no management link or token');
  check(!/\$50\.000|(?<!\d)50000(?!\d)/.test(both) && !/>Modalidad<\/td>|>Duración<\/td>|>Valor<\/td>/.test(html),
    name + ': shows no value, modality or duration');
  check(!/\bflow\b|commerce.?order|provider.?reference|refund_status|BUSINESS_POLICY_TBD|PROVIDER_REFUND|REFUND_CREATE/i.test(both),
    name + ': no Flow vocabulary and no internal codes');
  check(body.includes('Agendar nueva sesión: https://franciscabustos.cl/reserva')
    && body.includes('Fecha: miércoles 16 de septiembre de 2026') && body.includes('Hora: 11:00 (Chile)'),
    name + ': text/plain is equivalent');
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
  check(!html.includes('min-height:48px') && !/Agendar una nueva sesión|ENTRAR A LA SESIÓN|¿Necesitas ayuda\?|wa\.me/.test(html), 'internal alert has no patient CTA and no patient footer');
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
// FRA-9 visual polish — four bounded presentation refinements.
// Presentation only: every destination, token, amount and lifecycle rule below
// is asserted to be the one the approved candidate already shipped.
// ---------------------------------------------------------------------------

// 1 — Meet fallback: one compact line, a named link, same href, no raw URL.
check(T.EMAIL_V4_MEET_FALLBACK_LEAD === MEET_FALLBACK_LEAD && T.EMAIL_V4_MEET_FALLBACK_LABEL === MEET_FALLBACK_LABEL,
  'approved Meet fallback copy is the exact string pair');
for (const [name, rendered] of Object.entries({ CONFIRMED: confirmed, NAMED: confirmedNamed, RESCHEDULED: rescheduled, CLINICIAN: clinicianChange })) {
  const html = rendered.htmlBody;
  check(html.includes('>' + MEET_FALLBACK_LEAD + ' <a href="' + MEET_URL + '"'),
    name + ': the lead and the link share one line, not two rows');
  check(html.includes('>' + MEET_FALLBACK_LABEL + '</a>') && countOf(html, MEET_FALLBACK_LABEL) === 1,
    name + ': "Abrir Google Meet" alone is the link text, and it is stated once');
  check(!FORBIDDEN_LINK_TEXT.test(html), name + ': the link text is never "haz clic aquí"');
  check(!/meet\.google\.com/.test(visibleText(html)),
    name + ': no raw Meet URL is visible anywhere in the rendered text');
  check(countOf(html, 'href="' + MEET_URL + '"') === 2,
    name + ': the unchanged Meet href is still on both the primary button and the fallback link');
  check(html.indexOf('>ENTRAR A LA SESIÓN</a>') < html.indexOf(MEET_FALLBACK_LEAD),
    name + ': the fallback still sits under the primary button it explains');
  check(!html.includes('word-break:break-all'), name + ': the URL-wrapping hack left with the printed URL');
  check(rendered.body.includes('Entrar a la sesión: ' + MEET_URL),
    name + ': text/plain keeps the full URL, which is its only usable destination');
}

// 2 — Reschedule states: the highlight is the single schedule statement, and
// one compact logistics line stands in for the MODALIDAD/DURACIÓN/VALOR rows.
for (const [name, rendered] of Object.entries({ PATIENT_RESCHEDULED: rescheduled, LEAKY_TOKEN: rescheduledLeaky, CLINICIAN_RESCHEDULED: clinicianChange })) {
  const html = rendered.htmlBody; const body = rendered.body;
  check(html.includes('>' + RESCHEDULED_WHEN + '<'), name + ': the WHEN line is rendered');
  check(!/>Fecha<\/td>|>Hora<\/td>/.test(html), name + ': FECHA/HORA are not repeated as rows under the WHEN line');
  check(html.includes('· 15:00 (Chile)</td>'), name + ': the WHEN line carries the explicit Chile zone it owns');
  check(countOf(html, RESCHEDULED_WHEN) === 1,
    name + ': the new date and time have exactly one representation in the html');
  check(!html.includes('miércoles 16 de septiembre de 2026'),
    name + ': the html carries the compact date only; the long form lives in text/plain');
  for (const label of ['Modalidad', 'Duración', 'Valor']) {
    check(!html.includes('>' + label + '</td>'), name + ': the standalone ' + label + ' row is gone from the html');
  }
  check(!/\$50\.000|(?<!\d)50000(?!\d)/.test(html), name + ': VALOR is absent from the html of a reschedule');
  check(countOf(html, LOGISTICS_LINE) === 1,
    name + ': exactly one compact logistics presentation, "' + LOGISTICS_LINE + '"');
  check(html.indexOf('>' + RESCHEDULED_WHEN + '<') < html.indexOf(LOGISTICS_LINE)
    && html.indexOf(LOGISTICS_LINE) < html.indexOf('>ENTRAR A LA SESIÓN</a>'),
    name + ': the logistics line sits between the WHEN line and the Meet primary');
  check(countOf(html, 'href="' + MEET_URL + '"') === 2 && primaryCount(html) === 1,
    name + ': the Meet primary and its href survive the compaction');
  check(html.includes('open=cancel') && TERTIARY_CANCEL.test(html),
    name + ': the cancel capability and its href survive the compaction');
  check(body.includes('Fecha: miércoles 16 de septiembre de 2026') && body.includes('Hora: 15:00 (Chile)')
    && body.includes('Modalidad: Online') && body.includes('Duración: 50 minutos') && body.includes('Entrar a la sesión: ' + MEET_URL),
    name + ': text/plain still carries complete, unambiguous date, time, modality, duration and Meet URL');
}
// The line is composed from the inputs the detail rows already read — the record's
// modality and the canonical session duration — not from a literal of its own.
check(T.emailV4LogisticsLine_(movedRecord) === LOGISTICS_LINE, 'the compact line renders "' + LOGISTICS_LINE + '" for the fixture');
check(T.emailV4LogisticsLine_(baseRecord, true) === CONFIRMED_LOGISTICS_LINE,
  'the confirmation line appends the transaction value: "' + CONFIRMED_LOGISTICS_LINE + '"');
// The amount is what THIS transaction was worth, never today's catalog price.
check(T.emailV4LogisticsLine_(amountRecord, true) === 'Online · 50 minutos · $38.000',
  'the value half is read from the record\'s persisted transaction amount');
check(T.emailV4LogisticsLine_({ modality: 'presencial' }) === 'presencial · ' + T.emailV4SessionDurationLabel_()
  && T.emailV4LogisticsLine_({}) === T.emailV4SessionDurationLabel_(),
  'the modality half is read from the record, never assumed');
check(T.emailV4SessionDurationLabel_() === '50 minutos' && confirmed.body.includes('Duración: ' + T.emailV4SessionDurationLabel_()),
  'the duration half is the same canonical label the detail rows use');
// The confirmation shows no superseded time: nothing has been superseded.
check(!confirmed.htmlBody.includes('>ANTES</span>') && confirmed.htmlBody.includes('>' + CONFIRMED_WHEN + '<'),
  'confirmation renders the WHEN line alone, with no ANTES comparison');
// Every patient state states its appointment once, on one line, and nowhere else.
for (const [name, rendered] of Object.entries({
  BOOKING_CONFIRMED: confirmed, SESSION_CANCELLED: cancelled, REFUNDED: cancelledRefunded, REFUND_REQUESTED: refundRequested,
})) {
  const html = rendered.htmlBody;
  check(countOf(html, CONFIRMED_WHEN) === 1, name + ': the appointment is stated exactly once in the html');
  check(!/>Fecha<\/td>|>Hora<\/td>/.test(html), name + ': no labelled FECHA/HORA rows survive anywhere');
  check(rendered.body.includes('Fecha: miércoles 16 de septiembre de 2026') && rendered.body.includes('Hora: 11:00 (Chile)'),
    name + ': text/plain still carries the long, unambiguous date and time');
}

// 3 — Re-booking after a closed state: quiet link, never a button or a CTA.
check(T.EMAIL_V4_REBOOK_LABEL === REBOOK_LABEL, 'approved re-booking label is the exact string');
const REBOOK_ANCHOR = '>' + REBOOK_LABEL + ' &#8594;</a>';
for (const [name, rendered] of Object.entries({
  SESSION_CANCELLED: cancelled, REJECTED_REFUND: cancelledRejected, LATE: cancelledLate, MISROUTED: cancelledMisrouted,
  PATIENT_CANCELLED_REFUNDED: cancelledRefunded, CLINICIAN_CANCELLED_REFUNDED: cancelledClinicianRefunded,
  REFUND_REQUESTED: refundRequested, REFUND_REQUESTED_PENDING: refundRequestedPending,
})) {
  const html = rendered.htmlBody;
  check(html.includes(REBOOK_ANCHOR), name + ': re-booking renders as the approved sentence-case link with an arrow');
  check(countOf(html, 'href="https://franciscabustos.cl/reserva"') === 1,
    name + ': the re-booking destination is unchanged and appears exactly once');
  check(primaryCount(html) === 0 && !html.includes(SECONDARY) && !html.includes('height="48"') && !html.includes('min-height:48px'),
    name + ': re-booking is neither a primary nor an outline button');
  check(!/AGENDAR NUEVA SESIÓN/.test(html) && !/text-transform:uppercase;[^"]*">Agendar/.test(html),
    name + ': re-booking is not shouted in uppercase button type');
  check(html.indexOf(HUMAN_CANCEL_COPY) < html.indexOf(REBOOK_ANCHOR) && html.indexOf(REBOOK_ANCHOR) < html.indexOf('¿Necesitas ayuda?'),
    name + ': re-booking sits after the supportive copy and before the footer');
  check(html.includes('display:block;padding:14px 0;line-height:20px'), name + ': the quiet link keeps a 48px block target');
  check(rendered.body.includes('Agendar nueva sesión: https://franciscabustos.cl/reserva'),
    name + ': text/plain re-booking destination is unchanged');
}

// 4 — No generic greeting; the personal one survives when a name is supplied.
check(T.emailV4Greeting_({}) === '' && T.emailV4Greeting_({ patient_first_name: '   ' }) === ''
  && T.emailV4Greeting_(null) === '', 'a missing or blank name yields no greeting at all');
check(T.emailV4Greeting_({ patient_first_name: 'Ana Sofía' }) === 'Hola, Ana'
  && T.emailV4Greeting_({ patient_name: 'Ana Sofía Rojas' }) === 'Hola, Ana',
  'a supplied name still yields the personal greeting from the first token');
for (const [name, rendered] of Object.entries(allStates)) {
  if (name === 'BOOKING_CONFIRMED_NAMED') continue;
  check(!/(^|\n)\s*Hola,\s*(\n|$)/.test(visibleText(rendered.htmlBody)) && !/^Hola,$/m.test(rendered.body),
    name + ': the bare "Hola," greeting is never rendered');
  check(!/;"><\/td>/.test(rendered.htmlBody), name + ': no empty body row is left where the greeting used to be');
}
{
  const leadRow = (html, needle) => html.slice(html.lastIndexOf('<tr><td', html.indexOf(needle)), html.indexOf(needle));
  const html = confirmedNamed.htmlBody;
  check(html.includes('>Hola, Ana</td>') && confirmedNamed.body.includes('\nHola, Ana\n'),
    'a named record renders the personal greeting in html and text');
  check(html.indexOf('>Tu sesión está confirmada.<') < html.indexOf('>Hola, Ana</td>')
    && html.indexOf('>Hola, Ana</td>') < html.indexOf('>' + CONFIRMED_WHEN + '<'),
    'the personal greeting sits between the H1 and the WHEN line');
  // One 16px step under the H1 whether or not a name was available.
  check(/padding:16px 28px 0 28px/.test(leadRow(confirmed.htmlBody, CONFIRMED_WHEN)),
    'nameless confirmation: the WHEN line takes the 16px step under the H1');
  check(/padding:16px 28px 0 28px/.test(leadRow(html, '>Hola, Ana</td>')),
    'named confirmation: the greeting takes the same 16px step');
  check(confirmedNamed.subject === confirmed.subject
    && countOf(html, 'href="' + MEET_URL + '"') === countOf(confirmed.htmlBody, 'href="' + MEET_URL + '"'),
    'the greeting changes nothing but the greeting');
}

// ---------------------------------------------------------------------------
// FRA-9 V4.1 — compaction, information architecture, dark-mode resilience.
// Presentation only. Every destination, token, amount, cutoff and lifecycle rule
// below is asserted to be the one the approved V4 candidate already shipped.
// ---------------------------------------------------------------------------

// 1 — The chip adds context, the H1 carries the human message, and the two never
// state the same proposition. V4 shipped "TU SESIÓN FUE REAGENDADA" directly
// above "Tu sesión fue reagendada." — the same sentence twice, once shouted.
const chipOf = (html) => { const m = html.match(/class="v4-chip-[a-z]+" bgcolor="[^"]*"[^>]*>([^<]+)<\/td>/); return m ? m[1] : ''; };
const headlineOf = (html) => { const m = html.match(/class="v4-pad v4-h1 v4-ink"[^>]*>([^<]+)<\/td>/); return m ? m[1] : ''; };
// Case, accents and punctuation are stripped, so "shouted" is not a way around
// the rule: only a genuinely different proposition passes.
const proposition = (text) => String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
let duplications = 0;
for (const [name, rendered] of Object.entries(allStates)) {
  const chip = chipOf(rendered.htmlBody); const headline = headlineOf(rendered.htmlBody);
  check(Boolean(chip) && Boolean(headline), name + ': renders both a status chip and a headline');
  if (proposition(chip) === proposition(headline)) duplications += 1;
  check(proposition(chip) !== proposition(headline),
    name + ': chip and H1 state different propositions ("' + chip + '" / "' + headline + '")');
}
check(duplications === 0, 'EYEBROW_H1_DUPLICATION=0 across every rendered state');
check(chipOf(rescheduled.htmlBody) === 'NUEVA FECHA CONFIRMADA', 'the rescheduled chip is NUEVA FECHA CONFIRMADA');
check(chipOf(confirmed.htmlBody) === 'RESERVA CONFIRMADA' && chipOf(cancelled.htmlBody) === 'RESERVA CANCELADA'
  && chipOf(clinicianChange.htmlBody) === 'CAMBIO DE HORARIO' && chipOf(genericState.htmlBody) === 'AVISO OPERATIVO',
  'each state carries its own context word, and none of them is its own headline');

// 2 — No lead sentence restates a fact the WHEN line already carries.
for (const [name, rendered] of Object.entries(allStates)) {
  for (const lead of RETIRED_LEADS) {
    check(!rendered.htmlBody.includes(lead), name + ': the retired lead "' + lead.slice(0, 36) + '…" is gone from the html');
  }
}

// 3 — The WHEN line is derived, never composed by hand, and it reads the same
// short-date helper the subject reads, so body and subject cannot drift.
check(T.emailV4WhenLine_(T.lifecycleEmailDateParts_(ORIGINAL_START)) === CONFIRMED_WHEN
  && T.emailV4WhenLine_(T.lifecycleEmailDateParts_(CURRENT_START)) === RESCHEDULED_WHEN
  && T.emailV4WhenLine_(T.lifecycleEmailDateParts_(ORIGINAL_START), false) === SUPERSEDED_WHEN,
  'the WHEN line is composed from the canonical date parts plus the short-date helper');
check(T.emailV4WhenLine_(T.lifecycleEmailDateParts_('garbage')) === '' && T.emailV4WhenLine_(null) === '',
  'an underivable instant yields no WHEN line rather than a wrong one');
check(confirmed.subject.includes('mié 16 sep') && CONFIRMED_WHEN.indexOf('Mié 16 sep') === 0,
  'the compact body date and the subject date come from the one helper');

// 4 — The policy reminder is composed from the enforced cutoff. Shifting the
// canonical constant must move the rendered copy with it, in html and in text.
check(POLICY_COPY.includes(String(context.PATIENT_MANAGEMENT_CUTOFF_HOURS)),
  'the expected copy states the cutoff the runtime actually enforces');
{
  const shifted = build({ '../Lifecycle.js': [['var PATIENT_MANAGEMENT_CUTOFF_HOURS = 24;', 'var PATIENT_MANAGEMENT_CUTOFF_HOURS = 12;']] });
  check(shifted.__EMAIL_TEMPLATE_TEST_EXPORTS__.emailV4ManagementPolicyCopy_()
    === 'Puedes reagendar o cancelar hasta 12 horas antes de tu sesión.',
    'the policy copy is composed from the canonical constant, not a duplicated literal');
  const shiftedConfirmed = renderWith(shifted)('BOOKING_CONFIRMED', baseRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
  check(shiftedConfirmed.htmlBody.includes('hasta 12 horas') && !shiftedConfirmed.htmlBody.includes('hasta 24 horas')
    && shiftedConfirmed.body.includes('hasta 12 horas'),
    'a change to the enforced cutoff moves the rendered reminder with it');
}

// 5 — Dark-mode resilience lives in the palette, not in a client-specific hack.
{
  const html = confirmed.htmlBody;
  check(T.EMAIL_V4.surface === '#F2F1EF' && T.EMAIL_V4.paper === '#FFFFFF' && T.EMAIL_V4.border === '#E4E1DC',
    'V4.1 grounds: near-neutral page, white card, warm-neutral border');
  check(T.EMAIL_V4.cream === undefined, 'the cream ground token is retired, not merely unused');
  check(T.EMAIL_V4.sand === '#DCCBB9' && T.EMAIL_V4.taupe === '#A89E93' && T.EMAIL_V4.link === '#8C6B52'
    && T.EMAIL_V4.cancelAccent === '#8C4F4B',
    'the warmth that remains is accent-only: the sand rule, the taupe outline, the link, the destructive accent');
  check(html.includes('bgcolor="#F2F1EF" style="width:100%;background-color:#F2F1EF;'), 'the page ground is the neutral surface');
  check(html.includes('bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;'), 'the card ground is white');
  for (const rule of ['.v4-page{background-color:#F2F1EF !important;}', '.v4-card{background-color:#FFFFFF !important;}',
    '.v4-chip-ok{background-color:#E6EDE6 !important;color:#3F5C45 !important;}',
    '.v4-chip-neutral{background-color:#EDEBE7 !important;color:#2F3236 !important;}',
    '.v4-chip-cancel{background-color:#F6E6E6 !important;color:#8C4F4B !important;}']) {
    check(html.includes(rule), 'the dark block restates its own pair: "' + rule + '"');
  }
  check(!/-webkit-filter|mix-blend-mode|\[data-ogsc\]|\[data-ogsb\]/i.test(html),
    'no client-specific dark-mode hack: the resilience is in the palette');
  check((html.match(/class="v4-chip-[a-z]+"/g) || []).length === 1,
    'the confirmed state carries exactly one small status chip');
  check(html.includes('<meta name="color-scheme" content="light">'), 'the email still declares itself light-scheme');
}
// The success state is a small restrained accent, never a large tinted block.
check(T.EMAIL_V4.successBg === '#E6EDE6' && T.EMAIL_V4.successAccent === '#3F5C45',
  'the success accent pair is the restrained V4.1 one');
check(!confirmed.htmlBody.includes('padding:12px 28px;background-color:'),
  'the full-width status band is gone from the confirmation');

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
    ["const released = when ? 'La hora quedó liberada.'", "const released = when ? 'Tu reembolso está en proceso.'"]],
    (ctx) => { const r = renderWith(ctx)('SESSION_CANCELLED', rejectedRecord, {}, null); return /en proceso|reembolso/i.test(r.htmlBody) ? 'en_proceso_claimed_after_rejection' : null; }],
  ['MUTATION_REFUND_CLAIM_WITHOUT_REFUNDED_RECORD', [["return confirmedEvent && String(record && record.refund_status || '') === LIFECYCLE.REFUND_STATUS.REFUNDED;", 'return confirmedEvent;']],
    (ctx) => { const r = renderWith(ctx)('PATIENT_CANCELLED', rejectedRecord, {}, null); return /REEMBOLSO/.test(r.htmlBody + r.body) || ECONOMIC.test(r.htmlBody + r.body) ? 'refund_claimed_on_rejected_record' : null; }],
  ['MUTATION_REFUND_PROMOTED_TO_H1', [["emailV4Headline_('Tu sesión fue cancelada.')", "emailV4Headline_('Tu reembolso fue confirmado.')"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_CANCELLED', refundedRecord, {}, null); return !r.htmlBody.includes('>Tu sesión fue cancelada.<') ? 'refund_promoted_over_cancellation_h1' : null; }],
  ['MUTATION_CANCELLED_PRIMARY_REBOOK_CTA', [["emailV4QuietActionRow_(emailV4BookingUrl_(origin), EMAIL_V4_REBOOK_LABEL, 8)", "emailV4PrimaryRow_(emailV4BookingUrl_(origin), EMAIL_V4_REBOOK_LABEL)"]],
    (ctx) => { const r = renderWith(ctx)('SESSION_CANCELLED', pendingRecord, {}, null); return primaryCount(r.htmlBody) > 0 ? 'charcoal_primary_on_cancelled' : null; }],
  // --- FRA-9 visual polish: one mutation per refinement --------------------
  ['MUTATION_RAW_MEET_URL_PRINTED', [
    [";text-decoration:underline;\">' + EMAIL_V4_MEET_FALLBACK_LABEL + '</a></td></tr>'", ";text-decoration:underline;\">' + escapeEmailText_(meetUrl) + '</a></td></tr>'"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return /meet\.google\.com/.test(visibleText(r.htmlBody)) ? 'raw_meet_url_visible_again' : null; }],
  ['MUTATION_WHEN_LINE_DUPLICATED_AS_ROWS', [
    ["        + whenRow\n        + logisticsRow",
      "        + whenRow\n        + emailV4Details_(emailV4ScheduleRows_(parts))\n        + logisticsRow"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN }); return r.htmlBody.includes(RESCHEDULED_WHEN) && />Fecha<\/td>/.test(r.htmlBody) ? 'fecha_hora_duplicated_under_the_when_line' : null; }],
  ['MUTATION_WHEN_LINE_DROPS_TIME_ZONE', [["const zone = withZone === false ? '' : ' (Chile)';", "const zone = '';"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN }); return !/\(Chile\)/.test(r.htmlBody) ? 'reschedule_html_lost_the_time_zone' : null; }],
  ['MUTATION_REBOOK_BUTTON_RESTORED', [["emailV4QuietActionRow_(emailV4BookingUrl_(origin), EMAIL_V4_REBOOK_LABEL, 8)", "emailV4SecondaryRow_(emailV4BookingUrl_(origin), EMAIL_V4_REBOOK_LABEL, 24)"]],
    (ctx) => { const r = renderWith(ctx)('REFUND_REQUESTED', refundRequestedRecord, {}, null); return /min-height:48px/.test(r.htmlBody) ? 'rebooking_became_a_button_again' : null; }],
  ['MUTATION_GENERIC_GREETING_RESTORED', [["return first ? 'Hola, ' + first : '';", "return first ? 'Hola, ' + first : 'Hola,';"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return /(^|\n)\s*Hola,\s*(\n|$)/.test(visibleText(r.htmlBody)) ? 'bare_hola_greeting_restored' : null; }],
  ['MUTATION_NAMED_GREETING_DROPPED', [["return first ? 'Hola, ' + first : '';", "return '';"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', namedRecord, { CANCEL: CANCEL_TOKEN }); return !r.htmlBody.includes('>Hola, Ana</td>') ? 'personal_greeting_lost_when_name_exists' : null; }],
  ['MUTATION_REMOTE_FONT_DEPENDENCY', [["+ emailV4Style_()\n    + '</head>'", "+ emailV4Style_()\n    + '<link href=\"https://fonts.googleapis.com/css2?family=Fraunces\" rel=\"stylesheet\">'\n    + '</head>'"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return /fonts\.googleapis\.com|<link/i.test(r.htmlBody) ? 'remote_font_loaded' : null; }],
  ['MUTATION_LABEL_BELOW_FLOOR', [["font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.16em;", "font-size:10px;font-weight:600;line-height:1.4;letter-spacing:.16em;"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return /font-size:(8|9|10|11)px/.test(r.htmlBody) ? 'label_below_12px' : null; }],
  // --- FRA-9 content compaction: one mutation per compacted rule ------------
  ['MUTATION_RETIRED_SUPPORTIVE_CLAUSE_RESTORED', [
    ["var EMAIL_V4_SESSION_COPY = 'No necesitas preparar nada especial para la sesión.';",
      "var EMAIL_V4_SESSION_COPY = 'No necesitas preparar nada especial para la sesión. "
      + "Puedes llegar con lo que tengas hoy, aunque todavía sea difícil ponerlo en palabras.';"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return r.htmlBody.includes(DROPPED_SESSION_CLAUSE) || r.body.includes(DROPPED_SESSION_CLAUSE) ? 'retired_supportive_clause_restored' : null; }],
  ['MUTATION_MEET_CTA_PUSHED_BELOW_THE_REFERENCE_LINE', [
    ["        + logisticsRow\n        + emailV4PrimaryRow_(meetUrl, 'ENTRAR A LA SESIÓN')",
      "        + emailV4PrimaryRow_(meetUrl, 'ENTRAR A LA SESIÓN')\n        + logisticsRow"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }); return r.htmlBody.indexOf(CONFIRMED_LOGISTICS_LINE) > r.htmlBody.indexOf('>ENTRAR A LA SESIÓN</a>') ? 'reference_line_pushed_below_the_cta' : null; }],
  ['MUTATION_CONFIRMATION_LOSES_THE_WHEN_LINE', [
    ["    const whenRow = emailV4WhenRow_(emailV4WhenLine_(parts), true, previousRow ? 4 : 16);",
      "    const whenRow = previousRow ? emailV4WhenRow_(emailV4WhenLine_(parts), true, 4) : '';"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return !r.htmlBody.includes(CONFIRMED_WHEN) ? 'confirmation_no_longer_says_when_the_session_is' : null; }],
  ['MUTATION_VALOR_RESTORED_ON_RESCHEDULE', [
    ["emailV4LogisticsLineRow_(emailV4LogisticsLine_(record, kind === 'confirmed'));",
      "emailV4LogisticsLineRow_(emailV4LogisticsLine_(record, true));"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN }); return /\$50\.000/.test(r.htmlBody) ? 'valor_restored_in_reschedule_html' : null; }],
  ['MUTATION_VALOR_DROPPED_FROM_THE_CONFIRMATION', [
    ["emailV4LogisticsLineRow_(emailV4LogisticsLine_(record, kind === 'confirmed'));",
      "emailV4LogisticsLineRow_(emailV4LogisticsLine_(record, false));"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN }); return !/\$50\.000/.test(r.htmlBody) ? 'confirmation_stopped_being_the_receipt' : null; }],
  ['MUTATION_LOGISTICS_LINE_HARDCODED', [
    ["return [emailV4ModalityLabel_(record), emailV4SessionDurationLabel_(),\n    includeAmount ? emailV4AmountLabel_(record) : '']\n    .filter(function(part) { return Boolean(part); }).join(' · ');",
      "return 'Online · 50 minutos' + (includeAmount ? ' · $50.000' : '');"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_RESCHEDULED', Object.assign({}, movedRecord, { modality: 'presencial' }), { CANCEL: CANCEL_TOKEN }); return r.htmlBody.includes('Online · 50 minutos') ? 'logistics_line_ignored_the_record_modality' : null; }],
  ['MUTATION_AMOUNT_HARDCODED_IN_THE_COMPACT_LINE', [
    ["includeAmount ? emailV4AmountLabel_(record) : '']", "includeAmount ? '$50.000' : '']"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', amountRecord, { CANCEL: CANCEL_TOKEN }); return r.htmlBody.includes('$50.000') && !r.htmlBody.includes('$38.000') ? 'amount_stopped_tracking_the_persisted_transaction' : null; }],
  ['MUTATION_LOGISTICS_LINE_DRIFTS_FROM_CANONICAL_DURATION', [
    ["const minutes = typeof SESSION_DURATION_MINUTES === 'number' ? SESSION_DURATION_MINUTES : 0;",
      "const minutes = 99;"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN }); return r.htmlBody.includes('Online · 99 minutos') ? 'compact_line_tracks_the_canonical_duration_helper' : null; }],
  // --- FRA-9 V4.1: one mutation per new rule -------------------------------
  ['MUTATION_CHIP_RESTATES_THE_HEADLINE', [["      eyebrow = 'NUEVA FECHA CONFIRMADA';", "      eyebrow = 'TU SESIÓN FUE REAGENDADA';"]],
    (ctx) => { const r = renderWith(ctx)('PATIENT_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN });
      return proposition(chipOf(r.htmlBody)) === proposition(headlineOf(r.htmlBody)) ? 'chip_and_h1_state_the_same_proposition' : null; }],
  ['MUTATION_VERBOSE_MEET_FALLBACK_RESTORED', [
    ["var EMAIL_V4_MEET_FALLBACK_LABEL = 'Abrir Google Meet';", "var EMAIL_V4_MEET_FALLBACK_LABEL = 'Abrir enlace alternativo de Google Meet';"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN });
      return r.htmlBody.includes(RETIRED_MEET_FALLBACK_LABEL) ? 'verbose_two_row_fallback_label_restored' : null; }],
  ['MUTATION_MEET_LINK_BECOMES_CLICK_HERE', [
    ["var EMAIL_V4_MEET_FALLBACK_LABEL = 'Abrir Google Meet';", "var EMAIL_V4_MEET_FALLBACK_LABEL = 'haz clic aquí';"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN });
      return FORBIDDEN_LINK_TEXT.test(r.htmlBody) ? 'link_text_lost_its_destination' : null; }],
  ['MUTATION_FULL_WIDTH_STATUS_BAND_RESTORED', [
    ["  return '<tr><td class=\"v4-pad\" style=\"padding:24px 28px 0 28px;\">'\n    + '<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>'\n    + '<td class=\"' + (cssClass || 'v4-chip-neutral') + '\" bgcolor=\"' + background",
      "  return '<tr><td style=\"height:24px;line-height:24px;font-size:0;\">&nbsp;</td></tr>'\n    + '<tr><td class=\"v4-pad ' + (cssClass || 'v4-chip-neutral') + '\" bgcolor=\"' + background"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN });
      return /<td class="v4-pad[^"]*" bgcolor=/.test(r.htmlBody) ? 'full_width_tinted_band_restored' : null; }],
  ['MUTATION_CREAM_GROUNDS_RESTORED', [["  surface: '#F2F1EF',\n  paper: '#FFFFFF',", "  surface: '#FFF7F2',\n  paper: '#FFFCF9',"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { CANCEL: CANCEL_TOKEN });
      return RETIRED_V4_SURFACES.test(r.htmlBody) ? 'large_warm_surfaces_restored' : null; }],
  ['MUTATION_POLICY_COPY_STOPS_READING_THE_CANONICAL_CUTOFF', [
    ["'Puedes reagendar o cancelar hasta ' + PATIENT_MANAGEMENT_CUTOFF_HOURS", "'Puedes reagendar o cancelar hasta ' + 48"]],
    (ctx) => { const r = renderWith(ctx)('BOOKING_CONFIRMED', baseRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
      return r.htmlBody.includes('hasta 48 horas') ? 'policy_copy_drifted_from_the_enforced_cutoff' : null; }],
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
  'refund-requested': refundRequested,
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
