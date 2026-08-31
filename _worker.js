/**
 * _worker.js — Francisca Bustos · Cloudflare Pages Worker
 * ============================================================
 * Production same-origin route boundary:
 *   - Browser booking traffic is same-origin only.
 *   - APPS_SCRIPT_WEB_APP_URL is REQUIRED and never returned to a client.
 *   - Booking/payment routes fail closed unless APP_ENV is exactly production.
 *   - /backend/* explicitly returns 404 (defense in depth — should also
 *     be excluded at deploy artifact level via wrangler/build).
 *   - Management routes are same-origin proxies with server-side capability
 *     validation; their responses contain no patient/clinical PII.
 *   - /pago-resultado POST → 303 GET preserved (Flow urlReturn).
 *   - Missing APPS_SCRIPT_WEB_APP_URL returns 503 (NOT 200) so monitoring
 *     can detect misconfiguration immediately.
 *
 * Required Cloudflare Pages Production environment variables:
 *   APP_ENV = production
 *   APPS_SCRIPT_WEB_APP_URL = set privately to the Production Web App
 *
 * This worker supersedes functions/api/flow-confirmation.js. When _worker.js
 * is present, Cloudflare Pages ignores the functions/ directory entirely.
 */

const RESP_HEADERS_TEXT = { 'content-type': 'text/plain; charset=utf-8' };
const RESP_HEADERS_JSON = { 'content-type': 'application/json; charset=utf-8' };

function textOk()       { return new Response('OK',  { status: 200, headers: RESP_HEADERS_TEXT }); }
function textBad(r, s)  { return new Response(r,     { status: s,   headers: RESP_HEADERS_TEXT }); }
function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: RESP_HEADERS_JSON
  });
}

function productionUpstream(env) {
  if (!env || env.APP_ENV !== 'production') {
    return { error: 'environment_not_configured', status: 503 };
  }
  const target = env.APPS_SCRIPT_WEB_APP_URL;
  if (!target) return { error: 'upstream_not_configured', status: 503 };
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
      return { error: 'upstream_rejected', status: 503 };
    }
  } catch (_) {
    return { error: 'upstream_rejected', status: 503 };
  }
  return { target: target };
}

function disabledProductionFeature() {
  return jsonResp({ ok: false, code: 'feature_disabled' }, 503);
}

function safeAvailability(data) {
  const slots = Array.isArray(data) ? data : (data && Array.isArray(data.slots) ? data.slots : null);
  if (!slots) return null;
  return slots.filter((slot) => slot && typeof slot.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(slot.date)
    && typeof slot.time === 'string' && /^\d{2}:\d{2}$/.test(slot.time))
    .map((slot) => ({ date: slot.date, time: slot.time }));
}

async function readJsonResponse(upstream) {
  let text;
  try { text = await upstream.text(); } catch (_) { return null; }
  try { return JSON.parse(text); } catch (_) { return null; }
}

// --- /api/availability ---------------------------------------------------
async function handleAvailability(request, env) {
  if (request.method !== 'GET') return textBad('method_not_allowed', 405);
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return jsonResp({ ok: false, code: upstreamConfig.error }, upstreamConfig.status);

  const date = new URL(request.url).searchParams.get('date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResp({ ok: false, code: 'bad_request' }, 400);
  const query = '?action=availability' + (date ? '&date=' + encodeURIComponent(date) : '');
  let upstream;
  try {
    upstream = await fetch(upstreamConfig.target + query, { method: 'GET', redirect: 'follow', cf: { cacheTtl: 0, cacheEverything: false } });
  } catch (_) {
    console.error('[availability] upstream unavailable');
    return jsonResp({ ok: false, code: 'upstream_unreachable' }, 502);
  }
  if (!upstream.ok) return jsonResp({ ok: false, code: 'upstream_error' }, 502);
  const slots = safeAvailability(await readJsonResponse(upstream));
  if (!slots) return jsonResp({ ok: false, code: 'upstream_bad_response' }, 502);
  return jsonResp({ ok: true, slots: slots }, 200);
}

const CREATE_FIELDS = new Set(['idempotencyKey', 'serviceType', 'modality', 'date', 'time', 'name', 'email', 'phone', 'patientRut', 'reason', 'message']);

function validCreatePayload(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !CREATE_FIELDS.has(key))) return null;
  const payload = {};
  for (const key of CREATE_FIELDS) {
    const field = value[key] == null ? '' : String(value[key]).trim();
    if (field.length > 500) return null;
    payload[key] = field;
  }
  if (!/^fran-booking-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.idempotencyKey)
      || !/^(initial|followup)$/.test(payload.serviceType) || !/^(online|presencial)$/.test(payload.modality)
      || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)
      || !/^\d{2}:\d{2}$/.test(payload.time) || !payload.name || payload.name.length > 80
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return null;
  return payload;
}

// --- /api/create-flow-payment -------------------------------------------
async function handleCreateFlowPayment(request, env) {
  if (request.method !== 'POST') return textBad('method_not_allowed', 405);
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return jsonResp({ ok: false, code: upstreamConfig.error }, upstreamConfig.status);

  let candidate;
  try { candidate = await request.json(); } catch (_) { return jsonResp({ ok: false, code: 'bad_request' }, 400); }
  const payload = validCreatePayload(candidate);
  if (!payload) return jsonResp({ ok: false, code: 'bad_request' }, 400);

  let upstream;
  try {
    upstream = await fetch(upstreamConfig.target + '?action=create_flow_payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create_flow_payment', ...payload }),
      redirect: 'follow',
    });
  } catch (_) {
    console.error('[create-flow-payment] upstream unavailable');
    return jsonResp({ ok: false, code: 'upstream_unreachable' }, 502);
  }
  if (!upstream.ok) return jsonResp({ ok: false, code: 'upstream_error' }, 502);
  const data = await readJsonResponse(upstream);
  if (!data || typeof data !== 'object') return jsonResp({ ok: false, code: 'upstream_bad_response' }, 502);
  if (!data.ok) return jsonResp({ ok: false, code: typeof data.code === 'string' ? data.code : 'payment_rejected' }, 200);
  // A checkout redirect is a required payment-provider handoff, not an Apps
  // Script upstream URL. It is restricted to Flow Production (www.flow.cl) in this environment.
  if (typeof data.paymentUrl !== 'string') return jsonResp({ ok: false, code: 'upstream_bad_response' }, 502);
  try {
    const checkout = new URL(data.paymentUrl);
    if (checkout.protocol !== 'https:' || checkout.hostname !== 'www.flow.cl') throw new Error('rejected');
  } catch (_) {
    return jsonResp({ ok: false, code: 'checkout_rejected' }, 502);
  }
  if (typeof data.publicStatusToken !== 'string' || !/^fran-booking-st-[0-9a-f]{32}$/i.test(data.publicStatusToken)) {
    return jsonResp({ ok: false, code: 'upstream_bad_response' }, 502);
  }
  return jsonResp({ ok: true, paymentUrl: data.paymentUrl, publicStatusToken: data.publicStatusToken }, 200);
}

async function handleRetryFlowPayment(request, env) {
  if (request.method !== 'POST') return textBad('method_not_allowed', 405);
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return jsonResp({ ok: false, code: upstreamConfig.error }, upstreamConfig.status);
  let candidate;
  try { candidate = await request.json(); } catch (_) { return jsonResp({ ok: false, code: 'bad_request' }, 400); }
  const st = candidate && typeof candidate.st === 'string' ? candidate.st.trim() : '';
  if (!/^fran-booking-st-[0-9a-f]{32}$/i.test(st)) return jsonResp({ ok: false, code: 'bad_request' }, 400);
  let upstream;
  try {
    upstream = await fetch(upstreamConfig.target + '?action=retry_flow_payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry_flow_payment', st: st }),
      redirect: 'follow',
    });
  } catch (_) {
    return jsonResp({ ok: false, code: 'upstream_unreachable' }, 502);
  }
  if (!upstream.ok) return jsonResp({ ok: false, code: 'upstream_error' }, 502);
  const data = await readJsonResponse(upstream);
  if (!data || typeof data !== 'object') return jsonResp({ ok: false, code: 'upstream_bad_response' }, 502);
  if (!data.ok) return jsonResp({ ok: false, code: typeof data.code === 'string' ? data.code : 'payment_rejected' }, 200);
  if (typeof data.paymentUrl !== 'string') return jsonResp({ ok: false, code: 'upstream_bad_response' }, 502);
  try {
    const checkout = new URL(data.paymentUrl);
    if (checkout.protocol !== 'https:' || checkout.hostname !== 'www.flow.cl') throw new Error('rejected');
  } catch (_) {
    return jsonResp({ ok: false, code: 'checkout_rejected' }, 502);
  }
  return jsonResp({ ok: true, paymentUrl: data.paymentUrl, publicStatusToken: typeof data.publicStatusToken === 'string' ? data.publicStatusToken : st }, 200);
}

// --- /api/flow-confirmation ----------------------------------------------
// Flow.cl webhook target. Forwards POST application/x-www-form-urlencoded
// to Apps Script, follows the 302 redirect internally, returns 200 OK plain
// text to Flow. Idempotency is enforced server-side (LockService + flags).
async function handleFlowConfirmation(request, env) {
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return textBad(upstreamConfig.error, upstreamConfig.status);
  if (request.method === 'GET') {
    return new Response('flow-confirmation proxy alive\n', { status: 200, headers: RESP_HEADERS_TEXT });
  }
  if (request.method !== 'POST') {
    return textBad('method_not_allowed', 405);
  }

  let body;
  try { body = await request.text(); } catch (e) {
    console.error('[flow-confirmation] body read failed');
    return textBad('bad_request', 400);
  }
  const incomingCT = request.headers.get('content-type') || 'application/x-www-form-urlencoded';

  let upstream;
  try {
    upstream = await fetch(upstreamConfig.target + '?action=flow_confirmation', {
      method: 'POST',
      headers: { 'content-type': incomingCT },
      body: body,
      redirect: 'follow'
    });
  } catch (err) {
    console.error('[flow-confirmation] upstream fetch failed');
    return textBad('upstream_unreachable', 502);
  }

  if (!upstream.ok) {
    console.error('[flow-confirmation] upstream non-2xx status=' + upstream.status);
    return textBad('upstream_error', 502);
  }
  try { await upstream.text(); } catch (_) { /* drain */ }
  return textOk();
}

// --- /api/payment-status -------------------------------------------------
// Proxy for pago-resultado.html polling. Forwards GET ?st=<publicStatusToken>
// to Apps Script payment_status action. This proxy also applies a defensive
// no-PII allowlist before returning JSON to the browser.
async function handlePaymentStatus(request, env) {
  if (request.method !== 'GET') {
    return textBad('method_not_allowed', 405);
  }

  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return jsonResp({ ok: false, code: upstreamConfig.error }, upstreamConfig.status);

  const incomingUrl = new URL(request.url);
  const st = incomingUrl.searchParams.get('st');
  if (!st || !/^[A-Za-z0-9._~-]{20,300}$/.test(st)) {
    return jsonResp({ ok: false, code: 'MISSING_STATUS_TOKEN' }, 400);
  }

  let upstream;
  try {
    upstream = await fetch(upstreamConfig.target + '?action=payment_status&st=' + encodeURIComponent(st), {
      method: 'GET',
      redirect: 'follow',
      cf: { cacheTtl: 0, cacheEverything: false }
    });
  } catch (err) {
    console.error('[payment-status] upstream fetch failed');
    return jsonResp({ ok: false, code: 'UPSTREAM_UNREACHABLE' }, 502);
  }

  if (!upstream.ok) {
    console.error('[payment-status] upstream non-2xx status=' + upstream.status);
    return jsonResp({ ok: false, code: 'UPSTREAM_ERROR' }, 502);
  }

  let bodyText;
  try { bodyText = await upstream.text(); } catch (_) {
    return jsonResp({ ok: false, code: 'UPSTREAM_BAD_RESPONSE' }, 502);
  }

  let data;
  try { data = JSON.parse(bodyText); } catch (_) {
    return jsonResp({ ok: false, code: 'UPSTREAM_BAD_JSON' }, 502);
  }

  // Defensive no-PII allowlist. Never forward publicStatusToken, Flow token,
  // patient identifiers, contact data, clinical notes, or Meet links.
  const safeBody = data && data.ok ? {
    ok: true,
    status: data.status || '',
    amount: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
    currency: data.currency === 'CLP' ? 'CLP' : '',
    serviceType: data.serviceType || '',
    modality: data.modality || '',
    backendVersion: data.backendVersion || '',
    retryAvailable: data.retryAvailable === true,
    holdValid: data.holdValid === true
  } : {
    ok: false,
    code: data && data.code ? data.code : '',
    backendVersion: data && data.backendVersion ? data.backendVersion : ''
  };

  return new Response(JSON.stringify(safeBody), {
    status: 200,
    headers: { ...RESP_HEADERS_JSON, 'cache-control': 'no-store' }
  });
}

function safeManagementResponse(data) {
  if (!data || typeof data !== 'object') return { ok: false, code: 'upstream_bad_response' };
  if (!data.ok) return { ok: false, code: typeof data.code === 'string' ? data.code : 'management_rejected' };
  return { ok: true, status: typeof data.status === 'string' ? data.status : '',
    date: typeof data.date === 'string' ? data.date : '', time: typeof data.time === 'string' ? data.time : '',
    serviceType: typeof data.serviceType === 'string' ? data.serviceType : '', modality: typeof data.modality === 'string' ? data.modality : '',
    originalStart: typeof data.originalStart === 'string' ? data.originalStart : '', currentStart: typeof data.currentStart === 'string' ? data.currentStart : '',
    currentEnd: typeof data.currentEnd === 'string' ? data.currentEnd : '', meetUrl: typeof data.meetUrl === 'string' ? data.meetUrl : '',
    capabilityType: data.capabilityType === 'RESCHEDULE' || data.capabilityType === 'CANCEL' ? data.capabilityType : '' };
}

async function handleManageLookup(request, env) {
  if (request.method !== 'POST') return textBad('method_not_allowed', 405);
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return jsonResp({ ok: false, code: upstreamConfig.error }, upstreamConfig.status);
  let payload;
  try { payload = await request.json(); } catch (_) { return jsonResp({ ok: false, code: 'bad_request' }, 400); }
  if (!payload || payload.action !== 'manage' || typeof payload.token !== 'string' || !/^[A-Za-z0-9_-]{64,256}$/.test(payload.token)) {
    return jsonResp({ ok: false, code: 'bad_request' }, 400);
  }
  let upstream;
  try { upstream = await fetch(upstreamConfig.target + '?action=manage_lookup', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'manage_lookup', token: payload.token }), redirect: 'follow' }); }
  catch (_) { return jsonResp({ ok: false, code: 'upstream_unreachable' }, 502); }
  if (!upstream.ok) return jsonResp({ ok: false, code: 'upstream_error' }, 502);
  return jsonResp(safeManagementResponse(await readJsonResponse(upstream)), 200);
}

async function handleManageCancel(request, env) {
  if (request.method !== 'POST') return textBad('method_not_allowed', 405);
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return jsonResp({ ok: false, code: upstreamConfig.error }, upstreamConfig.status);
  let payload;
  try { payload = await request.json(); } catch (_) { return jsonResp({ ok: false, code: 'bad_request' }, 400); }
  if (!payload || payload.action !== 'cancel_confirm' || typeof payload.token !== 'string' || !/^[A-Za-z0-9_-]{64,256}$/.test(payload.token)) {
    return jsonResp({ ok: false, code: 'bad_request' }, 400);
  }
  let upstream;
  try { upstream = await fetch(upstreamConfig.target + '?action=patient_cancel', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'patient_cancel', token: payload.token }), redirect: 'follow' }); }
  catch (_) { return jsonResp({ ok: false, code: 'upstream_unreachable' }, 502); }
  if (!upstream.ok) return jsonResp({ ok: false, code: 'upstream_error' }, 502);
  const data = await readJsonResponse(upstream);
  return data && data.ok ? jsonResp({
    ok: true,
    status: data.status === 'cancellation_pending' ? 'cancellation_pending' : 'cancelled',
    refund: data.refund === 'requested' || data.refund === 'pending' ? 'requested' : 'BUSINESS_POLICY_TBD'
  }, 200)
    : jsonResp({ ok: false, code: data && data.code ? data.code : 'management_rejected' }, 200);
}

async function handleManageReschedule(request, env) {
  if (request.method !== 'POST') return textBad('method_not_allowed', 405);
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return jsonResp({ ok: false, code: upstreamConfig.error }, upstreamConfig.status);
  let payload;
  try { payload = await request.json(); } catch (_) { return jsonResp({ ok: false, code: 'bad_request' }, 400); }
  if (!payload || payload.action !== 'reschedule_confirm' || typeof payload.token !== 'string' || !/^[A-Za-z0-9_-]{64,256}$/.test(payload.token)
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.fecha || '')) || !/^\d{2}:\d{2}$/.test(String(payload.hora || ''))) {
    return jsonResp({ ok: false, code: 'bad_request' }, 400);
  }
  let upstream;
  try { upstream = await fetch(upstreamConfig.target + '?action=patient_reschedule', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'patient_reschedule', token: payload.token, fecha: payload.fecha, hora: payload.hora }), redirect: 'follow' }); }
  catch (_) { return jsonResp({ ok: false, code: 'upstream_unreachable' }, 502); }
  if (!upstream.ok) return jsonResp({ ok: false, code: 'upstream_error' }, 502);
  const data = await readJsonResponse(upstream);
  return data && data.ok ? jsonResp({ ok: true, status: 'rescheduled', currentStart: data.currentStart || '' }, 200)
    : jsonResp({ ok: false, code: data && data.code ? data.code : 'management_rejected' }, 200);
}

async function handleRefundConfirmation(request, env) {
  if (request.method !== 'POST') return textBad('method_not_allowed', 405);
  const upstreamConfig = productionUpstream(env);
  if (upstreamConfig.error) return textBad(upstreamConfig.error, upstreamConfig.status);
  let body;
  try { body = await request.text(); } catch (_) { return textBad('bad_request', 400); }
  if (!body || body.length > 4096) return textBad('bad_request', 400);
  let upstream;
  try { upstream = await fetch(upstreamConfig.target + '?action=refund_confirmation', { method: 'POST', headers: { 'content-type': request.headers.get('content-type') || 'application/x-www-form-urlencoded' }, body, redirect: 'follow' }); }
  catch (_) { return textBad('upstream_unreachable', 502); }
  if (!upstream.ok) return textBad('upstream_error', 502);
  try { await upstream.text(); } catch (_) { /* drain */ }
  return textOk();
}

// --- /pago-resultado POST → 303 GET --------------------------------------
// Flow's urlReturn sends a POST to the return URL. Static assets only serve
// GET. We preserve the publicStatusToken (?st=…) and 303-redirect to GET.
async function handlePagoResultadoPost(request, env) {
  const url = new URL(request.url);
  if (!url.searchParams.has('st')) {
    try {
      const bodyText = await request.text();
      const bodyParams = new URLSearchParams(bodyText);
      const st = bodyParams.get('st');
      if (st) url.searchParams.set('st', st);
    } catch (_) { /* ignore parse errors */ }
  }
  return Response.redirect(url.toString(), 303);
}

// --- Main fetch handler --------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Web 04.10: 301 www ? canonical non-www (added 2026-05-17)
    if (url.hostname === 'www.franciscabustos.cl') {
      url.hostname = 'franciscabustos.cl';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/api/flow-confirmation') {
      return handleFlowConfirmation(request, env);
    }

    if (url.pathname === '/api/leadmagnet') {
      if (request.method !== 'POST') return jsonResp({ ok: false, code: 'method_not_allowed' }, 405);
      return disabledProductionFeature();
    }

    if (url.pathname === '/api/manage') return handleManageLookup(request, env);
    if (url.pathname === '/api/manage-availability') return handleAvailability(request, env);
    if (url.pathname === '/api/manage-cancel') return handleManageCancel(request, env);
    if (url.pathname === '/api/manage-reschedule') return handleManageReschedule(request, env);
    if (url.pathname === '/api/refund-confirmation') return handleRefundConfirmation(request, env);

    if (url.pathname === '/api/availability') {
      return handleAvailability(request, env);
    }

    if (url.pathname === '/api/create-flow-payment') {
      return handleCreateFlowPayment(request, env);
    }

    if (url.pathname === '/api/retry-flow-payment') {
      return handleRetryFlowPayment(request, env);
    }

    if (url.pathname === '/api/payment-status') {
      return handlePaymentStatus(request, env);
    }

    if (url.pathname === '/pago-resultado' && request.method === 'POST') {
      return handlePagoResultadoPost(request, env);
    }

    // Web 04.9: explicit /backend/* block (defense in depth — backend/ should
    // also be excluded from the deploy artifact via wrangler config / build).
    if (url.pathname === '/backend' || url.pathname.startsWith('/backend/')) {
      return textBad('not_found', 404);
    }

    // All other routes: serve static assets via Pages.
    return env.ASSETS.fetch(request);
  }
};
