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
  pull_request:
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
- Keep GitHub Actions approval for outside collaborators enabled in public repos.
- Ensure only trusted users can apply the `codex-review` label.
- Create the `codex-review` label in each consuming repository.
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

The workflow checks out a pinned read-only Matomo core tree for review context.
This gives the existing `matomo-review` and plugin architecture skills access to
core files and sibling plugins that standalone plugin repositories do not have.

By default the workflow checks out `matomo-org/matomo` at
`84017ed00948fca0db087ea24612723ca8d9df83`. Override `matomo-core-ref` only when
you intentionally want to move that shared context pin.

When a plugin name can be read from `plugin.json`, the workflow also maps the PR
checkout into the core tree at `matomo-core/plugins/<PluginName>` for read-only
inspection. The PR checkout remains the review target, and GitHub inline
comments must use the actual changed paths from the PR diff.

## Security Model

- The caller wrapper runs only for pull request label events where the label is
  `codex-review`.
- The called workflow fails before using the OpenAI key unless the repository
  owner is in the `allowed-owners` input. The default is `matomo-org,innocraft`.
- Trusted scripts are checked out from the shared workflow repository at
  `job.workflow_sha`, not from the caller repository.
- The PR merge ref is checked out with `persist-credentials: false`.
- Codex runs with `sandbox: read-only`, `safety-strategy: drop-sudo`, disabled
  web search, and an environment policy that excludes common secret variables.
- PR-provided agent instructions are treated as PR content, not trusted workflow
  instructions.
- PRs changing reviewer automation paths are skipped and require human review.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `trigger-label` | no | `codex-review` | Pull request label that triggers the review. |
| `allowed-owners` | no | `matomo-org,innocraft` | Comma-separated repository owner allowlist. |
| `automation-paths` | no | `.github/workflows/codex-review.yml`, `.github/codex/` | Caller-repository paths that require human review before Codex runs. Entries ending in `/` match by prefix. |
| `matomo-agent-skills-ref` | no | `main` | Ref of `matomo-org/matomo-agent-skills` to install. |
| `matomo-core-repository` | no | `matomo-org/matomo` | Matomo core repository used for read-only review context. |
| `matomo-core-ref` | no | `84017ed00948fca0db087ea24612723ca8d9df83` | Pinned Matomo core ref used for read-only review context. |
| `plugin-name` | no | read from `plugin.json` | Plugin name used for the optional core-layout mapping. |

## Secrets

| Secret | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | OpenAI API key passed from the consuming repository or organization secret. |

