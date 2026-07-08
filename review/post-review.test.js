'use strict';

// Unit tests for the pure helpers in post-review.js. No external dependencies: run with
//   node --test review/
// The workflow calls the default postReview export; these tests target the named helpers it attaches.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePatchLines, validateReview, expectedHighestSeverity } = require('./post-review.js');

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

test('expectedHighestSeverity: maps counts to the highest present severity', () => {
  assert.equal(expectedHighestSeverity({ blocking: 2, medium: 1, low_polish: 1 }), 'blocking');
  assert.equal(expectedHighestSeverity({ blocking: 0, medium: 1, low_polish: 1 }), 'medium');
  assert.equal(expectedHighestSeverity({ blocking: 0, medium: 0, low_polish: 1 }), 'low');
  assert.equal(expectedHighestSeverity({ blocking: 0, medium: 0, low_polish: 0 }), 'none');
});
