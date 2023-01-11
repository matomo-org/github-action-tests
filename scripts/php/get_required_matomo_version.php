<?php
/**
 * Matomo - free/libre analytics platform
 *
 * @link https://matomo.org
 * @license http://www.gnu.org/licenses/gpl-3.0.html GPL v3 or later
 */

$pathToMatomo = $argv[1];
$pluginName = $argv[2];
$returnMaxVersion = !empty($argv[3]) && $argv[3] === 'max';

// tiny script to get plugin version from plugin.json from a bash script
require_once $pathToMatomo . '/core/Version.php';

function getRequiredMatomoVersions($pluginJsonContents, $returnAlsoInvalid = false)
{
    $requiredMatomoVersion = '';
    if (isset($pluginJsonContents["require"]["piwik"])) {
        $requiredMatomoVersion = (string) $pluginJsonContents["require"]["piwik"];
    } else if (isset($pluginJsonContents["require"]["matomo"])) {
        $requiredMatomoVersion = (string) $pluginJsonContents["require"]["matomo"];
    }

    $requiredVersions = explode(',', $requiredMatomoVersion);

    $versions = [];
    foreach ($requiredVersions as $required) {
        if (preg_match('{^(<>|!=|>=?|<=?|==?)\s*(.*)}', $required, $matches)) {
            $comparison = trim($matches[1]);
            $version = $matches[2];

            if (!preg_match("/^[^0-9]*(.*)/", $version) || empty($version)) {
                // not a valid version number
                continue;
            }

            if (!$returnAlsoInvalid && version_compare($version, \Piwik\Version::VERSION) > 0) {
                continue;
            }

            $versions[] = [
                'comparison' => $comparison,
                'version' => $version
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

        if (in_array($comparison, ['>=','>', '=='])) {
            if (empty($minVersion)) {
                $minVersion = $version;
            } elseif (version_compare($version, $minVersion, '<=')) {
                $minVersion = $version;
            }
        }
    }

    return $minVersion;
}

function getMaxVersion(array $requiredVersions)
{
    $maxVersion = $devBranch = '';

    foreach ($requiredVersions as $required) {
        $comparison = $required['comparison'];
        $version    = $required['version'];

        if ($comparison == '<' && $version == '3.0.0-b1') {
            $maxVersion = trim(file_get_contents('https://api.matomo.org/1.0/getLatestVersion/?release_channel=latest_2x_beta'));
            continue;
        } elseif ($comparison == '<' && $version == '4.0.0-b1') {
            $maxVersion = trim(file_get_contents('https://api.matomo.org/1.0/getLatestVersion/?release_channel=latest_3x_beta'));
            $devBranch = '3.x-dev';
            continue;
        } elseif ($comparison == '<' && $version == '5.0.0-b1') {
            $maxVersion = trim(file_get_contents('https://api.matomo.org/1.0/getLatestVersion/?release_channel=latest_4x_beta'));
            $devBranch = '4.x-dev';
            continue;
        } elseif ($comparison == '<' && $version == '6.0.0-b1') {
            $maxVersion = trim(file_get_contents('https://api.matomo.org/1.0/getLatestVersion/?release_channel=latest_5x_beta'));
            $devBranch = '5.x-dev';
            continue;
        }

        if (in_array($comparison, ['<', '<=', '=='])) {
            if (empty($maxVersion)) {
                $maxVersion = $devBranch ?: $version;
            } elseif (version_compare($version, $maxVersion, '>=')) {
                $maxVersion = $version;
            } elseif ($devBranch) {
                $maxVersion = $devBranch;
            }
        }
    }

    return $maxVersion;
}

// at this point in travis the plugin to test against is not in the piwik directory. we could move it to piwik
// beforehand, but for plugins that are also stored as submodules, this would erase the plugin or fail when git
// submodule update is called
$pluginJsonPath     = "$pathToMatomo/plugins/$pluginName/plugin.json";
$pluginJsonContents = file_get_contents($pluginJsonPath);
$pluginJsonContents = json_decode($pluginJsonContents, true);

$requiredVersions = getRequiredMatomoVersions($pluginJsonContents);

if ($returnMaxVersion) {
    $versionToReturn = getMaxVersion($requiredVersions);

    if (empty($versionToReturn)) {
        $versionToReturn = trim(file_get_contents('https://api.matomo.org/LATEST_BETA'));
    }
} else {
    $versionToReturn = getMinVersion($requiredVersions);
}

if (empty($versionToReturn)) {
    $requiredVersions = getRequiredMatomoVersions($pluginJsonContents, true);
    $versionToReturn = getMinVersion($requiredVersions);
    $versionToReturn = !empty($versionToReturn) ? $versionToReturn : '4.x-dev';
}

echo $versionToReturn;
