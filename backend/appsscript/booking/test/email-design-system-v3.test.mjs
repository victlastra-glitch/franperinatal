/**
 * FRAN_EMAIL_DESIGN_SYSTEM_V3 contract — Editorial Clinical Human.
 *
 * Focused, deterministic, no-network. Renders the patient lifecycle states from
 * synthetic data, asserts the V3 contract, and writes the reviewable preview
 * fixtures under test/fixtures/email-preview/.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const files = ['../Code.js', '../Lifecycle.js', '../EmailTemplates.js'];
const sources = await Promise.all(files.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
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
for (const source of sources) vm.runInContext(source, context);

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };

// ---------------------------------------------------------------------------
// Synthetic fixtures. Production-canonical values only.
// ---------------------------------------------------------------------------
const MEET_URL = 'https://meet.google.com/opaque-meet';
const RESCHEDULE_TOKEN = 'r'.repeat(64);
const CANCEL_TOKEN = 'c'.repeat(64);
const ORIGINAL_START = '2026-09-03T17:00:00.000Z'; // jueves 3 de septiembre de 2026, 13:00 (Chile)
const CURRENT_START = '2026-09-04T18:00:00.000Z';  // viernes 4 de septiembre de 2026, 14:00 (Chile)

const baseRecord = {
  reservation_id: 'fran-booking-reservation-synthetic',
  service_type: 'initial', modality: 'online', booking_status: 'confirmed',
  original_start_at: ORIGINAL_START, current_start_at: ORIGINAL_START, current_end_at: '2026-09-03T17:50:00.000Z',
};
const movedRecord = Object.assign({}, baseRecord, {
  current_start_at: CURRENT_START, current_end_at: '2026-09-04T18:50:00.000Z',
});

const render = (eventType, record, tokens, meet) => context.renderLifecycleNotificationEmail_({
  notification: { eventType, meet: meet === undefined ? { meetUrl: MEET_URL } : meet },
  record, capabilityTokens: tokens || {}, previewOrigin: origin,
});

const confirmed = render('BOOKING_CONFIRMED', baseRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
const confirmedFollowup = render('BOOKING_CONFIRMED', Object.assign({}, baseRecord, { service_type: 'followup' }),
  { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
const confirmedNoMeet = render('BOOKING_CONFIRMED', Object.assign({}, baseRecord, { modality: 'presencial' }),
  { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }, null);
const rescheduled = render('PATIENT_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN });
// A revoked-but-still-supplied RESCHEDULE token must not resurrect the action.
const rescheduledLeaky = render('PATIENT_RESCHEDULED', movedRecord,
  { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN });
const clinicianChange = render('CLINICIAN_RESCHEDULED', movedRecord, { CANCEL: CANCEL_TOKEN });
const cancelled = render('SESSION_CANCELLED', baseRecord, {}, null);
const cancelledPatient = render('PATIENT_CANCELLED', baseRecord, { RESCHEDULE: RESCHEDULE_TOKEN, CANCEL: CANCEL_TOKEN }, null);
const cancelledClinician = render('CLINICIAN_CANCELLED', baseRecord, {}, null);
const internal = render('REFUND_FAILED_MANUAL_REVIEW', Object.assign({}, baseRecord, {
  payment_status: 'paid', refund_status: 'manual_review', refund_last_error_code: 'BUSINESS_POLICY_TBD',
}), {}, null);

const patientStates = {
  BOOKING_CONFIRMED: confirmed,
  BOOKING_CONFIRMED_FOLLOWUP: confirmedFollowup,
  BOOKING_CONFIRMED_NO_MEET: confirmedNoMeet,
  PATIENT_RESCHEDULED: rescheduled,
  CLINICIAN_RESCHEDULED: clinicianChange,
  SESSION_CANCELLED: cancelled,
  PATIENT_CANCELLED: cancelledPatient,
  CLINICIAN_CANCELLED: cancelledClinician,
};

// ---------------------------------------------------------------------------
// Global V3 contract
// ---------------------------------------------------------------------------
const V2_MALVA = /#8A5A6B|#6D4454|#C9A8B3|#FAF6F0|#FDFBF7|#231F1C|#5A534D|#8A8178|#E5DED1/i;
const SPACING_SCALE = new Set([0, 4, 8, 12, 16, 24, 28, 32, 40, 48]);
const TYPE_SCALE = new Set([0, 1, 8, 9, 10, 12, 14, 16, 20, 22, 30, 38]);
const MARKETING = /instagram|linkedin|testimoni|s[ií]guenos|reserva ya|oferta|descuento|diagn[oó]stico|trastorno|cura|garantiz/i;

for (const [name, rendered] of Object.entries(Object.assign({}, patientStates, { REFUND_FAILED_MANUAL_REVIEW: internal }))) {
  const html = rendered.htmlBody;
  const text = rendered.body;
  const both = html + '\n' + text;

  check(Boolean(rendered.subject && text && html), name + ': subject + text/plain + html all exist');
  check(html.includes('FRANCISCA BUSTOS M.') && text.includes('FRANCISCA BUSTOS M.'),
    name + ': principal wordmark is FRANCISCA BUSTOS M.');
  check(html.includes('PSICOLOGÍA PERINATAL') && text.includes('PSICOLOGÍA PERINATAL'),
    name + ': descriptor PSICOLOGÍA PERINATAL present in html and text');
  check(!/Francisca Bustos<|>Francisca Bustos<|alt="Francisca Bustos"|>fb</.test(html),
    name + ': no V2 "Francisca Bustos" / "fb" principal signature');
  check(html.includes('max-width:600px'), name + ': max-width is 600px');
  check(html.includes('font-size:16px'), name + ': 16px body type is present');

  // Zero image dependency.
  check(!/<img|background-image|url\(/i.test(html), name + ': renders with zero images');
  check(!/<img/i.test(html) || /<img[^>]*\salt=/i.test(html), name + ': any image would carry alt');
  check(!/<svg|<script|<form|<input|onclick=|javascript:/i.test(html),
    name + ': no SVG, JS, forms, or inline handlers');
  check(!/display:\s*grid|display:\s*flex|grid-template|flex-direction/i.test(html),
    name + ': no CSS Grid or Flexbox structural dependency');
  check(!/box-shadow|text-shadow|filter:|backdrop-filter/i.test(html), name + ': no shadows or glass effects');
  check(!/linear-gradient|radial-gradient/i.test(html), name + ': no gradients');
  check(!V2_MALVA.test(html), name + ': no V2 malva/legacy palette');
  check(!MARKETING.test(both), name + ': no marketing, testimonial, or diagnostic claims');

  // Radius, spacing, and type scales.
  const radii = [...html.matchAll(/border-radius:(\d+)px/g)].map((match) => Number(match[1]));
  check(radii.length > 0 && radii.every((value) => value <= 4), name + ': no radius above 4px');
  check(!/border-radius:(8|16)px/.test(html), name + ': no V2 8px/16px radius');
  const spacing = [...html.matchAll(/padding(?:-top|-bottom|-left|-right)?:([^;"]+)/g)]
    .flatMap((match) => match[1].trim().split(/\s+/))
    .map((token) => token.replace(/\s*!important$/, ''))
    .filter((token) => /^\d+px$/.test(token))
    .map((token) => Number(token.replace('px', '')));
  const offScale = [...new Set(spacing)].filter((value) => !SPACING_SCALE.has(value));
  check(offScale.length === 0, name + ': spacing uses the V3 scale only (off-scale: ' + offScale.join(',') + ')');
  const sizes = [...new Set([...html.matchAll(/font-size:(\d+)px/g)].map((match) => Number(match[1])))];
  const offType = sizes.filter((value) => !TYPE_SCALE.has(value));
  check(offType.length === 0, name + ': type uses the V3 scale only (off-scale: ' + offType.join(',') + ')');

  // Typography stacks must survive with no webfont loaded.
  check(html.includes("'Cormorant Garamond', Georgia, 'Times New Roman', serif"),
    name + ': display stack falls back to Georgia');
  check(html.includes("'DM Sans', Arial, Helvetica, sans-serif"), name + ': UI stack falls back to Arial');
  check(!/@import|fonts\.googleapis\.com|<link/i.test(html), name + ': does not depend on a webfont request');

  // Robust email HTML.
  check(/<table role="presentation"/.test(html), name + ': uses presentation tables');
  check(html.includes('cellpadding="0" cellspacing="0" border="0"'), name + ': Outlook-safe table attributes');
  check(html.includes('<meta name="color-scheme" content="light">')
    && html.includes('prefers-color-scheme:dark'), name + ': declares a colour scheme and a dark-mode block');
  check(html.includes('@media only screen and (max-width:599px)'), name + ': ships a simple mobile media query');
  check(!/href="\/|href="\.\.?\//.test(html), name + ': links are absolute');
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  check(hrefs.every((href) => /^(https:\/\/|mailto:)/.test(href)),
    name + ': every href is absolute HTTPS or mailto');
  check(name === 'REFUND_FAILED_MANUAL_REVIEW' ? hrefs.length === 0 : hrefs.length > 0,
    name + ': patient states link out; the internal notification does not');
  check(text.length > 200 && !/<[a-z]/i.test(text), name + ': text/plain is a real plain-text equivalent');
}

// One hidden preheader per state, real copy, not a headline duplicate.
const preheaderOf = (html) => {
  const match = html.match(/<div style="display:none;[^"]*">([^<]*)<\/div>/);
  return match ? match[1] : '';
};
check(preheaderOf(confirmed.htmlBody) === 'Fecha, hora y enlace para entrar a tu sesión.',
  'confirmed preheader is the exact V3 string');
check(preheaderOf(rescheduled.htmlBody) === 'Revisa tu nueva fecha y el enlace de la sesión.',
  'rescheduled preheader is the exact V3 string');
check(preheaderOf(cancelled.htmlBody) === 'Confirmación de cancelación de tu sesión.',
  'cancelled preheader is the exact V3 string');
for (const [name, rendered] of Object.entries(patientStates)) {
  const preheader = preheaderOf(rendered.htmlBody);
  check(preheader && !rendered.htmlBody.includes('>' + preheader + '</td>'),
    name + ': preheader is hidden text, not the visible headline');
}

// Buttons.
const PRIMARY = 'background-color:#2F3236;border:1px solid #2F3236;border-radius:2px';
const SECONDARY = 'background-color:#FFFCF9;border:1px solid #A89E93;border-radius:2px';
for (const [name, rendered] of Object.entries(patientStates)) {
  const html = rendered.htmlBody;
  const primaries = (html.match(/background-color:#2F3236;border:1px solid #2F3236/g) || []).length;
  check(primaries <= 1, name + ': at most one primary action');
  if (html.includes('min-height:48px')) {
    check(html.includes('min-height:48px;line-height:48px') && html.includes('height="48"'),
      name + ': CTA target is 48px in CSS-aware clients and in the Outlook table box');
    check(!html.includes('min-height:44px'), name + ': no V2 44px target');
    check(html.includes('letter-spacing:.18em;text-transform:uppercase'), name + ': button type is 12/600/.18em uppercase');
    check(html.includes('font-size:12px;font-weight:600'), name + ': button type is 12px 600');
  }
  check(!html.includes('color:#FFFFFF;">') || html.includes(PRIMARY), name + ': white button text only on the charcoal primary');
}
check(confirmed.htmlBody.includes(PRIMARY) && confirmed.htmlBody.includes(SECONDARY),
  'confirmed renders the charcoal primary and the paper/taupe secondary');
check(confirmed.htmlBody.includes('class="v3-col" width="50%" valign="top" style="width:50%;padding:0 4px 0 0;"')
  && confirmed.htmlBody.includes('class="v3-col v3-col-last" width="50%" valign="top" style="width:50%;padding:0 0 0 4px;"'),
  'two secondary actions share a 50/50 desktop row with a 4+4=8px gutter');
check(confirmed.htmlBody.includes('.v3-col{display:block !important;width:100% !important;padding:0 0 8px 0 !important;}')
  && confirmed.htmlBody.includes('.v3-col-last{padding:0 !important;}'),
  'secondary actions stack full-width with an 8px gap on mobile');
check(confirmed.htmlBody.includes('color:#8C6B52;text-decoration:underline'), 'textual links are #8C6B52 and underlined');

// Layout.
check(confirmed.htmlBody.includes('class="v3-outer" align="center" style="padding:24px;"')
  && confirmed.htmlBody.includes('.v3-outer{padding:12px !important;}'), 'outer padding is 24 desktop / 12 mobile');
check(confirmed.htmlBody.includes('padding:28px 28px 0 28px')
  && confirmed.htmlBody.includes('.v3-pad{padding-left:16px !important;padding-right:16px !important;}'),
  'inner padding is 28 desktop / 16 mobile');
check(confirmed.htmlBody.includes('font-size:38px;font-weight:500;line-height:1.08')
  && confirmed.htmlBody.includes('.v3-h1{font-size:30px !important;}'), 'H1 is 38/30, weight 500, line-height 1.08');
check(confirmed.htmlBody.includes('font-size:22px;font-weight:500')
  && confirmed.htmlBody.includes('.v3-wordmark{font-size:20px !important;}'), 'wordmark is 22/20, weight 500');
check(confirmed.htmlBody.includes('font-size:10px;font-weight:600;line-height:1.4;letter-spacing:.18em'),
  'descriptor is 10/600/.18em');
check(confirmed.htmlBody.includes('letter-spacing:.16em'), 'eyebrow tracking is .16em');
check(confirmed.htmlBody.includes('letter-spacing:.12em'), 'label tracking is .12em');
check(confirmed.htmlBody.includes('font-size:16px;font-weight:400;line-height:1.55'), 'body is 16/400/1.55');
check(confirmed.htmlBody.includes('font-size:14px;font-weight:500'), 'value type is 14/500');
check(!/font-size:26px/.test(confirmed.htmlBody), 'no V2 26px headline');

// Footer order and content.
const footerOrder = ['¿Necesitas ayuda?', '>WhatsApp<', '>Email<', 'FRANCISCA BUSTOS M. &middot; PSICOLOGÍA PERINATAL',
  'Acompañamiento psicológico en embarazo, posparto y transición a la maternidad.', '>franciscabustos.cl<'];
let cursor = -1;
for (const needle of footerOrder) {
  const at = confirmed.htmlBody.indexOf(needle);
  check(at > cursor, 'footer keeps V3 order at "' + needle + '"');
  cursor = at;
}
check(!/instagram|linkedin/i.test(confirmed.htmlBody + confirmed.body), 'footer has no Instagram or LinkedIn');

// ---------------------------------------------------------------------------
// CONFIRMED
// ---------------------------------------------------------------------------
check(confirmed.subject === 'Tu sesión está confirmada · jueves 3 de septiembre de 2026 a las 13:00',
  'confirmed subject matches the exact V3 contract');
check(confirmed.htmlBody.includes('>TU SESIÓN ESTÁ CONFIRMADA<'), 'confirmed eyebrow');
check(confirmed.htmlBody.includes('>Tu sesión está confirmada.<'), 'confirmed H1');
check(confirmed.htmlBody.includes('>Hola,<'), 'confirmed greeting');
check(confirmed.htmlBody.includes('Te esperamos el jueves 3 de septiembre de 2026 a las 13:00.'), 'confirmed lead');
for (const label of ['Fecha', 'Hora', 'Modalidad', 'Duración', 'Valor']) {
  check(confirmed.htmlBody.includes('>' + label + '</td>'), 'confirmed detail row ' + label);
  check(confirmed.body.includes(label + ': '), 'confirmed text/plain detail ' + label);
}
check(confirmed.htmlBody.includes('>50 minutos<') && confirmed.body.includes('Duración: 50 minutos'),
  'confirmed renders Duración = 50 minutos');
check(confirmed.htmlBody.includes('>$50.000<') && confirmed.body.includes('Valor: $50.000'),
  'confirmed renders Valor = $50.000 in the Production fixture');
check(confirmed.htmlBody.includes('>Online<'), 'confirmed renders Modalidad = Online');
check(confirmed.htmlBody.includes('>ENTRAR A LA SESIÓN</a>'), 'confirmed primary CTA is ENTRAR A LA SESIÓN');
check(confirmed.htmlBody.includes('>' + MEET_URL + '</a>') && confirmed.htmlBody.includes('href="' + MEET_URL + '"'),
  'confirmed shows the Meet URL as a visible textual fallback link');
check(confirmed.htmlBody.includes('>REAGENDAR SESIÓN</a>') && confirmed.htmlBody.includes('open=reschedule'),
  'confirmed offers REAGENDAR SESIÓN');
check(confirmed.htmlBody.includes('>CANCELAR SESIÓN</a>') && confirmed.htmlBody.includes('open=cancel'),
  'confirmed offers CANCELAR SESIÓN');
const UNIVERSAL_COPY = 'No necesitas preparar nada especial para la sesión. '
  + 'Puedes llegar con lo que tengas hoy, aunque todavía sea difícil ponerlo en palabras.';
check(context.__EMAIL_TEMPLATE_TEST_EXPORTS__.EMAIL_V3_SESSION_COPY === UNIVERSAL_COPY,
  'the approved human copy is the universal string');
for (const [name, rendered] of Object.entries({
  CONFIRMED_INITIAL: confirmed, CONFIRMED_FOLLOWUP: confirmedFollowup, CONFIRMED_NO_MEET: confirmedNoMeet,
})) {
  check(rendered.htmlBody.includes(UNIVERSAL_COPY) && rendered.body.includes(UNIVERSAL_COPY),
    name + ': carries the universal approved human copy in html and text');
  check(!/primera sesión/i.test(rendered.htmlBody + rendered.body),
    name + ': the human copy makes no first-session claim');
}
check(!/Agregar al calendario|calendar\.google\.com\/calendar\/render/i.test(confirmed.htmlBody + confirmed.body),
  'confirmed no longer competes with an "Agregar al calendario" action');
check(!/pagar|pendiente de pago|transferencia/i.test(confirmed.htmlBody + confirmed.body),
  'confirmed carries no payment instructions');
check(confirmed.body.includes(MEET_URL) && confirmed.body.includes('Reagendar: ') && confirmed.body.includes('Cancelar: ')
  && confirmed.body.includes('Hola,') && confirmed.body.includes('WhatsApp: ') && confirmed.body.includes('Email: '),
  'confirmed text/plain is fully equivalent');

// Modality without Meet: no primary action is invented.
check(!confirmedNoMeet.htmlBody.includes('ENTRAR A LA SESIÓN'), 'no-Meet confirmed hides ENTRAR A LA SESIÓN');
check(!/meet\.google\.com/i.test(confirmedNoMeet.htmlBody + confirmedNoMeet.body), 'no-Meet confirmed invents no Meet fallback');
check(!confirmedNoMeet.htmlBody.includes(PRIMARY), 'no-Meet confirmed invents no other primary CTA');
check(confirmedNoMeet.htmlBody.includes('>REAGENDAR SESIÓN</a>') && confirmedNoMeet.htmlBody.includes('>CANCELAR SESIÓN</a>'),
  'no-Meet confirmed keeps both secondary actions');

// ---------------------------------------------------------------------------
// RESCHEDULED (patient) — no second reschedule anywhere
// ---------------------------------------------------------------------------
check(rescheduled.subject === 'Tu sesión fue reagendada · viernes 4 de septiembre de 2026 a las 14:00',
  'rescheduled subject matches the exact V3 contract');
check(rescheduled.htmlBody.includes('>TU SESIÓN FUE REAGENDADA<'), 'rescheduled eyebrow');
check(rescheduled.htmlBody.includes('>Tu sesión fue reagendada.<'), 'rescheduled H1');
check(rescheduled.htmlBody.includes('Te esperamos en tu nueva fecha.'), 'rescheduled copy');
check(rescheduled.htmlBody.includes('>ANTES<') && rescheduled.htmlBody.includes('>NUEVA FECHA<'),
  'rescheduled renders the ANTES / NUEVA FECHA comparison');
check(rescheduled.htmlBody.includes('jueves 3 de septiembre de 2026 · 13:00')
  && rescheduled.htmlBody.includes('viernes 4 de septiembre de 2026 · 14:00'),
  'comparison carries both the old and the new datetime');
check(rescheduled.htmlBody.indexOf('>ANTES<') < rescheduled.htmlBody.indexOf('>Fecha</td>'),
  'comparison comes before the current detail block');
check(rescheduled.htmlBody.includes('&#8594;'), 'comparison uses a textual arrow, not an emoji');
check(rescheduled.htmlBody.includes('>ENTRAR A LA SESIÓN</a>') && rescheduled.htmlBody.includes('>' + MEET_URL + '</a>'),
  'rescheduled keeps the Meet primary and its visible fallback');
check(rescheduled.htmlBody.includes('>CANCELAR SESIÓN</a>'), 'rescheduled offers CANCELAR SESIÓN');
for (const [name, rendered] of Object.entries({ PATIENT_RESCHEDULED: rescheduled, LEAKY_TOKEN: rescheduledLeaky })) {
  const both = rendered.htmlBody + '\n' + rendered.body;
  check(!/REAGENDAR SESIÓN/.test(both), name + ': no REAGENDAR SESIÓN action after a reschedule');
  check(!/open=reschedule/.test(both), name + ': no reschedule capability link after a reschedule');
  check(!/^Reagendar: /m.test(rendered.body), name + ': text/plain offers no reschedule action');
}
check(/reagendada/i.test(rescheduled.htmlBody), 'the word "reagendada" may still appear as status copy');
check(rescheduled.body.includes('ANTES: jueves 3 de septiembre de 2026 · 13:00')
  && rescheduled.body.includes('NUEVA FECHA: viernes 4 de septiembre de 2026 · 14:00')
  && rescheduled.body.includes('Cancelar: '),
  'rescheduled text/plain has both datetimes and only the cancel action');

// CLINICIAN_RESCHEDULED: NUEVA FECHA alone. original_start_at is not provably
// the immediately previous slot once a patient reschedule has happened, so
// rendering it as ANTES would be factually misleading.
check(clinicianChange.subject === 'Hubo un cambio en tu próxima sesión', 'clinician reschedule keeps its subject contract');
check(clinicianChange.htmlBody.includes('>HUBO UN CAMBIO EN TU PRÓXIMA SESIÓN<'), 'clinician reschedule eyebrow');
check(clinicianChange.htmlBody.includes('>Hubo un cambio en tu próxima sesión.<'), 'clinician reschedule H1');
check(clinicianChange.htmlBody.includes('Actualicé el horario. Revisa a continuación la nueva fecha.')
  && clinicianChange.body.includes('Actualicé el horario. Revisa a continuación la nueva fecha.'),
  'clinician reschedule lead');
check(clinicianChange.htmlBody.includes('>NUEVA FECHA<')
  && clinicianChange.htmlBody.includes('viernes 4 de septiembre de 2026 · 14:00'),
  'clinician reschedule shows a single highlighted NUEVA FECHA block');
check(!/ANTES/.test(clinicianChange.htmlBody) && !/ANTES/.test(clinicianChange.body),
  'clinician reschedule renders no ANTES value');
check(!clinicianChange.htmlBody.includes('&#8594;'), 'clinician reschedule has no comparison arrow');
check(!/jueves 3 de septiembre de 2026/.test(clinicianChange.htmlBody + clinicianChange.body),
  'clinician reschedule never surfaces original_start_at');
check(clinicianChange.body.includes('NUEVA FECHA: viernes 4 de septiembre de 2026 · 14:00')
  && !clinicianChange.body.includes('ANTES: '),
  'clinician reschedule text/plain shows only the new date');
for (const label of ['Fecha', 'Hora', 'Modalidad', 'Duración', 'Valor']) {
  check(clinicianChange.htmlBody.includes('>' + label + '</td>'), 'clinician reschedule detail row ' + label);
}
check(clinicianChange.htmlBody.includes('>ENTRAR A LA SESIÓN</a>')
  && clinicianChange.htmlBody.includes('>' + MEET_URL + '</a>'),
  'clinician reschedule keeps the Meet primary and its visible fallback');
check(!/REAGENDAR SESIÓN|open=reschedule/.test(clinicianChange.htmlBody + clinicianChange.body),
  'clinician reschedule offers no reschedule action');
check(clinicianChange.htmlBody.includes('>CANCELAR SESIÓN</a>'), 'clinician reschedule keeps CANCELAR SESIÓN');

// PATIENT_RESCHEDULED keeps the mandatory ANTES -> NUEVA FECHA comparison.
check(rescheduled.htmlBody.includes('>ANTES<') && rescheduled.htmlBody.includes('>NUEVA FECHA<')
  && rescheduled.body.includes('ANTES: ') && rescheduled.body.includes('NUEVA FECHA: '),
  'patient reschedule keeps ANTES and NUEVA FECHA in html and text');

// ---------------------------------------------------------------------------
// CANCELLED (patient) — fail-closed
// ---------------------------------------------------------------------------
const FAIL_CLOSED = /(pago|cobro|valor|devoluci[oó]n|reembolso|\$50\.000|50000)/i;
for (const [name, rendered] of Object.entries({
  SESSION_CANCELLED: cancelled, PATIENT_CANCELLED: cancelledPatient, CLINICIAN_CANCELLED: cancelledClinician,
})) {
  check(rendered.subject === 'Tu sesión fue cancelada', name + ': cancelled subject');
  check(!FAIL_CLOSED.test(rendered.htmlBody), name + ': cancelled HTML has no economic vocabulary');
  check(!FAIL_CLOSED.test(rendered.body), name + ': cancelled text/plain has no economic vocabulary');
  check(rendered.htmlBody.includes('>TU SESIÓN FUE CANCELADA<'), name + ': cancelled eyebrow');
  check(rendered.htmlBody.includes('>Tu sesión fue cancelada.<'), name + ': cancelled H1');
  check(rendered.htmlBody.includes('La sesión agendada para el jueves 3 de septiembre de 2026 a las 13:00 fue cancelada.'),
    name + ': cancelled copy names the cancelled slot');
  check(rendered.htmlBody.includes('>Fecha</td>') && rendered.htmlBody.includes('>jueves 3 de septiembre de 2026<'),
    name + ': cancelled shows the date');
  check(rendered.htmlBody.includes('>Hora</td>') && rendered.htmlBody.includes('>13:00 (Chile)<'),
    name + ': cancelled shows the time');
  check(!rendered.htmlBody.includes('>Modalidad</td>'), name + ': cancelled hides modality');
  check(!rendered.htmlBody.includes('>Duración</td>'), name + ': cancelled hides duration');
  check(!/meet\.google\.com|ENTRAR A LA SESIÓN/i.test(rendered.htmlBody + rendered.body), name + ': cancelled hides Meet');
  check(!/manage\.html|open=reschedule|open=cancel|REAGENDAR SESIÓN|CANCELAR SESIÓN/.test(rendered.htmlBody + rendered.body),
    name + ': cancelled drops the old management links');
  check(rendered.htmlBody.includes('>AGENDAR NUEVA SESIÓN</a>') && rendered.htmlBody.includes('href="https://franciscabustos.cl/reserva"'),
    name + ': cancelled primary is AGENDAR NUEVA SESIÓN');
  check(rendered.htmlBody.includes('>CONTACTAR POR WHATSAPP</a>') && rendered.htmlBody.includes('href="https://wa.me/56957663038"'),
    name + ': cancelled secondary is CONTACTAR POR WHATSAPP on the official contract');
  check(rendered.htmlBody.includes('Si necesitas apoyo o tienes dudas, puedes escribirnos. Estamos aquí para acompañarte cuando lo necesites.'),
    name + ': cancelled human message');
  check(rendered.body.includes('Agendar nueva sesión: https://franciscabustos.cl/reserva')
    && rendered.body.includes('Contactar por WhatsApp: https://wa.me/56957663038')
    && rendered.body.includes('Fecha: jueves 3 de septiembre de 2026') && rendered.body.includes('Hora: 13:00 (Chile)'),
    name + ': cancelled text/plain is equivalent and economically silent');
  check(!/Si corresponde un reembolso|reembolso de tu sesión fue procesado/i.test(rendered.htmlBody + rendered.body),
    name + ': V2 cancellation refund copy is gone');
}

// ---------------------------------------------------------------------------
// Internal operational notification stays internal
// ---------------------------------------------------------------------------
check(internal.subject === 'Revisión operativa: reembolso pendiente de política', 'internal subject preserved');
check(/no es confirmación de reembolso al paciente/i.test(internal.htmlBody)
  && /no es confirmación de reembolso al paciente/i.test(internal.body), 'internal disclaimer preserved');
check(internal.htmlBody.includes('fran-booking-reservation-synthetic') && internal.body.includes('Pago: paid')
  && internal.body.includes('Reembolso: manual_review') && internal.body.includes('Motivo: BUSINESS_POLICY_TBD')
  && internal.body.includes('revisión humana'), 'internal operational payload preserved');
check(FAIL_CLOSED.test(internal.body), 'internal notification is exempt from the patient fail-closed rule');
check(!internal.htmlBody.includes('min-height:48px'), 'internal notification has no patient CTA');
check(!/AGENDAR NUEVA SESIÓN|CONTACTAR POR WHATSAPP|ENTRAR A LA SESIÓN|¿Necesitas ayuda\?/.test(internal.htmlBody),
  'internal notification did not inherit patient V3 copy');

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
};
for (const [base, rendered] of Object.entries(artifacts)) {
  await writeFile(new URL(base + '.html', fixtureDir), rendered.htmlBody);
  await writeFile(new URL(base + '.txt', fixtureDir), rendered.body);
}

console.log(`EMAIL_DESIGN_SYSTEM_V3_CONTRACT=PASS assertions=${assertions}`);
console.log('EMAIL_PREVIEW_FIXTURES=' + fileURLToPath(fixtureDir));
console.log('PRODUCTION_EMAILS_SENT=0');
console.log('REAL_NETWORK_SIDE_EFFECTS=0');
