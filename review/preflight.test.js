'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCodexReviewHeader, CODEX_REVIEW_MARKER } = require('./review-constants');
const {
  MAX_CHANGED_FILES_OUTPUT_LENGTH,
  inspectFrozenChanges,
  isAutomationFile,
  isSameRepositoryPullRequest,
  parseAutomationPaths,
  validateReviewRequest,
} = require('./preflight');

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const REPOSITORY_ID = 12345;

function pullRequest(overrides = {}) {
  const pull = {
    number: 17,
    base: {
      sha: BASE_SHA,
      repo: { id: REPOSITORY_ID, full_name: 'matomo-org/plugin-Example' },
    },
    head: {
      sha: HEAD_SHA,
      repo: { id: REPOSITORY_ID, full_name: 'MATOMO-ORG/plugin-example' },
    },
  };
  return {
    ...pull,
    ...overrides,
    base: { ...pull.base, ...overrides.base },
    head: { ...pull.head, ...overrides.head },
  };
}

function contextFor(pull = pullRequest(), eventName = 'pull_request_target') {
  return {
    eventName,
    repo: { owner: 'Matomo-Org', repo: 'plugin-Example' },
    payload: { pull_request: pull },
  };
}

function fakeCore() {
  const outputs = new Map();
  return {
    outputs,
    setOutput: (name, value) => outputs.set(name, String(value)),
  };
}

function fakeGithub({ livePull = pullRequest(), reviews = [] } = {}) {
  const calls = { get: 0, listReviews: 0 };
  const github = {
    paginate: async (fn, params) => fn(params),
    rest: {
      pulls: {
        get: async () => {
          calls.get += 1;
          return { data: livePull };
        },
        listReviews: async () => {
          calls.listReviews += 1;
          return reviews;
        },
      },
    },
  };
  return { github, calls };
}

test('validateReviewRequest: accepts a current same-repository pull request', async () => {
  const core = fakeCore();
  const { github, calls } = fakeGithub();

  await validateReviewRequest({
    github,
    context: contextFor(),
    core,
    allowedOwners: 'innocraft, matomo-org',
  });

  assert.equal(calls.get, 1);
  assert.equal(calls.listReviews, 1);
  assert.equal(core.outputs.get('base_sha'), BASE_SHA);
  assert.equal(core.outputs.get('head_sha'), HEAD_SHA);
  assert.equal(core.outputs.get('should_inspect'), 'true');
  assert.equal(core.outputs.get('should_run'), 'false');
});

test('validateReviewRequest: requires the trusted event, owner, and immutable SHAs', async () => {
  const { github } = fakeGithub();

  await assert.rejects(
    validateReviewRequest({
      github,
      context: contextFor(pullRequest(), 'pull_request'),
      core: fakeCore(),
      allowedOwners: 'matomo-org',
    }),
    /requires a trusted pull_request_target caller/,
  );
  await assert.rejects(
    validateReviewRequest({
      github,
      context: contextFor(),
      core: fakeCore(),
      allowedOwners: 'someone-else',
    }),
    /restricted to repositories owned by/,
  );
  await assert.rejects(
    validateReviewRequest({
      github,
      context: contextFor(pullRequest({ head: { sha: 'main' } })),
      core: fakeCore(),
      allowedOwners: 'matomo-org',
    }),
    /40-character commit SHAs/,
  );
});

test('same-repository detection uses repository IDs and fails closed when they are missing', () => {
  assert.equal(isSameRepositoryPullRequest(pullRequest()), true);
  assert.equal(isSameRepositoryPullRequest(pullRequest({
    head: { repo: { id: 999, full_name: 'matomo-org/plugin-Example' } },
  })), false);
  assert.equal(isSameRepositoryPullRequest(pullRequest({ head: { repo: {} } })), false);
});

test('validateReviewRequest: skips a fork before making pull-request API calls', async () => {
  const eventPull = pullRequest({
    head: { repo: { id: 999, full_name: 'matomo-org/plugin-Example' } },
  });
  const core = fakeCore();
  const { github, calls } = fakeGithub();

  await validateReviewRequest({
    github,
    context: contextFor(eventPull),
    core,
    allowedOwners: 'matomo-org',
  });

  assert.equal(calls.get, 0);
  assert.equal(core.outputs.get('skip_reason'), 'fork_pull_request');
  assert.equal(core.outputs.get('should_inspect'), 'false');
});

test('validateReviewRequest: rechecks live repository identity and head SHA', async () => {
  const forkCore = fakeCore();
  const { github: forkGithub } = fakeGithub({
    livePull: pullRequest({ head: { repo: { id: 999 } } }),
  });
  await validateReviewRequest({
    github: forkGithub,
    context: contextFor(),
    core: forkCore,
    allowedOwners: 'matomo-org',
  });
  assert.equal(forkCore.outputs.get('skip_reason'), 'fork_pull_request');

  const staleCore = fakeCore();
  const { github: staleGithub } = fakeGithub({
    livePull: pullRequest({ head: { sha: 'c'.repeat(40) } }),
  });
  await validateReviewRequest({
    github: staleGithub,
    context: contextFor(),
    core: staleCore,
    allowedOwners: 'matomo-org',
  });
  assert.equal(staleCore.outputs.get('skip_reason'), 'stale_head');
  assert.match(staleCore.outputs.get('skip_message'), /cccccccccccc/);

  const staleBaseCore = fakeCore();
  const { github: staleBaseGithub } = fakeGithub({
    livePull: pullRequest({ base: { sha: 'd'.repeat(40) } }),
  });
  await validateReviewRequest({
    github: staleBaseGithub,
    context: contextFor(),
    core: staleBaseCore,
    allowedOwners: 'matomo-org',
  });
  assert.equal(staleBaseCore.outputs.get('skip_reason'), 'stale_base');
  assert.match(staleBaseCore.outputs.get('skip_message'), /dddddddddddd/);
});

test('validateReviewRequest: skips a head already covered by the latest Codex review', async () => {
  const reviews = [
    {
      user: { login: 'github-actions[bot]' },
      state: 'COMMENTED',
      body: `${buildCodexReviewHeader(BASE_SHA)}\n## Codex review`,
      commit_id: HEAD_SHA,
      submitted_at: '2026-07-13T10:00:00Z',
    },
    {
      user: { login: 'github-actions[bot]' },
      state: 'CHANGES_REQUESTED',
      body: `<!-- ${CODEX_REVIEW_MARKER} -->`,
      commit_id: 'c'.repeat(40),
      submitted_at: '2026-07-12T10:00:00Z',
    },
  ];
  const core = fakeCore();
  const { github } = fakeGithub({ reviews });

  await validateReviewRequest({
    github,
    context: contextFor(),
    core,
    allowedOwners: 'matomo-org',
  });

  assert.equal(core.outputs.get('skip_reason'), 'no_new_changes');
  assert.equal(core.outputs.get('should_inspect'), 'false');
});

test('validateReviewRequest: does not deduplicate a same-head review from an unknown base', async () => {
  const core = fakeCore();
  const { github } = fakeGithub({
    reviews: [{
      user: { login: 'github-actions[bot]' },
      state: 'COMMENTED',
      body: `<!-- ${CODEX_REVIEW_MARKER} -->\n## Legacy Codex review`,
      commit_id: HEAD_SHA,
      submitted_at: '2026-07-13T10:00:00Z',
    }],
  });

  await validateReviewRequest({
    github,
    context: contextFor(),
    core,
    allowedOwners: 'matomo-org',
  });

  assert.equal(core.outputs.get('skip_reason'), '');
  assert.equal(core.outputs.get('should_inspect'), 'true');
});

function fakeGit(changedFiles, { checkedOutHead = HEAD_SHA } = {}) {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'rev-parse') return `${checkedOutHead}\n`;
    if (args[0] === 'cat-file') return '';
    if (args[0] === 'diff') return `${changedFiles.join('\0')}\0`;
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  };
  return { execFile, calls };
}

test('automation path parsing supports exact files and directory prefixes', () => {
  const paths = parseAutomationPaths('.github/workflow.yml, .github/codex/\nreview/');
  assert.deepEqual(paths, ['.github/workflow.yml', '.github/codex/', 'review/']);
  assert.equal(isAutomationFile('.github/workflow.yml', paths), true);
  assert.equal(isAutomationFile('.github/codex/config.toml', paths), true);
  assert.equal(isAutomationFile('.github/codex-old/config.toml', paths), false);
});

test('inspectFrozenChanges: verifies the snapshot and disables rename detection', () => {
  const core = fakeCore();
  const { execFile, calls } = fakeGit(['src/a.js', 'docs/readme.md']);

  inspectFrozenChanges({
    core,
    checkoutPath: '/tmp/pr-preflight',
    automationPaths: '.github/workflows/codex-review.yml\n.github/codex/',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    execFile,
  });

  const diffCall = calls.find(({ args }) => args[0] === 'diff');
  assert.deepEqual(
    diffCall.args,
    ['diff', '--no-renames', '--name-only', '-z', `${BASE_SHA}...${HEAD_SHA}`, '--'],
  );
  assert.equal(core.outputs.get('changed_files'), JSON.stringify(['src/a.js', 'docs/readme.md']));
  assert.equal(core.outputs.get('should_run'), 'true');
  assert.equal(core.outputs.get('safety_failure'), 'false');
});

test('inspectFrozenChanges: blocks a renamed automation source and safely renders hostile paths', () => {
  const hostilePath = '.github/codex/@security\nreview`config.toml';
  const core = fakeCore();
  // With --no-renames, git emits the deleted source as well as its unguarded destination.
  const { execFile } = fakeGit([hostilePath, 'docs/config.toml']);

  inspectFrozenChanges({
    core,
    checkoutPath: '/tmp/pr-preflight',
    automationPaths: '.github/codex/',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    execFile,
  });

  assert.equal(core.outputs.get('should_run'), 'false');
  assert.equal(core.outputs.get('safety_failure'), 'true');
  assert.match(core.outputs.get('safety_message'), /<U\+000A>/);
  assert.match(core.outputs.get('safety_message'), /@\u200bsecurity/);
  assert.doesNotMatch(core.outputs.get('safety_message'), /@security/);
});

test('inspectFrozenChanges: fails closed when changed-path output exceeds the job-output budget', () => {
  const changedFiles = Array.from(
    { length: 3000 },
    (_, index) => `src/${index}-${'x'.repeat(70)}.js`,
  );
  assert.ok(JSON.stringify(changedFiles).length > MAX_CHANGED_FILES_OUTPUT_LENGTH);
  const core = fakeCore();
  const { execFile } = fakeGit(changedFiles);

  inspectFrozenChanges({
    core,
    checkoutPath: '/tmp/pr-preflight',
    automationPaths: '.github/',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    execFile,
  });

  assert.equal(core.outputs.get('changed_files'), '[]');
  assert.equal(core.outputs.get('should_run'), 'false');
  assert.equal(core.outputs.get('safety_failure'), 'true');
  assert.match(core.outputs.get('safety_message'), /too much changed-path data/);
});

test('inspectFrozenChanges: converts a subprocess buffer overflow into a safety failure', () => {
  const core = fakeCore();
  const { execFile: baseExecFile } = fakeGit([]);
  const execFile = (command, args, options) => {
    if (args[0] === 'diff') {
      throw Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' });
    }
    return baseExecFile(command, args, options);
  };

  assert.doesNotThrow(() => inspectFrozenChanges({
    core,
    checkoutPath: '/tmp/pr-preflight',
    automationPaths: '',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    execFile,
  }));
  assert.equal(core.outputs.get('changed_files'), '[]');
  assert.equal(core.outputs.get('should_run'), 'false');
  assert.equal(core.outputs.get('safety_failure'), 'true');
  assert.match(core.outputs.get('safety_message'), /too much changed-path data/);
});

test('inspectFrozenChanges: rejects a checkout that does not match the frozen head', () => {
  const { execFile } = fakeGit([], { checkedOutHead: 'c'.repeat(40) });
  assert.throws(() => inspectFrozenChanges({
    core: fakeCore(),
    checkoutPath: '/tmp/pr-preflight',
    automationPaths: '',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    execFile,
  }), /expected b{40}/);
});
