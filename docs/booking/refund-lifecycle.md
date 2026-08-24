# Flow refund lifecycle

createFlowRefundGateway_ usa exclusivamente Sandbox https://sandbox.flow.cl/api y firma parámetros form-urlencoded. Expone localmente refund/create, refund/getStatus y refund/cancel.

El order lógico es determinista por reservation_id. Un create exitoso guarda la referencia opaca; un timeout conserva la orden y fuerza status-only. Un callback repetido sobre estado terminal es replay-safe. Tokens/referencias de provider nunca cruzan el Worker hacia el browser.

FLOW_REFUND_CALLBACK_URL es propiedad lazy; su nombre se documenta, su valor no se genera ni se guarda en Git. La elegibilidad comercial sigue BUSINESS_POLICY_TBD.
