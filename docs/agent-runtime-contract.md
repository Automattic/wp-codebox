# Agent Runtime Contract

WP Codebox exposes a stable, product-neutral sandbox runtime boundary. External orchestrators own queues, retries, promotion, review policy, runner placement, and durable job history. WP Codebox owns disposable WordPress Playground execution, runtime-stack mounting, bounded command execution, artifact capture, and the schemas listed here.

## Entry Point

The stable orchestrator-facing CLI entry point is:

```bash
wp-codebox agent-task-run --input-file=/path/to/request.json --json
```

The command reads one JSON request from `--input-file`, writes a single JSON envelope to stdout, and exits non-zero when the normalized result is not successful. Orchestrators should treat stdout JSON as the contract and stderr as diagnostic text only.

Direct `wp-codebox agent-sandbox-run` remains an operator/debug command. Product orchestrators should call `agent-task-run` or the parent-site `wp-codebox/run-agent-task` ability so WP Codebox can build the private recipe, capture artifacts, normalize no-op/failure evidence, and clean up temporary recipe files.

## Input Boundary

`request.json` uses the task input contract plus agent runtime placement fields:

```json
{
  "schema": "wp-codebox/task-input/v1",
  "goal": "Fix the failing audit finding and return a reviewable artifact.",
  "target": { "kind": "repo", "ref": "Automattic/wp-codebox" },
  "allowed_tools": ["workspace.read", "workspace.write", "tests.run"],
  "expected_artifacts": ["patch", "review", "tests"],
  "provider": "example-ai",
  "model": "example-model",
  "provider_plugin_paths": ["/srv/runtime/ai-provider-example"],
  "component_contracts": [
    { "slug": "agents-api", "path": "/srv/runtime/agents-api", "pluginFile": "agents-api/agents-api.php", "loadAs": "mu-plugin" },
    { "slug": "caller-runtime", "path": "/srv/runtime/caller-runtime", "pluginFile": "caller-runtime/caller-runtime.php", "loadAs": "mu-plugin" },
    { "slug": "caller-runtime-tools", "path": "/srv/runtime/caller-runtime-tools", "pluginFile": "caller-runtime-tools/caller-runtime-tools.php", "loadAs": "mu-plugin" }
  ],
  "runtime_stack_mounts": [
    { "source": "/srv/runtime/agents-api", "target": "/runtime/agents-api", "mode": "readonly" }
  ],
  "runtime_overlays": [
    {
      "kind": "bundled-library",
      "library": "php-ai-client",
      "source": "/srv/runtime/php-ai-client",
      "strategy": "wordpress-scoped-bundle"
    }
  ],
  "secret_env": ["EXAMPLE_AI_API_KEY"],
  "workspaces": [
    {
      "target": "/wordpress/wp-content/plugins/example",
      "mode": "readwrite",
      "sourceMode": "repo-backed",
      "seed": { "type": "directory", "source": "/srv/worktrees/example" }
    }
  ],
  "sandbox_tool_policy": {
    "schema": "wp-codebox/sandbox-tool-policy/v1",
    "version": 1,
    "tools": []
  },
  "task_timeout_seconds": 3600,
  "max_turns": 8,
  "sandbox_session_id": "agent-task-123",
  "artifacts_path": "/srv/artifacts/agent-task-123",
  "policy": { "applyBack": "reviewed" },
  "context": { "issue": "https://github.com/Automattic/wp-codebox/issues/1035" },
  "orchestrator": {
    "type": "external",
    "id": "agent-task",
    "job_id": "job-123"
  }
}
```

Stable fields exported from runtime-core:

- `wp-codebox/task-input/v1` normalizes `goal`, `target`, `allowed_tools`, `expected_artifacts`, `structured_artifacts`, `agent_bundles`, `sandbox_tool_policy`, `policy`, and `context`.
- `provider`, `model`, `provider_plugin_paths`, `component_contracts`, `runtime_stack_mounts`, `runtime_overlays`, `runtime_env`, `secret_env`, `workspaces`, `mounts`, `verify_steps`, `agent_bundles`, `session_id`, `sandbox_session_id`, `artifacts_path`, `wp`, `task_timeout_seconds`, and `max_turns` are accepted by the reusable agent-task recipe builder.
- `secret_env` contains environment variable names only. Secret values stay in the orchestrator environment and are not accepted in JSON payloads.

WP Codebox rejects product ability paths that pass raw `code` or `code_file`. Debug-only PHP runner overrides are limited to direct CLI operator commands.

## Output Boundary

`agent-task-run --json` returns `wp-codebox/agent-task-run/v1`:

```json
{
  "success": true,
  "schema": "wp-codebox/agent-task-run/v1",
  "status": "completed",
  "session": {
    "schema": "wp-codebox/sandbox-session/v1",
    "id": "agent-task-123",
    "status": "completed",
    "persistence": "external-orchestrator"
  },
  "task_input": {
    "schema": "wp-codebox/task-input/v1",
    "version": 1,
    "goal": "Fix the failing audit finding and return a reviewable artifact."
  },
  "agent_result": {
    "schema": "wp-codebox/agent-result/v1",
    "status": "completed"
  },
  "completion_outcome": {
    "schema": "wp-codebox/sandbox-completion-outcome/v1",
    "status": "succeeded"
  },
  "agent_task_result": {
    "schema": "wp-codebox/agent-task-result/v1",
    "success": true,
    "status": "completed",
    "outputs": {},
    "structured_artifacts": [],
    "diagnostics": {},
    "raw": {}
  },
  "run_metadata": {
    "run_id": "run_...",
    "run_status": "succeeded",
    "runtime_id": "runtime-...",
    "runtime_status": "destroyed",
    "sandbox_session_id": "agent-task-123"
  },
  "evidence_refs": [],
  "diagnostics": [],
  "run": {}
}
```

`agent_task_result` is the sandbox semantic result `wp-codebox/agent-task-result/v1`. Orchestrators should normalize the full `agent-task-run` envelope with `normalizeAgentTaskRunResult()` from `@automattic/wp-codebox-core` or `wp-codebox-workspace/core`. The normalized `wp-codebox/agent-task-run-result/v1` groups stable artifact refs into `artifact_bundles`, `changed_files`, `patches`, `transcripts`, `logs`, and `runtimes`, and classifies terminal statuses including `succeeded`, `failed`, `no_op`, `timeout`, `provider_error`, and `unable_to_remediate`.

Failed `agent-task-run` responses include `wp-codebox/agent-task-run-failure-evidence/v1` in `failure_evidence` when available. This block is safe for orchestrators to persist with job failure records and includes phase, command, exit code, redacted stdout/stderr snippets, runtime and sandbox identifiers, artifact references, diagnostics, and serialized error data.

## Artifact Contract

The stable artifact bundle is the directory selected by `artifacts_path` or a temporary WP Codebox artifact directory when omitted. Current stable paths are:

- `manifest.json`: content-addressed artifact index.
- `metadata.json`: runtime, policy, mount, task, agent, and provenance metadata.
- `events.jsonl`, `commands.jsonl`, `observations.jsonl`: runtime evidence streams.
- `logs/runtime.log` and `logs/commands.log`: human-readable logs.
- `files/changed-files.json`: canonical changed-files manifest.
- `files/patch.diff`: canonical combined text patch for review/apply-back.
- `files/test-results.json`: normalized test-results artifact, with `status: "unknown"` when no structured test command ran.
- `files/review.json`: frontend/reviewer summary derived from canonical artifacts.
- `files/completion-outcome.json`: `wp-codebox/sandbox-completion-outcome/v1`.
- `files/agent-result.json`: `wp-codebox/agent-result/v1`.
- `files/agent-task-result.json`: `wp-codebox/agent-task-result/v1` when the sandbox runtime emits semantic task outputs.
- `files/transcript.json`: `wp-codebox/agent-transcript/v1`.
- `files/runtime-evidence/tool-calls/transcript.json`: optional `wp-codebox/tool-call-transcript/v1` evidence for generic tool or command execution.
- `files/runtime-reference-manifest.json`: stable runtime reference index.

Bundle ids are content-addressed over the exact bytes of `files/changed-files.json` and `files/patch.diff`. Orchestrators should verify bundles with `wp-codebox artifacts verify` before promotion or apply-back when a bundle crosses a trust boundary.

Apply-back is outside `agent-task-run`. External orchestrators may publish, open PRs, or stage review through their own policy after reading the artifact bundle. WP Codebox's reviewed apply-back path remains `apply-approved-artifact` or `stage-artifact-apply` for WordPress-hosted product flows.

### Tool-Call Transcript Artifacts

Generic command runners and host tool registries should write tool-call evidence as a product-neutral `tool-call-transcript` manifest entry. The transcript schema is `wp-codebox/tool-call-transcript/v1` and each `tool_calls[]` record carries `call_id`, `tool_name`, `tool_type`, `phase`, `status`, optional `started_at` and `finished_at`, optional `input_artifacts` and `output_artifacts`, optional input/output SHA-256 digests, and explicit redaction metadata. Input/output artifacts should use manifest kinds `tool-call-input` and `tool-call-output` when persisted as separate bounded files.

The artifact verifier checks that transcript artifact refs are listed in `manifest.json`, stay within the bundle, and match their declared SHA-256 digests when present. This lets a generic command runner branch merge by materializing its command/tool transcript into `files/runtime-evidence/tool-calls/transcript.json` and appending the referenced input/output artifacts through the existing runtime-evidence manifest update path.

## Runner Workspace Publication

Runner workspace publication is a separate exported contract in runtime-core:

- `wp-codebox/runner-workspace-publication-request/v1`
- `wp-codebox/runner-workspace-publication-result/v1`
- `wp-codebox/runner-workspace-capture-request/v1`
- `wp-codebox/runner-workspace-capture-result/v1`
- `wp-codebox/runner-workspace-command-request/v1`
- `wp-codebox/runner-workspace-command-result/v1`

External orchestrators own the backend that turns a sandbox result into a durable workspace, branch, commit, PR, package, or other publication target. WP Codebox defines the request/result shapes so callers can exchange workspace identity, changed paths, commit/PR metadata, evidence context, and backend failure information without encoding placement policy in the sandbox runtime.

## Provider Runtime Invocation Names

Runtime-core exports `wp-codebox/provider-runtime-invocation-contract/v1` through `providerRuntimeInvocationContract()`. This gives provider bridges and external orchestrators stable WP Codebox-owned names for common generic runtime operations without importing a caller's ability namespace:

- `wp-codebox.runner-workspace.capture` / `wp-codebox/runner-workspace-capture` for runner workspace status and diff capture.
- `wp-codebox.runner-workspace.command` / `wp-codebox/runner-workspace-command` for bounded runner workspace commands.
- `wp-codebox.runner-workspace.publish` / `wp-codebox/runner-workspace-publish` for branch, commit, PR, or equivalent publication handoff.
- `wp-codebox.tool-call-transcript.record` / `wp-codebox/record-tool-call-transcript` for product-neutral tool-call transcript evidence.
- `wp-codebox.artifact-handoff` / `wp-codebox/handoff-artifacts` for artifact envelope handoff across a trust boundary.

These names are identifiers and contract anchors, not a queue or policy implementation. The corresponding result schemas remain the existing runner workspace, tool-call transcript, and evidence artifact envelope contracts. External orchestrators still own backend placement, authorization, retries, retention, and publication policy.

## Heartbeat And Cleanup Metadata

Recipe execution writes run registry records with schema `wp-codebox/run-registry-entry/v1`. The lifecycle block uses `wp-codebox/run-lifecycle/v1` and carries:

- `status`: `queued`, `booting`, `running`, `collecting_artifacts`, `succeeded`, `failed`, `timed_out`, or `cancelled`.
- `heartbeatAt`: updated when the run record changes or receives a heartbeat.
- `lifecycle.phase`: `pending`, `active`, `finalizing`, or `terminal`.
- `lifecycle.cleanup.status`: `not_started`, `running`, `succeeded`, or `failed`.
- `lifecycle.cleanup.attempts`, timestamps, and optional cleanup error.
- `retention.cleanupEligibleAt`, `retainUntil`, `retained`, and `reason` when a parent provides retention metadata.

The recipe output metadata also includes `wp-codebox/run-resource-evidence/v1`, including startup timing, total duration, cleanup evidence, artifact size evidence, phase evidence, and retry-count availability. Orchestrators should use this structured metadata for watchdog, cleanup, and retry decisions instead of scraping human logs.

WP Codebox cleanup covers temporary recipe files, prepared plugin copies, dependency overlays, staged files, input baselines, and Playground teardown. External orchestrators remain responsible for cleanup of their own workspaces, job records, runner leases, remote artifacts, and publication state.

## Provider Plugins And Runtime Overlays

Provider stacks are declared through generic primitives:

- `provider_plugin_paths`: prepared provider plugin checkouts. WP Codebox mounts them as WordPress plugins and derives stable slugs from Composer package names when available, avoiding branch/worktree directory names as plugin identities.
- `component_contracts`: runtime components such as agent APIs, coding tools, provider bridges, or orchestrator-owned tool bridges. Each component accepts `path`/`source`, `slug`, optional explicit `pluginFile`, optional `loadAs`, and optional `activate`. `loadAs: "mu-plugin"` is the expected load mode for runtime substrate. When `pluginFile` is omitted, WP Codebox resolves `<slug>/<slug>.php`, `<slug>/plugin.php`, then a single top-level PHP file with a WordPress plugin header.
- `runtime_stack_mounts`: readonly runtime files or configuration mounted into the sandbox filesystem.
- `runtime_overlays`: scoped library/runtime replacements such as `kind: "bundled-library"`, `library: "php-ai-client"`, and `strategy: "wordpress-scoped-bundle"`.
- `secret_env`: names of environment variables to expose to the sandbox. Values remain outside the JSON contract.

WP Codebox does not implement provider-specific model authentication. Provider plugins and external control-plane configuration resolve credentials. Raw provider keys must not be written to request JSON, artifact files, browser JavaScript, diagnostics, or PR/review output.

## Default Sandbox Agent And Bootstrap

The default sandbox invocation uses:

- `agent`: `wp-codebox-sandbox` when omitted.
- `mode`: `sandbox` when omitted.
- `runtimeEnv.WP_AGENT_RUNTIME`: `1`.
- `sandbox_tool_policy`: caller-provided policy when present, otherwise a default-deny policy with source `wp-codebox.agent-task-run.default-deny`.

Runtime substrate should be mounted as MU plugins so it loads before user-visible plugins. A typical bootstrap supplies runtime components through generic component contracts, mounts the selected provider plugin/runtime bridge, then invokes the sandbox agent through the `wp-codebox.agent-sandbox-run` recipe step generated by `agent-task-run`.

Agent bundles are optional. When provided through `agent_bundles`, WP Codebox stages local bundle sources into the sandbox and passes them to the sandbox agent runner. External orchestrators own which bundle, flow, model, or task policy is selected.

## Contract Gaps

Current exported code covers the entry point, task input normalization, agent-task output normalization, artifact bundle layout, run registry lifecycle, cleanup evidence, and runner workspace publication shapes. Remaining gaps are owned by integration policy rather than the core sandbox contract:

- No standalone JSON Schema is exported for the full `agent-task-run` request or response envelope; the TypeScript interfaces and task-input JSON schema are the current source of truth.
- Heartbeats are recorded in the run registry, but there is no separate long-running streaming/progress protocol; orchestrators should poll or observe run records/artifacts they own.
- Retention metadata is represented but not enforced by WP Codebox. External orchestrators own retention execution for their job and runner resources.
- Provider overlay compatibility is validated by runtime activation and diagnostics, not by provider-specific schema in WP Codebox core.
- Browser-sandbox agent invocation and provider proxy registration are centralized in `WP_Codebox_Agent_Runtime_Invoker`, but the generated sandbox fragment still has to assemble runtime-principal authorization, bundle import, provider readiness/proxying, and `agents/chat` execution from lower-level WordPress Ability API, Agents API, and PHP AI Client hooks.

### Browser-runtime invocation primitive

`generic-ability-runtime-run` is the canonical primitive for callers that need to
invoke a WordPress ability in a disposable runtime with provider/runtime
components. WP Codebox supplies the runtime invocation payload, component
contracts, provider plugin contracts, artifact handoff metadata, and the expected
result schema. Parent control planes supply policy: repository selection,
authorization, retries, retention, publication approval, and how resulting refs
attach to their job records.

The primitive keeps the browser-runtime boundary generic:

- runtime principals or capability tokens are supplied by the caller;
- ability input carries task text plus optional structured context and tool
  policy;
- component and provider contracts declare runtime substrate without naming a
  consumer product;
- artifact handoff and transcript recorders use WP Codebox schema names; and
- command output is normalized as
  `wp-codebox/generic-ability-runtime-run-result/v1` when an expected result
  schema is supplied.

Consumer-specific browser invocation adapters should target this primitive
instead of reintroducing fallback request shapes or product-specific runtime
semantics in WP Codebox core.
