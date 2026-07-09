'use strict';

// Unit tests for env-utils.js. Run with: node --test review/env-utils.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { requiredEnv, optionalEnv } = require('./env-utils');

function withEnv(t, name, value) {
  const saved = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  t.after(() => {
    if (saved === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved;
    }
  });
}

test('requiredEnv: returns the value when set', (t) => {
  withEnv(t, 'ENV_UTILS_TEST', 'hello');
  assert.equal(requiredEnv('ENV_UTILS_TEST'), 'hello');
});

test('requiredEnv: throws when the variable is unset', (t) => {
  withEnv(t, 'ENV_UTILS_TEST', undefined);
  assert.throws(() => requiredEnv('ENV_UTILS_TEST'), /Missing required environment variable: ENV_UTILS_TEST/);
});

test('requiredEnv: rejects an empty string by default', (t) => {
  withEnv(t, 'ENV_UTILS_TEST', '');
  assert.throws(() => requiredEnv('ENV_UTILS_TEST'));
});

test('requiredEnv: allowEmpty accepts an empty string but still rejects unset', (t) => {
  withEnv(t, 'ENV_UTILS_TEST', '');
  assert.equal(requiredEnv('ENV_UTILS_TEST', { allowEmpty: true }), '');

  withEnv(t, 'ENV_UTILS_UNSET', undefined);
  assert.throws(() => requiredEnv('ENV_UTILS_UNSET', { allowEmpty: true }));
});

test('optionalEnv: returns the value or an empty string', (t) => {
  withEnv(t, 'ENV_UTILS_TEST', 'x');
  assert.equal(optionalEnv('ENV_UTILS_TEST'), 'x');
  withEnv(t, 'ENV_UTILS_TEST', undefined);
  assert.equal(optionalEnv('ENV_UTILS_TEST'), '');
});
