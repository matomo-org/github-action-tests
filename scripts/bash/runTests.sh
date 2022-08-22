#!/bin/bash
RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

if [ -n "$TEST_SUITE" == 'PHP' ]
then
    echo -e "${GREEN}Executing PHP Tests ...${SET}"
    ./vendor/phpunit/phpunit/phpunit --configuration ./tests/PHPUnit/phpunit.xml --testsuite $COMMAND
fi

if [ -n "$TEST_SUITE" == 'UI' ]
then
   echo -e "${GREEN}Executing UI Tests ...${SET}"
   ./console tests:run-ui --store-in-ui-tests-repo --persist-fixture-data --assume-artifacts --core --extra-options="--num-test-groups=8 --test-group=$COMMAND"
fi


if [-n "$TEST_SUITE" == 'Angular' ]
then
   echo -e "${GREEN}Executing JS Tests ...${SET}"
   cd /home/runner/work/matomo/matomo/tests/angularjs
   npm install
  ./node_modules/karma/bin/karma start karma.conf.js --browsers ChromeHeadless --single-run
fi

if [-n "$TEST_SUITE" == 'JS' ]
then
    echo -e "${GREEN}Executing JS Tests ...${SET}"
  ./console tests:run-js --matomo-url='http://localhost'
fi