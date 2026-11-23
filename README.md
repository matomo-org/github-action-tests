# Matomo GitHub Action Tests

This action is able to run certain test suites for Matomo or any Matomo plugin.

This is forked from <https://github.com/matomo-org/github-action-tests>. It was forked to focus on contributed plugins, and remove functions and scripts that is not needed for contribution plugins.

## Inputs

### test-type

Specifies the test types to run. This can be any of the following:

- PluginTests (default)
- UI
- JS
- Client

### plugin-name

Needs to be provided when running tests for a certain plugin only. If not provided tests will run for Matomo itself.

### matomo-test-branch

When running tests for a plugin, this option defines which version of Matomo should be used for running the tests.

It can either be a specific branch or tag name (like `4.x-dev` or `4.13.1`) or one of this magic keywords:

- minimum_required_matomo

  This will automatically try to determine the minimum required Matomo version for your plugin. This is done by looking at the version requirement in `plugin.json`

  If a version is defined in `plugin.json` this version will be tried to check out. If e.g. `>=4.0.0-b1,<5.0.0-b1` is defined it will try to check out `4.0.0-b1`.

  In case the defined version can not be found. e.g. the tag `4.0.0-b1` is not available, it will first try to check out the stable version (if beta provided). e.g. `4.0.0` in this example. If that would also fail it falls back to the development branch of that major version. So `4.x-dev` in that case.

- maximum_supported_matomo

  This will automatically try to identify the maximum supported Matomo version for your plugin. This is also done by looking at the version requirement in `plugin.json`

  If a specific version is defined in `plugin.json` this version will be tried to check out. If e.g. `>=4.0.0-b1,<4.7.0` is defined it will try to check out `4.7.0` if a newer version has already been released. If no newer version is available it falls back using the development branch like below.

  In case the upper bound defines that the plugin is compatible with a full major version, e.g. `>=4.0.0-b1,<5.0.0-b1`, tests will automatically run against the development branch of the supported major version. In this case it would be `4.x-dev`.

  Should the defined limits of a plugin contain more than one major releases, e.g. `>=4.4.0,<6.0.0-b1`, the development branch of the latest support Matomo version will be used. `5.x-dev` in that case.

### php-version

Defines the PHP version to set up for testing.

The action uses `shivammathur/setup-php` to set up PHP. You can find supported PHP versions here: <https://github.com/shivammathur/setup-php#tada-php-support>

### node-version

Defines the Node version to set up for testing. (Not needed for PHP tests)

### redis-service

Defines if a redis master and sentinel server should be set up before testing.

### mysql-service

Defines if a MySQL server should be set up before testing. If so a MySQL 8.0 server using tmpfs will be set up.

### mysql-driver

Defines which Mysql adapter Matomo should use to connect to the database. Can be set to `PDO_MYSQL` (default) or `MYSQLI`.

### dependent-plugins

Additional plugins to check out before testing, as a space or comma separated list of their slugs.

E.g. "matomo-org/plugin-CustomVariables" or "matomo-org/plugin-CustomVariables,nickname/PluginName"

Each plugin is placed in the folder named by `name` in its `plugin.json`, so the repository can have any name. The job fails when a plugin can not be checked out.

### github-token

If a dependant plugin is a private repository, this option needs to contain a GitHub access token having access to that repo.

For security reasons this option should not be provided in plain text, but using a repository secret instead.

### setup-script

This option can contain the path to a bash script that should be executed before running the tests.

This can be used by plugin to set up additional requirements. Like e.g. LoginLdap plugin requires a Ldap server for running tests.

### ui-test-options

Additional options to provide for UI tests. This can be used to split up UI tests in multiple builds like used in core.

### phpunit-test-options

Additional options to provide for PHPUnit tests. This can be used to provide debugging options for PHPUnit.

### coverage

If you want code coverage reports, possible values are none, xdebug, pcov.

### debug

Set to 'true' to output the PHP configuration, the Matomo configuration and the log files after the tests, also when they fail. Defaults to 'false'.

### Example usage for a Plugin

```yaml
on:
  pull_request: {}
  workflow_dispatch: {}
  push:
    branches: ["main"]
jobs:
  plugin:
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        php: [ '8.4', '8.5' ]
        target: ['minimum_required_matomo', 'maximum_supported_matomo']
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        uses: Digitalist-Open-Cloud/Matomo-github-action-tests@main
        with:
          plugin-name: 'PluginName'
          php-version: ${{ matrix.php }}
          test-type: 'PluginTests'
          matomo-test-branch: ${{ matrix.target }}
          dependent-plugins: 'slug/plugin-AdditionalPlugin'
          github-token: ${{ secrets.TESTS_ACCESS_TOKEN || secrets.GITHUB_TOKEN }}
```
### Documented configuration

| Input | Description | Default |
|-------|-------------|---------|
| `test-type` | Specifies test types to run: `PluginTests`, `UI`, `JS`, or `Client` | `PluginTests` |
| `plugin-name` | Name of the plugin to test. If not provided, tests run for Matomo itself | - |
| `matomo-test-branch` | Version of Matomo to use for testing. Can be specific branch/tag or keywords: `minimum_required_matomo`, `maximum_supported_matomo` | - |
| `php-version` | PHP version to use for testing | - |
| `node-version` | Node version to use for testing (Not needed for PHP tests) | - |
| `redis-service` | Whether to set up redis master and sentinel server | - |
| `mysql-service` | Whether to set up MySQL server (MySQL 8.0 with tmpfs) | - |
| `mysql-driver` | MySQL adapter for Matomo: `PDO_MYSQL` or `MYSQLI` | `PDO_MYSQL` |
| `dependent-plugins` | Additional plugins to check out before testing (space or comma separated list) | - |
| `github-token` | GitHub access token for private repository access | - |
| `setup-script` | Path to bash script to execute before running tests | - |
| `ui-test-options` | Additional options for UI tests | - |
| `phpunit-test-options` | Additional options for PHPUnit tests | - |
| `coverage` | Code coverage reporting options: `none`, `xdebug`, `pcov` | - |
| `coverage-html-report` | Code coverage report as HTML. Options: `false`, `true` | `false` |
| `debug` | Output debug information like PHP config, Matomo config | `false` |
