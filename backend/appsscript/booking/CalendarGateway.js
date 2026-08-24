/**
 * Calendar gateway for the NONPROD booking lifecycle.
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
      const resource = { summary: 'NONPROD confirmed booking', start: { dateTime: start.toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE },
        end: { dateTime: end.toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE }, extendedProperties: opaqueCalendarProperties_(record.calendar_link_key) };
      if (options.requestMeet) {
        resource.conferenceData = { createRequest: { requestId: String(record.calendar_link_key), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      }
      return calendarEventResult_(api.Events.insert(resource, calendarId, { conferenceDataVersion: options.requestMeet ? 1 : 0, sendUpdates: 'none' }));
    },
    updateSameEvent: function(record, targetStartAt, targetEndAt) {
      const current = this.getEvent(record.calendar_event_id);
      if (!current) calendarFail_('CALENDAR_EVENT_MISSING');
      if (String(record.calendar_event_etag || '') !== String(current.etag || '')) {
        calendarConflict_('CALENDAR_ETAG_CONFLICT', 412);
      }
      const event = current.event;
      event.start = { dateTime: calendarDateTime_(targetStartAt).toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE };
      event.end = { dateTime: calendarDateTime_(targetEndAt).toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE };
      event.extendedProperties = opaqueCalendarProperties_(record.calendar_link_key);
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
      catch (error) { if (calendarHttpStatus_(error) === 404) return { ok: true, alreadyAbsent: true }; throw error; }
    },
    reconcileIncremental: function(syncToken, bounds) {
      const baseRequest = { showDeleted: true, singleEvents: false, maxResults: 2500 };
      if (syncToken) baseRequest.syncToken = String(syncToken);
      else { baseRequest.timeMin = calendarDateTime_(bounds.start).toISOString(); baseRequest.timeMax = calendarDateTime_(bounds.end).toISOString(); }
      let fullSyncReset = false; let response; let request = Object.assign({}, baseRequest); const items = [];
      try { response = api.Events.list(calendarId, request); }
      catch (error) {
        if (calendarHttpStatus_(error) !== 410 || !syncToken) throw error;
        fullSyncReset = true;
        request = { showDeleted: true, singleEvents: false, maxResults: 2500,
          timeMin: calendarDateTime_(bounds.start).toISOString(), timeMax: calendarDateTime_(bounds.end).toISOString() };
        response = api.Events.list(calendarId, request);
      }
      while (response) {
        if (Array.isArray(response.items)) items.push.apply(items, response.items);
        if (!response.nextPageToken) break;
        request = Object.assign({}, baseRequest, { pageToken: String(response.nextPageToken) });
        if (fullSyncReset) request = { showDeleted: true, singleEvents: false, maxResults: 2500,
          timeMin: calendarDateTime_(bounds.start).toISOString(), timeMax: calendarDateTime_(bounds.end).toISOString(),
          pageToken: String(response.nextPageToken) };
        response = api.Events.list(calendarId, request);
      }
      return { ok: true, fullSyncReset: fullSyncReset, nextSyncToken: String(response && response.nextSyncToken || ''),
        events: items.map(function(item) { return { event: item, linkage: calendarExtendedProperties_(item), syncHash: calendarSyncHash_(item) }; }) };
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
  return match ? Number(match[1]) : Number(error && error.status || 0);
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
        const slotStart = startAt_(date, time); const slotEnd = new Date(Date.parse(slotStart) + 3600000).toISOString();
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

function computeOccupiedSlots_(input) {
  const busy = Array.isArray(input && input.busyIntervals) ? input.busyIntervals : [];
  const reservations = Array.isArray(input && input.reservations) ? input.reservations : [];
  const slots = Array.isArray(input && input.workingSlots) ? input.workingSlots : [];
  const occupied = {};
  slots.forEach(function(slot) {
    const calendarBusy = busy.some(function(interval) { return intervalOverlap_(slot.start, slot.end, interval.start, interval.end); });
    const internalBusy = reservations.some(function(record) {
      return ACTIVE_SLOT_STATES.indexOf(record.booking_status) !== -1 && record.current_start_at && record.current_end_at
        && intervalOverlap_(slot.start, slot.end, record.current_start_at, record.current_end_at);
    });
    if (calendarBusy || internalBusy) occupied[slot.date + 'T' + slot.time] = { date: slot.date, time: slot.time };
  });
  return Object.keys(occupied).sort().map(function(key) { return occupied[key]; });
}

var __CALENDAR_TEST_EXPORTS__ = Object.freeze({
  CALENDAR_LINK_SCHEMA: CALENDAR_LINK_SCHEMA, CALENDAR_LINK_SOURCE: CALENDAR_LINK_SOURCE,
  opaqueCalendarProperties_: opaqueCalendarProperties_, eventInterval_: eventInterval_, intervalOverlap_: intervalOverlap_,
  calendarExtendedProperties_: calendarExtendedProperties_, calendarSyncHash_: calendarSyncHash_, meetFields_: meetFields_,
  createCalendarGateway_: createCalendarGateway_, computeOccupiedSlots_: computeOccupiedSlots_, availabilityBounds_: availabilityBounds_,
  workingSlots_: workingSlots_, addCalendarDays_: addCalendarDays_, localDateLabel_: localDateLabel_,
  calendarHttpStatus_: calendarHttpStatus_, calendarEventResult_: calendarEventResult_,
});
