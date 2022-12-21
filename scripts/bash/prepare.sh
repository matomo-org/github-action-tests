#!/bin/bash


RED='\033[0;31m'
GREEN='\033[0;32m'
SET='\033[0m'

echo -e "${GREEN} Prepare directory ${SET}"
if [ "$PLUGIN_NAME" == '' ]
then
    echo -e "${GREEN} rm matomo folder${SET}"
    sudo rm -r /home/runner/work/matomo/*
fi
if [ "$PLUGIN_NAME" != '' ]
then
   sudo mkdir /home/runner/work/matomo/
   sudo chown -R "$USER":www-data /home/runner/work/matomo/
fi

echo -e "${GREEN} Clone repo${SET}"
cd /home/runner/work/matomo
git clone --recurse-submodules https://github.com/matomo-org/matomo
cd /home/runner/work/matomo/matomo

if [ "$PLUGIN_NAME" != '' ]
then
  echo -e "${GREEN} Switch to plugin ${$PLUGIN_NAME} DIR ${SET}"
  cp -r $WORKSPACE/../* /home/runner/work/$PLUGIN_NAME/
  mv /home/runner/work/$PLUGIN_NAME /home/runner/work/matomo/matomo/plugins/
  cd /home/runner/work/matomo/matomo/plugins/$PLUGIN_NAME
fi
if [ -n "$REF" ]
then
   echo -e "${GREEN} Checkout ${REF} branch ${SET}"
   git fetch origin $REF:newbranch
   git checkout -b current newbranch
fi
cd /home/runner/work/matomo/matomo
git submodule update --init --recursive

# set up fonts
if [ "$MATOMO_TEST_TARGET" = "UI" ];
then
  echo -e "${GREEN}Setup fonts${SET}"
  mkdir $HOME/.fonts
  cp /home/runner/work/appendix/artifacts/fonts/* $HOME/.fonts
  fc-cache -f -v
  ls $HOME/.fonts
  sudo sed -i -E 's/name="memory" value="[^"]+"/name="memory" value="2GiB"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="width" value="[^"]+"/name="width" value="64KP"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="height" value="[^"]+"/name="height" value="64KP"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="area" value="[^"]+"/name="area" value="1GiB"/g' /etc/ImageMagick-6/policy.xml
  sudo sed -i -E 's/name="disk" value="[^"]+"/name="area" value="4GiB"/g' /etc/ImageMagick-6/policy.xml

fi

# composer install
cd /home/runner/work/matomo/matomo/
echo -e "${GREEN}install composer${SET}"
composer install --ignore-platform-reqs

#php 8.1 require unitTest > 9
if [ "$PHP_VERSION" = "8.1" ];
then
  composer remove --dev phpunit/phpunit
  composer require --dev phpunit/phpunit ~9.3 --ignore-platform-reqs
fi

# setup config
sed "s/PDO_MYSQL/$MYSQL_ADAPTER/g" /home/runner/work/appendix/artifacts/config.ini.github.php > config/config.ini.php

# setup js and phpunit.xml
if [ "$MATOMO_TEST_TARGET" = "UI" ];
then
  echo -e "${GREEN}installing node/puppeteer${SET}"
  cd /home/runner/work/matomo/matomo/tests/lib/screenshot-testing
  git lfs pull --exclude=
  npm install
  cd /home/runner/work/matomo/matomo/
  cp ./tests/UI/config.dist.js ./tests/UI/config.js
  chmod a+rw ./tests/lib/geoip-files || true
  chmod a+rw ./plugins/*/tests/System/processed || true
  chmod a+rw ./plugins/*/tests/Integration/processed || true
  mkdir -p ./tests/UI/processed-ui-screenshots
else
  cp ./tests/PHPUnit/phpunit.xml.dist ./tests/PHPUnit/phpunit.xml
fi

# if just js tests, running php -S otherwise use php fpm
if [ "$MATOMO_TEST_TARGET" = "JS" ] || [ "$MATOMO_TEST_TARGET" = "Angular" ];
then
  echo -e "${GREEN}installing node/puppeteer${SET}"
  cd /home/runner/work/matomo/matomo/tests/lib/screenshot-testing
  git lfs pull --exclude=
  npm install
  cd /home/runner/work/matomo/matomo/
  echo -e "${GREEN}start php on 80${SET}"
  sudo setcap CAP_NET_BIND_SERVICE=+eip $(readlink -f $(which php))
  tmux new-session -d -s "php-cgi" sudo php -S 127.0.0.1:80
  tmux ls
else
  echo -e "${GREEN}setup php-fpm${SET}"
  cd /home/runner/work/matomo/matomo/
  sudo systemctl enable php$PHP_VERSION-fpm.service
  sudo systemctl start php$PHP_VERSION-fpm.service
  sudo sed 's/VersionNumber/$PHP_VERSION/g' /home/runner/work/appendix/artifacts/www.conf
  sudo cp /home/runner/work/appendix/artifacts/www.conf  /etc/php/$PHP_VERSION/fpm/pool.d/
  sudo systemctl reload php$PHP_VERSION-fpm.service
  sudo systemctl restart php$PHP_VERSION-fpm.service
  sudo systemctl enable nginx
  sudo systemctl start nginx
  sudo sed 's/VersionNumber/$PHP_VERSION/g' /home/runner/work/appendix/artifacts/ui_nginx.conf
  sudo cp  /home/runner/work/appendix/artifacts/ui_nginx.conf /etc/nginx/conf.d/
  sudo unlink /etc/nginx/sites-enabled/default
  sudo systemctl reload nginx
  sudo systemctl restart nginx
fi

#update chrome drive
if [ "$MATOMO_TEST_TARGET" = "UI" ];
then
  echo -e "${GREEN}update Chrome driver${SET}"
  sudo apt-get update
  sudo apt-get --only-upgrade install google-chrome-stable
  google-chrome --version
fi

#make tmp folder
echo -e "${GREEN}set up Folder${SET}"
cd /home/runner/work/matomo/matomo/
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

#set up folder permission
echo -e "${GREEN}set tmp and screenshot folder permission${SET}"
sudo chown -R "$USER":www-data /home/runner/work/matomo/matomo/
sudo chmod o+w /home/runner/work/matomo/matomo/
cd /home/runner/work/matomo/matomo/
sudo gpasswd -a "$USER" www-data
sudo chmod -R 777 /home/runner/work/matomo/matomo/tmp
sudo chmod -R 777 /home/runner/work/matomo/matomo/tmp/assets
sudo chmod -R 777 /home/runner/work/matomo/matomo/tmp/templates_c
sudo chmod -R 777 /home/runner/work/matomo/matomo/tests/UI
