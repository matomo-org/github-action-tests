### Matomo Plugin Github Action Tests Package

This is the package for the matomo test, service still need enter before the job. 

### Inputs

`test-type` UI,PHP(Integration,System) PluginTests,JS, Angular (This will be renamed to VUE)

`git-sha` Pull request sha to test

`run_id` GitHub Action run ID, unique id that used to download artifact

`redis-service` if test request redis

`plugin-name` `string` `requried`

`php-version`  `string` Default 7.4, options [7.2, 7.4, 8.0, 8.1],

`node-version` `string` Default 12

`mysql-adapter` `string` options "PDO_MYSQL","MYSQLI"' Default `PDO_MYSQL`

`php-extensions` `string` optional see here for more detail https://github.com/shivammathur/setup-php

`addition` if test required eg: ldap

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
          git-head: ${{ github.head_ref }}
          git-sha: ${{ github.event.pull_request.head.sha }}
          plugin-name: 'TasksTimetable'
```