### Matomo Plugin GitHub Action Tests Package

This is a group of the scripts for the Matomo Tests

### Inputs

`test-type` UI,PHP(Integration,System) PluginTests,JS, Angular (This will be renamed to VUE)

`git-ref` Git Ref to test

`run-number` GitHub Action run ID, unique id that used to download artifact

`redis-service` if test request redis

`plugin-name` `string` `requried`

`php-version`  `string` Default 7.4, options [7.2, 7.4, 8.0, 8.1],

`node-version` `string` Default 12

`mysql-adapter` `string` options "PDO_MYSQL","MYSQLI"' Default `PDO_MYSQL`

`php-extensions` `string` optional see here for more detail https://github.com/shivammathur/setup-php

`addition` if test required eg: ldap

`test-command:` the command used to run the tests

`php-memory` If you like to increase or decrease the PHP memory, default 256M.

`artifact-pass` use for UI viewer, artifact password


``

### Usage For Plugin
```yaml
jobs:
  PluginTests:
    runs-on: ubuntu-20.04
    strategy:
      fail-fast: false
    steps:
      - name: run tests
        uses: matomo-org/github-action-tests@v1
        with:
          git-ref: ${{ github.ref }}
          plugin-name: 'TasksTimetable'
```
