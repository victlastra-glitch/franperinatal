#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_root="${1:?usage: build-nonprod-preview-artifact.sh <empty-output-directory>}"

require_tool() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'TOOL_MISSING: %s\n' "$1" >&2
    exit 127
  }
}
require_tool cp
require_tool find
require_tool rg
require_tool node

[[ -d "$artifact_root" ]] || { printf 'ARTIFACT_BUILD_FAIL: output directory missing\n' >&2; exit 1; }
[[ -z "$(find "$artifact_root" -mindepth 1 -print -quit)" ]] || { printf 'ARTIFACT_BUILD_FAIL: output directory must be empty\n' >&2; exit 1; }

public_files=(
  _redirects _worker.js ansiedad-perinatal.html blog.html contacto.html
  depresion-postparto.html faq.html index.html lp.html manage.html
  pago-resultado.html pago.html privacidad.html reserva.html robots.txt
  servicios.html sitemap.xml sobre-mi.html
)
public_directories=(assets blog guia recursos)

for relative_path in "${public_files[@]}" "${public_directories[@]}"; do
  source_path="$repo_root/$relative_path"
  [[ -e "$source_path" ]] || { printf 'ARTIFACT_BUILD_FAIL: source missing: %s\n' "$relative_path" >&2; exit 1; }
  [[ ! -L "$source_path" ]] || { printf 'PUBLIC_ARTIFACT_SYMLINKS: source symlink: %s\n' "$relative_path" >&2; exit 1; }
  source_symlink="$(find -P "$source_path" -type l -print -quit)"
  [[ -z "$source_symlink" ]] || { printf 'PUBLIC_ARTIFACT_SYMLINKS: source symlink: %s\n' "$source_symlink" >&2; exit 1; }
done

for file in "${public_files[@]}"; do
  cp "$repo_root/$file" "$artifact_root/$file"
done
for directory in "${public_directories[@]}"; do
  cp -R "$repo_root/$directory" "$artifact_root/$directory"
done

"$repo_root/scripts/validate-nonprod-boundary.sh" "$artifact_root"
printf 'NONPROD_PREVIEW_ARTIFACT=PASS\n'
