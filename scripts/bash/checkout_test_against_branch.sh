#!/bin/bash

set -x          # trace commands

if [[ "$MATOMO_TEST_TARGET" == "minimum_required_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the minimum required Matomo in the plugin.json file
  export MATOMO_TEST_TARGET=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE/matomo $PLUGIN_NAME)

  if ! git ls-remote --exit-code origin "$MATOMO_TEST_TARGET" >/dev/null 2>&1; then
    if git ls-remote --exit-code origin "${MATOMO_TEST_TARGET%-*}" >/dev/null 2>&1; then
      echo "Could not find beta version '$MATOMO_TEST_TARGET' specified in plugin.json, testing against stable ${MATOMO_TEST_TARGET%-*}."

      export MATOMO_TEST_TARGET=${MATOMO_TEST_TARGET%-*}
    elif ! git ls-remote --exit-code origin "${MATOMO_TEST_TARGET:0:1}.x-dev" >/dev/null 2>&1; then
      echo "Could not find development branch '${MATOMO_TEST_TARGET:0:1}.x-dev' for '$MATOMO_TEST_TARGET' specified in plugin.json, testing against 4.x-dev."

      export MATOMO_TEST_TARGET=4.x-dev
    else
      echo "Could not find tag '$MATOMO_TEST_TARGET' specified in plugin.json, testing against development branch ${MATOMO_TEST_TARGET:0:1}.x-dev."

      export MATOMO_TEST_TARGET=${MATOMO_TEST_TARGET:0:1}.x-dev
    fi
  fi
elif [[ "$MATOMO_TEST_TARGET" == "maximum_supported_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the maximum supported Matomo in the plugin.json file
  export MATOMO_TEST_TARGET=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE/matomo $PLUGIN_NAME "max")

  if ! git ls-remote --exit-code origin "$MATOMO_TEST_TARGET" >/dev/null 2>&1; then
    if ! git ls-remote --exit-code origin "${MATOMO_TEST_TARGET:0:1}.x-dev" >/dev/null 2>&1; then
      echo "Could not find development branch '${MATOMO_TEST_TARGET:0:1}.x-dev' for '$MATOMO_TEST_TARGET' specified in plugin.json, testing against 4.x-dev."

      export MATOMO_TEST_TARGET=4.x-dev
    else
      echo "Could not find tag '$MATOMO_TEST_TARGET' specified in plugin.json, testing against development branch ${MATOMO_TEST_TARGET:0:1}.x-dev."

      export MATOMO_TEST_TARGET=${MATOMO_TEST_TARGET:0:1}.x-dev
    fi
  fi
fi

if [[ "$TEST_SUITE" == "JS" && ! $MATOMO_TEST_TARGET =~ ^[0-9]\.x-dev$ && $(php -r "echo (int) version_compare('$MATOMO_TEST_TARGET', '4.3.0', '<');") == "1" ]]; then
  echo "JavaScript tests can't run on Matomo < 4.3.0, so switching to 4.3.0 instead."
  export MATOMO_TEST_TARGET=4.3.0
fi

echo "Testing against '$MATOMO_TEST_TARGET'"
git reset --hard
if ! git checkout "$MATOMO_TEST_TARGET" --force; then
  echo ""
  echo "Failed to checkout $MATOMO_TEST_TARGET"
  echo "git status:"
  echo ""

  git status

  exit 1
fi

echo "Initializing submodules"
git submodule init -q
git submodule update -q || true
git lfs logs last
