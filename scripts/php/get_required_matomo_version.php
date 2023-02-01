<?php
/**
 * Matomo - free/libre analytics platform
 *
 * @link    https://matomo.org
 * @license http://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */

$pathToMatomo     = $argv[1];
$pluginName       = $argv[2];
$returnMaxVersion = !empty($argv[3]) && $argv[3] === 'max';

// tiny script to get plugin version from plugin.json from a bash script
require_once $pathToMatomo . '/core/Version.php';

function getRequiredMatomoVersions($pluginJsonContents, bool $returnAlsoInvalid = false): array
{
    $requiredMatomoVersion = '';
    if (isset($pluginJsonContents["require"]["piwik"])) {
        $requiredMatomoVersion = (string)$pluginJsonContents["require"]["piwik"];
    } else {
        if (isset($pluginJsonContents["require"]["matomo"])) {
            $requiredMatomoVersion = (string)$pluginJsonContents["require"]["matomo"];
        }
    }

    $requiredVersions = explode(',', $requiredMatomoVersion);

    $versions = [];
    foreach ($requiredVersions as $required) {
        if (preg_match('{^(<>|!=|>=?|<=?|==?)\s*(.*)}', $required, $matches)) {
            $comparison = trim($matches[1]);
            $version    = $matches[2];

            if (!preg_match("/^[^0-9]*(.*)/", $version) || empty($version)) {
                // not a valid version number
                continue;
            }

            if (!$returnAlsoInvalid && version_compare($version, \Piwik\Version::VERSION) > 0) {
                continue;
            }

            $versions[] = [
                'comparison' => $comparison,
                'version'    => $version,
            ];
        }
    }

    return $versions;
}

function getMinVersion(array $requiredVersions)
{
    $minVersion = '';

    foreach ($requiredVersions as $required) {
        $comparison = $required['comparison'];
        $version    = $required['version'];

        if (in_array($comparison, ['>=', '>', '=='])) {
            if (empty($minVersion)) {
                $minVersion = $version;
                break;
            } elseif (version_compare($version, $minVersion, '<=')) {
                $minVersion = $version;
                break;
            }
        }
    }

    return $minVersion;
}

function getMaxVersion(array $requiredVersions): string
{
    foreach ($requiredVersions as $required) {
        $comparison = $required['comparison'];
        $version    = $required['version'];

        if (!in_array($comparison, ['<', '<=', '=='])) {
            // skip lower bounds
            continue;
        }

        if ($comparison == '<' && preg_match('/^[2-9]\.0\.0-b1$/', $version)) {
            $majorVersion = (int)substr($version, 0, 1) - 1;
            $maxVersion   = trim(
                file_get_contents(
                    'https://api.matomo.org/1.0/getLatestVersion/?release_channel=latest_' . $majorVersion . 'x_beta'
                )
            );
            $devBranch    = $majorVersion . '.x-dev';

            if (empty($maxVersion) || !version_compare($version, $maxVersion, '<=')) {
                // use dev branch if the latest released version is covered by the supported version
                return $devBranch;
            } else {
                // otherwise use the version defined in plugin json, as newer versions might no longer work
                return $version;
            }
        } else {
            // otherwise use the version defined in plugin json, as newer versions might no longer work
            return $version;
        }
    }

    return '';
}

// at this point the plugin to test against is not in the matomo directory. we could move it to matomo
// beforehand, but for plugins that are also stored as submodules, this would erase the plugin or fail when git
// submodule update is called
$pluginJsonPath     = "$pathToMatomo/../$pluginName/plugin.json";
$pluginJsonContents = file_get_contents($pluginJsonPath);
$pluginJsonContents = json_decode($pluginJsonContents, true);

$allRequiredVersions   = getRequiredMatomoVersions($pluginJsonContents, true);
$validRequiredVersions = getRequiredMatomoVersions($pluginJsonContents, true);

if ($returnMaxVersion) {
    $versionToReturn = getMaxVersion($allRequiredVersions);

    if (empty($versionToReturn)) {
        // if no upper bound found, use the dev branch of the minimum required version, as we assume plugins are never compatible with next major release
        $minVersion      = getMinVersion($validRequiredVersions);
        $versionToReturn = substr($minVersion, 0, 1) . '.x-dev';
    }
} else {
    $versionToReturn = getMinVersion($validRequiredVersions);
}

if (empty($versionToReturn)) {
    $requiredVersions = $allRequiredVersions;
    $versionToReturn  = getMinVersion($requiredVersions);
    $versionToReturn  = !empty($versionToReturn) ? $versionToReturn : '4.x-dev';
}

echo $versionToReturn;
