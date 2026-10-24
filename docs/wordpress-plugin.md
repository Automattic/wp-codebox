# WordPress Plugin

How a parent WordPress site drives WP Codebox. The plugin's own
[README](../packages/wordpress-plugin/README.md) lists its abilities, PHP facade,
WP-CLI commands, and configuration.

## Why A WordPress Plugin?

The WordPress plugin is useful when the host experience should live inside a
WordPress site. It turns WP Codebox into a WordPress-native control plane for
reviewed coding workflows without asking users to run a terminal.

Good fits include:

- Letting non-technical site owners request, review, and approve bounded coding changes from a WordPress UI or chat surface.
- Running a managed coding community where users submit tasks and maintainers approve sandboxed artifacts before anything reaches real code.
- Supporting WordPress contributors with disposable reproduction, patch, review, and test-result artifacts that can be shared before commit or PR creation.

These are host-product use cases. The core runtime still works anywhere the CLI
can run.

## Abilities

The WordPress plugin registers parent-site abilities under the `wp-codebox/`
namespace through the WordPress Abilities API, and mirrors the operator-facing
ones as `wp codebox` WP-CLI commands. List what is registered on a site with
`GET /wp-json/wp-abilities/v1/abilities` or `wp codebox --help`. Compatibility
aliases expose `meta.canonical_ability` in their ability metadata.

Canonical agent-task execution paths are intentionally split by caller runtime:

- Server/host execution uses `wp-codebox/run-agent-task` or `wp-codebox/run-agent-task-batch`. These abilities shell out to local `wp-codebox recipe-run`, boot disposable Codebox sandboxes, mount the configured agent stack, invoke the configured sandbox-local task, and return artifact metadata. Runtime backend and agent execution substrate details stay behind the Codebox contract.
- Portable CLI execution uses `wp-codebox recipe-run --recipe <path>` or `wp-codebox agent-task-run --input-file <path>` for task-oriented runs. Recipe internals may use private helper steps, but product callers should depend on the CLI command contract rather than private step names.
- No-Node/browser execution uses `wp-codebox/create-browser-playground-session`. The host prepares a browser-executable recipe and runner payload; the browser executes `wordpress.run-php` inside the contained runtime instead of requiring host shell or Node access.

All three paths use the same `wp-codebox/task-input/v1` task input contract. Host and browser paths also emit the same `wp-codebox/sandbox-session/v1` session envelope so product callers can correlate prepared browser sessions and completed host runs without transport-specific metadata drift.

`wp-codebox/run-agent-task-batch` runs one isolated sandbox per task sequentially and returns per-task status, artifact id, preview URL, and error fields. Parent orchestrators own any parallel fan-out above this ability.

`wp-codebox/run-agent-task` accepts the stable task input contract below. Existing callers that still send `task` as a string are normalized to the same shape with `goal` populated from `task`. It rejects raw `code` and `code_file` fields so frontend/chat callers cannot pass arbitrary PHP through the product ability path. Operators can still use CLI debug commands directly when they need raw PHP probes.

```json
{
  "schema": "wp-codebox/task-input/v1",
  "goal": "Add a focused product feature and return a reviewable patch.",
  "target": {
    "kind": "plugin",
    "path": "wp-content/plugins/example"
  },
  "allowed_tools": ["workspace.read", "workspace.write", "tests.run"],
  "expected_artifacts": ["patch", "tests", "review"],
  "policy": {
    "applyBack": "reviewed"
  },
  "context": {
    "issue": "https://github.com/Automattic/wp-codebox/issues/29"
  }
}
```

`target.kind` is caller-defined but should use `repo`, `site`, `plugin`, or `theme` when possible. `allowed_tools` and `expected_artifacts` are advisory contract fields for the product caller and sandboxed agent loop; the host runner still decides the private CLI invocation and returns the normalized `task_input` alongside the string `task` it passed into the current CLI bridge.

Runtime components are declared through `component_contracts` in ability input, the `wp_codebox_component_contracts` option, or the `wp_codebox_component_contracts` filter. WP Codebox does not infer product-specific component names or paths.

Product callers can opt into public preview wiring through `preview_port`, `preview_bind`, and `preview_public_url`. Omit them to keep the default loopback-only random-port preview behavior; `preview_bind` requires `preview_port`, and `preview_public_url` must be an `http` or `https` URL.

Callers can gate success on post-agent verification through `verify_steps`: an array of recipe steps (for example `{ "command": "wordpress.phpunit", "args": ["plugin-slug=example"] }` or `{ "command": "wordpress.run-php", "args": ["code-file=..."] }`) that run as recipe `workflow.after` steps after the agent finishes editing, against the booted runtime. A non-zero exit from any verify step fails the whole run, so the agent cannot report success unless its checks pass. Runs without `verify_steps` are unaffected.

Each component contract declares `slug`, `path` or `source`, optional explicit `pluginFile`, optional `activate`, optional `loadAs`, and optional `readiness_probe` metadata.

The CLI binary can come from ability input, the `wp_codebox_bin` option, or the `wp_codebox_bin` filter. Source-checkout snapshots should point at `bin/wp-codebox-source.mjs`; it runs the incremental source build before every invocation so ignored `dist/` output cannot predate the checked-out core, Playground, or CLI source, then delegates to the compiled CLI.

Caller-owned runtime components can provide workspace, file, GitHub, or other tools to the sandboxed agent. WP Codebox owns the parent-site ability surface, sandbox lifecycle, and artifact capture boundary.

Parent orchestrators that already own task state can call the same API instead of generating a low-level WP Codebox recipe. The stable CLI entry point is:

```bash
wp-codebox agent-task-run --input-file=/path/to/request.json --json \
  --preview-hold-seconds 300 \
  --preview-hold-blocking \
  --preview-port 4173 \
  --preview-bind 127.0.0.1 \
  --preview-public-url https://preview.example.test
```

Generic caller-owned `request.json` payloads may use this shape:

```json
{
  "schema": "wp-codebox/task-input/v1",
  "goal": "Fix the failing audit finding and return a reviewable artifact.",
  "provider": "example-ai",
  "model": "example-model",
  "provider_plugin_paths": ["/srv/runtime/ai-provider-example"],
  "component_contracts": [
    { "slug": "caller-runtime-substrate", "path": "/srv/runtime/caller-runtime-substrate", "pluginFile": "caller-runtime-substrate/caller-runtime-substrate.php", "loadAs": "mu-plugin" },
    { "slug": "caller-runtime", "path": "/srv/runtime/caller-runtime", "pluginFile": "caller-runtime/caller-runtime.php", "loadAs": "mu-plugin" },
    { "slug": "caller-runtime-tools", "path": "/srv/runtime/caller-runtime-tools", "pluginFile": "caller-runtime-tools/caller-runtime-tools.php", "loadAs": "mu-plugin" }
  ],
  "secret_env": ["EXAMPLE_AI_API_KEY"],
  "mounts": [
    {
      "source": "/srv/worktrees/plugin",
      "target": "/workspace/plugin",
      "mode": "readwrite",
      "metadata": { "kind": "component", "slug": "plugin" }
    }
  ],
  "runtime_stack_mounts": [
    { "source": "/srv/runtime/caller-runtime-substrate", "target": "/runtime/caller-runtime-substrate", "mode": "readonly" }
  ],
  "runtime_overlays": [
    { "id": "caller-runtime-overlay", "source": "/srv/runtime/caller-runtime-overlay" }
  ],
  "task_timeout_seconds": 3600,
  "max_turns": 8,
  "sandbox_session_id": "caller-sandbox-session-123",
  "artifacts_path": "/srv/artifacts/caller/agent-task-123",
  "expected_artifacts": ["patch"],
  "policy": { "kind": "audit-remediation" },
  "context": { "issue": "https://github.com/org/repo/issues/123" },
  "orchestrator": {
    "type": "caller-control-plane",
    "id": "caller-agent-task",
    "job_id": "caller-job-123",
    "agent_task_id": "agent-task-123"
  }
}
```

WP Codebox normalizes the task input, writes the private temporary recipe, runs `wp-codebox recipe-run`, then deletes temporary recipe/seed files. The JSON response keeps `schema: "wp-codebox/agent-task-run/v1"` and includes `agent_task_run_result` with `schema: "wp-codebox/agent-task-run-result/v1"`. Consumers read `agent_task_run_result.status`, `agent_task_run_result.success`, `agent_task_run_result.refs`, `agent_task_run_result.metadata`, and `failure_evidence` as the stable result envelope. `--result-file <path>` atomically writes that final JSON with a private temporary file and a rename; callers that require structured output should use it instead of stdout. Secret values are never accepted in the request or returned in the response; `secret_env` carries names only.

Failed `agent-task-run` responses also include `failure_evidence` with `schema: "wp-codebox/agent-task-run-failure-evidence/v1"`. This block is intentionally safe for parent orchestrators to persist alongside their own task failure record. It includes the best available `phase`, `command`, `exit_code`, message, stdout/stderr snippets, runtime and sandbox identifiers, artifact directory or bundle identifiers, recipe-run status/run ID, diagnostics, phase evidence, and the serialized error. If recipe-run fails before normal runtime artifacts exist or returns malformed output, `agent-task-run` still emits this fallback evidence block in the CLI JSON payload and references it from `evidence_refs` with kind `codebox-agent-task-failure-evidence`.

Provider stacks are assembled from generic primitives: `provider_plugin_paths`, `component_contracts`, `runtime_stack_mounts`, `runtime_overlays`, and `secret_env`. A provider plugin path may point at any prepared checkout; when the checkout has a Composer package name, WP Codebox uses the package basename as the mounted plugin slug so branch/worktree directory names do not become WordPress plugin identities.

Use explicit `runtime_overlays` for bundled libraries or scoped runtime replacements so public examples keep the consumer-facing Codebox API boundary clear.

Consumers that need a stable interpretation layer can import `normalizeAgentTaskRunResult()`, `AGENT_TASK_RUN_RESULT_SCHEMA`, and `AGENT_TASK_RUN_RESULT_JSON_SCHEMA` from `@automattic/wp-codebox-core`. The helper accepts the current `agent-task-run` response, including `agentResult`, `completionOutcome`, and nested `metadata.recipe_run` records. The returned `wp-codebox/agent-task-run-result/v1` envelope normalizes `completed`/`success` into `succeeded` or `failed`, exposes terminal statuses such as `no_op`, `timeout`, `provider_error`, and `unable_to_remediate`, groups artifact bundle, changed-files, patch, transcript, log, and runtime refs, and includes no-op/failure metadata for parent schedulers.

Consumers that only need artifact pointers use `normalizePublicArtifactRefDTO()`, `normalizePublicArtifactRefDTOs()`, `publicArtifactRefGroups()`, `findChangedFilesArtifactRef()`, and `findPatchArtifactRef()` to read bundle, session, and recipe-run artifact references. Browser hosts can also use `normalizeBrowserSessionProductDTO()` to project a product-safe `wp-codebox/browser-session-product-dto/v1` view with stable artifact ref groups and secret-like fields redacted.

Apply-back is intentionally not part of `run-agent-task`. Sandbox execution returns proposed outputs and evidence. `list-artifacts`, `get-artifact`, and `discard-artifact` manage captured artifact bundles under the configured artifact root. `apply-approved-artifact` is the lower-level adapter-only/test API: it validates `artifact_id` plus an explicit `approved_files[]` list against canonical `changed-files.json`, recomputes the artifact content digest from `changed-files.json` and the exact `patch.diff` the reviewer approved, delegates to the `wp_codebox_apply_approved_artifact` filter, and requires the adapter to return `wp-codebox/apply-result/v1`. PR creation, direct deploy, package export, and bot identity policy live in adapters behind that reviewed boundary.

Prefer `stage-artifact-apply` for user-facing apply flows. It stages that same apply input through the host approval adapter. The review preview should include `files/review.json`, canonical changed files, normalized test results, and the explicit approved file list. Accepting the staged action calls the existing `apply-approved-artifact` path; rejecting it leaves the artifact untouched. This keeps approval lifecycle in the host control plane without making WP Codebox depend on any site-specific apply adapter.

## Browser Site Operations

The WordPress plugin ships a browser runtime helper at
`window.wpCodeboxBrowser` for product callers that drive a contained WordPress runtime
from the browser. Advanced adapter helpers such as `runPhpRequest`,
`runWordPressOperation`, `ensureDirectory`, and `writeFile` remain available for
custom workflows. Prefer the typed site-operation helpers for common safe
actions because they validate input and return a normalized product envelope:

```js
{
  operation: "setFrontendAdminBarVisible",
  status: "ok",
  target: "frontendAdminBar",
  key: "show_admin_bar_front",
  data: { visible: false },
  errors: [],
}
```

Current safe helpers:

- `setFrontendAdminBarVisible(client, { visible, userId? })` toggles the
  frontend admin bar preference for a runtime user. `visible` must be a
  boolean, and `userId` must be a positive integer when supplied.
- `writeReviewFile(client, { path, content, encoding? })` writes review or
  artifact notes below the runtime uploads `wp-codebox/reviews` directory.
  `path` must be a relative path without `.` or `..` segments.

These helpers mutate only the disposable contained WordPress runtime. Parent products
remain responsible for reviewing artifacts and deciding whether to apply any
result outside the sandbox.

## Browser Runner

Browser Playground callers can provide sandbox-owned MU plugin source through `runtime.mu_plugins` on `wp-codebox/create-browser-playground-session`. Those files are written into `/wordpress/wp-content/mu-plugins/` before the generated runner invokes sandbox-local work. Pair that with `browser_runner.invocation` to call a generic sandbox extension point:

```json
{
  "runtime": {
    "mu_plugins": [
      {
        "slug": "caller-runtime",
        "file": "caller-runtime.php",
        "content": "<?php add_filter( 'caller_runtime_task', static function ( $result, $input ) { return array( 'summary' => 'done', 'input' => $input ); }, 10, 2 );"
      }
    ]
  },
  "browser_runner": {
    "capture_paths": [
      {
        "path": "/wordpress/wp-content/uploads/wp-codebox/artifacts/materialization/report.json",
        "name": "materialization-report",
        "kind": "report",
        "mime_type": "application/json",
        "max_bytes": 262144
      }
    ],
    "invocation": {
      "type": "task",
      "hook": "caller_runtime_task",
      "input": {
        "diagnostics": { "status": "ready" }
      }
    }
  }
}
```

`browser_runner.invocation.type` supports `ability` for a `namespace/name` WordPress Ability and `task` for a caller-owned WordPress hook. WP Codebox validates the invocation shape, runs it inside the disposable Playground only, and returns normal artifact metadata without encoding product-specific repair semantics.

The packaged browser runtime exposes `window.wpCodeboxBrowser.v1` as the stable browser SDK for product callers and keeps legacy top-level helpers available for internal compatibility. Use `window.wpCodeboxBrowser.v1.runBrowserSessionRecipe( client, sessionOutput, taskPayload?, options? )` to execute the `wp-codebox/create-browser-playground-session` response and receive a `wp-codebox/browser-run-result/v1` envelope. Pass the full ability output as `sessionOutput`; WP Codebox resolves `sessionOutput.recipe`, stages `taskPayload` or `sessionOutput.task_input` at the recipe's browser task path, runs the generated PHP request step through Playground, and normalizes the result. Product callers should use this helper instead of reading `recipe.workflow.steps`, extracting `code=` arguments, or depending on legacy raw runner variants.

Browser run and artifact outputs use one product-safe DTO lane:

- `wp-codebox/browser-run-result/v1` reports `operation`, `status`, `success`, normalized `result`, `artifactRefs`, `diagnostics`, and an `error` on failure.
- `wp-codebox/browser-artifact-persistence/ref/v1` reports persisted browser artifact data and canonical `artifactRefs`. Older `wp-codebox/browser-artifact-persistence-projection/v1` inputs are still accepted by helpers for compatibility, but new consumer-facing output uses the `/ref/v1` schema.
- `window.wpCodeboxBrowser.v1.normalizeBrowserRunResult()` and `browserArtifactPersistenceRef()` normalize legacy browser runner/materialization variants into those DTOs.
- `window.wpCodeboxBrowser.v1.createBrowserConnectorRequest()` builds the public `wp-codebox/browser-connector-request/v1` envelope for connector-scoped browser calls. `executeBrowserConnectorRequest()` accepts that envelope and adapts it through Codebox's internal provider bridge; product callers should not construct `wp-codebox/browser-provider-proxy-request/v1` directly.
- `window.wpCodeboxBrowser.v1.captureViewportScreenshot(client, { route, viewport, timeout_ms }, { browserInvoker, session? })` replays a prepared browser preview by exporting it with the matching Playground client module's `zipWpContent`, then runs the requested desktop or mobile viewport through Codebox's Playwright runtime. Codebox persists its PNG evidence through `wp-codebox/persist-browser-artifact` and returns canonical `wp-codebox/browser-artifact-ref/v1` data, including bundle id, immutable artifact path, and SHA-256. `browserInvoker` is an optional test/extensibility seam. `verifyViewportScreenshot(evidence)` calls `wp-codebox/inspect-artifact` server-side and requires the artifact manifest checksum to match before evidence can be consumed. Explicit persistence and verification adapters are optional test/extensibility seams.
- Non-browser TypeScript consumers should use the equivalent public DTO helpers from `@automattic/wp-codebox-core/public`: `normalizeBrowserRunResult()`, `browserRunResultEnvelope()`, `browserArtifactPersistenceProjection()`, `persistedBrowserArtifactRefs()`, and `artifactBundleFileManifest()`.

`browser_runner.capture_paths` is the generic result-capture layer for browser materialization. Each entry names a sandbox-local file that the generated runner should read after the ability or hook returns. The runner writes `/tmp/wp-codebox-agent-result.json` with `wp-codebox/browser-materialization/v1`, normalized `success`/`status`/`error` fields, invocation metadata, the raw response, and captured files as `wp-codebox/browser-capture/v1` records. JSON files are decoded into `json`, text files into `content`, and binary files into `content_base64`, bounded by `max_bytes`.
