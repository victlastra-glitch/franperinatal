# Production port requirements — 19 of 19

Reference behavior: `feat/flow-lifecycle-email-v2` @ `f1bf6c0` (not merged).
Target: live Apps Script v7 + recovered public website.

| # | Capability | Classification | Evidence |
|---|---|---|---|
| 1 | Flow status 4 = annulled | PORT_COMPLETE | `stateForFlowStatus_(4) === 'annulled'` |
| 2 | Unknown / provider failure stays verifying | PORT_COMPLETE | unknown status + getStatus failure → `payment_verifying` |
| 3 | 15-minute slot hold | PORT_COMPLETE | `SLOT_HOLD_MS = 15 * 60 * 1000` |
| 4 | Flow timeout ≤ 900 | PORT_COMPLETE | `FLOW_PAYMENT_TIMEOUT_SECONDS = 900` |
| 5 | Flow checkout_timeout ≤ 900 | PORT_COMPLETE | `FLOW_CHECKOUT_TIMEOUT_SECONDS = 900`; create/retry payload |
| 6 | Retry does not extend hold | PORT_COMPLETE | retry keeps `slot_hold_expires_at`; remaining seconds only |
| 7 | Late PAID does not reclaim slot | PORT_COMPLETE | expired + PAID → verifying, no Calendar create |
| 8 | TBD manual-review remediation (late paid) | PORT_COMPLETE | `refund_status=manual_review`, `REFUND_FAILED_MANUAL_REVIEW`, no Flow refund |
| 9 | Calendar refresh / confirm idempotency | PORT_COMPLETE | one event/Meet; duplicate callback does not duplicate |
| 10 | Lifecycle email V2 | PORT_COMPLETE | `EmailTemplates.js` + GmailApp adapter |
| 11 | Durable notification outbox | PORT_COMPLETE | `notification_outbox` sheet worker |
| 12 | Same-event patient reschedule | PORT_COMPLETE | `updateSameEvent`; persist before email |
| 13 | Clinician Calendar reconciliation | PORT_COMPLETE | `Reconciliation.js` |
| 14 | Explicit BUSINESS_POLICY_TBD | PORT_COMPLETE | `activeRefundPolicy_` always ineligible |
| 15 | Internal manual-review notification | PORT_COMPLETE | one `REFUND_FAILED_MANUAL_REVIEW` on TBD cancel |
| 16 | PATIENT_CANCELLED refund-success gating | PORT_COMPLETE | reserved for provider-confirmed refund; TBD uses `SESSION_CANCELLED` |
| 17 | Payment-result retry / annulled UI | PORT_COMPLETE | `pago-resultado.html` failed/pending/annulled/expired/verifying |
| 18 | Production same-origin proxy | PORT_COMPLETE | `_worker.js` + `assets/booking.js` `/api/*` |
| 19 | No-PII Worker contract | PORT_COMPLETE | payment-status allowlist; missing binding 503 |

PORT_REQUIREMENTS_19_OF_19_ACCOUNTED=PASS

The earlier closeout count of 14 was a grouped product summary, not 19 omitted ports.
Zero INTENTIONALLY_NOT_PORTED. Zero BLOCKED. Zero unexplained omissions.
