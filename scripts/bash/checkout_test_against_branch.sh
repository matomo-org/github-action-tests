#!/bin/bash

if [[ "$TEST_AGAINST_MATOMO_BRANCH" == "minimum_required_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the minimum required Matomo in the plugin.json file
      export TEST_AGAINST_MATOMO_BRANCH=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE/matomo $PLUGIN_NAME)

      if ! git rev-parse "$TEST_AGAINST_MATOMO_BRANCH" >/dev/null 2>&1
      then
          if ! git rev-parse "${TEST_AGAINST_MATOMO_BRANCH:0:1}.x-dev" >/dev/null 2>&1
          then
              echo "Could not find tag '$TEST_AGAINST_MATOMO_BRANCH' specified in plugin.json, testing against 4.x-dev."

              export TEST_AGAINST_MATOMO_BRANCH=4.x-dev
          else
              echo "Could not find tag '$TEST_AGAINST_MATOMO_BRANCH' specified in plugin.json, testing against ${TEST_AGAINST_MATOMO_BRANCH:0:1}.x-dev."

              export TEST_AGAINST_MATOMO_BRANCH=${TEST_AGAINST_MATOMO_BRANCH:0:1}.x-dev
          fi
      fi
elif [[ "$TEST_AGAINST_MATOMO_BRANCH" == "maximum_supported_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the maximum supported Matomo in the plugin.json file
    export TEST_AGAINST_MATOMO_BRANCH=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE/matomo $PLUGIN_NAME "max")

    if ! git rev-parse "$TEST_AGAINST_MATOMO_BRANCH" >/dev/null 2>&1
    then
        if ! git rev-parse "${TEST_AGAINST_MATOMO_BRANCH:0:1}.x-dev" >/dev/null 2>&1
        then
            echo "Could not find tag '$TEST_AGAINST_MATOMO_BRANCH' specified in plugin.json, testing against 4.x-dev."

            export TEST_AGAINST_MATOMO_BRANCH=4.x-dev
        else
            echo "Could not find tag '$TEST_AGAINST_MATOMO_BRANCH' specified in plugin.json, testing against ${TEST_AGAINST_MATOMO_BRANCH:0:1}.x-dev."

            export TEST_AGAINST_MATOMO_BRANCH=${TEST_AGAINST_MATOMO_BRANCH:0:1}.x-dev
        fi
    fi
fi

echo "Testing against '$TEST_AGAINST_MATOMO_BRANCH'"
git reset --hard
if ! git checkout "$TEST_AGAINST_MATOMO_BRANCH" --force; then
    echo ""
    echo "Failed to checkout $TEST_AGAINST_MATOMO_BRANCH"
    echo "git status:"
    echo ""

    git status

    exit 1
fi

echo "Initializing submodules"
git submodule init -q
git submodule update -q || true
