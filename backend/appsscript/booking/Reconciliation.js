/**
 * Calendar -> datastore reconciliation.
 *
 * This layer never writes Calendar while processing a clinician edit.
 * Matching persisted ETag + sync hash is a duplicate/system no-op.
 * calendarSyncHash_ also includes etag, updated, and Meet conferenceId, so a
 * later Google/system representation of the same linked event can change the
 * hash without moving the appointment. That metadata-only evolution is
 * non-notifying: persist current Calendar metadata/hash/etag/Meet, do not set
 * calendar_change_source=clinician, and do not enqueue CLINICIAN_RESCHEDULED.
 * CLINICIAN_RESCHEDULED is reserved for a material start/end instant change
 * on the same linked event. Cancellation/deleted detection is unchanged.
 */

function reconciliationOperationId_(kind, event) {
  return makeOperationId_(kind, String(event && event.id || '') + ':' + String(event && event.etag || '') + ':' + String(event && event.updated || ''));
}

// Only patient-reschedule Calendar failures can recover from an unchanged
// authoritative event. Other reconciliation states may represent an
// unresolved cancellation, creation, notification, Flow, refund, or
// capability operation and must remain untouched until their own handler runs.
var CALENDAR_UNCHANGED_EVENT_RECOVERY_STATES = Object.freeze([
  'calendar_reschedule_conflict', 'calendar_reschedule_retry', 'calendar_reschedule_store_retry',
]);

function canRecoverUnchangedCalendarEvent_(record) {
  return record && record.schedule_status === LIFECYCLE.SCHEDULE_STATUS.RECONCILIATION_REQUIRED
    && CALENDAR_UNCHANGED_EVENT_RECOVERY_STATES.indexOf(String(record.reconciliation_state || '')) !== -1;
}

function sameAppointmentInstant_(left, right) {
  const leftMs = Date.parse(String(left || ''));
  const rightMs = Date.parse(String(right || ''));
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return false;
  return leftMs === rightMs;
}

function datastoreAppointmentInterval_(record) {
  const start = String(record && record.current_start_at || '');
  const end = String(record && record.current_end_at || '');
  if (!start && !end) return { comparable: false, empty: true };
  const startMs = Date.parse(start); const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return { comparable: false, invalid: true };
  return { comparable: true, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

function appointmentIntervalUnchanged_(record, interval) {
  if (!record || !interval) return false;
  return sameAppointmentInstant_(record.current_start_at, interval.start)
    && sameAppointmentInstant_(record.current_end_at, interval.end);
}

function isSameLinkedCalendarEvent_(record, event) {
  const eventId = String(event && event.id || '');
  if (!eventId) return false;
  const persistedId = String(record && record.calendar_event_id || '');
  return !persistedId || persistedId === eventId;
}

function persistCalendarMetadataRefresh_(input, record, event, hash) {
  const recover = canRecoverUnchangedCalendarEvent_(record);
  const eventFields = calendarEventFields_(calendarEventResult_(event));
  const updates = Object.assign({}, eventFields, {
    calendar_event_id: String(event.id),
    calendar_event_etag: String(event.etag || ''),
    calendar_event_updated_at: String(event.updated || ''),
    calendar_sync_hash: hash,
  });
  if (recover) {
    updates.schedule_status = LIFECYCLE.SCHEDULE_STATUS.SCHEDULED;
    updates.reconciliation_state = '';
  }
  const updated = input.store.update(record, updates);
  return { ok: true, changed: true, recovered: recover, source: 'system', reason: 'metadata_refreshed',
    patientRescheduleCount: String(updated.patient_reschedule_count) };
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
    if (canRecoverUnchangedCalendarEvent_(record)) {
      const interval = eventInterval_(event);
      if (!interval) {
        input.store.update(record, { reconciliation_state: 'calendar_bad_interval' });
        return { ok: false, code: 'CALENDAR_BAD_INTERVAL' };
      }
      const recovered = input.store.update(record, Object.assign({}, calendarEventFields_(calendarEventResult_(event)), {
        current_start_at: interval.start,
        current_end_at: interval.end,
        schedule_status: LIFECYCLE.SCHEDULE_STATUS.SCHEDULED,
        reconciliation_state: '',
      }));
      return { ok: true, changed: true, recovered: true, source: 'reconciliation',
        patientRescheduleCount: String(recovered.patient_reschedule_count) };
    }
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
  if (isSameLinkedCalendarEvent_(record, event)) {
    const storedInterval = datastoreAppointmentInterval_(record);
    if (storedInterval.invalid) {
      input.store.update(record, { reconciliation_state: 'calendar_bad_interval' });
      return { ok: false, code: 'CALENDAR_BAD_INTERVAL' };
    }
    if (storedInterval.comparable && appointmentIntervalUnchanged_(record, interval)) {
      return persistCalendarMetadataRefresh_(input, record, event, hash);
    }
  }
  const eventFields = calendarEventFields_(calendarEventResult_(event));
  const moveNow = Date.now();
  const moveFields = Object.assign({}, eventFields, { current_start_at: interval.start, current_end_at: interval.end,
    calendar_event_id: String(event.id), calendar_event_etag: String(event.etag || ''), calendar_event_updated_at: String(event.updated || ''),
    calendar_sync_hash: hash, calendar_change_source: 'clinician', schedule_changed_at: new Date(moveNow).toISOString(),
    last_operation_id: operationId, reconciliation_state: '', schedule_status: LIFECYCLE.SCHEDULE_STATUS.SCHEDULED });
  // A clinician move changes the current session start, so the live management
  // capabilities are re-scoped onto the new horizon: extended when the session
  // moves later, contracted when it moves earlier. Revoked or already-expired
  // capabilities are left dead. The lifecycle email that follows mints its own
  // capability from the same new start.
  Object.assign(moveFields, alignedCapabilityExpiryFields_(Object.assign({}, record, moveFields), moveNow));
  const updated = input.store.update(record, moveFields);
  if (input.enqueueNotification) input.enqueueNotification(updated);
  return { ok: true, changed: true, source: 'clinician', patientRescheduleCount: String(updated.patient_reschedule_count) };
}

function reconcileClinicianCancellation_(input, record, operationId) {
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLED) return { ok: true, noop: true, reason: 'already_cancelled' };
  if (record.booking_status === LIFECYCLE.BOOKING_STATUS.CANCELLATION_REQUESTED) {
    return { ok: true, noop: true, reason: 'cancellation_pending_refund' };
  }
  const policy = input.policyEvaluator ? input.policyEvaluator(record) : { eligible: false, decision: 'BUSINESS_POLICY_TBD' };
  const refundEligible = Boolean(policy.eligible && record.payment_status === LIFECYCLE.PAYMENT_STATUS.PAID);
  const updated = input.store.update(record, atomicCancellationTransitionFields_(record, {
    schedule_status: LIFECYCLE.SCHEDULE_STATUS.CANCELLED, cancellation_source: 'clinician', cancelled_at: new Date().toISOString(),
    last_operation_id: operationId, reconciliation_state: '', refund_status: refundEligible ? LIFECYCLE.REFUND_STATUS.REQUESTED : LIFECYCLE.REFUND_STATUS.MANUAL_REVIEW,
    refund_last_error_code: refundEligible ? '' : 'BUSINESS_POLICY_TBD' }, { terminal: !refundEligible }));
  if (refundEligible && input.enqueueRefund) input.enqueueRefund(updated);
  else if (!refundEligible && input.enqueueNotification) {
    try { input.enqueueNotification(updated); } catch (_) {}
  }
  return { ok: true, changed: true, source: 'clinician', refund: refundEligible ? 'requested' : 'BUSINESS_POLICY_TBD' };
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
  canRecoverUnchangedCalendarEvent_: canRecoverUnchangedCalendarEvent_,
  sameAppointmentInstant_: sameAppointmentInstant_, appointmentIntervalUnchanged_: appointmentIntervalUnchanged_,
  datastoreAppointmentInterval_: datastoreAppointmentInterval_, isSameLinkedCalendarEvent_: isSameLinkedCalendarEvent_,
});
