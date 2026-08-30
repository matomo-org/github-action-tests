'use strict';

// Stable sentinels shared by preflight and posting. Keeping them in trusted code avoids duplicating
// security-sensitive marker strings inside workflow YAML.
const CODEX_REVIEW_MARKER = 'This Codex review supersedes any previous Codex review output for this PR.';
const CODEX_REVIEW_BASE_MARKER_PREFIX = 'codex-review-base:';
const CODEX_INLINE_MARKER = '<!-- codex-review-inline -->';
const CODEX_REVIEW_OUTPUT_FILE = 'codex-review-output.json';
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function buildCodexReviewHeader(baseSha) {
  if (!COMMIT_SHA_PATTERN.test(baseSha || '')) {
    throw new Error('Codex review base must be a lowercase 40-character commit SHA');
  }
  return [
    `<!-- ${CODEX_REVIEW_MARKER} -->`,
    `<!-- ${CODEX_REVIEW_BASE_MARKER_PREFIX}${baseSha} -->`,
  ].join('\n');
}

module.exports = {
  COMMIT_SHA_PATTERN,
  buildCodexReviewHeader,
  CODEX_REVIEW_BASE_MARKER_PREFIX,
  CODEX_REVIEW_MARKER,
  CODEX_INLINE_MARKER,
  CODEX_REVIEW_OUTPUT_FILE,
};
