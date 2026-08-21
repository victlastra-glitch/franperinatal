/**
 * _worker.js — Francisca Bustos · Cloudflare Pages Worker
 * ============================================================
 * Web 04.9 PRODUCTION cutover:
 *   - Hardcoded fallback URL removed. APPS_SCRIPT_WEB_APP_URL is REQUIRED.
 *   - /api/payment-status proxy added (no PII, no Apps Script URL leak).
 *   - /backend/* explicitly returns 404 (defense in depth — should also
 *     be excluded at deploy artifact level via wrangler/build).
 *   - /pago-resultado POST → 303 GET preserved (Flow urlReturn).
 *   - Missing APPS_SCRIPT_WEB_APP_URL returns 503 (NOT 200) so monitoring
 *     can detect misconfiguration immediately.
 *
 * Required Cloudflare Pages environment variables (Production):
 *   APPS_SCRIPT_WEB_APP_URL = https://script.google.com/macros/s/<PROD_DEPLOY_ID>/exec
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

// --- /api/flow-confirmation ----------------------------------------------
// Flow.cl webhook target. Forwards POST application/x-www-form-urlencoded
// to Apps Script, follows the 302 redirect internally, returns 200 OK plain
// text to Flow. Idempotency is enforced server-side (LockService + flags).
async function handleFlowConfirmation(request, env) {
  if (request.method === 'GET') {
    return new Response('flow-confirmation proxy alive\n', { status: 200, headers: RESP_HEADERS_TEXT });
  }
  if (request.method !== 'POST') {
    return textBad('method_not_allowed', 405);
  }

  const target = env.APPS_SCRIPT_WEB_APP_URL;
  if (!target) {
    console.error('[flow-confirmation] APPS_SCRIPT_WEB_APP_URL not configured');
    // Web 04.9: 503 (not 200) so Cloudflare monitoring + Flow retries surface the gap.
    return textBad('upstream_not_configured', 503);
  }

  let body;
  try { body = await request.text(); } catch (e) {
    console.error('[flow-confirmation] body read failed');
    return textBad('bad_request', 400);
  }
  const incomingCT = request.headers.get('content-type') || 'application/x-www-form-urlencoded';

  let upstream;
  try {
    upstream = await fetch(target + '?action=flow_confirmation', {
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

  const target = env.APPS_SCRIPT_WEB_APP_URL;
  if (!target) {
    console.error('[payment-status] APPS_SCRIPT_WEB_APP_URL not configured');
    return jsonResp({ ok: false, code: 'UPSTREAM_NOT_CONFIGURED' }, 503);
  }

  const incomingUrl = new URL(request.url);
  const st = incomingUrl.searchParams.get('st');
  if (!st) {
    return jsonResp({ ok: false, code: 'MISSING_STATUS_TOKEN' }, 400);
  }

  let upstream;
  try {
    upstream = await fetch(target + '?action=payment_status&st=' + encodeURIComponent(st), {
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
    commerceOrder: data.commerceOrder || '',
    reservationId: data.reservationId || '',
    amount: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
    currency: data.currency === 'CLP' ? 'CLP' : '',
    serviceType: data.serviceType || '',
    modality: data.modality || '',
    backendVersion: data.backendVersion || ''
  } : {
    ok: false,
    code: data && data.code ? data.code : '',
    error: data && data.error ? data.error : '',
    backendVersion: data && data.backendVersion ? data.backendVersion : ''
  };

  return new Response(JSON.stringify(safeBody), {
    status: 200,
    headers: { ...RESP_HEADERS_JSON, 'cache-control': 'no-store' }
  });
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
