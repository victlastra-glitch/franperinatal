/**
 * Flow refund adapter. Production host only, lazy-scoped.
 * Not invoked by normal BUSINESS_POLICY_TBD cancellation.
 * No provider token/reference is returned to the browser or written to logs.
 */

var FLOW_REFUND_BASE_URL = 'https://www.flow.cl/api';

function refundFail_(code, definite) {
  const error = new Error(code || 'FLOW_REFUND_FAILED'); error.code = code || 'FLOW_REFUND_FAILED';
  if (definite) error.definite = true; throw error;
}

function deterministicRefundCommerceOrder_(reservationId) {
  const value = String(reservationId || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) refundFail_('REFUND_ORDER_INVALID');
  const digest = hexBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'refund:' + value, Utilities.Charset.UTF_8));
  return 'fp-rf-' + digest.slice(0, 24);
}

function refundSign_(params, secretKey) {
  const canonical = Object.keys(params).sort().reduce(function(result, key) {
    return params[key] === null || params[key] === undefined ? result : result + key + params[key];
  }, '');
  return hexBytes_(Utilities.computeHmacSha256Signature(canonical, secretKey));
}

function refundForm_(params) {
  return Object.keys(params).sort().map(function(key) { return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]); }).join('&');
}

function validRefundCallbackUrl_(value) {
  if (typeof productionSiteUrlMatch_ === 'function') {
    const match = productionSiteUrlMatch_(value);
    return Boolean(match && match[1] === '/api/refund-confirmation');
  }
  return /^https:\/\/(?:www\.)?franciscabustos\.cl\/api\/refund-confirmation$/i.test(String(value || ''));
}

function createFlowRefundGateway_(options) {
  options = options || {};
  const baseUrl = String(options.baseUrl || FLOW_REFUND_BASE_URL).replace(/\/$/, '');
  if (/sandbox\.flow\.cl/i.test(baseUrl) || baseUrl !== FLOW_REFUND_BASE_URL) refundFail_('FLOW_REFUND_ENVIRONMENT_REJECTED');
  const apiKey = String(options.apiKey || ''); const secretKey = String(options.secretKey || '');
  if (!apiKey || !secretKey) refundFail_('REFUND_CONFIGURATION_INCOMPLETE');
  const fetchImpl = options.fetch || (typeof UrlFetchApp !== 'undefined' && UrlFetchApp.fetch ? function(url, request) { return UrlFetchApp.fetch(url, request); } : null);
  if (!fetchImpl) refundFail_('REFUND_TRANSPORT_UNAVAILABLE');

  function request(endpoint, params, method) {
    const signed = Object.assign({}, params, { apiKey: apiKey }); signed.s = refundSign_(signed, secretKey);
    const encoded = refundForm_(signed); const verb = method || 'post';
    let url = baseUrl + endpoint; const requestOptions = { method: verb, muteHttpExceptions: true, contentType: 'application/x-www-form-urlencoded', payload: encoded };
    if (verb === 'get') { url += '?' + encoded; delete requestOptions.payload; delete requestOptions.contentType; }
    const response = fetchImpl(url, requestOptions); const status = response && response.getResponseCode ? response.getResponseCode() : response.status;
    if (status < 200 || status >= 300) refundFail_(status >= 400 && status < 500 ? 'FLOW_REFUND_PROVIDER_REJECTED' : 'FLOW_REFUND_PROVIDER_ERROR', status >= 400 && status < 500);
    let data; try { data = JSON.parse(response.getContentText ? response.getContentText() : response.body); } catch (_) { refundFail_('FLOW_REFUND_BAD_RESPONSE'); }
    if (!data || typeof data !== 'object') refundFail_('FLOW_REFUND_BAD_RESPONSE');
    return data;
  }

  return Object.freeze({
    create: function(input) {
      const refundCommerceOrder = deterministicRefundCommerceOrder_(input.reservationId);
      const params = { refundCommerceOrder: refundCommerceOrder, receiverEmail: String(input.receiverEmail || ''), amount: String(input.amount || ''),
        urlCallBack: String(input.urlCallBack || ''), commerceTrxId: String(input.commerceTrxId || ''), flowTrxId: String(input.flowTrxId || '') };
      if (!params.receiverEmail || !params.amount || !validRefundCallbackUrl_(params.urlCallBack)
        || (!params.commerceTrxId && !params.flowTrxId)) refundFail_('REFUND_REQUEST_INVALID');
      const response = request('/refund/create', params, 'post');
      return { ok: true, refundCommerceOrder: refundCommerceOrder, providerReference: String(response.token || response.refundToken || response.flowTrxId || ''), status: String(response.status || 'pending') };
    },
    getStatus: function(token) {
      if (!token) refundFail_('REFUND_TOKEN_INVALID');
      const response = request('/refund/getStatus', { token: String(token) }, 'get');
      return { ok: true, status: String(response.status || response.refundStatus || 'unknown'), providerReference: String(response.flowTrxId || response.token || '') };
    },
    cancel: function(token) {
      if (!token) refundFail_('REFUND_TOKEN_INVALID');
      const response = request('/refund/cancel', { token: String(token) }, 'post');
      return { ok: true, status: String(response.status || 'cancelled') };
    },
  });
}

function refundStatusFromProvider_(status) {
  const normalized = String(status || '').toLowerCase();
  if (['completed', 'success', 'refunded', 'accepted', '2'].indexOf(normalized) !== -1) return LIFECYCLE.REFUND_STATUS.REFUNDED;
  if (['rejected', 'failed', 'error', 'cancelled', 'canceled', '3', '4'].indexOf(normalized) !== -1) return LIFECYCLE.REFUND_STATUS.FAILED;
  if (['created', 'pending', '1'].indexOf(normalized) !== -1) return LIFECYCLE.REFUND_STATUS.PENDING;
  return LIFECYCLE.REFUND_STATUS.PENDING;
}

function refundCreateOnce_(input) {
  if (!input || !input.store || !input.record || !input.gateway) refundFail_('REFUND_REQUEST_INVALID');
  const record = input.record; const existingOrder = String(record.refund_commerce_order || '');
  if (existingOrder) {
    if (record.refund_status === LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW) {
      return { ok: false, replay: true, retry: 'manual_review', refundCommerceOrder: existingOrder, code: 'REFUND_CREATE_OUTCOME_UNKNOWN' };
    }
    return { ok: true, replay: true, refundCommerceOrder: existingOrder, status: record.refund_status };
  }
  const order = deterministicRefundCommerceOrder_(record.reservation_id);
  try {
    const response = input.gateway.create(Object.assign({}, input, { reservationId: record.reservation_id }));
    const providerReference = String(response && response.providerReference || '');
    if (!providerReference) refundFail_('REFUND_CREATE_OUTCOME_UNKNOWN');
    const updated = input.store.update(record, { refund_commerce_order: order, refund_provider_reference: providerReference,
      refund_requested_at: new Date().toISOString(), refund_status: LIFECYCLE.REFUND_STATUS.PENDING, refund_last_error_code: '' });
    return { ok: true, replay: false, refundCommerceOrder: order, status: updated.refund_status };
  } catch (error) {
    const code = String(error && error.code || 'FLOW_REFUND_TIMEOUT');
    const definite = Boolean(error && error.definite);
    try { input.store.update(record, { refund_commerce_order: order,
      refund_status: definite ? LIFECYCLE.REFUND_STATUS.FAILED : LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW,
      refund_last_error_code: definite ? 'PROVIDER_REFUND_REJECTED' : 'REFUND_CREATE_OUTCOME_UNKNOWN' }); } catch (_) { /* caller receives the same non-success outcome */ }
    return { ok: false, retry: 'manual_review', refundCommerceOrder: order,
      code: definite ? 'PROVIDER_REFUND_REJECTED' : 'REFUND_CREATE_OUTCOME_UNKNOWN' };
  }
}

function refundCallbackOnce_(input) {
  if (!input || !input.store || !input.record || !input.gateway || !input.token) refundFail_('REFUND_CALLBACK_INVALID');
  const record = input.record;
  if (record.refund_status === LIFECYCLE.REFUND_STATUS.REFUNDED || record.refund_status === LIFECYCLE.REFUND_STATUS.FAILED) {
    return { ok: true, replay: true, status: record.refund_status };
  }
  const result = input.gateway.getStatus(input.token); const next = refundStatusFromProvider_(result.status);
  const updates = { refund_status: next, refund_last_checked_at: new Date().toISOString(), refund_provider_reference: result.providerReference || record.refund_provider_reference };
  if (next === LIFECYCLE.REFUND_STATUS.REFUNDED) updates.refund_completed_at = new Date().toISOString();
  if (next === LIFECYCLE.REFUND_STATUS.FAILED) updates.refund_last_error_code = 'PROVIDER_REFUND_FAILED';
  const updated = input.store.update(record, updates);
  return { ok: true, replay: false, status: updated.refund_status };
}

var __REFUND_TEST_EXPORTS__ = Object.freeze({
  deterministicRefundCommerceOrder_: deterministicRefundCommerceOrder_, refundSign_: refundSign_, refundForm_: refundForm_,
  validRefundCallbackUrl_: validRefundCallbackUrl_,
  createFlowRefundGateway_: createFlowRefundGateway_, refundStatusFromProvider_: refundStatusFromProvider_,
  refundCreateOnce_: refundCreateOnce_, refundCallbackOnce_: refundCallbackOnce_,
});
