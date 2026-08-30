// ============================================================
// BOOKING FLOW — 7 steps, state machine with live summary
// v19 PRODUCTION (Web 04.9 cutover): Flow API integration.
// Promoted from the Web 04.x preview track; all preview URLs scrubbed.
// ============================================================
(function () {
  const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const DAYS_FULL = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  // Same-origin booking boundary. The Worker keeps the upstream private.
  const BOOKING_API = Object.freeze({
    availability: '/api/availability',
    createFlowPayment: '/api/create-flow-payment',
  });

  const state = {
    step: 1,
    service: null,
    modality: { value: "online", label: "Online" },
    date: null,       // Date object
    time: null,       // "10:00"
    form: {},
    reservationId: null,
    confirmation: null,
    idempotencyKey: null,
  };

  const BOOKING_CALENDAR_CONFIG = Object.freeze({
    timeZone: "America/Santiago",
    leadMinutes: 120,
    // Mantener esta lista alineada con manage.html hasta moverla a una configuración compartida en fase posterior.
    holidays: [
      "2026-01-01","2026-04-03","2026-04-04","2026-05-01","2026-05-21",
      "2026-06-29","2026-07-16","2026-08-15","2026-09-18","2026-09-19",
      "2026-10-12","2026-10-31","2026-11-01","2026-12-08","2026-12-25",
      "2027-01-01","2027-04-02","2027-04-03","2027-05-01","2027-05-21",
      "2027-06-28","2027-07-16","2027-08-15","2027-09-18","2027-09-19",
      "2027-10-12","2027-10-30","2027-11-01","2027-12-08","2027-12-25"
    ],
    hours: ["10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"],
  });
  const BOOKING_TIME_ZONE = BOOKING_CALENDAR_CONFIG.timeZone;
  const MIN_BOOKING_LEAD_MINUTES = BOOKING_CALENDAR_CONFIG.leadMinutes;
  const HOLIDAYS_CL = new Set(BOOKING_CALENDAR_CONFIG.holidays);
  const SLOTS_WEEKDAY = BOOKING_CALENDAR_CONFIG.hours.slice();

  // bookedSlots: [{ fecha: "YYYY-MM-DD", hora: "HH:MM" }, ...]
  let bookedSlots = [];
  let slotsLoaded = false;

  async function fetchBookedSlots() {
    try {
      const resp = await fetch(BOOKING_API.availability, { method: 'GET', cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        bookedSlots = data && data.ok && Array.isArray(data.slots)
          ? data.slots.map(function (slot) { return { date: slot.date || slot.fecha || '', time: slot.time || slot.hora || '' }; })
          : [];
      }
    } catch (_) {}
    slotsLoaded = true;
    // Re-render calendar/slots si ya están visibles
    if (state.step === 3) renderCalendar();
    if (state.step === 4) renderSlots();
  }
  fetchBookedSlots();

  const stage = document.getElementById("bk-stage");
  const summary = document.getElementById("bk-summary");

  // Limpiar validación personalizada del teléfono cuando el usuario edita el campo.
  // Evita que el tooltip de error quede pegado después de corregir.
  const _phoneInputEl = document.getElementById("f-phone");
  if (_phoneInputEl) {
    _phoneInputEl.addEventListener("input", function() {
      _phoneInputEl.setCustomValidity("");
    });
  }

  // ------- Autoavance: helper centralizado -------
  // Cancela timers anteriores para evitar dobles saltos.
  // Solo se usa en pasos 1-4 (selección simple).
  let pendingAdvance = null;

  function scheduleAdvance(nextStep, delay) {
    delay = delay !== undefined ? delay : 140;
    if (pendingAdvance) {
      clearTimeout(pendingAdvance);
      pendingAdvance = null;
    }
    pendingAdvance = window.setTimeout(function () {
      pendingAdvance = null;
      go(nextStep);
    }, delay);
  }

  function cancelScheduledAdvance() {
    if (pendingAdvance) {
      clearTimeout(pendingAdvance);
      pendingAdvance = null;
    }
  }

  // ------- Step 1: Service -------
  // Usamos pointerdown en el label contenedor porque ese evento dispara ANTES que change.
  // click en el input llega DESPUÉS del change cuando el input está dentro de un label.
  let serviceClickedByPointer = false;

  stage.querySelectorAll('input[name="service"]').forEach(inp => {
    const labelService = inp.closest('label') || inp.parentElement;
    labelService.addEventListener("pointerdown", () => {
      serviceClickedByPointer = true;
    });
    inp.addEventListener("change", () => {
      state.service = {
        value: inp.value,
        label: inp.dataset.label,
        duration: inp.dataset.duration,
        price: inp.dataset.price,
      };
      enableNext(1);
      updateSummary();
      if (serviceClickedByPointer) {
        serviceClickedByPointer = false;
        scheduleAdvance(2);
      }
    });
  });

  // ------- Step 2: modalidad online -------
  let modalityClickedByPointer = false;

  stage.querySelectorAll('input[name="modality"]').forEach(inp => {
    const labelModality = inp.closest('label') || inp.parentElement;
    labelModality.addEventListener("pointerdown", () => {
      modalityClickedByPointer = true;
    });
    inp.addEventListener("change", () => {
      const previousValue = state.modality && state.modality.value;
      state.modality = { value: inp.value, label: inp.dataset.label };
      if (previousValue && previousValue !== inp.value) {
        state.date = null;
        state.time = null;
      }
      enableNext(2);
      updateSummary();
      if (modalityClickedByPointer) {
        modalityClickedByPointer = false;
        scheduleAdvance(3);
      }
    });
  });
  // La única modalidad publicada es online, por lo que el paso queda listo
  // sin requerir una interacción adicional de la persona usuaria.
  enableNext(2);

  // ------- Web 04.11: helpers para RUT chileno (validación módulo 11) -------
  function cleanRut(rut) {
    return String(rut || '').replace(/[\s.\-]/g, '').toUpperCase();
  }
  function isValidChileanRut(rut) {
    const clean = cleanRut(rut);
    if (clean.length < 2 || clean.length > 9) return false;
    const body = clean.slice(0, -1);
    const dv = clean.slice(-1);
    if (!/^\d+$/.test(body)) return false;
    if (!/^[\dK]$/.test(dv)) return false;
    if (body.length < 7) return false; // bloquea RUTs claramente inválidos (<1.000.000)
    let sum = 0;
    let mul = 2;
    for (let i = body.length - 1; i >= 0; i--) {
      sum += parseInt(body[i], 10) * mul;
      mul = mul === 7 ? 2 : mul + 1;
    }
    const mod = 11 - (sum % 11);
    let expected;
    if (mod === 11) expected = '0';
    else if (mod === 10) expected = 'K';
    else expected = String(mod);
    return dv === expected;
  }
  function formatRut(rut) {
    const clean = cleanRut(rut);
    if (clean.length < 2) return rut;
    const body = clean.slice(0, -1);
    const dv = clean.slice(-1);
    let formatted = '';
    for (let i = 0; i < body.length; i++) {
      if (i > 0 && (body.length - i) % 3 === 0) formatted += '.';
      formatted += body[i];
    }
    return formatted + '-' + dv;
  }
  // Limpiar validity custom del RUT cuando el usuario edita
  const _rutInputEl = document.getElementById("f-rut");
  if (_rutInputEl) {
    _rutInputEl.addEventListener("input", function() {
      _rutInputEl.setCustomValidity("");
    });
  }

  // ------- Step 3: Calendar -------
  let calYear, calMonth;
  const santiagoNowFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function getSantiagoNowParts() {
    const parts = {};
    santiagoNowFormatter.formatToParts(new Date()).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    };
  }

  function dateKeyFromNumbers(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function dateKeyFromDate(date) {
    return dateKeyFromNumbers(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  function getSantiagoTodayKey() {
    const now = getSantiagoNowParts();
    return dateKeyFromNumbers(now.year, now.month, now.day);
  }

  function normalizeSlotHour(value) {
    return String(value || "").replace(" h", "").trim();
  }

  function minBookableHour() {
    const now = getSantiagoNowParts();
    const nowMins = now.hour * 60 + now.minute;
    return Math.ceil((nowMins + MIN_BOOKING_LEAD_MINUTES) / 60);
  }

  function isSlotTooSoon(dateObj, hourStr) {
    if (dateKeyFromDate(dateObj) !== getSantiagoTodayKey()) return false;
    const hh = parseInt(hourStr.split(":")[0], 10);
    return hh < minBookableHour();
  }

  const todayParts = getSantiagoNowParts();
  const today = new Date(todayParts.year, todayParts.month - 1, todayParts.day);
  today.setHours(0,0,0,0);
  calYear = today.getFullYear();
  calMonth = today.getMonth();

  // Disponibilidad real: L-V 10:00–18:00 (sin sábado ni domingo).
  // El calendario es único: cualquier slot ocupado en Calendar bloquea
  // las reservas online.
  function availabilityFor(date) {
    const d = new Date(date);
    const iso = dateKeyFromDate(d);
    const todayIso = getSantiagoTodayKey();
    if (iso < todayIso) return "past";
    const dow = d.getDay(); // 0=dom, 6=sab
    if (dow === 0 || dow === 6) return "none"; // fin de semana cerrado
    if (HOLIDAYS_CL.has(iso)) return "none";

    if (!slotsLoaded) return "loading";

    // Bloqueo real basado en Calendar (bookedSlots viene del doGet)
    const takenHours = bookedSlots
      .filter(b => (b.date || b.fecha) === iso)
      .map(b => normalizeSlotHour(b.time || b.hora));
    const remaining = SLOTS_WEEKDAY.filter((hour) => !takenHours.includes(hour) && !isSlotTooSoon(d, hour));
    if (remaining.length === 0) return "none";
    if (remaining.length === 1) return "few";
    return "avail";
  }

  function renderCalendar() {
    const grid = document.getElementById("cal-grid");
    const monthEl = document.getElementById("cal-month");
    monthEl.textContent = `${MONTHS[calMonth]} ${calYear}`;
    grid.innerHTML = "";

    const first = new Date(calYear, calMonth, 1);
    const firstDow = (first.getDay() + 6) % 7; // lunes primero
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

    for (let i = 0; i < firstDow; i++) {
      const b = document.createElement("button");
      b.className = "bk-day"; b.dataset.state = "empty"; b.disabled = true;
      grid.appendChild(b);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(calYear, calMonth, d);
      const iso = dateKeyFromDate(date);
      const state_ = availabilityFor(date);
      const btn = document.createElement("button");
      btn.className = "bk-day";
      btn.textContent = d;
      btn.dataset.state = state_;
      btn.dataset.iso = iso;
      if (iso === getSantiagoTodayKey()) btn.classList.add("today");
      if (state_ === "past" || state_ === "none" || state_ === "empty" || state_ === "loading") btn.disabled = true;
      if (state.date && iso === dateKeyFromDate(state.date)) btn.classList.add("selected");
      btn.addEventListener("click", () => {
        state.date = date;
        state.time = null;
        renderCalendar();
        enableNext(3);
        updateSummary();
        scheduleAdvance(4); // autoavance al paso de horario
      });
      grid.appendChild(btn);
    }
  }
  document.getElementById("cal-prev").addEventListener("click", () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar();
  });

  function renderSlots() {
    const host = document.getElementById("bk-slots");
    host.innerHTML = "";
    if (!state.date || !slotsLoaded) return;
    const subtitle = document.getElementById("bk-time-subtitle");
    const dow = state.date.getDay();
    subtitle.innerHTML = `Horas disponibles para <strong>${DAYS_FULL[dow]} ${state.date.getDate()} de ${MONTHS[state.date.getMonth()].toLowerCase()}</strong> · horario 10:00 a 18:00. Zona horaria Santiago de Chile (GMT-3).`;

    const iso = dateKeyFromDate(state.date);
    const takenHours = bookedSlots
      .filter(b => (b.date || b.fecha) === iso)
      .map(b => normalizeSlotHour(b.time || b.hora));

    // Si todos los slots están ocupados o pasaron, no quedan horarios visibles.
    const renderable = SLOTS_WEEKDAY.filter(s => !takenHours.includes(s) && !isSlotTooSoon(state.date, s));
    if (renderable.length === 0) {
      const msg = document.createElement("p");
      msg.className = "bk-slot-msg";
      msg.style.cssText = "font-size:14px;color:var(--ink-2,#5A534D);line-height:1.6;padding:16px 18px;background:#FAF6F0;border:1px solid var(--line,#E5DED1);border-radius:8px;margin:0;";
      msg.textContent = "No hay horarios disponibles para esta fecha. Puedes elegir otro día.";
      host.appendChild(msg);
      return;
    }

    SLOTS_WEEKDAY.forEach((s) => {
      const taken = takenHours.includes(s);
      const tooSoon = isSlotTooSoon(state.date, s);
      const btn = document.createElement("button");
      btn.className = "bk-slot"; btn.textContent = s;
      if (taken || tooSoon) { btn.disabled = true; btn.classList.add("taken"); }
      if (state.time === s) btn.classList.add("selected");
      btn.addEventListener("click", () => {
        state.time = s;
        renderSlots();
        enableNext(4);
        updateSummary();
        scheduleAdvance(5); // autoavance al formulario de datos
      });
      host.appendChild(btn);
    });
  }

  // ------- Step 5: captura formulario -------
  // Web 04.11: RUT y Teléfono ahora obligatorios. RUT con validación módulo 11.
  function captureForm() {
    const f = document.getElementById("bk-form");
    const fd = new FormData(f);
    const phoneRaw    = fd.get("phone") || "";
    const phoneDigits = phoneRaw.replace(/\D/g, "");
    const phoneEl     = document.getElementById("f-phone");
    const rutRaw      = fd.get("patient_rut") || "";
    const rutEl       = document.getElementById("f-rut");
    const nameEl      = document.getElementById("f-name");
    const emailEl     = document.getElementById("f-email");

    // Limpiar validity previo en todos los campos relevantes
    if (phoneEl) phoneEl.setCustomValidity("");
    if (rutEl)   rutEl.setCustomValidity("");
    if (nameEl)  nameEl.setCustomValidity("");
    if (emailEl) emailEl.setCustomValidity("");

    state.form = {
      name:             fd.get("name"),
      email:            fd.get("email"),
      phone:            phoneRaw,
      patientRut:       rutRaw,
      motivo_principal: fd.get("motivo_principal") || "",
      reason:           fd.get("reason") || "",
    };
    // A changed form is a new booking attempt. Retries from step 6 retain the
    // same opaque key and cannot derive an identity from patient data.
    state.idempotencyKey = null;

    const nameVal  = (state.form.name  || "").trim();
    const emailVal = (state.form.email || "").trim();
    const phoneTrimmed = String(phoneRaw).trim();
    const rutTrimmed   = String(rutRaw).trim();
    let hasError = false;

    if (!nameVal) {
      if (nameEl) nameEl.setCustomValidity("Completa tu nombre.");
      hasError = true;
    }
    if (!emailVal) {
      if (emailEl) emailEl.setCustomValidity("Completa tu correo.");
      hasError = true;
    }
    // Teléfono: obligatorio + mínimo 9 dígitos
    if (!phoneTrimmed) {
      if (phoneEl) phoneEl.setCustomValidity("Ingresa un teléfono de contacto.");
      hasError = true;
    } else if (phoneDigits.length < 9) {
      if (phoneEl) phoneEl.setCustomValidity("Ingresa un teléfono válido con al menos 9 números.");
      hasError = true;
    }
    // RUT: obligatorio + validación módulo 11 (acepta con/sin puntos o guion)
    if (!rutTrimmed) {
      if (rutEl) rutEl.setCustomValidity("Ingresa un RUT válido para emisión de boleta.");
      hasError = true;
    } else if (!isValidChileanRut(rutTrimmed)) {
      if (rutEl) rutEl.setCustomValidity("Ingresa un RUT válido para emisión de boleta.");
      hasError = true;
    }

    if (hasError) return false;
    return f.checkValidity();
  }

  function submitFormStep() {
    cancelScheduledAdvance();
    if (!captureForm()) {
      document.getElementById("bk-form").reportValidity();
      return false;
    }
    go(6);
    return true;
  }

  // ------- Actions -------
  stage.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      cancelScheduledAdvance(); // cancelar cualquier avance pendiente al actuar manualmente
      const a = btn.dataset.action;
      if (a === "next") {
        go(state.step + 1);
      }
      else if (a === "prev") go(state.step - 1);
      else if (a === "submit-form") {
        submitFormStep();
      } else if (a === "confirm") {
        await confirmReservation(btn);
      } else if (a === "restart") {
        Object.assign(state, { step: 1, service: null, modality: null, date: null, time: null, form: {}, reservationId: null, confirmation: null, idempotencyKey: null });
        document.querySelectorAll('input[name="service"], input[name="modality"]').forEach(i => i.checked = false);
        document.getElementById("bk-form").reset();
        go(1);
      }
    });
  });

  // ------- v18 Flow integration: crea orden Flow + redirige a checkout -------
  function bookingIdempotencyKey() {
    if (state.idempotencyKey) return state.idempotencyKey;
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
      throw new Error('No pudimos preparar esta reserva de forma segura. Recarga la página e inténtalo nuevamente.');
    }
    state.idempotencyKey = 'fran-nonprod-20260821-' + window.crypto.randomUUID();
    return state.idempotencyKey;
  }

  async function confirmReservation(btn) {
    const statusEl = document.getElementById("bk-confirm-status");

    btn.disabled = true;
    btn.innerHTML = 'Conectando con Flow…';
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = 'form-status is-loading';
      statusEl.textContent = 'Conectando con el sistema de pago seguro…';
    }

    // Server-side serviceType: 'initial' o 'followup'
    const serviceType = (state.service && state.service.value === 'primera') ? 'initial' : 'followup';

    const fechaISO = dateKeyFromDate(state.date);
    const horaISO  = (state.time || '').toString();

    // Web 04.11: RUT obligatorio (ya validado en captureForm con dígito verificador).
    // Enviamos el formato canónico con puntos y guion: 12.345.678-9.
    const rutEl = document.getElementById('f-rut');
    const rutRawForSend = rutEl ? (rutEl.value || '').trim() : '';
    const patientRut = rutRawForSend && isValidChileanRut(rutRawForSend)
      ? formatRut(rutRawForSend)
      : rutRawForSend;

    const motivoParts = [
      state.form.motivo_principal,
      state.form.reason,
    ].map(s => (s || '').trim()).filter(s => s.length > 0);

    const payload = {
      idempotencyKey: bookingIdempotencyKey(),
      serviceType: serviceType,
      modality:    state.modality && state.modality.value ? state.modality.value : '',
      date:        fechaISO,
      time:        horaISO,
      name:        state.form.name,
      email:       state.form.email,
      phone:       state.form.phone,
      patientRut:  patientRut,
      reason:      motivoParts.join(' — '),
      message:     state.form.reason || '',
    };

    // Funnel event only: no name, email, phone, RUT, free text or token.
    if (typeof window.fbTrack === 'function') {
      window.fbTrack('payment_started', {
        service_type: serviceType,
        modality: state.modality && state.modality.value ? state.modality.value : 'online'
      });
    }

    try {
      const resp = await fetch(BOOKING_API.createFlowPayment, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await resp.json().catch(() => ({}));

      if (!resp.ok || !result.ok || !result.paymentUrl || !result.publicStatusToken) {
        const code = result.code || '';
        let msg;
        if (code === 'SLOT_TAKEN')         msg = 'Ese horario ya fue reservado. Elige otro para continuar.';
        else if (code === 'INVALID_PHONE') msg = 'Ingresa un teléfono válido con al menos 9 números.';
        else if (code === 'PHONE_REQUIRED') msg = 'Ingresa un teléfono de contacto.';
        else if (code === 'PATIENT_RUT_REQUIRED') msg = 'Ingresa tu RUT para emisión de boleta.';
        else if (code === 'INVALID_PATIENT_RUT')  msg = 'Ingresa un RUT válido para emisión de boleta.';
        else if (code === 'ONLINE_ONLY') msg = 'La atención se realiza exclusivamente online.';
        else if (code === 'INVALID_SERVICE') msg = 'Servicio no válido. Recarga la página.';
        else if (code === 'INVALID_DATETIME') msg = 'Fecha u hora inválida. Vuelve a elegir.';
        else if (code === 'MISSING_REQUIRED') msg = result.message || 'Completa nombre y correo.';
        else if (code === 'FLOW_CREATE_FAILED') msg = 'No pudimos iniciar el pago en Flow. Revisa tus datos o intenta nuevamente en unos minutos.';
        else if (code === 'CONFIG_MISSING') msg = 'Configuración pendiente. Contáctanos por WhatsApp.';
        else if (code === 'SERVER_ERROR')   msg = 'Tuvimos un problema en el servidor. Intenta nuevamente o escríbenos.';
        else msg = result.message || result.error || 'No pudimos iniciar el pago. Intenta nuevamente.';

        if (statusEl) {
          statusEl.hidden = false;
          statusEl.className = 'form-status is-err';
          statusEl.textContent = msg;
        }
        btn.disabled = false;
        btn.innerHTML = 'Reintentar pago <span class="arrow">→</span>';

        if (code === 'SLOT_TAKEN') {
          // Forzar volver al paso de hora
          setTimeout(() => go(4), 1500);
        } else if (code === 'PATIENT_RUT_REQUIRED' || code === 'INVALID_PATIENT_RUT' || code === 'PHONE_REQUIRED') {
          // Volver al formulario de datos
          setTimeout(() => go(5), 1200);
        }
        return;
      }

      // Guardar publicStatusToken para la página de retorno
      state.publicStatusTok  = result.publicStatusToken;
      try {
        sessionStorage.setItem('fb_last_status_token', result.publicStatusToken || '');
      } catch (_) {}

      // Bloquear slot localmente
      bookedSlots.push({ fecha: dateKeyFromDate(state.date), hora: state.time });

      if (statusEl) {
        statusEl.className = 'form-status is-loading';
        statusEl.textContent = 'Redirigiendo al pago seguro…';
      }
      window.location.href = result.paymentUrl;
    } catch (err) {
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.className = 'form-status is-err';
        statusEl.textContent = (err && err.message) ? err.message : 'No pudimos conectar con el sistema de pago. Intenta nuevamente.';
      }
      btn.disabled = false;
      btn.innerHTML = 'Reintentar <span class="arrow">→</span>';
    }
  }

  function enableNext(stepNum) {
    const btn = stage.querySelector(`.bk-step[data-step="${stepNum}"] [data-action="next"]`);
    if (btn) btn.disabled = false;
  }

  function go(n) {
    cancelScheduledAdvance(); // cancelar timers al navegar manualmente
    if (n < 1 || n > 7) return;
    state.step = n;
    stage.querySelectorAll(".bk-step").forEach(sec => {
      sec.hidden = Number(sec.dataset.step) !== n;
    });
    if (n === 3) renderCalendar();
    if (n === 4) renderSlots();
    if (n === 6) fillReview();
    if (n === 7) fillSuccess();
    // Ocultar resumen en paso 7
    summary.style.display = n === 7 ? "none" : "";
    // Scroll suave al inicio del formulario
    stage.scrollIntoView ? window.scrollTo({ top: stage.offsetTop - 120, behavior: "smooth" }) : null;
    // Mover el foco al primer control interactivo del paso (accesibilidad)
    // No enfocamos <h2> para evitar el focus-ring visual que parece "texto seleccionado"
    const currentStep = stage.querySelector(`.bk-step[data-step="${n}"]`);
    if (currentStep) {
      const focusTarget = currentStep.querySelector('input, button, select, textarea');
      if (focusTarget) {
        window.setTimeout(() => focusTarget.focus(), 0);
      }
    }
  }

  // ------- Live summary -------
  function updateSummary() {
    const set = (field, val, empty) => {
      const el = summary.querySelector(`[data-field="${field}"]`);
      if (!el) return;
      el.textContent = val || empty || "Por elegir";
      el.classList.toggle("empty", !val);
    };
    set("service", state.service && state.service.label);
    set("modality", state.modality && state.modality.label);
    if (state.date) {
      set("date", state.date.toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" }));
    } else { set("date", null); }
    set("time", state.time);
    set("duration", state.service && state.service.duration, "—");
    set("price", state.service && state.service.price, "—");
  }
  updateSummary();

  // ------- Review -------
  function fmtDate(d) {
    return d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  function fillReview() {
    const id = "FB-" + (Math.floor(Math.random() * 90000) + 10000);
    state.reservationId = state.reservationId || id;
    document.getElementById("rv-id").textContent = state.reservationId;
    document.getElementById("rv-service").textContent = state.service.label;
    document.getElementById("rv-mod").textContent = state.modality.label;
    document.getElementById("rv-date").textContent = fmtDate(state.date);
    document.getElementById("rv-time").textContent = state.time + " h";
    document.getElementById("rv-dur").textContent = state.service.duration;
    document.getElementById("rv-price").textContent = state.service.price;
    document.getElementById("rv-name").textContent = state.form.name;
    document.getElementById("rv-email").textContent = state.form.email;
    document.getElementById("rv-phone").textContent = state.form.phone;
    // Web 04.12: mostrar RUT del paciente en el resumen (formato canónico
    // si pasa validación módulo 11; en caso contrario, raw — captureForm()
    // ya impidió llegar hasta acá con un RUT inválido).
    const rutReviewEl = document.getElementById("rv-rut");
    if (rutReviewEl) {
      const rutRaw = (state.form.patientRut || "").trim();
      rutReviewEl.textContent = rutRaw
        ? (isValidChileanRut(rutRaw) ? formatRut(rutRaw) : rutRaw)
        : "—";
    }
    document.getElementById("rv-reason").textContent = state.form.reason;
  }

  function fillSuccess() {
    const firstName = (state.form.name || "").split(" ")[0] || "—";
    const when = state.date.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" }) + ` a las ${state.time}`;
    const confirmation = state.confirmation || {};
    const emailPatientSent = confirmation.emailPatientSent !== false;
    const emailMessageEl = document.getElementById("sx-email-message");
    document.getElementById("sx-name").textContent = firstName;
    document.getElementById("sx-when").textContent = `el ${when}`;
    document.getElementById("sx-channel").textContent = "link seguro de la sesión";
    document.getElementById("sx-date").textContent = state.date.toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" });
    document.getElementById("sx-time").textContent = state.time + " h";
    document.getElementById("sx-mod").textContent = state.modality.label;
    document.getElementById("sx-id").textContent = state.reservationId;
    if (emailMessageEl) {
      emailMessageEl.textContent = emailPatientSent
        ? 'Te envié un email con los detalles de tu reserva, el '
        : 'Tu reserva quedó agendada, pero hubo un problema al enviar el email. Si no lo recibes, escríbenos por WhatsApp o a hola@franciscabustos.cl para reenviarlo. Allí encontrarás el ';
    }

    // Email mock
    document.getElementById("em-name").textContent = firstName;
    document.getElementById("em-service").textContent = state.service.label;
    document.getElementById("em-when").textContent = fmtDate(state.date) + ` · ${state.time} h`;
    document.getElementById("em-mod").textContent = state.modality.label;
    document.getElementById("em-dur").textContent = state.service.duration;
    document.getElementById("em-price").textContent = state.service.price;
    document.getElementById("em-id").textContent = state.reservationId;
  }

  // Expose minimal API for the form submit button
  window.BK = {
    next: () => go(state.step + 1),
    submitForm: submitFormStep,
  };

  // Pre-fill servicio desde query param (?servicio=...)
  const params = new URLSearchParams(location.search);
  const svcParam = params.get("servicio");
  const SVC_MAP = { ansiedad: "primera", depresion: "primera", adaptacion: "primera", duelo: "duelo", vinculo: "vinculo", acompanamiento: "primera" };
  if (svcParam && SVC_MAP[svcParam]) {
    const target = document.querySelector(`input[name="service"][value="${SVC_MAP[svcParam]}"]`);
    // dispatchEvent sin autoavance (no hubo click del usuario)
    if (target) { target.checked = true; target.dispatchEvent(new Event("change")); }
  }

  // Init
  go(1);
})();
