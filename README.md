### Matomo Github Action Tests Package

This is the package for the matomo test, service still need enter before the job. 

### Inputs

`php-version`  `string` Default 7.4, options [7.2, 7.4, 8.0, 8.1],

`node-version` `string` Default 12

`is-plugin` `boolean` used for test plugin only Default `false`

`test-type` `string` options '"UnitTests","SystemTestsPlugins","SystemTestsCore" ,"IntegrationTestsCore","IntegrationTestsPlugins","JS","UI"'

`database-adapter` `string` options "PDO_MYSQL","MYSQLI"' Default `PDO_MYSQL`

`php-extensions` `string` optional see here for more detail https://github.com/shivammathur/setup-php

### Usage
```yaml
    steps:
      - name: run tests
        uses: matomo-org/github-action-tests@v1
        with:
          php-version: '7.4'
          is-plugin: true
          test-type: 'UI'
```