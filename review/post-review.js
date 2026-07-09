const fs = require('fs');
const { requiredEnv } = require('./env-utils');

// Severity ranked low->high; index doubles as the ordering used to reconcile highest_severity.
const SEVERITIES = ['none', 'low', 'medium', 'blocking'];
// The subset a finding/comment may carry ('none' is a review-level state, not a per-finding value).
const FINDING_SEVERITIES = SEVERITIES.filter((severity) => severity !== 'none');

// Sentinel embedded in every Codex review body so later runs can recognise and supersede their own
// previous reviews. The preflight job in .github/workflows/codex-review.yml matches this exact
// string to deduplicate runs, so it MUST stay byte-identical to the literal there.
const CODEX_REVIEW_MARKER = 'This Codex review supersedes any previous Codex review output for this PR.';

// Hidden marker embedded in every inline review comment. Dismissing a superseded review does not
// remove its inline comments, so each run finds and deletes prior Codex inline comments by this
// marker to stop them accumulating across runs.
const CODEX_INLINE_MARKER = '<!-- codex-review-inline -->';

function expectedHighestSeverity(findings) {
  if (findings.blocking > 0) {
    return 'blocking';
  }
  if (findings.medium > 0) {
    return 'medium';
  }
  if (findings.low_polish > 0) {
    return 'low';
  }
  return 'none';
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

// Defence-in-depth re-validation of the Codex output. The codex-action already constrains the model
// to review-output.schema.json, so this mirrors that schema as a backstop in case enforcement is
// absent or changes. Keep this in sync with review/review-output.schema.json.
function validateReview(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new Error('Codex output must be a JSON object');
  }

  assertString(review.review_body_markdown, 'review_body_markdown');
  // diagnostics_markdown is intentionally not rendered into the review body; it is surfaced only via
  // the uploaded codex-review-output artifact, so the PR conversation stays concise.
  assertString(review.diagnostics_markdown, 'diagnostics_markdown');
  if (!SEVERITIES.includes(review.highest_severity)) {
    throw new Error('highest_severity is invalid');
  }

  const findings = review.findings;
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) {
    throw new Error('findings must be an object');
  }
  assertInteger(findings.blocking, 'findings.blocking');
  assertInteger(findings.medium, 'findings.medium');
  assertInteger(findings.low_polish, 'findings.low_polish');

  if (!Array.isArray(review.inline_comments)) {
    throw new Error('inline_comments must be an array');
  }
  if (!Array.isArray(review.unplaced_findings)) {
    throw new Error('unplaced_findings must be an array');
  }

  for (const [index, comment] of review.inline_comments.entries()) {
    assertString(comment.path, `inline_comments[${index}].path`);
    if (!Number.isInteger(comment.line) || comment.line < 1) {
      throw new Error(`inline_comments[${index}].line must be a positive integer`);
    }
    if (!['LEFT', 'RIGHT'].includes(comment.side)) {
      throw new Error(`inline_comments[${index}].side must be LEFT or RIGHT`);
    }
    if (!FINDING_SEVERITIES.includes(comment.severity)) {
      throw new Error(`inline_comments[${index}].severity is invalid`);
    }
    assertString(comment.body, `inline_comments[${index}].body`);
    // rule_source is required by the schema but may be null; it is only read optionally downstream.
    if (comment.rule_source !== null && typeof comment.rule_source !== 'string') {
      throw new Error(`inline_comments[${index}].rule_source must be a string or null`);
    }
  }

  for (const [index, finding] of review.unplaced_findings.entries()) {
    if (!FINDING_SEVERITIES.includes(finding.severity)) {
      throw new Error(`unplaced_findings[${index}].severity is invalid`);
    }
    assertString(finding.body, `unplaced_findings[${index}].body`);
    // path and line are nullable per the schema; the mapping step re-derives placement from them.
    if (finding.path !== null && finding.path !== undefined && typeof finding.path !== 'string') {
      throw new Error(`unplaced_findings[${index}].path must be a string or null`);
    }
    if (finding.line !== null && finding.line !== undefined
      && (!Number.isInteger(finding.line) || finding.line < 1)) {
      throw new Error(`unplaced_findings[${index}].line must be a positive integer or null`);
    }
  }

  // Recompute highest_severity from trustworthy signals rather than trusting the model's own value.
  // The counts drive the baseline, but an individual inline/unplaced finding may carry a higher
  // severity than the counts imply; in that case the review must reflect the severest finding so
  // reviewEventForSeverity does not post a blocking finding as a non-blocking COMMENT.
  const highestFromCounts = expectedHighestSeverity(findings);
  const findingSeverities = [
    ...review.inline_comments.map((comment) => comment.severity),
    ...review.unplaced_findings.map((finding) => finding.severity),
  ];
  review.highest_severity = findingSeverities.reduce(
    (highest, severity) =>
      SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(highest) ? severity : highest,
    highestFromCounts,
  );
}

function readReviewOutput(path) {
  const raw = fs.readFileSync(path, 'utf8').trim();
  if (!raw) {
    throw new Error('Codex output file is empty');
  }
  return JSON.parse(raw);
}

function parsePatchLines(patch) {
  const right = new Set();
  const left = new Set();

  if (!patch) {
    return { right, left };
  }

  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    // The pulls.listFiles `patch` starts at the first @@ header and never contains `---`/`+++`
    // file-header lines, so we must NOT skip those prefixes here: a real added line whose source
    // begins with `++` renders as `+++...` and a removed line beginning with `--` renders as
    // `---...`, and skipping them would desynchronise every following line number in the hunk. Only
    // the "\ No newline at end of file" marker needs to be ignored.
    if (line.startsWith('\\')) {
      continue;
    }

    if (line.startsWith('+')) {
      right.add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      left.add(oldLine);
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      right.add(newLine);
      left.add(oldLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return { right, left };
}

function formatFinding(finding) {
  const location = finding.path
    ? ` (${finding.path}${finding.line ? `:${finding.line}` : ''})`
    : '';
  return `- **${formatSeverityBadge(finding.severity)}**${location}: ${finding.body}`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatSeverityBadge(severity) {
  switch (severity) {
    case 'blocking':
      return '🚫 Blocking';
    case 'medium':
      return '⚠️ Medium';
    case 'low':
      return '💬 Low / Polish';
    case 'none':
      return '✅ No findings';
    default:
      return severity;
  }
}

function formatInlineCommentBody(comment) {
  const lines = [
    `**${formatSeverityBadge(comment.severity)}**`,
    '',
    comment.body,
  ];

  if (comment.rule_source) {
    lines.push('', `Rule source: \`${comment.rule_source}\``);
  }

  // Trailing hidden marker so a later run can identify and delete this comment (see
  // deletePreviousCodexInlineComments).
  lines.push('', CODEX_INLINE_MARKER);

  return lines.join('\n');
}

// Attach `candidate` (an inline comment or a locatable unplaced finding) as an inline review comment
// on the given diff `side` when its line is part of the diff. On success it records both the GitHub
// comment payload and a plain-finding mirror (used to rebuild the body in the 422 fallback). Both
// placement loops in postReview share this so the diff-mapping rules live in one place.
function placeInlineComment({ candidate, side, patchesByPath, comments, placedFindings }) {
  const patch = candidate.path ? patchesByPath.get(candidate.path) : undefined;
  const lineSet = side === 'RIGHT' ? patch?.right : patch?.left;
  if (!patch || !Number.isInteger(candidate.line) || !lineSet.has(candidate.line)) {
    return { placed: false, patchMissing: !patch };
  }

  comments.push({
    path: candidate.path,
    line: candidate.line,
    side,
    body: formatInlineCommentBody(candidate),
  });
  placedFindings.push({
    severity: candidate.severity,
    body: candidate.body,
    path: candidate.path,
    line: candidate.line,
  });
  return { placed: true, patchMissing: false };
}

function buildReviewBody(review, unplaced, inlineCount) {
  const hasFindings = review.findings.blocking + review.findings.medium + review.findings.low_polish > 0;
  const lines = [
    `<!-- ${CODEX_REVIEW_MARKER} -->`,
    `## 🤖 Codex Review: ${formatSeverityBadge(review.highest_severity)}`,
    '',
    '### Summary',
    review.review_body_markdown.trim(),
    '',
    '### Findings Overview',
    '',
    '| Severity | Count |',
    '| --- | ---: |',
    `| 🚫 Blocking | ${review.findings.blocking} |`,
    `| ⚠️ Medium | ${review.findings.medium} |`,
    `| 💬 Low / Polish | ${review.findings.low_polish} |`,
  ];

  if (inlineCount > 0) {
    lines.push('', `📍 Posted ${inlineCount} inline ${pluralize(inlineCount, 'finding')}.`);
  } else if (hasFindings) {
    lines.push('', '📍 No findings could be placed inline.');
  } else {
    lines.push('', '✅ No inline findings to place.');
  }

  if (unplaced.length > 0) {
    lines.push(
      '',
      '<details>',
      '<summary>Unplaced findings</summary>',
      '',
      ...unplaced.map(formatFinding),
      '',
      '</details>'
    );
  }

  lines.push(
    '',
    '### Diagnostics',
    'Detailed review diagnostics are available in the `codex-review-output` workflow artifact.'
  );

  return `${lines.join('\n')}\n`;
}

function reviewEventForSeverity(severity) {
  // Never emit APPROVE: the verdict is produced by an LLM reading the untrusted PR diff, so the
  // workflow must not stamp a green approval it cannot guarantee. Non-blocking outcomes are posted
  // as a plain COMMENT instead.
  if (severity === 'medium' || severity === 'blocking') {
    return 'REQUEST_CHANGES';
  }
  return 'COMMENT';
}

function isDismissableCodexReview(review) {
  // Only APPROVED and CHANGES_REQUESTED reviews can be dismissed; GitHub rejects dismissing a
  // COMMENTED review with 422. A COMMENTED review does not block the PR, so there is nothing to
  // dismiss anyway.
  return review
    && review.user
    // The login of the actor behind github.token, which is what posts and therefore dismisses these
    // reviews. If the workflow ever posts under a different identity (e.g. a GitHub App) this must
    // be updated, otherwise dismissal silently stops matching.
    && review.user.login === 'github-actions[bot]'
    && ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state)
    && typeof review.body === 'string'
    && review.body.includes(CODEX_REVIEW_MARKER);
}

async function createIssueComment({ github, context, body, core }) {
  try {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
      body,
    });
  } catch (error) {
    if (error.status === 403) {
      core.warning('Could not post PR comment because this workflow token lacks permission.');
      return;
    }
    throw error;
  }
}

async function deletePreviousCodexInlineComments({ github, context, core, keepReviewId }) {
  // Best-effort cleanup: remove inline comments left by earlier Codex runs so they do not pile up.
  // Scoped by the hidden marker and the bot identity, and excludes the review just posted
  // (keepReviewId). Any failure here is logged and swallowed so it can never fail a posted review.
  let reviewComments;
  try {
    reviewComments = await github.paginate(github.rest.pulls.listReviewComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      per_page: 100,
    });
  } catch (error) {
    core.warning(`Could not list previous review comments: ${error.message}`);
    return;
  }

  const staleComments = reviewComments.filter(
    (comment) =>
      comment
      && comment.user
      && comment.user.login === 'github-actions[bot]'
      && typeof comment.body === 'string'
      && comment.body.includes(CODEX_INLINE_MARKER)
      && comment.pull_request_review_id !== keepReviewId,
  );

  for (const comment of staleComments) {
    try {
      await github.rest.pulls.deleteReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: comment.id,
      });
      core.info(`Deleted stale Codex inline comment ${comment.id}.`);
    } catch (error) {
      core.warning(`Could not delete stale Codex inline comment ${comment.id}: ${error.message}`);
    }
  }
}

async function dismissPreviousCodexReviews({ github, context, core, runUrl }) {
  let reviews;
  try {
    reviews = await github.paginate(github.rest.pulls.listReviews, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      per_page: 100,
    });
  } catch (error) {
    core.warning(`Could not list previous pull request reviews: ${error.message}`);
    return;
  }

  const previousCodexReviews = reviews.filter(isDismissableCodexReview);

  for (const previousReview of previousCodexReviews) {
    try {
      await github.rest.pulls.dismissReview({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.payload.pull_request.number,
        review_id: previousReview.id,
        message: `Superseded by Codex Review run ${runUrl}.`,
      });
      core.info(`Dismissed previous Codex review ${previousReview.id}.`);
    } catch (error) {
      if (error.status === 403 || error.status === 422) {
        core.warning(`Could not dismiss previous Codex review ${previousReview.id}: ${error.message}`);
        continue;
      }
      throw error;
    }
  }
}

module.exports = async function postReview({ github, context, core }) {
  const pr = context.payload.pull_request;
  // These are passthrough outputs from upstream jobs and can be empty strings when a job is skipped,
  // so allowEmpty: true treats only a genuinely unset variable as missing.
  const safetyFailure = requiredEnv('PREFLIGHT_SAFETY_FAILURE', { allowEmpty: true }) === 'true';
  const safetyMessage = process.env.PREFLIGHT_SAFETY_MESSAGE || '';
  const skipReason = process.env.PREFLIGHT_SKIP_REASON || '';
  const skipMessage = process.env.PREFLIGHT_SKIP_MESSAGE || '';
  const codexResult = requiredEnv('CODEX_RESULT', { allowEmpty: true });
  const runUrl = requiredEnv('RUN_URL', { allowEmpty: true });

  if (safetyFailure) {
    await createIssueComment({
      github,
      context,
      core,
      body: safetyMessage || 'Codex review was not run because this PR changes reviewer automation files.',
    });
    return;
  }

  if (skipReason) {
    await createIssueComment({
      github,
      context,
      core,
      body: skipMessage || `Codex review was skipped during preflight (${skipReason}).`,
    });
    return;
  }

  if (codexResult !== 'success') {
    await createIssueComment({
      github,
      context,
      core,
      body: `Codex review failed before producing a usable review. Workflow run: ${runUrl}`,
    });
    return;
  }

  let review;
  try {
    review = readReviewOutput(requiredEnv('CODEX_OUTPUT_FILE', { allowEmpty: true }));
    validateReview(review);
  } catch (error) {
    await createIssueComment({
      github,
      context,
      core,
      body: `Codex review produced invalid structured output, so no approval or request-changes review was submitted. Workflow run: ${runUrl}`,
    });
    core.setFailed(error.message);
    return;
  }

  let files;
  try {
    files = await github.paginate(github.rest.pulls.listFiles, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      per_page: 100,
    });
  } catch (error) {
    // Without the changed-file patches we cannot map inline comments, and every other API path
    // degrades to a comment rather than a hard failure. Do the same so a valid Codex review still
    // surfaces some PR feedback instead of an opaque crashed step.
    core.warning(`Could not list pull request files: ${error.message}`);
    await createIssueComment({
      github,
      context,
      core,
      body: `Codex review completed, but the changed-file list could not be retrieved, so no review was posted. Workflow run: ${runUrl}`,
    });
    return;
  }

  // listFiles returns patches for at most ~300 files and omits patches for very large or binary
  // files. Inline comments targeting those paths get an empty patch here and fall through to
  // unplaced_findings below by design (see the `valid` check) -- this degradation is expected.
  const patchesByPath = new Map();
  for (const file of files) {
    patchesByPath.set(file.filename, parsePatchLines(file.patch));
  }

  const comments = [];
  const unplaced = [];
  // Mirror of the placed inline comments as plain findings, used to fold them back into the review
  // body if GitHub rejects the inline comments wholesale (see the 422 fallback below).
  const placedFindings = [];

  for (const comment of review.inline_comments) {
    const { placed, patchMissing } = placeInlineComment({
      candidate: comment,
      side: comment.side,
      patchesByPath,
      comments,
      placedFindings,
    });

    if (!placed) {
      // Distinguish a patch-less path (listFiles truncation / binary / >~300 changed files) from a
      // line the model picked that simply is not part of the diff -- different root causes.
      const reason = patchMissing
        ? 'no patch was returned for this path (large/binary file or listFiles truncation)'
        : `line ${comment.line} (${comment.side}) is not part of the diff`;
      core.warning(`Demoted inline comment on ${comment.path}: ${reason}.`);
      unplaced.push({
        severity: comment.severity,
        body: comment.body,
        path: comment.path,
        line: comment.line,
      });
    }
  }

  for (const finding of review.unplaced_findings) {
    // Unplaced findings only ever attach to the new side; when they cannot be located they stay in
    // the unplaced list as-is.
    const { placed } = placeInlineComment({
      candidate: finding,
      side: 'RIGHT',
      patchesByPath,
      comments,
      placedFindings,
    });

    if (!placed) {
      unplaced.push(finding);
    }
  }

  const body = buildReviewBody(review, unplaced, comments.length);
  const event = reviewEventForSeverity(review.highest_severity);

  core.info(`Codex review: placing ${comments.length} inline ${pluralize(comments.length, 'comment')}, ${unplaced.length} unplaced, event=${event}.`);

  let created;
  try {
    created = await github.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      body,
      event,
      comments,
    });
  } catch (error) {
    if (error.status === 403) {
      await createIssueComment({
        github,
        context,
        core,
        body: `Codex review completed, but the workflow token could not submit a pull request review. Workflow run: ${runUrl}`,
      });
      // The new review was never posted, so leave any previous (possibly blocking) review in place.
      return;
    }

    // GitHub rejects the whole review with 422 if a single inline comment lands on a line it does
    // not consider commentable. Rather than lose every finding, retry once without inline comments
    // and fold them into the body as unplaced findings. A failure of this retry propagates
    // (skipping the cleanup below), again leaving any previous review in place.
    if (error.status === 422 && comments.length > 0) {
      core.warning(`GitHub rejected the inline comments (422): ${error.message}. Retrying without inline comments.`);
      const fallbackBody = buildReviewBody(review, [...unplaced, ...placedFindings], 0);
      created = await github.rest.pulls.createReview({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number,
        body: fallbackBody,
        event,
        comments: [],
      });
      core.info('Posted a comment-free Codex review after the inline comments were rejected.');
    } else {
      throw error;
    }
  }

  // Clean up after the new review is safely posted. Delete inline comments left by earlier runs
  // (keeping the one just created), then supersede earlier reviews. Dismissing first risked removing
  // a previous blocking review and then failing to post the replacement, silently unblocking the PR.
  await deletePreviousCodexInlineComments({ github, context, core, keepReviewId: created?.data?.id });
  await dismissPreviousCodexReviews({ github, context, core, runUrl });
};

// Exported for unit testing. The workflow only calls the default postReview export; these named
// helpers are attached so their logic can be exercised in isolation (see post-review.test.js).
module.exports.parsePatchLines = parsePatchLines;
module.exports.validateReview = validateReview;
module.exports.expectedHighestSeverity = expectedHighestSeverity;
module.exports.buildReviewBody = buildReviewBody;
module.exports.reviewEventForSeverity = reviewEventForSeverity;
module.exports.isDismissableCodexReview = isDismissableCodexReview;
module.exports.CODEX_REVIEW_MARKER = CODEX_REVIEW_MARKER;
module.exports.CODEX_INLINE_MARKER = CODEX_INLINE_MARKER;
