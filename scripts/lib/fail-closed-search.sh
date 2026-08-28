# Shared fail-closed local search. Prefer rg; fall back to grep.
# A missing required search tool never yields VALIDATION_PASS.
# Source this file from validation scripts. Do not execute it directly.

if command -v rg >/dev/null 2>&1; then
  SEARCH_ENGINE=rg
elif command -v grep >/dev/null 2>&1; then
  SEARCH_ENGINE=grep
else
  printf 'TOOL_MISSING: rg (no grep fallback)\n' >&2
  exit 127
fi

_search_status() {
  local status=$1
  if [[ "$status" -ge 2 ]]; then
    printf 'SEARCH_ERROR: %s failed with status %s\n' "$SEARCH_ENGINE" "$status" >&2
    exit 1
  fi
  return "$status"
}

# Quiet regex match against files (no directory recursion).
# Return 0 on match, 1 on no match; tool errors abort the script.
search_quiet_regex() {
  local pattern=$1
  shift
  local status=0
  if [[ "$SEARCH_ENGINE" == rg ]]; then
    rg -q -- "$pattern" "$@" || status=$?
  else
    grep -qE -- "$pattern" "$@" || status=$?
  fi
  _search_status "$status"
}

# Quiet fixed-string match against files.
search_quiet_fixed() {
  local needle=$1
  shift
  local status=0
  if [[ "$SEARCH_ENGINE" == rg ]]; then
    rg -Fq -- "$needle" "$@" || status=$?
  else
    grep -qF -- "$needle" "$@" || status=$?
  fi
  _search_status "$status"
}

# Quiet case-insensitive regex across files and/or directories.
search_quiet_regex_i() {
  local pattern=$1
  shift
  local status=0
  if [[ "$SEARCH_ENGINE" == rg ]]; then
    rg -q -i -- "$pattern" "$@" || status=$?
  else
    grep -qiRE -- "$pattern" "$@" || status=$?
  fi
  _search_status "$status"
}

# Print matching lines (regex, recursive for grep). Return 0 on match.
search_print_regex() {
  local pattern=$1
  shift
  local status=0
  if [[ "$SEARCH_ENGINE" == rg ]]; then
    rg -n -- "$pattern" "$@" || status=$?
  else
    grep -nRE -- "$pattern" "$@" || status=$?
  fi
  _search_status "$status"
}
