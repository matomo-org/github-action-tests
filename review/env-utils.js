'use strict';

// Shared environment-variable readers for the review scripts.
//
// requiredEnv throws when a variable is unset. By default it also rejects an empty string, which is
// what render-review-prompt.js wants (an empty PR_NUMBER etc. is a bug). post-review.js runs with
// `if: always()`, so passthrough outputs such as PREFLIGHT_SAFETY_FAILURE can legitimately be an
// empty string when an upstream job did not complete; those callers pass { allowEmpty: true }.
function requiredEnv(name, { allowEmpty = false } = {}) {
  const value = process.env[name];
  if (value === undefined || (!allowEmpty && value === '')) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name) {
  return process.env[name] || '';
}

module.exports = { requiredEnv, optionalEnv };
