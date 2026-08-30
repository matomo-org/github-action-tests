'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeInvisibleCharacters,
  formatUntrustedInlineCode,
  neutralizeGitHubMentions,
} = require('./markdown-utils');

test('neutralizeGitHubMentions: disables user, team, and email-shaped notification tokens', () => {
  const result = neutralizeGitHubMentions(
    '@octocat, please ask @matomo-org/security. Email reviewer@example.com or a+b@example.com.',
  );

  assert.equal(
    result,
    '@\u200boctocat, please ask @\u200bmatomo-org/security. Email reviewer@\u200bexample.com or a+b@\u200bexample.com.',
  );
  assert.doesNotMatch(result, /(^|\s)@(?:octocat|matomo-org\/security)\b/);
  assert.doesNotMatch(result, /@example\.com/);
});

test('escapeInvisibleCharacters: makes control and direction-changing characters visible', () => {
  assert.equal(
    escapeInvisibleCharacters('line\nname\u202efile.js\0'),
    'line<U+000A>name<U+202E>file.js<U+0000>',
  );
});

test('formatUntrustedInlineCode: contains Markdown delimiters with a longer code fence', () => {
  const result = formatUntrustedInlineCode('src/`odd``name`\nfile.js');

  assert.match(result, /^``` .* ```$/);
  assert.match(result, /src\/`odd``name`<U\+000A>file\.js/);
});
