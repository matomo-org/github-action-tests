#!/bin/bash
# Regression tests for scripts/bash/license_check.sh, run against throwaway
# fixture repositories. Usage: bash tests/license_check_test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/bash/license_check.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

tests=0
failures=0

OSS_HEADER='<?php
/**
 * Matomo - free/libre analytics platform
 *
 * @link https://matomo.org
 * @license https://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */
'
PREMIUM_HEADER='<?php
/**
 * Copyright (C) InnoCraft Ltd - All rights reserved.
 *
 * @link https://www.innocraft.com/
 * @license For license details see https://www.innocraft.com/license
 */
'

new_premium_repo() {
  local dir="$WORK/$1"
  mkdir -p "$dir"
  echo '{"name":"Test","license":"InnoCraft EULA"}' > "$dir/plugin.json"
  echo 'Copyright InnoCraft Ltd license text' > "$dir/LICENSE"
  printf '%s' "$PREMIUM_HEADER" > "$dir/Good.php"
  echo "$dir"
}

new_oss_repo() {
  local dir="$WORK/$1"
  mkdir -p "$dir"
  echo '{"name":"Test","license":"GPL v3+"}' > "$dir/plugin.json"
  echo 'GNU GENERAL PUBLIC LICENSE' > "$dir/LICENSE"
  printf '%s' "$OSS_HEADER" > "$dir/Good.php"
  echo "$dir"
}

# check <description> <expected exit> <expected output substring or ""> <repo dir> [ENV=value...]
check() {
  local desc="$1" expected_exit="$2" expected_output="$3" dir="$4"
  shift 4
  tests=$((tests + 1))
  local output actual
  output=$(cd "$dir" && env "$@" bash "$SCRIPT" . 2>&1)
  actual=$?
  local ok=1
  [ "$actual" -eq "$expected_exit" ] || ok=0
  if [ -n "$expected_output" ] && ! grep -qF "$expected_output" <<< "$output"; then
    ok=0
  fi
  if [ "$ok" -eq 1 ]; then
    echo "ok - $desc"
  else
    failures=$((failures + 1))
    echo "FAIL - $desc (exit $actual, expected $expected_exit)"
    sed 's/^/    /' <<< "$output"
  fi
}

dir=$(new_premium_repo clean-premium)
check 'clean premium repository passes' 0 '0 error(s), 0 warning(s)' "$dir"

dir=$(new_oss_repo clean-oss)
check 'clean OSS repository passes' 0 '0 error(s), 0 warning(s)' "$dir"

dir=$(new_premium_repo premium-with-gpl)
printf '%s' "$OSS_HEADER" > "$dir/Wrong.php"
check 'GPL header in premium repository fails' 1 'carries a GPL header' "$dir"

dir=$(new_oss_repo oss-with-eula)
printf '%s' "$PREMIUM_HEADER" > "$dir/Wrong.php"
check 'InnoCraft header in OSS repository fails' 1 'carries an InnoCraft EULA header' "$dir"

dir=$(new_oss_repo marker-in-code)
{
  printf '%s' "$OSS_HEADER"
  printf "\$notice = 'Copyright (C) InnoCraft Ltd - All rights reserved.';\n"
} > "$dir/Strings.php"
check 'marker text in a string literal is not a header' 0 '0 error(s)' "$dir"

dir=$(new_premium_repo vue-html-comment)
printf '<!--\n  Copyright (C) InnoCraft Ltd - All rights reserved.\n-->\n<template></template>\n' > "$dir/Comp.vue"
check 'HTML-comment header in a .vue file is recognized' 0 '0 error(s), 0 warning(s)' "$dir"

dir=$(new_premium_repo single-line-comments)
printf '<!-- Copyright (C) InnoCraft Ltd - All rights reserved. -->\n<template></template>\n' > "$dir/Comp.vue"
printf '/* Copyright (C) InnoCraft Ltd - All rights reserved. */\nconsole.log(1);\n' > "$dir/one.js"
printf '// Copyright (C) InnoCraft Ltd - All rights reserved.\nconsole.log(1);\n' > "$dir/two.js"
check 'single-line comment headers are recognized' 0 '0 error(s), 0 warning(s)' "$dir"

dir=$(new_premium_repo late-comment)
{
  printf '<?php\nclass Code {}\n'
  printf '%s' "$PREMIUM_HEADER" | tail -n +2
} > "$dir/Late.php"
check 'marker in a comment after code is not a header' 0 '::warning file=Late.php' "$dir"

dir=$(new_oss_repo late-wrong-comment)
{
  printf '%s' "$OSS_HEADER"
  printf 'class Code {}\n'
  printf '%s' "$PREMIUM_HEADER" | tail -n +2
} > "$dir/LateWrong.php"
check 'opposite marker in a comment after code is not an error' 0 '0 error(s)' "$dir"

dir=$(new_premium_repo missing-header)
printf '<?php class NoHeader {}\n' > "$dir/NoHeader.php"
check 'missing header warns but passes by default' 0 '::warning file=NoHeader.php' "$dir"
check 'missing header fails with FAIL_ON_MISSING_HEADER=1' 1 '::error file=NoHeader.php' "$dir" FAIL_ON_MISSING_HEADER=1
check 'missing header fails with FAIL_ON_MISSING_HEADER=true' 1 '::error file=NoHeader.php' "$dir" FAIL_ON_MISSING_HEADER=true

dir=$(new_premium_repo ignored-file)
printf '%s' "$OSS_HEADER" > "$dir/ThirdParty.php"
echo 'ThirdParty.php' > "$dir/.license-check-ignore"
check 'ignore glob skips a listed file' 0 '0 error(s)' "$dir"

dir=$(new_premium_repo pruned-vendor)
mkdir -p "$dir/vendor" "$dir/node_modules"
printf '%s' "$OSS_HEADER" > "$dir/vendor/dep.php"
printf '%s' "$OSS_HEADER" > "$dir/node_modules/dep.js"
check 'vendor and node_modules are not scanned' 0 'Checked 1 files' "$dir"

dir=$(new_premium_repo no-license-file)
rm "$dir/LICENSE"
check 'missing LICENSE file fails' 1 'No LICENSE or LICENSE.md file found' "$dir"

dir=$(new_premium_repo license-mismatch)
echo 'GNU GENERAL PUBLIC LICENSE' > "$dir/LICENSE"
check 'LICENSE contradicting plugin.json fails' 1 'does not mention InnoCraft' "$dir"

dir=$(new_premium_repo license-contradiction)
printf 'InnoCraft something\nGNU GENERAL PUBLIC LICENSE\n' > "$dir/LICENSE"
check 'premium LICENSE containing GPL text fails' 1 'license file contains the GPL' "$dir"

dir=$(new_oss_repo oss-license-contradiction)
printf 'GNU GENERAL PUBLIC LICENSE\nInnoCraft EULA terms\n' > "$dir/LICENSE"
check 'OSS LICENSE containing the InnoCraft EULA fails' 1 'license file contains the InnoCraft EULA' "$dir"

dir=$(new_oss_repo oss-license-copyright-line)
printf 'GNU GENERAL PUBLIC LICENSE\nCopyright (C) InnoCraft Ltd\n' > "$dir/LICENSE"
check 'InnoCraft copyright line in a GPL LICENSE is fine' 0 '0 error(s)' "$dir"

dir="$WORK/unknown-license"
mkdir -p "$dir"
echo '{"name":"Test","license":"MIT"}' > "$dir/plugin.json"
check 'unrecognized license value fails' 1 'Unrecognized license "MIT"' "$dir"

dir="$WORK/no-plugin-json"
mkdir -p "$dir"
check 'repository without plugin.json fails' 1 'No plugin.json found' "$dir"

echo
echo "$tests tests, $failures failure(s)"
exit "$((failures > 0))"
