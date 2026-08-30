'use strict';

const { execFileSync } = require('node:child_process');
const {
  COMMIT_SHA_PATTERN,
  buildCodexReviewHeader,
  CODEX_REVIEW_MARKER,
} = require('./review-constants');
const { formatUntrustedInlineCode, neutralizeGitHubMentions } = require('./markdown-utils');

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
// Job outputs are accounted as UTF-16 by GitHub. Leave ample room for the other outputs and prompt
// metadata instead of approaching the per-job output limit with an unusually large path list.
const MAX_CHANGED_FILES_OUTPUT_LENGTH = 200000;
const MAX_AUTOMATION_FILES_IN_MESSAGE = 20;
const MAX_DISPLAY_PATH_LENGTH = 240;

function setRequestDefaults(core) {
  core.setOutput('changed_files', '[]');
  core.setOutput('automation_files', '[]');
  core.setOutput('should_inspect', 'false');
  core.setOutput('should_run', 'false');
  core.setOutput('safety_failure', 'false');
  core.setOutput('safety_message', '');
  core.setOutput('skip_reason', '');
  core.setOutput('skip_message', '');
}

function repositoryId(repository) {
  return Number.isSafeInteger(repository?.id) && repository.id > 0
    ? repository.id
    : null;
}

function isSameRepositoryPullRequest(pullRequest) {
  const baseRepositoryId = repositoryId(pullRequest?.base?.repo);
  const headRepositoryId = repositoryId(pullRequest?.head?.repo);
  return baseRepositoryId !== null && headRepositoryId === baseRepositoryId;
}

async function validateReviewRequest({ github, context, core, allowedOwners }) {
  const pullRequest = context.payload.pull_request;
  if (!pullRequest) {
    throw new Error('Codex review must be called from a pull_request_target event.');
  }
  if (context.eventName !== 'pull_request_target') {
    throw new Error('Codex review requires a trusted pull_request_target caller so skip feedback and label cleanup retain write access.');
  }

  const owner = context.repo.owner.toLowerCase();
  const ownerAllowlist = String(allowedOwners || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!ownerAllowlist.includes(owner)) {
    throw new Error(`Codex review is restricted to repositories owned by: ${ownerAllowlist.join(', ')}. Current owner: ${context.repo.owner}.`);
  }

  const baseSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;
  if (!COMMIT_SHA_PATTERN.test(baseSha || '') || !COMMIT_SHA_PATTERN.test(headSha || '')) {
    throw new Error('Pull request base and head SHAs must be lowercase 40-character commit SHAs.');
  }

  core.setOutput('base_sha', baseSha);
  core.setOutput('head_sha', headSha);
  setRequestDefaults(core);

  // Repository IDs are immutable and case-independent. Missing IDs fail closed as a fork because
  // this secret-bearing workflow must never check out code whose origin it cannot prove.
  if (!isSameRepositoryPullRequest(pullRequest)) {
    core.setOutput('skip_reason', 'fork_pull_request');
    core.setOutput(
      'skip_message',
      'Codex review is not available for pull requests from forks because this trusted workflow does not check out fork code. Re-run the review from a branch in this repository instead.',
    );
    return;
  }

  const currentPullRequest = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullRequest.number,
  });
  if (!isSameRepositoryPullRequest(currentPullRequest.data)) {
    core.setOutput('skip_reason', 'fork_pull_request');
    core.setOutput(
      'skip_message',
      'Codex review was skipped because the current pull request repository identity could not be verified as same-repository.',
    );
    return;
  }

  const currentHeadSha = currentPullRequest.data?.head?.sha;
  const currentBaseSha = currentPullRequest.data?.base?.sha;
  if (currentHeadSha !== headSha) {
    core.setOutput('skip_reason', 'stale_head');
    core.setOutput(
      'skip_message',
      `Codex review was skipped because the pull request head changed after the label was applied. Reapply the review label to review commit ${(currentHeadSha || headSha).slice(0, 12)}.`,
    );
    return;
  }
  if (currentBaseSha !== baseSha) {
    core.setOutput('skip_reason', 'stale_base');
    core.setOutput(
      'skip_message',
      `Codex review was skipped because the pull request base changed after the label was applied. Reapply the review label to review against base commit ${(currentBaseSha || baseSha).slice(0, 12)}.`,
    );
    return;
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });
  const latestCodexReview = reviews
    .filter((review) =>
      review.user?.login === 'github-actions[bot]'
      && REVIEW_STATES.has(review.state)
      && typeof review.body === 'string'
      && review.body.includes(CODEX_REVIEW_MARKER)
    )
    .sort((left, right) => new Date(right.submitted_at) - new Date(left.submitted_at))[0];

  // Require the snapshot marker in the trusted leading frame. A startsWith check prevents
  // model-authored summary text from spoofing the base marker used for deduplication.
  const snapshotHeader = `${buildCodexReviewHeader(baseSha)}\n`;
  if (
    latestCodexReview?.commit_id === headSha
    && latestCodexReview.body.startsWith(snapshotHeader)
  ) {
    core.setOutput('skip_reason', 'no_new_changes');
    core.setOutput(
      'skip_message',
      `Codex review was skipped because the latest Codex review already covers head commit ${headSha.slice(0, 12)}. Push a new commit before requesting another Codex review.`,
    );
    return;
  }

  core.setOutput('should_inspect', 'true');
}

function parseAutomationPaths(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isAutomationFile(file, automationPaths) {
  return automationPaths.some((automationPath) =>
    automationPath.endsWith('/')
      ? file.startsWith(automationPath)
      : file === automationPath
  );
}

function displayPath(file) {
  const truncated = file.length > MAX_DISPLAY_PATH_LENGTH
    ? `${file.slice(0, MAX_DISPLAY_PATH_LENGTH - 3)}...`
    : file;
  return formatUntrustedInlineCode(truncated);
}

function automationSafetyMessage(automationFiles) {
  const displayedFiles = automationFiles.slice(0, MAX_AUTOMATION_FILES_IN_MESSAGE);
  const omittedCount = automationFiles.length - displayedFiles.length;
  const omittedSuffix = omittedCount > 0
    ? `, and ${omittedCount} additional ${omittedCount === 1 ? 'path' : 'paths'}`
    : '';
  return neutralizeGitHubMentions(
    `Codex review was not run because this PR changes reviewer automation files: ${displayedFiles.map(displayPath).join(', ')}${omittedSuffix}. These files need human review first.`,
  );
}

function setInspectionFailure(core, message) {
  core.setOutput('should_run', 'false');
  core.setOutput('safety_failure', 'true');
  core.setOutput('safety_message', message);
}

function setInspectionOutputs(core, changedFiles = [], automationFiles = []) {
  const changedFilesJson = JSON.stringify(changedFiles);
  const automationFilesJson = JSON.stringify(automationFiles);
  core.setOutput('changed_files', changedFilesJson.length <= MAX_CHANGED_FILES_OUTPUT_LENGTH ? changedFilesJson : '[]');
  core.setOutput('automation_files', automationFilesJson.length <= MAX_CHANGED_FILES_OUTPUT_LENGTH ? automationFilesJson : '[]');
  core.setOutput('skip_reason', '');
  core.setOutput('skip_message', '');
  return { changedFilesJson, automationFilesJson };
}

function inspectFrozenChanges({
  core,
  checkoutPath,
  automationPaths,
  baseSha,
  headSha,
  execFile = execFileSync,
}) {
  if (!COMMIT_SHA_PATTERN.test(baseSha || '') || !COMMIT_SHA_PATTERN.test(headSha || '')) {
    throw new Error('Frozen diff base and head must be lowercase 40-character commit SHAs.');
  }

  const git = (args, options = {}) => execFile('git', args, {
    cwd: checkoutPath,
    encoding: 'utf8',
    ...options,
  });
  const checkedOutHead = git(['rev-parse', 'HEAD']).trim();
  if (checkedOutHead !== headSha) {
    throw new Error(`Frozen preflight checkout resolved to ${checkedOutHead}, expected ${headSha}.`);
  }
  git(['cat-file', '-e', `${baseSha}^{commit}`]);

  // --no-renames reports both the deleted source and added destination. Without it, renaming a
  // guarded workflow file out of an automation path could hide the guarded source path.
  let changedFileOutput;
  try {
    changedFileOutput = git(
      ['diff', '--no-renames', '--name-only', '-z', `${baseSha}...${headSha}`, '--'],
      { maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    if (!['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code)) {
      throw error;
    }

    setInspectionOutputs(core);
    setInspectionFailure(
      core,
      'Codex review was not run because the frozen diff contains too much changed-path data to inspect safely. Split the pull request or review it manually.',
    );
    return;
  }

  const changedFiles = changedFileOutput.split('\0').filter(Boolean);
  const guardedPaths = parseAutomationPaths(automationPaths);
  const automationFiles = changedFiles.filter((file) =>
    isAutomationFile(file, guardedPaths)
  );
  const { changedFilesJson } = setInspectionOutputs(core, changedFiles, automationFiles);

  if (automationFiles.length > 0) {
    setInspectionFailure(core, automationSafetyMessage(automationFiles));
    return;
  }

  if (changedFilesJson.length > MAX_CHANGED_FILES_OUTPUT_LENGTH) {
    setInspectionFailure(
      core,
      'Codex review was not run because the frozen diff contains too much changed-path data to pass safely between jobs. Split the pull request or review it manually.',
    );
    return;
  }

  core.setOutput('should_run', 'true');
  core.setOutput('safety_failure', 'false');
  core.setOutput('safety_message', '');
}

module.exports = {
  COMMIT_SHA_PATTERN,
  MAX_CHANGED_FILES_OUTPUT_LENGTH,
  automationSafetyMessage,
  inspectFrozenChanges,
  isAutomationFile,
  isSameRepositoryPullRequest,
  parseAutomationPaths,
  validateReviewRequest,
};
