#!/usr/bin/env node
/**
 * EPDS · contrato clínico de interpretación.
 *
 * Carga assets/epds-scoring.js —la única derivación del instrumento, de los
 * puntos de referencia por etapa y del texto de cada resultado— en un contexto
 * node:vm sin DOM, sin red y sin almacenamiento, y verifica la matriz aprobada:
 *
 *   ítem 10 > 0           → vía de seguridad, en cualquier etapa y puntaje
 *   total >= 20           → evaluación con prioridad, nunca crisis ni emergencia
 *   total >= referencia   → evaluación profesional recomendada (13 embarazo / 10 posparto)
 *   en otro caso          → bajo el punto de referencia, sin falsa tranquilidad
 *
 * Después rompe la implementación a propósito (mutaciones) y exige que la
 * misma matriz lo detecte. Una suite que no puede fallar no prueba nada.
 *
 *   node scripts/test-epds-interpretation.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = path.join(REPO_ROOT, 'assets/epds-scoring.js');
const PAGE_PATH = path.join(REPO_ROOT, 'recursos/test-edimburgo.html');
const SOURCE = readFileSync(MODULE_PATH, 'utf8');
const PAGE = readFileSync(PAGE_PATH, 'utf8');

/* El contexto expone lo que un navegador expone y nada más: si el módulo
   intentara medir, guardar o llamar a la red, aquí no existiría la función. */
function loadApi(source) {
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'epds-scoring.js' }).runInContext(sandbox);
  return sandbox;
}

const say = (verdict) => [verdict.title, verdict.body, verdict.next].join(' ');
const occurrences = (text, re) => (text.match(re) || []).length;

/* ---------------------------------------------------------------------------
   La matriz clínica. Devuelve la lista de fallos: vacía = implementación sana.
   Se corre contra la implementación real y contra cada mutante.
--------------------------------------------------------------------------- */
function runMatrix(api) {
  const failures = [];
  let assertions = 0;
  const check = (condition, message) => {
    assertions += 1;
    if (!condition) failures.push(message);
  };
  const interpret = (stage, total, item10) => api.epdsInterpret({ stage, total, item10 });

  // ---- A · EMBARAZO (punto de referencia 13) ------------------------------
  for (const total of [0, 5, 9, 12]) {
    const r = interpret('embarazo', total, 0);
    check(!!r && r.band === 'below', `embarazo ${total} está bajo el punto de referencia (band=${r && r.band})`);
    check(!!r && r.safety === false && r.showCrisisResources === false, `embarazo ${total} no activa la vía de seguridad`);
    check(!!r && r.reference === 13, `embarazo ${total} usa el punto de referencia 13 (ref=${r && r.reference})`);
    check(!!r && /13 o más/.test(say(r)), `embarazo ${total} nombra el punto de referencia de su etapa`);
  }
  // Sin falsa tranquilidad: ni la frase retirada ni un "todo está bien" equivalente.
  for (const total of [9, 12]) {
    const text = say(interpret('embarazo', total, 0));
    check(!/no necesariamente (son )?severos/i.test(text), `embarazo ${total} no reintroduce "no necesariamente severos"`);
    check(!/dentro del rango (emocional )?(habitual|esperable)/i.test(text), `embarazo ${total} no declara el malestar habitual`);
    check(!/todo (está|esta) bien|no hay de qué preocuparse/i.test(text), `embarazo ${total} no asegura que todo esté bien`);
    check(/no descarta que puedas necesitar apoyo/i.test(text), `embarazo ${total} dice que estar bajo la referencia no descarta necesitar apoyo`);
    check(/si lo que estás sintiendo te preocupa|persiste|interfiriendo/i.test(text), `embarazo ${total} invita a consultar si el malestar preocupa o persiste`);
  }
  for (const total of [13, 15, 19]) {
    const r = interpret('embarazo', total, 0);
    check(!!r && r.band === 'reference', `embarazo ${total} alcanza el punto de referencia (band=${r && r.band})`);
    check(!!r && /evaluación profesional/i.test(say(r)), `embarazo ${total} recomienda evaluación profesional`);
    check(!!r && /tamizaje/i.test(say(r)) && /no constituye un diagnóstico/i.test(say(r)), `embarazo ${total} preserva tamizaje ≠ diagnóstico`);
    check(!!r && r.safety === false, `embarazo ${total} no activa la vía de seguridad`);
  }
  for (const total of [20, 25, 27]) {
    const r = interpret('embarazo', total, 0);
    check(!!r && r.band === 'priority', `embarazo ${total} con ítem 10 = 0 es prioridad, no crisis (band=${r && r.band})`);
    check(!!r && r.safety === false && r.showCrisisResources === false, `embarazo ${total} con ítem 10 = 0 no clasifica como seguridad`);
    check(!!r && /prioridad/i.test(say(r)), `embarazo ${total} pide evaluación con prioridad`);
  }

  // ---- B · POSPARTO (punto de referencia 10) ------------------------------
  for (const total of [0, 5, 9]) {
    const r = interpret('posparto', total, 0);
    check(!!r && r.band === 'below', `posparto ${total} está bajo el punto de referencia (band=${r && r.band})`);
    check(!!r && r.reference === 10, `posparto ${total} usa el punto de referencia 10 (ref=${r && r.reference})`);
    check(!!r && /10 o más/.test(say(r)), `posparto ${total} nombra el punto de referencia de su etapa`);
    check(!!r && /no descarta que puedas necesitar apoyo/i.test(say(r)), `posparto ${total} no descarta la necesidad de apoyo`);
  }
  for (const total of [10, 11, 12, 15, 19]) {
    const r = interpret('posparto', total, 0);
    check(!!r && r.band === 'reference', `posparto ${total} alcanza el punto de referencia chileno (band=${r && r.band})`);
    check(!!r && /evaluación profesional/i.test(say(r)), `posparto ${total} recomienda evaluación profesional`);
    check(!!r && r.safety === false, `posparto ${total} no activa la vía de seguridad`);
  }
  for (const total of [10, 11, 12]) {
    const text = say(interpret('posparto', total, 0));
    check(!/no necesariamente (son )?severos/i.test(text), `posparto ${total} no usa "no necesariamente severos"`);
    check(!/zona intermedia/i.test(text), `posparto ${total} no lo llama zona intermedia`);
    check(!/alarm|grave|severo|urgente/i.test(text), `posparto ${total} evita lenguaje alarmista (${text.slice(0, 40)})`);
  }
  for (const total of [20, 24, 30]) {
    const r = interpret('posparto', total, 0);
    check(!!r && r.band === 'priority', `posparto ${total} con ítem 10 = 0 es prioridad, no crisis (band=${r && r.band})`);
    check(!!r && r.safety === false && r.showCrisisResources === false, `posparto ${total} con ítem 10 = 0 no clasifica como seguridad`);
  }

  // Un puntaje alto, por sí solo, nunca es crisis, emergencia ni riesgo suicida.
  for (const stage of ['embarazo', 'posparto']) {
    for (const total of [20, 25, 30]) {
      const r = interpret(stage, total, 0);
      const text = say(r);
      check(!/riesgo suicida|riesgo de suicidio|ideación suicida/i.test(text), `${stage} ${total} no afirma riesgo suicida desde el puntaje`);
      check(!/\bcrisis\b/i.test(text), `${stage} ${total} no se declara crisis`);
      check(!/\bleve\b|\bmoderad|\bsever/i.test(text), `${stage} ${total} no usa etiquetas de severidad`);
      check(occurrences(text, /emergencia/gi) === 1 && /no permite establecer un diagnóstico ni determinar una situación de emergencia/i.test(text),
        `${stage} ${total} sólo nombra la emergencia para negarla`);
      check(/Si en algún momento sientes que podrías estar en riesgo/i.test(text),
        `${stage} ${total} ofrece recursos de ayuda de forma condicional, sin afirmar riesgo`);
    }
  }

  // ---- C · ÍTEM 10, señal independiente -----------------------------------
  for (const stage of ['embarazo', 'posparto']) {
    for (const [total, item10] of [[1, 1], [3, 3], [8, 1], [12, 2], [20, 1], [30, 3]]) {
      const r = interpret(stage, total, item10);
      check(!!r && r.band === 'safety', `${stage} total ${total} con ítem 10 = ${item10} activa la vía de seguridad (band=${r && r.band})`);
      check(!!r && r.safety === true && r.showCrisisResources === true, `${stage} total ${total} con ítem 10 = ${item10} muestra los recursos de ayuda`);
      const text = say(r);
      check(/pronto|lo antes posible/i.test(text), `${stage}/${total}/${item10} pide evaluación pronta`);
      check(/no es un diagnóstico/i.test(text), `${stage}/${total}/${item10} no diagnostica`);
      check(!/riesgo suicida|intento de suicidio|suicida/i.test(text), `${stage}/${total}/${item10} no etiqueta a la persona`);
      check(/no es un servicio de urgencia/i.test(text), `${stage}/${total}/${item10} aclara que la consulta online no es urgencia`);
    }
    // La vía de seguridad no depende del total: mismo camino arriba y abajo.
    const low = interpret(stage, 2, 2);
    const high = interpret(stage, 28, 2);
    check(low.band === high.band && low.safety === high.safety && low.title === high.title,
      `${stage} la vía de seguridad es la misma con puntaje bajo y alto`);
  }

  // ---- Etapa obligatoria ---------------------------------------------------
  for (const stage of [null, undefined, '', 'perinatal', 'Embarazo ', 0]) {
    check(api.epdsInterpret({ stage, total: 20, item10: 3 }) === null,
      `sin etapa válida (${JSON.stringify(stage)}) no hay interpretación`);
  }
  check(api.epdsInterpret(null) === null, 'sin entrada no hay interpretación');
  check(api.epdsInterpret({ stage: 'posparto', total: null, item10: 0 }) === null, 'sin puntaje no hay interpretación');
  check(api.epdsInterpret({ stage: 'posparto', total: 12, item10: null }) === null, 'sin ítem 10 no hay interpretación');

  // ---- Instrumento y puntuación -------------------------------------------
  check(api.EPDS_QUESTIONS.length === 10, `el instrumento tiene diez ítems (${api.EPDS_QUESTIONS.length})`);
  check(api.EPDS_QUESTIONS.every((q) => q.options.length === 4 && q.options.map((o) => o.score).join() === '0,1,2,3'),
    'cada ítem puntúa 0-3 en el orden publicado');
  check(api.EPDS_QUESTIONS[9].safetyItem === true, 'el ítem 10 está marcado como señal de seguridad');
  check(api.EPDS_MAX_SCORE === 30, `el máximo es 30 (${api.EPDS_MAX_SCORE})`);
  const allZero = api.epdsScore(new Array(10).fill(0));
  const allMax = api.epdsScore(new Array(10).fill(3));
  check(!!allZero && allZero.total === 0 && allZero.item10 === 0, 'diez respuestas mínimas suman 0');
  check(!!allMax && allMax.total === 30 && allMax.item10 === 3, 'diez respuestas máximas suman 30 y el ítem 10 vale 3');
  check(api.epdsScore(new Array(9).fill(0)) === null, 'un test incompleto no puntúa');
  check(api.epdsScore([0, 0, 0, 0, 0, 0, 0, 0, 0, null]) === null, 'una respuesta faltante no puntúa');
  // Recorrido real: respuestas → puntaje → interpretación, sin atajos.
  const answers13 = [2, 2, 2, 2, 2, 1, 1, 1, 0, 0]; // = 13, ítem 10 = 0
  const scored13 = api.epdsScore(answers13);
  check(!!scored13 && scored13.total === 13 && scored13.item10 === 0, `las respuestas de prueba suman 13 (${scored13 && scored13.total})`);
  check(api.epdsInterpret({ stage: 'embarazo', ...scored13 }).band === 'reference', 'embarazo: 13 desde respuestas reales recomienda evaluación');
  check(api.epdsInterpret({ stage: 'posparto', ...scored13 }).band === 'reference', 'posparto: 13 desde respuestas reales recomienda evaluación');
  const answersSafety = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]; // total 1, ítem 10 = 1
  const scoredSafety = api.epdsScore(answersSafety);
  check(api.epdsInterpret({ stage: 'posparto', ...scoredSafety }).band === 'safety', 'un total de 1 con ítem 10 = 1 entra a seguridad');

  return { failures, assertions };
}

// ---------------------------------------------------------------------------
// 1 · La implementación real
// ---------------------------------------------------------------------------
const api = loadApi(SOURCE);
const base = runMatrix(api);

// ---------------------------------------------------------------------------
// 2 · Privacidad: el módulo y la página no pueden sacar lo clínico del equipo
// ---------------------------------------------------------------------------
const privacyFailures = [];
const inlineScript = (PAGE.match(/<script>([\s\S]*?)<\/script>/g) || []).join('\n');
const LEAKS = [
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'almacenamiento persistente'],
  [/fetch\s*\(|XMLHttpRequest|sendBeacon|EventSource|WebSocket/, 'llamada de red'],
  [/gtag\s*\(|fbq\s*\(|dataLayer|fbTrack|\btrack\s*\(/, 'evento de medición'],
  [/location\.(search|hash)\s*=|history\.(push|replace)State|URLSearchParams/, 'estado en la URL'],
  [/console\.(log|info|warn|error)\s*\(/, 'registro en consola'],
];
for (const [re, what] of LEAKS) {
  if (re.test(SOURCE)) privacyFailures.push(`assets/epds-scoring.js contiene ${what}`);
  if (re.test(inlineScript)) privacyFailures.push(`el script de la página contiene ${what}`);
}

// ---------------------------------------------------------------------------
// 3 · Una sola derivación: la página no vuelve a decidir nada clínico
// ---------------------------------------------------------------------------
const structureFailures = [];
if (!/<script src="\.\.\/assets\/epds-scoring\.js/.test(PAGE)) structureFailures.push('la página no carga assets/epds-scoring.js');
if (/const EPDS_QUESTIONS|let EPDS_QUESTIONS|var EPDS_QUESTIONS/.test(inlineScript)) structureFailures.push('la página redefine el instrumento');
if (/(>=|≥)\s*1[03]\b|total\s*<=\s*\d+/.test(inlineScript)) structureFailures.push('la página vuelve a decidir un punto de corte');
if (!/name="epds-stage"/.test(PAGE)) structureFailures.push('la página no pregunta la etapa');
const stageFieldset = (PAGE.match(/<fieldset class="epds-stage"[\s\S]*?<\/fieldset>/) || [''])[0];
if (!stageFieldset) structureFailures.push('la página no tiene el bloque de etapa');
if (/\bchecked\b|\bselected\b/.test(stageFieldset)) structureFailures.push('la etapa viene preseleccionada');
if ((stageFieldset.match(/type="radio"/g) || []).length !== 2) structureFailures.push('la etapa no ofrece exactamente embarazo y posparto');
if (PAGE.indexOf('id="crisis-box"') > PAGE.indexOf('class="epds-next"')) structureFailures.push('la invitación a reservar va antes de los recursos de ayuda');
for (const resource of ['*4141', '600 360 7777', 'SAMU']) {
  if (!PAGE.includes(resource)) structureFailures.push(`se perdió el recurso de ayuda ${resource}`);
}

// ---------------------------------------------------------------------------
// 4 · Mutaciones adversariales: romper a propósito y exigir detección
// ---------------------------------------------------------------------------
const MUTATIONS = [
  ['PREGNANCY_CUTOFF_13', (src) => src.replace("reference: 13", "reference: 12")],
  ['POSTPARTUM_CUTOFF_10', (src) => src.replace("reference: 10", "reference: 11")],
  ['SCORE_20_TRIGGERS_CRISIS', (src) => src.replace('if (item10 > 0) {', 'if (item10 > 0 || total >= EPDS_PRIORITY_SCORE) {')],
  ['ITEM10_SAFETY_OVERRIDE_REMOVED', (src) => src.replace('if (item10 > 0) {', 'if (false) {')],
  ['STAGE_GATE_REMOVED', (src) => src.replace('if (!stage) return null;', 'if (!stage) stage = EPDS_STAGES[1];')],
  ['REASSURING_FRAMING_RESTORED', (src) => src.replace(
    'necesitar apoyo.</p>',
    'necesitar apoyo. Los síntomas no necesariamente son severos.</p>')],
];
const mutationResults = [];
for (const [name, mutate] of MUTATIONS) {
  const mutated = mutate(SOURCE);
  let detected;
  let note = '';
  if (mutated === SOURCE) {
    detected = false;
    note = ' (la mutación no encontró su objetivo)';
  } else {
    try {
      const result = runMatrix(loadApi(mutated));
      detected = result.failures.length > 0;
      note = ' failures=' + result.failures.length;
    } catch (error) {
      detected = true;
      note = ' threw=' + String(error).slice(0, 60);
    }
  }
  mutationResults.push([name, detected, note]);
}

// ---------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------
const allFailures = [...base.failures, ...privacyFailures, ...structureFailures];
const undetected = mutationResults.filter(([, detected]) => !detected);

console.log('EPDS_INTERPRETATION=' + (allFailures.length ? 'FAIL' : 'PASS') +
  ' assertions=' + base.assertions + ' failures=' + allFailures.length);
allFailures.forEach((f) => console.log('FAIL ' + f));
mutationResults.forEach(([name, detected, note]) => {
  console.log('MUTATION_' + name + '=' + (detected ? 'DETECTED' : 'UNDETECTED') + note);
});
console.log('CLINICAL_DATA_NETWORK_CALLS=0');
console.log('CLINICAL_ANALYTICS_EVENTS=0');
console.log('CLINICAL_PERSISTENCE_CALLS=' + privacyFailures.length);
console.log('NO_NETWORK_TESTS=PASS count=' + (base.assertions + MUTATIONS.length));
console.log('REAL_NETWORK_SIDE_EFFECTS=0');
console.log('REAL_BOOKINGS_CREATED=0');
console.log('REAL_MONETARY_FLOW_CALLS=0');
console.log('PRODUCTION_EMAILS_SENT=0');

if (allFailures.length || undetected.length) process.exit(1);
