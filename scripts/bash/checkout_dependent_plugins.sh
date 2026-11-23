#!/bin/bash

# NOTE: should be removed when composer used to handle plugin dependencies

set -e

if [ "$DEPENDENT_PLUGINS" == "" ]; then
  echo "No dependent plugins."
  exit 0
fi

echo "Cloning dependent plugins..."
echo ""

CLONE_DIR=$(mktemp -d)
FAILED=""

# The token is sent as a header, so it is not kept in the address of the clone.
GIT_AUTH=()
if [ "$GITHUB_USER_TOKEN" != "" ]; then
  GIT_AUTH=(-c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_USER_TOKEN" | base64 | tr -d '\n')")
fi

for pluginSlug in ${DEPENDENT_PLUGINS//,/ }; do
  target="$CLONE_DIR/$(basename "$pluginSlug")"

  echo "Cloning $pluginSlug..."
  if ! git "${GIT_AUTH[@]}" clone --depth=1 "https://github.com/$pluginSlug" "$target"; then
    echo "::error::Failed to check out the dependent plugin $pluginSlug"
    FAILED="$FAILED $pluginSlug"
    continue
  fi

  if [[ $TARGET_BRANCH =~ ^[0-9]\.x-dev$ ]]; then
    git -C "$target" "${GIT_AUTH[@]}" fetch --depth=1 origin "$TARGET_BRANCH" && git -C "$target" checkout FETCH_HEAD || true
  fi

  # The folder of a plugin is the name in its plugin.json, whatever the repository is called.
  dependentPluginName=$(php -r '$json = json_decode((string) @file_get_contents($argv[1]), true); echo is_array($json) && is_string($json["name"] ?? null) ? $json["name"] : "";' "$target/plugin.json")
  if [[ ! $dependentPluginName =~ ^[a-zA-Z0-9_]+$ ]]; then
    echo "::error::$pluginSlug has no plugin.json with a plugin name"
    FAILED="$FAILED $pluginSlug"
    continue
  fi

  echo "Placing $pluginSlug in plugins/$dependentPluginName"
  rm -rf "plugins/$dependentPluginName"
  mv "$target" "plugins/$dependentPluginName"

  rm -rf "plugins/$dependentPluginName/tests/Integration"
  rm -rf "plugins/$dependentPluginName/Test/Integration"
  rm -rf "plugins/$dependentPluginName/tests/Unit"
  rm -rf "plugins/$dependentPluginName/Test/Unit"
  rm -rf "plugins/$dependentPluginName/tests/System"
  rm -rf "plugins/$dependentPluginName/Test/System"
done

rm -rf "$CLONE_DIR"

echo "Plugin directory:"
echo ""

ls -d plugins/*

if [ "$FAILED" != "" ]; then
  echo "::error::Dependent plugins that could not be set up:$FAILED"
  exit 1
fi
