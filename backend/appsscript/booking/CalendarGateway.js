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
      const event = current.event;
      event.start = { dateTime: calendarDateTime_(targetStartAt).toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE };
      event.end = { dateTime: calendarDateTime_(targetEndAt).toISOString(), timeZone: DEFAULT_BOOKING_TIME_ZONE };
      event.extendedProperties = opaqueCalendarProperties_(record.calendar_link_key);
      // Sending conferenceDataVersion while retaining event.conferenceData
      // preserves Meet on the same event. Sandbox must prove this behavior.
      return calendarEventResult_(api.Events.update(calendarId, event.id, event, { conferenceDataVersion: 1, sendUpdates: 'none' }));
    },
    cancelLinkedEvent: function(record) {
      if (!record.calendar_event_id) return { ok: true, alreadyAbsent: true };
      try { api.Events.delete(calendarId, String(record.calendar_event_id), { sendUpdates: 'none' }); return { ok: true, deleted: true }; }
      catch (error) { if (calendarHttpStatus_(error) === 404) return { ok: true, alreadyAbsent: true }; throw error; }
    },
    reconcileIncremental: function(syncToken, bounds) {
      const request = { showDeleted: true, singleEvents: false, maxResults: 2500 };
      if (syncToken) request.syncToken = String(syncToken);
      else { request.timeMin = calendarDateTime_(bounds.start).toISOString(); request.timeMax = calendarDateTime_(bounds.end).toISOString(); }
      let fullSyncReset = false; let response;
      try { response = api.Events.list(calendarId, request); }
      catch (error) {
        if (calendarHttpStatus_(error) !== 410 || !syncToken) throw error;
        fullSyncReset = true;
        response = api.Events.list(calendarId, { showDeleted: true, singleEvents: false, maxResults: 2500,
          timeMin: calendarDateTime_(bounds.start).toISOString(), timeMax: calendarDateTime_(bounds.end).toISOString() });
      }
      const items = response && Array.isArray(response.items) ? response.items : [];
      return { ok: true, fullSyncReset: fullSyncReset, nextSyncToken: String(response.nextSyncToken || ''),
        events: items.map(function(item) { return { event: item, linkage: calendarExtendedProperties_(item), syncHash: calendarSyncHash_(item) }; }) };
    },
    isSlotAvailable: function(start, end, currentEventId) {
      return this.freeBusy(start, end).every(function(interval) {
        return String(interval.eventId || '') === String(currentEventId || '')
          || !intervalOverlap_(start, end, interval.start, interval.end);
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
  const endDate = new Date(Date.parse(start) + AVAILABILITY_HORIZON_DAYS * 86400000).toISOString().slice(0, 10);
  return { start: start, end: startAt_(endDate, '23:59') };
}

function workingSlots_(start, end, requestedDate) {
  const slots = []; const cursor = new Date(start); const last = new Date(end);
  while (cursor.getTime() <= last.getTime()) {
    const date = cursor.toISOString().slice(0, 10);
    if ((!requestedDate || date === requestedDate) && cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      WORKING_HOURS.forEach(function(time) {
        const slotStart = startAt_(date, time); const slotEnd = new Date(Date.parse(slotStart) + 3600000).toISOString();
        slots.push({ date: date, time: time, start: slotStart, end: slotEnd });
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return slots;
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
  workingSlots_: workingSlots_, calendarHttpStatus_: calendarHttpStatus_, calendarEventResult_: calendarEventResult_,
});
