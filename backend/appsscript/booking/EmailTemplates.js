/**
 * FRAN_EMAIL_DESIGN_SYSTEM_V3 — direction: Editorial Clinical Human.
 *
 * Transactional lifecycle email: HTML + a fully equivalent text/plain body.
 * Contracts held by this file:
 * - text-first brand header; the email is complete with zero images
 * - exactly one primary action per lifecycle state
 * - presentation tables + inline CSS only (no JS, Grid, Flex, SVG, forms)
 * - patient cancellation copy carries no economic vocabulary
 * - REFUND_FAILED_MANUAL_REVIEW stays internal/operational, never patient copy
 */

var EMAIL_V3 = Object.freeze({
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
  cancelAccent: '#B46E6A',
  link: '#8C6B52',
  white: '#FFFFFF',
  display: "'Cormorant Garamond', Georgia, 'Times New Roman', serif",
  sans: "'DM Sans', Arial, Helvetica, sans-serif",
  maxWidth: 600,
});

var EMAIL_V3_BRAND = Object.freeze({
  wordmark: 'FRANCISCA BUSTOS M.',
  descriptor: 'PSICOLOGÍA PERINATAL',
  promise: 'Acompañamiento psicológico en embarazo, posparto y transición a la maternidad.',
  whatsappUrl: 'https://wa.me/56957663038',
  emailAddress: 'hola@franciscabustos.cl',
});

var EMAIL_V3_PREHEADER = Object.freeze({
  confirmed: 'Fecha, hora y enlace para entrar a tu sesión.',
  rescheduled: 'Revisa tu nueva fecha y el enlace de la sesión.',
  cancelled: 'Confirmación de cancelación de tu sesión.',
  cancelledRefunded: 'Confirmación de cancelación y reembolso de tu sesión.',
  internal: 'Revisión operativa interna. No es confirmación de reembolso al paciente.',
  generic: 'Actualización operativa de tu reserva.',
});

// Approved universal human copy. Rendered on every confirmation, initial and
// follow-up alike; it makes no claim about which session this is.
var EMAIL_V3_SESSION_COPY = 'No necesitas preparar nada especial para la sesión. '
  + 'Puedes llegar con lo que tengas hoy, aunque todavía sea difícil ponerlo en palabras.';

// Approved refund copy. Rendered only once the provider has confirmed the
// refund as REFUNDED, never before.
var EMAIL_V3_REFUND_COPY = 'El reembolso fue procesado al mismo medio de pago utilizado. '
  + 'Dependiendo de tu banco o emisor, puede tardar hasta 10 días hábiles en verse reflejado.';

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

function lifecycleNotificationSubject_(eventType, dateParts) {
  const parts = dateParts || {};
  const date = String(parts.date || '');
  const time = String(parts.time || '');
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.BOOKING_CONFIRMED && date && time) {
    return 'Tu sesión está confirmada · ' + date + ' a las ' + time;
  }
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED && date && time) {
    return 'Tu sesión fue reagendada · ' + date + ' a las ' + time;
  }
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) {
    return 'Hubo un cambio en tu próxima sesión';
  }
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.SESSION_CANCELLED) {
    return 'Tu sesión fue cancelada';
  }
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_REQUESTED) return 'Solicitud de reembolso en curso';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_COMPLETED) return 'Reembolso completado';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) {
    return 'Revisión operativa: reembolso pendiente de política';
  }
  return 'Actualización de tu reserva';
}

/** Lifecycle event -> V3 visual state. One state, one primary action. */
function lifecycleEmailV3Kind_(eventType) {
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.BOOKING_CONFIRMED) return 'confirmed';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED) return 'rescheduled';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) return 'clinician_rescheduled';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.SESSION_CANCELLED) return 'cancelled';
  if (eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) return 'internal';
  return 'generic';
}

function emailV3Origin_(input) {
  return String(input && input.previewOrigin || '').replace(/\/$/, '');
}

function emailV3BookingUrl_(origin) {
  return (origin || 'https://franciscabustos.cl') + '/reserva';
}

/** "$50.000" from the canonical CLP integer. Never hardcodes an amount. */
function emailV3FormatClp_(amount) {
  const value = Math.round(Number(amount) || 0);
  return '$' + String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function emailV3SessionDurationLabel_() {
  const minutes = typeof SESSION_DURATION_MINUTES === 'number' ? SESSION_DURATION_MINUTES : 0;
  return minutes ? minutes + ' minutos' : '';
}

function emailV3AmountLabel_(record) {
  if (typeof consultationAmountClp_ !== 'function') return '';
  const amount = consultationAmountClp_(record && record.service_type);
  return amount ? emailV3FormatClp_(amount) : '';
}

/**
 * The reservation schema stores no patient name (deliberate minimisation), so
 * the greeting degrades to "Hola," unless a name is present on the record.
 */
/**
 * True only for the final cancellation email: the event is the provider-confirmed
 * variant AND the record itself still reads REFUNDED. Both must agree before any
 * refund claim is rendered, so a mis-routed event cannot produce a false claim.
 */
function emailV3RefundConfirmed_(eventType, record) {
  const confirmedEvent = eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED;
  return confirmedEvent && String(record && record.refund_status || '') === LIFECYCLE.REFUND_STATUS.REFUNDED;
}

function emailV3Greeting_(record) {
  const raw = String(record && (record.patient_first_name || record.patient_name) || '').trim();
  const first = raw ? raw.split(/\s+/)[0].slice(0, 40) : '';
  return first ? 'Hola, ' + first : 'Hola,';
}

// ---------------------------------------------------------------------------
// HTML primitives. Presentation tables + inline CSS only.
// ---------------------------------------------------------------------------

function emailV3Style_() {
  return '<style type="text/css">'
    + 'body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}'
    + 'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}'
    + 'table{border-collapse:collapse;}'
    + 'img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}'
    + '@media only screen and (max-width:599px){'
    + '.v3-outer{padding:12px !important;}'
    + '.v3-pad{padding-left:16px !important;padding-right:16px !important;}'
    + '.v3-h1{font-size:30px !important;}'
    + '.v3-wordmark{font-size:20px !important;}'
    + '.v3-descriptor{font-size:9px !important;}'
    + '.v3-lbl{display:block !important;width:100% !important;padding:12px 0 4px 0 !important;border-bottom:0 !important;}'
    + '.v3-val{display:block !important;width:100% !important;padding:0 0 12px 0 !important;}'
    + '.v3-col{display:block !important;width:100% !important;padding:0 0 8px 0 !important;}'
    + '.v3-col-last{padding:0 !important;}'
    + '}'
    + '@media (prefers-color-scheme:dark){'
    + '.v3-page{background-color:' + EMAIL_V3.cream + ' !important;}'
    + '.v3-card{background-color:' + EMAIL_V3.paper + ' !important;}'
    + '.v3-ink{color:' + EMAIL_V3.charcoal + ' !important;}'
    + '.v3-ink2{color:' + EMAIL_V3.textSecondary + ' !important;}'
    + '.v3-ink3{color:' + EMAIL_V3.textMuted + ' !important;}'
    + '}'
    + '</style>';
}

function emailV3Preheader_(text) {
  const hidden = 'display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;'
    + 'opacity:0;overflow:hidden;mso-hide:all;';
  let spacer = '';
  for (let index = 0; index < 40; index += 1) spacer += '&#847;&zwnj;&nbsp;';
  return '<div style="' + hidden + '">' + escapeEmailText_(text) + '</div>'
    + '<div style="' + hidden + '">' + spacer + '</div>';
}

function emailV3Document_(options) {
  return '<!DOCTYPE html><html lang="es-CL"><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="X-UA-Compatible" content="IE=edge">'
    + '<meta name="color-scheme" content="light">'
    + '<meta name="supported-color-schemes" content="light">'
    + '<title>' + escapeEmailText_(options.title) + '</title>'
    + '<!--[if mso]><style type="text/css">body,table,td,div,p,a{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->'
    + emailV3Style_()
    + '</head>'
    + '<body class="v3-page" style="margin:0;padding:0;width:100%;background-color:' + EMAIL_V3.cream
    + ';color:' + EMAIL_V3.charcoal + ';">'
    + emailV3Preheader_(options.preheader)
    + '<table role="presentation" class="v3-page" width="100%" cellpadding="0" cellspacing="0" border="0"'
    + ' bgcolor="' + EMAIL_V3.cream + '" style="width:100%;background-color:' + EMAIL_V3.cream + ';">'
    + '<tr><td class="v3-outer" align="center" style="padding:24px;">'
    + '<table role="presentation" class="v3-card" width="600" cellpadding="0" cellspacing="0" border="0"'
    + ' bgcolor="' + EMAIL_V3.paper + '" style="width:100%;max-width:' + EMAIL_V3.maxWidth + 'px;'
    + 'background-color:' + EMAIL_V3.paper + ';border:1px solid ' + EMAIL_V3.border + ';border-radius:4px;">'
    + options.rows
    + '</table>'
    + '</td></tr></table></body></html>';
}

function emailV3Header_() {
  return '<tr><td class="v3-pad v3-wordmark v3-ink" style="padding:28px 28px 0 28px;font-family:' + EMAIL_V3.display
    + ';font-size:22px;font-weight:500;line-height:1.15;letter-spacing:.02em;color:' + EMAIL_V3.charcoal
    + ';text-align:left;">' + EMAIL_V3_BRAND.wordmark + '</td></tr>'
    + '<tr><td class="v3-pad v3-descriptor v3-ink3" style="padding:8px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:10px;font-weight:600;line-height:1.4;letter-spacing:.18em;color:' + EMAIL_V3.textMuted
    + ';text-transform:uppercase;text-align:left;">' + EMAIL_V3_BRAND.descriptor + '</td></tr>';
}

function emailV3Rule_(top, bottom) {
  return '<tr><td class="v3-pad" style="padding:' + top + 'px 28px ' + bottom + 'px 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + '<td height="1" style="height:1px;line-height:1px;font-size:0;background-color:' + EMAIL_V3.border
    + ';">&nbsp;</td></tr></table></td></tr>';
}

function emailV3Eyebrow_(text, background, color) {
  // A paper gap keeps the status band from fusing with the brand header.
  return '<tr><td style="height:24px;line-height:24px;font-size:0;">&nbsp;</td></tr>'
    + '<tr><td class="v3-pad" bgcolor="' + background + '" style="padding:12px 28px;background-color:' + background
    + ';font-family:' + EMAIL_V3.sans + ';font-size:10px;font-weight:600;line-height:1.4;letter-spacing:.16em;'
    + 'text-transform:uppercase;color:' + color + ';">' + escapeEmailText_(text) + '</td></tr>';
}

function emailV3Headline_(text) {
  return '<tr><td class="v3-pad v3-h1 v3-ink" style="padding:28px 28px 0 28px;font-family:' + EMAIL_V3.display
    + ';font-size:38px;font-weight:500;line-height:1.08;letter-spacing:-0.01em;color:' + EMAIL_V3.charcoal
    + ';">' + escapeEmailText_(text) + '</td></tr>';
}

function emailV3Body_(html, top, color) {
  return '<tr><td class="v3-pad v3-ink2" style="padding:' + top + 'px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;font-weight:400;line-height:1.55;color:' + (color || EMAIL_V3.textSecondary) + ';">'
    + html + '</td></tr>';
}

function emailV3Details_(rows) {
  if (!rows || !rows.length) return '';
  let cells = '';
  rows.forEach(function(row) {
    const edge = 'border-bottom:1px solid ' + EMAIL_V3.border + ';';
    cells += '<tr>'
      + '<td class="v3-lbl v3-ink3" width="128" style="width:128px;padding:12px 12px 12px 0;' + edge
      + 'vertical-align:top;font-family:' + EMAIL_V3.sans + ';font-size:10px;font-weight:600;line-height:1.4;'
      + 'letter-spacing:.12em;text-transform:uppercase;color:' + EMAIL_V3.textMuted + ';">'
      + escapeEmailText_(row[0]) + '</td>'
      + '<td class="v3-val v3-ink" style="padding:12px 0;' + edge + 'vertical-align:top;font-family:' + EMAIL_V3.sans
      + ';font-size:14px;font-weight:500;line-height:1.5;color:' + EMAIL_V3.charcoal + ';word-break:break-word;">'
      + escapeEmailText_(row[1]) + '</td>'
      + '</tr>';
  });
  return '<tr><td class="v3-pad" style="padding:24px 28px 0 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + cells
    + '</table></td></tr>';
}

/**
 * Highlighted schedule block.
 *
 * ANTES is rendered only when the record can prove the immediately previous
 * appointment time. That holds for a patient reschedule, which the state
 * machine caps at one move, so original_start_at is the prior slot. It does not
 * hold for a clinician change that follows a patient reschedule, so the
 * clinician variant shows NUEVA FECHA alone rather than a misleading ANTES.
 */
function emailV3ScheduleHighlight_(previousValue, newValue) {
  function label(text, color, top) {
    return '<tr><td class="v3-ink' + (color === EMAIL_V3.charcoal ? '' : '3') + '" style="padding:' + top
      + 'px 16px 0 16px;font-family:' + EMAIL_V3.sans
      + ';font-size:10px;font-weight:600;line-height:1.4;letter-spacing:.12em;text-transform:uppercase;color:'
      + color + ';">' + text + '</td></tr>';
  }
  let inner = '';
  if (previousValue) {
    inner += label('ANTES', EMAIL_V3.textMuted, 16)
      + '<tr><td class="v3-ink2" style="padding:4px 16px 0 16px;font-family:' + EMAIL_V3.sans
      + ';font-size:14px;font-weight:500;line-height:1.5;color:' + EMAIL_V3.textSecondary + ';">'
      + escapeEmailText_(previousValue) + '</td></tr>'
      + '<tr><td style="padding:12px 16px 0 16px;font-family:' + EMAIL_V3.sans
      + ';font-size:16px;line-height:1;color:' + EMAIL_V3.taupe + ';">&#8594;</td></tr>'
      + label('NUEVA FECHA', EMAIL_V3.charcoal, 12);
  } else {
    inner += label('NUEVA FECHA', EMAIL_V3.charcoal, 16);
  }
  inner += '<tr><td class="v3-ink" style="padding:4px 16px 16px 16px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;font-weight:600;line-height:1.5;color:' + EMAIL_V3.charcoal + ';">'
    + escapeEmailText_(newValue) + '</td></tr>';
  return '<tr><td class="v3-pad" style="padding:24px 28px 0 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + EMAIL_V3.cream
    + '" style="width:100%;background-color:' + EMAIL_V3.cream + ';border:1px solid ' + EMAIL_V3.border
    + ';border-radius:4px;">' + inner + '</table></td></tr>';
}

/** Quiet information block: thin border, cream ground, label eyebrow, no icon. */
function emailV3InfoBlock_(label, text) {
  return '<tr><td class="v3-pad" style="padding:24px 28px 0 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + EMAIL_V3.cream
    + '" style="width:100%;background-color:' + EMAIL_V3.cream + ';border:1px solid ' + EMAIL_V3.border
    + ';border-radius:4px;">'
    + '<tr><td class="v3-ink3" style="padding:16px 16px 0 16px;font-family:' + EMAIL_V3.sans
    + ';font-size:10px;font-weight:600;line-height:1.4;letter-spacing:.12em;text-transform:uppercase;color:'
    + EMAIL_V3.textMuted + ';">' + label + '</td></tr>'
    + '<tr><td class="v3-ink2" style="padding:8px 16px 16px 16px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;font-weight:400;line-height:1.55;color:' + EMAIL_V3.textSecondary + ';">'
    + escapeEmailText_(text) + '</td></tr>'
    + '</table></td></tr>';
}

function emailV3Button_(href, label, primary) {
  if (!href || !label) return '';
  const background = primary ? EMAIL_V3.charcoal : EMAIL_V3.paper;
  const color = primary ? EMAIL_V3.white : EMAIL_V3.charcoal;
  const edge = primary ? EMAIL_V3.charcoal : EMAIL_V3.taupe;
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">'
    + '<tr><td align="center" height="48" bgcolor="' + background + '" style="height:48px;background-color:' + background
    + ';border:1px solid ' + edge + ';border-radius:2px;mso-padding-alt:0;">'
    + '<a href="' + escapeEmailText_(href) + '" target="_blank" style="display:block;min-height:48px;line-height:48px;'
    + 'mso-line-height-rule:exactly;padding:0 12px;font-family:' + EMAIL_V3.sans + ';font-size:12px;font-weight:600;'
    + 'letter-spacing:.18em;text-transform:uppercase;text-align:center;text-decoration:none;color:' + color + ';">'
    + escapeEmailText_(label) + '</a></td></tr></table>';
}

function emailV3PrimaryRow_(href, label) {
  const button = emailV3Button_(href, label, true);
  if (!button) return '';
  return '<tr><td class="v3-pad" style="padding:32px 28px 0 28px;">' + button + '</td></tr>';
}

/** Desktop: up to two secondaries share a 50/50 row with an 8px gutter. Mobile stacks. */
function emailV3SecondaryRow_(actions) {
  const buttons = (actions || []).filter(function(item) { return item && item.href && item.label; })
    .map(function(item) { return emailV3Button_(item.href, item.label, false); });
  if (!buttons.length) return '';
  if (buttons.length === 1) {
    return '<tr><td class="v3-pad" style="padding:16px 28px 0 28px;">' + buttons[0] + '</td></tr>';
  }
  return '<tr><td class="v3-pad" style="padding:16px 28px 0 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>'
    // 4px + 4px is the 8px desktop gutter; on mobile the cells stack with an 8px gap.
    + '<td class="v3-col" width="50%" valign="top" style="width:50%;padding:0 4px 0 0;">' + buttons[0] + '</td>'
    + '<td class="v3-col v3-col-last" width="50%" valign="top" style="width:50%;padding:0 0 0 4px;">' + buttons[1] + '</td>'
    + '</tr></table></td></tr>';
}

/** The Meet URL is always readable as text, never only behind a button. */
function emailV3MeetFallback_(meetUrl) {
  if (!meetUrl) return '';
  return '<tr><td class="v3-pad v3-ink3" style="padding:16px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;font-weight:400;line-height:1.55;color:' + EMAIL_V3.textMuted + ';">'
    + 'Si el botón no funciona, entra desde este enlace:</td></tr>'
    + '<tr><td class="v3-pad" style="padding:4px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:14px;line-height:1.5;">'
    + '<a href="' + escapeEmailText_(meetUrl) + '" target="_blank" style="color:' + EMAIL_V3.link
    + ';text-decoration:underline;word-break:break-all;">' + escapeEmailText_(meetUrl) + '</a></td></tr>';
}

function emailV3Footer_(origin) {
  const site = origin || 'https://franciscabustos.cl';
  const siteLabel = site.replace(/^https?:\/\//, '');
  return emailV3Rule_(32, 0)
    + '<tr><td class="v3-pad v3-ink" style="padding:24px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;font-weight:500;line-height:1.55;color:' + EMAIL_V3.charcoal + ';">¿Necesitas ayuda?</td></tr>'
    + '<tr><td class="v3-pad" style="padding:8px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;line-height:1.55;color:' + EMAIL_V3.textSecondary + ';">'
    + '<a href="' + EMAIL_V3_BRAND.whatsappUrl + '" target="_blank" style="color:' + EMAIL_V3.link
    + ';text-decoration:underline;">WhatsApp</a>'
    + '<span style="color:' + EMAIL_V3.taupe + ';"> &middot; </span>'
    + '<a href="mailto:' + EMAIL_V3_BRAND.emailAddress + '" style="color:' + EMAIL_V3.link
    + ';text-decoration:underline;">Email</a></td></tr>'
    + emailV3Rule_(24, 0)
    + '<tr><td class="v3-pad v3-ink3" style="padding:24px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:10px;font-weight:600;line-height:1.5;letter-spacing:.12em;text-transform:uppercase;color:'
    + EMAIL_V3.textMuted + ';">' + EMAIL_V3_BRAND.wordmark + ' &middot; ' + EMAIL_V3_BRAND.descriptor + '</td></tr>'
    + '<tr><td class="v3-pad v3-ink2" style="padding:12px 28px 0 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;font-weight:400;line-height:1.55;color:' + EMAIL_V3.textSecondary + ';">'
    + EMAIL_V3_BRAND.promise + '</td></tr>'
    + '<tr><td class="v3-pad" style="padding:12px 28px 32px 28px;font-family:' + EMAIL_V3.sans
    + ';font-size:16px;line-height:1.55;">'
    + '<a href="' + escapeEmailText_(site) + '" target="_blank" style="color:' + EMAIL_V3.link
    + ';text-decoration:underline;">' + escapeEmailText_(siteLabel) + '</a></td></tr>';
}

// ---------------------------------------------------------------------------
// Per-state view models
// ---------------------------------------------------------------------------

function emailV3SessionRows_(record, parts) {
  const rows = [];
  if (parts.date) rows.push(['Fecha', parts.date]);
  if (parts.time) rows.push(['Hora', parts.time + ' (Chile)']);
  const modality = typeof patientFacingModalityLabel_ === 'function'
    ? patientFacingModalityLabel_(record.modality) : '';
  if (modality) rows.push(['Modalidad', modality]);
  const duration = emailV3SessionDurationLabel_();
  if (duration) rows.push(['Duración', duration]);
  const amount = emailV3AmountLabel_(record);
  if (amount) rows.push(['Valor', amount]);
  return rows;
}

function emailV3ScheduleActions_(kind, tokens, origin) {
  const actions = [];
  // REAGENDAR exists only on the confirmed state. After any reschedule the
  // state machine has revoked the capability and V3 offers no second move.
  if (kind === 'confirmed' && tokens.RESCHEDULE) {
    actions.push({ href: managementPageUrl_(origin, tokens.RESCHEDULE, 'reschedule'), label: 'REAGENDAR SESIÓN' });
  }
  if (tokens.CANCEL) {
    actions.push({ href: managementPageUrl_(origin, tokens.CANCEL, 'cancel'), label: 'CANCELAR SESIÓN' });
  }
  return actions;
}

function emailV3InternalRows_(record) {
  return [
    ['Reserva', String(record.reservation_id || '')],
    ['Pago', String(record.payment_status || '')],
    ['Reembolso', String(record.refund_status || '')],
    ['Motivo', String(record.refund_last_error_code || 'BUSINESS_POLICY_TBD')],
    ['Proveedor', typeof providerRefundAttempted_ === 'function' && providerRefundAttempted_(record)
      ? 'intentado' : 'no intentado'],
    ['Próxima acción', 'revisión humana'],
  ];
}

function renderLifecycleEmailHtml_(input) {
  const notification = input.notification;
  const record = input.record;
  const tokens = input.capabilityTokens || {};
  const origin = emailV3Origin_(input);
  const kind = lifecycleEmailV3Kind_(notification.eventType);
  const parts = lifecycleEmailDateParts_(record.current_start_at);
  const previous = lifecycleEmailDateParts_(record.original_start_at);
  const subject = lifecycleNotificationSubject_(notification.eventType, parts);
  const showsMeet = typeof lifecycleNotificationShowsMeet_ === 'function'
    && lifecycleNotificationShowsMeet_(notification.eventType);
  const meetUrl = showsMeet && notification.meet && notification.meet.meetUrl
    ? String(notification.meet.meetUrl) : '';

  if (kind === 'internal') {
    return emailV3Document_({
      title: subject,
      preheader: EMAIL_V3_PREHEADER.internal,
      rows: emailV3Header_()
        + emailV3Eyebrow_('REVISIÓN OPERATIVA INTERNA', EMAIL_V3.cream, EMAIL_V3.textMuted)
        + emailV3Headline_('Revisión operativa interna.')
        + emailV3Body_('No es confirmación de reembolso al paciente. La reserva requiere revisión humana.', 16)
        + emailV3Details_(emailV3InternalRows_(record))
        + emailV3Rule_(32, 0)
        + '<tr><td class="v3-pad v3-ink3" style="padding:24px 28px 32px 28px;font-family:' + EMAIL_V3.sans
        + ';font-size:10px;font-weight:600;line-height:1.5;letter-spacing:.12em;text-transform:uppercase;color:'
        + EMAIL_V3.textMuted + ';">' + EMAIL_V3_BRAND.wordmark + ' &middot; ' + EMAIL_V3_BRAND.descriptor
        + '</td></tr>',
    });
  }

  if (kind === 'cancelled') {
    // Fail-closed: no modality, duration, value, Meet, management links, or any
    // payment/refund vocabulary. BUSINESS_POLICY_TBD is unchanged; it is simply
    // not something this email speaks about.
    const cancelledRows = [];
    if (parts.date) cancelledRows.push(['Fecha', parts.date]);
    if (parts.time) cancelledRows.push(['Hora', parts.time + ' (Chile)']);
    const when = parts.date && parts.time
      ? 'La sesión agendada para el ' + parts.date + ' a las ' + parts.time + ' fue cancelada.'
      : 'La sesión que tenías agendada fue cancelada.';
    const refundConfirmed = emailV3RefundConfirmed_(notification.eventType, record);
    return emailV3Document_({
      title: subject,
      preheader: refundConfirmed ? EMAIL_V3_PREHEADER.cancelledRefunded : EMAIL_V3_PREHEADER.cancelled,
      rows: emailV3Header_()
        + emailV3Eyebrow_('TU SESIÓN FUE CANCELADA', EMAIL_V3.cancelBg, EMAIL_V3.cancelAccent)
        + emailV3Headline_('Tu sesión fue cancelada.')
        + emailV3Body_(escapeEmailText_(emailV3Greeting_(record)), 24, EMAIL_V3.charcoal)
        + emailV3Body_(escapeEmailText_(when), 16)
        + emailV3Details_(cancelledRows)
        + (refundConfirmed ? emailV3InfoBlock_('REEMBOLSO', EMAIL_V3_REFUND_COPY) : '')
        + emailV3PrimaryRow_(emailV3BookingUrl_(origin), 'AGENDAR NUEVA SESIÓN')
        + emailV3SecondaryRow_([{ href: EMAIL_V3_BRAND.whatsappUrl, label: 'CONTACTAR POR WHATSAPP' }])
        + emailV3Body_('Si necesitas apoyo o tienes dudas, puedes escribirnos. '
          + 'Estamos aquí para acompañarte cuando lo necesites.', 32)
        + emailV3Footer_(origin),
    });
  }

  if (kind === 'confirmed' || kind === 'rescheduled' || kind === 'clinician_rescheduled') {
    let eyebrow = 'TU SESIÓN ESTÁ CONFIRMADA';
    let headline = 'Tu sesión está confirmada.';
    let lead = parts.date && parts.time
      ? 'Te esperamos el ' + parts.date + ' a las ' + parts.time + '.'
      : 'Te esperamos en la fecha agendada.';
    let preheader = EMAIL_V3_PREHEADER.confirmed;
    let band = EMAIL_V3.successBg;
    let bandColor = EMAIL_V3.charcoal;
    if (kind === 'rescheduled') {
      eyebrow = 'TU SESIÓN FUE REAGENDADA';
      headline = 'Tu sesión fue reagendada.';
      lead = 'Te esperamos en tu nueva fecha.';
      preheader = EMAIL_V3_PREHEADER.rescheduled;
      band = EMAIL_V3.cream;
    } else if (kind === 'clinician_rescheduled') {
      eyebrow = 'HUBO UN CAMBIO EN TU PRÓXIMA SESIÓN';
      headline = 'Hubo un cambio en tu próxima sesión.';
      lead = 'Actualicé el horario. Revisa a continuación la nueva fecha.';
      preheader = EMAIL_V3_PREHEADER.rescheduled;
      band = EMAIL_V3.cream;
    }

    let highlight = '';
    if (kind === 'clinician_rescheduled' && parts.combined) {
      highlight = emailV3ScheduleHighlight_('', parts.date + ' · ' + parts.time);
    } else if (kind === 'rescheduled' && previous.combined && parts.combined
      && record.original_start_at !== record.current_start_at) {
      highlight = emailV3ScheduleHighlight_(previous.date + ' · ' + previous.time, parts.date + ' · ' + parts.time);
    }

    const humanCopy = kind === 'confirmed' ? emailV3Body_(EMAIL_V3_SESSION_COPY, 32) : '';

    return emailV3Document_({
      title: subject,
      preheader: preheader,
      rows: emailV3Header_()
        + emailV3Eyebrow_(eyebrow, band, bandColor)
        + emailV3Headline_(headline)
        + emailV3Body_(escapeEmailText_(emailV3Greeting_(record)), 24, EMAIL_V3.charcoal)
        + emailV3Body_(escapeEmailText_(lead), 16)
        + highlight
        + emailV3Details_(emailV3SessionRows_(record, parts))
        + emailV3PrimaryRow_(meetUrl, 'ENTRAR A LA SESIÓN')
        + emailV3MeetFallback_(meetUrl)
        + emailV3SecondaryRow_(emailV3ScheduleActions_(kind, tokens, origin))
        + humanCopy
        + emailV3Footer_(origin),
    });
  }

  // Dormant operational states (REFUND_REQUESTED / REFUND_COMPLETED / unknown).
  // V3 chrome, existing copy, no invented policy language, no CTA.
  return emailV3Document_({
    title: subject,
    preheader: EMAIL_V3_PREHEADER.generic,
    rows: emailV3Header_()
      + emailV3Eyebrow_('ACTUALIZACIÓN DE TU RESERVA', EMAIL_V3.cream, EMAIL_V3.textMuted)
      + emailV3Headline_(subject)
      + emailV3Body_(escapeEmailText_(emailV3Greeting_(record)), 24, EMAIL_V3.charcoal)
      + emailV3Body_('Te escribimos con una actualización operativa de tu reserva.', 16)
      + emailV3Footer_(origin),
  });
}

// ---------------------------------------------------------------------------
// text/plain — same operational content, same forbidden rules
// ---------------------------------------------------------------------------

function emailV3TextHeader_() {
  return [EMAIL_V3_BRAND.wordmark, EMAIL_V3_BRAND.descriptor, ''];
}

function emailV3TextFooter_(origin) {
  return [
    '',
    '¿Necesitas ayuda?',
    'WhatsApp: ' + EMAIL_V3_BRAND.whatsappUrl,
    'Email: ' + EMAIL_V3_BRAND.emailAddress,
    '',
    EMAIL_V3_BRAND.wordmark + ' · ' + EMAIL_V3_BRAND.descriptor,
    EMAIL_V3_BRAND.promise,
    origin || 'https://franciscabustos.cl',
  ];
}

function renderLifecycleEmailText_(input) {
  const notification = input.notification;
  const record = input.record;
  const tokens = input.capabilityTokens || {};
  const origin = emailV3Origin_(input);
  const kind = lifecycleEmailV3Kind_(notification.eventType);
  const parts = lifecycleEmailDateParts_(record.current_start_at);
  const previous = lifecycleEmailDateParts_(record.original_start_at);
  const showsMeet = typeof lifecycleNotificationShowsMeet_ === 'function'
    && lifecycleNotificationShowsMeet_(notification.eventType);
  const meetUrl = showsMeet && notification.meet && notification.meet.meetUrl
    ? String(notification.meet.meetUrl) : '';

  if (kind === 'internal') {
    return [
      'REVISIÓN OPERATIVA INTERNA',
      '',
      'No es confirmación de reembolso al paciente. La reserva requiere revisión humana.',
      '',
      'Reserva: ' + String(record.reservation_id || ''),
      'Pago: ' + String(record.payment_status || ''),
      'Reembolso: ' + String(record.refund_status || ''),
      'Motivo: ' + String(record.refund_last_error_code || 'BUSINESS_POLICY_TBD'),
      'Reembolso en proveedor: ' + (typeof providerRefundAttempted_ === 'function'
        && providerRefundAttempted_(record) ? 'intentado' : 'no intentado'),
      'Próxima acción: revisión humana.',
      '',
      EMAIL_V3_BRAND.wordmark + ' · ' + EMAIL_V3_BRAND.descriptor,
    ].join('\n');
  }

  if (kind === 'cancelled') {
    const lines = emailV3TextHeader_();
    lines.push('TU SESIÓN FUE CANCELADA', '', emailV3Greeting_(record), '');
    lines.push(parts.date && parts.time
      ? 'La sesión agendada para el ' + parts.date + ' a las ' + parts.time + ' fue cancelada.'
      : 'La sesión que tenías agendada fue cancelada.');
    lines.push('');
    if (parts.date) lines.push('Fecha: ' + parts.date);
    if (parts.time) lines.push('Hora: ' + parts.time + ' (Chile)');
    if (emailV3RefundConfirmed_(notification.eventType, record)) {
      lines.push('', 'REEMBOLSO', EMAIL_V3_REFUND_COPY);
    }
    lines.push('', 'Agendar nueva sesión: ' + emailV3BookingUrl_(origin));
    lines.push('Contactar por WhatsApp: ' + EMAIL_V3_BRAND.whatsappUrl);
    lines.push('', 'Si necesitas apoyo o tienes dudas, puedes escribirnos. '
      + 'Estamos aquí para acompañarte cuando lo necesites.');
    return lines.concat(emailV3TextFooter_(origin)).join('\n');
  }

  if (kind === 'confirmed' || kind === 'rescheduled' || kind === 'clinician_rescheduled') {
    const lines = emailV3TextHeader_();
    if (kind === 'confirmed') {
      lines.push('TU SESIÓN ESTÁ CONFIRMADA', '', emailV3Greeting_(record), '');
      lines.push(parts.date && parts.time
        ? 'Te esperamos el ' + parts.date + ' a las ' + parts.time + '.'
        : 'Te esperamos en la fecha agendada.');
    } else if (kind === 'rescheduled') {
      lines.push('TU SESIÓN FUE REAGENDADA', '', emailV3Greeting_(record), '', 'Te esperamos en tu nueva fecha.');
    } else {
      lines.push('HUBO UN CAMBIO EN TU PRÓXIMA SESIÓN', '', emailV3Greeting_(record), '',
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
    if (parts.date) lines.push('Fecha: ' + parts.date);
    if (parts.time) lines.push('Hora: ' + parts.time + ' (Chile)');
    const modality = typeof patientFacingModalityLabel_ === 'function'
      ? patientFacingModalityLabel_(record.modality) : '';
    if (modality) lines.push('Modalidad: ' + modality);
    const duration = emailV3SessionDurationLabel_();
    if (duration) lines.push('Duración: ' + duration);
    const amount = emailV3AmountLabel_(record);
    if (amount) lines.push('Valor: ' + amount);
    if (meetUrl) lines.push('', 'Entrar a la sesión: ' + meetUrl);
    const actions = emailV3ScheduleActions_(kind, tokens, origin);
    if (actions.length) lines.push('');
    actions.forEach(function(action) {
      lines.push((action.label === 'REAGENDAR SESIÓN' ? 'Reagendar: ' : 'Cancelar: ') + action.href);
    });
    if (kind === 'confirmed') lines.push('', EMAIL_V3_SESSION_COPY);
    return lines.concat(emailV3TextFooter_(origin)).join('\n');
  }

  const lines = emailV3TextHeader_();
  lines.push('ACTUALIZACIÓN DE TU RESERVA', '', emailV3Greeting_(record), '',
    'Te escribimos con una actualización operativa de tu reserva.');
  return lines.concat(emailV3TextFooter_(origin)).join('\n');
}

var __EMAIL_TEMPLATE_TEST_EXPORTS__ = Object.freeze({
  EMAIL_V3: EMAIL_V3,
  EMAIL_V3_BRAND: EMAIL_V3_BRAND,
  EMAIL_V3_PREHEADER: EMAIL_V3_PREHEADER,
  EMAIL_V3_SESSION_COPY: EMAIL_V3_SESSION_COPY,
  EMAIL_V3_REFUND_COPY: EMAIL_V3_REFUND_COPY,
  emailV3RefundConfirmed_: emailV3RefundConfirmed_,
  lifecycleEmailDateParts_: lifecycleEmailDateParts_,
  lifecycleNotificationSubject_: lifecycleNotificationSubject_,
  lifecycleEmailV3Kind_: lifecycleEmailV3Kind_,
  emailV3FormatClp_: emailV3FormatClp_,
  renderLifecycleEmailHtml_: renderLifecycleEmailHtml_,
  renderLifecycleEmailText_: renderLifecycleEmailText_,
});
