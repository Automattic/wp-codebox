# Docs Agent Reusable Workflow

WP Codebox publishes a reusable GitHub Actions workflow for product-level agent
tasks, including Docs Agent runs:

```yaml
jobs:
  update-docs:
    uses: Automattic/wp-codebox/.github/workflows/run-agent-task.yml@main
    with:
      runner_recipe: Automattic/docs-agent@main:ci/docs-agent-runner-recipe.json
      agent_bundle: bundles/technical-docs-agent
      workload_id: technical-docs-maintenance-flow
      workload_label: Run technical Docs Agent
      component_id: docs-agent-ci-driver
      target_repo: Automattic/example-target
      prompt: Refresh the API docs for changed files.
      writable_paths: README.md,docs/**
      runner_workspace: |
        {
          "enabled": true,
          "repo": "Automattic/example-target",
          "clone_url": "https://github.com/Automattic/example-target.git",
          "branch_prefix": "docs/agent-run",
          "from": "origin/main"
        }
      verification_commands: '[{"command":"npm test","description":"Run docs checks"}]'
      drift_checks: '[]'
      output_projections: '{"docs_pr_url":"metadata.engine_data.docs_agent.pr_url"}'
      expected_artifacts: '["docs_agent_transcript","docs_agent_change_summary"]'
      artifact_declarations: |
        [
          {
            "schema": "wp-codebox/artifact-declaration/v1",
            "name": "docs_agent_transcript",
            "type": "DocsAgentTranscript",
            "artifact_schema": "docs-agent/transcript/v1",
            "description": "Machine-readable transcript for the Docs Agent run.",
            "required": false,
            "egress": ["artifact", "workflow-output", "review-link"]
          },
          {
            "schema": "wp-codebox/artifact-declaration/v1",
            "name": "docs_agent_change_summary",
            "type": "DocsAgentChangeSummary",
            "artifact_schema": "docs-agent/change-summary/v1",
            "description": "Reviewable summary of documentation changes.",
            "required": false,
            "egress": ["pr-body", "workflow-output", "review-link"]
          }
        ]
    secrets: inherit
```

Consumers provide product-level task inputs: the selected runner recipe, agent
bundle, target repository, workspace publication request, verification commands,
drift checks, artifact expectations, typed artifact declarations, and output
projection. The workflow returns stable run outputs; implementation-specific
runtime wiring, workspace adapters, plugins, and model setup stay behind the WP
Codebox boundary.

## Runner Recipe

`runner_recipe` is a descriptor for a committed runner recipe, such as
`Automattic/docs-agent@main:ci/docs-agent-runner-recipe.json`. The recipe stays
owned by the product workflow. Consumers pass the descriptor and the selected
`agent_bundle`; they do not pass worker filesystem paths, runtime substrate
checkout rules, package internals, or private workflow names.

```json
{
  "id": "docs-agent/codebox-homeboy-runner",
  "description": "Docs Agent product-level Codebox runner contract.",
  "runtime": "wp-codebox",
  "profile": "docs-agent-runner"
}
```

## Inputs

- `runner_recipe`: committed runner recipe descriptor.
- `agent_bundle`: selected agent bundle path in the product repository.
- `workload_id`, `workload_label`, and `component_id`: caller-owned run labels.
- `target_repo`: `OWNER/REPO` target repository.
- `prompt`: task instruction supplied to the agent bundle.
- `writable_paths`: comma-separated repository paths the agent may edit.
- `runner_workspace`: JSON workspace publication request.
- `validation_dependencies`, `verification_commands`, and `drift_checks`: runner-owned validation inputs.
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
behavior as runner recipe fields or workflow inputs instead of depending on
worker filesystem paths, runtime internals, package internals, or the private
implementation that executes the task.
