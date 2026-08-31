// ============================================================
// Apps Script — franciscabustos.cl booking backend — v21 PRODUCTION
// ============================================================
// Web 04.9 Production Cutover (2026-05-16):
//   - SHEET_ID, CALENDAR_ID, FLOW_API_KEY, FLOW_SECRET_KEY, FLOW_ENV,
//     FLOW_BASE_URL, WEB_APP_URL, PUBLIC_RETURN_URL, FLOW_WEBHOOK_URL
//     read from Script Properties at runtime. No environment hardcodes.
//   - Fail-fast: doGet/doPost respond CONFIG_MISSING_REQUIRED_PROPERTIES
//     if any required Script Property is missing.
//   - Admin debug endpoints removed.
//   - Transferencia bank constants removed. Pago online exclusivo via
//     Flow API. URL_PAGO_CON_UTM kept as deeplink to /pago.
//   - Public error responses no longer expose err.toString().
//     Internal Logger.log keeps stack details for ops debugging.
//   - getFlowConfig_() fail-fast if FLOW_ENV or FLOW_BASE_URL missing.
//   - Error copy normalized for production.
// ============================================================
// Original v17–v20 changelog preserved below for context:
// ============================================================
// Cambios v17 (sobre v16):
//   - FIX CRÍTICO: sendReminders() ahora filtra por STATUS_ACTIVE.
//     Filas rescheduled / cancelled / cualquier otro status NO reciben
//     recordatorios. Corrige bug de recordatorios fantasma.
//   - FIX: doCancelConfirm tolera Calendar event ya eliminado:
//     si _cancelCalendarEventById falla por 'not_found', continúa con
//     _updateReservationStatus + email. Si falla por auth/quota real,
//     retorna calendar_cancel_failed sin enviar email ni marcar Sheet.
//   - GESTIÓN INTERNA: emails internos a Francisca y descripción privada
//     del evento Calendar incluyen links Reagendar/Cancelar (gestión
//     interna). El paciente NO recibe estos links en emails posteriores
//     (sigue protegido por _assertNoManageLinks_).
// Cambios v16 (sobre v15):
//   - CONTRATO EXPLÍCITO: emailContext determina si un email puede exponer
//     links /manage. Solo EMAIL_CONTEXT_INITIAL los permite.
//   - Helpers defensivos: _canExposeManageLinks_() y _assertNoManageLinks_().
//   - nuevaReserva en doRescheduleConfirm ya NO contiene url_reagendar/url_cancelar.
//   - _enviarCorreos() ya no depende solo de manageToken: ahora gatea por contexto.
//   - Guards aplicados antes de enviar en reagendamiento y cancelación.
// Cambios v15 (sobre v14.1):
//   - CICLO ÚNICO: email inicial SÍ incluye botones Reagendar/Cancelar.
//   - Email post-reagendamiento y post-cancelación NUNCA incluyen botones
//     ni links /manage (ciclo termina tras primera gestión).
//   - doRescheduleConfirm ya no expone manageToken en respuesta al frontend.
//   - _buildCancelacionPacienteHtml_: agrega servicio/modalidad en hero
//     y actualiza texto de contacto con referencia a WhatsApp.
//   - _enviarCorreosReagendamiento: plain text actualizado con WhatsApp.
//   - Guard de seguridad en post-reagendamiento mantiene /manage fuera.
// Cambios v14.1 (sobre v14):
//   - Plain text email paciente inicial: texto WhatsApp consistente con HTML.
// Cambios v14 (sobre v13):
//   - Validación obligatoria de nombre, email y teléfono en doPost().
//   - MISSING_REQUIRED code devuelto si faltan campos requeridos.
// Cambios v13 (sobre v12):
//   - SCOPE REDUCIDO: reagendamiento y cancelación quedan como funciones
//     internas de backend únicamente. No se exponen via frontend.
//   - CLEAN: manageToken ya no se devuelve al frontend en doPost().
//   - PRECIO: precios canónicos server-side (ver PRICE_INITIAL_CLP /
//     PRICE_FOLLOWUP_CLP más abajo). _getMontoForServicio_() elige el
//     string para email según el nombre del servicio.
// ============================================================

// Web 04.9: SHEET_ID y CALENDAR_ID se leen desde Script Properties.
// El producto de producción debe configurar estos valores en
// Apps Script → Project Settings → Script Properties antes del primer deploy.
const SHEET_ID          = PropertiesService.getScriptProperties().getProperty('SHEET_ID')    || '';
const SHEET_NAME        = 'Respuestas de formulario 1';
const FRANCISCA_EMAIL   = 'hola@franciscabustos.cl';
const FRANCISCA_NAME    = 'Francisca Bustos';
const SITE_URL          = 'www.franciscabustos.cl';
// Web 04.2: BASE_URL eliminado (no hardcoded endpoint). Fuente única de URL
// del Web App es Script Property WEB_APP_URL (leída en doCreateFlowPayment).
const BASE_URL = '';
const MANAGE_URL        = 'https://franciscabustos.cl/manage';
const CALENDAR_ID       = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID') || '';
const SESSION_DURATION  = 50; // minutos por sesión
const TZ                = 'America/Santiago';
const DIAS_ANTICIPACION = 90; // cuántos días hacia adelante leer del Calendar

// Web 04.9: constantes bancarias removidas. Pago exclusivo via Flow API.
// No emitimos datos de transferencia en emails, sitio, ni respuestas.
// URL_PAGO_CON_UTM se mantiene como deeplink informativo a /pago.
const URL_PAGO_CON_UTM = 'https://franciscabustos.cl/pago?utm_source=email&utm_medium=transactional&utm_campaign=booking_confirmation';
const BACKEND_VERSION  = 'booking-backend-v21-production-cutover';
const STATUS_ACTIVE      = 'active';
const STATUS_CANCELLED   = 'cancelled';
const STATUS_RESCHEDULED = 'rescheduled';

// v18 Flow integration - estados nuevos
const STATUS_PENDING_PAYMENT  = 'pending_payment';
const STATUS_PAID_CONFIRMED   = 'paid_confirmed';
const STATUS_PAYMENT_REJECTED = 'payment_rejected';
const STATUS_PAYMENT_REVIEW   = 'payment_review_required';

// Precios oficiales - fuente unica de verdad server-side
const PRICE_INITIAL_CLP  = 50000;
const PRICE_FOLLOWUP_CLP = 50000;
const SERVICE_INITIAL    = 'initial';
const SERVICE_FOLLOWUP   = 'followup';
const FLOW_SUBJECT_INITIAL  = 'Francisca Bustos | Evaluacion clinica inicial';
const FLOW_SUBJECT_FOLLOWUP = 'Francisca Bustos | Sesion de seguimiento';

// Sheet headers Flow (se agregan via ensureSheetSchema_)
const FLOW_HEADERS = [
  'commerceOrder','flowOrder','flowToken','priceClp','paidAt',
  'rawFlowStatus','serviceType','patientRut','paymentUrl','publicStatusToken',
  'calendarCreated','emailPatientSent','emailInternalSent',
  'emailPatientSentAt','emailInternalSentAt','paymentExpiresAt','reviewReason'
];

// Web 04.4: alias map header espanol <-> ingles para columnas base de la Sheet.
// Las claves son canonicas (ingles). Los valores son variantes ya normalizadas
// (lowercase, sin acentos, sin dobles espacios). Permite que la Sheet conserve
// sus headers actuales en espanol sin renombrar manualmente.
const HEADER_ALIASES = {
  timestamp:     ['timestamp', 'marca temporal', 'marca_temporal', 'fecha creacion', 'fecha_creacion', 'createdat', 'created at'],
  phone:         ['phone', 'telefono', 'tel', 'celular'],
  email:         ['email', 'correo', 'correo electronico', 'mail', 'e-mail'],
  service:       ['service', 'servicio', 'tipo servicio', 'tipo de servicio'],
  modality:      ['modality', 'modalidad'],
  date:          ['date', 'fecha'],
  time:          ['time', 'hora'],
  message:       ['message', 'motivo', 'reason', 'motivo de consulta', 'mensaje'],
  reservationId: ['reservationid', 'reservation_id', 'id reserva', 'id_reserva', 'reserva id', 'idreserva'],
  name:          ['name', 'nombre', 'nombre completo', 'nombre paciente'],
  manageToken:   ['managetoken', 'manage_token', 'columna 1', 'token gestion', 'token de gestion'],
  status:        ['status', 'estado'],
  patientRut:    ['patientrut', 'patient_rut', 'rut', 'rut paciente']
};

// Canonical keys cuya ausencia bloquea el flujo de pago.
const REQUIRED_SHEET_CANONICAL = ['date', 'time', 'email', 'name', 'service', 'modality'];

/**
 * Normaliza un header de Sheet para comparacion robusta:
 * - String, trim, lowercase.
 * - Strip diacriticos (NFD + remove combining).
 * - Colapsa espacios multiples a uno.
 */
function _normalizeHeaderKey_(h) {
  if (h === null || h === undefined) return '';
  var s = String(h).trim().toLowerCase();
  try {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {
    s = s.replace(/[áàäâ]/g, 'a')
         .replace(/[éèëê]/g, 'e')
         .replace(/[íìïî]/g, 'i')
         .replace(/[óòöô]/g, 'o')
         .replace(/[úùüû]/g, 'u')
         .replace(/ñ/g, 'n');
  }
  s = s.replace(/\s+/g, ' ');
  return s;
}

/**
 * Valida que el colMap contenga todas las columnas canonicas requeridas.
 * Devuelve array de canonicas faltantes (vacio si todo OK).
 */
function _validateSchemaRequired_(colMap) {
  var missing = [];
  for (var i = 0; i < REQUIRED_SHEET_CANONICAL.length; i++) {
    var key = REQUIRED_SHEET_CANONICAL[i];
    if (!colMap[key]) missing.push(key);
  }
  return missing;
}

// Contextos de email — solo INITIAL puede exponer links /manage
const EMAIL_CONTEXT_INITIAL    = 'initial_booking';
const EMAIL_CONTEXT_RESCHEDULE = 'reschedule_confirmation';
const EMAIL_CONTEXT_CANCEL     = 'cancellation_confirmation';
// ---------------------------------------------------------------
// _getMontoForServicio_ — devuelve el monto correcto según servicio
// ---------------------------------------------------------------
function _getMontoForServicio_(servicio) {
  // Web 04.9: precios literales para emails. Server-side authority es
  // PRICE_INITIAL_CLP / PRICE_FOLLOWUP_CLP; aquí solo formato display.
  var s = _toSafeString_(servicio).toLowerCase();
  if (s.indexOf('seguimiento') >= 0) return '$50.000';
  return '$50.000';
}

// ---------------------------------------------------------------
// _canExposeManageLinks_ — único contexto que puede mostrar links /manage
// ---------------------------------------------------------------
function _canExposeManageLinks_(emailContext) {
  return emailContext === EMAIL_CONTEXT_INITIAL;
}

// ---------------------------------------------------------------
// _assertNoManageLinks_ — guard defensivo: bloquea envío si HTML contiene
// links de gestión en un contexto que no sea EMAIL_CONTEXT_INITIAL.
// ---------------------------------------------------------------
function _assertNoManageLinks_(html, context) {
  var forbidden = [
    '/manage',
    'Reagendar sesión',
    'Cancelar reserva',
    'url_reagendar',
    'url_cancelar',
    'manageToken'
  ];

  var hayProhibido = forbidden.some(function(pattern) {
    return String(html || '').indexOf(pattern) !== -1;
  });

  if (hayProhibido && context !== EMAIL_CONTEXT_INITIAL) {
    Logger.log('[ERROR] manage links detected in forbidden email context: ' + context);
    throw new Error('forbidden_manage_links_in_email_context_' + context);
  }
}

const COL_TIMESTAMP                  = 1;
const COL_TELEFONO                   = 2;
const COL_EMAIL                      = 3;
const COL_SERVICIO                   = 4;
const COL_MODALIDAD                  = 5;
const COL_FECHA                      = 6;
const COL_HORA                       = 7;
const COL_MOTIVO                     = 8;
const COL_RESERVA_ID                 = 9;
const COL_NOMBRE                     = 10;
const COL_GOOGLE_MEET_LINK           = 11;
const COL_CALENDAR_EVENT_ID          = 12;
const COL_MANAGE_TOKEN               = 13;
const COL_STATUS                     = 14;
const COL_CANCELLED_AT               = 15;
const COL_REPLACED_BY_RESERVATION_ID = 16;

// ---------------------------------------------------------------
// doGet ??? enruta acciones o retorna slots ocupados desde Google Calendar
// ---------------------------------------------------------------
function doGet(e) {
  // Web 04.9: admin debug endpoints (init_props, debug_row, set_sandbox_urls)
  // and one-time URL setter helper removed for production hardening.

  // Web 04.9: fail-fast on missing Script Properties before any business logic.
  var _propsMissing = _validateRequiredScriptProperties_();
  if (_propsMissing.length > 0) {
    return _jsonOut({
      ok: false,
      code: 'CONFIG_MISSING_REQUIRED_PROPERTIES',
      missing: _propsMissing,
      message: 'Configuracion productiva incompleta.',
      backendVersion: BACKEND_VERSION
    });
  }

  try {
    const action = _getActionParam(e);
    if (action === 'manage') {
      return doManage(e);
    }
    if (action === 'reschedule') {
      return _jsonOut({ ok: true, action: 'reschedule', token: _getTokenParam(e) });
    }
    if (action === 'cancel') {
      return _jsonOut({ ok: true, action: 'cancel', token: _getTokenParam(e) });
    }
    // v18 Flow: payment_status via publicStatusToken (no enumerable)
    if (action === 'payment_status') {
      return doFlowPaymentStatus(e);
    }
    // v18 Flow: webhook puede llegar via GET tambien
    if (action === 'flow_confirmation') {
      return doFlowConfirmation(e);
    }

    return _jsonOut(_getBookedSlotsFromCalendarV2());

  } catch (err) {
    Logger.log('doGet error: ' + err);
    // Web 04.9: do not leak err.toString() in public response.
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'Error interno.', backendVersion: BACKEND_VERSION });
  }
}

// ---------------------------------------------------------------
// _dayOfWeek_ / _isFriday_ — Web 04.11
// Devuelve día de la semana (0=Dom..6=Sab) para un string 'YYYY-MM-DD'.
// Uso de Date.UTC para ser timezone-independent: el calendario de
// fecha-de-reserva no depende del timezone del script.
// ---------------------------------------------------------------
function _dayOfWeek_(dateStr) {
  if (!dateStr) return -1;
  var parts = String(dateStr).split('-');
  if (parts.length !== 3) return -1;
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  if (!y || !m || !d) return -1;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function _isFriday_(dateStr) {
  return _dayOfWeek_(dateStr) === 5;
}

// ---------------------------------------------------------------
// _validarRutChileno_ — Web 04.11b
// Valida un RUT chileno aplicando módulo 11. Acepta el RUT con o sin
// puntos, con o sin guion, con K mayúscula o minúscula, y con espacios.
// Rechaza string vacío, caracteres inválidos, body fuera de rango (7-8
// dígitos típicos) y dígito verificador incorrecto.
// Devuelve true / false. No registra el RUT en Logger por privacidad.
// Mantiene paridad lógica con isValidChileanRut() en assets/booking.js.
// ---------------------------------------------------------------
function _validarRutChileno_(rut) {
  if (!rut) return false;
  var clean = String(rut).replace(/[\s.\-]/g, '').toUpperCase();
  if (clean.length < 2 || clean.length > 9) return false;
  var body = clean.slice(0, -1);
  var dv   = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;
  if (!/^[\dK]$/.test(dv)) return false;
  if (body.length < 7) return false; // descarta RUTs < 1.000.000
  var sum = 0;
  var mul = 2;
  for (var i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body.charAt(i), 10) * mul;
    mul = (mul === 7) ? 2 : mul + 1;
  }
  var mod = 11 - (sum % 11);
  var expected;
  if (mod === 11)      expected = '0';
  else if (mod === 10) expected = 'K';
  else                 expected = String(mod);
  return dv === expected;
}

// ---------------------------------------------------------------
// _validateRequiredScriptProperties_ — Web 04.9 fail-fast gate.
// Returns array of missing Script Property keys (empty if all set).
// ---------------------------------------------------------------
function _validateRequiredScriptProperties_() {
  var required = [
    'SHEET_ID', 'CALENDAR_ID',
    'FLOW_API_KEY', 'FLOW_SECRET_KEY', 'FLOW_ENV', 'FLOW_BASE_URL',
    'WEB_APP_URL', 'PUBLIC_RETURN_URL', 'FLOW_WEBHOOK_URL'
  ];
  var props = PropertiesService.getScriptProperties();
  var missing = [];
  for (var i = 0; i < required.length; i++) {
    if (!props.getProperty(required[i])) missing.push(required[i]);
  }
  return missing;
}

// ---------------------------------------------------------------
// doPost ??? verifica Calendar, crea evento, guarda log, env??a correos
// ---------------------------------------------------------------
function doPost(e) {
  // Web 04.9: fail-fast on missing Script Properties before any business logic.
  var _propsMissing = _validateRequiredScriptProperties_();
  if (_propsMissing.length > 0) {
    return _jsonOut({
      ok: false,
      code: 'CONFIG_MISSING_REQUIRED_PROPERTIES',
      missing: _propsMissing,
      message: 'Configuracion productiva incompleta.',
      backendVersion: BACKEND_VERSION
    });
  }
  try {
    const incoming = _parsePostBodyFlex_(e);
    const action = _getActionParam(e) || _getBodyAction(incoming) || (incoming && incoming.action) || '';

    // Rutas existentes preservadas
    if (action === 'manage') return doManageFromToken_(String(incoming.token || '').trim());
    if (action === 'cancel_confirm') return doCancelConfirm(e);
    if (action === 'reschedule_confirm') return doRescheduleConfirm(e);

    // v18 Flow: rutas nuevas
    if (action === 'create_flow_payment') return doCreateFlowPayment(e, incoming);
    if (action === 'flow_confirmation')   return doFlowConfirmation(e);
    if (action === 'payment_status')      return doFlowPaymentStatus(e);

    // v18 Flow: bloquear booking legacy salvo Script Property ALLOW_LEGACY_BOOKING=true
    var allowLegacy = String(PropertiesService.getScriptProperties().getProperty('ALLOW_LEGACY_BOOKING') || '').toLowerCase() === 'true';
    if (!allowLegacy) {
      return _jsonOut({
        ok: false,
        code: 'LEGACY_BOOKING_DISABLED',
        message: 'La reserva sin pago no esta disponible. Usa el flujo create_flow_payment.',
        backendVersion: BACKEND_VERSION
      });
    }

    const raw   = e.postData ? e.postData.contents : '{}';
    const datos = JSON.parse(raw);

    const fechaNormalizada = _normalizeFechaForBackend_(datos.fecha);
    const horaNormalizada  = _normalizeHoraForBackend_(datos.hora);
    const isoMatch  = fechaNormalizada.match(/(\d{4}-\d{2}-\d{2})/);
    const horaMatch = horaNormalizada.match(/(\d{2}:\d{2})/);

    if (!isoMatch || !horaMatch) {
      return _jsonOut({ ok: false, code: 'INVALID_DATETIME', error: 'invalid_datetime', message: 'Fecha u hora inválida.', backendVersion: BACKEND_VERSION });
    }

    const [yr, mo, dy] = isoMatch[1].split('-').map(Number);
    const [hh, mm]     = horaMatch[1].split(':').map(Number);

    const startTime = new Date(yr, mo - 1, dy, hh, mm, 0);
    const endTime   = new Date(startTime.getTime() + SESSION_DURATION * 60 * 1000);

    const cal       = CalendarApp.getCalendarById(CALENDAR_ID);
    const conflicts = cal.getEvents(startTime, endTime);

    if (conflicts.length > 0) {
      return _jsonOut({ ok: false, code: 'SLOT_TAKEN', error: 'slot_taken', message: 'Este horario ya no está disponible.', backendVersion: BACKEND_VERSION });
    }

    // Validación de campos requeridos: nombre, email, teléfono
    if (!datos.nombre || !datos.email || !datos.telefono) {
      return _jsonOut({ ok: false, code: 'MISSING_REQUIRED', message: 'Nombre, correo y teléfono son obligatorios.', backendVersion: BACKEND_VERSION });
    }

    // Validación de teléfono (mínimo 9 dígitos, ignorando +, espacios, guiones)
    if (!_validarTelefono_(datos.telefono || '')) {
      return _jsonOut({ ok: false, code: 'INVALID_PHONE', message: 'Ingresa un teléfono válido con al menos 9 números.', backendVersion: BACKEND_VERSION });
    }

    const nombre    = datos.nombre    || 'Paciente';
    const servicio  = datos.servicio  || 'Sesión';
    const modalidad = datos.modalidad || '';
    const email     = datos.email     || '';
    const telefono  = datos.telefono  || '—';
    const motivo    = datos.motivo    || '—';
    const reservaId = datos.reservaId || '';
    datos.fecha = fechaNormalizada;
    datos.hora  = horaNormalizada;

    // v17: manageToken se genera ANTES de crear el evento para incluirlo en
    // la descripción privada del Calendar (gestión interna Francisca).
    const manageToken = Utilities.getUuid();

    // Crear evento en Calendar con Meet (si online).
    // Título neutro para proteger privacidad del paciente.
    // Descripción incluye links internos de gestión solo visibles para Francisca.
    const calResult = createCalendarEventForReservation_({
      startTime:   startTime,
      endTime:     endTime,
      email:       email,
      modalidad:   modalidad,
      manageToken: manageToken,
    });
    const meetLink        = calResult.googleMeetLink;
    const calendarEventId = calResult.eventId;

    datos.googleMeetLink = meetLink;
    datos.calendarEventId = calendarEventId;
    datos.manageToken = manageToken;
    datos.status = STATUS_ACTIVE;
    datos.cancelledAt = '';
    datos.replacedByReservationId = '';
    // url_reagendar y url_cancelar eliminadas de datos (v13): gestión vía contacto directo.
    _guardarEnSheet(datos);

    // v16: contrato explícito — solo el email inicial puede exponer links /manage
    datos.emailContext = EMAIL_CONTEXT_INITIAL;
    const emailStatus = _enviarCorreos(datos);

    return _jsonOut({
      ok:                true,
      reservaId:         reservaId,
      eventId:           calendarEventId,
      emailPatientSent:  emailStatus.emailPatientSent,
      emailInternalSent: emailStatus.emailInternalSent,
      googleMeetLink:    meetLink,
      // manageToken eliminado de respuesta al frontend (v13)
      backendVersion:    BACKEND_VERSION,
    });

  } catch (err) {
    Logger.log('doPost error: ' + err);
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'No pudimos completar la reserva. Intenta nuevamente.', backendVersion: BACKEND_VERSION });
  }
}

// ---------------------------------------------------------------
// doManage ??? lectura segura de estado por token
// ---------------------------------------------------------------
function doManage(e) {
  return doManageFromToken_(_getTokenParam(e));
}

// ---------------------------------------------------------------
// doManageFromToken_ ??? lógica de manage extraída para reutilizar
// desde doGet (acción GET) y doPost (acción POST, sin CORS preflight)
// ---------------------------------------------------------------
function doManageFromToken_(token) {
  try {
    const safeToken = String(token || '').trim();
    if (!safeToken) return _jsonOut({ ok: false, error: 'token_not_found', backendVersion: BACKEND_VERSION });
    const found = _findReservationByToken(safeToken);
    if (!found) return _jsonOut({ ok: false, error: 'token_not_found', backendVersion: BACKEND_VERSION });
    return _jsonOut({
      ok: true,
      status: found.status || '',
      nombre: found.nombre || '',
      fecha: found.fecha || '',
      hora: found.hora || '',
      servicio: found.servicio || '',
      modalidad: found.modalidad || '',
      backendVersion: BACKEND_VERSION,
    });
  } catch (err) {
    Logger.log('doManageFromToken_ error: ' + err);
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'Error interno.', backendVersion: BACKEND_VERSION });
  }
}

// ---------------------------------------------------------------
// doCancelConfirm ??? cancelaci??n confirmada
// ---------------------------------------------------------------
function doCancelConfirm(e) {
  try {
    const payload = _parsePostBody(e);
    const token = String(payload.token || _getTokenParam(e) || '').trim();

    if (!token) return _jsonOut({ ok: false, error: 'token_not_found', code: 'TOKEN_NOT_FOUND', message: 'No encontramos esta reserva.', backendVersion: BACKEND_VERSION });

    const found = _findReservationByToken(token);
    if (!found) return _jsonOut({ ok: false, error: 'token_not_found', code: 'TOKEN_NOT_FOUND', message: 'No encontramos esta reserva.', backendVersion: BACKEND_VERSION });
    if (found.status !== STATUS_ACTIVE) return _jsonOut({ ok: false, error: 'already_processed', code: 'ALREADY_PROCESSED', message: 'Esta reserva ya fue gestionada.', backendVersion: BACKEND_VERSION });

    found.fecha = _normalizeFechaForBackend_(found.fecha);
    found.hora  = _normalizeHoraForBackend_(found.hora);

    // v17: tolerar evento Calendar ya eliminado manualmente.
    // Si Calendar falla por not_found → seguir adelante con Sheet + email.
    // Si Calendar falla por error real (auth/quota/permisos) → abortar sin tocar Sheet.
    var calendarAlreadyDeleted = false;
    try {
      _cancelCalendarEventById(found.calendarEventId);
    } catch (calErr) {
      var msg = String(calErr && calErr.message || calErr).toLowerCase();
      if (msg.indexOf('not_found') !== -1 || msg.indexOf('not found') !== -1 || msg.indexOf('event_id_missing') !== -1) {
        calendarAlreadyDeleted = true;
        Logger.log('doCancelConfirm: Calendar event ya estaba eliminado o ID ausente. Continúo con Sheet+email. id=' + _toSafeString_(found.calendarEventId));
      } else {
        Logger.log('[ERROR] doCancelConfirm: fallo real al cancelar Calendar. err=' + calErr);
        return _jsonOut({ ok: false, code: 'CALENDAR_CANCEL_FAILED', error: 'calendar_cancel_failed', message: 'No pudimos cancelar el evento en Calendar. Intenta nuevamente.', backendVersion: BACKEND_VERSION });
      }
    }

    _updateReservationStatus(found.rowIndex, STATUS_CANCELLED, new Date().toISOString(), '');
    var emailStatus = { emailPatientSent: false, emailInternalSent: false };
    try {
      emailStatus = _enviarCorreosCancelacion(found, payload.reason || '') || emailStatus;
    } catch (emailErr) {
      Logger.log('doCancelConfirm email error: ' + emailErr);
    }

    Logger.log('doCancelConfirm: token=' + token + ' reservaId=' + _toSafeString_(found.reservaId) + ' emailPatientSent=' + !!emailStatus.emailPatientSent + ' emailInternalSent=' + !!emailStatus.emailInternalSent + ' calendarAlreadyDeleted=' + calendarAlreadyDeleted);
    return _jsonOut({ ok: true, emailPatientSent: !!emailStatus.emailPatientSent, emailInternalSent: !!emailStatus.emailInternalSent, calendarAlreadyDeleted: calendarAlreadyDeleted, manageLinksExposed: false, backendVersion: BACKEND_VERSION });
  } catch (err) {
    Logger.log('doCancelConfirm error: ' + err);
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'No pudimos completar la cancelación. Intenta nuevamente.', backendVersion: BACKEND_VERSION });
  }
}

// ---------------------------------------------------------------
// doRescheduleConfirm ??? reagendamiento confirmado
// ---------------------------------------------------------------
function doRescheduleConfirm(e) {
  try {
    const payload = _parsePostBody(e);
    const token = String(payload.token || _getTokenParam(e) || '').trim();

    if (!token) return _jsonOut({ ok: false, error: 'token_not_found', code: 'TOKEN_NOT_FOUND', message: 'No encontramos esta reserva.', backendVersion: BACKEND_VERSION });

    const found = _findReservationByToken(token);
    if (!found) return _jsonOut({ ok: false, error: 'token_not_found', code: 'TOKEN_NOT_FOUND', message: 'No encontramos esta reserva.', backendVersion: BACKEND_VERSION });
    if (found.status !== STATUS_ACTIVE) return _jsonOut({ ok: false, error: 'already_processed', code: 'ALREADY_PROCESSED', message: 'Esta reserva ya fue gestionada.', backendVersion: BACKEND_VERSION });

    const nuevaFecha = _normalizeFechaForBackend_(payload.fecha);
    const nuevaHora = _normalizeHoraForBackend_(payload.hora);
    const newRange = _buildDateRange(nuevaFecha, nuevaHora);
    if (!newRange) return _jsonOut({ ok: false, error: 'invalid_datetime', code: 'INVALID_DATETIME', message: 'Fecha u hora inválida.', backendVersion: BACKEND_VERSION });

    const cal = CalendarApp.getCalendarById(CALENDAR_ID);
    const conflicts = cal.getEvents(newRange.startTime, newRange.endTime);
    if (conflicts.length > 0) return _jsonOut({ ok: false, code: 'SLOT_TAKEN', error: 'slot_taken', message: 'Este horario ya no está disponible.', backendVersion: BACKEND_VERSION });

    const newReservaId = String(payload.reservaId || _generateReservationId()).trim();
    const newManageToken = Utilities.getUuid();

    // v17: nuevo evento con Meet + descripción con links internos de gestión.
    // Título neutro para proteger privacidad del paciente.
    const calResult = createCalendarEventForReservation_({
      startTime:   newRange.startTime,
      endTime:     newRange.endTime,
      email:       found.email || '',
      modalidad:   found.modalidad || '',
      manageToken: newManageToken,
    });
    const newMeetLink = calResult.googleMeetLink;
    const newCalendarEventId = calResult.eventId;

    _cancelCalendarEventById(found.calendarEventId);
    _updateReservationStatus(found.rowIndex, STATUS_RESCHEDULED, '', newReservaId);

    // v16: nuevaReserva NO incluye url_reagendar/url_cancelar.
    // manageToken se conserva solo para storage interno (Sheet), no para email.
    const nuevaReserva = {
      telefono: found.telefono || '',
      email: found.email || '',
      servicio: found.servicio || '',
      modalidad: found.modalidad || '',
      fecha: nuevaFecha,
      hora: nuevaHora,
      motivo: found.motivo || '',
      reservaId: newReservaId,
      nombre: found.nombre || '',
      googleMeetLink: newMeetLink,
      calendarEventId: newCalendarEventId,
      manageToken: newManageToken,
      status: STATUS_ACTIVE,
      cancelledAt: '',
      replacedByReservationId: '',
      emailContext: EMAIL_CONTEXT_RESCHEDULE,
    };

    _guardarEnSheet(nuevaReserva);
    var emailStatus = { emailPatientSent: false, emailInternalSent: false };
    try {
      emailStatus = _enviarCorreosReagendamiento(found, nuevaReserva) || emailStatus;
    } catch (emailErr) {
      Logger.log('doRescheduleConfirm email error: ' + emailErr);
    }

    Logger.log('doRescheduleConfirm: oldToken=' + _toSafeString_(token) + ' newToken=' + newManageToken + ' oldReservaId=' + _toSafeString_(found.reservaId) + ' newReservaId=' + newReservaId + ' newCalendarEventId=' + _toSafeString_(newCalendarEventId) + ' emailPatientSent=' + !!emailStatus.emailPatientSent + ' emailInternalSent=' + !!emailStatus.emailInternalSent);

    return _jsonOut({
      ok: true,
      googleMeetLink: newMeetLink,
      reservaId: newReservaId,
      emailPatientSent: !!emailStatus.emailPatientSent,
      emailInternalSent: !!emailStatus.emailInternalSent,
      manageLinksExposed: false,
      backendVersion: BACKEND_VERSION,
    });
  } catch (err) {
    Logger.log('doRescheduleConfirm error: ' + err);
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'No pudimos completar el reagendamiento. Intenta nuevamente.', backendVersion: BACKEND_VERSION });
  }
}

function _guardarEnSheet(d) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  sheet.appendRow([
    new Date(),
    d.telefono       || '',
    d.email          || '',
    d.servicio       || '',
    d.modalidad      || '',
    d.fecha          || '',
    d.hora           || '',
    d.motivo         || '',
    d.reservaId      || '',
    d.nombre         || '',
    d.googleMeetLink || '',
    d.calendarEventId || '',
    d.manageToken || '',
    d.status || STATUS_ACTIVE,
    d.cancelledAt || '',
    d.replacedByReservationId || '',
  ]);
}

// ---------------------------------------------------------------
// Helpers de routing / JSON / persistence
// ---------------------------------------------------------------
function _jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _getActionParam(e) {
  if (!e || !e.parameter || !e.parameter.action) return '';
  return String(e.parameter.action).toLowerCase();
}

function _getTokenParam(e) {
  if (!e || !e.parameter || !e.parameter.token) return '';
  return String(e.parameter.token).trim();
}

function _getBodyAction(body) {
  if (!body || !body.action) return '';
  return String(body.action).toLowerCase();
}

function _parsePostBody(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  return JSON.parse(raw);
}

function _getBookedSlotsFromCalendar() {
  const cal    = CalendarApp.getCalendarById(CALENDAR_ID);
  const desde  = new Date();
  const hasta  = new Date();
  hasta.setDate(desde.getDate() + DIAS_ANTICIPACION);

  const events = cal.getEvents(desde, hasta);
  const slots  = [];

  for (var i = 0; i < events.length; i++) {
    const start = events[i].getStartTime();
    slots.push({
      fecha: Utilities.formatDate(start, TZ, 'yyyy-MM-dd'),
      hora: Utilities.formatDate(start, TZ, 'HH:mm'),
    });
  }

  return slots;
}

function _buildDateRange(fechaRaw, horaRaw) {
  const isoDate = _normalizeFechaForBackend_(fechaRaw);
  const hora = _normalizeHoraForBackend_(horaRaw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !/^\d{2}:\d{2}$/.test(hora)) return null;

  const partsFecha = isoDate.split('-').map(Number);
  const partsHora = hora.split(':').map(Number);
  const startTime = new Date(partsFecha[0], partsFecha[1] - 1, partsFecha[2], partsHora[0], partsHora[1], 0);
  const endTime = new Date(startTime.getTime() + SESSION_DURATION * 60 * 1000);

  return {
    startTime: startTime,
    endTime: endTime,
    isoDate: isoDate,
    hourLabel: hora + ' h',
  };
}

function _getSheet() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
}

function _findReservationByToken(token) {
  const safeToken = String(token || '').trim();
  if (!safeToken) return null;

  const sheet = _getSheet();
  const data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[COL_MANAGE_TOKEN - 1] || '').trim() === safeToken) {
      return _mapReservationRow(row, i + 1);
    }
  }

  return null;
}

function _mapReservationRow(row, rowIndex) {
  return {
    rowIndex: rowIndex,
    timestamp: row[COL_TIMESTAMP - 1] || '',
    telefono: row[COL_TELEFONO - 1] || '',
    email: row[COL_EMAIL - 1] || '',
    servicio: row[COL_SERVICIO - 1] || '',
    modalidad: row[COL_MODALIDAD - 1] || '',
    fecha: _normalizeFechaForBackend_(row[COL_FECHA - 1]),
    hora: _normalizeHoraForBackend_(row[COL_HORA - 1]),
    motivo: row[COL_MOTIVO - 1] || '',
    reservaId: row[COL_RESERVA_ID - 1] || '',
    nombre: row[COL_NOMBRE - 1] || '',
    googleMeetLink: row[COL_GOOGLE_MEET_LINK - 1] || '',
    calendarEventId: row[COL_CALENDAR_EVENT_ID - 1] || '',
    manageToken: row[COL_MANAGE_TOKEN - 1] || '',
    status: row[COL_STATUS - 1] || STATUS_ACTIVE,
    cancelledAt: row[COL_CANCELLED_AT - 1] || '',
    replacedByReservationId: row[COL_REPLACED_BY_RESERVATION_ID - 1] || '',
  };
}

function _updateReservationStatus(rowIndex, status, cancelledAt, replacedByReservationId) {
  const sheet = _getSheet();
  sheet.getRange(rowIndex, COL_STATUS).setValue(status || '');
  sheet.getRange(rowIndex, COL_CANCELLED_AT).setValue(cancelledAt || '');
  sheet.getRange(rowIndex, COL_REPLACED_BY_RESERVATION_ID).setValue(replacedByReservationId || '');
}

function _cancelCalendarEventById(calendarEventId) {
  if (!calendarEventId) throw new Error('calendar_event_id_missing');

  // Primero: Advanced Calendar API con sendUpdates:'all' para notificar asistentes.
  // Funciona con eventos creados via Calendar.Events.insert() (base ID format).
  try {
    Calendar.Events.remove(CALENDAR_ID, calendarEventId, { sendUpdates: 'all' });
    Logger.log('_cancelCalendarEventById: eliminado via Advanced API. id=' + calendarEventId);
    return;
  } catch (e1) {
    Logger.log('_cancelCalendarEventById: Advanced API falló (' + e1 + '), intentando CalendarApp...');
  }

  // Fallback: CalendarApp para eventos anteriores guardados como iCalUID (v10 y anteriores).
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  const ev = cal.getEventById(calendarEventId);
  if (!ev) throw new Error('calendar_event_not_found');
  ev.deleteEvent();
}

function _generateReservationId() {
  return 'FB-' + (Math.floor(Math.random() * 90000) + 10000);
}

function _toSafeString_(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Utilities.formatDate(value, TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return String(value);
}

function _normalizeFechaForBackend_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');

  const raw = _toSafeString_(value).trim();
  if (!raw) return '';

  const pipeMatch = raw.match(/\|\s*(\d{4}-\d{2}-\d{2})\s*$/);
  if (pipeMatch) return pipeMatch[1];

  const isoMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  return raw;
}

function _normalizeHoraForBackend_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'HH:mm');

  const raw = _toSafeString_(value).replace(/\s*h$/i, '').trim();
  if (!raw) return '';

  const horaMatch = raw.match(/(\d{1,2}):(\d{2})/);
  if (horaMatch) return horaMatch[1].padStart(2, '0') + ':' + horaMatch[2];

  return raw;
}

function _parseFechas(fechaRaw) {
  const MESES    = ['enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const DIAS_SEM = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const fechaTexto = _toSafeString_(fechaRaw).trim();
  const fechaNormalizada = _normalizeFechaForBackend_(fechaRaw);

  // Caso 1: fecha en formato ISO puro "YYYY-MM-DD" → convierte a español
  const isoMatch = fechaNormalizada.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mo = parseInt(isoMatch[2], 10) - 1;
    const dy = parseInt(isoMatch[3], 10);
    const d  = new Date(yr, mo, dy);
    const fechaCorta = isoMatch[3] + '/' + isoMatch[2] + '/' + isoMatch[1];
    const diaSem = DIAS_SEM[d.getDay()];
    const fechaLarga = diaSem.charAt(0).toUpperCase() + diaSem.slice(1)
                     + ', ' + dy + ' de ' + MESES[mo] + ' de ' + yr;
    return { fechaCorta: fechaCorta, fechaLarga: fechaLarga };
  }

  // Caso 2 (legacy): fecha con pipe o texto libre.
  var fechaCorta = fechaNormalizada || fechaTexto;
  var fechaLarga = fechaTexto || fechaNormalizada;
  const isoInText = fechaTexto.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoInText) {
    const parts = isoInText[1].split('-');
    fechaCorta = parts[2] + '/' + parts[1] + '/' + parts[0];
  }
  const pipeIdx = fechaTexto.indexOf(' | ');
  if (pipeIdx > -1) {
    fechaLarga = fechaTexto.substring(0, pipeIdx);
    fechaLarga = fechaLarga.charAt(0).toUpperCase() + fechaLarga.slice(1);
  }

  return { fechaCorta: fechaCorta, fechaLarga: fechaLarga };
}

// ---------------------------------------------------------------
// _enviarCorreoGmail — envía un email via GmailApp (nativo Apps Script)
// ---------------------------------------------------------------
function _enviarCorreoGmail(para, asunto, cuerpo, htmlCuerpo) {
  const options = {
    name:    FRANCISCA_NAME + ' · franciscabustos.cl',
    replyTo: FRANCISCA_EMAIL,
  };
  if (htmlCuerpo) {
    options.htmlBody = htmlCuerpo;
  }
  GmailApp.sendEmail(para, asunto, cuerpo, options);
}

// ---------------------------------------------------------------
// _buildEmailHtml — construye el HTML del email reemplazando
// todas las {{variables}} y eliminando el bloque Meet si no aplica
// ---------------------------------------------------------------
function _buildEmailHtml(vars) {
  var tpl = _getEmailTemplate();

  // Eliminar bloque Meet si no hay enlace
  if (!vars.google_meet_link) {
    tpl = tpl.replace(/<!--MEET_START-->[\s\S]*?<!--MEET_END-->/g, '');
  }

  // Eliminar bloque Manage si no hay URLs de gestión (ciclo único: solo email inicial las recibe)
  if (!vars.url_reagendar) {
    tpl = tpl.replace(/<!--MANAGE_START-->[\s\S]*?<!--MANAGE_END-->/g, '');
  }

  // Reemplazar todas las {{variables}} con sus valores
  return tpl.replace(/\{\{(\w+)\}\}/g, function(match, key) {
    return vars.hasOwnProperty(key) ? vars[key] : '';
  });
}


// ---------------------------------------------------------------
// _buildCancelacionInternalHtml_ — email interno a Francisca · cancelación
// ---------------------------------------------------------------
function _buildCancelacionInternalHtml_(vars) {
  var nombre    = vars.nombre    || '';
  var emailP    = vars.email     || '';
  var telefono  = vars.telefono  || '—';
  var servicio  = vars.servicio  || '—';
  var modalidad = vars.modalidad || '—';
  var hora      = vars.hora      || '';
  var fechaL    = vars.fecha_larga || '';
  var rid       = vars.id_reserva  || '—';

  var f1  = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
  var f2  = 'font-family:Georgia,\'Times New Roman\',serif;';
  var div = '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;"><table width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>';

  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<style>body,table,td{-webkit-text-size-adjust:100%}table,td{border-collapse:collapse!important}body{margin:0;padding:0;background-color:#EFE7DB}</style></head>'
    + '<body style="margin:0;padding:0;background-color:#EFE7DB;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EFE7DB;"><tr><td align="center" style="padding:40px 16px 48px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">'

    // HEADER
    + '<tr><td align="center" style="background-color:#FDFBF7;border-radius:14px 14px 0 0;padding:30px 40px 26px;border-bottom:1px solid #E4DDD5;">'
    + '<p style="margin:0 0 4px;' + f2 + 'font-size:20px;font-weight:400;letter-spacing:0.03em;color:#231F1C;">Francisca Bustos</p>'
    + '<p style="margin:0;' + f1 + 'font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8A8178;">Psicología Perinatal</p>'
    + '</td></tr>'

    // BODY
    + '<tr><td style="background-color:#FDFBF7;">'

    // Título
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:34px 40px 0;">'
    + '<p style="margin:0 0 4px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Aviso interno</p>'
    + '<p style="margin:0 0 10px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.25;letter-spacing:-0.01em;">Reserva cancelada.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.6;">Hola Francisca, la reserva de <strong style="color:#231F1C;">' + nombre + '</strong> fue cancelada correctamente.</p>'
    + '</td></tr></table>'

    // Hero — sesión cancelada
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:20px 40px 0;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">'
    + '<tr><td width="4" style="background-color:#C9A8B3;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>'
    + '<td style="padding:20px 22px 20px 20px;">'
    + '<p style="margin:0 0 7px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Sesión cancelada</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:22px;font-weight:400;color:#5A534D;line-height:1.2;">' + fechaL + '</p>'
    + '<p style="margin:0 0 14px;' + f2 + 'font-size:16px;font-weight:400;color:#8A8178;">' + hora + '</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + modalidad + '</span>'
    + '</td><td style="width:8px;"></td>'
    + '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + servicio + '</span>'
    + '</td></tr></table>'
    + '</td></tr></table></td></tr></table>'

    // Divider
    + div

    // Datos del paciente
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Datos del paciente</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">Nombre</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + nombre + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">Email</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;"><a href="mailto:' + emailP + '" style="color:#8A5A6B;text-decoration:none;">' + emailP + '</a></td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">Teléfono</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + telefono + '</td></tr>'
    + '</table></td></tr></table>'

    // Divider
    + div

    // Info administrativa
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Información administrativa</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">ID de reserva</td>'
    + '<td style="padding:6px 0;font-family:\'Courier New\',Courier,monospace;font-size:13px;color:#231F1C;letter-spacing:0.02em;">' + rid + '</td></tr>'
    + '</table></td></tr></table>'

    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td height="28">&nbsp;</td></tr></table>'
    + '</td></tr>'

    // FOOTER
    + '<tr><td style="background-color:#FAF6F0;border-top:1px solid #C9A8B3;border-radius:0 0 14px 14px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:26px 40px 28px;">'
    + '<p style="margin:0 0 6px;' + f1 + 'font-size:12px;color:#5A534D;">El evento fue cancelado en Google Calendar y el paciente fue notificado.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:11px;color:#8A8178;">Este correo fue generado automáticamente desde franciscabustos.cl.</p>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function _buildCancelacionPacienteHtml_(vars) {
  var primerNombre = vars.primer_nombre || 'Paciente';
  var fechaL    = vars.fecha_larga  || '';
  var hora      = vars.hora         || '';
  var urlReserva = vars.url_reserva || 'https://franciscabustos.cl/reserva';
  var rid       = vars.id_reserva   || '—';
  var servicio  = vars.servicio     || '';
  var modalidad = vars.modalidad    || '';

  var f1  = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
  var f2  = 'font-family:Georgia,\'Times New Roman\',serif;';
  var div = '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;"><table width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>';

  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<style>body,table,td{-webkit-text-size-adjust:100%}table,td{border-collapse:collapse!important}body{margin:0;padding:0;background-color:#EFE7DB}</style></head>'
    + '<body style="margin:0;padding:0;background-color:#EFE7DB;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EFE7DB;"><tr><td align="center" style="padding:40px 16px 48px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">'
    + '<tr><td align="center" style="background-color:#FDFBF7;border-radius:14px 14px 0 0;padding:30px 40px 26px;border-bottom:1px solid #E4DDD5;">'
    + '<p style="margin:0 0 4px;' + f2 + 'font-size:20px;font-weight:400;letter-spacing:0.03em;color:#231F1C;">Francisca Bustos</p>'
    + '<p style="margin:0;' + f1 + 'font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8A8178;">Psicología Perinatal</p>'
    + '</td></tr>'
    + '<tr><td style="background-color:#FDFBF7;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:34px 40px 0;">'
    + '<p style="margin:0 0 6px;' + f1 + 'font-size:15px;color:#5A534D;line-height:1.6;">Hola <strong style="color:#231F1C;font-weight:600;">' + primerNombre + '</strong>,</p>'
    + '<p style="margin:0 0 8px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.25;letter-spacing:-0.01em;">Tu sesión fue cancelada.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.6;">La cancelación quedó registrada correctamente.</p>'
    + '</td></tr></table>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:20px 40px 0;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">'
    + '<tr><td width="4" style="background-color:#C9A8B3;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>'
    + '<td style="padding:20px 22px 20px 20px;">'
    + '<p style="margin:0 0 7px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Sesión cancelada</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.2;">' + fechaL + '</p>'
    + '<p style="margin:0 0 14px;' + f2 + 'font-size:16px;font-weight:400;color:#5A534D;">' + hora + '</p>'
    + (servicio || modalidad
        ? '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>'
          + (modalidad ? '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;"><span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + modalidad + '</span></td>' : '')
          + (modalidad && servicio ? '<td style="width:8px;"></td>' : '')
          + (servicio  ? '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;"><span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + servicio + '</span></td>' : '')
          + '</tr></table>'
        : '')
    + '</td></tr></table></td></tr></table>'
    + div
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 9px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">¿Necesitas una nueva hora?</p>'
    + '<p style="margin:0 0 16px;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.7;">Puedes reservar una nueva sesión cuando te acomode desde el siguiente enlace.</p>'
    + '<a href="' + urlReserva + '" style="background-color:#231F1C;border-radius:8px;color:#FDFBF7;display:inline-block;' + f1 + 'font-size:14px;font-weight:600;line-height:1;padding:16px 32px;text-decoration:none;letter-spacing:0.02em;">Agendar una nueva hora →</a>'
    + '</td></tr></table>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td height="28">&nbsp;</td></tr></table>'
    + '</td></tr>'
    + '<tr><td style="background-color:#FAF6F0;border-top:1px solid #C9A8B3;border-radius:0 0 14px 14px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:26px 40px 28px;">'
    + '<p style="margin:0 0 18px;' + f1 + 'font-size:13px;color:#5A534D;line-height:1.6;">Si necesitas agendar una nueva hora más adelante, puedes escribirnos por WhatsApp o responder este correo.</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:16px;font-weight:400;color:#231F1C;letter-spacing:0.01em;">Francisca Bustos</p>'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;color:#8A8178;letter-spacing:0.08em;text-transform:uppercase;">Psicología Perinatal</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + '<p style="margin:14px 0 0;' + f1 + 'font-size:11px;color:#8A8178;line-height:1.5;">ID de reserva:&nbsp;<span style="font-family:\'Courier New\',Courier,monospace;letter-spacing:0.03em;">' + rid + '</span></p>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

// ---------------------------------------------------------------
// _buildReagendamientoInternalHtml_ — email interno a Francisca · reagendamiento
// ---------------------------------------------------------------
function _buildReagendamientoInternalHtml_(vars) {
  var nombre       = vars.nombre               || '';
  var emailP       = vars.email                || '';
  var telefono     = vars.telefono             || '—';
  var servicio     = vars.servicio             || '—';
  var modalidad    = vars.modalidad            || '—';
  var horaNueva    = vars.hora_nueva           || '';
  var fechaNuevaL  = vars.fecha_nueva_larga    || '';
  var horaAnterior = vars.hora_anterior        || '';
  var fechaAntL    = vars.fecha_anterior_larga || '';
  var idAnterior   = vars.id_anterior          || '—';
  var idNuevo      = vars.id_nuevo             || '—';
  var urlReag      = vars.url_reagendar        || '';
  var urlCanc      = vars.url_cancelar         || '';

  var f1  = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
  var f2  = 'font-family:Georgia,\'Times New Roman\',serif;';
  var div = '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;"><table width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>';

  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<style>body,table,td{-webkit-text-size-adjust:100%}table,td{border-collapse:collapse!important}body{margin:0;padding:0;background-color:#EFE7DB}</style></head>'
    + '<body style="margin:0;padding:0;background-color:#EFE7DB;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EFE7DB;"><tr><td align="center" style="padding:40px 16px 48px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">'

    // HEADER
    + '<tr><td align="center" style="background-color:#FDFBF7;border-radius:14px 14px 0 0;padding:30px 40px 26px;border-bottom:1px solid #E4DDD5;">'
    + '<p style="margin:0 0 4px;' + f2 + 'font-size:20px;font-weight:400;letter-spacing:0.03em;color:#231F1C;">Francisca Bustos</p>'
    + '<p style="margin:0;' + f1 + 'font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8A8178;">Psicología Perinatal</p>'
    + '</td></tr>'

    // BODY
    + '<tr><td style="background-color:#FDFBF7;">'

    // Título
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:34px 40px 0;">'
    + '<p style="margin:0 0 4px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Aviso interno</p>'
    + '<p style="margin:0 0 10px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.25;letter-spacing:-0.01em;">Reserva reagendada.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.6;">Hola Francisca, la reserva de <strong style="color:#231F1C;">' + nombre + '</strong> fue reagendada correctamente.</p>'
    + '</td></tr></table>'

    // Hero — nueva sesión
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:20px 40px 0;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">'
    + '<tr><td width="4" style="background-color:#8A5A6B;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>'
    + '<td style="padding:20px 22px 20px 20px;">'
    + '<p style="margin:0 0 7px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Nueva sesión</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.2;">' + fechaNuevaL + '</p>'
    + '<p style="margin:0 0 14px;' + f2 + 'font-size:16px;font-weight:400;color:#5A534D;">' + horaNueva + '</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + modalidad + '</span>'
    + '</td><td style="width:8px;"></td>'
    + '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + servicio + '</span>'
    + '</td></tr></table>'
    + '</td></tr></table></td></tr></table>'

    // Reserva anterior (muted)
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:10px 40px 0;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FDFBF7;border:1px solid #E4DDD5;border-radius:10px;">'
    + '<tr><td width="4" style="background-color:#E4DDD5;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>'
    + '<td style="padding:16px 22px 16px 20px;">'
    + '<p style="margin:0 0 10px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Reserva anterior</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:3px 16px 3px 0;' + f1 + 'font-size:13px;color:#8A8178;width:60px;white-space:nowrap;">Fecha</td>'
    + '<td style="padding:3px 0;' + f1 + 'font-size:13px;color:#5A534D;">' + fechaAntL + '</td></tr>'
    + '<tr><td style="padding:3px 16px 3px 0;' + f1 + 'font-size:13px;color:#8A8178;width:60px;white-space:nowrap;">Hora</td>'
    + '<td style="padding:3px 0;' + f1 + 'font-size:13px;color:#5A534D;">' + horaAnterior + '</td></tr>'
    + '</table></td></tr></table></td></tr></table>'

    // Divider
    + div

    // Datos del paciente
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Datos del paciente</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">Nombre</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + nombre + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">Email</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;"><a href="mailto:' + emailP + '" style="color:#8A5A6B;text-decoration:none;">' + emailP + '</a></td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">Teléfono</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + telefono + '</td></tr>'
    + '</table></td></tr></table>'

    // Divider
    + div

    // Info administrativa
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Información administrativa</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">ID anterior</td>'
    + '<td style="padding:6px 0;font-family:\'Courier New\',Courier,monospace;font-size:13px;color:#5A534D;letter-spacing:0.02em;">' + idAnterior + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:130px;white-space:nowrap;">ID nuevo</td>'
    + '<td style="padding:6px 0;font-family:\'Courier New\',Courier,monospace;font-size:13px;color:#231F1C;font-weight:500;letter-spacing:0.02em;">' + idNuevo + '</td></tr>'
    + '</table></td></tr></table>'

    // v17: Bloque Gestión interna (solo email Francisca)
    + ((urlReag || urlCanc)
        ? div
          + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
          + '<p style="margin:0 0 6px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Gestión interna</p>'
          + '<p style="margin:0 0 14px;' + f1 + 'font-size:12px;color:#8A8178;line-height:1.6;">Estos enlaces apuntan a la NUEVA reserva. Solo para gestión interna de Francisca. No reenviar al paciente.</p>'
          + '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>'
          + (urlReag ? '<td style="padding-right:12px;"><a href="' + urlReag + '" style="background-color:#231F1C;border-radius:8px;color:#FDFBF7;display:inline-block;' + f1 + 'font-size:13px;font-weight:600;line-height:1;padding:12px 20px;text-decoration:none;letter-spacing:0.02em;">Reagendar esta sesión</a></td>' : '')
          + (urlCanc ? '<td><a href="' + urlCanc + '" style="background-color:#EFE7DB;border-radius:8px;color:#5A534D;display:inline-block;' + f1 + 'font-size:13px;font-weight:500;line-height:1;padding:12px 20px;text-decoration:none;letter-spacing:0.02em;">Cancelar esta sesión</a></td>' : '')
          + '</tr></table>'
          + '</td></tr></table>'
        : '')

    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td height="28">&nbsp;</td></tr></table>'
    + '</td></tr>'

    // FOOTER
    + '<tr><td style="background-color:#FAF6F0;border-top:1px solid #C9A8B3;border-radius:0 0 14px 14px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:26px 40px 28px;">'
    + '<p style="margin:0 0 6px;' + f1 + 'font-size:12px;color:#5A534D;">El evento anterior fue cancelado y el nuevo evento ya fue creado en Google Calendar.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:11px;color:#8A8178;">Este correo fue generado automáticamente desde franciscabustos.cl.</p>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

// ---------------------------------------------------------------
// _buildReagendamientoPacienteHtml_ — email al paciente · reagendamiento
// Sin links de gestión (/manage). Solo confirmación de nueva hora + pago.
// ---------------------------------------------------------------
function _buildReagendamientoPacienteHtml_(vars) {
  var primerNombre  = vars.primer_nombre    || 'Hola';
  var fechaL        = vars.fecha_larga      || '';
  var hora          = vars.hora             || '';
  var modalidad     = vars.modalidad        || '—';
  var servicio      = vars.servicio         || '—';
  var meetLink      = vars.google_meet_link || '';
  var titular       = vars.titular_cuenta   || '';
  var rut           = vars.rut_titular      || '';
  var banco         = vars.banco            || '';
  var tipoCuenta    = vars.tipo_cuenta      || '';
  var numeroCuenta  = vars.numero_cuenta    || '';
  var emailPago     = vars.email_pago       || '';
  var monto         = vars.monto_sesion     || '';
  var urlPago       = vars.url_pago_con_utm || 'https://franciscabustos.cl/pago';
  var rid           = vars.id_reserva       || '—';

  var f1  = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
  var f2  = 'font-family:Georgia,\'Times New Roman\',serif;';
  var div = '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;"><table width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>';

  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<style>body,table,td{-webkit-text-size-adjust:100%}table,td{border-collapse:collapse!important}body{margin:0;padding:0;background-color:#EFE7DB}</style></head>'
    + '<body style="margin:0;padding:0;background-color:#EFE7DB;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EFE7DB;"><tr><td align="center" style="padding:40px 16px 48px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">'

    // HEADER
    + '<tr><td align="center" style="background-color:#FDFBF7;border-radius:14px 14px 0 0;padding:30px 40px 26px;border-bottom:1px solid #E4DDD5;">'
    + '<p style="margin:0 0 4px;' + f2 + 'font-size:20px;font-weight:400;letter-spacing:0.03em;color:#231F1C;">Francisca Bustos</p>'
    + '<p style="margin:0;' + f1 + 'font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8A8178;">Psicología Perinatal</p>'
    + '</td></tr>'

    // BODY
    + '<tr><td style="background-color:#FDFBF7;">'

    // Título
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:34px 40px 0;">'
    + '<p style="margin:0 0 6px;' + f1 + 'font-size:15px;color:#5A534D;line-height:1.6;">Hola <strong style="color:#231F1C;font-weight:600;">' + primerNombre + '</strong>,</p>'
    + '<p style="margin:0 0 8px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.25;letter-spacing:-0.01em;">Tu sesión fue reagendada.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.6;">Tu nueva sesión quedó confirmada. Aquí tienes todos los detalles.</p>'
    + '</td></tr></table>'

    // Hero — nueva sesión
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:20px 40px 0;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">'
    + '<tr><td width="4" style="background-color:#8A5A6B;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>'
    + '<td style="padding:20px 22px 20px 20px;">'
    + '<p style="margin:0 0 7px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Nueva sesión</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.2;">' + fechaL + '</p>'
    + '<p style="margin:0 0 14px;' + f2 + 'font-size:16px;font-weight:400;color:#5A534D;">' + hora + '</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + modalidad + '</span>'
    + '</td><td style="width:8px;"></td>'
    + '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + servicio + '</span>'
    + '</td></tr></table>'
    + '</td></tr></table></td></tr></table>'

    // Google Meet (condicional)
    + (meetLink
        ? '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:12px 40px 0;">'
          + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#F5F0FA;border:1px solid #D8CCE8;border-radius:10px;">'
          + '<tr><td style="padding:16px 20px;">'
          + '<p style="margin:0 0 6px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#6B5B8A;">Enlace Google Meet</p>'
          + '<a href="' + meetLink + '" style="' + f1 + 'font-size:13px;color:#6B5B8A;text-decoration:underline;word-break:break-all;">' + meetLink + '</a>'
          + '</td></tr></table></td></tr></table>'
        : '')

    // Divider
    + div

    // Sesión pagada online — sin datos de transferencia
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.7;">Tu sesión fue pagada correctamente de forma online. Si tienes alguna consulta sobre el pago, puedes escribirnos a <a href="mailto:hola@franciscabustos.cl" style="color:#8A5A6B;text-decoration:none;font-weight:500;">hola@franciscabustos.cl</a>.</p>'
    + '</td></tr></table>'

    // Divider
    + div

    // Contacto directo (sin botones de gestión)
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.7;">Si necesitas modificar o cancelar esta nueva hora, responde este correo o escríbenos por WhatsApp para ayudarte directamente. Estamos en <a href="mailto:hola@franciscabustos.cl" style="color:#8A5A6B;text-decoration:none;font-weight:500;">hola@franciscabustos.cl</a>.</p>'
    + '</td></tr></table>'

    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td height="28">&nbsp;</td></tr></table>'
    + '</td></tr>'

    // FOOTER
    + '<tr><td style="background-color:#FAF6F0;border-top:1px solid #C9A8B3;border-radius:0 0 14px 14px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:26px 40px 28px;">'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:16px;font-weight:400;color:#231F1C;letter-spacing:0.01em;">Francisca Bustos</p>'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;color:#8A8178;letter-spacing:0.08em;text-transform:uppercase;">Psicología Perinatal</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + '<p style="margin:14px 0 0;' + f1 + 'font-size:11px;color:#8A8178;line-height:1.5;">ID de reserva:&nbsp;<span style="font-family:\'Courier New\',Courier,monospace;letter-spacing:0.03em;">' + rid + '</span></p>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

// ---------------------------------------------------------------
// _buildInternalEmailHtml — email a Francisca con misma identidad visual
// que el email al paciente
// ---------------------------------------------------------------
function _buildInternalEmailHtml(vars) {
  var nombre      = vars.nombre      || '';
  var emailP      = vars.email       || '';
  var telefono    = vars.telefono    || '\u2014';
  var servicio    = vars.servicio    || '\u2014';
  var modalidad   = vars.modalidad   || '\u2014';
  var hora        = vars.hora        || '';
  var motivo      = vars.motivo      || '\u2014';
  var fechaDM     = vars.fecha_dia_mes || '';
  var fechaL      = vars.fecha_larga   || '';
  var rid         = vars.id_reserva    || '\u2014';
  var mlink       = vars.meet_link     || '';
  var urlReag     = vars.url_reagendar || '';
  var urlCanc     = vars.url_cancelar  || '';
  var amountPaid  = vars.amount_paid   || '';
  var commerceOrd = vars.commerce_order || '';

  var f1 = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
  var f2 = 'font-family:Georgia,\'Times New Roman\',serif;';
  var div = '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;"><table width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>';

  var meetBlock = mlink
    ? '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:18px 40px 0;"><p style="margin:0 0 8px;' + f1 + 'font-size:13px;color:#5A534D;">Enlace Google Meet:</p><a href="' + mlink + '" style="color:#8A5A6B;' + f1 + 'font-size:13px;">' + mlink + '</a></td></tr></table>'
    : '';

  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<style>body,table,td{-webkit-text-size-adjust:100%}table,td{border-collapse:collapse!important}body{margin:0;padding:0;background-color:#EFE7DB}</style></head>'
    + '<body style="margin:0;padding:0;background-color:#EFE7DB;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EFE7DB;"><tr><td align="center" style="padding:40px 16px 48px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">'
    + '<tr><td align="center" style="background-color:#FDFBF7;border-radius:14px 14px 0 0;padding:30px 40px 26px;border-bottom:1px solid #E4DDD5;">'
    + '<p style="margin:0 0 4px;' + f2 + 'font-size:20px;font-weight:400;letter-spacing:0.03em;color:#231F1C;">Francisca Bustos</p>'
    + '<p style="margin:0;' + f1 + 'font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8A8178;">Psicolog\u00eda Perinatal</p>'
    + '</td></tr>'
    + '<tr><td style="background-color:#FDFBF7;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:34px 40px 0;">'
    + '<p style="margin:0 0 6px;' + f1 + 'font-size:15px;color:#5A534D;">Hola Francisca,</p>'
    + '<p style="margin:0;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.25;letter-spacing:-0.01em;">Nueva reserva confirmada.</p>'
    + '</td></tr></table>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:20px 40px 0;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">'
    + '<tr><td width="4" style="background-color:#8A5A6B;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>'
    + '<td style="padding:22px 22px 22px 20px;">'
    + '<p style="margin:0 0 7px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Sesi\u00f3n reservada</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:26px;font-weight:400;color:#231F1C;line-height:1.15;">' + fechaDM + '</p>'
    + '<p style="margin:0 0 16px;' + f2 + 'font-size:18px;font-weight:400;color:#5A534D;line-height:1.25;">' + hora + '</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + modalidad + '</span>'
    + '</td></tr></table>'
    + '</td></tr></table></td></tr></table>'
    + meetBlock
    + div
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Datos del paciente</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Nombre</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + nombre + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Email</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;"><a href="mailto:' + emailP + '" style="color:#8A5A6B;text-decoration:none;">' + emailP + '</a></td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Tel\u00e9fono</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + telefono + '</td></tr>'
    + '</table></td></tr></table>'
    + div
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Detalles de la sesi\u00f3n</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Servicio</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + servicio + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Modalidad</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + modalidad + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Fecha</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + fechaL + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Hora</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + hora + '</td></tr>'
    + (amountPaid ? '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Precio pagado</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:600;">' + amountPaid + '</td></tr>' : '')
    + (commerceOrd ? '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Flow order</td>'
    +     '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#8A8178;font-weight:400;">' + commerceOrd + '</td></tr>' : '')
    + '</table></td></tr></table>'
    + div
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 9px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Motivo de consulta</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#231F1C;line-height:1.7;">' + motivo + '</p>'
    + '</td></tr></table>'

    // v17: Bloque Gesti\u00f3n interna (solo email Francisca, nunca paciente)
    + ((urlReag || urlCanc)
        ? div
          + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
          + '<p style="margin:0 0 6px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Gesti\u00f3n interna</p>'
          + '<p style="margin:0 0 14px;' + f1 + 'font-size:12px;color:#8A8178;line-height:1.6;">Estos enlaces son solo para gesti\u00f3n interna de Francisca. No reenviar al paciente.</p>'
          + '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>'
          + (urlReag ? '<td style="padding-right:12px;"><a href="' + urlReag + '" style="background-color:#231F1C;border-radius:8px;color:#FDFBF7;display:inline-block;' + f1 + 'font-size:13px;font-weight:600;line-height:1;padding:12px 20px;text-decoration:none;letter-spacing:0.02em;">Reagendar esta sesi\u00f3n</a></td>' : '')
          + (urlCanc ? '<td><a href="' + urlCanc + '" style="background-color:#EFE7DB;border-radius:8px;color:#5A534D;display:inline-block;' + f1 + 'font-size:13px;font-weight:500;line-height:1;padding:12px 20px;text-decoration:none;letter-spacing:0.02em;">Cancelar esta sesi\u00f3n</a></td>' : '')
          + '</tr></table>'
          + '</td></tr></table>'
        : '')

    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td height="28">&nbsp;</td></tr></table>'
    + '</td></tr>'
    + '<tr><td style="background-color:#FAF6F0;border-top:1px solid #C9A8B3;border-radius:0 0 14px 14px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:26px 40px 28px;">'
    + '<p style="margin:0 0 6px;' + f1 + 'font-size:12px;color:#5A534D;">El evento fue creado autom\u00e1ticamente en Google Calendar.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:11px;color:#8A8178;">ID de reserva:&nbsp;<span style="font-family:\'Courier New\',monospace;letter-spacing:0.03em;">' + rid + '</span></p>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

// ---------------------------------------------------------------
// _getEmailTemplate — plantilla HTML de confirmación al paciente
// ---------------------------------------------------------------
function _getEmailTemplate() {
  return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <title>Reserva confirmada · Francisca Bustos</title>
  <style type="text/css">
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse!important}
    img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;display:block}
    a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
    #MessageViewBody a{color:inherit;text-decoration:none}
    u+#body a{color:inherit;text-decoration:none}
    #outlook a{padding:0}
    body{margin:0!important;padding:0!important;width:100%!important;min-width:100%;background-color:#EFE7DB}
    @media only screen and (max-width:620px){
      .wrap{width:100%!important;max-width:100%!important}
      .inner-pad{padding-left:20px!important;padding-right:20px!important}
      .hero-date{font-size:22px!important;line-height:1.2!important}
      .hero-time{font-size:17px!important}
      .data-label{display:block!important;width:100%!important;padding-bottom:0!important}
      .data-value{display:block!important;width:100%!important;padding-bottom:10px!important}
    }
  </style>
</head>
<body id="body" style="margin:0;padding:0;background-color:#EFE7DB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;">

<div style="display:none;font-size:1px;color:#EFE7DB;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;">Aquí encontrarás los detalles para conectarte, prepararte y dejar todo listo antes de tu sesión.&#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;</div>

<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EFE7DB;">
  <tr>
    <td align="center" style="padding:40px 16px 48px 16px;">
      <table role="presentation" class="wrap" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">

        <!-- HEADER -->
        <tr>
          <td align="center" style="background-color:#FDFBF7;border-radius:14px 14px 0 0;padding:30px 40px 26px;border-bottom:1px solid #E4DDD5;">
            <p style="margin:0 0 4px;font-family:Georgia,'Times New Roman',Times,serif;font-size:20px;font-weight:400;letter-spacing:0.03em;color:#231F1C;line-height:1.2;">Francisca Bustos</p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:400;letter-spacing:0.14em;text-transform:uppercase;color:#8A8178;">Psicología Perinatal</p>
          </td>
        </tr>

        <!-- CUERPO -->
        <tr>
          <td style="background-color:#FDFBF7;">

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:34px 40px 0;">
                  <p style="margin:0 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;color:#5A534D;line-height:1.6;">Hola <strong style="color:#231F1C;font-weight:600;">{{primer_nombre}}</strong>,</p>
                  <p style="margin:0;font-family:Georgia,'Times New Roman',Times,serif;font-size:22px;font-weight:400;color:#231F1C;line-height:1.25;letter-spacing:-0.01em;">Tu reserva está confirmada.</p>
                  <p style="margin:8px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;color:#5A534D;line-height:1.55;">Hemos recibido correctamente el pago online de tu sesión. Tu hora queda confirmada.</p>
                </td>
              </tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:20px 40px 0;">
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">
                    <tr>
                      <td width="4" style="background-color:#8A5A6B;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>
                      <td style="padding:22px 22px 22px 20px;">
                        <p style="margin:0 0 7px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Tu próxima sesión</p>
                        <p class="hero-date" style="margin:0 0 2px;font-family:Georgia,'Times New Roman',Times,serif;font-size:26px;font-weight:400;color:#231F1C;line-height:1.15;letter-spacing:-0.01em;">{{fecha_dia_mes}}</p>
                        <p class="hero-time" style="margin:0 0 16px;font-family:Georgia,'Times New Roman',Times,serif;font-size:18px;font-weight:400;color:#5A534D;line-height:1.25;">{{hora}}</p>
                        <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">
                              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:500;color:#5A534D;letter-spacing:0.05em;">{{modalidad}}</span>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!--MEET_START-->
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:18px 40px 0;">
                  <p style="margin:0 0 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;color:#5A534D;line-height:1.65;">Si tu sesión es online, podrás conectarte desde el siguiente enlace:</p>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td align="center">
                        <!--[if mso]>
                        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{google_meet_link}}" style="height:50px;v-text-anchor:middle;width:520px;" arcsize="8%" stroke="f" fillcolor="#231F1C">
                          <w:anchorlock/>
                          <center style="color:#FDFBF7;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;">Unirme a la sesión online</center>
                        </v:roundrect>
                        <![endif]-->
                        <!--[if !mso]><!-->
                        <a href="{{google_meet_link}}" style="background-color:#231F1C;border-radius:8px;color:#FDFBF7;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;line-height:1;padding:16px 32px;text-decoration:none;letter-spacing:0.02em;width:100%;box-sizing:border-box;text-align:center;mso-hide:all;">Unirme a la sesión online &nbsp;→</a>
                        <!--<![endif]-->
                      </td>
                    </tr>
                  </table>
                  <p style="margin:10px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;color:#8A8178;line-height:1.5;text-align:center;">Te sugerimos abrir el enlace unos minutos antes para conectarte con calma.</p>
                </td>
              </tr>
            </table>
            <!--MEET_END-->

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr><td class="inner-pad" style="padding:26px 40px 0;"><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:22px 40px 0;">
                  <p style="margin:0 0 13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Detalles de tu sesión</p>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td class="data-label" style="padding:6px 16px 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#8A8178;width:110px;vertical-align:top;white-space:nowrap;">Servicio</td>
                      <td class="data-value" style="padding:6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#231F1C;font-weight:500;vertical-align:top;">{{servicio}}</td>
                    </tr>
                    <tr>
                      <td class="data-label" style="padding:6px 16px 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#8A8178;width:110px;vertical-align:top;white-space:nowrap;">Modalidad</td>
                      <td class="data-value" style="padding:6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#231F1C;font-weight:500;vertical-align:top;">{{modalidad}}</td>
                    </tr>
                    <tr>
                      <td class="data-label" style="padding:6px 16px 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#8A8178;width:110px;vertical-align:top;white-space:nowrap;">Fecha</td>
                      <td class="data-value" style="padding:6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#231F1C;font-weight:500;vertical-align:top;">{{fecha_larga}}</td>
                    </tr>
                    <tr>
                      <td class="data-label" style="padding:6px 16px 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#8A8178;width:110px;vertical-align:top;white-space:nowrap;">Hora</td>
                      <td class="data-value" style="padding:6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#231F1C;font-weight:500;vertical-align:top;">{{hora}}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr><td class="inner-pad" style="padding:22px 40px 0;"><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:22px 40px 0;">
                  <p style="margin:0 0 9px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Antes de la sesión</p>
                  <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;color:#5A534D;line-height:1.7;">Para que puedas prepararte con calma, te recomendamos elegir un espacio tranquilo y tener a mano cualquier antecedente, duda o tema que quieras conversar durante la sesión.</p>
                </td>
              </tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr><td class="inner-pad" style="padding:22px 40px 0;"><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:22px 40px 0;">
                  <p style="margin:0 0 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Precio pagado</p>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">
                    <tr>
                      <td style="padding:20px 22px 16px;">
                        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                          <tr>
                            <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;color:#8A8178;vertical-align:middle;">Monto pagado</td>
                            <td align="right" style="font-family:Georgia,'Times New Roman',Times,serif;font-size:20px;font-weight:400;color:#231F1C;vertical-align:middle;letter-spacing:-0.01em;">{{monto_sesion}}</td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:14px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#5A534D;line-height:1.65;">Si necesitas modificar tu hora, puedes hacerlo desde los enlaces de este correo o escribirnos a <a href="mailto:hola@franciscabustos.cl" style="color:#8A5A6B;text-decoration:none;font-weight:500;">hola@franciscabustos.cl</a>.</p>
                </td>
              </tr>
            </table>

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr><td class="inner-pad" style="padding:22px 40px 0;"><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
            </table>

            <!--MANAGE_START-->
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:22px 40px 0;">
                  <p style="margin:0 0 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">¿Necesitas modificar o cancelar?</p>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-right:12px;">
                        <a href="{{url_reagendar}}" style="background-color:#231F1C;border-radius:8px;color:#FDFBF7;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;font-weight:600;line-height:1;padding:14px 24px;text-decoration:none;letter-spacing:0.02em;">Reagendar sesión</a>
                      </td>
                      <td>
                        <a href="{{url_cancelar}}" style="background-color:#EFE7DB;border-radius:8px;color:#5A534D;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;font-weight:500;line-height:1;padding:14px 24px;text-decoration:none;letter-spacing:0.02em;">Cancelar reserva</a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:14px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;color:#8A8178;line-height:1.6;">Los enlaces son válidos para esta reserva. También puedes responder este correo directamente si tienes consultas.</p>
                </td>
              </tr>
            </table>
            <!--MANAGE_END-->

            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr><td height="28">&nbsp;</td></tr>
            </table>

          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background-color:#FAF6F0;border-top:1px solid #C9A8B3;border-radius:0 0 14px 14px;">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td class="inner-pad" style="padding:26px 40px 28px;">
                  <p style="margin:0 0 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;color:#5A534D;line-height:1.6;">Gracias por confiar en este espacio.</p>
                  <p style="margin:0 0 2px;font-family:Georgia,'Times New Roman',Times,serif;font-size:16px;font-weight:400;color:#231F1C;letter-spacing:0.01em;">Francisca Bustos</p>
                  <p style="margin:0 0 13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:10px;color:#8A8178;letter-spacing:0.08em;text-transform:uppercase;">Psicóloga Perinatal</p>
                  <p style="margin:0 0 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;color:#8A8178;line-height:1.8;">
                    <a href="https://www.franciscabustos.cl" style="color:#8A5A6B;text-decoration:none;font-weight:500;">www.franciscabustos.cl</a>
                    <span style="color:#C9A8B3;">&nbsp;·&nbsp;</span>
                    <a href="mailto:hola@franciscabustos.cl" style="color:#8A5A6B;text-decoration:none;font-weight:500;">hola@franciscabustos.cl</a>
                  </p>
                  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr>
                  </table>
                  <p style="margin:14px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;color:#8A8178;line-height:1.5;">ID de reserva:&nbsp;<span style="font-family:'Courier New',Courier,monospace;letter-spacing:0.03em;">{{id_reserva}}</span></p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td height="24">&nbsp;</td></tr>

        <tr>
          <td align="center" style="padding:0 16px 8px;">
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;color:#8A7F76;line-height:1.6;text-align:center;">Recibiste este mensaje porque realizaste una reserva en franciscabustos.cl.<br>Puedes responder directamente a este correo si tienes alguna consulta.</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

// ---------------------------------------------------------------
// _enviarCorreos — interno + paciente (ambos via GmailApp)
// Retorna { emailInternalSent: bool, emailPatientSent: bool }
// ---------------------------------------------------------------
function _enviarCorreos(d, skipInternal) {
  const nombre    = d.nombre    || 'Paciente';
  const email     = d.email     || '';
  const telefono  = d.telefono  || '?';
  const servicio  = d.servicio  || '?';
  const modalidad = d.modalidad || '?';
  const hora      = _normalizeHoraForBackend_(d.hora);
  const motivo    = d.motivo    || '?';
  const reservaId = d.reservaId || '?';

  const fechas     = _parseFechas(d.fecha);
  const fechaLarga = fechas.fechaLarga;

  var fechaDiaMes = fechaLarga;
  var diaMesMatch = _toSafeString_(fechaLarga).match(/(\d{1,2} de \w+)/i);
  if (diaMesMatch) fechaDiaMes = diaMesMatch[1];

  var emailInternalSent = false;
  var emailPatientSent  = false;

  if (!skipInternal) {
    try {
      const asuntoInterno =
        'Nueva reserva pagada · ' + fechaDiaMes + ' a las ' + hora + ' · ' + nombre;

      // v17: links internos de gestión SOLO en el email interno a Francisca.
      const internalReagendar = d.manageToken
        ? MANAGE_URL + '?token=' + encodeURIComponent(d.manageToken) + '&open=reschedule'
        : '';
      const internalCancelar  = d.manageToken
        ? MANAGE_URL + '?token=' + encodeURIComponent(d.manageToken) + '&open=cancel'
        : '';

      const cuerpoInterno =
        'Hola Francisca,\n\n' +
        'Nueva reserva confirmada desde franciscabustos.cl.\n' +
        'El evento ya fue creado en tu Google Calendar.\n\n' +
        'SESION\n' +
        '----------------------\n' +
        'Servicio:       ' + servicio  + '\n' +
        'Modalidad:      ' + modalidad + '\n' +
        'Fecha:          ' + fechaLarga + '\n' +
        'Hora:           ' + hora + ' h\n\n' +
        'PACIENTE\n' +
        '----------------------\n' +
        'Nombre:    ' + nombre   + '\n' +
        'Email:     ' + email    + '\n' +
        'Telefono:  ' + telefono + '\n\n' +
        'MOTIVO\n' +
        '----------------------\n' +
        motivo + '\n\n' +
        (internalReagendar || internalCancelar
          ? 'GESTION INTERNA (solo Francisca, no reenviar al paciente)\n' +
            '----------------------\n' +
            (internalReagendar ? 'Reagendar: ' + internalReagendar + '\n' : '') +
            (internalCancelar  ? 'Cancelar:  ' + internalCancelar  + '\n' : '') +
            '\n'
          : '') +
        'ID de reserva: ' + reservaId + '\n\n' +
        'Este correo fue generado automaticamente desde franciscabustos.cl.';

      const htmlInterno = _buildInternalEmailHtml({
        nombre:           nombre,
        email:            email,
        telefono:         telefono,
        servicio:         servicio,
        modalidad:        modalidad,
        hora:             hora + ' h',
        motivo:           motivo,
        fecha_dia_mes:    fechaDiaMes,
        fecha_larga:      fechaLarga,
        id_reserva:       reservaId,
        meet_link:        d.googleMeetLink || d.google_meet_link || '',
        url_reagendar:    internalReagendar,
        url_cancelar:     internalCancelar,
        amount_paid:      d.amount_paid    || '',
        commerce_order:   d.commerce_order || '',
      });
      _enviarCorreoGmail(FRANCISCA_EMAIL, asuntoInterno, cuerpoInterno, htmlInterno);
      emailInternalSent = true;
    } catch (err) {
      Logger.log('Error email interno: ' + err);
    }
  }

  if (email) {
    try {
      const primerNombre = _toSafeString_(nombre).split(' ')[0] || nombre;

      var fechaDiaMesPaciente = fechaDiaMes;
      var diaSemanaMatch = _toSafeString_(fechaLarga).match(/^(\w+)/i);
      if (diaSemanaMatch) {
        fechaDiaMesPaciente = diaSemanaMatch[1].toLowerCase() + ' ' + fechaDiaMes;
      }

      var fechaLargaConComa = fechaLarga.charAt(0).toLowerCase() + fechaLarga.slice(1);
      fechaLargaConComa = fechaLargaConComa.replace(/^(\w+)(\s)/, '$1,$2');

      const horaDisplay = hora + ' h';
      const meetLink    = d.googleMeetLink || d.google_meet_link || '';
      // v16: links de gestión solo si emailContext === EMAIL_CONTEXT_INITIAL (contrato explícito).
      const allowManageLinks = _canExposeManageLinks_(d.emailContext);
      const url_reagendar = allowManageLinks && d.manageToken
        ? MANAGE_URL + '?token=' + encodeURIComponent(d.manageToken) + '&open=reschedule'
        : '';
      const url_cancelar  = allowManageLinks && d.manageToken
        ? MANAGE_URL + '?token=' + encodeURIComponent(d.manageToken) + '&open=cancel'
        : '';

      const asuntoPaciente = 'Reserva confirmada · Francisca Bustos';

      const cuerpoPaciente =
        'Hola ' + primerNombre + ',\n\n' +
        'Tu reserva está confirmada. Hemos recibido correctamente el pago online de tu sesión.\n\n' +
        fechaDiaMesPaciente.toUpperCase() + ' · ' + horaDisplay + ' · ' + modalidad + '\n\n' +
        (meetLink ? 'Enlace para conectarte:\n' + meetLink + '\n\n' : '') +
        'DETALLES\n' +
        '---------------------\n' +
        'Servicio:  ' + servicio  + '\n' +
        'Modalidad: ' + modalidad + '\n' +
        'Fecha:     ' + fechaLargaConComa + '\n' +
        'Hora:      ' + horaDisplay + '\n' +
        'Precio:    ' + _getMontoForServicio_(servicio) + '\n\n' +
        (url_reagendar ? 'Reagendar sesión: ' + url_reagendar + '\n' : '') +
        (url_cancelar  ? 'Cancelar reserva: ' + url_cancelar  + '\n\n' : '') +
        'Si tienes alguna consulta, escríbenos a hola@franciscabustos.cl\n\n' +
        'ID de reserva: ' + reservaId + '\n\n' +
        'Gracias por confiar en este espacio.\n\n' +
        FRANCISCA_NAME + '\nPsicologa Perinatal\n' + SITE_URL;

      const htmlPaciente = _buildEmailHtml({
        primer_nombre:    primerNombre,
        fecha_dia_mes:    fechaDiaMesPaciente,
        hora:             horaDisplay,
        modalidad:        modalidad,
        fecha_larga:      fechaLargaConComa,
        servicio:         servicio,
        google_meet_link: meetLink,
        monto_sesion:     _getMontoForServicio_(servicio),
        url_reagendar:    url_reagendar,
        url_cancelar:     url_cancelar,
        id_reserva:       reservaId,
      });

      _enviarCorreoGmail(email, asuntoPaciente, cuerpoPaciente, htmlPaciente);
      emailPatientSent = true;
    } catch (err) {
      Logger.log('Error email paciente: ' + err);
    }
  }

  Logger.log('Correos -> interno:' + emailInternalSent + ' paciente:' + emailPatientSent + ' skipInternal=' + !!skipInternal + ' / ' + reservaId);
  return { emailInternalSent: emailInternalSent, emailPatientSent: emailPatientSent };
}

function _enviarCorreosCancelacion(reserva, reason) {
  const fechaInfo  = _parseFechas(reserva.fecha);
  const fechaLarga = fechaInfo.fechaLarga || _normalizeFechaForBackend_(reserva.fecha) || '';
  const fechaCorta = fechaInfo.fechaCorta || '';
  const hora       = _normalizeHoraForBackend_(reserva.hora);
  const motivoCancelacion = _toSafeString_(reason).trim();

  const nombre    = reserva.nombre    || 'Paciente';
  const emailP    = reserva.email     || '';
  const telefono  = reserva.telefono  || '—';
  const servicio  = reserva.servicio  || '—';
  const modalidad = reserva.modalidad || '—';
  const rid       = reserva.reservaId || '—';
  const primerNombre = _toSafeString_(nombre).split(' ')[0] || 'Paciente';
  const urlNuevaReserva = 'https://franciscabustos.cl/reserva';

  // Subject mejorado: incluye fecha_corta y hora
  const asuntoInterno =
    'Reserva cancelada · ' + nombre + ' · ' + fechaCorta + ' ' + hora;

  // Fallback texto plano
  const cuerpoInterno =
    'Hola Francisca,\n\n' +
    'La reserva de ' + nombre + ' fue cancelada correctamente.\n\n' +
    'SESION CANCELADA\n' +
    '----------------------\n' +
    'Fecha:     ' + fechaLarga + '\n' +
    'Hora:      ' + hora + ' h\n' +
    'Modalidad: ' + modalidad + '\n' +
    'Servicio:  ' + servicio  + '\n\n' +
    'PACIENTE\n' +
    '----------------------\n' +
    'Nombre:    ' + nombre   + '\n' +
    'Email:     ' + emailP   + '\n' +
    'Telefono:  ' + telefono + '\n\n' +
    'INFORMACION ADMINISTRATIVA\n' +
    '----------------------\n' +
    'ID de reserva: ' + rid + '\n\n' +
    (motivoCancelacion ? 'Motivo del paciente: ' + motivoCancelacion + '\n\n' : '') +
    'El evento fue cancelado en Google Calendar y el paciente fue notificado.\n' +
    'Este correo fue generado automaticamente desde franciscabustos.cl.';

  // HTML enriquecido
  const htmlInterno = _buildCancelacionInternalHtml_({
    nombre:      nombre,
    email:       emailP,
    telefono:    telefono,
    servicio:    servicio,
    modalidad:   modalidad,
    hora:        hora + ' h',
    fecha_larga: fechaLarga,
    id_reserva:  rid,
  });

  var emailInternalSent = false;
  var emailPatientSent = false;
  try {
    _enviarCorreoGmail(FRANCISCA_EMAIL, asuntoInterno, cuerpoInterno, htmlInterno);
    emailInternalSent = true;
  } catch (err) {
    Logger.log('Error email cancelacion interno: ' + err);
  }

  if (emailP) {
    try {
      const cuerpoPaciente =
        'Hola ' + primerNombre + ',\n\n' +
        'Tu sesión fue cancelada correctamente.\n\n' +
        'Fecha original: ' + fechaLarga + '\n' +
        'Hora original: ' + hora + ' h\n' +
        'ID de reserva: ' + rid + '\n\n' +
        'Si necesitas una nueva hora, puedes reservar aquí:\n' + urlNuevaReserva + '\n\n' +
        FRANCISCA_NAME + '\nPsicóloga Perinatal\nhttps://' + SITE_URL;
      const htmlPaciente = _buildCancelacionPacienteHtml_({
        primer_nombre: primerNombre,
        fecha_larga:   fechaLarga,
        hora:          hora + ' h',
        servicio:      servicio,
        modalidad:     modalidad,
        url_reserva:   urlNuevaReserva,
        id_reserva:    rid,
      });

      // v16: guard defensivo por contexto
      _assertNoManageLinks_(htmlPaciente, EMAIL_CONTEXT_CANCEL);
      _assertNoManageLinks_(cuerpoPaciente, EMAIL_CONTEXT_CANCEL);

      _enviarCorreoGmail(emailP, 'Tu reserva fue cancelada', cuerpoPaciente, htmlPaciente);
      emailPatientSent = true;
    } catch (err) {
      Logger.log('Error email cancelacion paciente: ' + err);
    }
  }

  Logger.log('Correos cancelacion -> interno:' + emailInternalSent + ' paciente:' + emailPatientSent + ' emailContext:' + EMAIL_CONTEXT_CANCEL + ' manageLinksExposed:false / ' + rid);
  return { emailInternalSent: emailInternalSent, emailPatientSent: emailPatientSent, emailContext: EMAIL_CONTEXT_CANCEL, manageLinksExposed: false };
}

function _enviarCorreosReagendamiento(reservaAnterior, nuevaReserva) {
  const fechaAntInfo   = _parseFechas(reservaAnterior.fecha);
  const fechaAntLarga  = fechaAntInfo.fechaLarga || _normalizeFechaForBackend_(reservaAnterior.fecha) || '';

  const fechaNuevaInfo  = _parseFechas(nuevaReserva.fecha);
  const fechaNuevaLarga = fechaNuevaInfo.fechaLarga || _normalizeFechaForBackend_(nuevaReserva.fecha) || '';
  const fechaNuevaCorta = fechaNuevaInfo.fechaCorta || '';

  const horaAnterior = _normalizeHoraForBackend_(reservaAnterior.hora);
  const horaNueva    = _normalizeHoraForBackend_(nuevaReserva.hora);

  const nombre    = nuevaReserva.nombre    || 'Paciente';
  const emailP    = nuevaReserva.email     || '';
  const telefono  = nuevaReserva.telefono  || '—';
  const servicio  = nuevaReserva.servicio  || '—';
  const modalidad = nuevaReserva.modalidad || '—';

  // Subject mejorado: incluye fecha_nueva_corta y hora_nueva
  const asuntoInterno =
    'Reserva reagendada · ' + nombre + ' · ' + fechaNuevaCorta + ' ' + horaNueva;

  // v17: links internos de gestión apuntan al nuevo manageToken.
  const internalReagendar = nuevaReserva.manageToken
    ? MANAGE_URL + '?token=' + encodeURIComponent(nuevaReserva.manageToken) + '&open=reschedule'
    : '';
  const internalCancelar  = nuevaReserva.manageToken
    ? MANAGE_URL + '?token=' + encodeURIComponent(nuevaReserva.manageToken) + '&open=cancel'
    : '';

  // Fallback texto plano
  const cuerpoInterno =
    'Hola Francisca,\n\n' +
    'La reserva de ' + nombre + ' fue reagendada correctamente.\n\n' +
    'NUEVA SESION\n' +
    '----------------------\n' +
    'Fecha:     ' + fechaNuevaLarga + '\n' +
    'Hora:      ' + horaNueva + ' h\n' +
    'Modalidad: ' + modalidad + '\n' +
    'Servicio:  ' + servicio  + '\n\n' +
    'RESERVA ANTERIOR\n' +
    '----------------------\n' +
    'Fecha:     ' + fechaAntLarga  + '\n' +
    'Hora:      ' + horaAnterior   + ' h\n\n' +
    'PACIENTE\n' +
    '----------------------\n' +
    'Nombre:    ' + nombre   + '\n' +
    'Email:     ' + emailP   + '\n' +
    'Telefono:  ' + telefono + '\n\n' +
    (internalReagendar || internalCancelar
      ? 'GESTION INTERNA (solo Francisca, no reenviar al paciente)\n' +
        '----------------------\n' +
        (internalReagendar ? 'Reagendar: ' + internalReagendar + '\n' : '') +
        (internalCancelar  ? 'Cancelar:  ' + internalCancelar  + '\n' : '') +
        '\n'
      : '') +
    'INFORMACION ADMINISTRATIVA\n' +
    '----------------------\n' +
    'ID anterior: ' + (reservaAnterior.reservaId || '?') + '\n' +
    'ID nuevo:    ' + (nuevaReserva.reservaId    || '?') + '\n\n' +
    'El evento anterior fue cancelado y el nuevo evento ya fue creado en Google Calendar.\n' +
    'Este correo fue generado automaticamente desde franciscabustos.cl.';

  // HTML enriquecido
  const htmlInterno = _buildReagendamientoInternalHtml_({
    nombre:               nombre,
    email:                emailP,
    telefono:             telefono,
    servicio:             servicio,
    modalidad:            modalidad,
    hora_nueva:           horaNueva + ' h',
    fecha_nueva_larga:    fechaNuevaLarga,
    hora_anterior:        horaAnterior + ' h',
    fecha_anterior_larga: fechaAntLarga,
    id_anterior:          reservaAnterior.reservaId || '—',
    id_nuevo:             nuevaReserva.reservaId    || '—',
    url_reagendar:        internalReagendar,
    url_cancelar:         internalCancelar,
  });

  var emailInternalSent = false;
  var emailPatientSent = false;
  try {
    _enviarCorreoGmail(FRANCISCA_EMAIL, asuntoInterno, cuerpoInterno, htmlInterno);
    emailInternalSent = true;
  } catch (err) {
    Logger.log('Error email reagendamiento interno: ' + err);
  }

  // Email al paciente: confirmación directa SIN links /manage ni botones de gestión.
  // El paciente debe contactar directamente si necesita modificar o cancelar.
  if (emailP) {
    try {
      const primerNombrePac = _toSafeString_(nombre).split(' ')[0] || nombre;
      const meetLink = nuevaReserva.googleMeetLink || '';
      const horaPaciente = horaNueva + ' h';

      const cuerpoPaciente =
        'Hola ' + primerNombrePac + ',\n\n' +
        'Tu sesión fue reagendada correctamente.\n\n' +
        'NUEVA SESION\n' +
        '----------------------\n' +
        'Fecha:     ' + fechaNuevaLarga + '\n' +
        'Hora:      ' + horaPaciente + '\n' +
        'Modalidad: ' + modalidad + '\n' +
        'Servicio:  ' + servicio  + '\n\n' +
        (meetLink ? 'Enlace Google Meet:\n' + meetLink + '\n\n' : '') +
        'Si necesitas modificar o cancelar esta nueva hora, responde este correo o escríbenos a hola@franciscabustos.cl\n\n' +
        'ID de reserva: ' + (nuevaReserva.reservaId || '?') + '\n\n' +
        FRANCISCA_NAME + '\nPsicóloga Perinatal\nhttps://' + SITE_URL;

      const htmlPaciente = _buildReagendamientoPacienteHtml_({
        primer_nombre:    primerNombrePac,
        fecha_larga:      fechaNuevaLarga,
        hora:             horaPaciente,
        modalidad:        modalidad,
        servicio:         servicio,
        google_meet_link: meetLink,
        id_reserva:       nuevaReserva.reservaId || '—',
      });

      // v16: guard defensivo unificado por contexto
      _assertNoManageLinks_(htmlPaciente, EMAIL_CONTEXT_RESCHEDULE);
      _assertNoManageLinks_(cuerpoPaciente, EMAIL_CONTEXT_RESCHEDULE);

      _enviarCorreoGmail(emailP, 'Tu sesión fue reagendada · ' + fechaNuevaCorta, cuerpoPaciente, htmlPaciente);
      emailPatientSent = true;
    } catch (err) {
      Logger.log('Error email reagendamiento paciente: ' + err);
    }
  }

  Logger.log('Correos reagendamiento -> interno:' + emailInternalSent + ' paciente:' + emailPatientSent + ' emailContext:' + EMAIL_CONTEXT_RESCHEDULE + ' manageLinksExposed:false' + ' oldToken=' + _toSafeString_(reservaAnterior.manageToken) + ' newToken=' + _toSafeString_(nuevaReserva.manageToken));
  return { emailInternalSent: emailInternalSent, emailPatientSent: emailPatientSent, emailContext: EMAIL_CONTEXT_RESCHEDULE, manageLinksExposed: false };
}

// ---------------------------------------------------------------
// _buildReminderEmailHtml_ — email de recordatorio 24 h al paciente
// Misma identidad visual que los otros correos transaccionales.
// params: { primer_nombre, fecha_larga, fecha_dia_mes, hora,
//           modalidad, servicio, google_meet_link, id_reserva }
// ---------------------------------------------------------------
function _buildReminderEmailHtml_(vars) {
  var primerNombre = vars.primer_nombre    || 'Hola';
  var fechaL       = vars.fecha_larga      || '';
  var fechaDM      = vars.fecha_dia_mes    || fechaL;
  var hora         = vars.hora             || '';
  var modalidad    = vars.modalidad        || '';
  var servicio     = vars.servicio         || '';
  var meetLink     = vars.google_meet_link || '';
  var rid          = vars.id_reserva       || '';

  var f1  = 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
  var f2  = 'font-family:Georgia,\'Times New Roman\',serif;';
  var div = '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;"><table width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table>';

  // Bloque Meet — solo si existe enlace
  var meetBlock = meetLink
    ? '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
      + '<p style="margin:0 0 9px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Enlace para tu sesión online</p>'
      + '<p style="margin:0 0 16px;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.65;">Podrás conectarte desde el siguiente enlace. Te sugerimos abrirlo unos minutos antes para conectarte con calma.</p>'
      + '<a href="' + meetLink + '" style="background-color:#231F1C;border-radius:8px;color:#FDFBF7;display:inline-block;' + f1 + 'font-size:14px;font-weight:600;line-height:1;padding:16px 32px;text-decoration:none;letter-spacing:0.02em;">Unirme a la sesión →</a>'
      + '<p style="margin:10px 0 0;' + f1 + 'font-size:11px;color:#8A8178;line-height:1.5;">' + meetLink + '</p>'
      + '</td></tr></table>'
      + div
    : '';

  return '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
    + '<style>body,table,td{-webkit-text-size-adjust:100%}table,td{border-collapse:collapse!important}body{margin:0;padding:0;background-color:#EFE7DB}</style></head>'
    + '<body style="margin:0;padding:0;background-color:#EFE7DB;">'

    // Preheader oculto
    + '<div style="display:none;font-size:1px;color:#EFE7DB;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Te dejamos los detalles de tu sesión para que puedas prepararte con calma.&#847; &#847; &#847; &#847; &#847; &#847; &#847;</div>'

    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#EFE7DB;"><tr><td align="center" style="padding:40px 16px 48px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;">'

    // HEADER
    + '<tr><td align="center" style="background-color:#FDFBF7;border-radius:14px 14px 0 0;padding:30px 40px 26px;border-bottom:1px solid #E4DDD5;">'
    + '<p style="margin:0 0 4px;' + f2 + 'font-size:20px;font-weight:400;letter-spacing:0.03em;color:#231F1C;">Francisca Bustos</p>'
    + '<p style="margin:0;' + f1 + 'font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8A8178;">Psicología Perinatal</p>'
    + '</td></tr>'

    // BODY
    + '<tr><td style="background-color:#FDFBF7;">'

    // Saludo + título
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:34px 40px 0;">'
    + '<p style="margin:0 0 6px;' + f1 + 'font-size:15px;color:#5A534D;line-height:1.6;">Hola <strong style="color:#231F1C;font-weight:600;">' + primerNombre + '</strong>,</p>'
    + '<p style="margin:0 0 8px;' + f2 + 'font-size:22px;font-weight:400;color:#231F1C;line-height:1.25;letter-spacing:-0.01em;">Tu sesión es mañana.</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.6;">Te recordamos que mañana tienes tu sesión con Francisca Bustos.</p>'
    + '</td></tr></table>'

    // Hero — fecha / hora / modalidad
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:20px 40px 0;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#FAF6F0;border:1px solid #E4DDD5;border-radius:10px;">'
    + '<tr><td width="4" style="background-color:#8A5A6B;border-radius:10px 0 0 10px;font-size:0;line-height:0;width:4px;">&nbsp;</td>'
    + '<td style="padding:22px 22px 22px 20px;">'
    + '<p style="margin:0 0 7px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Tu próxima sesión</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:26px;font-weight:400;color:#231F1C;line-height:1.15;">' + fechaDM + '</p>'
    + '<p style="margin:0 0 16px;' + f2 + 'font-size:18px;font-weight:400;color:#5A534D;line-height:1.25;">' + hora + '</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="background-color:#EFE7DB;border-radius:20px;padding:5px 14px;">'
    + '<span style="' + f1 + 'font-size:11px;font-weight:500;color:#5A534D;">' + modalidad + '</span>'
    + '</td></tr></table>'
    + '</td></tr></table></td></tr></table>'

    // Enlace Meet (condicional) + divider integrado
    + meetBlock

    // Divider post-hero (solo si no hay Meet; si hay Meet, meetBlock ya lo incluye)
    + (meetLink ? '' : div)

    // Detalles de la sesión
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Detalles de tu sesión</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Servicio</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + servicio + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Modalidad</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + modalidad + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Fecha</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + fechaL + '</td></tr>'
    + '<tr><td style="padding:6px 16px 6px 0;' + f1 + 'font-size:13px;color:#8A8178;width:110px;white-space:nowrap;">Hora</td>'
    + '<td style="padding:6px 0;' + f1 + 'font-size:13px;color:#231F1C;font-weight:500;">' + hora + '</td></tr>'
    + '</table></td></tr></table>'

    + div

    // Antes de la sesión
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 9px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A5A6B;">Antes de la sesión</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.7;">Para que puedas prepararte con calma, te recomendamos elegir un espacio tranquilo, con la mayor privacidad posible, y tener a mano cualquier antecedente, duda o tema que quieras conversar durante la sesión.</p>'
    + '</td></tr></table>'

    + div

    // Cambios o cancelaciones
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:22px 40px 0;">'
    + '<p style="margin:0 0 9px;' + f1 + 'font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#8A8178;">Cambios o cancelaciones</p>'
    + '<p style="margin:0;' + f1 + 'font-size:14px;color:#5A534D;line-height:1.7;">Si necesitas modificar o cancelar tu hora, puedes responder este correo o escribirnos a <a href="mailto:hola@franciscabustos.cl" style="color:#8A5A6B;text-decoration:underline;">hola@franciscabustos.cl</a> con la mayor anticipación posible.</p>'
    + '</td></tr></table>'

    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td height="28">&nbsp;</td></tr></table>'
    + '</td></tr>'

    // FOOTER
    + '<tr><td style="background-color:#FAF6F0;border-top:1px solid #C9A8B3;border-radius:0 0 14px 14px;">'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:26px 40px 28px;">'
    + '<p style="margin:0 0 18px;' + f1 + 'font-size:13px;color:#5A534D;line-height:1.6;">Gracias por confiar en este espacio.</p>'
    + '<p style="margin:0 0 2px;' + f2 + 'font-size:16px;font-weight:400;color:#231F1C;letter-spacing:0.01em;">Francisca Bustos</p>'
    + '<p style="margin:0 0 13px;' + f1 + 'font-size:10px;color:#8A8178;letter-spacing:0.08em;text-transform:uppercase;">Psicóloga Perinatal</p>'
    + '<p style="margin:0 0 22px;' + f1 + 'font-size:12px;color:#8A8178;line-height:1.8;">'
    + '<a href="https://www.franciscabustos.cl" style="color:#8A5A6B;text-decoration:none;font-weight:500;">www.franciscabustos.cl</a>'
    + '<span style="color:#C9A8B3;">&nbsp;·&nbsp;</span>'
    + '<a href="mailto:hola@franciscabustos.cl" style="color:#8A5A6B;text-decoration:none;font-weight:500;">hola@franciscabustos.cl</a>'
    + '</p>'
    + '<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="height:1px;background-color:#E4DDD5;font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    + '<p style="margin:14px 0 0;' + f1 + 'font-size:11px;color:#8A8178;line-height:1.5;">ID de reserva:&nbsp;<span style="font-family:\'Courier New\',Courier,monospace;letter-spacing:0.03em;">' + rid + '</span></p>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function sendReminders() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data  = sheet.getDataRange().getValues();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = tomorrow.toISOString().slice(0, 10);

    for (let i = 1; i < data.length; i++) {
      const row       = data[i];
      const email     = String(row[COL_EMAIL     - 1] || '');
      const nombre    = String(row[COL_NOMBRE    - 1] || 'Paciente');
      const fechaRaw  = row[COL_FECHA     - 1];
      const horaRaw   = row[COL_HORA      - 1];
      const reservaId = String(row[COL_RESERVA_ID - 1] || '');
      const servicio  = String(row[COL_SERVICIO  - 1] || '');
      const modalidad = String(row[COL_MODALIDAD - 1] || '');
      const meetLink  = String(row[COL_GOOGLE_MEET_LINK - 1] || '');

      const fechaNormalizada = _normalizeFechaForBackend_(fechaRaw);
      if (!fechaNormalizada || fechaNormalizada !== tomorrowISO) continue;
      if (!email) continue;

      // v17 FIX: solo enviar recordatorios a reservas activas.
      // Filas rescheduled / cancelled / sin status definido se omiten.
      const statusRaw = String(row[COL_STATUS - 1] || '').trim().toLowerCase();
      if (statusRaw && statusRaw !== STATUS_ACTIVE) {
        Logger.log('sendReminders: omitida fila ' + i + ' status=' + statusRaw + ' / ' + reservaId);
        continue;
      }

      const hora  = _normalizeHoraForBackend_(horaRaw);
      const fechas = _parseFechas(fechaRaw);

      try {
        const primerNombre = nombre.split(' ')[0] || nombre;
        const horaDisplay  = hora + ' h';

        // Extraer "6 de mayo" del texto largo para el hero del email
        var fechaDiaMes = fechas.fechaLarga;
        var diaMesMatch = _toSafeString_(fechas.fechaLarga).match(/(\d{1,2} de \w+)/i);
        if (diaMesMatch) fechaDiaMes = diaMesMatch[1];

        const subject = 'Recordatorio: tu sesión con Francisca es mañana a las ' + hora;

        // Fallback plain text estructurado
        const cuerpoPlano =
          'Hola ' + primerNombre + ',\n\n' +
          'Te recordamos que mañana tienes tu sesión con Francisca Bustos.\n\n' +
          'DETALLES DE TU SESIÓN\n' +
          '---------------------\n' +
          'Fecha:     ' + fechas.fechaLarga + '\n' +
          'Hora:      ' + horaDisplay + '\n' +
          (modalidad ? 'Modalidad: ' + modalidad + '\n' : '') +
          (servicio  ? 'Servicio:  ' + servicio  + '\n' : '') +
          (meetLink  ? '\nEnlace para conectarte:\n' + meetLink + '\n' : '') +
          '\nANTES DE LA SESIÓN\n' +
          '---------------------\n' +
          'Te recomendamos elegir un espacio tranquilo, con la mayor privacidad\n' +
          'posible, y tener a mano cualquier antecedente o tema que quieras\n' +
          'conversar durante la sesión.\n\n' +
          'CAMBIOS O CANCELACIONES\n' +
          '---------------------\n' +
          'Si necesitas modificar o cancelar tu hora, escríbenos a ' + FRANCISCA_EMAIL + '\n' +
          'con la mayor anticipación posible.\n\n' +
          'Gracias por confiar en este espacio.\n\n' +
          FRANCISCA_NAME + '\nPsicóloga Perinatal\n' + SITE_URL + '\n\n' +
          'ID de reserva: ' + reservaId;

        // HTML branded
        const htmlBody = _buildReminderEmailHtml_({
          primer_nombre:    primerNombre,
          fecha_larga:      fechas.fechaLarga,
          fecha_dia_mes:    fechaDiaMes,
          hora:             horaDisplay,
          modalidad:        modalidad || '—',
          servicio:         servicio  || '—',
          google_meet_link: meetLink,
          id_reserva:       reservaId,
        });

        _enviarCorreoGmail(email, subject, cuerpoPlano, htmlBody);
        Logger.log('Recordatorio enviado: ' + email + ' / ' + reservaId);
      } catch (err) {
        Logger.log('sendReminders error fila ' + i + ': ' + err);
      }
    }
  } catch (err) {
    Logger.log('sendReminders fatal: ' + err);
  }
}

// ---------------------------------------------------------------
// crearTriggerDiario — ejecutar UNA VEZ manualmente desde el editor
// ---------------------------------------------------------------
function crearTriggerDiario() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReminders')
    .timeBased().everyDays(1).atHour(8).create();
  Logger.log('Trigger diario creado: sendReminders a las 08:00');
}

// ---------------------------------------------------------------
// _testCalendar — función temporal para autorizar CalendarApp
// ---------------------------------------------------------------
function _testCalendar() {
  const cal = CalendarApp.getCalendarById('hola@franciscabustos.cl');
  Logger.log('Calendar OK: ' + cal.getName());
}

// ---------------------------------------------------------------
// _validarTelefono_ — valida que el teléfono tenga >= 9 dígitos.
// Acepta: +56 9 1234 5678, 912345678, (9)12345678, etc.
// Ignora +, espacios, guiones, paréntesis antes de contar.
// ---------------------------------------------------------------
function _validarTelefono_(telefonoRaw) {
  const digits = String(telefonoRaw || '').replace(/\D/g, '');
  return digits.length >= 9;
}

// ---------------------------------------------------------------
// createCalendarEventForReservation_ — helper central v12.
// Crea evento en Google Calendar usando Advanced Calendar API.
//
// POLÍTICA DE COMUNICACIÓN (v12):
//   El canal oficial al paciente es EXCLUSIVAMENTE el email corporativo
//   de Francisca Bustos. Google Calendar NO envía ninguna invitación.
//
// Para sesiones ONLINE:
//   - Crea Google Meet automáticamente (conferenceData).
//   - El Meet link se guarda y se envía por email corporativo.
//   - El paciente NO es agregado como attendee.
//   - sendUpdates: 'none' — sin invitaciones automáticas de Calendar.
//
// Para sesiones PRESENCIAL:
//   - Sin Meet.
//   - El paciente NO es agregado como attendee.
//   - sendUpdates: 'none'.
//
// PRIVACIDAD: título y descripción del evento son neutros.
// Los datos clínicos quedan SOLO en Sheet y email interno a Francisca.
//
// REQUISITO MANUAL (una sola vez):
//   Apps Script > Servicios > Google Calendar API > Agregar
//   Esto habilita el objeto Calendar.Events.insert() etc.
//
// params: { startTime: Date, endTime: Date, email: string, modalidad: string, manageToken?: string }
// returns: { eventId: string, googleMeetLink: string, calendarHtmlLink: string }
// ---------------------------------------------------------------
function createCalendarEventForReservation_(params) {
  const isOnline = (params.modalidad || '').toLowerCase() === 'online';

  // v17: descripción del evento incluye links internos de gestión para Francisca.
  // Estos links solo viven en el calendario privado de Francisca, no se exponen al paciente.
  var description = 'Sesión agendada con Francisca Bustos.';
  if (params.manageToken) {
    var tokenEnc = encodeURIComponent(params.manageToken);
    description +=
      '\n\n— GESTIÓN INTERNA (solo Francisca) —\n' +
      'Reagendar sesión:\n' + MANAGE_URL + '?token=' + tokenEnc + '&open=reschedule\n\n' +
      'Cancelar sesión:\n' + MANAGE_URL + '?token=' + tokenEnc + '&open=cancel\n\n' +
      'No reenviar al paciente.';
  }

  const eventResource = {
    summary:     'Sesión con Francisca Bustos',
    description: description,
    start: { dateTime: params.startTime.toISOString(), timeZone: TZ },
    end:   { dateTime: params.endTime.toISOString(),   timeZone: TZ },
    guestsCanModifyEvent:    false,
    guestsCanInviteOthers:   false,
    guestsCanSeeOtherGuests: false,
    // Sin attendees: el paciente NO recibe invitación automática de Google Calendar.
    // El Meet link llega por email corporativo transaccional.
  };

  if (isOnline) {
    eventResource.conferenceData = {
      createRequest: {
        requestId: Utilities.getUuid(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  // sendUpdates: 'none' — suprime completamente las notificaciones automáticas de Calendar.
  // El paciente no recibe: invitación, recordatorio de Calendar ni cancelación por este canal.
  const insertOptions = { sendUpdates: 'none' };
  if (isOnline) insertOptions.conferenceDataVersion = 1;

  // Web 04.4+: intentar Calendar Advanced API; si falla (no habilitado/sin scopes),
  // caer a CalendarApp como fallback robusto.
  let event;
  var _calEventCreated_ = false;
  try {
    if (typeof Calendar !== 'undefined' && Calendar.Events && typeof Calendar.Events.insert === 'function') {
      event = Calendar.Events.insert(eventResource, CALENDAR_ID, insertOptions);
      _calEventCreated_ = true;
    }
  } catch (_advCalErr_) {
    Logger.log('createCalendarEvent: Advanced API fallo (' + _advCalErr_ + '), usando CalendarApp fallback');
    _calEventCreated_ = false;
  }
  if (!_calEventCreated_) {
    var _calFB_ = CalendarApp.getCalendarById(CALENDAR_ID);
    var _evFB_  = _calFB_.createEvent(
      eventResource.summary,
      params.startTime,
      params.endTime,
      { description: eventResource.description || '' }
    );
    var _evId_ = _evFB_.getId().replace('@google.com','');
    event = { id: _evId_, htmlLink: 'https://calendar.google.com/calendar/event?eid=' + _evId_ };
    Logger.log('createCalendarEvent: fallback CalendarApp OK, eventId=' + _evId_);
  }

  let googleMeetLink     = '';
  const calendarHtmlLink = event.htmlLink || '';

  if (isOnline && event.conferenceData && event.conferenceData.entryPoints) {
    const videoEntry = (event.conferenceData.entryPoints || []).filter(function(ep) {
      return ep.entryPointType === 'video';
    })[0];
    if (videoEntry) googleMeetLink = videoEntry.uri || '';
  }

  const meetLinkCreated = isOnline && !!googleMeetLink;
  if (isOnline && !googleMeetLink) {
    Logger.log('[WARNING] createCalendarEventForReservation_: sesión online sin Meet link. eventId=' + (event.id || ''));
  }

  Logger.log('createCalendarEventForReservation_:'
    + ' calendarEventCreated=true'
    + ' isOnline=' + isOnline
    + ' eventId=' + (event.id || '')
    + ' meetLinkCreated=' + meetLinkCreated
    + ' calendarInviteSuppressed=true');

  return {
    eventId:          event.id          || '',
    googleMeetLink:   googleMeetLink,
    calendarHtmlLink: calendarHtmlLink,
  };
}



// =============================================================================
// v18 FLOW INTEGRATION - Implementacion final
// =============================================================================

/**
 * Parser flexible: JSON, x-www-form-urlencoded, parameter fallback.
 */
function _parsePostBodyFlex_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    var raw = e.postData.contents;
    var ct  = (e.postData.type || '').toLowerCase();
    if (ct.indexOf('application/json') !== -1 || raw.charAt(0) === '{' || raw.charAt(0) === '[') {
      try { return JSON.parse(raw); } catch (e1) {}
    }
    if (ct.indexOf('x-www-form-urlencoded') !== -1 || raw.indexOf('=') !== -1) {
      var out = {};
      raw.split('&').forEach(function(pair) {
        if (!pair) return;
        var idx = pair.indexOf('=');
        if (idx < 0) { out[decodeURIComponent(pair)] = ''; return; }
        var k = decodeURIComponent(pair.substring(0, idx).replace(/\+/g, ' '));
        var v = decodeURIComponent(pair.substring(idx + 1).replace(/\+/g, ' '));
        out[k] = v;
      });
      return out;
    }
    try { return JSON.parse(raw); } catch (e2) {}
  }
  if (e.parameter) {
    var p = {};
    Object.keys(e.parameter).forEach(function(k) { p[k] = e.parameter[k]; });
    return p;
  }
  return {};
}

/**
 * Lee config Flow desde Script Properties. Nunca loguea secretKey.
 */
function getFlowConfig_() {
  var props = PropertiesService.getScriptProperties();
  var apiKey    = props.getProperty('FLOW_API_KEY');
  var secretKey = props.getProperty('FLOW_SECRET_KEY');
  var env       = (props.getProperty('FLOW_ENV')      || '').toLowerCase();
  var baseUrl   = props.getProperty('FLOW_BASE_URL')  || '';
  // Web 04.9: fail-fast — no fallback a entornos no-productivos.
  if (!apiKey || !secretKey) throw new Error('FLOW_CREDENTIALS_MISSING');
  if (!env)     throw new Error('FLOW_ENV_MISSING');
  if (!baseUrl) throw new Error('FLOW_BASE_URL_MISSING');
  return { apiKey: apiKey, secretKey: secretKey, env: env, baseUrl: baseUrl };
}

/**
 * Firma Flow: keys alfabeticas + key+value concat + HMAC-SHA256 + hex lowercase.
 */
function signFlowParams_(params, secretKey) {
  var keys = Object.keys(params).sort();
  var toSign = '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (params[k] === null || params[k] === undefined) continue;
    toSign += k + params[k];
  }
  var raw = Utilities.computeHmacSha256Signature(toSign, secretKey);
  var hex = '';
  for (var j = 0; j < raw.length; j++) {
    var b = raw[j];
    if (b < 0) b += 256;
    var h = b.toString(16);
    if (h.length === 1) h = '0' + h;
    hex += h;
  }
  return hex;
}

/**
 * Request a Flow API. POST x-www-form-urlencoded para create.
 * GET con query params para getStatus.
 */
function flowRequest_(endpoint, params, method) {
  var cfg = getFlowConfig_();
  var full = {};
  Object.keys(params).forEach(function(k) { full[k] = params[k]; });
  full.apiKey = cfg.apiKey;
  var signature = signFlowParams_(full, cfg.secretKey);
  full.s = signature;
  var url = cfg.baseUrl + endpoint;
  var options = { muteHttpExceptions: true };
  if (method === 'GET') {
    var qs = Object.keys(full).map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(full[k]);
    }).join('&');
    url += '?' + qs;
    options.method = 'get';
  } else {
    options.method = 'post';
    options.contentType = 'application/x-www-form-urlencoded';
    options.payload = Object.keys(full).map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(full[k]);
    }).join('&');
  }
  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  Logger.log('flowRequest_ ' + method + ' ' + endpoint + ' status=' + code);
  if (code < 200 || code >= 300) {
    throw new Error('FLOW_API_ERROR_' + code + ': ' + body.substring(0, 240));
  }
  try { return JSON.parse(body); }
  catch (e) { throw new Error('FLOW_API_PARSE_ERROR: ' + body.substring(0, 200)); }
}

/**
 * Garantiza schema Sheet: agrega FLOW_HEADERS faltantes. Idempotente.
 * No reordena ni borra. Devuelve mapa {header: colIndex}.
 */
function ensureSheetSchema_() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var lastCol = sheet.getLastColumn();
  var headerRow = sheet.getRange(1, 1, 1, Math.max(lastCol, 16)).getValues()[0];
  var headers = headerRow.map(function(h) { return String(h || '').trim(); });
  var hasNamedHeaders = headers.some(function(h) { return h && h.length > 0; });

  var colMap = {};
  // 1) Conservar mapping crudo (header literal -> indice) para backwards compat.
  for (var i = 0; i < headers.length; i++) {
    if (headers[i]) colMap[headers[i]] = i + 1;
  }

  // 2) Web 04.4: resolver alias espanol/ingles -> canonical (ingles). Primer match gana.
  for (var j = 0; j < headers.length; j++) {
    var raw = headers[j];
    if (!raw) continue;
    var norm = _normalizeHeaderKey_(raw);
    if (!norm) continue;
    for (var canon in HEADER_ALIASES) {
      if (!HEADER_ALIASES.hasOwnProperty(canon)) continue;
      var aliases = HEADER_ALIASES[canon];
      if (aliases.indexOf(norm) === -1) continue;
      if (colMap[canon] && colMap[canon] !== (j + 1)) {
        Logger.log('ensureSheetSchema_: canonical "' + canon + '" ya mapeado a col '
          + colMap[canon] + '; ignorado header duplicado "' + raw + '" en col ' + (j + 1));
      } else if (!colMap[canon]) {
        colMap[canon] = j + 1;
      }
      break;
    }
  }

  // 3) Anadir FLOW_HEADERS faltantes (no reordena, no borra, no renombra).
  var nextCol = sheet.getLastColumn() + 1;
  var added = 0;
  FLOW_HEADERS.forEach(function(name) {
    if (!colMap[name]) {
      if (hasNamedHeaders) sheet.getRange(1, nextCol).setValue(name);
      colMap[name] = nextCol;
      nextCol++;
      added++;
    }
  });
  if (added > 0) Logger.log('ensureSheetSchema_: added ' + added + ' Flow headers');

  // 4) Reportar canonical resueltos (visibilidad operativa).
  var resolved = [];
  for (var k in HEADER_ALIASES) {
    if (HEADER_ALIASES.hasOwnProperty(k) && colMap[k]) {
      resolved.push(k + '=' + colMap[k]);
    }
  }
  Logger.log('ensureSheetSchema_: canonical resolved -> ' + resolved.join(', '));

  return colMap;
}

function _generateCommerceOrder_(date, time) {
  var dc = String(date).replace(/-/g, '');
  var tc = String(time).replace(/:/g, '');
  var rand = String(Math.floor(Math.random() * 9000) + 1000);
  return 'FB-' + dc + '-' + tc + '-' + rand;
}

function _generatePublicStatusToken_() {
  return Utilities.getUuid();
}

/**
 * doCreateFlowPayment: valida + crea orden Flow + guarda Sheet PENDING.
 * NO crea Calendar. NO envia emails.
 */
function doCreateFlowPayment(e, incoming) {
  try {
    var body = incoming || _parsePostBodyFlex_(e);
    var name      = String(body.name || '').trim();
    var email     = String(body.email || '').trim();
    var phone     = String(body.phone || '').trim();
    var rut       = String(body.patientRut || '').trim();
    var service   = String(body.serviceType || '').trim().toLowerCase();
    var modality  = String(body.modality || '').trim();
    var date      = _normalizeFechaForBackend_(body.date);
    var time      = _normalizeHoraForBackend_(body.time);
    var reason    = String(body.reason || '').trim();
    var message   = String(body.message || '').trim();

    if (!name || !email) {
      return _jsonOut({ ok: false, code: 'MISSING_REQUIRED', message: 'Nombre y email son obligatorios.', backendVersion: BACKEND_VERSION });
    }
    // Web 04.11: phone obligatorio (campo vacio)
    if (!phone) {
      return _jsonOut({ ok: false, code: 'PHONE_REQUIRED', message: 'Telefono es obligatorio.', backendVersion: BACKEND_VERSION });
    }
    if (!_validarTelefono_(phone)) {
      return _jsonOut({ ok: false, code: 'INVALID_PHONE', message: 'Telefono invalido. Minimo 9 digitos.', backendVersion: BACKEND_VERSION });
    }
    // Web 04.11: RUT paciente obligatorio (campo vacio) para emision de boleta
    if (!rut) {
      return _jsonOut({ ok: false, code: 'PATIENT_RUT_REQUIRED', message: 'RUT del paciente es obligatorio para emision de boleta.', backendVersion: BACKEND_VERSION });
    }
    // Web 04.11b: validacion modulo 11 backend (defense in depth).
    // Acepta con/sin puntos, con/sin guion, K mayuscula o minuscula.
    if (!_validarRutChileno_(rut)) {
      return _jsonOut({ ok: false, code: 'INVALID_PATIENT_RUT', message: 'Ingresa un RUT valido para emision de boleta.', backendVersion: BACKEND_VERSION });
    }
    if (!date || !time) {
      return _jsonOut({ ok: false, code: 'INVALID_DATETIME', message: 'Fecha u hora invalida.', backendVersion: BACKEND_VERSION });
    }
    // Modalidad exclusiva: la atencion se realiza solo online.
    var modalityLower = String(modality || '').trim().toLowerCase();
    if (modalityLower !== 'online') {
      return _jsonOut({
        ok: false,
        code: 'ONLINE_ONLY',
        message: 'La atencion se realiza exclusivamente online.',
        backendVersion: BACKEND_VERSION
      });
    }

    // Server-side recalcula precio
    var amount, subject;
    if (service === SERVICE_INITIAL || service === 'primera' || service === 'evaluacion' || service === 'inicial') {
      amount = PRICE_INITIAL_CLP; subject = FLOW_SUBJECT_INITIAL; service = SERVICE_INITIAL;
    } else if (service === SERVICE_FOLLOWUP || service === 'seguimiento') {
      amount = PRICE_FOLLOWUP_CLP; subject = FLOW_SUBJECT_FOLLOWUP; service = SERVICE_FOLLOWUP;
    } else {
      return _jsonOut({ ok: false, code: 'INVALID_SERVICE', message: 'Servicio no permitido.', backendVersion: BACKEND_VERSION });
    }

    // Validar slot Calendar
    var range = _buildDateRange(date, time);
    if (!range) return _jsonOut({ ok: false, code: 'INVALID_DATETIME', message: 'Fecha/hora invalida.', backendVersion: BACKEND_VERSION });
    var cal = CalendarApp.getCalendarById(CALENDAR_ID);
    var conflicts = cal.getEvents(range.startTime, range.endTime);
    if (conflicts.length > 0) {
      return _jsonOut({ ok: false, code: 'SLOT_TAKEN', message: 'Este horario ya no esta disponible.', backendVersion: BACKEND_VERSION });
    }

    var reservationId   = _generateReservationId();
    var commerceOrder   = _generateCommerceOrder_(date, time);
    var publicStatusTok = _generatePublicStatusToken_();
    var manageToken     = Utilities.getUuid();

    var colMap = ensureSheetSchema_();
    var schemaMissing = _validateSchemaRequired_(colMap);
    if (schemaMissing.length > 0) {
      Logger.log('doCreateFlowPayment SHEET_SCHEMA_MISSING_REQUIRED_HEADERS: ' + schemaMissing.join(','));
      return _jsonOut({
        ok: false,
        code: 'SHEET_SCHEMA_MISSING_REQUIRED_HEADERS',
        missing: schemaMissing,
        message: 'La Sheet no expone headers requeridos: ' + schemaMissing.join(', ') + '.',
        backendVersion: BACKEND_VERSION
      });
    }
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);

    // Web 04.2 P0-03: construir fila robusta segun colMap (no orden fijo).
    // Soporta headers en ingles o espanol. Cualquier columna extra no listada
    // se respeta como vacia. No reordena, no borra columnas, no rompe historicos.
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) lastCol = 1;
    var row = new Array(lastCol);
    for (var ri = 0; ri < lastCol; ri++) row[ri] = '';

    function setByColMap_(candidates, value) {
      for (var i = 0; i < candidates.length; i++) {
        var col = colMap[candidates[i]];
        if (col && col >= 1 && col <= lastCol) {
          row[col - 1] = value;
          return true;
        }
      }
      return false;
    }

    // --- columnas base (legacy puede estar en espanol) ---
    setByColMap_(['timestamp', 'fecha_creacion', 'createdAt'], new Date());
    setByColMap_(['phone', 'telefono'], phone || '');
    setByColMap_(['email', 'correo'], email || '');
    setByColMap_(['service', 'servicio'], service || '');
    setByColMap_(['modality', 'modalidad'], modality || '');
    setByColMap_(['date', 'fecha'], date || '');
    setByColMap_(['time', 'hora'], time || '');
    setByColMap_(['message', 'motivo', 'reason'], reason || message || '');
    setByColMap_(['reservationId', 'reserva_id'], reservationId);
    setByColMap_(['name', 'nombre'], name || '');
    setByColMap_(['manageToken'], manageToken);
    setByColMap_(['status', 'estado'], STATUS_PENDING_PAYMENT);

    // --- columnas Flow (FLOW_HEADERS en ingles, garantizadas por ensureSheetSchema_) ---
    setByColMap_(['commerceOrder'],     commerceOrder);
    setByColMap_(['flowOrder', 'flowPaymentId'], '');
    setByColMap_(['flowToken'],         '');
    setByColMap_(['priceClp', 'amount'], amount);
    setByColMap_(['paidAt'],            '');
    setByColMap_(['rawFlowStatus'],     '');
    setByColMap_(['serviceType'],       service);
    setByColMap_(['patientRut'],        rut || '');
    setByColMap_(['paymentUrl'],        '');
    setByColMap_(['publicStatusToken'], publicStatusTok);
    setByColMap_(['calendarCreated'],   false);
    setByColMap_(['emailPatientSent'],  false);
    setByColMap_(['emailInternalSent'], false);
    setByColMap_(['emailPatientSentAt'],  '');
    setByColMap_(['emailInternalSentAt'], '');
    setByColMap_(['paymentExpiresAt'],  new Date(Date.now() + 60 * 60 * 1000).toISOString());
    setByColMap_(['reviewReason'],      '');

    sheet.appendRow(row);

    var props = PropertiesService.getScriptProperties();
    var webAppUrl = props.getProperty('WEB_APP_URL') || '';
    var publicReturnUrl = props.getProperty('PUBLIC_RETURN_URL') || 'https://franciscabustos.cl/pago-resultado';
    if (!webAppUrl) {
      return _jsonOut({ ok: false, code: 'CONFIG_MISSING', message: 'WEB_APP_URL no configurada.', backendVersion: BACKEND_VERSION });
    }

    // Web 04.5 — Flow urlConfirmation 302 fix.
    // FLOW_WEBHOOK_URL Script Property points to a Cloudflare Pages Function proxy
    // (functions/api/flow-confirmation.js) that forwards the webhook to Apps Script
    // and returns HTTP 200 to Flow. Apps Script Web Apps always respond 302 to the
    // first POST hit on /macros/s/.../exec; Flow does not follow redirects and treats
    // the 302 as a webhook failure.
    // Fallback: if FLOW_WEBHOOK_URL is unset, behavior is identical to pre-04.5
    // (direct Apps Script URL — still returns 302, but no functional regression).
    var webhookUrl = props.getProperty('FLOW_WEBHOOK_URL') || (webAppUrl + '?action=flow_confirmation');

    var flowResp;
    try {
      flowResp = flowRequest_('/payment/create', {
        commerceOrder:   commerceOrder,
        subject:         subject,
        currency:        'CLP',
        amount:          amount,
        email:           email,
        urlConfirmation: webhookUrl,
        urlReturn:       publicReturnUrl + '?st=' + encodeURIComponent(publicStatusTok),
        optional: JSON.stringify({
          reservationId: reservationId,
          serviceType:   service,
          patientRut:    rut,
          date:          date,
          time:          time,
          commerceOrder: commerceOrder
        })
      }, 'POST');
    } catch (err) {
      Logger.log('doCreateFlowPayment Flow error: ' + err);
      _updateRowByCommerceOrder_(commerceOrder, { rawFlowStatus: 'create_error:' + String(err).substring(0, 80) });
      return _jsonOut({ ok: false, code: 'FLOW_CREATE_FAILED', message: 'No pudimos iniciar el pago. Intenta nuevamente.', backendVersion: BACKEND_VERSION });
    }

    if (!flowResp || !flowResp.url || !flowResp.token) {
      return _jsonOut({ ok: false, code: 'FLOW_CREATE_FAILED', message: 'Respuesta Flow incompleta.', backendVersion: BACKEND_VERSION });
    }

    var paymentUrl = flowResp.url + '?token=' + flowResp.token;
    _updateRowByCommerceOrder_(commerceOrder, {
      flowToken:  flowResp.token,
      flowOrder:  flowResp.flowOrder || '',
      paymentUrl: paymentUrl
    });

    return _jsonOut({
      ok: true,
      reservationId:     reservationId,
      commerceOrder:     commerceOrder,
      publicStatusToken: publicStatusTok,
      paymentUrl:        paymentUrl,
      amount:            amount,
      backendVersion:    BACKEND_VERSION
    });
  } catch (err) {
    Logger.log('doCreateFlowPayment fatal: ' + err);
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'No pudimos iniciar el pago.', backendVersion: BACKEND_VERSION });
  }
}

/**
 * doFlowConfirmation: webhook. LockService + idempotente.
 */
function doFlowConfirmation(e) {
  var lock = LockService.getScriptLock();
  var gotLock = false;
  try {
    try { lock.waitLock(10000); gotLock = true; } catch (lerr) {
      Logger.log('doFlowConfirmation lock timeout');
      return _jsonOut({ ok: true, note: 'lock_busy_will_retry' });
    }
    var body = _parsePostBodyFlex_(e);
    var token = String(body.token || (e.parameter && e.parameter.token) || '').trim();
    if (!token) return _jsonOut({ ok: false, error: 'token_missing' });

    var statusResp;
    try {
      statusResp = flowRequest_('/payment/getStatus', { token: token }, 'GET');
    } catch (err) {
      Logger.log('doFlowConfirmation getStatus error: ' + err);
      return _jsonOut({ ok: false, error: 'status_query_failed' });
    }

    var commerceOrder = statusResp.commerceOrder;
    var flowStatus    = statusResp.status;
    if (!commerceOrder) return _jsonOut({ ok: false, error: 'no_commerce_order_in_response' });

    var found = _findRowByCommerceOrder_(commerceOrder);
    if (!found) {
      Logger.log('doFlowConfirmation: commerceOrder not found ' + commerceOrder);
      return _jsonOut({ ok: true, note: 'order_not_found_ack' });
    }

    if (found.flowToken && found.flowToken !== token) {
      Logger.log('doFlowConfirmation token mismatch ' + commerceOrder);
      return _jsonOut({ ok: false, error: 'token_mismatch' });
    }

    if (found.status === STATUS_PAID_CONFIRMED && flowStatus === 2) {
      return _jsonOut({ ok: true, idempotent: true });
    }

    if (flowStatus === 2) {
      _confirmReservationAfterPayment_(found, statusResp);
      return _jsonOut({ ok: true, confirmed: true });
    } else if (flowStatus === 3 || flowStatus === 4) {
      _updateRowByCommerceOrder_(commerceOrder, {
        status: STATUS_PAYMENT_REJECTED,
        rawFlowStatus: 'flow_status_' + flowStatus
      });
      return _jsonOut({ ok: true, rejected: true });
    } else {
      _updateRowByCommerceOrder_(commerceOrder, { rawFlowStatus: 'flow_status_' + flowStatus });
      return _jsonOut({ ok: true, pending: true });
    }
  } catch (err) {
    Logger.log('doFlowConfirmation fatal: ' + err);
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'Error interno.' });
  } finally {
    if (gotLock) try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * Confirma post-pago: revalida slot, crea Calendar, emails.
 */
function _confirmReservationAfterPayment_(found, flowStatusResp) {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var colMap = ensureSheetSchema_();
  var rowVals = sheet.getRange(found.rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (rowVals[COL_STATUS - 1] === STATUS_PAID_CONFIRMED) return;

  try {
    var range = _buildDateRange(found.fecha, found.hora);
    if (range) {
      var cal = CalendarApp.getCalendarById(CALENDAR_ID);
      var conflicts = cal.getEvents(range.startTime, range.endTime);
      if (conflicts.length > 0) {
        sheet.getRange(found.rowIndex, COL_STATUS).setValue(STATUS_PAYMENT_REVIEW);
        if (colMap.reviewReason) sheet.getRange(found.rowIndex, colMap.reviewReason).setValue('slot_taken_after_payment');
        if (colMap.rawFlowStatus) sheet.getRange(found.rowIndex, colMap.rawFlowStatus).setValue('paid_but_slot_taken');
        _enviarAlertaInterna_(found, 'Pago recibido pero slot ya ocupado');
        return;
      }
    }

    var calendarEventId = rowVals[COL_CALENDAR_EVENT_ID - 1];
    var meetLink = rowVals[COL_GOOGLE_MEET_LINK - 1];
    var calendarCreatedFlag = colMap.calendarCreated ? rowVals[colMap.calendarCreated - 1] : false;

    if (!calendarEventId && !calendarCreatedFlag) {
      var calResult = createCalendarEventForReservation_({
        startTime:   range.startTime,
        endTime:     range.endTime,
        email:       found.email,
        modalidad:   found.modalidad,
        manageToken: found.manageToken
      });
      calendarEventId = calResult.eventId;
      meetLink = calResult.googleMeetLink;
      sheet.getRange(found.rowIndex, COL_CALENDAR_EVENT_ID).setValue(calendarEventId);
      sheet.getRange(found.rowIndex, COL_GOOGLE_MEET_LINK).setValue(meetLink || '');
      if (colMap.calendarCreated) sheet.getRange(found.rowIndex, colMap.calendarCreated).setValue(true);
    }

    sheet.getRange(found.rowIndex, COL_STATUS).setValue(STATUS_PAID_CONFIRMED);
    if (colMap.paidAt) sheet.getRange(found.rowIndex, colMap.paidAt).setValue(new Date().toISOString());
    if (colMap.reviewReason) sheet.getRange(found.rowIndex, colMap.reviewReason).setValue('');
    if (colMap.rawFlowStatus) sheet.getRange(found.rowIndex, colMap.rawFlowStatus).setValue('paid_confirmed');

    var emailPatientSentFlag  = colMap.emailPatientSent  ? rowVals[colMap.emailPatientSent - 1]  : false;
    var emailInternalSentFlag = colMap.emailInternalSent ? rowVals[colMap.emailInternalSent - 1] : false;

    if (!emailPatientSentFlag || !emailInternalSentFlag) {
      var emailData = {
        nombre: found.nombre,
        email: found.email,
        telefono: found.telefono,
        servicio: found.servicio,
        modalidad: found.modalidad,
        fecha: found.fecha,
        hora: found.hora,
        motivo: found.motivo,
        reservaId: found.reservaId,
        googleMeetLink: meetLink,
        calendarEventId: calendarEventId,
        manageToken: found.manageToken,
        emailContext: EMAIL_CONTEXT_INITIAL,
        amount_paid:    _getMontoForServicio_(found.servicio),
        commerce_order: found.commerceOrder
      };
      var emailResult = _enviarCorreos(emailData);
      if (emailResult && emailResult.emailPatientSent && colMap.emailPatientSent) {
        sheet.getRange(found.rowIndex, colMap.emailPatientSent).setValue(true);
        if (colMap.emailPatientSentAt) sheet.getRange(found.rowIndex, colMap.emailPatientSentAt).setValue(new Date().toISOString());
      }
      if (emailResult && emailResult.emailInternalSent && colMap.emailInternalSent) {
        sheet.getRange(found.rowIndex, colMap.emailInternalSent).setValue(true);
        if (colMap.emailInternalSentAt) sheet.getRange(found.rowIndex, colMap.emailInternalSentAt).setValue(new Date().toISOString());
      }
    }
  } catch (err) {
    Logger.log('_confirmReservationAfterPayment_ error: ' + err);
    try {
      sheet.getRange(found.rowIndex, COL_STATUS).setValue(STATUS_PAYMENT_REVIEW);
      if (colMap.reviewReason) sheet.getRange(found.rowIndex, colMap.reviewReason).setValue('confirm_error: ' + String(err).substring(0, 120));
    } catch (e) {}
  }
}

function _enviarAlertaInterna_(found, reason) {
  try {
    var subject = '[Atencion] ' + reason + ' - ' + (found.nombre || 'paciente') + ' - ' + (found.fecha || '') + ' ' + (found.hora || '');
    var body = 'Alerta operativa de franciscabustos.cl\n\n' +
               'Motivo: ' + reason + '\n\n' +
               'Paciente: ' + (found.nombre || '') + ' (' + (found.email || '') + ')\n' +
               'Telefono: ' + (found.telefono || '') + '\n' +
               'Servicio: ' + (found.servicio || '') + '\n' +
               'Fecha/hora: ' + (found.fecha || '') + ' ' + (found.hora || '') + '\n' +
               'ID reserva: ' + (found.reservaId || '') + '\n' +
               'commerceOrder: ' + (found.commerceOrder || '') + '\n\n' +
               'Revisar manualmente en Sheet y contactar al paciente.';
    GmailApp.sendEmail(FRANCISCA_EMAIL, subject, body);
  } catch (e) {
    Logger.log('_enviarAlertaInterna_ error: ' + e);
  }
}

/**
 * doFlowPaymentStatus: consulta por publicStatusToken (no enumerable).
 * NO expone PII ni flowToken ni email.
 */
function doFlowPaymentStatus(e) {
  try {
    var st = String((e.parameter && e.parameter.st) || '').trim();
    if (!st) return _jsonOut({ ok: false, error: 'token_missing' });
    var colMap = ensureSheetSchema_();
    if (!colMap.publicStatusToken) return _jsonOut({ ok: false, error: 'schema_missing' });
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowSt = String(data[i][colMap.publicStatusToken - 1] || '').trim();
      if (rowSt === st) {
        var status = String(data[i][COL_STATUS - 1] || '').trim();
        var reviewReason = colMap.reviewReason ? String(data[i][colMap.reviewReason - 1] || '') : '';
        return _jsonOut({ ok: true, status: status, backendVersion: BACKEND_VERSION });
      }
    }
    return _jsonOut({ ok: false, error: 'not_found' });
  } catch (err) {
    Logger.log('doFlowPaymentStatus error: ' + err);
    return _jsonOut({ ok: false, code: 'SERVER_ERROR', message: 'Error interno.' });
  }
}

function _findRowByCommerceOrder_(commerceOrder) {
  if (!commerceOrder) return null;
  var colMap = ensureSheetSchema_();
  if (!colMap.commerceOrder) return null;
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][colMap.commerceOrder - 1] || '').trim() === commerceOrder) {
      var row = data[i];
      // Web 04.4: preferir canonical colMap (resuelve aliases ES/EN) y caer a COL_* legacy.
      function _pick_(canonical, legacyCol) {
        var idx = colMap[canonical] ? colMap[canonical] : legacyCol;
        return (idx && idx >= 1) ? row[idx - 1] : '';
      }
      return {
        rowIndex:      i + 1,
        commerceOrder: row[colMap.commerceOrder - 1],
        flowOrder:     colMap.flowOrder ? row[colMap.flowOrder - 1] : '',
        flowToken:     colMap.flowToken ? row[colMap.flowToken - 1] : '',
        status:        _pick_('status',        COL_STATUS),
        email:         _pick_('email',         COL_EMAIL),
        nombre:        _pick_('name',          COL_NOMBRE),
        telefono:      _pick_('phone',         COL_TELEFONO),
        servicio:      _pick_('service',       COL_SERVICIO),
        modalidad:     _pick_('modality',      COL_MODALIDAD),
        fecha:         _pick_('date',          COL_FECHA),
        hora:          _pick_('time',          COL_HORA),
        motivo:        _pick_('message',       COL_MOTIVO),
        reservaId:     _pick_('reservationId', COL_RESERVA_ID),
        manageToken:   _pick_('manageToken',   COL_MANAGE_TOKEN)
      };
    }
  }
  return null;
}

function _updateRowByCommerceOrder_(commerceOrder, updates) {
  var found = _findRowByCommerceOrder_(commerceOrder);
  if (!found) return false;
  var colMap = ensureSheetSchema_();
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  Object.keys(updates).forEach(function(k) {
    var col = colMap[k];
    if (k === 'status') col = COL_STATUS;
    if (k === 'calendarEventId') col = COL_CALENDAR_EVENT_ID;
    if (k === 'googleMeetLink') col = COL_GOOGLE_MEET_LINK;
    if (col) sheet.getRange(found.rowIndex, col).setValue(updates[k]);
  });
  return true;
}

// Web 04.4 deploy - backup removed
// Web 04.9 production cutover: _setSandboxReturnUrl_() helper removed.
// PUBLIC_RETURN_URL and FLOW_WEBHOOK_URL must be set manually on the
// production Script Properties (one-time, via Apps Script editor UI).


// FIX 2026-06-12 (GO Vic): la disponibilidad web ahora refleja la duracion completa de los eventos y los eventos de dia completo. Call-site: doGet -> _jsonOut(_getBookedSlotsFromCalendarV2()). Reemplaza a _getBookedSlotsFromCalendar (solo bloqueaba la hora de inicio).
function _getBookedSlotsFromCalendarV2() { var cal = CalendarApp.getCalendarById(CALENDAR_ID); var desde = new Date(); var hasta = new Date(); hasta.setDate(desde.getDate() + DIAS_ANTICIPACION); var events = cal.getEvents(desde, hasta); var slots = []; var HORAS = ['10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00']; for (var i = 0; i < events.length; i++) { var ev = events[i]; if (ev.isAllDayEvent()) { var d = new Date(ev.getAllDayStartDate()); var fin = new Date(ev.getAllDayEndDate()); while (d < fin) { var f = Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); for (var j = 0; j < HORAS.length; j++) { slots.push({ fecha: f, hora: HORAS[j] }); } d.setDate(d.getDate() + 1); } continue; } var st = ev.getStartTime(); var en = ev.getEndTime(); var cursor = new Date(st); cursor.setMinutes(0, 0, 0); while (cursor < en) { var hh = Utilities.formatDate(cursor, TZ, 'HH:mm'); if (HORAS.indexOf(hh) !== -1) { slots.push({ fecha: Utilities.formatDate(cursor, TZ, 'yyyy-MM-dd'), hora: hh }); } cursor.setHours(cursor.getHours() + 1); } } return slots; }
