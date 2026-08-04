#!/bin/bash
# Checks that a plugin repository ships a license file and that its source
# files carry the license header matching the repository's license:
# the GPL header for OSS plugins, the InnoCraft EULA header for premium ones.
#
# Usage: license_check.sh [repo-root]
#
# Files carrying the opposite header are errors; files with no recognized
# header are warnings, or errors when FAIL_ON_MISSING_HEADER is 1 or true.
# Glob patterns in a .license-check-ignore file at the repository root are
# skipped, e.g. for bundled third-party files under their own license.
set -euo pipefail

REPO_ROOT="${1:-.}"
FAIL_ON_MISSING_HEADER="${FAIL_ON_MISSING_HEADER:-0}"

PREMIUM_MARKER='Copyright (C) InnoCraft Ltd'
# Matches both the http and https URL variants in use across plugins.
OSS_MARKER='gnu\.org/licenses/gpl-3\.0'
# Only the start of a file counts as its header; a byte window rather than a
# line count so minified single-line bundles are still covered.
HEADER_WINDOW_BYTES=2048

errors=0
warnings=0

report_error() {
  echo "::error file=$1::$2"
  errors=$((errors + 1))
}

report_missing_header() {
  case "$FAIL_ON_MISSING_HEADER" in
    1|true)
      report_error "$1" "$2"
      ;;
    *)
      echo "::warning file=$1::$2"
      warnings=$((warnings + 1))
      ;;
  esac
}

cd "$REPO_ROOT"

if [ ! -f plugin.json ]; then
  echo "::error::No plugin.json found; cannot determine whether this repository is OSS or premium"
  exit 1
fi

license=$(python3 -c "import json; print(json.load(open('plugin.json')).get('license') or '')")
case "$license" in
  'InnoCraft EULA')
    repo_type=premium
    expected_header='the InnoCraft EULA header'
    ;;
  GPL*)
    repo_type=oss
    expected_header='the GPL header'
    ;;
  *)
    echo "::error file=plugin.json::Unrecognized license \"$license\" in plugin.json; expected \"InnoCraft EULA\" or a GPL license"
    exit 1
    ;;
esac
echo "Repository type: $repo_type (plugin.json license: \"$license\")"

license_file=''
for candidate in LICENSE LICENSE.md; do
  if [ -f "$candidate" ]; then
    license_file="$candidate"
    break
  fi
done

if [ -z "$license_file" ]; then
  report_error LICENSE 'No LICENSE or LICENSE.md file found at the repository root'
elif [ "$repo_type" = premium ] && ! grep -qi 'InnoCraft' "$license_file"; then
  report_error "$license_file" 'plugin.json declares the InnoCraft EULA but the license file does not mention InnoCraft'
elif [ "$repo_type" = oss ] && ! grep -qi 'GNU GENERAL PUBLIC LICENSE' "$license_file"; then
  report_error "$license_file" 'plugin.json declares a GPL license but the license file is not the GPL'
fi

ignore_patterns=()
if [ -f .license-check-ignore ]; then
  while IFS= read -r pattern; do
    case "$pattern" in ''|'#'*) continue ;; esac
    ignore_patterns+=("$pattern")
  done < .license-check-ignore
fi

is_ignored() {
  local path="$1" pattern
  if [ "${#ignore_patterns[@]}" -eq 0 ]; then
    return 1
  fi
  for pattern in "${ignore_patterns[@]}"; do
    # shellcheck disable=SC2254 -- the patterns are globs by design
    case "$path" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

scanned=0
while IFS= read -r -d '' file; do
  rel="${file#./}"
  if is_ignored "$rel"; then
    continue
  fi
  scanned=$((scanned + 1))

  header=$(head -c "$HEADER_WINDOW_BYTES" -- "$file")
  has_premium=0
  has_oss=0
  if grep -qF "$PREMIUM_MARKER" <<< "$header"; then has_premium=1; fi
  if grep -qE "$OSS_MARKER" <<< "$header"; then has_oss=1; fi

  if [ "$repo_type" = premium ]; then
    has_expected=$has_premium
    has_wrong=$has_oss
    wrong_header='a GPL header'
    repo_desc='a premium repository'
  else
    has_expected=$has_oss
    has_wrong=$has_premium
    wrong_header='an InnoCraft EULA header'
    repo_desc='an OSS repository'
  fi

  if [ "$has_wrong" = 1 ]; then
    report_error "$rel" "File carries $wrong_header but this is $repo_desc"
  elif [ "$has_expected" = 0 ]; then
    report_missing_header "$rel" "File has no recognized license header; expected $expected_header"
  fi
done < <(find . \
  \( -name .git -o -name vendor -o -name node_modules -o -name libs -o -path ./tests/resources \) -prune \
  -o -type f \( -name '*.php' -o -name '*.js' -o -name '*.ts' -o -name '*.vue' \) -print0)

echo "Checked $scanned files: $errors error(s), $warnings warning(s)"
if [ "$errors" -gt 0 ]; then
  exit 1
fi
