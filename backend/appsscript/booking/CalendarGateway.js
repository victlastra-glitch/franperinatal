/**
 * Calendar gateway for the Production booking lifecycle.
 *
 * The business layer depends on this adapter instead of Calendar calls. All
 * methods are inert until called with an injected API or the Apps Script
 * Advanced Calendar service. Tests inject a fake API and never reach Google.
 */

var CALENDAR_LINK_SCHEMA = 'fran_booking:v1';
var CALENDAR_LINK_SOURCE = 'fran_booking';
var DEFAULT_BOOKING_TIME_ZONE = 'America/Santiago';
var WORKING_HOURS = Object.freeze(['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
var AVAILABILITY_HORIZON_DAYS = 90;
var BOOKING_LEAD_MINUTES = 120;

function calendarFail_(code) { fail_(code || 'CALENDAR_UNAVAILABLE'); }

function calendarConflict_(code, status) {
  const error = new Error(code || 'RECONCILIATION_REQUIRED');
  error.code = code || 'RECONCILIATION_REQUIRED';
  if (status) error.status = status;
  throw error;
}

function calendarApi_(options) {
  if (options && options.api) return options.api;
  if (typeof Calendar !== 'undefined') return Calendar;
  calendarFail_('CALENDAR_UNAVAILABLE');
}

function opaqueCalendarProperties_(linkKey) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(linkKey || ''))) calendarFail_('CALENDAR_LINK_KEY_INVALID');
  return { private: { source: CALENDAR_LINK_SOURCE, link_key: String(linkKey), schema: CALENDAR_LINK_SCHEMA } };
}

function calendarDateTime_(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) calendarFail_('CALENDAR_TIME_INVALID');
  return date;
}

function eventInterval_(event) {
  if (!event || !event.start || !event.end) return null;
  let start = event.start.dateTime || event.start.date;
  let end = event.end.dateTime || event.end.date;
  if (event.start.date && event.end.date) {
    start = startAt_(event.start.date, '00:00'); end = startAt_(event.end.date, '00:00');
  }
  const startDate = calendarDateTime_(start); const endDate = calendarDateTime_(end);
  if (endDate.getTime() <= startDate.getTime()) return null;
  return { start: startDate.toISOString(), end: endDate.toISOString(), allDay: Boolean(event.start.date) };
}

function intervalOverlap_(leftStart, leftEnd, rightStart, rightEnd) {
  return new Date(leftStart).getTime() < new Date(rightEnd).getTime()
    && new Date(rightStart).getTime() < new Date(leftEnd).getTime();
}

function calendarExtendedProperties_(event) {
  const properties = event && event.extendedProperties && event.extendedProperties.private;
  if (!properties || properties.source !== CALENDAR_LINK_SOURCE || properties.schema !== CALENDAR_LINK_SCHEMA) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(properties.link_key || ''))) return null;
  return { source: CALENDAR_LINK_SOURCE, link_key: String(properties.link_key), schema: CALENDAR_LINK_SCHEMA };
}

function meetFields_(event) {
  const conference = event && event.conferenceData;
  if (!conference) return { meetUrl: '', meetConferenceId: '', meetStatus: 'not_available' };
  const entry = (conference.entryPoints || []).find(function(point) { return point.entryPointType === 'video' && point.uri; });
  return { meetUrl: entry ? String(entry.uri) : '', meetConferenceId: String(conference.conferenceId || ''),
    meetStatus: entry ? 'available' : 'requested' };
}

function calendarSyncHash_(event) {
  // Identity for persisted sync/idempotency. Reconciliation classifies a
  // clinician reschedule by appointment start/end instants, not by this hash
  // alone: etag, updated, and Meet conferenceId can change without a schedule
  // change.
  const linkage = calendarExtendedProperties_(event) || {};
  const meet = meetFields_(event);
  const stable = [event && event.id, event && event.etag, event && event.updated,
    event && event.status, event && event.start && (event.start.dateTime || event.start.date),
    event && event.end && (event.end.dateTime || event.end.date), linkage.link_key || '', meet.meetConferenceId].join('|');
  return hexBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, stable, Utilities.Charset.UTF_8));
}

function calendarEventResult_(event) {
  if (!event || !event.id) calendarFail_('CALENDAR_BAD_RESPONSE');
  const meet = meetFields_(event);
  return { id: String(event.id), etag: String(event.etag || ''), updated: String(event.updated || ''),
    syncHash: calendarSyncHash_(event), meetUrl: meet.meetUrl, meetConferenceId: meet.meetConferenceId, meetStatus: meet.meetStatus,
    event: event };
}

function createCalendarGateway_(options) {
  options = options || {};
  const api = calendarApi_(options);
  const calendarId = String(options.calendarId || '');
  if (!calendarId) calendarFail_('CALENDAR_CONFIGURATION_INCOMPLETE');
  const gateway = {
    freeBusy: function(start, end) {
      const response = api.Freebusy.query({ timeMin: calendarDateTime_(start).toISOString(), timeMax: calendarDateTime_(end).toISOString(),
        items: [{ id: calendarId }] });
      const busy = response && response.calendars && response.calendars[calendarId] && response.calendars[calendarId].busy;
      if (!Array.isArray(busy)) calendarFail_('CALENDAR_BAD_RESPONSE');
      return busy.map(function(interval) { return { start: String(interval.start), end: String(interval.end) }; });
    },
    getEvent: function(eventId) {
      try { return calendarEventResult_(api.Events.get(calendarId, String(eventId))); }
      catch (error) { if (calendarHttpStatus_(error) === 404) return null; throw error; }
    },
    findLinkedEvent: function(linkKey) {
      const response = api.Events.list(calendarId, { privateExtendedProperty: ['source=' + CALENDAR_LINK_SOURCE, 'link_key=' + String(linkKey)],
        showDeleted: false, maxResults: 10, singleEvents: false });
      const events = response && Array.isArray(response.items) ? response.items : [];
      return events.map(calendarEventResult_).find(function(result) { return calendarExtendedProperties_(result.event) && result.event.extendedProperties.private.link_key === String(linkKey); }) || null;
    },
    createLinkedBookingEvent: function(record) {
      const existing = this.findLinkedEvent(record.calendar_link_key);
      if (existing) return existing;
      const start = calendarDateTime_(record.current_start_at); const end = calendarDateTime_(record.current_end_at);
      const resource = { summary: 'Sesión con Francisca Bustos', start: { dateTime: start.toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE },
        end: { dateTime: end.toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE }, extendedProperties: opaqueCalendarProperties_(record.calendar_link_key) };
      if (options.requestMeet) {
        resource.conferenceData = { createRequest: { requestId: String(record.calendar_link_key), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      }
      const created = calendarEventResult_(api.Events.insert(resource, calendarId, { conferenceDataVersion: options.requestMeet ? 1 : 0, sendUpdates: 'none' }));
      const latest = this.getEvent(created.id);
      return latest || created;
    },
    updateSameEvent: function(record, targetStartAt, targetEndAt) {
      const current = this.getEvent(record.calendar_event_id);
      if (!current) calendarFail_('CALENDAR_EVENT_MISSING');
      if (String(record.calendar_event_etag || '') !== String(current.etag || '')) {
        const liveInterval = eventInterval_(current.event);
        const timesUnchanged = Boolean(record.current_start_at && record.current_end_at && liveInterval)
          && calendarDateTime_(liveInterval.start).getTime() === calendarDateTime_(record.current_start_at).getTime()
          && calendarDateTime_(liveInterval.end).getTime() === calendarDateTime_(record.current_end_at).getTime();
        if (!timesUnchanged) calendarConflict_('CALENDAR_ETAG_CONFLICT', 412);
      }
      // Never mutate the object returned by GET before the conditional update.
      // A 412 must leave the locally observed event unchanged for the next
      // reconciliation attempt and must never appear as a successful move.
      const event = Object.assign({}, current.event, {
        start: { dateTime: calendarDateTime_(targetStartAt).toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE },
        end: { dateTime: calendarDateTime_(targetEndAt).toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE },
        extendedProperties: opaqueCalendarProperties_(record.calendar_link_key),
      });
      // Sending conferenceDataVersion while retaining event.conferenceData
      // preserves Meet on the same event. Sandbox must prove this behavior.
      try {
        return calendarEventResult_(api.Events.update(event, calendarId, event.id,
          { conferenceDataVersion: 1, sendUpdates: 'none' }, { 'If-Match': current.etag }));
      } catch (error) {
        if (calendarHttpStatus_(error) === 412) calendarConflict_('CALENDAR_ETAG_CONFLICT', 412);
        throw error;
      }
    },
    cancelLinkedEvent: function(record) {
      if (!record.calendar_event_id) return { ok: true, alreadyAbsent: true };
      try { api.Events.remove(calendarId, String(record.calendar_event_id), { sendUpdates: 'none' }); return { ok: true, deleted: true }; }
      catch (error) {
        const status = calendarHttpStatus_(error);
        if (status === 404 || status === 410) return { ok: true, alreadyAbsent: true };
        throw error;
      }
    },
    reconcileIncremental: function(syncToken, bounds) {
      const baseRequest = { showDeleted: true, singleEvents: false, maxResults: 2500 };
      if (syncToken) baseRequest.syncToken = String(syncToken);
      else { baseRequest.timeMin = calendarDateTime_(bounds.start).toISOString(); baseRequest.timeMax = calendarDateTime_(bounds.end).toISOString(); }
      let fullSyncReset = false;
      const fullRequest = { showDeleted: true, singleEvents: false, maxResults: 2500,
        timeMin: calendarDateTime_(bounds.start).toISOString(), timeMax: calendarDateTime_(bounds.end).toISOString() };
      function readAllPages_(initialRequest, allowReset) {
        const items = []; let request = Object.assign({}, initialRequest); let response;
        while (true) {
          try { response = api.Events.list(calendarId, request); }
          catch (error) {
            if (allowReset && syncToken && calendarHttpStatus_(error) === 410) {
              fullSyncReset = true;
              return readAllPages_(fullRequest, false);
            }
            throw error;
          }
          if (Array.isArray(response && response.items)) items.push.apply(items, response.items);
          if (!response || !response.nextPageToken) break;
          request = Object.assign({}, initialRequest, { pageToken: String(response.nextPageToken) });
        }
        if (!response || !response.nextSyncToken) calendarFail_('CALENDAR_SYNC_CURSOR_MISSING');
        return { items: items, nextSyncToken: String(response.nextSyncToken) };
      }
      const pages = readAllPages_(baseRequest, true);
      return { ok: true, fullSyncReset: fullSyncReset, nextSyncToken: pages.nextSyncToken,
        events: pages.items.map(function(item) { return { event: item, linkage: calendarExtendedProperties_(item), syncHash: calendarSyncHash_(item) }; }) };
    },
    isSlotAvailable: function(start, end, currentEventId) {
      const busy = this.freeBusy(start, end);
      const overlaps = busy.some(function(interval) { return intervalOverlap_(start, end, interval.start, interval.end); });
      if (!overlaps) return true;
      if (!currentEventId) return false;
      const current = this.getEvent(currentEventId);
      const ownInterval = current && eventInterval_(current.event);
      if (!ownInterval || !intervalOverlap_(start, end, ownInterval.start, ownInterval.end)) return false;
      // FreeBusy intervals intentionally have no eventId. When the target
      // overlaps the linked event, identify competitors through Events.list
      // and exclude only the exact linked event id.
      const response = api.Events.list(calendarId, { timeMin: calendarDateTime_(start).toISOString(),
        timeMax: calendarDateTime_(end).toISOString(), singleEvents: true, showDeleted: false, maxResults: 2500 });
      const events = response && Array.isArray(response.items) ? response.items : [];
      return !events.some(function(event) {
        const interval = eventInterval_(event);
        return String(event && event.id || '') !== String(currentEventId) && interval
          && intervalOverlap_(start, end, interval.start, interval.end);
      });
    },
  };
  return Object.freeze(gateway);
}

function calendarHttpStatus_(error) {
  const text = String(error && (error.message || error) || '');
  const match = text.match(/\b(400|404|409|410|412|429|500|503)\b/);
  if (match) return Number(match[1]);
  if (/resource has been deleted|\bnot found\b|\bgone\b/i.test(text)) return 404;
  return Number(error && error.status || 0);
}

function availabilityBounds_(requestedDate) {
  const startDate = requestedDate || new Date().toISOString().slice(0, 10);
  const start = startAt_(startDate, '00:00');
  const endDate = addCalendarDays_(startDate, AVAILABILITY_HORIZON_DAYS);
  return { start: start, end: startAt_(endDate, '23:59') };
}

function workingSlots_(start, end, requestedDate) {
  const slots = []; let date = localDateLabel_(start); const last = localDateLabel_(end);
  while (date <= last) {
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    if ((!requestedDate || date === requestedDate) && weekday !== 0 && weekday !== 6) {
      WORKING_HOURS.forEach(function(time) {
        const slotStart = startAt_(date, time);
        const slotEnd = typeof slotIntervalEndAt_ === 'function'
          ? slotIntervalEndAt_(slotStart)
          : new Date(Date.parse(slotStart) + ((typeof SLOT_INTERVAL_MS === 'number') ? SLOT_INTERVAL_MS : 60 * 60 * 1000)).toISOString();
        slots.push({ date: date, time: time, start: slotStart, end: slotEnd });
      });
    }
    date = addCalendarDays_(date, 1);
  }
  return slots;
}

function addCalendarDays_(date, amount) {
  const value = new Date(String(date) + 'T00:00:00Z');
  if (Number.isNaN(value.getTime())) calendarFail_('CALENDAR_TIME_INVALID');
  value.setUTCDate(value.getUTCDate() + Number(amount || 0));
  return value.toISOString().slice(0, 10);
}

function localDateLabel_(value) {
  const date = calendarDateTime_(value);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_BOOKING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = {}; formatter.formatToParts(date).forEach(function(part) { if (part.type !== 'literal') parts[part.type] = part.value; });
  return String(parts.year) + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
}

/**
 * The slots a client must not offer.
 *
 * `leadCutoffMs` is optional and, when supplied, reports a slot starting before
 * it as occupied. A slot inside the canonical booking lead time is not bookable,
 * so it is withheld here rather than offered and then refused on submit. The
 * comparison is deliberately the same one assertBookableSlot_ applies, so the
 * picker and the mutation guards agree at the millisecond: a slot exactly
 * BOOKING_LEAD_MINUTES away stays eligible, one millisecond nearer does not.
 *
 * Omitting it preserves the original behaviour for every other caller.
 */
function computeOccupiedSlots_(input) {
  const busy = Array.isArray(input && input.busyIntervals) ? input.busyIntervals : [];
  const reservations = Array.isArray(input && input.reservations) ? input.reservations : [];
  const slots = Array.isArray(input && input.workingSlots) ? input.workingSlots : [];
  const leadCutoff = input && input.leadCutoffMs;
  const leadCutoffMs = Number.isFinite(Number(leadCutoff)) && leadCutoff !== null && leadCutoff !== ''
    ? Number(leadCutoff) : null;
  const occupied = {};
  slots.forEach(function(slot) {
    const insideLead = leadCutoffMs !== null && Date.parse(slot.start) < leadCutoffMs;
    const calendarBusy = busy.some(function(interval) { return intervalOverlap_(slot.start, slot.end, interval.start, interval.end); });
    const internalBusy = reservations.some(function(record) {
      return reservationOccupiesSlot_(record) && record.current_start_at && record.current_end_at
        && intervalOverlap_(slot.start, slot.end, record.current_start_at, record.current_end_at);
    });
    if (insideLead || calendarBusy || internalBusy) occupied[slot.date + 'T' + slot.time] = { date: slot.date, time: slot.time };
  });
  return Object.keys(occupied).sort().map(function(key) { return occupied[key]; });
}

var __CALENDAR_TEST_EXPORTS__ = Object.freeze({
  CALENDAR_LINK_SCHEMA: CALENDAR_LINK_SCHEMA, CALENDAR_LINK_SOURCE: CALENDAR_LINK_SOURCE,
  opaqueCalendarProperties_: opaqueCalendarProperties_, eventInterval_: eventInterval_, intervalOverlap_: intervalOverlap_,
  calendarExtendedProperties_: calendarExtendedProperties_, calendarSyncHash_: calendarSyncHash_, meetFields_: meetFields_,
  createCalendarGateway_: createCalendarGateway_, computeOccupiedSlots_: computeOccupiedSlots_, availabilityBounds_: availabilityBounds_,
  workingSlots_: workingSlots_, addCalendarDays_: addCalendarDays_, localDateLabel_: localDateLabel_,
  calendarHttpStatus_: calendarHttpStatus_, calendarEventResult_: calendarEventResult_, BOOKING_LEAD_MINUTES: BOOKING_LEAD_MINUTES,
  calendarApi_: calendarApi_,
});
