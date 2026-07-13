# Agent Task Reusable Workflow

WP Codebox publishes a reusable GitHub Actions workflow for generic agent tasks:

```yaml
jobs:
  run-agent-task:
    uses: Automattic/wp-codebox/.github/workflows/run-agent-task.yml@main
    with:
      agent_bundle: bundles/example-agent
      workload_id: example-maintenance
      workload_label: Run example maintenance
      component_id: example-ci-driver
      target_repo: Automattic/example-target
      prompt: Refresh the configured surface from source evidence.
      writable_paths: README.md,docs/**
      runner_workspace: |
        {
          "enabled": true,
          "repo": "Automattic/example-target",
          "clone_url": "https://github.com/Automattic/example-target.git",
          "branch_prefix": "agent/example-run",
          "from": "origin/main"
        }
      verification_commands: '[{"command":"npm test","description":"Run checks"}]'
      drift_checks: '[]'
      output_projections: '{"pr_url":"metadata.runner_workspace_publication.url"}'
      access_token_repos: Automattic/example-target
      require_access_token: true
      expected_artifacts: '["agent_transcript","agent_change_summary"]'
      artifact_declarations: |
        [
          {
            "schema": "wp-codebox/artifact-declaration/v1",
            "name": "agent_transcript",
            "type": "AgentTranscript",
            "artifact_schema": "agent/transcript/v1",
            "description": "Machine-readable transcript for the agent task.",
            "required": false,
            "egress": ["artifact", "workflow-output", "review-link"]
          },
          {
            "schema": "wp-codebox/artifact-declaration/v1",
            "name": "agent_change_summary",
            "type": "AgentChangeSummary",
            "artifact_schema": "agent/change-summary/v1",
            "description": "Reviewable summary of changes made by the run.",
            "required": false,
            "egress": ["pr-body", "workflow-output", "review-link"]
          }
        ]
    secrets: inherit
```

Consumers provide product-level task inputs: the agent bundle, target repository,
workspace publication request, verification commands, drift checks, artifact
expectations, typed artifact declarations, and output projection. The workflow
returns stable run outputs; implementation-specific runtime wiring, workspace
adapters, plugins, and model setup stay behind the WP Codebox boundary.

## Runner Recipe

`runner_recipe` is a temporary optional input while callers transition away from
the runner-recipe contract. It may be omitted only for an explicit
`run_agent: false` skipped result or `dry_run: true` dry-run result. A live
`run_agent: true` request without a recipe fails closed until the executable
[wp-codebox#1751](https://github.com/Automattic/wp-codebox/pull/1751) workflow
lands. Merge the transition in this order: this bridge, Docs Agent caller cleanup
([docs-agent#119](https://github.com/Automattic/docs-agent/pull/119)), then #1751,
which deletes this input.

## Inputs

- `runner_recipe`: optional temporary runner recipe descriptor; removed by #1751 after Docs Agent caller cleanup.
- `agent_bundle`: selected agent bundle path in the product repository.
- `workload_id`, `workload_label`, and `component_id`: caller-owned run labels.
- `target_repo`: `OWNER/REPO` target repository.
- `prompt`: task instruction supplied to the agent bundle.
- `writable_paths`: comma-separated repository paths the agent may edit.
- `runner_workspace`: JSON workspace publication request.
- `validation_dependencies`, `verification_commands`, and `drift_checks`: runner-owned validation inputs.
- `access_token_repos`: comma-separated repositories for access-token scoping.
- `require_access_token`: require the configured access token for the run.
- `artifact_declarations` and `expected_artifacts`: typed review artifact contract.
- `output_projections`: JSON object mapping workflow output names to result paths.
- `run_agent`: set to `false` to record a skipped run.
- `provider` and `model`: model selection for the recipe owner.
- `dry_run`: validates the runner request without a live agent call.

## Outputs

- `job_status`: normalized terminal status.
- `transcript_json`: transcript artifact path when available.
- `transcript_summary`: short transcript label when available.
- `engine_data_json`: projected recipe outputs as one JSON object.
- `credential_mode`: credential source selected for the run.
- `declared_artifacts_json`: typed artifact declarations accepted for the run.

The workflow is intentionally product-input-first. Consumers should model new
behavior as workflow inputs instead of depending on worker filesystem paths,
runtime internals, package internals, or the private implementation that
executes the task.
