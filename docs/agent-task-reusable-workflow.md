# Agent Task Reusable Workflow

WP Codebox publishes a reusable GitHub Actions workflow for generic agent tasks:

```yaml
jobs:
  run-agent-task:
    uses: Automattic/wp-codebox/.github/workflows/run-agent-task.yml@main
    with:
      agent_bundle: bundles/example-agent
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
      require_access_token: true
      output_projections: '{"pr_url":"outputs.artifact_result.result.outputs.runner_workspace_publication.pull_request.url"}'
    secrets: inherit
```

The workflow checks out the target workspace, imports the selected native
package, invokes it through the default native chat path, runs declared commands
in a credential-free verification environment, and returns actual runtime and
publication data.

## Inputs

- `agent_bundle`: selected agent bundle path in the target repository.
- `target_repo`: `OWNER/REPO` target repository.
- `prompt`, `writable_paths`, provider/model, `max_turns`, `time_budget_ms`, callback data, and artifact declarations: native task inputs.
- `runner_workspace`: JSON runner-workspace publication request owned by the package.
- `validation_dependencies`: optional shell command that installs validation dependencies in the target workspace.
- `verification_commands` and `drift_checks`: JSON arrays of non-empty command strings or `{command, description}` objects. Every entry runs and must pass.
- `success_requires_pr`: require a successful, published runner-workspace pull request for `target_repo`.
- `access_token_repos`: comma-separated repositories available to the supplied access token.
- `allowed_repos`: JSON repository allowlist. It and `access_token_repos` must explicitly include `target_repo`.
- `require_access_token`: require the reusable workflow's `ACCESS_TOKEN` secret.
- `output_projections`: JSON object mapping output names to dot-delimited paths in the native result. Every projection must resolve.

## Access And Publication

`ACCESS_TOKEN` is passed only as `GITHUB_TOKEN` to native agent execution and is
not serialized into task input, result, or artifact data. GitHub runner tools
receive the normalized `allowed_repos` policy explicitly through the runtime and
fail closed for every PR, issue, and comment operation outside that set. The
checkout does not persist credentials. Verification, dependency, and drift
commands run with a clean environment that excludes provider and GitHub secrets.
Known secret values are redacted before result or artifact persistence; captured
stdout/stderr is capped at 32 KiB and workflow outputs at 8 KiB.

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

This removes the previously exposed `runner_recipe`, `context_repositories`,
`workspace_contract_checks`, `actions_artifact_downloads`,
`success_completion_outcomes`, `step_budget`, and `tool_results_key` inputs.
They were serialized without a generic WP Codebox execution primitive, so
retaining them would have presented inert data as a supported contract. Callers
must migrate checks to executable `validation_dependencies`,
`verification_commands`, or `drift_checks`; context and artifact preparation
remain caller-workflow responsibilities. This is an intentional exposed-workflow breaking change.

## Upload safety limits

The reusable workflow stages every uploaded file through a fail-closed policy. Only regular UTF-8 files of 4 MiB or less are uploaded, after configured secret values are redacted. Symlinks, special files, binary files, and files larger than 4 MiB are excluded from the upload staging directory. This applies to task artifacts and workflow request, input, and result files.

Native task execution, validation-dependency installation, verification, drift checks, and GitHub pull-request validation retain at most 32 KiB from each stdout and stderr stream while continuing to drain both streams. Command results expose `stdout_truncated` and `stderr_truncated` when retained output is incomplete.
