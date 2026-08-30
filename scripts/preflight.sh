#!/usr/bin/env bash
# Read-only, fail-closed preflight for the Francisca recovery branch.
set -euo pipefail

readonly EXPECTED_REPO='/Users/vic/Projects/francisca-bustos/franperinatal'
readonly EXPECTED_BRANCH='recovery/production-source-20260821'
readonly EXPECTED_ORIGIN='https://github.com/victlastra-glitch/franperinatal.git'
readonly EXPECTED_CLASP_USER='hola@franciscabustos.cl'
readonly FORBIDDEN_ROOT='/Users/vic/Documents/Claude'

fail() {
  printf 'PREFLIGHT_FAIL: %s\n' "$1" >&2
  exit 1
}

current_dir="$(pwd -P)"
case "$current_dir" in
  "$FORBIDDEN_ROOT"|"$FORBIDDEN_ROOT"/*)
    fail 'forbidden working directory'
    ;;
esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail 'not a Git repository'
repo_root="$(cd "$repo_root" && pwd -P)"
[[ "$repo_root" == "$EXPECTED_REPO" ]] || fail 'unexpected repository'

branch="$(git -C "$repo_root" branch --show-current)"
[[ "$branch" == "$EXPECTED_BRANCH" ]] || fail 'unexpected branch; main is never allowed'
[[ "$branch" != 'main' ]] || fail 'main is never allowed'

origin="$(git -C "$repo_root" remote get-url origin 2>/dev/null)" || fail 'origin missing'
[[ "$origin" == "$EXPECTED_ORIGIN" ]] || fail 'unexpected origin'

[[ -z "$(git -C "$repo_root" status --porcelain)" ]] || fail 'worktree is not clean'

for tool in git clasp node npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool missing: $tool"
done
npx --no-install wrangler --version >/dev/null 2>&1 || fail 'required tool missing: wrangler'

# This command reports only the signed-in account. Its raw output is never echoed.
authorized_user="$(clasp show-authorized-user 2>&1)" || fail 'clasp authorization unavailable'
grep -Fq "You are logged in as $EXPECTED_CLASP_USER." <<<"$authorized_user" || \
  fail 'unexpected clasp identity'

printf 'PREFLIGHT_PASS: repo, branch, origin, cleanliness, tooling, and clasp identity verified\n'
