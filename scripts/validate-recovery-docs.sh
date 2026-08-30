#!/usr/bin/env bash
# Static local validation only. It does not contact or mutate any external service.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Prefer rg; fall back to grep. Missing search tools never yield PASS.
# shellcheck source=lib/fail-closed-search.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/fail-closed-search.sh"

required=(
  docs/control-tower/CURRENT_STATE.md
  docs/recovery/apps-script-sanitization-canonicalization-2026-08-21.md
  backend/README.md
  docs/deployment/NONPROD_ISOLATION_PLAN.md
  docs/deployment/NONPROD_IMPLEMENTATION_PACKAGE.md
  scripts/preflight.sh
)
for file in "${required[@]}"; do
  [[ -f "$file" ]] || { printf 'VALIDATION_FAIL: missing %s\n' "$file" >&2; exit 1; }
done

search_quiet_fixed 'PRODUCTION_BACKEND_MATCH = VERIFIED' docs/control-tower/CURRENT_STATE.md
search_quiet_fixed 'PRODUCTION_BACKEND_MATCH = VERIFIED' backend/README.md
search_quiet_fixed 'NONPROD_READINESS = BLOCKED' docs/deployment/NONPROD_IMPLEMENTATION_PACKAGE.md
search_quiet_fixed 'Worker-to-active' docs/control-tower/CURRENT_STATE.md

# Canonical documentation must not carry a concrete Apps Script endpoint or API key.
if search_print_regex 'https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec|AIza[[:alnum:]_-]{20,}|AKfy[a-zA-Z0-9_-]{20,}' \
  docs/control-tower docs/deployment docs/recovery backend; then
  printf 'VALIDATION_FAIL: concrete endpoint or API key-like value in documentation\n' >&2
  exit 1
fi

git diff --check
printf 'VALIDATION_PASS: recovery documentation is structurally complete and endpoint-sanitized\n'
