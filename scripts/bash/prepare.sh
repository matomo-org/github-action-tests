#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

shopt -s extglob

echo "::group::Setup test environment"

echo -e "${GREEN}Using workspace path $WORKSPACE ${SET}"

if [ "$TEST_SUITE" = "UI" ]; then
  cd $WORKSPACE/matomo
  git lfs pull --exclude=
  if [ "$PLUGIN_NAME" != '' ]; then
    cd $WORKSPACE/matomo/plugins/$PLUGIN_NAME
    git lfs pull --exclude=
  fi
  echo -e "${GREEN}setup fonts${SET}"
  mkdir $HOME/.fonts
  cp $ACTION_PATH/artifacts/fonts/* $HOME/.fonts
  fc-cache -f -v
  ls $HOME/.fonts
  sudo apt-get update --allow-releaseinfo-change-label && sudo apt-get install -y imagemagick
  sudo sed -i -E 's/name="memory" value="[^"]+"/name="memory" value="2GiB"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="width" value="[^"]+"/name="width" value="64KP"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="height" value="[^"]+"/name="height" value="64KP"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="area" value="[^"]+"/name="area" value="1GiB"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="disk" value="[^"]+"/name="area" value="4GiB"/g' /etc/ImageMagick-6/policy.xml

fi

cd $WORKSPACE/matomo
echo -e "${GREEN}composer install${SET}"
# prevents possible error with older Matomo releases, that doesn't include that config
composer config --no-plugins allow-plugins.dealerdirect/phpcodesniffer-composer-installer false
composer install --ignore-platform-reqs

# use PHPUnit 9.x for PHP 8.x
if [[ "$PHP_VERSION" == "8."* ]]; then
  composer remove --dev phpunit/phpunit
  composer require --dev phpunit/phpunit ~9.3 --ignore-platform-reqs
fi

# setup config
sed "s/PDO_MYSQL/$MYSQL_ADAPTER/g; s/schema = Mysql/schema = $MYSQL_ENGINE/g" $ACTION_PATH/artifacts/config.ini.github.php >config/config.ini.php

# for plugin builds on minimal required matomo version disable deprecation notices
if [ "$PLUGIN_NAME" != '' ] && [ "$MATOMO_TEST_TARGET" == "minimum_required_matomo" ]; then
  sed -i -E "s/error_reporting\(.*\)/error_reporting(E_ALL \& ~E_DEPRECATED)/g" core/bootstrap.php
fi

# setup js and phpunit.xml
if [ "$TEST_SUITE" = "UI" ] || [ "$TEST_SUITE" = "JS" ]; then
  echo -e "${GREEN}installing node/puppeteer${SET}"
  cd $WORKSPACE/matomo/tests/lib/screenshot-testing
  npm ci
  cd $WORKSPACE/matomo
  cp ./tests/UI/config.dist.js ./tests/UI/config.js
  chmod a+rw ./tests/lib/geoip-files || true
  mkdir -p ./tests/UI/processed-ui-screenshots
else
  cp ./tests/PHPUnit/phpunit.xml.dist ./tests/PHPUnit/phpunit.xml
  if [ -n "$PLUGIN_NAME" ]; then
    sed -n '/<filter>/{p;:a;N;/<\/filter>/!ba;s/.*\n/<whitelist addUncoveredFilesFromWhitelist=\"true\">\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'<\/directory>\n<exclude>\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'\/tests<\/directory>\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'\/Test<\/directory>\n<directory suffix=\".php\">..\/..\/plugins\/'$PLUGIN_NAME'\/Updates<\/directory>\n<\/exclude>\n<\/whitelist>\n/};p' ./tests/PHPUnit/phpunit.xml >./tests/PHPUnit/phpunit.xml.new && mv ./tests/PHPUnit/phpunit.xml.new ./tests/PHPUnit/phpunit.xml
  fi
fi

# if just js tests, running php -S otherwise use php fpm
if [ "$TEST_SUITE" = "JS" ] || [ "$TEST_SUITE" = "Client" ]; then
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
  sudo sed -i "s!{VersionNumber}!$PHP_VERSION!g" $ACTION_PATH/artifacts/ui_nginx.conf
  sudo sed -i "s!{WORKSPACE}!$WORKSPACE/matomo!g" $ACTION_PATH/artifacts/ui_nginx.conf
  sudo sed -i "s!{USER}!$USER!g" $ACTION_PATH/artifacts/ui_nginx.conf
  sudo nginx -c $ACTION_PATH/artifacts/ui_nginx.conf
  sudo unlink /etc/nginx/sites-enabled/default
  sudo systemctl status nginx.service
fi

if [ "$TEST_SUITE" = "UI" ]; then
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

echo "::endgroup::"
