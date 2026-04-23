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

function collect_phpunit_suite_files {
  php <<'PHP'
<?php
$suiteName = getenv('TARGET_TEST_SUITE');
$configPath = getcwd() . '/tests/PHPUnit/phpunit.xml';

if (!$suiteName) {
    fwrite(STDERR, "TARGET_TEST_SUITE is not set.\n");
    exit(1);
}

if (!file_exists($configPath)) {
    fwrite(STDERR, "Unable to find phpunit config at {$configPath}.\n");
    exit(1);
}

$dom = new DOMDocument();
$dom->preserveWhiteSpace = false;

if (!@$dom->load($configPath)) {
    fwrite(STDERR, "Unable to parse phpunit config at {$configPath}.\n");
    exit(1);
}

$suiteNodes = [];
foreach ($dom->getElementsByTagName('testsuite') as $testsuiteNode) {
    if ($testsuiteNode->getAttribute('name') === $suiteName) {
        $suiteNodes[] = $testsuiteNode;
    }
}

if (count($suiteNodes) === 0) {
    fwrite(STDERR, "Unable to find testsuite '{$suiteName}' in {$configPath}.\n");
    exit(1);
}

$configDir = dirname(realpath($configPath));
$paths = [];

function expandPattern($configDir, $rawPath)
{
    $absolutePattern = strlen($rawPath) > 0 && $rawPath[0] === '/'
        ? $rawPath
        : $configDir . '/' . $rawPath;

    $matches = glob($absolutePattern, GLOB_BRACE);
    if ($matches === false || count($matches) === 0) {
        $resolvedPath = realpath($absolutePattern);
        return $resolvedPath ? [$resolvedPath] : [];
    }

    $resolvedMatches = [];
    foreach ($matches as $match) {
        $resolvedMatch = realpath($match);
        if ($resolvedMatch) {
            $resolvedMatches[] = $resolvedMatch;
        }
    }

    return $resolvedMatches;
}

foreach ($suiteNodes as $suiteNode) {
    $suiteLevelExcludes = [];

    foreach ($suiteNode->childNodes as $childNode) {
        if (!$childNode instanceof DOMElement || $childNode->nodeName !== 'exclude') {
            continue;
        }

        $excludePath = trim($childNode->textContent);
        if ($excludePath === '') {
            continue;
        }

        foreach (expandPattern($configDir, $excludePath) as $resolvedExclude) {
            $suiteLevelExcludes[] = rtrim($resolvedExclude, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        }
    }

    foreach ($suiteNode->childNodes as $childNode) {
        if (!$childNode instanceof DOMElement) {
            continue;
        }

        $nodeName = $childNode->nodeName;
        $rawPath = trim($childNode->textContent);
        if ($rawPath === '') {
            continue;
        }

        if ($nodeName === 'file') {
            foreach (expandPattern($configDir, $rawPath) as $resolvedFile) {
                if (is_file($resolvedFile)) {
                    $paths[$resolvedFile] = true;
                }
            }
            continue;
        }

        if ($nodeName !== 'directory') {
            continue;
        }

        $suffix = $childNode->getAttribute('suffix');
        if ($suffix === '') {
            $suffix = 'Test.php';
        }
        $prefix = $childNode->getAttribute('prefix');

        $directoryLevelExcludes = [];
        foreach ($childNode->childNodes as $directoryChild) {
            if (!$directoryChild instanceof DOMElement || $directoryChild->nodeName !== 'exclude') {
                continue;
            }

            $excludePath = trim($directoryChild->textContent);
            if ($excludePath === '') {
                continue;
            }

            foreach (expandPattern($configDir, $excludePath) as $resolvedExclude) {
                $directoryLevelExcludes[] = rtrim($resolvedExclude, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
            }
        }

        $excludePaths = array_merge($suiteLevelExcludes, $directoryLevelExcludes);

        foreach (expandPattern($configDir, $rawPath) as $resolvedDir) {
            if (!is_dir($resolvedDir)) {
                continue;
            }

            $iterator = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($resolvedDir, FilesystemIterator::SKIP_DOTS)
            );

            foreach ($iterator as $fileInfo) {
                if (!$fileInfo->isFile()) {
                    continue;
                }

                $filePath = $fileInfo->getPathname();
                $normalizedFilePath = rtrim($filePath, DIRECTORY_SEPARATOR);

                $isExcluded = false;
                foreach ($excludePaths as $excludePath) {
                    if (strpos($normalizedFilePath . DIRECTORY_SEPARATOR, $excludePath) === 0) {
                        $isExcluded = true;
                        break;
                    }
                }
                if ($isExcluded) {
                    continue;
                }

                $filename = $fileInfo->getFilename();
                if ($suffix !== '' && substr($filename, -strlen($suffix)) !== $suffix) {
                    continue;
                }
                if ($prefix !== '' && strpos($filename, $prefix) !== 0) {
                    continue;
                }

                $paths[$filePath] = true;
            }
        }
    }
}

$files = array_keys($paths);
sort($files, SORT_STRING);

foreach ($files as $file) {
    echo $file, "\0";
}
PHP
}

function collect_plugin_test_files {
  local plugin_dir="$1"
  find "$plugin_dir" -type f -name '*Test.php' -print0 | sort -z
}

function collect_phpunit_suite_directories {
  php <<'PHP'
<?php
$suiteName = getenv('TARGET_TEST_SUITE');
$configPath = getcwd() . '/tests/PHPUnit/phpunit.xml';

if (!$suiteName) {
    fwrite(STDERR, "TARGET_TEST_SUITE is not set.\n");
    exit(1);
}

if (!file_exists($configPath)) {
    fwrite(STDERR, "Unable to find phpunit config at {$configPath}.\n");
    exit(1);
}

$dom = new DOMDocument();
$dom->preserveWhiteSpace = false;

if (!@$dom->load($configPath)) {
    fwrite(STDERR, "Unable to parse phpunit config at {$configPath}.\n");
    exit(1);
}

$suiteNodes = [];
foreach ($dom->getElementsByTagName('testsuite') as $testsuiteNode) {
    if ($testsuiteNode->getAttribute('name') === $suiteName) {
        $suiteNodes[] = $testsuiteNode;
    }
}

if (count($suiteNodes) === 0) {
    fwrite(STDERR, "Unable to find testsuite '{$suiteName}' in {$configPath}.\n");
    exit(1);
}

$configDir = dirname(realpath($configPath));
$paths = [];

function expandPatternToDirectories($configDir, $rawPath)
{
    $absolutePattern = strlen($rawPath) > 0 && $rawPath[0] === '/'
        ? $rawPath
        : $configDir . '/' . $rawPath;

    $matches = glob($absolutePattern, GLOB_BRACE);
    if ($matches === false || count($matches) === 0) {
        $resolvedPath = realpath($absolutePattern);
        return ($resolvedPath && is_dir($resolvedPath)) ? [$resolvedPath] : [];
    }

    $resolvedMatches = [];
    foreach ($matches as $match) {
        $resolvedMatch = realpath($match);
        if ($resolvedMatch && is_dir($resolvedMatch)) {
            $resolvedMatches[] = $resolvedMatch;
        }
    }

    return $resolvedMatches;
}

foreach ($suiteNodes as $suiteNode) {
    foreach ($suiteNode->childNodes as $childNode) {
        if (!$childNode instanceof DOMElement || $childNode->nodeName !== 'directory') {
            continue;
        }

        $rawPath = trim($childNode->textContent);
        if ($rawPath === '') {
            continue;
        }

        foreach (expandPatternToDirectories($configDir, $rawPath) as $resolvedDir) {
            $paths[$resolvedDir] = true;
        }
    }
}

$directories = array_keys($paths);
sort($directories, SORT_STRING);

foreach ($directories as $directory) {
    echo $directory, "\0";
}
PHP
}

function select_shard_files {
  local total="$1"
  local index="$2"
  shift 2

  local selected_files=()
  local current_index=0
  local file

  for file in "$@"; do
    if [ $((current_index % total)) -eq "$index" ]; then
      selected_files+=("$file")
    fi
    current_index=$((current_index + 1))
  done

  if [ "${#selected_files[@]}" -gt 0 ]; then
    printf '%s\0' "${selected_files[@]}"
  fi
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
    if [ "$SHOULD_SEND_TO_TESTOMATIO" == "true" ]; then
      PHPUNIT_EXTRA_OPTIONS="$PHPUNIT_EXTRA_OPTIONS --log-junit results.xml"
    fi

    phpunit_extra_args=()
    if [ -n "$PHPUNIT_EXTRA_OPTIONS" ]; then
      read -r -a phpunit_extra_args <<< "$PHPUNIT_EXTRA_OPTIONS"
    fi

    phpunit_base_command=(./vendor/phpunit/phpunit/phpunit --configuration ./tests/PHPUnit/phpunit.xml --colors)
    phpunit_command=()
    shard_files=()
    shard_directories=()
    shard_by_directories=false

    if validate_phpunit_shards && is_phpunit_suite "$TEST_SUITE"; then
      echo -e "${GREEN}Sharding PHPUnit suite $TEST_SUITE: shard ${PHPUNIT_TEST_SHARD_INDEX}/${PHPUNIT_TEST_SHARDS_TOTAL}${SET}"

      all_shard_files=()
      all_shard_directories=()

      if [ "$TEST_SUITE" = "IntegrationTestsPlugins" ] && [ -z "$PLUGIN_NAME" ]; then
        shard_by_directories=true
        while IFS= read -r -d '' file; do
          all_shard_directories+=("$file")
        done < <(TARGET_TEST_SUITE="$TEST_SUITE" collect_phpunit_suite_directories)

        if [ "${#all_shard_directories[@]}" -eq 0 ]; then
          echo "No PHPUnit test directories found for suite $TEST_SUITE."
          exit 1
        fi

        while IFS= read -r -d '' file; do
          shard_directories+=("$file")
        done < <(select_shard_files "$PHPUNIT_TEST_SHARDS_TOTAL" "$PHPUNIT_TEST_SHARD_INDEX" "${all_shard_directories[@]}")

        if [ "${#shard_directories[@]}" -eq 0 ]; then
          echo "No PHPUnit test directories selected for suite $TEST_SUITE shard ${PHPUNIT_TEST_SHARD_INDEX}/${PHPUNIT_TEST_SHARDS_TOTAL}."
          exit 1
        fi

        echo -e "${GREEN}Selected ${#shard_directories[@]} of ${#all_shard_directories[@]} plugin integration directories for this shard.${SET}"
      elif [ -n "$PLUGIN_NAME" ]; then
        if [ -d "plugins/$PLUGIN_NAME/Test" ]; then
          while IFS= read -r -d '' file; do
            all_shard_files+=("$file")
          done < <(collect_plugin_test_files "plugins/$PLUGIN_NAME/Test")
        elif [ -d "plugins/$PLUGIN_NAME/tests" ]; then
          while IFS= read -r -d '' file; do
            all_shard_files+=("$file")
          done < <(collect_plugin_test_files "plugins/$PLUGIN_NAME/tests")
        else
          echo "Sharding is not supported for group-based plugin test selection."
          exit 1
        fi
      else
        while IFS= read -r -d '' file; do
          all_shard_files+=("$file")
        done < <(TARGET_TEST_SUITE="$TEST_SUITE" collect_phpunit_suite_files)
      fi

      if [ "$shard_by_directories" != "true" ]; then
        if [ "${#all_shard_files[@]}" -eq 0 ]; then
          echo "No PHPUnit test files found for suite $TEST_SUITE."
          exit 1
        fi

        while IFS= read -r -d '' file; do
          shard_files+=("$file")
        done < <(select_shard_files "$PHPUNIT_TEST_SHARDS_TOTAL" "$PHPUNIT_TEST_SHARD_INDEX" "${all_shard_files[@]}")

        if [ "${#shard_files[@]}" -eq 0 ]; then
          echo "No PHPUnit test files selected for suite $TEST_SUITE shard ${PHPUNIT_TEST_SHARD_INDEX}/${PHPUNIT_TEST_SHARDS_TOTAL}."
          exit 1
        fi

        echo -e "${GREEN}Selected ${#shard_files[@]} of ${#all_shard_files[@]} test files for this shard.${SET}"
      fi
    fi

    if [ -n "$PLUGIN_NAME" ]; then
      if [ -d "plugins/$PLUGIN_NAME/Test" ]; then
        phpunit_command=("${phpunit_base_command[@]}" --testsuite "$TEST_SUITE" "${phpunit_extra_args[@]}")
        if [ "${#shard_files[@]}" -gt 0 ]; then
          phpunit_command+=("${shard_files[@]}")
        else
          phpunit_command+=("plugins/$PLUGIN_NAME/Test/")
        fi
      elif [ -d "plugins/$PLUGIN_NAME/tests" ]; then
        phpunit_command=("${phpunit_base_command[@]}" --testsuite "$TEST_SUITE" "${phpunit_extra_args[@]}")
        if [ "${#shard_files[@]}" -gt 0 ]; then
          phpunit_command+=("${shard_files[@]}")
        else
          phpunit_command+=("plugins/$PLUGIN_NAME/tests/")
        fi
      else
        phpunit_command=("${phpunit_base_command[@]}" --testsuite "$TEST_SUITE" --group "$PLUGIN_NAME" "${phpunit_extra_args[@]}")
      fi
    else
      phpunit_command=("${phpunit_base_command[@]}" --testsuite "$TEST_SUITE" "${phpunit_extra_args[@]}")
      if [ "${#shard_directories[@]}" -gt 0 ]; then
        phpunit_command+=("${shard_directories[@]}")
      elif [ "${#shard_files[@]}" -gt 0 ]; then
        phpunit_command+=("${shard_files[@]}")
      fi
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
