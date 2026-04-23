#!/bin/bash
RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

function is_phpunit_suite {
  case "$1" in
    UnitTests|SystemTestsPlugins|SystemTestsCore|IntegrationTestsCore|IntegrationTestsPlugins|PluginTests)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

function validate_phpunit_shards {
  if [ -z "$PHPUNIT_TEST_SHARDS_TOTAL" ] && [ -z "$PHPUNIT_TEST_SHARD_INDEX" ]; then
    return 1
  fi

  if [ -z "$PHPUNIT_TEST_SHARDS_TOTAL" ] || [ -z "$PHPUNIT_TEST_SHARD_INDEX" ]; then
    echo "Both PHPUNIT_TEST_SHARDS_TOTAL and PHPUNIT_TEST_SHARD_INDEX must be provided together."
    exit 1
  fi

  if ! [[ "$PHPUNIT_TEST_SHARDS_TOTAL" =~ ^[0-9]+$ ]] || [ "$PHPUNIT_TEST_SHARDS_TOTAL" -le 0 ]; then
    echo "PHPUNIT_TEST_SHARDS_TOTAL must be a positive integer."
    exit 1
  fi

  if ! [[ "$PHPUNIT_TEST_SHARD_INDEX" =~ ^[0-9]+$ ]]; then
    echo "PHPUNIT_TEST_SHARD_INDEX must be a non-negative integer."
    exit 1
  fi

  if [ "$PHPUNIT_TEST_SHARD_INDEX" -ge "$PHPUNIT_TEST_SHARDS_TOTAL" ]; then
    echo "PHPUNIT_TEST_SHARD_INDEX must be smaller than PHPUNIT_TEST_SHARDS_TOTAL."
    exit 1
  fi

  if [ "$PHPUNIT_TEST_SHARDS_TOTAL" -le 1 ]; then
    return 1
  fi

  return 0
}

function should_report_to_testomatio {
  if [ -v "$TESTOMATIO" ]; then
    return 1 # Return false
  fi
  if [ "$TESTOMATIO_FORCE_REPORT" == "true" ]; then
    return 0 # Return true since the token is set and the test was marked as force
  fi
  if [ "$GITHUB_IS_TRIGGERED_BY_PUSH" == "false" ]; then
    return 1  # Return false
  fi
  if [ "$TEST_SUITE" == "UnitTests" ]; then
    return 1 # Return false
  fi

  return 0  # Return true
}

should_report_to_testomatio
if [ $? -eq 0 ]; then
  export SHOULD_SEND_TO_TESTOMATIO=true
else
  export SHOULD_SEND_TO_TESTOMATIO=false
fi

if [ -n "$TEST_SUITE" ]; then
  echo -e "${GREEN}Executing tests in test suite $TEST_SUITE...${SET}"
  if [ -n "$PLUGIN_NAME" ]; then
    echo -e "${GREEN}[ plugin name = $PLUGIN_NAME ]${SET}"
  fi

  if [ "$TEST_SUITE" = "Client" ]; then
    status=0
    if [ -d "tests/angularjs" ]; then
      echo -e "${GREEN}Running angularjs tests${SET}"
      cd tests/angularjs
      npm install
      ./node_modules/karma/bin/karma start karma.conf.js --browsers ChromeHeadless --single-run
      status=$?
      echo "Returned status $status"
      cd ../..
    fi
    echo -e "${GREEN}Running vue tests${SET}"
    npm ci
    npm test
    vuestatus=$?
    echo "Returned status $vuestatus"
    if [ $status -ne 0 ]; then
      exit $status
    fi
    exit $vuestatus
  elif [ "$TEST_SUITE" = "JS" ]; then
    if [ -n "$PLUGIN_NAME" ]; then
      if [ $(php -r "require_once './core/Version.php'; echo (int)version_compare(\Piwik\Version::VERSION, '5.0.0-b1', '<');") -eq 1 ]; then
        ./console tests:run-js --matomo-url='http://localhost' # --plugin option not supported pre matomo 5 versions
      else
        ./console tests:run-js --matomo-url='http://localhost' --plugin=$PLUGIN_NAME
      fi
    else
      ./console tests:run-js --matomo-url='http://localhost'
    fi
  elif [ "$TEST_SUITE" = "UI" ]; then
    if [ -n "$PLUGIN_NAME" ]; then
      ./console tests:run-ui --persist-fixture-data --assume-artifacts --plugin=$PLUGIN_NAME --extra-options="$UITEST_EXTRA_OPTIONS"
    else
      ./console tests:run-ui --store-in-ui-tests-repo --persist-fixture-data --assume-artifacts --core --extra-options="$UITEST_EXTRA_OPTIONS"
    fi
  else
    phpunit_base_command=(./vendor/phpunit/phpunit/phpunit --configuration ./tests/PHPUnit/phpunit.xml --colors)
    phpunit_selection_args=(--testsuite "$TEST_SUITE")
    phpunit_run_extra_args=()
    phpunit_shard_filter=''
    phpunit_command=()

    if [ -n "$PLUGIN_NAME" ]; then
      if [ -d "plugins/$PLUGIN_NAME/Test" ]; then
        phpunit_selection_args+=("plugins/$PLUGIN_NAME/Test/")
      elif [ -d "plugins/$PLUGIN_NAME/tests" ]; then
        phpunit_selection_args+=("plugins/$PLUGIN_NAME/tests/")
      else
        phpunit_selection_args+=(--group "$PLUGIN_NAME")
      fi
    fi

    if [ -n "$PHPUNIT_EXTRA_OPTIONS" ]; then
      read -r -a phpunit_run_extra_args <<< "$PHPUNIT_EXTRA_OPTIONS"
    fi
    if [ "$SHOULD_SEND_TO_TESTOMATIO" == "true" ]; then
      phpunit_run_extra_args+=("--log-junit" "results.xml")
    fi

    if validate_phpunit_shards && is_phpunit_suite "$TEST_SUITE"; then
      echo -e "${GREEN}Sharding PHPUnit suite $TEST_SUITE: shard ${PHPUNIT_TEST_SHARD_INDEX}/${PHPUNIT_TEST_SHARDS_TOTAL}${SET}"

      phpunit_shard_filter="$(
        set -o pipefail
        "${phpunit_base_command[@]}" "${phpunit_selection_args[@]}" --list-tests |
          php -r '
$tests = [];
while (($line = fgets(STDIN)) !== false) {
    if (preg_match("/^\s*-\s+(.+)$/", $line, $matches)) {
        $tests[] = preg_split("/::/", $matches[1], 2)[0];
    }
}

sort($tests, SORT_STRING);
$tests = array_values(array_unique($tests));
$total = (int) $argv[1];
$index = (int) $argv[2];

$selected = [];
foreach ($tests as $position => $testName) {
    if ($position % $total === $index) {
        $selected[] = preg_quote($testName, "/") . "::";
    }
}

if (count($selected) === 0) {
    fwrite(STDERR, "No PHPUnit tests selected for shard.\n");
    exit(1);
}

echo "^(?:" . implode("|", $selected) . ")";
' "$PHPUNIT_TEST_SHARDS_TOTAL" "$PHPUNIT_TEST_SHARD_INDEX"
      )"
      phpunit_shard_filter_status=$?
      if [ "$phpunit_shard_filter_status" -ne 0 ]; then
        exit "$phpunit_shard_filter_status"
      fi
    fi

    phpunit_command=("${phpunit_base_command[@]}" "${phpunit_selection_args[@]}" "${phpunit_run_extra_args[@]}")
    if [ -n "$phpunit_shard_filter" ]; then
      phpunit_command+=("--filter" "$phpunit_shard_filter")
    fi

    "${phpunit_command[@]}" | tee phpunit.out

    exit_code="${PIPESTATUS[0]}"

    if [ "$SHOULD_SEND_TO_TESTOMATIO" == "true" ]; then
      npm install @testomatio/reporter
      npx report-xml "results.xml" --lang php
    fi

    if [ "$exit_code" -ne "0" ]; then
      exit $exit_code
    elif grep "No tests executed" phpunit.out; then
      exit 1
    else
      exit 0
    fi
  fi
fi
