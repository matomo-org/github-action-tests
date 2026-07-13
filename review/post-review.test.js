'use strict';

// Unit tests for post-review.js. No external dependencies: run with
//   node --test review/post-review.test.js
// The workflow calls the default postReview export; the named helpers are attached for testing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const postReview = require('./post-review.js');
const { buildCodexReviewHeader } = require('./review-constants');
const {
  parsePatchLines,
  resolveReviewOutputPath,
  readReviewOutput,
  validateReview,
  expectedHighestSeverity,
  countFindingsBySeverity,
  buildReviewBody,
  formatInlineCommentBody,
  reviewEventForSeverity,
  isDismissableCodexReview,
  CODEX_REVIEW_MARKER,
  CODEX_INLINE_MARKER,
  CODEX_REVIEW_OUTPUT_FILE,
  REVIEW_LIMITS,
} = postReview;

const REVIEWED_HEAD_SHA = 'a'.repeat(40);
const REVIEWED_BASE_SHA = 'b'.repeat(40);

// --- parsePatchLines --------------------------------------------------------

test('parsePatchLines: null and empty patches produce empty sets', () => {
  for (const input of [null, undefined, '']) {
    const { right, left } = parsePatchLines(input);
    assert.equal(right.size, 0);
    assert.equal(left.size, 0);
  }
});

test('parsePatchLines: maps added, removed, and context lines to the correct sides', () => {
  // The `patch` field from pulls.listFiles starts at the first @@ hunk header and contains no
  // `---`/`+++` file-header lines, so this fixture deliberately omits them.
  const patch = [
    '@@ -10,3 +10,4 @@ function context()',
    ' context1',
    '-removed',
    '+added1',
    '+added2',
    ' context2',
    '\\ No newline at end of file',
  ].join('\n');

  const { right, left } = parsePatchLines(patch);

  // RIGHT (new file) covers context + added lines; LEFT (old file) covers context + removed lines.
  assert.deepEqual([...right].sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.deepEqual([...left].sort((a, b) => a - b), [10, 11, 12]);
});

test('parsePatchLines: handles single-line hunk headers without counts', () => {
  const patch = ['@@ -1 +1 @@', '-old', '+new'].join('\n');
  const { right, left } = parsePatchLines(patch);
  assert.deepEqual([...right], [1]);
  assert.deepEqual([...left], [1]);
});

test('parsePatchLines: counts source lines that begin with ++ or -- (not file headers)', () => {
  // A hunk `patch` never contains `---`/`+++` file headers, so an added line whose source begins
  // with `++` renders as `+++...` and a removed line whose source begins with `--` renders as
  // `---...`. These are real content lines and must advance the line counters.
  const patch = [
    '@@ -1,2 +1,3 @@',
    ' ctx',
    '---removedDashes',
    '+++addedPluses',
    '+afterAdded',
  ].join('\n');

  const { right, left } = parsePatchLines(patch);

  // ctx=1, +++addedPluses=2, +afterAdded=3 on the new side; ctx=1, ---removedDashes=2 on the old.
  assert.deepEqual([...right].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...left].sort((a, b) => a - b), [1, 2]);
});

test('parsePatchLines: resets line counters across multiple hunks', () => {
  const patch = [
    '@@ -1,2 +1,2 @@',
    ' a',
    '+b',
    '@@ -10,2 +20,2 @@',
    ' c',
    '+d',
  ].join('\n');

  const { right, left } = parsePatchLines(patch);

  assert.deepEqual([...right].sort((a, b) => a - b), [1, 2, 20, 21]);
  assert.deepEqual([...left].sort((a, b) => a - b), [1, 10]);
});

// --- validateReview ---------------------------------------------------------

function validReview(overrides = {}) {
  return {
    review_body_markdown: 'summary',
    diagnostics_markdown: 'diagnostics',
    highest_severity: 'none',
    findings: { blocking: 0, medium: 0, low_polish: 0 },
    inline_comments: [],
    unplaced_findings: [],
    ...overrides,
  };
}

test('validateReview: accepts a minimal valid review', () => {
  assert.doesNotThrow(() => validateReview(validReview()));
});

test('validateReview: recomputes findings and highest_severity from structured findings', () => {
  const review = validReview({
    findings: { blocking: 0, medium: 0, low_polish: 0 },
    highest_severity: 'none',
    inline_comments: [
      { path: 'a.js', line: 1, side: 'RIGHT', severity: 'medium', body: 'b', rule_source: null },
      { path: 'b.js', line: 2, side: 'RIGHT', severity: 'low', body: 'b', rule_source: null },
    ],
    unplaced_findings: [
      { severity: 'blocking', body: 'b', path: null, line: null },
    ],
  });
  validateReview(review);
  assert.deepEqual(review.findings, { blocking: 1, medium: 1, low_polish: 1 });
  assert.equal(review.highest_severity, 'blocking');
});

test('validateReview: ignores inconsistent model-provided finding counts', () => {
  // Counts claim no findings, but a blocking inline comment is present: the normalized review must
  // be treated as blocking so it is posted as REQUEST_CHANGES with a truthful overview table.
  const blockingComment = validReview({
    findings: { blocking: 0, medium: 0, low_polish: 0 },
    highest_severity: 'none',
    inline_comments: [
      { path: 'a.js', line: 1, side: 'RIGHT', severity: 'blocking', body: 'b', rule_source: null },
    ],
  });
  validateReview(blockingComment);
  assert.deepEqual(blockingComment.findings, { blocking: 1, medium: 0, low_polish: 0 });
  assert.equal(blockingComment.highest_severity, 'blocking');

  // Likewise an unplaced medium finding outranks all-zero counts.
  const mediumUnplaced = validReview({
    findings: { blocking: 0, medium: 0, low_polish: 0 },
    highest_severity: 'none',
    unplaced_findings: [{ severity: 'medium', body: 'b', path: null, line: null }],
  });
  validateReview(mediumUnplaced);
  assert.deepEqual(mediumUnplaced.findings, { blocking: 0, medium: 1, low_polish: 0 });
  assert.equal(mediumUnplaced.highest_severity, 'medium');

  // A stale blocking count must not turn a lower-severity structured finding into a blocking review.
  const structuredFindingsWin = validReview({
    findings: { blocking: 1, medium: 0, low_polish: 0 },
    highest_severity: 'none',
    inline_comments: [
      { path: 'a.js', line: 1, side: 'RIGHT', severity: 'low', body: 'b', rule_source: null },
    ],
  });
  validateReview(structuredFindingsWin);
  assert.deepEqual(structuredFindingsWin.findings, { blocking: 0, medium: 0, low_polish: 1 });
  assert.equal(structuredFindingsWin.highest_severity, 'low');
});

test('validateReview: rejects non-object payloads', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    assert.throws(() => validateReview(bad));
  }
});

test('validateReview: rejects unknown properties at every structured object boundary', () => {
  assert.throws(
    () => validateReview({ ...validReview(), unexpected: true }),
    /Codex output must contain exactly these properties/,
  );
  assert.throws(
    () => validateReview(validReview({
      findings: { blocking: 0, medium: 0, low_polish: 0, critical: 1 },
    })),
    /findings must contain exactly these properties/,
  );
  assert.throws(
    () => validateReview(validReview({
      inline_comments: [{
        path: 'a.js', line: 1, side: 'RIGHT', severity: 'low', body: 'b', rule_source: null, command: 'run me',
      }],
    })),
    /inline_comments\[0\] must contain exactly these properties/,
  );
  assert.throws(
    () => validateReview(validReview({
      unplaced_findings: [{
        severity: 'low', body: 'b', path: null, line: null, html: '<script>',
      }],
    })),
    /unplaced_findings\[0\] must contain exactly these properties/,
  );
});

test('validateReview: rejects missing or empty required string fields', () => {
  assert.throws(() => validateReview(validReview({ review_body_markdown: '' })));
  assert.throws(() => validateReview(validReview({ review_body_markdown: '   ' })));
  assert.throws(() => validateReview(validReview({ diagnostics_markdown: '' })));
});

test('validateReview: rejects over-limit strings and finding collections', () => {
  const inlineComment = { path: 'a.js', line: 1, side: 'RIGHT', severity: 'low', body: 'b', rule_source: null };
  const unplacedFinding = { severity: 'low', body: 'b', path: null, line: null };

  assert.throws(() => validateReview(validReview({
    review_body_markdown: 'x'.repeat(REVIEW_LIMITS.reviewBodyMarkdownMaxLength + 1),
  })), /review_body_markdown must be at most/);
  assert.throws(() => validateReview(validReview({
    diagnostics_markdown: 'x'.repeat(REVIEW_LIMITS.diagnosticsMarkdownMaxLength + 1),
  })), /diagnostics_markdown must be at most/);
  assert.throws(() => validateReview(validReview({
    findings: { blocking: REVIEW_LIMITS.inlineCommentsMaxItems + REVIEW_LIMITS.unplacedFindingsMaxItems + 1, medium: 0, low_polish: 0 },
  })), /findings\.blocking must be at most/);
  assert.throws(() => validateReview(validReview({
    inline_comments: Array.from({ length: REVIEW_LIMITS.inlineCommentsMaxItems + 1 }, () => inlineComment),
  })), /inline_comments must contain at most/);
  assert.throws(() => validateReview(validReview({
    unplaced_findings: Array.from({ length: REVIEW_LIMITS.unplacedFindingsMaxItems + 1 }, () => unplacedFinding),
  })), /unplaced_findings must contain at most/);
  assert.throws(() => validateReview(validReview({
    inline_comments: [{ ...inlineComment, path: 'x'.repeat(REVIEW_LIMITS.pathMaxLength + 1) }],
  })), /path must be at most/);
  assert.throws(() => validateReview(validReview({
    inline_comments: [{ ...inlineComment, body: 'x'.repeat(REVIEW_LIMITS.findingBodyMaxLength + 1) }],
  })), /body must be at most/);
  assert.throws(() => validateReview(validReview({
    inline_comments: [{ ...inlineComment, rule_source: 'x'.repeat(REVIEW_LIMITS.ruleSourceMaxLength + 1) }],
  })), /rule_source must be at most/);
  assert.throws(() => validateReview(validReview({
    unplaced_findings: [{ ...unplacedFinding, path: 'x'.repeat(REVIEW_LIMITS.pathMaxLength + 1) }],
  })), /path must be at most/);
  assert.throws(() => validateReview(validReview({
    unplaced_findings: [{ ...unplacedFinding, body: 'x'.repeat(REVIEW_LIMITS.findingBodyMaxLength + 1) }],
  })), /body must be at most/);
});

test('validateReview: rejects an invalid highest_severity enum before recompute', () => {
  assert.throws(() => validateReview(validReview({ highest_severity: 'critical' })));
});

test('validateReview: rejects malformed findings', () => {
  assert.throws(() => validateReview(validReview({ findings: null })));
  assert.throws(() => validateReview(validReview({ findings: { blocking: -1, medium: 0, low_polish: 0 } })));
  assert.throws(() => validateReview(validReview({ findings: { blocking: '1', medium: 0, low_polish: 0 } })));
});

test('validateReview: rejects non-array comment/finding collections', () => {
  assert.throws(() => validateReview(validReview({ inline_comments: {} })));
  assert.throws(() => validateReview(validReview({ unplaced_findings: {} })));
});

test('validateReview: accepts a well-formed inline comment', () => {
  const review = validReview({
    findings: { blocking: 0, medium: 0, low_polish: 1 },
    inline_comments: [
      { path: 'a.js', line: 3, side: 'RIGHT', severity: 'low', body: 'b', rule_source: 'matomo-code-quality' },
    ],
  });
  assert.doesNotThrow(() => validateReview(review));
});

test('validateReview: rejects inline comments with invalid fields', () => {
  const base = { path: 'a.js', line: 1, side: 'RIGHT', severity: 'low', body: 'b', rule_source: null };
  assert.throws(() => validateReview(validReview({ inline_comments: [{ ...base, side: 'MIDDLE' }] })), /side must be LEFT or RIGHT/);
  assert.throws(() => validateReview(validReview({ inline_comments: [{ ...base, line: 0 }] })), /line must be a positive integer/);
  assert.throws(() => validateReview(validReview({ inline_comments: [{ ...base, severity: 'none' }] })), /severity is invalid/);
  assert.throws(() => validateReview(validReview({ inline_comments: [{ ...base, body: '' }] })));
  assert.throws(() => validateReview(validReview({ inline_comments: [{ ...base, rule_source: 42 }] })), /rule_source must be a string or null/);
});

test('validateReview: accepts unplaced findings with null path and line', () => {
  const review = validReview({
    findings: { blocking: 0, medium: 1, low_polish: 0 },
    unplaced_findings: [{ severity: 'medium', body: 'b', path: null, line: null }],
  });
  assert.doesNotThrow(() => validateReview(review));
});

test('validateReview: rejects unplaced findings with missing or invalid nullable placement fields', () => {
  assert.throws(() => validateReview(validReview({ unplaced_findings: [{ severity: 'low', body: 'b', line: null }] })), /path is required/);
  assert.throws(() => validateReview(validReview({ unplaced_findings: [{ severity: 'low', body: 'b', path: null }] })), /line is required/);
  assert.throws(() => validateReview(validReview({ unplaced_findings: [{ severity: 'low', body: 'b', path: undefined, line: null }] })), /path must be a string or null/);
  assert.throws(() => validateReview(validReview({ unplaced_findings: [{ severity: 'low', body: 'b', path: null, line: undefined }] })), /positive integer or null/);
  assert.throws(() => validateReview(validReview({ unplaced_findings: [{ severity: 'nope', body: 'b', path: null, line: null }] })));
  assert.throws(() => validateReview(validReview({ unplaced_findings: [{ severity: 'low', body: 'b', path: 'a.js', line: 0 }] })), /positive integer or null/);
});

// --- expectedHighestSeverity ------------------------------------------------

test('expectedHighestSeverity: maps counts to the highest present severity', () => {
  assert.equal(expectedHighestSeverity({ blocking: 2, medium: 1, low_polish: 1 }), 'blocking');
  assert.equal(expectedHighestSeverity({ blocking: 0, medium: 1, low_polish: 1 }), 'medium');
  assert.equal(expectedHighestSeverity({ blocking: 0, medium: 0, low_polish: 1 }), 'low');
  assert.equal(expectedHighestSeverity({ blocking: 0, medium: 0, low_polish: 0 }), 'none');
});

test('countFindingsBySeverity: counts inline and unplaced finding severities', () => {
  const inlineComments = [
    { severity: 'blocking' },
    { severity: 'low' },
  ];
  const unplacedFindings = [
    { severity: 'medium' },
    { severity: 'low' },
  ];
  assert.deepEqual(
    countFindingsBySeverity(inlineComments, unplacedFindings),
    { blocking: 1, medium: 1, low_polish: 2 },
  );
});

// --- reviewEventForSeverity (security invariant: never APPROVE) --------------

test('reviewEventForSeverity: requests changes only for medium/blocking and never approves', () => {
  assert.equal(reviewEventForSeverity('blocking'), 'REQUEST_CHANGES');
  assert.equal(reviewEventForSeverity('medium'), 'REQUEST_CHANGES');
  assert.equal(reviewEventForSeverity('low'), 'COMMENT');
  assert.equal(reviewEventForSeverity('none'), 'COMMENT');
  for (const severity of ['none', 'low', 'medium', 'blocking', 'unexpected']) {
    assert.notEqual(reviewEventForSeverity(severity), 'APPROVE');
  }
});

// --- isDismissableCodexReview -----------------------------------------------

test('isDismissableCodexReview: matches only bot reviews that block and carry the marker', () => {
  const base = {
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    body: `intro ${CODEX_REVIEW_MARKER} outro`,
  };
  assert.ok(isDismissableCodexReview(base));
  assert.ok(isDismissableCodexReview({ ...base, state: 'APPROVED' }));
  // COMMENTED reviews are not dismissable (GitHub rejects it) and do not block the PR.
  assert.ok(!isDismissableCodexReview({ ...base, state: 'COMMENTED' }));
  assert.ok(!isDismissableCodexReview({ ...base, user: { login: 'someone-else' } }));
  assert.ok(!isDismissableCodexReview({ ...base, body: 'no marker here' }));
  assert.ok(!isDismissableCodexReview({ state: 'APPROVED', body: base.body })); // no user
  assert.ok(!isDismissableCodexReview(null));
});

// --- buildReviewBody --------------------------------------------------------

test('buildReviewBody: embeds the marker, the severity table, and the inline-count line', () => {
  const review = {
    review_body_markdown: 'Short summary.',
    diagnostics_markdown: 'diag',
    highest_severity: 'medium',
    findings: { blocking: 0, medium: 2, low_polish: 1 },
    inline_comments: [],
    unplaced_findings: [],
  };

  const withUnplaced = buildReviewBody(
    review,
    [{ severity: 'medium', body: 'floating finding', path: null, line: null }],
    0,
    REVIEWED_BASE_SHA,
  );
  assert.ok(withUnplaced.startsWith(`${buildCodexReviewHeader(REVIEWED_BASE_SHA)}\n`));
  assert.ok(withUnplaced.includes(CODEX_REVIEW_MARKER));
  assert.match(withUnplaced, /\| ⚠️ Medium \| 2 \|/);
  assert.match(withUnplaced, /\| 💬 Low \/ Polish \| 1 \|/);
  assert.match(withUnplaced, /Unplaced findings/);
  assert.match(withUnplaced, /floating finding/);
  assert.match(withUnplaced, /Short summary\./);

  const placed = buildReviewBody(review, [], 3, REVIEWED_BASE_SHA);
  assert.match(placed, /Posted 3 inline findings\./);

  const noFindings = buildReviewBody(
    { ...review, findings: { blocking: 0, medium: 0, low_polish: 0 } },
    [],
    0,
    REVIEWED_BASE_SHA,
  );
  assert.match(noFindings, /No inline findings to place\./);
});

test('buildReviewBody: caps the public body and reports findings retained only in diagnostics', () => {
  const unplaced = Array.from({ length: 40 }, (_, index) => ({
    severity: 'blocking',
    body: `finding-${index}-${'x'.repeat(REVIEW_LIMITS.findingBodyMaxLength - 11)}`,
    path: `${index}-${'p'.repeat(REVIEW_LIMITS.pathMaxLength - String(index).length - 1)}`,
    line: index + 1,
  }));
  const review = validReview({
    review_body_markdown: 's'.repeat(REVIEW_LIMITS.reviewBodyMarkdownMaxLength),
    highest_severity: 'blocking',
    findings: { blocking: unplaced.length, medium: 0, low_polish: 0 },
  });

  const body = buildReviewBody(review, unplaced, 0, REVIEWED_BASE_SHA);

  assert.ok(body.length <= REVIEW_LIMITS.publicReviewBodyMaxLength);
  assert.match(body, /additional unplaced findings omitted from this review body/);
  assert.match(body, /workflow artifact for the complete output/);
  assert.match(body, /finding-0-/);
  assert.doesNotMatch(body, /finding-39-/);
});

test('public review Markdown neutralizes mentions and safely displays untrusted metadata', () => {
  const review = validReview({
    review_body_markdown: 'Please notify @octocat or reviewer@example.com.',
    highest_severity: 'medium',
    findings: { blocking: 0, medium: 1, low_polish: 0 },
  });
  const body = buildReviewBody(review, [{
    severity: 'medium',
    body: 'Escalate to @matomo-org/security.',
    path: 'src/odd`name\n@reviewers.js',
    line: 7,
  }], 0, REVIEWED_BASE_SHA);

  assert.match(body, /@\u200boctocat/);
  assert.match(body, /@\u200bmatomo-org\/security/);
  assert.match(body, /@\u200breviewers\.js/);
  assert.match(body, /<U\+000A>/);
  assert.match(body, /reviewer@\u200bexample\.com/);
  assert.doesNotMatch(body, /@octocat|@matomo-org\/security|@reviewers\.js|@example\.com/);

  const inlineBody = formatInlineCommentBody({
    severity: 'low',
    body: 'Ask @octocat.',
    rule_source: 'skill`name @matomo-org/security',
  });
  assert.match(inlineBody, /@\u200boctocat/);
  assert.match(inlineBody, /@\u200bmatomo-org\/security/);
  assert.match(inlineBody, /`` skill`name/);
});

// --- postReview orchestration (fake GitHub client, no network) ---------------

function fakeGithub({
  files = [],
  reviews = [],
  reviewComments = [],
  liveHeadSha = REVIEWED_HEAD_SHA,
  liveBaseSha = REVIEWED_BASE_SHA,
  createReviewErrors = [],
  dismissReviewErrors = [],
  getPullError = null,
  listFilesError = null,
  listReviewsError = null,
} = {}) {
  // `order` records the sequence of mutating API calls so tests can assert, e.g., that the new
  // review is created before previous ones are dismissed. createReview returns an incrementing
  // review id so the stale-inline-comment cleanup can distinguish the new review from prior ones.
  const calls = {
    createReview: [], dismissReview: [], createComment: [],
    deleteReviewComment: [], getPull: 0, listFiles: 0, listReviews: 0,
    listReviewComments: 0, order: [],
  };
  const currentReviews = [...reviews];
  let createReviewCall = 0;
  let dismissReviewCall = 0;
  const github = {
    // The real code calls github.paginate(fn, params); the fake ignores params and invokes fn.
    paginate: async (fn) => fn(),
    rest: {
      pulls: {
        get: async () => {
          calls.getPull += 1;
          if (getPullError) throw getPullError;
          return { data: { head: { sha: liveHeadSha }, base: { sha: liveBaseSha } } };
        },
        listFiles: async () => { calls.listFiles += 1; if (listFilesError) throw listFilesError; return files; },
        listReviews: async () => { calls.listReviews += 1; if (listReviewsError) throw listReviewsError; return currentReviews; },
        listReviewComments: async () => { calls.listReviewComments += 1; return reviewComments; },
        createReview: async (params) => {
          calls.createReview.push(params);
          calls.order.push('createReview');
          const err = createReviewErrors[createReviewCall];
          const id = 1000 + createReviewCall;
          createReviewCall += 1;
          if (err) throw err;
          currentReviews.push({
            id,
            user: { login: 'github-actions[bot]' },
            state: params.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED',
            body: params.body,
            commit_id: params.commit_id,
          });
          return { data: { id } };
        },
        dismissReview: async (params) => {
          calls.dismissReview.push(params);
          calls.order.push('dismissReview');
          const err = dismissReviewErrors[dismissReviewCall];
          dismissReviewCall += 1;
          if (err) throw err;
        },
        deleteReviewComment: async (params) => { calls.deleteReviewComment.push(params); calls.order.push('deleteReviewComment'); },
      },
      issues: {
        createComment: async (params) => { calls.createComment.push(params); calls.order.push('createComment'); },
      },
    },
  };
  return { github, calls };
}

function fakeContext() {
  return {
    repo: { owner: 'matomo-org', repo: 'plugin-Example' },
    payload: { pull_request: { number: 7, head: { sha: REVIEWED_HEAD_SHA } } },
  };
}

function fakeCore() {
  const core = {
    warnings: [],
    infos: [],
    failures: [],
    warning: (m) => core.warnings.push(m),
    info: (m) => core.infos.push(m),
    setFailed: (m) => core.failures.push(m),
  };
  return core;
}

function setEnv(t, vars) {
  vars = { REVIEWED_BASE_SHA, REVIEWED_HEAD_SHA, ...vars };
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  t.after(() => {
    for (const [key, previous] of Object.entries(saved)) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
}

function writeTempReview(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
  const file = path.join(dir, CODEX_REVIEW_OUTPUT_FILE);
  fs.writeFileSync(file, content);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function reviewJson(overrides = {}) {
  return JSON.stringify({
    review_body_markdown: 'Looks reasonable.',
    diagnostics_markdown: 'diag',
    highest_severity: 'medium',
    findings: { blocking: 0, medium: 1, low_polish: 0 },
    inline_comments: [],
    unplaced_findings: [],
    ...overrides,
  });
}

test('resolveReviewOutputPath: only accepts the expected output file inside the output directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
  const expectedFile = path.join(dir, CODEX_REVIEW_OUTPUT_FILE);
  fs.writeFileSync(expectedFile, reviewJson());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(resolveReviewOutputPath(dir), fs.realpathSync(expectedFile));
});

test('resolveReviewOutputPath: rejects output files that resolve outside the output directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-outside-'));
  const outsideFile = path.join(outsideDir, CODEX_REVIEW_OUTPUT_FILE);
  const linkedFile = path.join(dir, CODEX_REVIEW_OUTPUT_FILE);
  fs.writeFileSync(outsideFile, reviewJson());
  fs.symlinkSync(outsideFile, linkedFile);
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  assert.throws(
    () => resolveReviewOutputPath(dir),
    /must resolve inside CODEX_OUTPUT_DIR/,
  );
});

test('readReviewOutput: rejects non-files and files over the byte limit before parsing', (t) => {
  const directoryOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-directory-'));
  fs.mkdirSync(path.join(directoryOutput, CODEX_REVIEW_OUTPUT_FILE));
  t.after(() => fs.rmSync(directoryOutput, { recursive: true, force: true }));
  assert.throws(() => readReviewOutput(directoryOutput), /must be a regular file/);

  const oversizedOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-oversized-'));
  fs.writeFileSync(
    path.join(oversizedOutput, CODEX_REVIEW_OUTPUT_FILE),
    'x'.repeat(REVIEW_LIMITS.reviewOutputFileMaxBytes + 1),
  );
  t.after(() => fs.rmSync(oversizedOutput, { recursive: true, force: true }));
  assert.throws(() => readReviewOutput(oversizedOutput), /must be at most .* bytes/);
});

test('postReview: posts a comment and no review on a preflight safety failure', async (t) => {
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'true',
    PREFLIGHT_SAFETY_MESSAGE: 'automation files changed',
    CODEX_RESULT: 'skipped',
    RUN_URL: 'https://example/run',
  });
  const { github, calls } = fakeGithub();
  await postReview({ github, context: fakeContext(), core: fakeCore() });
  assert.equal(calls.createComment.length, 1);
  assert.equal(calls.createComment[0].body, 'automation files changed');
  assert.equal(calls.createReview.length, 0);
});

test('postReview: neutralizes mentions in preflight feedback', async (t) => {
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'true',
    PREFLIGHT_SAFETY_MESSAGE: 'Automation path requested @matomo-org/security review.',
    CODEX_RESULT: 'skipped',
    RUN_URL: 'https://example/run',
  });
  const { github, calls } = fakeGithub();

  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /@\u200bmatomo-org\/security/);
  assert.doesNotMatch(calls.createComment[0].body, /@matomo-org\/security/);
});

test('postReview: rejects an invalid frozen head SHA before any GitHub API mutation', async (t) => {
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    REVIEWED_HEAD_SHA: 'refs/heads/main',
    RUN_URL: 'https://example/run',
  });
  const { github, calls } = fakeGithub();

  await assert.rejects(
    postReview({ github, context: fakeContext(), core: fakeCore() }),
    /lowercase 40-character commit SHA/,
  );

  assert.equal(calls.getPull, 0);
  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.createReview.length, 0);
});

test('postReview: rejects an invalid frozen base SHA before any GitHub API mutation', async (t) => {
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    REVIEWED_BASE_SHA: 'refs/heads/main',
    RUN_URL: 'https://example/run',
  });
  const { github, calls } = fakeGithub();

  await assert.rejects(
    postReview({ github, context: fakeContext(), core: fakeCore() }),
    /REVIEWED_BASE_SHA must be a lowercase 40-character commit SHA/,
  );

  assert.equal(calls.getPull, 0);
  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.createReview.length, 0);
});

test('postReview: posts a comment and no review when preflight skipped the run', async (t) => {
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: 'no_new_changes',
    PREFLIGHT_SKIP_MESSAGE: 'already reviewed head',
    CODEX_RESULT: 'skipped',
    RUN_URL: 'https://example/run',
  });
  const { github, calls } = fakeGithub();
  await postReview({ github, context: fakeContext(), core: fakeCore() });
  assert.equal(calls.createComment.length, 1);
  assert.equal(calls.createComment[0].body, 'already reviewed head');
  assert.equal(calls.createReview.length, 0);
});

test('postReview: posts a failure comment when the codex job did not succeed', async (t) => {
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'failure',
    RUN_URL: 'https://example/run/42',
  });
  const { github, calls } = fakeGithub();
  await postReview({ github, context: fakeContext(), core: fakeCore() });
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /failed before producing a usable review/);
  assert.equal(calls.createReview.length, 0);
});

test('postReview: reports invalid structured output and fails the step', async (t) => {
  const file = writeTempReview(t, '{ not valid json');
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub();
  const core = fakeCore();
  await postReview({ github, context: fakeContext(), core });
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /invalid structured output/);
  assert.equal(calls.createReview.length, 0);
  assert.equal(core.failures.length, 1);
});

test('postReview: places an inline comment that maps to a changed diff line', async (t) => {
  const patch = ['@@ -1,2 +1,4 @@', ' line1', ' line2', '+line3', '+line4'].join('\n');
  const file = writeTempReview(t, reviewJson({
    findings: { blocking: 0, medium: 1, low_polish: 0 },
    inline_comments: [{ path: 'a.js', line: 3, side: 'RIGHT', severity: 'medium', body: 'Bug here', rule_source: null }],
  }));
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({ files: [{ filename: 'a.js', patch }] });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.createReview.length, 1);
  const submitted = calls.createReview[0];
  assert.equal(submitted.event, 'REQUEST_CHANGES');
  assert.equal(submitted.commit_id, REVIEWED_HEAD_SHA);
  assert.equal(submitted.comments.length, 1);
  assert.equal(submitted.comments[0].path, 'a.js');
  assert.equal(submitted.comments[0].line, 3);
  assert.equal(submitted.comments[0].side, 'RIGHT');
  assert.ok(submitted.comments[0].body.includes(CODEX_INLINE_MARKER)); // enables later stale-comment cleanup
  assert.ok(submitted.body.includes(CODEX_REVIEW_MARKER));
  assert.equal(calls.createComment.length, 0);
});

test('postReview: demotes an inline comment whose line is not part of the diff', async (t) => {
  const patch = ['@@ -1,2 +1,2 @@', ' line1', ' line2'].join('\n');
  const file = writeTempReview(t, reviewJson({
    highest_severity: 'blocking',
    findings: { blocking: 1, medium: 0, low_polish: 0 },
    inline_comments: [{ path: 'a.js', line: 99, side: 'RIGHT', severity: 'blocking', body: 'Out of range', rule_source: null }],
  }));
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({ files: [{ filename: 'a.js', patch }] });
  const core = fakeCore();
  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].comments.length, 0);
  assert.match(calls.createReview[0].body, /Unplaced findings/);
  assert.match(calls.createReview[0].body, /Out of range/);
  assert.ok(core.warnings.some((w) => /Demoted inline comment/.test(w)));
});

test('postReview: retries without inline comments when GitHub rejects them with 422', async (t) => {
  const patch = ['@@ -1,2 +1,4 @@', ' line1', ' line2', '+line3', '+line4'].join('\n');
  const file = writeTempReview(t, reviewJson({
    findings: { blocking: 0, medium: 1, low_polish: 0 },
    inline_comments: [{ path: 'a.js', line: 3, side: 'RIGHT', severity: 'medium', body: 'Bug here', rule_source: null }],
  }));
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const rejection = Object.assign(new Error('unprocessable entity'), { status: 422 });
  const { github, calls } = fakeGithub({
    files: [{ filename: 'a.js', patch }],
    createReviewErrors: [rejection],
  });
  const core = fakeCore();
  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.createReview.length, 2);
  assert.equal(calls.createReview[0].comments.length, 1); // first attempt: inline
  assert.equal(calls.createReview[1].comments.length, 0); // fallback: comment-free
  assert.equal(calls.createReview[1].commit_id, REVIEWED_HEAD_SHA);
  assert.match(calls.createReview[1].body, /Bug here/); // finding folded into the body
  assert.equal(calls.createReview[1].event, 'REQUEST_CHANGES'); // fallback must not downgrade the verdict
  assert.ok(core.warnings.some((w) => /Retrying without inline comments/.test(w)));
});

test('postReview: dismisses a previous blocking Codex review but keeps the new blocking review', async (t) => {
  const previous = {
    id: 555,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    body: `old ${CODEX_REVIEW_MARKER}`,
  };
  const file = writeTempReview(t, reviewJson({
    findings: { blocking: 1, medium: 0, low_polish: 0 },
    highest_severity: 'blocking',
    unplaced_findings: [{
      severity: 'blocking', body: 'new blocking finding', path: null, line: null,
    }],
  }));
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({ files: [], reviews: [previous] });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.dismissReview.length, 1);
  assert.equal(calls.dismissReview[0].review_id, 555);
  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].event, 'REQUEST_CHANGES');
  // The new review must be created before the old one is dismissed, so a create failure can never
  // leave the PR with no Codex review at all.
  assert.deepEqual(calls.order, ['createReview', 'dismissReview']);
});

test('postReview: does not attach a completed review to a newer pull request head', async (t) => {
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({ liveHeadSha: 'b'.repeat(40) });
  const core = fakeCore();

  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.getPull, 1);
  assert.equal(calls.listFiles, 0);
  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /head changed before the review could be posted/);
  assert.ok(core.warnings.some((warning) => /pull request head is now/.test(warning)));
});

test('postReview: does not attach a completed review after the pull request base changes', async (t) => {
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({ liveBaseSha: 'c'.repeat(40) });
  const core = fakeCore();

  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.getPull, 1);
  assert.equal(calls.listFiles, 0);
  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /base changed before the review could be posted/);
  assert.ok(core.warnings.some((warning) => /pull request base is now/.test(warning)));
});

test('postReview: fails closed when the current pull request head cannot be verified', async (t) => {
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const getPullError = Object.assign(new Error('API unavailable'), { status: 500 });
  const { github, calls } = fakeGithub({ getPullError });
  const core = fakeCore();

  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /head could not be verified/);
  assert.equal(core.failures.length, 1);
});

test('postReview: does not dismiss previous reviews when creating the new review fails', async (t) => {
  const previous = {
    id: 555,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    body: `old ${CODEX_REVIEW_MARKER}`,
  };
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  // A non-403/422 error is not recoverable and must propagate, but the previous blocking review
  // must be left in place so the PR is not silently unblocked.
  const failure = Object.assign(new Error('server error'), { status: 500 });
  const { github, calls } = fakeGithub({ files: [], reviews: [previous], createReviewErrors: [failure] });
  await assert.rejects(() => postReview({ github, context: fakeContext(), core: fakeCore() }), /server error/);

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.dismissReview.length, 0);
});

test('postReview: requests changes when a blocking inline comment is present despite zero counts', async (t) => {
  const patch = ['@@ -1,2 +1,4 @@', ' line1', ' line2', '+line3', '+line4'].join('\n');
  const file = writeTempReview(t, reviewJson({
    highest_severity: 'none',
    findings: { blocking: 0, medium: 0, low_polish: 0 },
    inline_comments: [{ path: 'a.js', line: 3, side: 'RIGHT', severity: 'blocking', body: 'Serious bug', rule_source: null }],
  }));
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({ files: [{ filename: 'a.js', patch }] });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].event, 'REQUEST_CHANGES');
});

test('postReview: posts a comment instead of crashing when listing PR files fails', async (t) => {
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run/77',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const listFilesError = Object.assign(new Error('boom'), { status: 500 });
  const { github, calls } = fakeGithub({ listFilesError });
  const core = fakeCore();
  // Must resolve (not reject): a valid Codex review should still yield PR feedback.
  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /changed-file list could not be retrieved/);
});

test('postReview: degrades to a plain comment when the token cannot submit a review (403)', async (t) => {
  const previous = {
    id: 555,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    body: `old ${CODEX_REVIEW_MARKER}`,
  };
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
  const { github, calls } = fakeGithub({ files: [], reviews: [previous], createReviewErrors: [forbidden] });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createComment.length, 1);
  assert.match(calls.createComment[0].body, /could not submit a pull request review/);
  // A failed create must not dismiss the previous blocking review.
  assert.equal(calls.dismissReview.length, 0);
});

test('postReview: promotes a locatable unplaced finding to an inline comment', async (t) => {
  const patch = ['@@ -1,2 +1,4 @@', ' line1', ' line2', '+line3', '+line4'].join('\n');
  const file = writeTempReview(t, reviewJson({
    findings: { blocking: 0, medium: 1, low_polish: 0 },
    unplaced_findings: [{ severity: 'medium', body: 'Promote me', path: 'a.js', line: 3 }],
  }));
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({ files: [{ filename: 'a.js', patch }] });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].comments.length, 1);
  const comment = calls.createReview[0].comments[0];
  assert.equal(comment.path, 'a.js');
  assert.equal(comment.line, 3);
  assert.equal(comment.side, 'RIGHT');
  assert.match(comment.body, /Promote me/);
  // Promoted findings are not also listed as unplaced.
  assert.doesNotMatch(calls.createReview[0].body, /Unplaced findings/);
});

test('postReview: still posts the new review when dismissing a previous review fails', async (t) => {
  const previous = {
    id: 555,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    body: `old ${CODEX_REVIEW_MARKER}`,
  };
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const forbidden = Object.assign(new Error('cannot dismiss'), { status: 403 });
  const { github, calls } = fakeGithub({ files: [], reviews: [previous], dismissReviewErrors: [forbidden] });
  const core = fakeCore();
  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.dismissReview.length, 1);
  assert.ok(core.warnings.some((w) => /Could not dismiss previous Codex review/.test(w)));
});

test('postReview: still posts the new review when listing previous reviews fails', async (t) => {
  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const listReviewsError = Object.assign(new Error('list failed'), { status: 500 });
  const { github, calls } = fakeGithub({ files: [], listReviewsError });
  const core = fakeCore();
  await postReview({ github, context: fakeContext(), core });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.dismissReview.length, 0);
  assert.ok(core.warnings.some((w) => /Could not list previous pull request reviews/.test(w)));
});

test('postReview: deletes stale Codex inline comments from previous runs but keeps the new ones', async (t) => {
  // Dismissing a previous review does not remove its inline comments, so they accumulate across runs.
  // The new review carries pull_request_review_id 1000 (the fake createReview id); prior Codex inline
  // comments carry a different id and must be deleted, while human comments and the new review's own
  // comments are left untouched.
  const staleCodex = {
    id: 11, user: { login: 'github-actions[bot]' },
    body: `stale finding\n${CODEX_INLINE_MARKER}`, pull_request_review_id: 42,
  };
  const humanComment = {
    id: 12, user: { login: 'alice' },
    body: `looks fine ${CODEX_INLINE_MARKER}`, pull_request_review_id: 43,
  };
  const botNonCodex = {
    id: 13, user: { login: 'github-actions[bot]' },
    body: 'unrelated bot comment', pull_request_review_id: 44,
  };
  const newReviewComment = {
    id: 14, user: { login: 'github-actions[bot]' },
    body: `fresh finding\n${CODEX_INLINE_MARKER}`, pull_request_review_id: 1000,
  };

  const file = writeTempReview(t, reviewJson());
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_DIR: path.dirname(file),
  });
  const { github, calls } = fakeGithub({
    files: [],
    reviewComments: [staleCodex, humanComment, botNonCodex, newReviewComment],
  });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.createReview.length, 1);
  // Only the stale Codex inline comment is deleted.
  assert.deepEqual(calls.deleteReviewComment.map((c) => c.comment_id), [11]);
});

// --- cross-file invariant ---------------------------------------------------

test('preflight and posting share the same review marker constant', () => {
  const preflight = fs.readFileSync(
    path.join(__dirname, 'preflight.js'),
    'utf8',
  );
  assert.match(preflight, /require\('\.\/review-constants'\)/);
  assert.equal(require('./review-constants').CODEX_REVIEW_MARKER, CODEX_REVIEW_MARKER);
});

test('workflow and documented caller keep the trusted frozen-head review flow', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'codex-review.yml'),
    'utf8',
  );
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const preflight = fs.readFileSync(path.join(__dirname, 'preflight.js'), 'utf8');

  assert.match(readme, /on:\n  pull_request_target:\n    types: \[labeled\]/);
  assert.match(workflow, /validateReviewRequest/);
  assert.match(preflight, /context\.eventName !== 'pull_request_target'/);
  assert.match(preflight, /'diff', '--no-renames', '--name-only', '-z'/);
  assert.match(workflow, /ref: \$\{\{ needs\.preflight\.outputs\.head_sha \}\}/);
  assert.match(workflow, /REVIEWED_BASE_SHA: \$\{\{ needs\.preflight\.outputs\.base_sha \}\}/);
  assert.match(workflow, /REVIEWED_HEAD_SHA: \$\{\{ needs\.preflight\.outputs\.head_sha \}\}/);
  assert.doesNotMatch(workflow, /refs\/pull\/.*\/merge|MERGE_REF/);
});

test('workflow and documentation use the requested default Codex model', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'codex-review.yml'),
    'utf8',
  );
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');

  assert.match(workflow, /default: 'gpt-5\.6-sol'/);
  assert.match(readme, /\| `codex-model` \| no \| `gpt-5\.6-sol` \|/);
  assert.doesNotMatch(`${workflow}\n${readme}`, /gpt-5\.5/);
});

test('review-output schema stays aligned with the post-review validator limits', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'review-output.schema.json'),
    'utf8',
  ));
  const maxFindings = REVIEW_LIMITS.inlineCommentsMaxItems + REVIEW_LIMITS.unplacedFindingsMaxItems;

  assert.equal(schema.properties.review_body_markdown.maxLength, REVIEW_LIMITS.reviewBodyMarkdownMaxLength);
  assert.equal(schema.properties.diagnostics_markdown.maxLength, REVIEW_LIMITS.diagnosticsMarkdownMaxLength);
  assert.equal(schema.properties.findings.properties.blocking.maximum, maxFindings);
  assert.equal(schema.properties.findings.properties.medium.maximum, maxFindings);
  assert.equal(schema.properties.findings.properties.low_polish.maximum, maxFindings);
  assert.equal(schema.properties.inline_comments.maxItems, REVIEW_LIMITS.inlineCommentsMaxItems);
  assert.equal(schema.properties.inline_comments.items.properties.path.maxLength, REVIEW_LIMITS.pathMaxLength);
  assert.equal(schema.properties.inline_comments.items.properties.body.maxLength, REVIEW_LIMITS.findingBodyMaxLength);
  assert.equal(schema.properties.inline_comments.items.properties.rule_source.maxLength, REVIEW_LIMITS.ruleSourceMaxLength);
  assert.equal(schema.properties.unplaced_findings.maxItems, REVIEW_LIMITS.unplacedFindingsMaxItems);
  assert.equal(schema.properties.unplaced_findings.items.properties.path.maxLength, REVIEW_LIMITS.pathMaxLength);
  assert.equal(schema.properties.unplaced_findings.items.properties.body.maxLength, REVIEW_LIMITS.findingBodyMaxLength);
});

test('review-output schema object properties are all required for strict response format', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'review-output.schema.json'),
    'utf8',
  ));

  function assertStrictRequiredProperties(node, schemaPath) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.properties) {
      const propertyKeys = Object.keys(node.properties).sort();
      assert.equal(
        node.additionalProperties,
        false,
        `${schemaPath}.additionalProperties must remain false`,
      );
      assert.ok(Array.isArray(node.required), `${schemaPath}.required must be an array`);
      assert.deepEqual(
        [...node.required].sort(),
        propertyKeys,
        `${schemaPath}.required must include every property for OpenAI strict response format`,
      );
    }

    for (const [key, value] of Object.entries(node.properties || {})) {
      assertStrictRequiredProperties(value, `${schemaPath}.properties.${key}`);
    }
    if (node.items) {
      assertStrictRequiredProperties(node.items, `${schemaPath}.items`);
    }
  }

  assertStrictRequiredProperties(schema, 'schema');
});

test('workflow action references stay pinned to full commit SHAs', () => {
  for (const workflowFile of ['codex-review.yml', 'test-review-scripts.yml']) {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', '.github', 'workflows', workflowFile),
      'utf8',
    );
    for (const match of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
      const actionRef = match[1];
      if (actionRef.includes('/.github/workflows/')) {
        continue;
      }
      assert.match(
        actionRef,
        /@[0-9a-f]{40}$/,
        `${workflowFile} contains an unpinned action reference: ${actionRef}`,
      );
    }
  }
});
