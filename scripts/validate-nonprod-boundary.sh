#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() { printf 'NONPROD_BOUNDARY_VALIDATION=FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'NONPROD_BOUNDARY_VALIDATION=PASS\n'; }

test -f assets/booking.js || fail 'missing booking asset'
test -f _worker.js || fail 'missing Worker'

rg -q "availability: '/api/availability'" assets/booking.js || fail 'browser availability route missing'
rg -q "createFlowPayment: '/api/create-flow-payment'" assets/booking.js || fail 'browser payment route missing'
if rg -q 'script\.google\.com/macros/s/|WEBAPP_URL|AKfy' assets/booking.js; then
  fail 'browser contains Apps Script upstream material'
fi

for route in /api/availability /api/create-flow-payment /api/flow-confirmation /api/payment-status; do
  rg -Fq "$route" _worker.js || fail "Worker route missing: $route"
done
rg -Fq "env.APP_ENV !== 'nonprod'" _worker.js || fail 'Worker APP_ENV guard missing'
if rg -q 'https://script\.google\.com/macros/s/' _worker.js; then
  fail 'Worker contains literal upstream'
fi

node --check assets/booking.js >/dev/null
node --check _worker.js >/dev/null
pass
