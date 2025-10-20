### Matomo GitHub Action Tests

This action is able to run certain test suites for Matomo or any Matomo plugin.

### Inputs

  * **test-type**

    Specifies the test types to run. This can be any of the following:

    - UI
    - PluginTests
    - JS
    - Client
    - UnitTests
    - SystemTestsPlugins
    - SystemTestsCore
    - IntegrationTestsCore
    - IntegrationTestsPlugins


  * **plugin-name**

    Needs to be provided when running tests for a certain plugin only. If not provided tests will run for Matomo itself.


  * **matomo-test-branch**

    When running tests for a plugin, this option defines which version of Matomo should be used for running the tests.

    It can either be a specific branch or tag name (like `4.x-dev` or `4.13.1`) or one of this magic keywords:

    - **minimum_required_matomo**

      This will automatically try to determine the minimum required Matomo version for your plugin. This is done by looking at the version requirement in `plugin.json`

      If a version is defined in `plugin.json` this version will be tried to check out. If e.g. `>=4.0.0-b1,<5.0.0-b1` is defined it will try to check out `4.0.0-b1`.

      In case the defined version can not be found. e.g. the tag `4.0.0-b1` is not available, it will first try to check out the stable version (if beta provided). e.g. `4.0.0` in this example. If that would also fail it falls back to the development branch of that major version. So `4.x-dev` in that case.

    - **maximum_supported_matomo**

      This will automatically try to identify the maximum supported Matomo version for your plugin. This is also done by looking at the version requirement in `plugin.json`

      If a specific version is defined in `plugin.json` this version will be tried to check out. If e.g. `>=4.0.0-b1,<4.7.0` is defined it will try to check out `4.7.0` if a newer version has already been released. If no newer version is available it falls back using the development branch like below.

      In case the upper bound defines that the plugin is compatible with a full major version, e.g. `>=4.0.0-b1,<5.0.0-b1`, tests will automatically run against the development branch of the supported major version. In this case it would be `4.x-dev`.

      Should the defined limits of a plugin contain more than one major releases, e.g. `>=4.4.0,<6.0.0-b1`, the development branch of the latest support Matomo version will be used. `5.x-dev` in that case.


  * **php-version**

    Defines the PHP version to set up for testing. (Not needed for Client tests)

    Use `matomo_min_php` or `matomo_max_php` to resolve to the centrally managed (defined in action.yml) minimum or maximum PHP versions supported by Matomo tests.

    The action uses `shivammathur/setup-php` to set up PHP. You can find supported PHP versions here: https://github.com/shivammathur/setup-php#tada-php-support


  * **node-version**

    Defines the Node version to set up for testing. (Not needed for PHP tests)


  * **redis-service**

    Defines if a redis master and sentinel server should be set up before testing.


  * **mysql-service**

    Defines if a MySQL server should be set up before testing. If so a MySQL 5.7 server using tmpfs will be set up.


  * **mysql-driver**

    Defines which Mysql adapter Matomo should use to connect to the database. Can be set to `PDO_MYSQL` (default) or `MYSQLI`.


  * **upload-artifacts**

    If set to true produced artifacts will be uploaded to https://build-artifacts.matomo.org

    This is only relevant for test types: UI, PluginTests, SystemTestsPlugins and SystemTestsCore


  * **artifacts-protected**

    If artifacts should be uploaded to https://build-artifacts.matomo.org this option defines if the artifacts should be hidden behind a login. Only needed for premium plugins.


  * **artifacts-pass**

    If artifacts should be uploaded to https://build-artifacts.matomo.org this option needs to contain the correct upload password.


  * **dependent-plugins**

    Additional plugins to check out before testing. Plugins need to be provided as a comma separated list of their slugs.

    E.g. "matomo-org/plugin-CustomVariables" or "matomo-org/plugin-CustomVariables,nickname/PluginName"

    Repositories must be named as `PluginName` or `plugin-PluginName` for this to work.


  * **github-token**

    If a dependant plugin is a private repository, this option needs to contain a GitHub access token having access to that repo.

    For security reasons this option should not be provided in plain text, but using a repository secret instead.

  * **setup-script**

    This option can contain the path to a bash script that should be executed before running the tests.

    This can be used by plugin to set up additional requirements. Like e.g. LoginLdap plugin requires a Ldap server for running tests.


  * **ui-test-options**

    Additional options to provide for UI tests. This can be used to split up UI tests in multiple builds like used in core.


  * **phpunit-test-options**

    Additional options to provide for PHPUnit tests. This can be used to provide debugging options for PHPUnit.


### Example usage for a Plugin
```yaml
  PluginTests:
    runs-on: ubuntu-20.04
    strategy:
      fail-fast: false
      matrix:
        php: [ '7.2', '8.1' ]
        target: ['minimum_required_matomo', 'maximum_supported_matomo']
    steps:
      - uses: actions/checkout@v3
        with:
          lfs: true
          persist-credentials: false
      - name: Run tests
        uses: matomo-org/github-action-tests@main
        with:
          plugin-name: 'PluginName'
          php-version: ${{ matrix.php }}
          test-type: 'PluginTests'
          matomo-test-branch: ${{ matrix.target }}
          artifacts-pass: ${{ secrets.ARTIFACTS_PASS }}
          upload-artifacts: ${{ matrix.php == '7.2' && matrix.target == 'maximum_supported_matomo' }}
          artifacts-protected: true
          dependent-plugins: 'slug/plugin-AdditionalPlugin'
          github-token: ${{ secrets.TESTS_ACCESS_TOKEN || secrets.GITHUB_TOKEN }}
```
