#!/bin/bash

# NOTE: should be removed when composer used to handle plugin dependencies

if [ "$DEPENDENT_PLUGINS" == "" ]; then
  echo "No dependent plugins."
else
  echo "Cloning dependent plugins..."
  echo ""
  PLUGINS=($DEPENDENT_PLUGINS)
  for pluginSlug in ${PLUGINS[@]}; do
    # Both documented repository forms: owner/PluginName and owner/plugin-PluginName.
    # The strict plugin-name charset keeps the derived path inside plugins/ below.
    if [[ ! "$pluginSlug" =~ ^[A-Za-z0-9_.-]+/(plugin-)?([A-Za-z0-9_]+)$ ]]; then
        echo "Skipping invalid dependent plugin slug: $pluginSlug"
        continue
    fi
    dependentPluginName="${BASH_REMATCH[2]}"

    echo "Cloning $pluginSlug into plugins/$dependentPluginName..."

    rm -rf "plugins/$dependentPluginName"

    if [ "$GITHUB_USER_TOKEN" == "" ]; then
      REPO="https://github.com/$pluginSlug"
    else
      REPO="https://$GITHUB_USER_TOKEN:@github.com/$pluginSlug"
    fi
    
    CHECKOUTERROR=false
    
    git clone --depth=1 $REPO "plugins/$dependentPluginName" || CHECKOUTERROR=true
    
    if [ "$CHECKOUTERROR" = true ]; then
        echo "Failed to checkout $pluginSlug. Skipping."
        continue
    fi

    if [[ $TARGET_BRANCH =~ ^[0-9]\.x-dev$ ]]; then
      cd plugins/$dependentPluginName
      git fetch origin $TARGET_BRANCH || true
      git checkout FETCH_HEAD || true
      cd ../..
    fi

    rm -rf "plugins/$dependentPluginName/tests/Integration"
    rm -rf "plugins/$dependentPluginName/Test/Integration"
    rm -rf "plugins/$dependentPluginName/tests/Unit"
    rm -rf "plugins/$dependentPluginName/Test/Unit"
    rm -rf "plugins/$dependentPluginName/tests/System"
    rm -rf "plugins/$dependentPluginName/Test/System"
  done

  echo "Plugin directory:"
  echo ""

  ls -d plugins/*
fi
