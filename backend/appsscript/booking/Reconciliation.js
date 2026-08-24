/**
 * Calendar -> datastore reconciliation.
 *
 * This layer never writes Calendar while processing a clinician edit. A
 * system-authored change is recognized by the persisted ETag/sync hash and is
 * therefore a no-op on the next incremental sync.
 */

function reconciliationOperationId_(kind, event) {
  return makeOperationId_(kind, String(event && event.id || '') + ':' + String(event && event.etag || '') + ':' + String(event && event.updated || ''));
}

function reconcileCalendarChange_(input) {
  if (!input || !input.store || !input.event) fail_('RECONCILIATION_INPUT_INVALID');
  const event = input.event; const linkage = calendarExtendedProperties_(event);
  if (!linkage) return { ok: true, ignored: true, reason: 'unlinked_event' };
  let record;
  if (typeof input.store.loadByCalendarEventId === 'function') record = input.store.loadByCalendarEventId(event.id);
  else if (typeof input.store.loadByCalendarLinkKey === 'function') record = input.store.loadByCalendarLinkKey(linkage.link_key);
  else fail_('CALENDAR_LINKAGE_LOOKUP_UNAVAILABLE');
  if (!record) return { ok: true, ignored: true, reason: 'linked_record_missing' };
  const hash = calendarSyncHash_(event);
  if (String(record.calendar_sync_hash || '') === hash && String(record.calendar_event_etag || '') === String(event.etag || '')) {
    return { ok: true, noop: true, reason: 'system_or_duplicate_event' };
  }
  if (record.calendar_event_updated_at && event.updated && Date.parse(String(event.updated)) < Date.parse(String(record.calendar_event_updated_at))) {
    input.store.update(record, { reconciliation_state: 'calendar_stale_event_retry' });
    return { ok: false, code: 'STALE_CALENDAR_EVENT' };
  }
  const operationId = reconciliationOperationId_(LIFECYCLE.OPERATION_TYPE.CLINICIAN_RECONCILE_MOVE, event);
  if (event.status === 'cancelled' || event.deleted === true) return reconcileClinicianCancellation_(input, record, operationId);
  const interval = eventInterval_(event);
  if (!interval) { input.store.update(record, { reconciliation_state: 'calendar_bad_interval' }); return { ok: false, code: 'CALENDAR_BAD_INTERVAL' }; }
  const eventFields = calendarEventFields_(calendarEventResult_(event));
  const updated = input.store.update(record, Object.assign({}, eventFields, { current_start_at: interval.start, current_end_at: interval.end,
    calendar_event_id: String(event.id), calendar_event_etag: String(event.etag || ''), calendar_event_updated_at: String(event.updated || ''),
    calendar_sync_hash: hash, calendar_change_source: 'clinician', schedule_changed_at: new Date().toISOString(),
    last_operation_id: operationId, reconciliation_state: '', schedule_status: LIFECYCLE.SCHEDULE_STATUS.SCHEDULED }));
  if (input.enqueueNotification) input.enqueueNotification(updated);
  return { ok: true, changed: true, source: 'clinician', patientRescheduleCount: String(updated.patient_reschedule_count) };
}

function reconcileClinicianCancellation_(input, record, operationId) {
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLED) return { ok: true, noop: true, reason: 'already_cancelled' };
  const policy = input.policyEvaluator ? input.policyEvaluator(record) : { eligible: false, decision: 'BUSINESS_POLICY_TBD' };
  const updated = input.store.update(record, atomicCancellationTransitionFields_(record, {
    schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED, cancellation_source: 'clinician', cancelled_at: new Date().toISOString(),
    last_operation_id: operationId, reconciliation_state: '', refund_status: policy.eligible ? LIFECYCLE.REFUND_STATUS.REQUESTED : LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW,
    refund_last_error_code: policy.eligible ? '' : 'BUSINESS_POLICY_TBD' }));
  if (input.enqueueNotification) input.enqueueNotification(updated);
  if (policy.eligible && input.enqueueRefund) input.enqueueRefund(updated);
  return { ok: true, changed: true, source: 'clinician', refund: policy.eligible ? 'requested' : 'BUSINESS_POLICY_TBD' };
}

function reconcileCalendarSync_(input) {
  if (!input || !input.gateway || !input.syncState || !input.store) fail_('RECONCILIATION_INPUT_INVALID');
  return withLifecycleLock_(input, function() {
    const token = input.syncState.get(); const result = input.gateway.reconcileIncremental(token, input.bounds);
    let changed = 0; let ignored = 0; let stale = 0; let unresolved = false;
    result.events.forEach(function(item) {
      const outcome = reconcileCalendarChange_(Object.assign({}, input, { event: item.event }));
      if (outcome.changed) changed += 1; else if (outcome.ignored || outcome.noop) ignored += 1; else { unresolved = true; if (outcome.code === 'STALE_CALENDAR_EVENT') stale += 1; }
    });
    if (unresolved) return { ok: false, code: 'RECONCILIATION_REQUIRED', fullSyncReset: result.fullSyncReset, nextSyncToken: '', changed: changed, ignored: ignored, stale: stale };
    if (!result.nextSyncToken) return { ok: false, code: 'SYNC_CURSOR_MISSING', fullSyncReset: result.fullSyncReset, nextSyncToken: '', changed: changed, ignored: ignored, stale: stale };
    try { input.syncState.set(result.nextSyncToken); }
    catch (_) { return { ok: false, code: 'SYNC_CURSOR_PERSIST_FAILED', fullSyncReset: result.fullSyncReset, nextSyncToken: '', changed: changed, ignored: ignored, stale: stale }; }
    return { ok: true, fullSyncReset: result.fullSyncReset, nextSyncToken: result.nextSyncToken, changed: changed, ignored: ignored, stale: stale };
  });
}

var __RECONCILIATION_TEST_EXPORTS__ = Object.freeze({
  reconciliationOperationId_: reconciliationOperationId_, reconcileCalendarChange_: reconcileCalendarChange_,
  reconcileClinicianCancellation_: reconcileClinicianCancellation_, reconcileCalendarSync_: reconcileCalendarSync_,
});
