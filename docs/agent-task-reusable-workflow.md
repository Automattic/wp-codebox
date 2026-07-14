# Agent Task Reusable Workflow

WP Codebox publishes a reusable GitHub Actions workflow for generic agent tasks:

```yaml
jobs:
  run-agent-task:
    uses: Automattic/wp-codebox/.github/workflows/run-agent-task.yml@v0.12.3
    with:
      wp_codebox_release_ref: v0.12.3
      external_package_source: '{"repository":"OWNER/agent-packages","revision":"0123456789abcdef0123456789abcdef01234567","path":"agents/example.agent.json","digest":"sha256-bytes-v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
      target_repo: Automattic/example-target
      prompt: Refresh the configured surface from source evidence.
      writable_paths: README.md,docs/**
      runner_workspace: '{"enabled":true,"repo":"Automattic/example-target"}'
      validation_dependencies: npm ci
      verification_commands: '[{"command":"npm test","description":"Run checks"}]'
      drift_checks: '["git diff --exit-code"]'
      success_requires_pr: true
      access_token_repos: Automattic/example-target
      allowed_repos: '["Automattic/example-target"]'
      output_projections: '{"pr_url":"outputs.artifact_result.result.outputs.runner_workspace_publication.pull_request.url"}'
    secrets:
      EXTERNAL_PACKAGE_SOURCE_POLICY: ${{ secrets.EXTERNAL_PACKAGE_SOURCE_POLICY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

The workflow checks out the target workspace, fetches and imports the selected
public native package, invokes the package-declared agent through the native chat path, runs declared commands
in a credential-free verification environment, and returns actual runtime and
publication data.

## Helper Release Tag

Callers must invoke the reusable workflow from an exact WP Codebox release tag
and pass that same tag as `wp_codebox_release_ref`. For example, callers use
`Automattic/wp-codebox/.github/workflows/run-agent-task.yml@v0.12.3` together
with `wp_codebox_release_ref: v0.12.3`. The accepted format is exactly
`vX.Y.Z`; branches, commit SHAs, moving major tags, prereleases, and arbitrary
refs are rejected.

The workflow requires `wp_codebox_release_ref` to be an exact release tag. It
always checks helpers out from `Automattic/wp-codebox`, verifies the checked-out
commit equals the remote release tag commit, and verifies the checked-out
`package.json` version equals the requested tag without its `v` prefix. The
caller cannot select a different helper repository. GitHub nested workflows
expose the caller's `github.workflow_ref`, and the running workflow cannot
introspect its own `uses:` ref, so helper selection relies on the required input
and verified checkout rather than that caller context.

This release-coherence contract fixes [#1759](https://github.com/Automattic/wp-codebox/issues/1759).

## Inputs

- `wp_codebox_release_ref`: required exact immutable WP Codebox release tag in `vX.Y.Z` form.
- `external_package_source`: immutable descriptor with `repository`, full commit `revision`, one package-relative `.agent.json` `path`, and `digest`. Packages are supported only from publicly accessible GitHub repositories, fetched from canonical `https://github.com/OWNER/REPOSITORY.git` without credentials. `digest` is exactly `sha256-bytes-v1:<lowercase-sha256>` over the raw file bytes; filenames and JSON content are UTF-8-safe and are not normalized before hashing.
- `EXTERNAL_PACKAGE_SOURCE_POLICY`: required reusable-workflow secret, supplied by the caller's operator-controlled secret configuration. Its strict version 1 JSON shape is `{"version":1,"repositories":{"owner/repository":["agents/example.agent.json"]}}`. Every entry is an exact standalone `.agent.json` path. The policy is validated in runner memory, is never part of task input, and is not uploaded.
- `target_repo`: `OWNER/REPO` target repository.
- `prompt`, `writable_paths`, provider/model, `max_turns`, `time_budget_ms`, callback data, and artifact declarations: native task inputs.
- `runner_workspace`: JSON runner-workspace publication request owned by the package.
- `validation_dependencies`: optional shell command that installs validation dependencies in the target workspace.
- `verification_commands` and `drift_checks`: JSON arrays of non-empty command strings or `{command, description}` objects. Every entry runs and must pass.
- `success_requires_pr`: require a successful, published runner-workspace pull request for `target_repo`.
- `access_token_repos`: comma-separated repositories available to the supplied access token.
- `allowed_repos`: JSON repository allowlist. It and `access_token_repos` must explicitly include `target_repo`.
- `output_projections`: JSON object mapping output names to dot-delimited paths in the native result. Every projection must resolve.

## Access And Publication

For a target equal to the caller repository, the workflow passes the caller's
built-in `github.token` as `GITHUB_TOKEN` to native agent execution. An
`ACCESS_TOKEN` secret is not required in that case. For a target in another
repository, `ACCESS_TOKEN` is required explicitly and must be scoped by both
`access_token_repos` and `allowed_repos`. The caller token is never inferred to
have cross-repository access. The effective token is not serialized into task
input, result, or artifact data. GitHub runner tools
receive the normalized `allowed_repos` policy explicitly through the runtime and
fail closed for every PR, issue, and comment operation outside that set. The
checkout does not persist credentials. Verification, dependency, and drift
commands run with a clean environment that excludes provider and GitHub secrets.
Known secret values are redacted before result or artifact persistence; captured
stdout/stderr is capped at 32 KiB and workflow outputs at 8 KiB.

`EXTERNAL_PACKAGE_SOURCE_POLICY` is treated as a secret even when it contains
only repository and path metadata. It is redacted from runner output, excluded
from task requests, runtime input, results, and upload artifacts, and is never
passed to the agent. The selected descriptor is authorized against this policy
both before persistence and immediately before host materialization.

The source fetch receives no repository, publication, provider, or GitHub token.
Public package bytes are verified against the immutable descriptor, encoded in
the normal in-memory runtime recipe, and decoded inside Playground. The runtime
re-hashes raw bytes, validates the canonical flat package contract
(`schema_version: 1`, `bundle_slug`, and exactly one authoritative
`agent.agent_slug`), canonically imports it, verifies
that exact slug registered, and passes it explicitly as the `agent` input to
`agents/chat`. The descriptor and caller cannot select a different identity.
Only `{slug}` is carried in task metadata. The importer-only temporary
`.agent.json` is removed in a `try/finally` before resolving agent tools. No
package file is mounted into or visible from the agent workspace.

## Runtime Coverage

The repository's native-loop and PHP runtime-package tests execute generated
PHP with narrow WordPress and native agent-registry
shims. They prove digest-then-schema validation, canonical import, exact slug
resolution, `agents/chat` selection, invocation order, and temporary-file
cleanup. They are not a WordPress Playground end-to-end test: this repository
does not provide a fixture that boots both the agent-registry plugin and a real
provider-backed chat turn in Playground. The existing Playground CLI tests use
injected CLI modules and do not exercise that plugin/provider path.

To run the optional cross-repository package coverage, use a Docs Agent checkout
pinned to commit `3da1b8076359db9bf9f4ee7dadcc3932c080ed71`, which contains
`technical-docs-maintenance-agent.agent.json`:

```sh
DOCS_AGENT_DIR=/path/to/docs-agent npm run test:external-native-package-materialization
DOCS_AGENT_DIR=/path/to/docs-agent npm run test:agent-no-data-machine-loop
```

When `success_requires_pr` is true, success requires the canonical
`wp-codebox/runner-workspace-publication-result/v1` result with `success: true`,
`status: published`, and a GitHub pull-request URL for `target_repo`.
WP Codebox then resolves that pull request through the GitHub API with the
runner token, so a fabricated publication result cannot satisfy the gate.

## Outputs

- `job_status`: normalized terminal status.
- `transcript_json`: transcript artifact references when available.
- `transcript_summary`: short transcript label.
- `engine_data_json`: actual runtime output object.
- `projected_outputs_json`: evaluated values from `output_projections`.
- `credential_mode`: redacted credential source classification.
- `declared_artifacts_json`: accepted typed artifact declarations.

The result artifact includes the executable task input, normalized runtime
result, evaluated projections, verification records, and runner-owned
publication result. Runtime input, result, and diagnostics are uploaded from
`workspace/.codebox/` with `if: always()`, including execution failures. A request
artifact alone is not a successful task result.

## Interface Contract

[`contracts/run-agent-task-reusable-workflow-interface.v1.json`](../contracts/run-agent-task-reusable-workflow-interface.v1.json)
is the producer-owned, machine-readable `wp-codebox/reusable-workflow-interface/v1`
fixture. It records every declared input's required/type/default behavior, every
secret's required behavior, and every workflow output expression.

The offline validator reads only the checkout's fixture and
`.github/workflows/run-agent-task.yml`; it makes no network calls. External
consumers can contract-test a checked-out version with:

```sh
WP_CODEBOX_DIR=/path/to/wp-codebox npm --prefix /path/to/wp-codebox run test:agent-task-workflow-interface
```

Update the workflow declaration and fixture together when intentionally changing
this interface. The contract test rejects either addition, removal, or changed
input, secret, or output expectation.

## Compatibility

This public-only v1 interface removes support for confidential or private package
bytes and removes the previously exposed `external_package_allowed_repositories`,
`external_package_allowed_paths`, `runner_recipe`, `context_repositories`,
`workspace_contract_checks`, `actions_artifact_downloads`,
`success_completion_outcomes`, `step_budget`, and `tool_results_key` inputs.
They were serialized without a generic WP Codebox execution primitive, so
retaining them would have presented inert data as a supported contract. Callers
must migrate checks to executable `validation_dependencies`,
`verification_commands`, or `drift_checks`; context and artifact preparation
remain caller-workflow responsibilities. This is an intentional exposed-workflow breaking change.

`wp_codebox_release_ref` is a required v1 input. Existing callers must switch
their `uses:` reference from a branch or other ref to an exact release tag and
pass that exact release tag through this input. Consumer contract tests can
compare both values where the caller workflow is available; the reusable
workflow itself cannot inspect the caller's `uses:` declaration at runtime.

## Upload safety limits

The reusable workflow stages every uploaded file through a fail-closed policy. Only regular UTF-8 files of 4 MiB or less are uploaded, after configured secret values are redacted. Symlinks, special files, binary files, and files larger than 4 MiB are excluded from the upload staging directory. This applies to task artifacts and workflow request, input, and result files.

Native task execution, validation-dependency installation, verification, drift checks, and GitHub pull-request validation retain at most 32 KiB from each stdout and stderr stream while continuing to drain both streams. Command results expose `stdout_truncated` and `stderr_truncated` when retained output is incomplete. Native `agent-task-run` structured output is instead read from a controlled `.codebox/native-agent-task-result.json` file outside the agent-writable target checkout. The executor accepts only a regular, non-symlink JSON file up to 1 MiB with the required result schemas, rejects configured secret values, redacts the accepted record before persistence, and removes the transient native result file after reading it.
