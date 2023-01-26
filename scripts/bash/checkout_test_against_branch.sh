#!/bin/bash

if [[ "$MATOMO_TEST_TARGET" == "minimum_required_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the minimum required Matomo in the plugin.json file
  export MATOMO_TEST_TARGET=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE/matomo $PLUGIN_NAME)

  if ! git rev-parse "$MATOMO_TEST_TARGET" >/dev/null 2>&1; then
    if git rev-parse "${MATOMO_TEST_TARGET%-*}" >/dev/null 2>&1; then
      echo "Could not find tag '$MATOMO_TEST_TARGET' specified in plugin.json, testing against ${MATOMO_TEST_TARGET%-*}."

      export MATOMO_TEST_TARGET=${MATOMO_TEST_TARGET%-*}
    elif ! git rev-parse "${MATOMO_TEST_TARGET:0:1}.x-dev" >/dev/null 2>&1; then
      echo "Could not find tag '$MATOMO_TEST_TARGET' specified in plugin.json, testing against 4.x-dev."

      export MATOMO_TEST_TARGET=4.x-dev
    else
      echo "Could not find tag '$MATOMO_TEST_TARGET' specified in plugin.json, testing against ${MATOMO_TEST_TARGET:0:1}.x-dev."

      export MATOMO_TEST_TARGET=${MATOMO_TEST_TARGET:0:1}.x-dev
    fi
  fi
elif [[ "$MATOMO_TEST_TARGET" == "maximum_supported_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the maximum supported Matomo in the plugin.json file
  export MATOMO_TEST_TARGET=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE/matomo $PLUGIN_NAME "max")

  if ! git rev-parse "$MATOMO_TEST_TARGET" >/dev/null 2>&1; then
    if ! git rev-parse "${MATOMO_TEST_TARGET:0:1}.x-dev" >/dev/null 2>&1; then
      echo "Could not find tag '$MATOMO_TEST_TARGET' specified in plugin.json, testing against 4.x-dev."

      export MATOMO_TEST_TARGET=4.x-dev
    else
      echo "Could not find tag '$MATOMO_TEST_TARGET' specified in plugin.json, testing against ${MATOMO_TEST_TARGET:0:1}.x-dev."

      export MATOMO_TEST_TARGET=${MATOMO_TEST_TARGET:0:1}.x-dev
    fi
  fi
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
