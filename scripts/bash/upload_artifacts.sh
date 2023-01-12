#!/bin/bash
RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

url_base="https://builds-artifacts.matomo.org/build?auth_key=$ARTIFACTS_PASS&repo=$GITHUB_REPO&build_id=$GITHUB_RUN_ID&build_entity_id=$GITHUB_RUN_NUMBER&branch=$GITHUB_BRANCH&github=true"

if [ "$TEST_SUITE" = "UI" ];
then
  if [ -n "$PLUGIN_NAME" ];
  then
      if [ -d "$WORKSPACE/plugins/$PLUGIN_NAME/Test/UI" ]; then
          cd "$WORKSPACE/plugins/$PLUGIN_NAME/Test/UI"
      else
          cd "$WORKSPACE/plugins/$PLUGIN_NAME/tests/UI"
      fi
  else
      cd "$WORKSPACE/tests/UI"
  fi

  echo "[NOTE] Uploading processed screenshots:"
  ls processed-ui-screenshots
  echo ""
  tar --exclude='.gitkeep' -cjf processed-ui-screenshots.tar.bz2 processed-ui-screenshots
  curl -X POST --data-binary @processed-ui-screenshots.tar.bz2 "$url_base&artifact_name=processed-screenshots"

  # upload diff tarball if it exists
  cd $WORKSPACE/tests/UI
  if [ -d "./screenshot-diffs" ];
  then
     echo "[NOTE] Uploading following diffs:"
     ls screenshot-diffs

     tar -cjf screenshot-diffs.tar.bz2 screenshot-diffs
     curl -X POST --data-binary @screenshot-diffs.tar.bz2 "$url_base&artifact_name=screenshot-diffs"
  fi
fi

if [ "$TEST_SUITE" = "SystemTestsCore" ];
then
  cd "$WORKSPACE"
  tar --exclude='.gitkeep' -cjf processed.tar.bz2 tests/PHPUnit/System/processed/* --transform 's/.*\///'
  curl -X POST --data-binary @processed.tar.bz2 "$url_base&artifact_name=system"
fi

if [ "$TEST_SUITE" = "SystemTestsPlugins" ];
then
  cd "$WORKSPACE"
  tar --exclude='.gitkeep' -cjf processed.tar.bz2 plugins/*/tests/System/processed/* --transform 's/plugins\///g' --transform 's/\/tests\/System\/processed\//~~/'
  curl -X POST --data-binary @processed.tar.bz2 "$url_base&artifact_name=system.plugin"
fi

if [ "$TEST_SUITE" = "PluginTests" ];
then
  cd "$WORKSPACE"
  tar --exclude='.gitkeep' -cjf processed.tar.bz2 plugins/$PLUGIN_NAME/tests/System/processed/* --transform "s/plugins\/$PLUGIN_NAME\/tests\/System\/processed\///"
  curl -X POST --data-binary @processed.tar.bz2 "$url_base&artifact_name=system"
fi

echo ""
echo -e "${GREEN}Uploading Finished...${SET}"
echo ""
echo -e "${GREEN}You can download or view the processed artifacts here:${GREEN}"
echo ""
echo -e "${GREEN}https://builds-artifacts.matomo.org/github/$GITHUB_REPO/$GITHUB_BRANCH/$GITHUB_RUN_ID/${SET}"
