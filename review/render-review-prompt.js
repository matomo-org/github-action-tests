const fs = require('fs');
const { requiredEnv, optionalEnv } = require('./env-utils');

function renderTemplate(input, replacements) {
  // Resolve every {{KEY}} in a single pass over the original template so that values substituted
  // from untrusted PR content (title/body) cannot re-trigger a later substitution. Unknown keys are
  // left as their literal {{KEY}} placeholder rather than being turned into "undefined".
  return input.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match
  );
}

function main() {
  const promptTemplate = requiredEnv('PROMPT_TEMPLATE');
  const promptOutput = requiredEnv('PROMPT_OUTPUT');
  const reviewContext = requiredEnv('REVIEW_CONTEXT');

  const context = {
    pr_number: Number(requiredEnv('PR_NUMBER')),
    base_ref: requiredEnv('BASE_REF'),
    base_sha: requiredEnv('BASE_SHA'),
    head_ref: requiredEnv('HEAD_REF'),
    head_sha: requiredEnv('HEAD_SHA'),
    merge_ref: requiredEnv('MERGE_REF'),
    changed_files: JSON.parse(requiredEnv('CHANGED_FILES')),
    matomo_core_context: optionalEnv('MATOMO_CORE_CONTEXT'),
    matomo_core_path: optionalEnv('MATOMO_CORE_PATH'),
    plugin_name: optionalEnv('PLUGIN_NAME'),
    plugin_in_core_path: optionalEnv('PLUGIN_IN_CORE_PATH'),
  };

  fs.writeFileSync(reviewContext, `${JSON.stringify(context, null, 2)}\n`);

  const template = fs.readFileSync(promptTemplate, 'utf8');
  const prompt = renderTemplate(template, {
    PR_NUMBER: String(context.pr_number),
    PR_TITLE: optionalEnv('PR_TITLE'),
    PR_BODY: optionalEnv('PR_BODY'),
    BASE_REF: context.base_ref,
    BASE_SHA: context.base_sha,
    HEAD_REF: context.head_ref,
    HEAD_SHA: context.head_sha,
    MERGE_REF: context.merge_ref,
    REVIEW_CONTEXT: reviewContext,
    MATOMO_CORE_CONTEXT: context.matomo_core_context,
    MATOMO_CORE_PATH: context.matomo_core_path,
    PLUGIN_NAME: context.plugin_name,
    PLUGIN_IN_CORE_PATH: context.plugin_in_core_path,
  });

  fs.writeFileSync(promptOutput, prompt);
}

// Run the file's work only when executed directly (as the workflow does:
// `node render-review-prompt.js`). When required from a test, only the pure helpers are exposed.
if (require.main === module) {
  main();
}

module.exports = { renderTemplate };
