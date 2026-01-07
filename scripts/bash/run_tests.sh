#!/bin/bash
RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

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
    if [ "$SHOULD_SEND_TO_TESTOMATIO" == "true" ]; then
      PHPUNIT_EXTRA_OPTIONS="$PHPUNIT_EXTRA_OPTIONS --log-junit results.xml"
    fi

    echo "========================================"
    echo "PHP VERSION DEBUG"
    echo "PHP VERSION IS: $(php -r "echo PHP_VERSION;")"
    echo "========================================"
    echo "PHP VERSIONS INSTALLED:"
    if [ -d /etc/php ]; then
      ls -1 /etc/php
    else
      echo "/etc/php not found"
    fi
    if [ -f ./vendor/phpunit/phpunit/phpunit ]; then
      if ! grep -q "PHP version within PHPUNIT" ./vendor/phpunit/phpunit/phpunit; then
        phpunit_tmp="$(mktemp)"
        awk '
          BEGIN { inserted = 0 }
          { print }
          /declare\(strict_types=1\);/ && inserted == 0 {
            print "";
            print "echo \"************** PHP version within PHPUNIT *************\\n\";";
            print "echo \"PHP VERSION IS: \" . PHP_VERSION . \"\\n\";";
            print "echo \"********************************************************\\n\";";
            print "echo \"Instantiator.php output ++++++++++\\n\";";
            print "$instantiatorPath = \"/home/runner/work/matomo/matomo/matomo/vendor/doctrine/instantiator/src/Doctrine/Instantiator/Instantiator.php\";";
            print "if (is_file($instantiatorPath)) {";
            print "    echo file_get_contents($instantiatorPath);";
            print "} else {";
            print "    echo \"File not found: \" . $instantiatorPath . \"\\n\";";
            print "}";
            print "echo \"\\n++++++++++\\n\";";
            inserted = 1
          }
        ' ./vendor/phpunit/phpunit/phpunit > "$phpunit_tmp" && mv "$phpunit_tmp" ./vendor/phpunit/phpunit/phpunit
      fi
    fi
    echo "=-=-=-=-=-= phpunit -=-=-=-=-=-"
    head -n 10 ./vendor/phpunit/phpunit/phpunit
    echo "=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-"

    if [ -n "$PLUGIN_NAME" ]; then
      if [ -d "plugins/$PLUGIN_NAME/Test" ]; then
        php ./vendor/phpunit/phpunit/phpunit --configuration ./tests/PHPUnit/phpunit.xml --colors --testsuite $TEST_SUITE $PHPUNIT_EXTRA_OPTIONS plugins/$PLUGIN_NAME/Test/ | tee phpunit.out
      elif [ -d "plugins/$PLUGIN_NAME/tests" ]; then
        php ./vendor/phpunit/phpunit/phpunit --configuration ./tests/PHPUnit/phpunit.xml --colors --testsuite $TEST_SUITE $PHPUNIT_EXTRA_OPTIONS plugins/$PLUGIN_NAME/tests/ | tee phpunit.out
      else
        php ./vendor/phpunit/phpunit/phpunit --configuration ./tests/PHPUnit/phpunit.xml --colors --testsuite $TEST_SUITE --group $PLUGIN_NAME $PHPUNIT_EXTRA_OPTIONS | tee phpunit.out
      fi
    else
      php ./vendor/phpunit/phpunit/phpunit --configuration ./tests/PHPUnit/phpunit.xml --testsuite $TEST_SUITE --colors $PHPUNIT_EXTRA_OPTIONS | tee phpunit.out
    fi

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
