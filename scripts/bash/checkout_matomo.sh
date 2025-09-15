#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

shopt -s extglob
set -x # trace commands

if [ "$PLUGIN_NAME" != '' ]; then
  echo -e "${GREEN}Prepare directory for plugin tests ${SET}"

  echo -e "${GREEN}Move plugin content to directory${SET}"
  cd $WORKSPACE
  mkdir $PLUGIN_NAME
  cp -R !($PLUGIN_NAME) $PLUGIN_NAME

  echo -e "${GREEN}Clone Matomo repo${SET}"

  if [ "$GITHUB_USER_TOKEN" == "" ]; then
    REPO="https://github.com/matomo-org/matomo"
  else
    REPO="https://$GITHUB_USER_TOKEN:@github.com/matomo-org/matomo"
  fi


  git clone -q --recurse-submodules ${REPO}
  git fetch -q --all
  cd $WORKSPACE/matomo

  export PLUGIN_NAME
  export MATOMO_TEST_TARGET
  export TEST_SUITE
  export ACTION_PATH
  export WORKSPACE

  $ACTION_PATH/scripts/bash/checkout_test_against_branch.sh

  echo -e "${GREEN}Remove existing plugin (for submodules)${SET}"
  sudo rm -rf $WORKSPACE/matomo/plugins/$PLUGIN_NAME

  echo -e "${GREEN}Move checked out plugin to plugins directory${SET}"
  sudo mv ../$PLUGIN_NAME plugins
fi
