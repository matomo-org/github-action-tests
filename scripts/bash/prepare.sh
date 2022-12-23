#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

shopt -s extglob

echo -e "${GREEN}Using workspace path $WORKSPACE ${SET}"

if [ "$PLUGIN_NAME" != '' ]
then
  echo -e "${GREEN}Prepare directory for plugin tests ${SET}"

  echo -e "${GREEN}Move plugin content to directory${SET}"
  cd $WORKSPACE
  mkdir $PLUGIN_NAME
  cp -R !($PLUGIN_NAME) $PLUGIN_NAME

  echo -e "${GREEN}Clone Matomo repo${SET}"
  git clone -q --recurse-submodules https://github.com/matomo-org/matomo
  git fetch -q --all
  cd $WORKSPACE/matomo
  $ACTION_PATH/scripts/bash/checkout_test_against_branch.sh

  echo -e "${GREEN}Remove existing plugin (for submodules)${SET}"
  sudo rm -r $WORKSPACE/matomo/plugins/$PLUGIN_NAME

  echo -e "${GREEN}Move checked out plugin to plugins directory${SET}"
  sudo mv ../$PLUGIN_NAME plugins
fi

if [ "$MATOMO_TEST_TARGET" = "UI" ];
then
  cd $WORKSPACE/matomo
  git lfs pull --exclude=
  if [ "$PLUGIN_NAME" != '' ]
  then
    cd $WORKSPACE/matomo/plugins/$PLUGIN_NAME
    git lfs pull --exclude=
  fi
  echo -e "${GREEN}setup fonts${SET}"
  mkdir $HOME/.fonts
  cp $ACTION_PATH/artifacts/fonts/* $HOME/.fonts
  fc-cache -f -v
  ls $HOME/.fonts
  sudo sed -i -E 's/name="memory" value="[^"]+"/name="memory" value="2GiB"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="width" value="[^"]+"/name="width" value="64KP"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="height" value="[^"]+"/name="height" value="64KP"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="area" value="[^"]+"/name="area" value="1GiB"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="disk" value="[^"]+"/name="area" value="4GiB"/g' /etc/ImageMagick-6/policy.xml

fi

cd $WORKSPACE/matomo
echo -e "${GREEN}composer install${SET}"
composer install --ignore-platform-reqs

#php 8.1 require unitTest > 9
if [ "$PHP_VERSION" = "8.1" ] || [ "$PHP_VERSION" = "8.2" ];
then
  composer remove --dev phpunit/phpunit
  composer require --dev phpunit/phpunit ~9.3 --ignore-platform-reqs
fi

# setup config
sed "s/PDO_MYSQL/$MYSQL_ADAPTER/g" $ACTION_PATH/artifacts/config.ini.github.php > config/config.ini.php

# setup js and phpunit.xml
if [ "$MATOMO_TEST_TARGET" = "UI" ] || [ "$MATOMO_TEST_TARGET" = "JS" ];
then
  echo -e "${GREEN}installing node/puppeteer${SET}"
  cd $WORKSPACE/matomo/tests/lib/screenshot-testing
  npm install
  cd $WORKSPACE/matomo
  cp ./tests/UI/config.dist.js ./tests/UI/config.js
  chmod a+rw ./tests/lib/geoip-files || true
  mkdir -p ./tests/UI/processed-ui-screenshots
else
  cp ./tests/PHPUnit/phpunit.xml.dist ./tests/PHPUnit/phpunit.xml
  if [ -n "$PLUGIN_NAME" ];
  then
    sed -n '/<filter>/{p;:a;N;/<\/filter>/!ba;s/.*\n/<whitelist addUncoveredFilesFromWhitelist=\"true\">\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'<\/directory>\n<exclude>\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'\/tests<\/directory>\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'\/Test<\/directory>\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'\/Updates<\/directory>\n<\/exclude>\n<\/whitelist>\n/};p' ./tests/PHPUnit/phpunit.xml > ./tests/PHPUnit/phpunit.xml.new && mv ./tests/PHPUnit/phpunit.xml.new ./tests/PHPUnit/phpunit.xml
  fi;
fi

# if just js tests, running php -S otherwise use php fpm
if [ "$MATOMO_TEST_TARGET" = "JS" ] || [ "$MATOMO_TEST_TARGET" = "Angular" ];
then
  cd $WORKSPACE/matomo
  echo -e "${GREEN}start php on 80${SET}"
  sudo setcap CAP_NET_BIND_SERVICE=+eip $(readlink -f $(which php))
  tmux new-session -d -s "php-cgi" sudo php -S 127.0.0.1:80
  tmux ls
else
  echo -e "${GREEN}setup php-fpm${SET}"
  cd $WORKSPACE/matomo
  sudo systemctl enable php$PHP_VERSION-fpm.service
  sudo systemctl start php$PHP_VERSION-fpm.service
  sudo sed -i "s!{VersionNumber}!$PHP_VERSION!g" $ACTION_PATH/artifacts/www.conf
  sudo cp $ACTION_PATH/artifacts/www.conf /etc/php/$PHP_VERSION/fpm/pool.d/
  sudo systemctl reload php$PHP_VERSION-fpm.service
  sudo systemctl restart php$PHP_VERSION-fpm.service
  sudo systemctl enable nginx
  sudo systemctl start nginx
  sudo sed -i "s!{VersionNumber}!$PHP_VERSION!g" $ACTION_PATH/artifacts/ui_nginx.conf
  sudo sed -i "s!{WORKSPACE}!$WORKSPACE/matomo!g" $ACTION_PATH/artifacts/ui_nginx.conf
  sudo cp $ACTION_PATH/artifacts/ui_nginx.conf /etc/nginx/conf.d/
  sudo unlink /etc/nginx/sites-enabled/default
  sudo systemctl reload nginx
  sudo systemctl restart nginx
fi

if [ "$MATOMO_TEST_TARGET" = "UI" ];
then
  echo -e "${GREEN}update chrome driver${SET}"
  sudo apt-get update
  sudo apt-get --only-upgrade install google-chrome-stable
  google-chrome --version
fi

echo -e "${GREEN}prepare tmp folder${SET}"
cd $WORKSPACE/matomo
mkdir -p ./tmp/assets
mkdir -p ./tmp/cache
mkdir -p ./tmp/cache/tracker
mkdir -p ./tmp/latest
mkdir -p ./tmp/logs
mkdir -p ./tmp/sessions
mkdir -p ./tmp/templates_c
mkdir -p ./tmp/templates_c/d2
mkdir -p ./tmp/templates_c/2f
mkdir -p ./tmp/nonexistant
mkdir -p ./tmp/tcpdf
mkdir -p ./tmp/climulti
mkdir -p /tmp

echo -e "${GREEN}set folder permissions${SET}"
sudo chown -R "$USER":www-data /$WORKSPACE/matomo/
sudo chmod o+w $WORKSPACE/matomo/
cd $WORKSPACE/matomo/
sudo gpasswd -a "$USER" www-data
sudo chmod -R 777 $WORKSPACE/matomo/tmp
sudo chmod -R 777 $WORKSPACE/matomo/tmp/assets
sudo chmod -R 777 $WORKSPACE/matomo/tmp/templates_c
sudo chmod -R 777 $WORKSPACE/matomo/tests/UI
