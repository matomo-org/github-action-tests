'use strict';

// Unit tests for the pure template helper in render-review-prompt.js. The file guards its imperative
// work behind `require.main === module`, so requiring it here has no side effects.
//   node --test review/render-review-prompt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderTemplate } = require('./render-review-prompt.js');

test('renderTemplate: substitutes known keys, including repeats', () => {
  assert.equal(renderTemplate('a {{X}} b {{X}} c {{Y}}', { X: '1', Y: '2' }), 'a 1 b 1 c 2');
});

test('renderTemplate: leaves unknown placeholders literal (never "undefined")', () => {
  assert.equal(renderTemplate('{{KNOWN}} {{UNKNOWN}}', { KNOWN: 'ok' }), 'ok {{UNKNOWN}}');
});

test('renderTemplate: substitutes empty-string values', () => {
  assert.equal(renderTemplate('[{{EMPTY}}]', { EMPTY: '' }), '[]');
});

test('renderTemplate: does not re-substitute placeholder-like text from a substituted value', () => {
  // Security property: untrusted PR content (e.g. a PR title of literally "{{PR_BODY}}") must not be
  // able to pull in another key's value on a second pass. A single left-to-right pass guarantees the
  // injected token is left inert.
  const out = renderTemplate('title={{PR_TITLE}} body={{PR_BODY}}', {
    PR_TITLE: '{{PR_BODY}}',
    PR_BODY: 'sensitive',
  });
  assert.equal(out, 'title={{PR_BODY}} body=sensitive');
});

test('renderTemplate: only matches [A-Za-z0-9_]+ placeholder names', () => {
  const out = renderTemplate('{{ok}} {{no-match}} {{ }}', { ok: 'Y', 'no-match': 'X' });
  assert.equal(out, 'Y {{no-match}} {{ }}');
});
