/* ==================================================
   EPDS · Escala de Depresión Postnatal de Edimburgo
   Cox, Holden & Sagovsky (1987). Instrumento de tamizaje.

   Este archivo es la ÚNICA derivación de:
     · los diez ítems y su puntaje,
     · los puntos de referencia por etapa (embarazo 13, posparto 10),
     · la señal de seguridad independiente del ítem 10,
     · el texto de cada resultado.
   La página no vuelve a decidir ninguna de esas cosas.

   Todo ocurre en el dispositivo. Este módulo no lee ni escribe almacenamiento,
   no emite eventos de medición y no hace ninguna llamada de red: la etapa, las
   respuestas, el puntaje, el ítem 10 y el resultado viven sólo en memoria.

   La EPDS es tamizaje: orienta cuándo conviene una evaluación profesional.
   No diagnostica depresión ni ninguna otra condición de salud mental, y un
   puntaje —por alto que sea— no establece por sí solo una emergencia.
   ================================================== */
(function (global) {
  'use strict';

  var EPDS_QUESTIONS = [
    {
      text: "He podido reír y ver el lado gracioso de las cosas",
      options: [
        { text: "Tanto como siempre", score: 0 },
        { text: "No tanto ahora", score: 1 },
        { text: "Mucho menos", score: 2 },
        { text: "No, nada", score: 3 },
      ],
    },
    {
      text: "He mirado el futuro con placer",
      options: [
        { text: "Tanto como siempre", score: 0 },
        { text: "Algo menos que antes", score: 1 },
        { text: "Definitivamente menos", score: 2 },
        { text: "No, nada", score: 3 },
      ],
    },
    {
      text: "Me he culpado innecesariamente cuando las cosas han salido mal",
      options: [
        { text: "No, nunca", score: 0 },
        { text: "No, no muy a menudo", score: 1 },
        { text: "Sí, a veces", score: 2 },
        { text: "Sí, la mayor parte del tiempo", score: 3 },
      ],
    },
    {
      text: "He estado ansiosa o preocupada sin motivo",
      options: [
        { text: "No, nunca", score: 0 },
        { text: "Casi nunca", score: 1 },
        { text: "Sí, a veces", score: 2 },
        { text: "Sí, a menudo", score: 3 },
      ],
    },
    {
      text: "He sentido miedo o pánico sin motivo alguno",
      options: [
        { text: "No, nunca", score: 0 },
        { text: "No, no mucho", score: 1 },
        { text: "Sí, a veces", score: 2 },
        { text: "Sí, bastante", score: 3 },
      ],
    },
    {
      text: "Las cosas me han agobiado",
      options: [
        { text: "No, he podido con ellas como siempre", score: 0 },
        { text: "No, la mayoría de las veces lo he hecho bien", score: 1 },
        { text: "Sí, a veces no he podido con las cosas", score: 2 },
        { text: "Sí, la mayor parte del tiempo no he podido", score: 3 },
      ],
    },
    {
      text: "Me he sentido tan infeliz que he tenido dificultad para dormir",
      options: [
        { text: "No, nunca", score: 0 },
        { text: "No muy a menudo", score: 1 },
        { text: "Sí, a veces", score: 2 },
        { text: "Sí, la mayor parte del tiempo", score: 3 },
      ],
    },
    {
      text: "Me he sentido triste o desgraciada",
      options: [
        { text: "No, nunca", score: 0 },
        { text: "No muy a menudo", score: 1 },
        { text: "Sí, bastante a menudo", score: 2 },
        { text: "Sí, la mayor parte del tiempo", score: 3 },
      ],
    },
    {
      text: "Me he sentido tan infeliz que he estado llorando",
      options: [
        { text: "No, nunca", score: 0 },
        { text: "Solo ocasionalmente", score: 1 },
        { text: "Sí, bastante a menudo", score: 2 },
        { text: "Sí, la mayor parte del tiempo", score: 3 },
      ],
    },
    {
      // Ítem 10. Señal de seguridad independiente del puntaje total.
      text: "Se me ha ocurrido la idea de hacerme daño",
      options: [
        { text: "Nunca", score: 0 },
        { text: "Casi nunca", score: 1 },
        { text: "A veces", score: 2 },
        { text: "Sí, bastante a menudo", score: 3 },
      ],
      safetyItem: true,
    },
  ];

  var EPDS_MAX_SCORE = 30;

  /* Puntos de referencia de tamizaje usados en Chile. Son puntos de referencia,
     no umbrales diagnósticos. */
  var EPDS_STAGES = [
    { id: 'embarazo', label: 'Embarazo', word: 'el embarazo', reference: 13 },
    { id: 'posparto', label: 'Posparto', word: 'el posparto', reference: 10 },
  ];

  /* Un puntaje alto cambia la prioridad con que se sugiere la evaluación.
     Nunca activa por sí solo la vía de seguridad: eso lo decide el ítem 10. */
  var EPDS_PRIORITY_SCORE = 20;

  var SUPPORT_LINE =
    'Si en algún momento sientes que podrías estar en riesgo, puedes llamar a ' +
    '<strong>Salud Responde</strong> (600 360 7777, 24 horas) o a la ' +
    '<strong>Línea de Prevención del Suicidio *4141</strong>.';

  var LIST = 'margin:14px 0 0; padding-left:20px; line-height:1.7; color:var(--ink-2);';

  function epdsStage(id) {
    for (var i = 0; i < EPDS_STAGES.length; i += 1) {
      if (EPDS_STAGES[i].id === id) return EPDS_STAGES[i];
    }
    return null;
  }

  /* answers: índice de opción elegida por pregunta. Devuelve null si falta alguna. */
  function epdsScore(answers) {
    if (!answers || answers.length !== EPDS_QUESTIONS.length) return null;
    var total = 0;
    for (var i = 0; i < EPDS_QUESTIONS.length; i += 1) {
      var option = EPDS_QUESTIONS[i].options[answers[i]];
      if (!option) return null;
      total += option.score;
    }
    return { total: total, item10: EPDS_QUESTIONS[9].options[answers[9]].score };
  }

  /*
    Lógica de resultado, en este orden y sin otro camino:

      si item10 > 0            → seguridad (cualquier puntaje, cualquier etapa)
      si total >= 20           → evaluación con prioridad (no es crisis ni emergencia)
      si total >= referencia   → evaluación profesional recomendada
      si no                    → bajo el punto de referencia de la etapa

    Sin etapa no hay interpretación: devuelve null.
  */
  function epdsInterpret(input) {
    if (!input) return null;
    var stage = epdsStage(input.stage);
    if (!stage) return null;
    var total = input.total;
    var item10 = input.item10;
    if (typeof total !== 'number' || !isFinite(total)) return null;
    if (typeof item10 !== 'number' || !isFinite(item10)) return null;

    var score = '<strong>' + total + ' de ' + EPDS_MAX_SCORE + '</strong>';

    if (item10 > 0) {
      return {
        band: 'safety',
        tone: 'safety',
        label: 'Apoyo prioritario',
        stage: stage.id,
        reference: stage.reference,
        total: total,
        safety: true,
        showCrisisResources: true,
        title: 'Una de tus respuestas merece <em>atención pronta</em>.',
        body:
          '<p>Respondiste que se te ha ocurrido la idea de hacerte daño. ' +
          'Independiente de tu puntaje total (' + score + '), esa respuesta merece ' +
          'una evaluación y acompañamiento profesional pronto.</p>' +
          '<p>Esto no es un diagnóstico ni una conclusión sobre lo que te está pasando. ' +
          'Significa que es importante que alguien te acompañe a mirarlo pronto y que no ' +
          'tengas que sostenerlo sola.</p>' +
          '<p>Si sientes que podrías estar en riesgo ahora, busca apoyo inmediato con los ' +
          'recursos que aparecen aquí abajo.</p>',
        next:
          '<p>Pasos que pueden ayudarte ahora:</p>' +
          '<ul style="' + LIST + '">' +
          '<li>Contarle hoy a alguien de confianza cómo te sientes.</li>' +
          '<li>Pedir una evaluación con un profesional de salud mental lo antes posible.</li>' +
          '<li>Comentarlo en tu control con matrona o médico, o consultar en tu centro de salud.</li>' +
          '<li>Si sientes que podrías hacerte daño, usa los teléfonos de más arriba o acude al servicio de urgencia más cercano.</li>' +
          '</ul>' +
          '<p style="margin-top:14px;">La consulta psicológica online no es un servicio de ' +
          'urgencia. Si necesitas atención inmediata, los recursos de más arriba son el primer paso.</p>',
      };
    }

    if (total >= EPDS_PRIORITY_SCORE) {
      return {
        band: 'priority',
        tone: 'priority',
        label: 'Evaluación con prioridad',
        stage: stage.id,
        reference: stage.reference,
        total: total,
        safety: false,
        showCrisisResources: false,
        title: 'Tu resultado es <em>elevado</em> para esta etapa.',
        body:
          '<p>Un puntaje de ' + score + ' es elevado y está sobre el punto de referencia ' +
          'usado para ' + stage.word + ' (' + stage.reference + ' o más). Sería recomendable ' +
          'buscar una evaluación profesional con prioridad, en los próximos días.</p>' +
          '<p>El puntaje por sí solo no permite establecer un diagnóstico ni determinar una ' +
          'situación de emergencia. Lo que sí indica es que conviene no dejarlo pasar: esto ' +
          'tiene tratamiento y no tienes que atravesarlo sola.</p>',
        next:
          '<p>Algunas opciones para los próximos días:</p>' +
          '<ul style="' + LIST + '">' +
          '<li>Agendar una evaluación con una profesional de salud mental perinatal.</li>' +
          '<li>Comentarlo en tu control con matrona o médico, o pedir una hora antes.</li>' +
          '<li>Apoyarte en alguien cercano durante esta etapa.</li>' +
          '</ul>' +
          '<p style="margin-top:14px;">' + SUPPORT_LINE + '</p>',
      };
    }

    if (total >= stage.reference) {
      return {
        band: 'reference',
        tone: 'attention',
        label: 'Evaluación recomendada',
        stage: stage.id,
        reference: stage.reference,
        total: total,
        safety: false,
        showCrisisResources: false,
        title: 'Tu resultado está <em>sobre el punto de referencia</em> de esta etapa.',
        body:
          '<p>Un puntaje de ' + score + ' alcanza el punto de referencia usado para ' +
          stage.word + ' (' + stage.reference + ' o más) y sería recomendable realizar una ' +
          'evaluación profesional.</p>' +
          '<p>Este resultado viene de una herramienta de tamizaje y no constituye un ' +
          'diagnóstico: indica que vale la pena mirarlo con una profesional, no qué está ' +
          'ocurriendo.</p>',
        next:
          '<p>Algunas opciones que pueden ayudar:</p>' +
          '<ul style="' + LIST + '">' +
          '<li>Agendar una evaluación con una psicóloga perinatal en las próximas semanas.</li>' +
          '<li>Comentar cómo te sientes en tu control con matrona o médico.</li>' +
          '<li>Si ya nació tu bebé, puedes asistir con él o ella a la sesión.</li>' +
          '<li>La terapia con boleta clínica es reembolsable por Isapre.</li>' +
          '</ul>',
      };
    }

    return {
      band: 'below',
      tone: 'calm',
      label: 'Bajo el punto de referencia',
      stage: stage.id,
      reference: stage.reference,
      total: total,
      safety: false,
      showCrisisResources: false,
      title: 'Tu resultado está <em>bajo el punto de referencia</em> de esta etapa.',
      body:
        '<p>Un puntaje de ' + score + ' está bajo el punto de referencia usado para ' +
        stage.word + ' (' + stage.reference + ' o más). Esto no descarta que puedas ' +
        'necesitar apoyo.</p>' +
        '<p>Si lo que estás sintiendo te preocupa, persiste o está interfiriendo en tu ' +
        'bienestar o en tu vida cotidiana, puedes conversarlo con un profesional. La EPDS ' +
        'es una herramienta de tamizaje: no diagnostica depresión ni ninguna otra condición ' +
        'de salud mental.</p>',
      next:
        '<p>Algunas cosas que pueden ayudarte en esta etapa:</p>' +
        '<ul style="' + LIST + '">' +
        '<li>Decir en voz alta cómo estás a alguien de tu red cercana.</li>' +
        '<li>Comentarlo en tu próximo control con matrona o médico si te preocupa.</li>' +
        '<li>Priorizar el sueño y el descanso dentro de lo posible.</li>' +
        '<li>Volver a este test si algo cambia o si los síntomas persisten.</li>' +
        '</ul>',
    };
  }

  global.EPDS_QUESTIONS = EPDS_QUESTIONS;
  global.EPDS_MAX_SCORE = EPDS_MAX_SCORE;
  global.EPDS_STAGES = EPDS_STAGES;
  global.EPDS_PRIORITY_SCORE = EPDS_PRIORITY_SCORE;
  global.epdsStage = epdsStage;
  global.epdsScore = epdsScore;
  global.epdsInterpret = epdsInterpret;
})(typeof window !== 'undefined' ? window : globalThis);
