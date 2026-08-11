<?php

/**
 * Matomo - free/libre analytics platform
 *
 * @link    https://matomo.org
 * @license http://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 *
 * GENERATED FILE - do not commit this to the plugin repository.
 * It is written into the plugin checkout during CI by matomo-org/github-action-tests.
 * To change it, edit scripts/php/templates/GeneratedTwigCompilationTest.php.tpl in that repository.
 */

namespace Piwik\Plugins\{{PLUGIN_NAME}}\tests\Integration;

use Piwik\Plugin\Manager;
use Piwik\Tests\Framework\TestCase\IntegrationTestCase;
use Piwik\Twig;

/**
 * Compiles every template the plugin ships, so that a template using a core Twig function,
 * filter or tag that does not exist yet in the Matomo version under test fails here rather than
 * when a user opens the page on an install running that version.
 *
 * Only compilation is covered. Undefined variables are a runtime concern and are not reported.
 *
 * @group {{PLUGIN_NAME}}
 * @group Plugins
 */
class GeneratedTwigCompilationTest extends IntegrationTestCase
{
    private const PLUGIN_NAME = '{{PLUGIN_NAME}}';

    public function testTemplatesCompileAgainstTheMatomoVersionUnderTest()
    {
        $templateDir = PIWIK_DOCUMENT_ROOT . '/plugins/' . self::PLUGIN_NAME . '/templates';
        $templates   = is_dir($templateDir) ? $this->getTemplateNames($templateDir) : [];

        if (empty($templates)) {
            self::markTestSkipped(self::PLUGIN_NAME . ' ships no templates.');
        }

        // the plugin's own Twig extensions are only registered while it is loaded, and the test
        // framework decides what to load from this class' namespace
        self::assertTrue(
            Manager::getInstance()->isPluginLoaded(self::PLUGIN_NAME),
            self::PLUGIN_NAME . ' is not loaded, so this check would not cover the plugin.'
        );

        $twig        = new Twig();
        $environment = $twig->getTwigEnvironment();

        foreach ($templates as $template) {
            $environment->load('@' . self::PLUGIN_NAME . '/' . $template);
        }

        self::assertNotEmpty($templates);
    }

    /**
     * @return string[] template names relative to the plugin's templates directory
     */
    private function getTemplateNames(string $templateDir): array
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($templateDir, \FilesystemIterator::SKIP_DOTS)
        );

        $names = [];

        foreach ($iterator as $file) {
            if ($file->getExtension() !== 'twig') {
                continue;
            }

            $name = str_replace('\\', '/', substr($file->getPathname(), strlen($templateDir) + 1));

            // templates/plugins/<Other>/ holds theme overrides that Twig registers under the
            // other plugin's namespace, so they are not this plugin's to compile
            if (strpos($name, 'plugins/') === 0) {
                continue;
            }

            $names[] = $name;
        }

        sort($names);

        return $names;
    }
}
