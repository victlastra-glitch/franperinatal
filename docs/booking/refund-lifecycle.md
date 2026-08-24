# Flow refund lifecycle

createFlowRefundGateway_ usa exclusivamente Sandbox `https://sandbox.flow.cl/api` y firma parámetros form-urlencoded. `refund/create` y `refund/cancel` usan POST; `refund/getStatus` usa GET y transporta únicamente `apiKey`, `token` y `s` como query parameters. El fake local impone estos verbos, nombres, URL y firma.

El order lógico es determinista por reservation_id, pero eso es idempotencia interna y no prueba idempotencia provider-side. Un create exitoso guarda la referencia opaca y queda pending. Un rechazo definido queda failed; un timeout o resultado desconocido conserva la orden local, pasa a `manual_review` con `REFUND_CREATE_OUTCOME_UNKNOWN` y prohíbe otro create automático: `getStatus` exige token provider y no existe lookup seguro por commerce order demostrado. Un callback posterior puede resolver `manual_review`; callbacks duplicados son replay-safe. Cancelación de agenda no queda bloqueada por la ambigüedad financiera.

FLOW_REFUND_CALLBACK_URL es propiedad lazy; su nombre se documenta, su valor no se genera ni se guarda en Git. La elegibilidad comercial sigue BUSINESS_POLICY_TBD.
