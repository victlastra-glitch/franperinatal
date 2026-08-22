#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_root="${1:-$repo_root}"
cd "$repo_root"

require_tool() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'TOOL_MISSING: %s\n' "$1" >&2
    exit 127
  }
}
require_tool rg
require_tool find
require_tool node

fail() { printf 'NONPROD_BOUNDARY_VALIDATION=FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'NONPROD_BOUNDARY_VALIDATION=PASS\n'; }

test -d "$artifact_root" || fail 'artifact root missing'
[[ ! -L "$artifact_root" ]] || fail 'artifact root is a symlink'
test -f "$artifact_root/assets/booking.js" || fail 'missing booking asset'
test -f "$artifact_root/assets/app.js" || fail 'missing app asset'
test -f "$artifact_root/manage.html" || fail 'missing management page'
test -f "$artifact_root/_worker.js" || fail 'missing Worker'

rg -q "availability: '/api/availability'" "$artifact_root/assets/booking.js" || fail 'browser availability route missing'
rg -q "createFlowPayment: '/api/create-flow-payment'" "$artifact_root/assets/booking.js" || fail 'browser payment route missing'
rg -q "fran-nonprod-20260821-" "$artifact_root/assets/booking.js" || fail 'browser idempotency namespace missing'
rg -Fq "'/api/leadmagnet'" "$artifact_root/assets/app.js" || fail 'browser leadmagnet route missing'
for route in /api/manage /api/manage-availability /api/manage-cancel /api/manage-reschedule; do
  rg -Fq "'$route'" "$artifact_root/manage.html" || fail "browser management route missing: $route"
done
if rg -q -i 'script\.google\.com/macros/s/|script\.googleusercontent\.com/macros/|AKfy[[:alnum:]_-]{20,}' \
  "$artifact_root/assets" "$artifact_root/blog" "$artifact_root/guia" "$artifact_root/recursos" "$artifact_root"/*.html "$artifact_root/_worker.js"; then
  fail 'public artifact contains direct Apps Script endpoint'
fi
if rg -q 'WEBAPP_URL' "$artifact_root/assets/booking.js" "$artifact_root/assets/app.js" "$artifact_root/manage.html"; then
  fail 'browser contains Apps Script upstream material'
fi

for route in /api/availability /api/create-flow-payment /api/flow-confirmation /api/payment-status; do
  rg -Fq "$route" "$artifact_root/_worker.js" || fail "Worker route missing: $route"
done
for route in /api/leadmagnet /api/manage /api/manage-availability /api/manage-cancel /api/manage-reschedule; do
  rg -Fq "$route" "$artifact_root/_worker.js" || fail "disabled Worker route missing: $route"
done
rg -Fq "env.APP_ENV !== 'nonprod'" "$artifact_root/_worker.js" || fail 'Worker APP_ENV guard missing'
rg -Fq 'idempotencyKey' "$artifact_root/_worker.js" || fail 'Worker idempotency field missing'
rg -Fq "feature_disabled_nonprod" "$artifact_root/_worker.js" || fail 'disabled feature response missing'
node "$repo_root/scripts/assert-nonprod-worker-structure.mjs" "$artifact_root/_worker.js" >/dev/null \
  || fail 'unexpected semantic nonprod upstream call site'
if rg -q -i 'script\.google\.com/macros/s/|script\.googleusercontent\.com/macros/|AKfy[[:alnum:]_-]{20,}' "$artifact_root/_worker.js"; then
  fail 'Worker contains literal upstream'
fi

symlink_path="$(find -P "$artifact_root" -type l -print -quit)"
[[ -z "$symlink_path" ]] || fail "public artifact contains symlink: $symlink_path"
printf 'PUBLIC_ARTIFACT_SYMLINKS=0\n'
printf 'DIRECT_APPS_SCRIPT_BROWSER_REFERENCES=0\n'

if [[ "$artifact_root" != "$repo_root" ]]; then
  for excluded in .nonprod-private backend docs recovery scripts .wrangler AGENTS.md README.md .gitignore; do
    [[ ! -e "$artifact_root/$excluded" ]] || fail "artifact contains excluded material: $excluded"
  done
  sensitive_path="$(find -P "$artifact_root" -type f \( -name '.clasp.json' -o -name '*.log' -o -iname '*token*' -o -iname '*secret*' -o -iname '*credential*' -o -name '.env' -o -name '.env.*' \) -print -quit)"
  [[ -z "$sensitive_path" ]] || fail "artifact contains sensitive filename material: $sensitive_path"
  printf 'PRIVATE_FILES=0\n'
fi

node --check "$artifact_root/assets/booking.js" >/dev/null
node --check "$artifact_root/assets/app.js" >/dev/null
node --check "$artifact_root/_worker.js" >/dev/null
pass
