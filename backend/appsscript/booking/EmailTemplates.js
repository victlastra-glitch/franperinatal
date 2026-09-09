/**
 * FRAN_EMAIL_DESIGN_SYSTEM_V4 — direction: Editorial Clinical Human.
 *
 * Transactional lifecycle email: HTML + a fully equivalent text/plain body.
 * Contracts held by this file:
 * - text-first brand header; the email is complete with zero images
 * - exactly one primary action per lifecycle state; REAGENDAR is a secondary
 *   outline button and CANCELAR a subordinate destructive text link
 * - presentation tables + inline CSS only (no JS, Grid, Flex, SVG, forms)
 * - no remote font: the stacks degrade to Georgia / Arial
 * - no meaningful text below 12px; body 16px
 * - the neutral cancellation email makes no economic claim; the refund block
 *   renders only for a provider-confirmed REFUNDED record
 * - REFUND_FAILED_MANUAL_REVIEW is an internal operator tool, never patient copy
 */

var EMAIL_V4 = Object.freeze({
  cream: '#FFF7F2',
  paper: '#FFFCF9',
  charcoal: '#2F3236',
  textSecondary: '#5F5A55',
  textMuted: '#6A625C',
  sand: '#DCCBB9',
  taupe: '#A89E93',
  border: '#E7DDD3',
  successBg: '#E8EEE6',
  cancelBg: '#F6E6E6',
  // Foreground for cancellation eyebrows and the destructive text link. The
  // former #B46E6A failed small-text contrast on the paper ground.
  cancelAccent: '#8C4F4B',
  link: '#8C6B52',
  white: '#FFFFFF',
  display: "'Fraunces', 'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  sans: "Inter, 'DM Sans', Arial, Helvetica, sans-serif",
  maxWidth: 600,
});

var EMAIL_V4_BRAND = Object.freeze({
  wordmark: 'FRANCISCA BUSTOS M.',
  descriptor: 'PSICOLOGÍA PERINATAL',
  whatsappUrl: 'https://wa.me/56957663038',
  emailAddress: 'hola@franciscabustos.cl',
});

// Preheaders complement the subject; they never repeat it.
var EMAIL_V4_PREHEADER = Object.freeze({
  confirmed: 'Fecha, hora y enlace para entrar a tu sesión.',
  rescheduled: 'Revisa tu nueva fecha y el enlace de la sesión.',
  cancelled: 'La hora quedó liberada. Puedes agendar una nueva sesión cuando quieras.',
  cancelledRefunded: 'El reembolso fue procesado al mismo medio de pago.',
  internal: 'Aviso interno. No es confirmación de reembolso al paciente.',
  generic: 'Actualización operativa de tu reserva.',
});

// Approved universal human copy. Rendered on every confirmation, initial and
// follow-up alike; it makes no claim about which session this is.
var EMAIL_V4_SESSION_COPY = 'No necesitas preparar nada especial para la sesión. '
  + 'Puedes llegar con lo que tengas hoy, aunque todavía sea difícil ponerlo en palabras.';

// Approved refund copy. Rendered only once the provider has confirmed the
// refund as REFUNDED, never before.
var EMAIL_V4_REFUND_COPY = 'El reembolso fue procesado al mismo medio de pago utilizado. '
  + 'Dependiendo de tu banco o emisor, puede tardar hasta 10 días hábiles en verse reflejado.';

var EMAIL_V4_CANCELLED_HUMAN_COPY = 'Si necesitas apoyo o tienes dudas, puedes escribirnos. '
  + 'Estamos aquí para acompañarte cuando lo necesites.';

// Approved policy reminder. Rendered on the confirmation only, immediately under
// the REAGENDAR / CANCELAR actions it explains. The hour count is read from the
// canonical policy constant so the copy cannot drift from the enforced cutoff.
// It is deliberately not shown on PATIENT_RESCHEDULED: the state machine caps a
// patient at one move, so there is no second reschedule left to offer.
function emailV4ManagementPolicyCopy_() {
  return 'Puedes reagendar o cancelar tu sesión hasta ' + PATIENT_MANAGEMENT_CUTOFF_HOURS
    + ' horas antes del horario agendado.';
}

function escapeEmailText_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lifecycleEmailDateParts_(iso) {
  const formatted = typeof formatPatientFacingDateTime_ === 'function' ? formatPatientFacingDateTime_(iso) : '';
  if (!formatted) return { date: '', time: '', combined: '' };
  const pieces = formatted.split(', ');
  if (pieces.length < 2) return { date: formatted, time: '', combined: formatted };
  return { date: pieces[0], time: pieces[pieces.length - 1], combined: formatted };
}

// Short, locale-safe date for subjects: "mié 16 sep". Weekday and month names
// are fixed Spanish abbreviations so no ICU version can change the subject.
var EMAIL_V4_WEEKDAYS_SHORT = Object.freeze(['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']);
var EMAIL_V4_MONTHS_SHORT = Object.freeze(['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']);

function lifecycleEmailShortDate_(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  const zone = typeof PATIENT_EMAIL_TIME_ZONE === 'string' ? PATIENT_EMAIL_TIME_ZONE : 'America/Santiago';
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
    });
    const parts = {};
    formatter.formatToParts(new Date(ms)).forEach(function(part) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    });
    const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
    const month = Number(parts.month);
    const day = Number(parts.day);
    if (weekdayIndex === -1 || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return '';
    return EMAIL_V4_WEEKDAYS_SHORT[weekdayIndex] + ' ' + day + ' ' + EMAIL_V4_MONTHS_SHORT[month - 1];
  } catch (_) { return ''; }
}

/** Human-first subjects. The refund claim needs a REFUNDED record, not just the event. */
function lifecycleNotificationSubject_(eventType, dateParts, record) {
  const parts = dateParts || {};
  const time = String(parts.time || '');
  const shortDate = record && record.current_start_at ? lifecycleEmailShortDate_(record.current_start_at) : '';
  const dateBit = shortDate && time ? ' · ' + shortDate + ' · ' + time
    : (parts.date && time ? ' · ' + parts.date + ' · ' + time : '');
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.BOOKING_CONFIRMED) return 'Tu sesión está confirmada' + dateBit;
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED) return 'Tu sesión fue reagendada' + dateBit;
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) return 'Hubo un cambio en tu próxima sesión';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.SESSION_CANCELLED) {
    return emailV4RefundConfirmed_(eventType, record)
      ? 'Tu sesión fue cancelada · reembolso confirmado'
      : 'Tu sesión fue cancelada';
  }
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_REQUESTED) return 'Solicitud de reembolso en curso';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_COMPLETED) return 'Reembolso completado';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) {
    return emailV4InternalReview_(record).subject;
  }
  return 'Actualización de tu reserva';
}

/** Lifecycle event -> V4 visual state. One state, one primary action. */
function lifecycleEmailV4Kind_(eventType) {
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.BOOKING_CONFIRMED) return 'confirmed';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED) return 'rescheduled';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) return 'clinician_rescheduled';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.SESSION_CANCELLED) return 'cancelled';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) return 'internal';
  return 'generic';
}

function emailV4Origin_(input) {
  return String(input && input.previewOrigin || '').replace(/\/$/, '');
}

function emailV4BookingUrl_(origin) {
  return (origin || 'https://franciscabustos.cl') + '/reserva';
}

/** "$50.000" from the canonical CLP integer. Never hardcodes an amount. */
function emailV4FormatClp_(amount) {
  const value = Math.round(Number(amount) || 0);
  return '$' + String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function emailV4SessionDurationLabel_() {
  const minutes = typeof SESSION_DURATION_MINUTES === 'number' ? SESSION_DURATION_MINUTES : 0;
  return minutes ? minutes + ' minutos' : '';
}

/**
 * The email shows what this transaction is actually worth, not today's list price:
 * a catalog change after payment must never rewrite a delivered confirmation.
 */
function emailV4AmountLabel_(record) {
  if (typeof displayAmountClp_ !== 'function') return '';
  const amount = displayAmountClp_(record);
  return amount ? emailV4FormatClp_(amount) : '';
}

/**
 * True only for the refund-confirmed cancellation email: the event is the
 * provider-confirmed variant AND the record itself still reads REFUNDED. Both
 * must agree before any refund claim is rendered, so a mis-routed event cannot
 * produce a false claim.
 */
function emailV4RefundConfirmed_(eventType, record) {
  const confirmedEvent = eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED;
  return confirmedEvent && String(record && record.refund_status || '') === LIFECYCLE.REFUND_STATUS.REFUNDED;
}

/**
 * The reservation schema stores no patient name (deliberate minimisation), so
 * the greeting degrades to "Hola," unless a name is present on the record.
 */
function emailV4Greeting_(record) {
  const raw = String(record && (record.patient_first_name || record.patient_name) || '').trim();
  const first = raw ? raw.split(/\s+/)[0].slice(0, 40) : '';
  return first ? 'Hola, ' + first : 'Hola,';
}

// ---------------------------------------------------------------------------
// Internal operator view model — human-first rows, then metadata
// ---------------------------------------------------------------------------

function emailV4HumanPaymentLabel_(record) {
  const status = String(record && record.payment_status || '');
  if (status === LIFECYCLE.PAYMENT_STATUS.PAID) return 'Confirmado';
  if (status === LIFECYCLE.PAYMENT_STATUS.PENDING) return 'Pendiente';
  if (status === LIFECYCLE.PAYMENT_STATUS.REJECTED) return 'Rechazado';
  if (status === LIFECYCLE.PAYMENT_STATUS.FAILED) return 'Fallido';
  if (status === LIFECYCLE.PAYMENT_STATUS.EXPIRED) return 'Expirado';
  return status ? 'Sin traducción (' + status + ')' : 'Sin registro';
}

function emailV4HumanRefundLabel_(record) {
  const code = String(record && record.refund_last_error_code || '');
  const attempted = typeof providerRefundAttempted_ === 'function' && providerRefundAttempted_(record);
  if (code === 'PROVIDER_REFUND_REJECTED') return 'Rechazado por el proveedor';
  if (code === 'REFUND_CREATE_OUTCOME_UNKNOWN') return 'Resultado del proveedor desconocido';
  if (code === 'REFUND_AMOUNT_UNKNOWN') return 'Monto no verificable';
  if (code === 'REFUND_CONFIGURATION_INCOMPLETE') return 'Configuración incompleta';
  if (code === 'BUSINESS_POLICY_TBD') return 'Fuera de la política automática';
  return attempted ? 'No pudo procesarse automáticamente' : 'No intentado automáticamente';
}

function emailV4InternalReview_(record) {
  const code = String(record && record.refund_last_error_code || '');
  const attempted = typeof providerRefundAttempted_ === 'function' && providerRefundAttempted_(record);
  const providerFailure = code === 'PROVIDER_REFUND_REJECTED' || code === 'REFUND_CREATE_OUTCOME_UNKNOWN' || attempted;
  return {
    subject: providerFailure
      ? 'Acción requerida: el reembolso no pudo procesarse automáticamente'
      : 'Acción requerida: la reserva necesita revisión manual',
    headline: providerFailure
      ? 'El reembolso no pudo procesarse automáticamente.'
      : 'La reserva necesita revisión manual.',
    humanRows: [
      ['Pago', emailV4HumanPaymentLabel_(record)],
      ['Reembolso', emailV4HumanRefundLabel_(record)],
      ['Acción', 'Revisar manualmente. No reintentar automáticamente.'],
    ],
    metadataRows: [
      ['Referencia', String(record && record.reservation_id || '')],
      ['Código', code || 'BUSINESS_POLICY_TBD'],
      ['Proveedor', attempted ? 'intentado' : 'no intentado'],
      ['Estados internos', 'payment=' + String(record && record.payment_status || '')
        + ' · refund=' + String(record && record.refund_status || '')],
    ],
  };
}

var EMAIL_V4_INTERNAL_DISCLAIMER = 'Este aviso es interno. No es confirmación de reembolso al paciente; '
  + 'la reserva requiere revisión humana.';

// ---------------------------------------------------------------------------
// HTML primitives. Presentation tables + inline CSS only.
// ---------------------------------------------------------------------------

function emailV4Style_() {
  return '<style type="text/css">'
    + 'body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}'
    + 'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}'
    + 'table{border-collapse:collapse;}'
    + 'img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}'
    + '@media only screen and (max-width:599px){'
    + '.v4-outer{padding:12px !important;}'
    + '.v4-pad{padding-left:16px !important;padding-right:16px !important;}'
    + '.v4-h1{font-size:30px !important;}'
    + '.v4-wordmark{font-size:20px !important;}'
    + '.v4-lbl{display:block !important;width:100% !important;padding:12px 0 4px 0 !important;border-bottom:0 !important;}'
    + '.v4-val{display:block !important;width:100% !important;padding:0 0 12px 0 !important;}'
    + '}'
    + '@media (prefers-color-scheme:dark){'
    + '.v4-page{background-color:' + EMAIL_V4.cream + ' !important;}'
    + '.v4-card{background-color:' + EMAIL_V4.paper + ' !important;}'
    + '.v4-ink{color:' + EMAIL_V4.charcoal + ' !important;}'
    + '.v4-ink2{color:' + EMAIL_V4.textSecondary + ' !important;}'
    + '.v4-ink3{color:' + EMAIL_V4.textMuted + ' !important;}'
    + '.v4-cancel{color:' + EMAIL_V4.cancelAccent + ' !important;}'
    + '}'
    + '</style>';
}

function emailV4Preheader_(text) {
  const hidden = 'display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;'
    + 'opacity:0;overflow:hidden;mso-hide:all;';
  let spacer = '';
  for (let index = 0; index < 40; index += 1) spacer += '&#847;&zwnj;&nbsp;';
  return '<div style="' + hidden + '">' + escapeEmailText_(text) + '</div>'
    + '<div style="' + hidden + '">' + spacer + '</div>';
}

function emailV4Document_(options) {
  return '<!DOCTYPE html><html lang="es-CL"><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="X-UA-Compatible" content="IE=edge">'
    + '<meta name="color-scheme" content="light">'
    + '<meta name="supported-color-schemes" content="light">'
    + '<title>' + escapeEmailText_(options.title) + '</title>'
    + '<!--[if mso]><style type="text/css">body,table,td,div,p,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->'
    + emailV4Style_()
    + '</head>'
    + '<body class="v4-page" style="margin:0;padding:0;width:100%;background-color:' + EMAIL_V4.cream
    + ';color:' + EMAIL_V4.charcoal + ';">'
    + emailV4Preheader_(options.preheader)
    + '<table role="presentation" class="v4-page" width="100%" cellpadding="0" cellspacing="0" border="0"'
    + ' bgcolor="' + EMAIL_V4.cream + '" style="width:100%;background-color:' + EMAIL_V4.cream + ';">'
    + '<tr><td class="v4-outer" align="center" style="padding:24px;">'
    + '<table role="presentation" class="v4-card" width="600" cellpadding="0" cellspacing="0" border="0"'
    + ' bgcolor="' + EMAIL_V4.paper + '" style="width:100%;max-width:' + EMAIL_V4.maxWidth + 'px;'
    + 'background-color:' + EMAIL_V4.paper + ';border:1px solid ' + EMAIL_V4.border + ';border-radius:4px;">'
    + options.rows
    + '</table>'
    + '</td></tr></table></body></html>';
}

/**
 * Brand header. Text-first: wordmark, descriptor, and one short sand rule as the
 * editorial signature. No image is needed to understand the email.
 */
function emailV4Header_() {
  return '<tr><td class="v4-pad v4-wordmark v4-ink" style="padding:28px 28px 0 28px;font-family:' + EMAIL_V4.display
    + ';font-size:22px;font-weight:500;line-height:1.15;letter-spacing:.02em;color:' + EMAIL_V4.charcoal
    + ';text-align:left;">' + EMAIL_V4_BRAND.wordmark + '</td></tr>'
    + '<tr><td class="v4-pad v4-ink3" style="padding:8px 28px 0 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.18em;color:' + EMAIL_V4.textMuted
    + ';text-transform:uppercase;text-align:left;">' + EMAIL_V4_BRAND.descriptor + '</td></tr>'
    + '<tr><td class="v4-pad" style="padding:16px 28px 0 28px;">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td width="40" height="2" style="width:40px;height:2px;line-height:2px;font-size:0;background-color:'
    + EMAIL_V4.sand + ';">&nbsp;</td></tr></table></td></tr>';
}

function emailV4Rule_(top, bottom) {
  return '<tr><td class="v4-pad" style="padding:' + top + 'px 28px ' + bottom + 'px 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td height="1" style="height:1px;line-height:1px;font-size:0;background-color:' + EMAIL_V4.border
    + ';">&nbsp;</td></tr></table></td></tr>';
}

function emailV4Eyebrow_(text, background, color, cssClass) {
  // A paper gap keeps the status band from fusing with the brand header.
  return '<tr><td style="height:24px;line-height:24px;font-size:0;">&nbsp;</td></tr>'
    + '<tr><td class="v4-pad' + (cssClass ? ' ' + cssClass : '') + '" bgcolor="' + background
    + '" style="padding:12px 28px;background-color:' + background
    + ';font-family:' + EMAIL_V4.sans + ';font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.16em;'
    + 'text-transform:uppercase;color:' + color + ';">' + escapeEmailText_(text) + '</td></tr>';
}

function emailV4Headline_(text) {
  return '<tr><td class="v4-pad v4-h1 v4-ink" style="padding:28px 28px 0 28px;font-family:' + EMAIL_V4.display
    + ';font-size:38px;font-weight:500;line-height:1.08;letter-spacing:-0.01em;color:' + EMAIL_V4.charcoal
    + ';">' + escapeEmailText_(text) + '</td></tr>';
}

function emailV4Body_(html, top, color) {
  return '<tr><td class="v4-pad v4-ink2" style="padding:' + top + 'px 28px 0 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:16px;font-weight:400;line-height:1.55;color:' + (color || EMAIL_V4.textSecondary) + ';">'
    + html + '</td></tr>';
}

function emailV4Label_(text, color, extraStyle) {
  return '<span style="font-family:' + EMAIL_V4.sans + ';font-size:12px;font-weight:600;line-height:1.4;'
    + 'letter-spacing:.12em;text-transform:uppercase;color:' + color + ';' + (extraStyle || '') + '">' + text + '</span>';
}

function emailV4Details_(rows, top) {
  if (!rows || !rows.length) return '';
  let cells = '';
  rows.forEach(function(row) {
    const edge = 'border-bottom:1px solid ' + EMAIL_V4.border + ';';
    cells += '<tr>'
      + '<td class="v4-lbl v4-ink3" width="140" style="width:140px;padding:12px 12px 12px 0;' + edge
      + 'vertical-align:top;font-family:' + EMAIL_V4.sans + ';font-size:12px;font-weight:600;line-height:1.4;'
      + 'letter-spacing:.12em;text-transform:uppercase;color:' + EMAIL_V4.textMuted + ';">'
      + escapeEmailText_(row[0]) + '</td>'
      + '<td class="v4-val v4-ink" style="padding:12px 0;' + edge + 'vertical-align:top;font-family:' + EMAIL_V4.sans
      + ';font-size:14px;font-weight:500;line-height:1.5;color:' + EMAIL_V4.charcoal + ';word-break:break-word;">'
      + escapeEmailText_(row[1]) + '</td>'
      + '</tr>';
  });
  return '<tr><td class="v4-pad" style="padding:' + (top === undefined ? 24 : top) + 'px 28px 0 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + cells
    + '</table></td></tr>';
}

/**
 * Highlighted schedule block. NUEVA FECHA carries the visual weight (20/600);
 * ANTES is muted and rendered only when the record can prove the immediately
 * previous appointment time — a patient reschedule, capped at one move. A
 * clinician change after a patient move shows NUEVA FECHA alone.
 */
function emailV4ScheduleHighlight_(previousValue, newValue) {
  function label(text, color, top) {
    return '<tr><td class="' + (color === EMAIL_V4.charcoal ? 'v4-ink' : 'v4-ink3') + '" style="padding:' + top
      + 'px 16px 0 16px;font-family:' + EMAIL_V4.sans
      + ';font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.12em;text-transform:uppercase;color:'
      + color + ';">' + text + '</td></tr>';
  }
  let inner = '';
  if (previousValue) {
    inner += label('ANTES', EMAIL_V4.textMuted, 16)
      + '<tr><td class="v4-ink3" style="padding:4px 16px 0 16px;font-family:' + EMAIL_V4.sans
      + ';font-size:14px;font-weight:400;line-height:1.5;color:' + EMAIL_V4.textMuted
      + ';text-decoration:line-through;">' + escapeEmailText_(previousValue) + '</td></tr>'
      + '<tr><td style="padding:12px 16px 0 16px;font-family:' + EMAIL_V4.sans
      + ';font-size:16px;line-height:1;color:' + EMAIL_V4.taupe + ';">&#8594;</td></tr>'
      + label('NUEVA FECHA', EMAIL_V4.charcoal, 12);
  } else {
    inner += label('NUEVA FECHA', EMAIL_V4.charcoal, 16);
  }
  inner += '<tr><td class="v4-ink" style="padding:4px 16px 16px 16px;font-family:' + EMAIL_V4.sans
    + ';font-size:20px;font-weight:600;line-height:1.4;color:' + EMAIL_V4.charcoal + ';">'
    + escapeEmailText_(newValue) + '</td></tr>';
  return '<tr><td class="v4-pad" style="padding:24px 28px 0 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + EMAIL_V4.cream
    + '" style="width:100%;background-color:' + EMAIL_V4.cream + ';border:1px solid ' + EMAIL_V4.border
    + ';border-radius:4px;">' + inner + '</table></td></tr>';
}

/** Quiet information block: thin border, cream ground, label eyebrow, no icon. */
function emailV4InfoBlock_(label, text) {
  return '<tr><td class="v4-pad" style="padding:24px 28px 0 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + EMAIL_V4.cream
    + '" style="width:100%;background-color:' + EMAIL_V4.cream + ';border:1px solid ' + EMAIL_V4.border
    + ';border-radius:4px;">'
    + '<tr><td class="v4-ink3" style="padding:16px 16px 0 16px;font-family:' + EMAIL_V4.sans
    + ';font-size:12px;font-weight:600;line-height:1.4;letter-spacing:.12em;text-transform:uppercase;color:'
    + EMAIL_V4.textMuted + ';">' + label + '</td></tr>'
    + '<tr><td class="v4-ink2" style="padding:8px 16px 16px 16px;font-family:' + EMAIL_V4.sans
    + ';font-size:16px;font-weight:400;line-height:1.55;color:' + EMAIL_V4.textSecondary + ';">'
    + escapeEmailText_(text) + '</td></tr>'
    + '</table></td></tr>';
}

/** Primary: charcoal fill. Secondary: paper fill, taupe outline. Both 48px targets. */
function emailV4Button_(href, label, primary) {
  if (!href || !label) return '';
  const background = primary ? EMAIL_V4.charcoal : EMAIL_V4.paper;
  const color = primary ? EMAIL_V4.white : EMAIL_V4.charcoal;
  const edge = primary ? EMAIL_V4.charcoal : EMAIL_V4.taupe;
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
    + '<tr><td align="center" height="48" bgcolor="' + background + '" style="height:48px;background-color:' + background
    + ';border:1px solid ' + edge + ';border-radius:2px;mso-padding-alt:0;">'
    + '<a href="' + escapeEmailText_(href) + '" target="_blank" style="display:block;min-height:48px;line-height:48px;'
    + 'mso-line-height-rule:exactly;padding:0 12px;font-family:' + EMAIL_V4.sans + ';font-size:12px;font-weight:600;'
    + 'letter-spacing:.18em;text-transform:uppercase;text-align:center;text-decoration:none;color:' + color + ';">'
    + escapeEmailText_(label) + '</a></td></tr></table>';
}

function emailV4PrimaryRow_(href, label) {
  const button = emailV4Button_(href, label, true);
  if (!button) return '';
  return '<tr><td class="v4-pad" style="padding:32px 28px 0 28px;">' + button + '</td></tr>';
}

function emailV4SecondaryRow_(href, label) {
  const button = emailV4Button_(href, label, false);
  if (!button) return '';
  return '<tr><td class="v4-pad" style="padding:16px 28px 0 28px;">' + button + '</td></tr>';
}

/**
 * Tertiary, destructive: a text link in the cancellation accent. Visually
 * subordinate to both buttons, still a 48px block target (14 + 20 + 14).
 */
function emailV4TertiaryRow_(href, label) {
  if (!href || !label) return '';
  return '<tr><td class="v4-pad" align="center" style="padding:8px 28px 0 28px;text-align:center;">'
    + '<a href="' + escapeEmailText_(href) + '" target="_blank" class="v4-cancel" style="display:block;padding:14px 12px;'
    + 'line-height:20px;font-family:' + EMAIL_V4.sans + ';font-size:12px;font-weight:600;letter-spacing:.12em;'
    + 'text-transform:uppercase;text-align:center;text-decoration:underline;color:' + EMAIL_V4.cancelAccent + ';">'
    + escapeEmailText_(label) + '</a></td></tr>';
}

/** The Meet URL is always readable as text, never only behind a button. */
function emailV4MeetFallback_(meetUrl) {
  if (!meetUrl) return '';
  return '<tr><td class="v4-pad v4-ink3" style="padding:16px 28px 0 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:16px;font-weight:400;line-height:1.55;color:' + EMAIL_V4.textMuted + ';">'
    + 'Si el botón no funciona, entra desde este enlace:</td></tr>'
    + '<tr><td class="v4-pad" style="padding:4px 28px 0 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:14px;line-height:1.5;">'
    + '<a href="' + escapeEmailText_(meetUrl) + '" target="_blank" style="color:' + EMAIL_V4.link
    + ';text-decoration:underline;word-break:break-all;">' + escapeEmailText_(meetUrl) + '</a></td></tr>';
}

/** Compact footer: help line, contact links, one identification line. */
function emailV4Footer_() {
  return emailV4Rule_(32, 0)
    + '<tr><td class="v4-pad v4-ink" style="padding:24px 28px 0 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:16px;font-weight:500;line-height:1.55;color:' + EMAIL_V4.charcoal + ';">¿Necesitas ayuda?</td></tr>'
    + '<tr><td class="v4-pad" style="padding:8px 28px 0 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:16px;line-height:1.55;color:' + EMAIL_V4.textSecondary + ';">'
    + '<a href="' + EMAIL_V4_BRAND.whatsappUrl + '" target="_blank" style="color:' + EMAIL_V4.link
    + ';text-decoration:underline;">WhatsApp</a>'
    + '<span style="color:' + EMAIL_V4.taupe + ';"> &middot; </span>'
    + '<a href="mailto:' + EMAIL_V4_BRAND.emailAddress + '" style="color:' + EMAIL_V4.link
    + ';text-decoration:underline;">Email</a></td></tr>'
    + '<tr><td class="v4-pad v4-ink3" style="padding:24px 28px 28px 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:12px;font-weight:600;line-height:1.5;letter-spacing:.12em;text-transform:uppercase;color:'
    + EMAIL_V4.textMuted + ';">' + EMAIL_V4_BRAND.wordmark + ' &middot; ' + EMAIL_V4_BRAND.descriptor + '</td></tr>';
}

function emailV4InternalFooter_() {
  return emailV4Rule_(32, 0)
    + '<tr><td class="v4-pad v4-ink3" style="padding:24px 28px 28px 28px;font-family:' + EMAIL_V4.sans
    + ';font-size:12px;font-weight:600;line-height:1.5;letter-spacing:.12em;text-transform:uppercase;color:'
    + EMAIL_V4.textMuted + ';">' + EMAIL_V4_BRAND.wordmark + ' &middot; ' + EMAIL_V4_BRAND.descriptor
    + ' &middot; AVISO INTERNO</td></tr>';
}

// ---------------------------------------------------------------------------
// Per-state view models
// ---------------------------------------------------------------------------

function emailV4SessionRows_(record, parts, includeSchedule) {
  const rows = [];
  if (includeSchedule && parts.date) rows.push(['Fecha', parts.date]);
  if (includeSchedule && parts.time) rows.push(['Hora', parts.time + ' (Chile)']);
  const modality = typeof patientFacingModalityLabel_ === 'function'
    ? patientFacingModalityLabel_(record.modality) : '';
  if (modality) rows.push(['Modalidad', modality]);
  const duration = emailV4SessionDurationLabel_();
  if (duration) rows.push(['Duración', duration]);
  const amount = emailV4AmountLabel_(record);
  if (amount) rows.push(['Valor', amount]);
  return rows;
}

/**
 * REAGENDAR exists only on the confirmed state. After any reschedule the state
 * machine has revoked the capability and V4 offers no second move. CANCELAR is
 * offered wherever a cancel capability exists.
 */
function emailV4ScheduleActions_(kind, tokens, origin) {
  return {
    reschedule: kind === 'confirmed' && tokens.RESCHEDULE
      ? { href: managementPageUrl_(origin, tokens.RESCHEDULE, 'reschedule'), label: 'REAGENDAR SESIÓN' } : null,
    cancel: tokens.CANCEL
      ? { href: managementPageUrl_(origin, tokens.CANCEL, 'cancel'), label: 'CANCELAR SESIÓN' } : null,
  };
}

function renderLifecycleEmailHtml_(input) {
  const notification = input.notification;
  const record = input.record;
  const tokens = input.capabilityTokens || {};
  const origin = emailV4Origin_(input);
  const kind = lifecycleEmailV4Kind_(notification.eventType);
  const parts = lifecycleEmailDateParts_(record.current_start_at);
  const previous = lifecycleEmailDateParts_(record.original_start_at);
  const subject = lifecycleNotificationSubject_(notification.eventType, parts, record);
  const showsMeet = typeof lifecycleNotificationShowsMeet_ === 'function'
    && lifecycleNotificationShowsMeet_(notification.eventType);
  const meetUrl = showsMeet && notification.meet && notification.meet.meetUrl
    ? String(notification.meet.meetUrl) : '';

  if (kind === 'internal') {
    const review = emailV4InternalReview_(record);
    return emailV4Document_({
      title: subject,
      preheader: EMAIL_V4_PREHEADER.internal,
      rows: emailV4Header_()
        + emailV4Eyebrow_('ACCIÓN REQUERIDA', EMAIL_V4.cancelBg, EMAIL_V4.cancelAccent, 'v4-cancel')
        + emailV4Headline_(review.headline)
        + emailV4Body_(escapeEmailText_(EMAIL_V4_INTERNAL_DISCLAIMER), 16)
        + emailV4Details_(review.humanRows)
        + emailV4Body_(emailV4Label_('DATOS OPERATIVOS', EMAIL_V4.textMuted), 24)
        + emailV4Details_(review.metadataRows, 8)
        + emailV4InternalFooter_(),
    });
  }

  if (kind === 'cancelled') {
    // Fail-closed: no modality, duration, value, Meet, or management links. The
    // neutral variant carries no payment/refund vocabulary at all; the refund
    // block appears only for a provider-confirmed REFUNDED record.
    const cancelledRows = [];
    if (parts.date) cancelledRows.push(['Fecha', parts.date]);
    if (parts.time) cancelledRows.push(['Hora', parts.time + ' (Chile)']);
    const when = parts.date && parts.time
      ? 'La sesión agendada para el ' + parts.date + ' a las ' + parts.time + ' fue cancelada. La hora quedó liberada.'
      : 'La sesión que tenías agendada fue cancelada. La hora quedó liberada.';
    const refundConfirmed = emailV4RefundConfirmed_(notification.eventType, record);
    return emailV4Document_({
      title: subject,
      preheader: refundConfirmed ? EMAIL_V4_PREHEADER.cancelledRefunded : EMAIL_V4_PREHEADER.cancelled,
      rows: emailV4Header_()
        + emailV4Eyebrow_('TU SESIÓN FUE CANCELADA', EMAIL_V4.cancelBg, EMAIL_V4.cancelAccent, 'v4-cancel')
        + emailV4Headline_('Tu sesión fue cancelada.')
        + emailV4Body_(escapeEmailText_(emailV4Greeting_(record)), 24, EMAIL_V4.charcoal)
        + emailV4Body_(escapeEmailText_(when), 16)
        + emailV4Details_(cancelledRows)
        + (refundConfirmed ? emailV4InfoBlock_('REEMBOLSO CONFIRMADO', EMAIL_V4_REFUND_COPY) : '')
        + emailV4Body_(escapeEmailText_(EMAIL_V4_CANCELLED_HUMAN_COPY), 32)
        + emailV4PrimaryRow_(emailV4BookingUrl_(origin), 'AGENDAR NUEVA SESIÓN')
        + emailV4Footer_(),
    });
  }

  if (kind === 'confirmed' || kind === 'rescheduled' || kind === 'clinician_rescheduled') {
    let eyebrow = 'TU SESIÓN ESTÁ CONFIRMADA';
    let headline = 'Tu sesión está confirmada.';
    let lead = parts.date && parts.time
      ? 'Te esperamos el ' + parts.date + ' a las ' + parts.time + '.'
      : 'Te esperamos en la fecha agendada.';
    let preheader = EMAIL_V4_PREHEADER.confirmed;
    let band = EMAIL_V4.successBg;
    if (kind === 'rescheduled') {
      eyebrow = 'TU SESIÓN FUE REAGENDADA';
      headline = 'Tu sesión fue reagendada.';
      lead = 'Te esperamos en tu nueva fecha.';
      preheader = EMAIL_V4_PREHEADER.rescheduled;
      band = EMAIL_V4.cream;
    } else if (kind === 'clinician_rescheduled') {
      eyebrow = 'HUBO UN CAMBIO EN TU PRÓXIMA SESIÓN';
      headline = 'Hubo un cambio en tu próxima sesión.';
      lead = 'Actualicé el horario. Revisa a continuación la nueva fecha.';
      preheader = EMAIL_V4_PREHEADER.rescheduled;
      band = EMAIL_V4.cream;
    }

    // The highlight is the comparison; the detail table stays the record of the
    // session (with the explicit Chile time zone), so both are kept.
    let highlight = '';
    if (kind === 'clinician_rescheduled' && parts.combined) {
      highlight = emailV4ScheduleHighlight_('', parts.date + ' · ' + parts.time);
    } else if (kind === 'rescheduled' && previous.combined && parts.combined
      && record.original_start_at !== record.current_start_at) {
      highlight = emailV4ScheduleHighlight_(previous.date + ' · ' + previous.time, parts.date + ' · ' + parts.time);
    }
    const includeSchedule = true;

    const actions = emailV4ScheduleActions_(kind, tokens, origin);
    const humanCopy = kind === 'confirmed' ? emailV4Body_(EMAIL_V4_SESSION_COPY, 32) : '';
    // Muted caption directly under the management actions it explains.
    const policyReminder = kind === 'confirmed'
      ? emailV4Body_(escapeEmailText_(emailV4ManagementPolicyCopy_()), 16, EMAIL_V4.textMuted) : '';

    return emailV4Document_({
      title: subject,
      preheader: preheader,
      rows: emailV4Header_()
        + emailV4Eyebrow_(eyebrow, band, EMAIL_V4.charcoal)
        + emailV4Headline_(headline)
        + emailV4Body_(escapeEmailText_(emailV4Greeting_(record)), 24, EMAIL_V4.charcoal)
        + emailV4Body_(escapeEmailText_(lead), 16)
        + highlight
        + emailV4Details_(emailV4SessionRows_(record, parts, includeSchedule))
        + emailV4PrimaryRow_(meetUrl, 'ENTRAR A LA SESIÓN')
        + emailV4MeetFallback_(meetUrl)
        + (actions.reschedule ? emailV4SecondaryRow_(actions.reschedule.href, actions.reschedule.label) : '')
        + (actions.cancel ? emailV4TertiaryRow_(actions.cancel.href, actions.cancel.label) : '')
        + policyReminder
        + humanCopy
        + emailV4Footer_(),
    });
  }

  // Dormant operational states (REFUND_REQUESTED / REFUND_COMPLETED / unknown).
  // V4 chrome, existing copy, no invented policy language, no CTA.
  return emailV4Document_({
    title: subject,
    preheader: EMAIL_V4_PREHEADER.generic,
    rows: emailV4Header_()
      + emailV4Eyebrow_('ACTUALIZACIÓN DE TU RESERVA', EMAIL_V4.cream, EMAIL_V4.textMuted)
      + emailV4Headline_(subject)
      + emailV4Body_(escapeEmailText_(emailV4Greeting_(record)), 24, EMAIL_V4.charcoal)
      + emailV4Body_('Te escribimos con una actualización operativa de tu reserva.', 16)
      + emailV4Footer_(),
  });
}

// ---------------------------------------------------------------------------
// text/plain — same operational content, same forbidden rules
// ---------------------------------------------------------------------------

function emailV4TextHeader_() {
  return [EMAIL_V4_BRAND.wordmark, EMAIL_V4_BRAND.descriptor, ''];
}

function emailV4TextFooter_() {
  return [
    '',
    '¿Necesitas ayuda?',
    'WhatsApp: ' + EMAIL_V4_BRAND.whatsappUrl,
    'Email: ' + EMAIL_V4_BRAND.emailAddress,
    '',
    EMAIL_V4_BRAND.wordmark + ' · ' + EMAIL_V4_BRAND.descriptor,
  ];
}

function renderLifecycleEmailText_(input) {
  const notification = input.notification;
  const record = input.record;
  const tokens = input.capabilityTokens || {};
  const origin = emailV4Origin_(input);
  const kind = lifecycleEmailV4Kind_(notification.eventType);
  const parts = lifecycleEmailDateParts_(record.current_start_at);
  const previous = lifecycleEmailDateParts_(record.original_start_at);
  const showsMeet = typeof lifecycleNotificationShowsMeet_ === 'function'
    && lifecycleNotificationShowsMeet_(notification.eventType);
  const meetUrl = showsMeet && notification.meet && notification.meet.meetUrl
    ? String(notification.meet.meetUrl) : '';

  if (kind === 'internal') {
    const review = emailV4InternalReview_(record);
    const lines = ['ACCIÓN REQUERIDA', '', review.headline, '', EMAIL_V4_INTERNAL_DISCLAIMER, ''];
    review.humanRows.forEach(function(row) { lines.push(row[0] + ': ' + row[1]); });
    lines.push('', 'DATOS OPERATIVOS');
    review.metadataRows.forEach(function(row) { lines.push(row[0] + ': ' + row[1]); });
    lines.push('', EMAIL_V4_BRAND.wordmark + ' · ' + EMAIL_V4_BRAND.descriptor + ' · AVISO INTERNO');
    return lines.join('\n');
  }

  if (kind === 'cancelled') {
    const lines = emailV4TextHeader_();
    lines.push('TU SESIÓN FUE CANCELADA', '', emailV4Greeting_(record), '');
    lines.push(parts.date && parts.time
      ? 'La sesión agendada para el ' + parts.date + ' a las ' + parts.time + ' fue cancelada. La hora quedó liberada.'
      : 'La sesión que tenías agendada fue cancelada. La hora quedó liberada.');
    lines.push('');
    if (parts.date) lines.push('Fecha: ' + parts.date);
    if (parts.time) lines.push('Hora: ' + parts.time + ' (Chile)');
    if (emailV4RefundConfirmed_(notification.eventType, record)) {
      lines.push('', 'REEMBOLSO CONFIRMADO', EMAIL_V4_REFUND_COPY);
    }
    lines.push('', EMAIL_V4_CANCELLED_HUMAN_COPY);
    lines.push('', 'Agendar nueva sesión: ' + emailV4BookingUrl_(origin));
    return lines.concat(emailV4TextFooter_()).join('\n');
  }

  if (kind === 'confirmed' || kind === 'rescheduled' || kind === 'clinician_rescheduled') {
    const lines = emailV4TextHeader_();
    if (kind === 'confirmed') {
      lines.push('TU SESIÓN ESTÁ CONFIRMADA', '', emailV4Greeting_(record), '');
      lines.push(parts.date && parts.time
        ? 'Te esperamos el ' + parts.date + ' a las ' + parts.time + '.'
        : 'Te esperamos en la fecha agendada.');
    } else if (kind === 'rescheduled') {
      lines.push('TU SESIÓN FUE REAGENDADA', '', emailV4Greeting_(record), '', 'Te esperamos en tu nueva fecha.');
    } else {
      lines.push('HUBO UN CAMBIO EN TU PRÓXIMA SESIÓN', '', emailV4Greeting_(record), '',
        'Actualicé el horario. Revisa a continuación la nueva fecha.');
    }
    if (kind === 'clinician_rescheduled' && parts.combined) {
      lines.push('', 'NUEVA FECHA: ' + parts.date + ' · ' + parts.time);
    } else if (kind === 'rescheduled' && previous.combined && parts.combined
      && record.original_start_at !== record.current_start_at) {
      lines.push('', 'ANTES: ' + previous.date + ' · ' + previous.time);
      lines.push('NUEVA FECHA: ' + parts.date + ' · ' + parts.time);
    }
    lines.push('');
    emailV4SessionRows_(record, parts, true).forEach(function(row) { lines.push(row[0] + ': ' + row[1]); });
    if (meetUrl) lines.push('', 'Entrar a la sesión: ' + meetUrl);
    const actions = emailV4ScheduleActions_(kind, tokens, origin);
    if (actions.reschedule || actions.cancel) lines.push('');
    if (actions.reschedule) lines.push('Reagendar: ' + actions.reschedule.href);
    if (actions.cancel) lines.push('Cancelar: ' + actions.cancel.href);
    if (kind === 'confirmed') lines.push('', emailV4ManagementPolicyCopy_(), '', EMAIL_V4_SESSION_COPY);
    return lines.concat(emailV4TextFooter_()).join('\n');
  }

  const lines = emailV4TextHeader_();
  lines.push('ACTUALIZACIÓN DE TU RESERVA', '', emailV4Greeting_(record), '',
    'Te escribimos con una actualización operativa de tu reserva.');
  return lines.concat(emailV4TextFooter_()).join('\n');
}

var __EMAIL_TEMPLATE_TEST_EXPORTS__ = Object.freeze({
  EMAIL_V4: EMAIL_V4,
  EMAIL_V4_BRAND: EMAIL_V4_BRAND,
  EMAIL_V4_PREHEADER: EMAIL_V4_PREHEADER,
  EMAIL_V4_SESSION_COPY: EMAIL_V4_SESSION_COPY,
  EMAIL_V4_REFUND_COPY: EMAIL_V4_REFUND_COPY,
  EMAIL_V4_CANCELLED_HUMAN_COPY: EMAIL_V4_CANCELLED_HUMAN_COPY,
  EMAIL_V4_INTERNAL_DISCLAIMER: EMAIL_V4_INTERNAL_DISCLAIMER,
  emailV4ManagementPolicyCopy_: emailV4ManagementPolicyCopy_,
  emailV4RefundConfirmed_: emailV4RefundConfirmed_,
  emailV4InternalReview_: emailV4InternalReview_,
  lifecycleEmailDateParts_: lifecycleEmailDateParts_,
  lifecycleEmailShortDate_: lifecycleEmailShortDate_,
  lifecycleNotificationSubject_: lifecycleNotificationSubject_,
  lifecycleEmailV4Kind_: lifecycleEmailV4Kind_,
  emailV4FormatClp_: emailV4FormatClp_,
  renderLifecycleEmailHtml_: renderLifecycleEmailHtml_,
  renderLifecycleEmailText_: renderLifecycleEmailText_,
});
