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
const {
  parsePatchLines,
  validateReview,
  expectedHighestSeverity,
  buildReviewBody,
  reviewEventForSeverity,
  isDismissableCodexReview,
  CODEX_REVIEW_MARKER,
} = postReview;

// --- parsePatchLines --------------------------------------------------------

test('parsePatchLines: null and empty patches produce empty sets', () => {
  for (const input of [null, undefined, '']) {
    const { right, left } = parsePatchLines(input);
    assert.equal(right.size, 0);
    assert.equal(left.size, 0);
  }
});

test('parsePatchLines: maps added, removed, and context lines to the correct sides', () => {
  const patch = [
    '--- a/file.txt',
    '+++ b/file.txt',
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

test('validateReview: recomputes highest_severity from the finding counts', () => {
  const cases = [
    [{ blocking: 1, medium: 3, low_polish: 5 }, 'blocking'],
    [{ blocking: 0, medium: 2, low_polish: 5 }, 'medium'],
    [{ blocking: 0, medium: 0, low_polish: 4 }, 'low'],
    [{ blocking: 0, medium: 0, low_polish: 0 }, 'none'],
  ];
  for (const [findings, expected] of cases) {
    // Seed a deliberately wrong highest_severity to prove it is overwritten from the counts.
    const review = validReview({ findings, highest_severity: 'low' });
    validateReview(review);
    assert.equal(review.highest_severity, expected);
  }
});

test('validateReview: rejects non-object payloads', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    assert.throws(() => validateReview(bad));
  }
});

test('validateReview: rejects missing or empty required string fields', () => {
  assert.throws(() => validateReview(validReview({ review_body_markdown: '' })));
  assert.throws(() => validateReview(validReview({ review_body_markdown: '   ' })));
  assert.throws(() => validateReview(validReview({ diagnostics_markdown: '' })));
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

test('validateReview: rejects unplaced findings with invalid severity or line', () => {
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
  );
  assert.ok(withUnplaced.includes(CODEX_REVIEW_MARKER));
  assert.match(withUnplaced, /\| ⚠️ Medium \| 2 \|/);
  assert.match(withUnplaced, /\| 💬 Low \/ Polish \| 1 \|/);
  assert.match(withUnplaced, /Unplaced findings/);
  assert.match(withUnplaced, /floating finding/);
  assert.match(withUnplaced, /Short summary\./);

  const placed = buildReviewBody(review, [], 3);
  assert.match(placed, /Posted 3 inline findings\./);

  const noFindings = buildReviewBody(
    { ...review, findings: { blocking: 0, medium: 0, low_polish: 0 } },
    [],
    0,
  );
  assert.match(noFindings, /No inline findings to place\./);
});

// --- postReview orchestration (fake GitHub client, no network) ---------------

function fakeGithub({ files = [], reviews = [], createReviewErrors = [] } = {}) {
  const calls = { createReview: [], dismissReview: [], createComment: [], listFiles: 0, listReviews: 0 };
  let createReviewCall = 0;
  const github = {
    // The real code calls github.paginate(fn, params); the fake ignores params and invokes fn.
    paginate: async (fn) => fn(),
    rest: {
      pulls: {
        listFiles: async () => { calls.listFiles += 1; return files; },
        listReviews: async () => { calls.listReviews += 1; return reviews; },
        createReview: async (params) => {
          calls.createReview.push(params);
          const err = createReviewErrors[createReviewCall];
          createReviewCall += 1;
          if (err) throw err;
        },
        dismissReview: async (params) => { calls.dismissReview.push(params); },
      },
      issues: {
        createComment: async (params) => { calls.createComment.push(params); },
      },
    },
  };
  return { github, calls };
}

function fakeContext() {
  return { repo: { owner: 'matomo-org', repo: 'plugin-Example' }, payload: { pull_request: { number: 7 } } };
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
  const file = path.join(dir, 'codex-review-output.json');
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
    CODEX_OUTPUT_FILE: file,
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
    CODEX_OUTPUT_FILE: file,
  });
  const { github, calls } = fakeGithub({ files: [{ filename: 'a.js', patch }] });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.createReview.length, 1);
  const submitted = calls.createReview[0];
  assert.equal(submitted.event, 'REQUEST_CHANGES');
  assert.equal(submitted.comments.length, 1);
  assert.equal(submitted.comments[0].path, 'a.js');
  assert.equal(submitted.comments[0].line, 3);
  assert.equal(submitted.comments[0].side, 'RIGHT');
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
    CODEX_OUTPUT_FILE: file,
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
    CODEX_OUTPUT_FILE: file,
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
  assert.match(calls.createReview[1].body, /Bug here/); // finding folded into the body
  assert.ok(core.warnings.some((w) => /Retrying without inline comments/.test(w)));
});

test('postReview: dismisses a previous blocking Codex review before posting', async (t) => {
  const previous = {
    id: 555,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    body: `old ${CODEX_REVIEW_MARKER}`,
  };
  const file = writeTempReview(t, reviewJson({ findings: { blocking: 0, medium: 0, low_polish: 0 }, highest_severity: 'none' }));
  setEnv(t, {
    PREFLIGHT_SAFETY_FAILURE: 'false',
    PREFLIGHT_SKIP_REASON: '',
    CODEX_RESULT: 'success',
    RUN_URL: 'https://example/run',
    CODEX_OUTPUT_FILE: file,
  });
  const { github, calls } = fakeGithub({ files: [], reviews: [previous] });
  await postReview({ github, context: fakeContext(), core: fakeCore() });

  assert.equal(calls.dismissReview.length, 1);
  assert.equal(calls.dismissReview[0].review_id, 555);
  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].event, 'COMMENT'); // no findings -> COMMENT, never APPROVE
});

// --- cross-file invariant ---------------------------------------------------

test('CODEX_REVIEW_MARKER stays byte-identical in the preflight workflow', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'codex-review.yml'),
    'utf8',
  );
  // The preflight job in codex-review.yml matches this literal to detect and supersede prior Codex
  // reviews. The two copies are maintained by hand (preflight cannot require this module), so guard
  // against silent drift that would break dedup/dismissal.
  assert.ok(
    workflow.includes(CODEX_REVIEW_MARKER),
    'codex-review.yml no longer contains the exact CODEX_REVIEW_MARKER literal from post-review.js',
  );
});
