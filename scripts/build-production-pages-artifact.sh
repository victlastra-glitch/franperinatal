#!/usr/bin/env bash
# Deterministic Cloudflare Pages Production artifact builder.
#
# Production is deployed by Direct Upload, so the thing that reaches the edge is
# a directory, not a commit. This builds that directory from the Git object
# database at an explicit ref and never from the worktree, so an uncommitted or
# untracked file cannot reach Production, and re-running it on the same ref
# yields the same file list, the same bytes and the same manifest digest.
#
#   scripts/build-production-pages-artifact.sh <GIT_REF> [OUTPUT_DIR]
#   scripts/build-production-pages-artifact.sh --verify <ARTIFACT_DIR> <GIT_REF>
#
# The artifact is written outside the repository. `--verify` re-runs every
# assertion against an artifact that already exists, which is what the release
# operator runs immediately before the upload.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() { printf 'PRODUCTION_PAGES_ARTIFACT=FAIL: %s\n' "$1" >&2; exit 1; }
usage() {
  printf 'usage: build-production-pages-artifact.sh <GIT_REF> [OUTPUT_DIR]\n' >&2
  printf '       build-production-pages-artifact.sh --verify <ARTIFACT_DIR> <GIT_REF>\n' >&2
  exit 2
}

require_tool() { command -v "$1" >/dev/null 2>&1 || { printf 'TOOL_MISSING: %s\n' "$1" >&2; exit 127; }; }
require_tool git
require_tool tar
require_tool find
require_tool sort

# Fail closed on the hash: a manifest is evidence, and a missing digest tool must
# never degrade into "no hashes, therefore no mismatch".
if command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  printf 'TOOL_MISSING: shasum or sha256sum\n' >&2; exit 127
fi

# The Production deploy surface. Unlike the NONPROD preview, Production ships
# `_routes.json` as well as `_worker.js`: the Worker without its route manifest
# either never runs or runs on every asset request. They are one operational
# pair and both are release-critical.
production_root_files=(
  _redirects _routes.json _worker.js
  404.html ansiedad-perinatal.html blog.html contacto.html
  depresion-postparto.html faq.html index.html lp.html manage.html
  pago-resultado.html pago.html privacidad.html reserva.html
  robots.txt servicios.html sitemap.xml sobre-mi.html
)
production_directories=(assets blog guia recursos)
# Present in the tree and deliberately not deployed. Checked by prefix, so a new
# file underneath one of them is excluded without editing this list.
forbidden_prefixes=(
  backend/ docs/ scripts/ .git/ .agents/ .claude/
  AGENTS.md CLAUDE.md README.md .gitignore
)
release_critical=(_routes.json _worker.js)

# ---------------------------------------------------------------- expected set

# The allowlist applied to the tree at the ref — never to the worktree.
expected_paths() {
  local ref_sha="$1" path
  git -C "$repo_root" -c core.quotePath=false ls-tree -r --name-only "$ref_sha" | while IFS= read -r path; do
    for allowed in "${production_root_files[@]}"; do
      [[ "$path" == "$allowed" ]] && { printf '%s\n' "$path"; continue 2; }
    done
    for directory in "${production_directories[@]}"; do
      [[ "$path" == "$directory"/* ]] && { printf '%s\n' "$path"; continue 2; }
    done
  done | LC_ALL=C sort
}

artifact_paths() {
  local dir="$1"
  (cd "$dir" && find . -type f -print | sed 's|^\./||') | LC_ALL=C sort
}

write_manifest() {
  # Sorted relative paths and content hashes only. No directory name, no mtime,
  # no build host: two builds of one ref must produce byte-identical manifests.
  local dir="$1" out="$2" path
  : > "$out"
  artifact_paths "$dir" | while IFS= read -r path; do
    printf '%s  %s\n' "$(sha256_of "$dir/$path")" "$path" >> "$out"
  done
}

verify_artifact() {
  local artifact_dir="$1" ref_sha="$2" expected_file actual_file path

  [[ -d "$artifact_dir" ]] || fail "artifact directory missing: $artifact_dir"
  [[ ! -L "$artifact_dir" ]] || fail 'artifact directory is a symlink'

  local stray_link
  stray_link="$(find -P "$artifact_dir" -type l -print -quit)"
  [[ -z "$stray_link" ]] || fail "artifact contains a symlink: $stray_link"

  expected_file="$(mktemp)"; actual_file="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$expected_file' '$actual_file'" RETURN
  expected_paths "$ref_sha" > "$expected_file"
  artifact_paths "$artifact_dir" > "$actual_file"

  # Anything in the artifact that the ref's allowlist does not produce — a
  # forbidden backend/ or docs/ file, an untracked worktree leftover, a stale
  # file from an earlier build — is caught here, before the missing-file check,
  # because a contaminated artifact is the more dangerous of the two.
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    for prefix in "${forbidden_prefixes[@]}"; do
      [[ "$path" == "$prefix"* ]] && fail "forbidden path in artifact: $path"
    done
    grep -qxF -- "$path" "$expected_file" || fail "unexpected path in artifact: $path"
  done < "$actual_file"

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    grep -qxF -- "$path" "$actual_file" || fail "missing path in artifact: $path"
  done < "$expected_file"

  # Checked before the general root list so the operator sees which half of the
  # Worker pair broke, and so removing one from that list cannot silently
  # retire the check.
  for path in "${release_critical[@]}"; do
    [[ -f "$artifact_dir/$path" ]] || fail "release-critical file missing: $path"
  done
  for path in "${production_root_files[@]}" ; do
    [[ -f "$artifact_dir/$path" ]] || fail "required Production file missing: $path"
  done

  # Byte identity against the ref's own blobs. This is what makes "built from
  # the ref" a proven property rather than a claim about how the copy was made.
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    local blob_sha artifact_sha
    blob_sha="$(git -C "$repo_root" rev-parse "$ref_sha:$path" 2>/dev/null)" \
      || fail "path not in ref $ref_sha: $path"
    artifact_sha="$(git hash-object "$artifact_dir/$path")"
    [[ "$blob_sha" == "$artifact_sha" ]] || fail "content differs from ref: $path"
  done < "$expected_file"
}

# ------------------------------------------------------------------- dispatch

if [[ "${1:-}" == "--verify" ]]; then
  artifact_dir="${2:-}"; ref="${3:-}"
  [[ -n "$artifact_dir" && -n "$ref" ]] || usage
  ref_sha="$(git -C "$repo_root" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || fail "unknown git ref: $ref"
  artifact_dir="$(cd "$artifact_dir" 2>/dev/null && pwd -P)" || fail "artifact directory missing: ${2}"
  verify_artifact "$artifact_dir" "$ref_sha"
  printf 'PRODUCTION_PAGES_ARTIFACT_VERIFY=PASS\n'
  printf 'SOURCE_SHA=%s\n' "$ref_sha"
  printf 'ARTIFACT_DIR=%s\n' "$artifact_dir"
  printf 'FILE_COUNT=%s\n' "$(artifact_paths "$artifact_dir" | wc -l | tr -d ' ')"
  exit 0
fi

[[ $# -ge 1 && -n "${1:-}" ]] || usage
[[ $# -le 2 ]] || usage
ref="$1"
ref_sha="$(git -C "$repo_root" rev-parse --verify "$ref^{commit}" 2>/dev/null)" || fail "unknown git ref: $ref"

if [[ -n "${2:-}" ]]; then
  output_root="$2"
  [[ -e "$output_root" && ! -d "$output_root" ]] && fail 'output path exists and is not a directory'
  mkdir -p "$output_root"
  output_root="$(cd "$output_root" && pwd -P)"
  [[ -z "$(find "$output_root" -mindepth 1 -print -quit)" ]] || fail 'output directory must be empty'
else
  output_root="$(mktemp -d "${TMPDIR:-/tmp}/fran-production-pages-XXXXXX")"
  output_root="$(cd "$output_root" && pwd -P)"
fi

# Outside the repository, always: an artifact inside the worktree would be both
# a contamination risk for the next build and a candidate for accidental commit.
case "$output_root/" in
  "$repo_root"/*) fail 'output directory must be outside the repository' ;;
esac

artifact_dir="$output_root/public"
manifest_path="$output_root/MANIFEST.txt"
mkdir -p "$artifact_dir"

# git archive reads the tree object, so the worktree — dirty tracked files,
# untracked files, ignored files — cannot contribute a single byte.
# Built with `read` rather than `mapfile`, which does not exist in the bash 3.2
# that macOS still ships as /bin/bash.
archive_paths=()
while IFS= read -r archive_path; do
  [[ -n "$archive_path" ]] && archive_paths+=("$archive_path")
done < <(expected_paths "$ref_sha")
[[ ${#archive_paths[@]} -gt 0 ]] || fail "ref $ref_sha exposes no Production files"
git -C "$repo_root" archive --format=tar "$ref_sha" -- "${archive_paths[@]}" | tar -x -C "$artifact_dir"

verify_artifact "$artifact_dir" "$ref_sha"
write_manifest "$artifact_dir" "$manifest_path"

file_count="$(artifact_paths "$artifact_dir" | wc -l | tr -d ' ')"
printf 'PRODUCTION_PAGES_ARTIFACT=PASS\n'
printf 'SOURCE_SHA=%s\n' "$ref_sha"
printf 'ARTIFACT_DIR=%s\n' "$artifact_dir"
printf 'MANIFEST_PATH=%s\n' "$manifest_path"
printf 'FILE_COUNT=%s\n' "$file_count"
printf 'MANIFEST_SHA256=%s\n' "$(sha256_of "$manifest_path")"
