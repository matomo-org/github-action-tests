#!/bin/bash

if [ "$TEST_AGAINST_MATOMO_BRANCH" == "" ]; then
    if [ "$TEST_AGAINST_CORE" == "latest_stable" ]; then # test against the latest stable release of Matomo core (including betas & release candidates)
        # keeping latest_stable enabled until all plugins successfully migrated
        export TEST_AGAINST_MATOMO_BRANCH=$(git describe --tags `git rev-list --tags --max-count=1`)
        export TEST_AGAINST_MATOMO_BRANCH=`echo $TEST_AGAINST_MATOMO_BRANCH | tr -d ' ' | tr -d '\n'`

        #echo "Testing against 'latest_stable' is no longer supported, please test against 'minimum_required_matomo'."
        #exit 1
    elif [[ "$TEST_AGAINST_CORE" == "minimum_required_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the minimum required Matomo in the plugin.json file
        export TEST_AGAINST_MATOMO_BRANCH=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE $PLUGIN_NAME)

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
elif [[ "$TEST_AGAINST_MATOMO_BRANCH" == "maximum_supported_matomo" && "$PLUGIN_NAME" != "" ]]; then # test against the maximum supported Matomo in the plugin.json file
    export TEST_AGAINST_MATOMO_BRANCH=$(php "$ACTION_PATH/scripts/php/get_required_matomo_version.php" $WORKSPACE $PLUGIN_NAME "max")

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
rm -rf ./tests/travis
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
