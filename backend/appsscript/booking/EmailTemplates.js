/**
 * Lifecycle email V2 — transactional HTML + text/plain.
 * Brand tokens match assets/styles.css. No diagnosis, marketing, or Instagram.
 */

var EMAIL_BRAND = Object.freeze({
  bg: '#FAF6F0',
  paper: '#FDFBF7',
  ink: '#231F1C',
  ink2: '#5A534D',
  ink3: '#8A8178',
  malva: '#8A5A6B',
  malvaDeep: '#6D4454',
  malvaSoft: '#C9A8B3',
  line: '#E5DED1',
  serif: "Georgia, 'Times New Roman', Times, serif",
  sans: "Arial, Helvetica, sans-serif",
  maxWidth: 600,
});

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

function googleCalendarTemplateUrl_(startIso, endIso, title) {
  const startMs = Date.parse(String(startIso || ''));
  const endMs = Date.parse(String(endIso || ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return '';
  function basic(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }
  const params = [
    'action=TEMPLATE',
    'text=' + encodeURIComponent(String(title || 'Sesión · Francisca Bustos')),
    'dates=' + encodeURIComponent(basic(startMs) + '/' + basic(endMs)),
  ];
  return 'https://calendar.google.com/calendar/render?' + params.join('&');
}

function escapeEmailText_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emailCtaButton_(href, label, primary) {
  if (!href || !label) return '';
  const bg = primary ? EMAIL_BRAND.malva : EMAIL_BRAND.paper;
  const color = primary ? '#FFFFFF' : EMAIL_BRAND.malvaDeep;
  const border = primary ? EMAIL_BRAND.malva : EMAIL_BRAND.malvaSoft;
  return '<tr><td align="center" style="padding:0 0 12px 0;">'
    + '<a href="' + escapeEmailText_(href) + '" style="display:inline-block;min-height:44px;line-height:44px;padding:0 22px;'
    + 'background:' + bg + ';color:' + color + ';border:1px solid ' + border + ';border-radius:8px;'
    + 'font-family:' + EMAIL_BRAND.sans + ';font-size:16px;font-weight:600;text-decoration:none;">'
    + escapeEmailText_(label) + '</a></td></tr>';
}

function renderLifecycleEmailHtml_(input) {
  const notification = input.notification;
  const record = input.record;
  const tokens = input.capabilityTokens || {};
  const origin = String(input.previewOrigin || '').replace(/\/$/, '');
  const cancelledTbd = notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.SESSION_CANCELLED;
  const cancelled = notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED
    || cancelledTbd;
  const refundFailed = notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW;
  const parts = lifecycleEmailDateParts_(record.current_start_at);
  const modality = patientFacingModalityLabel_(record.modality);
  const meetUrl = !cancelled && !refundFailed && lifecycleNotificationShowsMeet_(notification.eventType)
    && notification.meet && notification.meet.meetUrl ? String(notification.meet.meetUrl) : '';
  const rescheduleUrl = !cancelled && !refundFailed && tokens.RESCHEDULE ? managementPageUrl_(origin, tokens.RESCHEDULE, 'reschedule') : '';
  const cancelUrl = !cancelled && !refundFailed && tokens.CANCEL ? managementPageUrl_(origin, tokens.CANCEL, 'cancel') : '';
  const calendarUrl = !cancelled && !refundFailed ? googleCalendarTemplateUrl_(record.current_start_at, record.current_end_at, 'Sesión con Francisca Bustos') : '';
  const logoUrl = 'https://franciscabustos.cl/assets/logo-franciscabustos.png';

  let headline = 'Tu sesión está confirmada';
  let lead = 'Quedó agendada. Conserva este correo como respaldo de la hora.';
  if (notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED) {
    headline = 'Tu sesión fue reagendada';
    lead = 'La nueva hora ya está confirmada. No hay un nuevo cobro.';
  } else if (notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) {
    headline = 'Hubo un cambio en tu próxima sesión';
    lead = 'Actualicé el horario. Revisa la nueva fecha y, si no te sirve, cancela o escríbeme.';
  } else if (cancelledTbd) {
    headline = 'Tu sesión fue cancelada';
    lead = 'Si corresponde un reembolso, te contactaremos.';
  } else if (cancelled) {
    headline = 'Tu sesión fue cancelada';
    lead = 'Confirmamos que el reembolso de tu sesión fue procesado.';
  } else if (refundFailed) {
    headline = 'Revisión operativa interna';
    lead = 'No es confirmación de reembolso al paciente. La reserva requiere revisión humana.';
  }

  const rows = [];
  if (refundFailed) {
    rows.push(['Reserva', String(record.reservation_id || '')]);
    rows.push(['Pago', String(record.payment_status || '')]);
    rows.push(['Reembolso', String(record.refund_status || '')]);
    rows.push(['Motivo', String(record.refund_last_error_code || 'BUSINESS_POLICY_TBD')]);
    rows.push(['Proveedor', typeof providerRefundAttempted_ === 'function' && providerRefundAttempted_(record)
      ? 'intentado' : 'no intentado']);
    rows.push(['Próxima acción', 'revisión humana']);
  } else {
    if (parts.date) {
      rows.push(['Fecha', parts.date]);
    }
    if (parts.time) {
      rows.push(['Hora', parts.time + ' (Chile)']);
    }
    if (modality) {
      rows.push(['Modalidad', modality]);
    }
    if (meetUrl) {
      rows.push(['Enlace', meetUrl]);
    }
  }

  let details = '';
  rows.forEach(function(row) {
    details += '<tr><td style="padding:8px 0;border-bottom:1px solid ' + EMAIL_BRAND.line + ';font-family:' + EMAIL_BRAND.sans
      + ';font-size:13px;color:' + EMAIL_BRAND.ink3 + ';width:110px;vertical-align:top;">' + escapeEmailText_(row[0])
      + '</td><td style="padding:8px 0;border-bottom:1px solid ' + EMAIL_BRAND.line + ';font-family:' + EMAIL_BRAND.sans
      + ';font-size:16px;color:' + EMAIL_BRAND.ink + ';vertical-align:top;word-break:break-word;">' + escapeEmailText_(row[1]) + '</td></tr>';
  });

  let prep = '';
  if (!cancelled && !refundFailed) {
    prep = record.modality === 'online'
      ? 'Si la sesión es online, entra con unos minutos de anticipación desde un espacio tranquilo.'
      : 'Si necesitas cambiar o cancelar, usa los botones de este correo mientras la hora siga vigente.';
  }

  const ctaBlocks = [];
  if (meetUrl) ctaBlocks.push(emailCtaButton_(meetUrl, 'Entrar a la sesión', true));
  if (calendarUrl) ctaBlocks.push(emailCtaButton_(calendarUrl, 'Agregar al calendario', !meetUrl));
  if (rescheduleUrl) ctaBlocks.push(emailCtaButton_(rescheduleUrl, 'Reagendar sesión', false));
  if (cancelUrl) ctaBlocks.push(emailCtaButton_(cancelUrl, 'Cancelar sesión', false));

  const logo = logoUrl
    ? '<img src="' + escapeEmailText_(logoUrl) + '" width="48" height="48" alt="Francisca Bustos" style="display:block;border:0;width:48px;height:48px;">'
    : '<div style="font-family:' + EMAIL_BRAND.serif + ';font-size:22px;color:' + EMAIL_BRAND.malvaDeep + ';">fb</div>';

  return '<!DOCTYPE html><html lang="es-CL"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="light">'
    + '<meta name="supported-color-schemes" content="light">'
    + '<title>' + escapeEmailText_(lifecycleNotificationSubject_(notification.eventType, parts)) + '</title>'
    + '</head><body style="margin:0;padding:0;background:' + EMAIL_BRAND.bg + ';color:' + EMAIL_BRAND.ink + ';">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + escapeEmailText_(headline) + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + EMAIL_BRAND.bg + ';">'
    + '<tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:' + EMAIL_BRAND.maxWidth
    + 'px;background:' + EMAIL_BRAND.paper + ';border:1px solid ' + EMAIL_BRAND.line + ';border-radius:16px;">'
    + '<tr><td style="padding:28px 28px 8px 28px;">' + logo + '</td></tr>'
    + '<tr><td style="padding:8px 28px 0 28px;font-family:' + EMAIL_BRAND.serif + ';font-size:26px;line-height:1.25;color:'
    + EMAIL_BRAND.ink + ';">' + escapeEmailText_(headline) + '</td></tr>'
    + '<tr><td style="padding:12px 28px 8px 28px;font-family:' + EMAIL_BRAND.sans + ';font-size:16px;line-height:1.55;color:'
    + EMAIL_BRAND.ink2 + ';">' + escapeEmailText_(lead) + '</td></tr>'
    + (details ? '<tr><td style="padding:12px 28px 8px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
      + details + '</table></td></tr>' : '')
    + (prep ? '<tr><td style="padding:8px 28px 16px 28px;font-family:' + EMAIL_BRAND.sans + ';font-size:15px;line-height:1.55;color:'
      + EMAIL_BRAND.ink2 + ';">' + escapeEmailText_(prep) + '</td></tr>' : '')
    + (ctaBlocks.length ? '<tr><td style="padding:8px 28px 8px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
      + ctaBlocks.join('') + '</table></td></tr>' : '')
    + '<tr><td style="padding:20px 28px 28px 28px;font-family:' + EMAIL_BRAND.sans + ';font-size:14px;line-height:1.5;color:'
    + EMAIL_BRAND.ink3 + ';">Francisca Bustos<br>Psicóloga perinatal</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function renderLifecycleEmailText_(input) {
  const notification = input.notification;
  const record = input.record;
  const tokens = input.capabilityTokens || {};
  const cancelledTbd = notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.SESSION_CANCELLED;
  const cancelled = notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_CANCELLED
    || notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_CANCELLED
    || cancelledTbd;
  const parts = lifecycleEmailDateParts_(record.current_start_at);
  const lines = [];
  if (cancelledTbd) {
    lines.push('Hola,', '', 'Tu sesión fue cancelada.', '', 'Si corresponde un reembolso, te contactaremos.');
  } else if (cancelled) {
    lines.push('Hola,', '', 'Tu sesión fue cancelada.', '', 'Confirmamos que el reembolso de tu sesión fue procesado.');
  } else if (notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.REFUND_FAILED_MANUAL_REVIEW) {
    lines.push(
      'Revisión operativa interna. No es confirmación de reembolso al paciente.',
      '',
      'Reserva: ' + String(record.reservation_id || ''),
      'Pago: ' + String(record.payment_status || ''),
      'Reembolso: ' + String(record.refund_status || ''),
      'Motivo: ' + String(record.refund_last_error_code || 'BUSINESS_POLICY_TBD'),
      'Reembolso en proveedor: ' + (typeof providerRefundAttempted_ === 'function' && providerRefundAttempted_(record)
        ? 'intentado' : 'no intentado'),
      'Próxima acción: revisión humana.'
    );
    lines.push('', 'Francisca Bustos — Psicología Perinatal');
    return lines.join('\n');
  } else if (notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.BOOKING_CONFIRMED) {
    lines.push('Hola,', '', 'Tu sesión está confirmada.');
  } else if (notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.PATIENT_RESCHEDULED) {
    lines.push('Hola,', '', 'Tu sesión fue reagendada. No hay un nuevo cobro.');
  } else if (notification.eventType === LIFECYCLE.NOTIFICATION_TYPE.CLINICIAN_RESCHEDULED) {
    lines.push('Hola,', '', 'Hubo un cambio en tu próxima sesión.');
  } else {
    lines.push('Hola,', '', 'Te escribimos con una actualización operativa de tu reserva.');
  }
  const serviceLabel = patientFacingServiceLabel_(record.service_type);
  const modalityLabel = patientFacingModalityLabel_(record.modality);
  if (serviceLabel) lines.push('Servicio: ' + serviceLabel);
  if (modalityLabel) lines.push('Modalidad: ' + modalityLabel);
  if (parts.combined) lines.push('Fecha y hora: ' + parts.combined);
  if (!cancelled && lifecycleNotificationShowsMeet_(notification.eventType)
    && notification.meet && notification.meet.meetUrl) {
    lines.push('Meet: ' + String(notification.meet.meetUrl));
  }
  const calendarUrl = !cancelled ? googleCalendarTemplateUrl_(record.current_start_at, record.current_end_at, 'Sesión con Francisca Bustos') : '';
  if (calendarUrl) lines.push('Calendario: ' + calendarUrl);
  if (!cancelled && tokens.RESCHEDULE) {
    lines.push('Reagendar: ' + managementPageUrl_(input.previewOrigin, tokens.RESCHEDULE, 'reschedule'));
  }
  if (!cancelled && tokens.CANCEL) {
    lines.push('Cancelar: ' + managementPageUrl_(input.previewOrigin, tokens.CANCEL, 'cancel'));
  }
  if (!cancelled && record.modality === 'online') {
    lines.push('', 'Si la sesión es online, entra con unos minutos de anticipación.');
  }
  lines.push('', 'Francisca Bustos — Psicología Perinatal');
  return lines.join('\n');
}

var __EMAIL_TEMPLATE_TEST_EXPORTS__ = Object.freeze({
  EMAIL_BRAND: EMAIL_BRAND,
  lifecycleEmailDateParts_: lifecycleEmailDateParts_,
  lifecycleNotificationSubject_: lifecycleNotificationSubject_,
  googleCalendarTemplateUrl_: googleCalendarTemplateUrl_,
  renderLifecycleEmailHtml_: renderLifecycleEmailHtml_,
  renderLifecycleEmailText_: renderLifecycleEmailText_,
});
