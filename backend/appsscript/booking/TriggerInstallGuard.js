/**
 * Production lifecycle trigger install guard.
 *
 * Apps Script Trigger objects do NOT expose their clock cadence for runtime
 * read-back: an installed Trigger has no public everyMinutes getter. Any
 * verifier that claims to read cadence back from a live Trigger object is a
 * false positive, and treating an unknown cadence as valid is worse than
 * failing. Cadence here is therefore proven by construction:
 *
 *   1. this installer is the only writer, and it always creates target
 *      triggers with timeBased().everyMinutes(<5-minute constant>).create();
 *   2. it persists non-secret install metadata naming each created trigger
 *      unique ID plus the cadence it was created with;
 *   3. verification re-reads the current project triggers and requires the
 *      current unique ID and CLOCK trigger source to match that metadata.
 *
 * cadenceVerification      = INSTALL_METADATA_PLUS_TRIGGER_ID
 * runtimeCadenceIntrospection = false
 *
 * Rerunning the installer is CONVERGENT, not identity-preserving idempotency.
 * Each run recreates both target triggers (new unique IDs) and converges on
 * exactly one current trigger per target handler. Unrelated project triggers
 * are never modified. No secret is read, logged, or persisted by this module.
 */
var PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_PROPERTY = 'PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_V1';
var PRODUCTION_LIFECYCLE_TRIGGER_META_VERSION = 'v1';
var PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION = 'INSTALL_METADATA_PLUS_TRIGGER_ID';
var PRODUCTION_LIFECYCLE_TRIGGER_RUNTIME_CADENCE_INTROSPECTION = false;
var PRODUCTION_LIFECYCLE_TRIGGER_FORBIDDEN_HANDLER_PATTERN = /nonprod|fixture|test|sandbox/i;

function productionLifecycleTriggerTargets_() {
  return [
    { handler: PRODUCTION_NOTIFICATION_RETRY_HANDLER,
      intervalMinutes: Number(PRODUCTION_NOTIFICATION_RETRY_INTERVAL_MINUTES) },
    { handler: PRODUCTION_CALENDAR_RECONCILIATION_HANDLER,
      intervalMinutes: Number(PRODUCTION_CALENDAR_RECONCILIATION_INTERVAL_MINUTES) },
  ];
}

// The single configured lifecycle cadence. Both target handlers must agree.
function productionLifecycleTriggerCadenceMinutes_() {
  const cadence = Number(PRODUCTION_NOTIFICATION_RETRY_INTERVAL_MINUTES);
  if (!(cadence > 0) || Math.floor(cadence) !== cadence) fail_('TRIGGER_CADENCE_CONTRACT_INVALID');
  if (Number(PRODUCTION_CALENDAR_RECONCILIATION_INTERVAL_MINUTES) !== cadence) {
    fail_('TRIGGER_CADENCE_CONTRACT_INVALID');
  }
  return cadence;
}

function productionClockTriggerSource_() {
  if (typeof ScriptApp !== 'undefined' && ScriptApp && ScriptApp.TriggerSource
    && ScriptApp.TriggerSource.CLOCK) {
    return String(ScriptApp.TriggerSource.CLOCK);
  }
  return 'CLOCK';
}

function isClockTriggerSource_(trigger) {
  if (!trigger || typeof trigger.getTriggerSource !== 'function') return false;
  return String(trigger.getTriggerSource()) === productionClockTriggerSource_();
}

function triggerHandlerName_(trigger) {
  if (!trigger || typeof trigger.getHandlerFunction !== 'function') return '';
  return String(trigger.getHandlerFunction() || '');
}

function triggerUniqueIdOrEmpty_(trigger) {
  if (!trigger || typeof trigger.getUniqueId !== 'function') return '';
  return String(trigger.getUniqueId() || '');
}

function productionLifecycleTriggerMetaProperties_() {
  return PropertiesService.getScriptProperties();
}

function readProductionLifecycleTriggerInstallMeta_() {
  const raw = String(productionLifecycleTriggerMetaProperties_()
    .getProperty(PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_PROPERTY) || '').trim();
  if (!raw) return { present: false, valid: false, meta: null };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { present: true, valid: false, meta: null };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.triggers)) {
    return { present: true, valid: false, meta: null };
  }
  return { present: true, valid: true, meta: parsed };
}

function deleteProductionLifecycleTriggerInstallMeta_() {
  try {
    productionLifecycleTriggerMetaProperties_()
      .deleteProperty(PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_PROPERTY);
  } catch (error) {
    // Best effort only. A missing or unwritable metadata property still fails
    // verification closed, which is the safe direction.
  }
  return true;
}

/**
 * Deterministic installer. Operator-only. readConfig_ keeps it fail-closed on
 * a non-Production configuration. Convergent: recreates both target triggers.
 */
function installProductionLifecycleTriggersDeterministic_() {
  readConfig_();
  const cadenceMinutes = productionLifecycleTriggerCadenceMinutes_();
  const targets = productionLifecycleTriggerTargets_();
  const targetHandlers = targets.map(function(target) { return target.handler; });
  const properties = productionLifecycleTriggerMetaProperties_();
  const created = [];
  try {
    targets.forEach(function(target) {
      if (Number(target.intervalMinutes) !== cadenceMinutes) fail_('TRIGGER_CADENCE_CONTRACT_INVALID');
      if (PRODUCTION_LIFECYCLE_TRIGGER_FORBIDDEN_HANDLER_PATTERN.test(target.handler)) {
        fail_('TRIGGER_HANDLER_NOT_ALLOWED');
      }
      const trigger = ScriptApp.newTrigger(target.handler).timeBased()
        .everyMinutes(cadenceMinutes).create();
      const uniqueId = triggerUniqueIdOrEmpty_(trigger);
      if (!uniqueId) fail_('TRIGGER_INSTALL_FAILED');
      if (triggerHandlerName_(trigger) !== target.handler) fail_('TRIGGER_INSTALL_FAILED');
      if (!isClockTriggerSource_(trigger)) fail_('TRIGGER_SOURCE_INVALID');
      created.push({ handler: target.handler, intervalMinutes: cadenceMinutes,
        uniqueId: uniqueId, trigger: trigger });
    });
  } catch (error) {
    // Roll back only what this run created. Unrelated and pre-existing target
    // triggers stay untouched, and partial metadata must not survive.
    created.forEach(function(item) {
      try {
        ScriptApp.deleteTrigger(item.trigger);
      } catch (ignored) {
        // best effort
      }
    });
    deleteProductionLifecycleTriggerInstallMeta_();
    throw error;
  }

  const keepIds = created.map(function(item) { return item.uniqueId; });
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    const handler = triggerHandlerName_(trigger);
    if (targetHandlers.indexOf(handler) === -1) return;
    if (keepIds.indexOf(triggerUniqueIdOrEmpty_(trigger)) !== -1) return;
    ScriptApp.deleteTrigger(trigger);
    removed += 1;
  });

  properties.setProperty(PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_PROPERTY, JSON.stringify({
    version: PRODUCTION_LIFECYCLE_TRIGGER_META_VERSION,
    installedAt: new Date().toISOString(),
    cadenceVerification: PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION,
    runtimeCadenceIntrospection: PRODUCTION_LIFECYCLE_TRIGGER_RUNTIME_CADENCE_INTROSPECTION,
    triggers: created.map(function(item) {
      return { handler: item.handler, intervalMinutes: item.intervalMinutes, uniqueId: item.uniqueId };
    }),
  }));

  const verification = verifyProductionLifecycleTriggersDeterministic_();
  if (!verification.ok) fail_('TRIGGER_INSTALL_VERIFICATION_FAILED');
  return operatorLog_({
    ok: true,
    behavior: 'CONVERGENT_RECREATE',
    cadenceMinutes: cadenceMinutes,
    cadenceVerification: PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION,
    runtimeCadenceIntrospection: PRODUCTION_LIFECYCLE_TRIGGER_RUNTIME_CADENCE_INTROSPECTION,
    created: created.map(function(item) {
      return { handler: item.handler, intervalMinutes: item.intervalMinutes, uniqueId: item.uniqueId };
    }),
    replaced: removed,
    verification: verification,
  });
}

/**
 * Deterministic verifier. Read-only. Never reads runtime cadence from a
 * Trigger object; cadence evidence comes from install metadata bound to the
 * current trigger unique IDs.
 */
function verifyProductionLifecycleTriggersDeterministic_() {
  const cadenceMinutes = productionLifecycleTriggerCadenceMinutes_();
  const targets = productionLifecycleTriggerTargets_();
  const expectedHandlers = targets.map(function(target) { return target.handler; });
  const stored = readProductionLifecycleTriggerInstallMeta_();
  const metadataPresent = stored.present && stored.valid;
  const meta = stored.meta;
  const metadataMismatch = [];
  const missing = [];
  const duplicates = [];
  const wrongSource = [];
  const idMismatch = [];
  const unexpectedNonprod = [];

  if (!stored.present) metadataMismatch.push('METADATA_MISSING');
  else if (!stored.valid) metadataMismatch.push('METADATA_INVALID_JSON');
  else {
    if (String(meta.version || '') !== PRODUCTION_LIFECYCLE_TRIGGER_META_VERSION) {
      metadataMismatch.push('METADATA_VERSION_UNEXPECTED');
    }
    if (String(meta.cadenceVerification || '') !== PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION) {
      metadataMismatch.push('METADATA_CADENCE_VERIFICATION_UNEXPECTED');
    }
    if (meta.runtimeCadenceIntrospection !== false) {
      metadataMismatch.push('METADATA_CLAIMS_RUNTIME_CADENCE_INTROSPECTION');
    }
    if (!String(meta.installedAt || '').trim()) metadataMismatch.push('METADATA_INSTALLED_AT_MISSING');
    if (meta.triggers.length !== expectedHandlers.length) metadataMismatch.push('METADATA_TRIGGER_COUNT_UNEXPECTED');
    const seen = [];
    meta.triggers.forEach(function(entry) {
      const handler = String(entry && entry.handler || '');
      if (expectedHandlers.indexOf(handler) === -1) {
        metadataMismatch.push('METADATA_HANDLER_UNEXPECTED');
        return;
      }
      if (seen.indexOf(handler) !== -1) metadataMismatch.push('METADATA_HANDLER_DUPLICATED');
      seen.push(handler);
      if (Number(entry.intervalMinutes) !== cadenceMinutes) metadataMismatch.push('METADATA_CADENCE_UNEXPECTED');
      if (!String(entry.uniqueId || '').trim()) metadataMismatch.push('METADATA_UNIQUE_ID_MISSING');
    });
  }

  const all = ScriptApp.getProjectTriggers();
  targets.forEach(function(target) {
    const matches = all.filter(function(trigger) {
      return triggerHandlerName_(trigger) === target.handler;
    });
    if (!matches.length) {
      missing.push(target.handler);
      return;
    }
    if (matches.length > 1) {
      duplicates.push(target.handler);
      return;
    }
    const current = matches[0];
    if (!isClockTriggerSource_(current)) wrongSource.push(target.handler);
    const expectedId = metadataPresent ? metadataUniqueIdForHandler_(meta, target.handler) : '';
    const currentId = triggerUniqueIdOrEmpty_(current);
    if (!expectedId || !currentId || expectedId !== currentId) idMismatch.push(target.handler);
  });

  all.forEach(function(trigger) {
    const handler = triggerHandlerName_(trigger);
    if (expectedHandlers.indexOf(handler) !== -1) return;
    if (PRODUCTION_LIFECYCLE_TRIGGER_FORBIDDEN_HANDLER_PATTERN.test(handler)) unexpectedNonprod.push(handler);
  });

  return operatorLog_({
    ok: metadataPresent && metadataMismatch.length === 0 && missing.length === 0
      && duplicates.length === 0 && wrongSource.length === 0 && idMismatch.length === 0
      && unexpectedNonprod.length === 0,
    expectedHandlers: expectedHandlers,
    cadenceMinutes: cadenceMinutes,
    cadenceVerification: PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION,
    runtimeCadenceIntrospection: PRODUCTION_LIFECYCLE_TRIGGER_RUNTIME_CADENCE_INTROSPECTION,
    metadataPresent: metadataPresent,
    missing: missing,
    duplicates: duplicates,
    wrongSource: wrongSource,
    idMismatch: idMismatch,
    metadataMismatch: metadataMismatch,
    unexpectedNonprod: unexpectedNonprod,
  });
}

function metadataUniqueIdForHandler_(meta, handler) {
  if (!meta || !Array.isArray(meta.triggers)) return '';
  for (let i = 0; i < meta.triggers.length; i += 1) {
    const entry = meta.triggers[i];
    if (String(entry && entry.handler || '') === handler) return String(entry.uniqueId || '');
  }
  return '';
}

var __TRIGGER_INSTALL_GUARD_TEST_EXPORTS__ = Object.freeze({
  installProductionLifecycleTriggersDeterministic_: installProductionLifecycleTriggersDeterministic_,
  verifyProductionLifecycleTriggersDeterministic_: verifyProductionLifecycleTriggersDeterministic_,
  productionLifecycleTriggerTargets_: productionLifecycleTriggerTargets_,
  productionLifecycleTriggerCadenceMinutes_: productionLifecycleTriggerCadenceMinutes_,
  readProductionLifecycleTriggerInstallMeta_: readProductionLifecycleTriggerInstallMeta_,
  deleteProductionLifecycleTriggerInstallMeta_: deleteProductionLifecycleTriggerInstallMeta_,
  isClockTriggerSource_: isClockTriggerSource_,
  PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_PROPERTY: PRODUCTION_LIFECYCLE_TRIGGER_INSTALL_META_PROPERTY,
  PRODUCTION_LIFECYCLE_TRIGGER_META_VERSION: PRODUCTION_LIFECYCLE_TRIGGER_META_VERSION,
  PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION: PRODUCTION_LIFECYCLE_TRIGGER_CADENCE_VERIFICATION,
  PRODUCTION_LIFECYCLE_TRIGGER_RUNTIME_CADENCE_INTROSPECTION: PRODUCTION_LIFECYCLE_TRIGGER_RUNTIME_CADENCE_INTROSPECTION,
});

// Public operator entry points. Delegation only, so the deterministic
// installer/verifier above can be selected in the Apps Script editor's Run
// menu; a trailing underscore makes a function private there.
function opInstallLifecycleTriggers() {
  return installProductionLifecycleTriggersDeterministic_();
}

function opVerifyLifecycleTriggers() {
  return verifyProductionLifecycleTriggersDeterministic_();
}
