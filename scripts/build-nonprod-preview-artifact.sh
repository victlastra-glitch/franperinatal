#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_root="${1:?usage: build-nonprod-preview-artifact.sh <empty-output-directory>}"

[[ -d "$artifact_root" ]] || { printf 'ARTIFACT_BUILD_FAIL: output directory missing\n' >&2; exit 1; }
[[ -z "$(find "$artifact_root" -mindepth 1 -print -quit)" ]] || { printf 'ARTIFACT_BUILD_FAIL: output directory must be empty\n' >&2; exit 1; }

for file in _redirects _worker.js ansiedad-perinatal.html blog.html contacto.html depresion-postparto.html faq.html index.html lp.html manage.html pago-resultado.html pago.html privacidad.html reserva.html robots.txt servicios.html sitemap.xml sobre-mi.html; do
  cp "$repo_root/$file" "$artifact_root/$file"
done
for directory in assets blog guia recursos; do
  cp -R "$repo_root/$directory" "$artifact_root/$directory"
done

"$repo_root/scripts/validate-nonprod-boundary.sh" "$artifact_root"
printf 'NONPROD_PREVIEW_ARTIFACT=PASS\n'
