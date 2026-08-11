#!/bin/bash

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
SET='\033[0m'

if [ -z "$PLUGIN_NAME" ]; then
  exit 0
fi

if [ "$SKIP_GENERATED_CHECKS" == "true" ]; then
  echo -e "${YELLOW}skip-generated-checks is set, not generating compatibility checks${SET}"
  exit 0
fi

# only these suites include plugins/*/tests/Integration, see tests/PHPUnit/phpunit.xml.dist
case "$TEST_SUITE" in
  PluginTests|IntegrationTestsPlugins) ;;
  *)
    echo "Test suite '$TEST_SUITE' does not run plugin integration tests, not generating compatibility checks"
    exit 0
    ;;
esac

# same precedence as run_tests.sh uses to pick the directory it hands to phpunit
if [ -d "plugins/$PLUGIN_NAME/Test" ]; then
  TARGET_DIR="plugins/$PLUGIN_NAME/Test/Integration"
elif [ -d "plugins/$PLUGIN_NAME/tests" ]; then
  TARGET_DIR="plugins/$PLUGIN_NAME/tests/Integration"
else
  echo "Plugin $PLUGIN_NAME has no test directory, not generating compatibility checks"
  exit 0
fi

mkdir -p "$TARGET_DIR"

for template in "$ACTION_PATH"/scripts/php/templates/Generated*.php.tpl; do
  target="$TARGET_DIR/$(basename "$template" .tpl)"

  sed "s/{{PLUGIN_NAME}}/$PLUGIN_NAME/g" "$template" > "$target"

  echo -e "${GREEN}Generated $target${SET}"
  cat "$target"
done
