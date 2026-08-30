/**
 * Test-local Date for Apps Script VM harnesses.
 *
 * Controls Date.now() and `new Date()` with no arguments. Explicit
 * constructors, Date.parse, Date.UTC, and instance methods keep native
 * semantics. Never import this into production source.
 *
 * Frozen civil time: Tuesday 2026-08-25 09:00 America/Santiago (CLT, UTC-4).
 * Relative to that instant, 2026-08-27 and 2026-09-03 weekdays stay inside
 * the 120-minute lead time and 90-day horizon without wall-clock maintenance.
 */
export const FIXED_TEST_NOW_ISO = '2026-08-25T13:00:00.000Z';
export const FIXED_TEST_NOW_MS = Date.parse(FIXED_TEST_NOW_ISO);

export function createFixedDate(nowMs = FIXED_TEST_NOW_MS) {
  const frozenMs = Number(nowMs);
  if (!Number.isFinite(frozenMs)) {
    throw new TypeError('createFixedDate requires a finite epoch milliseconds value');
  }
  class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(frozenMs);
      else super(...args);
    }

    static now() {
      return frozenMs;
    }
  }
  Object.defineProperty(FixedDate, 'parse', {
    value: Date.parse,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(FixedDate, 'UTC', {
    value: Date.UTC,
    writable: true,
    configurable: true,
  });
  return FixedDate;
}
