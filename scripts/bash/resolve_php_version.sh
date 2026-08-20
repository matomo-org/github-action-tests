#!/bin/bash

# Resolves the centrally managed PHP version aliases to concrete versions, so that a caller can
# track a Matomo major's floor or ceiling without repeating the number. Anything unrecognised is
# echoed back unchanged, which is what lets callers pass a literal version such as 8.2. Empty
# input echoes empty, which callers use to mean "do not set PHP up at all".
#
# Keeping the table in a script rather than inline in action.yml lets anything else that needs
# these versions — including workflows in other repositories, which can check this repository
# out — resolve the same table instead of copying it. A copy drifts exactly when a floor moves,
# which is the moment the value matters.

case "$1" in
  matomo5_min_php)
    RESOLVED_VERSION="7.2"
    ;;
  matomo5_max_php)
    RESOLVED_VERSION="8.5"
    ;;
  matomo6_min_php)
    RESOLVED_VERSION="8.1"
    ;;
  matomo6_max_php)
    RESOLVED_VERSION="8.5"
    ;;
  *)
    RESOLVED_VERSION="$1"
    ;;
esac

printf '%s' "$RESOLVED_VERSION"
