# Matomo Codex Review Workflow

This repository provides a reusable Codex PR review workflow for Matomo and
InnoCraft-maintained plugin repositories.

Reviews are triggered by adding the `codex-review` label to a pull request. The
called workflow checks the PR diff, runs Codex with the Matomo review skills,
posts a structured GitHub pull request review, uploads diagnostics, and removes
the trigger label after the run.

The workflow implementation lives in
`.github/workflows/codex-review.yml`. The trusted scripts, prompt, and schema
used by that workflow live in this `review/` directory.

## Usage

Add this wrapper workflow to each consuming repository:

```yaml
name: Codex Review

on:
  pull_request_target:
    types: [labeled]

permissions:
  contents: none

jobs:
  codex-review:
    if: ${{ github.event.label.name == 'codex-review' }}
    uses: matomo-org/github-action-tests/.github/workflows/codex-review.yml@main
    permissions:
      actions: read
      contents: read
      issues: write
      pull-requests: write
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Pin `matomo-org/github-action-tests/.github/workflows/codex-review.yml` to a tag
or commit SHA when using this outside early rollout.

## Required Repository Setup

- Configure `OPENAI_API_KEY` as a repository secret or as an organization secret
  scoped to selected repositories.
- Ensure only trusted users can apply the `codex-review` label.
- Create the `codex-review` label in each consuming repository.
- Keep the `pull_request_target` wrapper limited to the reusable-workflow call
  shown above. Do not add steps that check out or execute pull request code.
- Run the workflow on GitHub.com. It relies on the reusable-workflow identity
  fields `job.workflow_repository` and `job.workflow_sha`, which are not
  available on GitHub Enterprise Server.
- Confirm the repository or organization allows the required `GITHUB_TOKEN`
  permissions: `actions: read`, `contents: read`, `issues: write`, and
  `pull-requests: write`.
- Confirm the repository or organization allows the third-party actions used by
  the workflow, including `openai/codex-action`, `actions/checkout`,
  `actions/github-script`, `actions/upload-artifact`, and
  `actions/download-artifact`.

The OpenAI key is always supplied by the consuming repository or organization.
This repository does not provide a central key to callers.

## Core Context

The workflow checks out a read-only Matomo core tree for review context.
This gives the existing `matomo-review` and plugin architecture skills access to
core files and sibling plugins that standalone plugin repositories do not have.

By default the workflow checks out `matomo-org/matomo` at `5.x-dev`, matching
the current Matomo development baseline used by plugin work. The resolved core
commit SHA is written to the uploaded `codex-review-core-context.json`
diagnostics artifact for auditability. Override `matomo-core-ref` when a review
needs a different core branch, tag, or commit.

When a plugin name can be read from `plugin.json`, the workflow also maps the PR
checkout into the core tree at `matomo-core/plugins/<PluginName>` for read-only
inspection. The PR checkout remains the review target, and GitHub inline
comments must use the actual changed paths from the PR diff.

## Security Model

This workflow runs an autonomous AI agent (Codex) over pull request content. The
design treats **everything in the PR as untrusted** — the diff, commit messages,
the PR title and body, `plugin.json`, and any `AGENTS.md`/`.codex`-style agent
instruction files. It assumes an attacker may open a PR (or push a branch) for
the sole purpose of making the reviewer leak a secret or take an unwanted action.

The design does not rely on a single control: the two secrets in play
(`OPENAI_API_KEY` and the `GITHUB_TOKEN`) are separated from the agent by
several independent layers, and the agent runs sandboxed and read-only. The
controls below are grouped by the risk they address.

### Who can trigger a review

- The caller wrapper runs **only** on trusted `pull_request_target` `labeled`
  events where the label is `codex-review`, so an ordinary push never starts a
  review. The wrapper itself never checks out or executes pull request code.
- Applying that label is the trust decision. Restrict who can label PRs in each
  consuming repository (see *Required Repository Setup*).
- The called workflow refuses to use the OpenAI key unless the caller repository
  owner is in `allowed-owners` (default `matomo-org,innocraft`). This prevents
  accidental use by repositories outside the intended organizations.
- **Fork PRs are skipped before any PR checkout or Codex step.** The trusted
  `pull_request_target` context lets the posting and cleanup jobs explain the
  skip and remove the trigger label, while preflight compares immutable numeric
  base/head repository IDs before fork code reaches the runner. Missing or
  mismatched IDs fail closed. This means untrusted contributor code only reaches
  Codex after a maintainer with label rights has pulled it into a branch of the
  repository itself.

### The agent runs trusted code against an untrusted target

- The preflight module, review scripts, prompt, and JSON schema are checked out
  from **this** shared workflow repository at `job.workflow_sha` (the pinned
  trusted commit), never from the caller/PR. A PR that edits `review/*` cannot
  change what actually executes, and the security-sensitive preflight logic is
  covered by the same Node test suite as review posting.
- External GitHub Actions used by the trusted workflow are pinned by full commit
  SHA so tag retargeting cannot silently change what privileged jobs execute.
- The event's exact PR head SHA is checked out into a separate `pr/` directory
  that is only ever the *target* of read-only inspection. It is not a source of
  executable workflow logic.
- Preflight confirms the live PR repository identity, base, and head still match
  the labeled event, derives changed paths from that frozen base/head diff, and
  passes the same SHAs to checkout, the prompt, and review posting. Posting
  checks both SHAs again and supplies GitHub's head `commit_id`, so a later head
  push or base-branch advance cannot be presented as reviewed by an earlier run.
- Every posted review carries a trusted hidden base-SHA marker. A prior review
  suppresses a duplicate run only when both its head commit and recorded base
  commit match the newly labeled snapshot; legacy or malformed markers default
  to a fresh review.
- As defense in depth, a PR that touches reviewer automation paths
  (`.github/workflows/codex-review.yml`, `.github/codex/`, configurable via
  `automation-paths`) is skipped and flagged for human review first. Preflight
  uses `git diff --no-renames`, so renaming a guarded file out of a guarded path
  still reports and blocks the deleted source path.
- Changed-path JSON is bounded before it becomes a job output. An exceptionally
  large path list fails closed instead of overflowing GitHub's output channel or
  being truncated into an incomplete review scope.
- The plugin name read from the untrusted `plugin.json` is validated against
  `^[A-Za-z0-9_]+$` before it is used in a filesystem path or written to a step
  output, preventing path traversal and step-output injection.

### Secrets never reach the agent

- The workflow token defaults to `permissions: contents: none`, and each job
  requests only what it needs. The Codex job holds **`contents: read` only** — it
  cannot write code, comments, or labels.
- Every checkout, including the PR, uses `persist-credentials: false`, so no
  `GITHUB_TOKEN` is left in `pr/.git/config` for the agent to harvest.
- The frozen PR checkout uses `fetch-depth: 0`, so the base commit needed for
  the explicit SHA diff is present without a later authenticated fetch. After
  checkout, the working tree Codex reads contains no credential material.
- Codex's shell runs under an environment policy that strips secret-bearing
  variables (`*KEY*`, `*SECRET*`, `*TOKEN*`, `GITHUB_*`, `ACTIONS_*`, `OPENAI_*`,
  `CODEX_*`). Even a prompt-injected command cannot echo the OpenAI key or the
  GitHub token out of the environment.
- `OPENAI_API_KEY` is consumed only by the `openai/codex-action` step (pinned by
  commit SHA) and is always supplied by the consuming repo/org — this repository
  ships no central key.

### The agent is sandboxed

- Codex runs with `sandbox: read-only` (it cannot modify the checkout or the
  runner), `safety-strategy: drop-sudo` (no privilege escalation), `web_search`
  disabled (no exfiltration channel or untrusted fetches), and
  `project_doc_max_bytes = 0` (PR-provided project docs are not auto-loaded as
  instructions).

### Prompt-injection resistance

- The prompt establishes an explicit trust policy: the workflow prompt and the
  skills installed from the trusted `matomo-org/matomo-agent-skills` repository
  are authoritative, and PR-provided `AGENTS.md`/`.codex`/`.agents/skills` files
  are to be treated as reviewed content only — never as instructions, and never
  executed.
- PR title and body are injected into the prompt with a single-pass template
  render, so untrusted values cannot re-trigger substitution to smuggle in new
  placeholders.

### Review and posting are separated

- Codex (read-only, untrusted-input-facing) only emits a structured JSON file
  validated against `review-output.schema.json`.
- A **separate** `post-review` job — which never runs Codex — holds the
  `issues: write` / `pull-requests: write` permissions and turns that validated
  output into the GitHub review. The component that writes to the PR is not the
  component exposed to untrusted input.
- Posting revalidates every required property and rejects unknown properties,
  non-regular files, files outside the downloaded artifact directory, and
  output larger than 1 MiB before parsing or making a review mutation.
- Model-authored GitHub user/team mentions are neutralized before public
  posting. Untrusted filenames and rule names are rendered as bounded code spans
  with control and direction-changing characters made visible.
- Public review bodies are capped at 60,000 characters. Findings that do not fit
  remain available in the seven-day `codex-review-output` diagnostics artifact.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `trigger-label` | no | `codex-review` | Pull request label that triggers the review. |
| `allowed-owners` | no | `matomo-org,innocraft` | Comma-separated repository owner allowlist. |
| `automation-paths` | no | `.github/workflows/codex-review.yml`, `.github/codex/` | Caller-repository paths that require human review before Codex runs. Entries ending in `/` match by prefix. |
| `matomo-agent-skills-ref` | no | `main` | Ref of `matomo-org/matomo-agent-skills` to install. |
| `matomo-core-repository` | no | `matomo-org/matomo` | Matomo core repository used for read-only review context. |
| `matomo-core-ref` | no | `5.x-dev` | Matomo core ref used for read-only review context. |
| `plugin-name` | no | read from `plugin.json` | Plugin name used for the optional core-layout mapping. |
| `codex-model` | no | `gpt-5.6-sol` | OpenAI model passed to `openai/codex-action`. Override only to move off the default. |
| `codex-effort` | no | `xhigh` | Reasoning effort passed to `openai/codex-action` (`minimal`, `low`, `medium`, `high`, or `xhigh`). |

## Secrets

| Secret | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | OpenAI API key passed from the consuming repository or organization secret. |

## Local Validation

Run the dependency-free Node test suite after changing the workflow, prompt,
schema, or trusted review scripts:

```bash
npm test
```

CI runs the same suite on Node.js 22. The tests include cross-file workflow and
documentation invariants in addition to preflight, rendering, schema, and
posting edge cases.
