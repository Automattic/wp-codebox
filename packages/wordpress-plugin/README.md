# WP Codebox WordPress Plugin

Registers the WordPress ability surface for launching isolated WP Codebox
agent sandboxes from a parent site. The sandbox may produce WordPress-specific
or non-WordPress artifacts; the plugin returns the artifact bundle metadata to
the parent control plane for review, replay, or apply-back.

## Ability

Canonical consumer-facing ability names are listed first. Compatibility aliases
remain registered where existing callers already use them; inspectable ability
metadata exposes `meta.canonical_ability` for aliases.

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`
- `wp-codebox/run-agent-task-fanout`
- `wp-codebox/create-browser-playground-session`
- `wp-codebox/browser-connector-request`
- `wp-codebox/prepare`
- `wp-codebox/capture`
- `wp-codebox/command`
- `wp-codebox/publish`
- `wp-codebox/list-artifacts`
- `wp-codebox/get-artifact`
- `wp-codebox/discard-artifact`
- `wp-codebox/review-artifact`
- `wp-codebox/apply-artifact-preflight`
- `wp-codebox/import-artifact-bundle`
- `wp-codebox/reimport-artifact-bundle`
- `wp-codebox/stage-artifact-apply`
- `wp-codebox/apply-approved-artifact`
- `wp-codebox/preview-reuse-decision`
- `wp-codebox/open-or-create-browser-contained-site`
- `wp-codebox/create-browser-contained-site-session`
- `wp-codebox/boot-browser-contained-site-session`
- `wp-codebox/preview-boot-ref`
- `wp-codebox/destroy-browser-contained-site-session`
- WP-CLI wrappers under `wp codebox ...`

## PHP Facade

Consumers running inside WordPress should prefer `WP_Codebox_API` instead of
depending on ability registration details, upstream task runtimes, or lower-level
runtime classes. The facade only exposes WP Codebox operations and delegates to
the same service layer as the `wp-codebox/*` ability and WP-CLI surfaces:

- `WP_Codebox_API::run_agent_task( $input )`
- `WP_Codebox_API::create_browser_session( $input )`
- `WP_Codebox_API::open_or_create_browser_session( $input )`
- `WP_Codebox_API::list_artifacts( $input )`
- `WP_Codebox_API::get_artifact( $input )`
- `WP_Codebox_API::preflight_artifact_apply( $input )`
- `WP_Codebox_API::stage_artifact_apply( $input )`
- `WP_Codebox_API::apply_approved_artifact( $input )`
- `WP_Codebox_API::prepare_runner_workspace( $input )`
- `WP_Codebox_API::capture_runner_workspace( $input )`
- `WP_Codebox_API::run_runner_workspace_command( $input )`
- `WP_Codebox_API::publish_runner_workspace( $input )`

For ability-name-oriented callers, `WP_Codebox_API::execute_ability( $name,
$input )` accepts supported `wp-codebox/...` ability names and compatibility
aliases only. Host workspace backends, task runtimes, provider adapters, and
sandbox implementations connect to the Codebox ability and result contracts
through configured adapters.

The host task abilities build a private Codebox recipe, boot a disposable
sandbox runtime, mount the requested runtime components, invoke the configured
sandbox-local task, and return artifact metadata. `wp-codebox agent-sandbox-run`,
upstream runtime stacks, workspace adapters, provider plugins, sandbox backends,
and task runtimes are runner components mapped to Codebox task, runtime,
artifact, and apply contracts before returning results to consumers.

The task ability accepts `wp-codebox/task-input/v1` fields: `goal`, `target`,
`allowed_tools`, `expected_artifacts`, `policy`, and `context`. Raw PHP `code`
and `code_file` fields remain rejected on this product ability path.

Runtime orchestrators can pass `agent_bundles` plus a generic `runtime_task`
payload to run caller-owned bundle logic without injecting PHP code. WP Codebox
imports each bundle through `wp_agent_import_runtime_bundles` or the
`wp_agent_runtime_import_bundle` filter, then executes the sandbox-local ability
named by `runtime_task.ability` with `runtime_task.input`. The runtime owner
plugin defines that ability contract; WP Codebox only preserves the generic
transport, task input, status, diagnostics, and evidence refs.
The `wp_agent_*` hooks are upstream runtime integration seams; consumers should
treat the `agent_bundles` and `runtime_task` fields as the Codebox contract.

```json
{
  "goal": "Run the provider-owned bundle task.",
  "agent_bundles": [
    { "source": "/path/to/sample-agent.json", "slug": "sample-agent", "on_conflict": "upgrade" }
  ],
  "runtime_task": {
    "ability": "runtime/run-agent-bundle",
    "input": {
      "source": "/wordpress/wp-content/wp-codebox-inputs/sample-agent.json",
      "flow": "static-site-manual-flow",
      "wait_for_completion": true
    }
  }
}
```

When `allowed_tools` is non-empty, the parent-side runner requires a resolved
`sandbox_tool_policy` snapshot before launching the CLI. Codebox validates and
enforces the snapshot generically: tools that are not present, not allowed, not
visible to the sandbox, or assigned to a non-sandbox execution location fail
closed with `wp_codebox_tool_not_allowed`.

```json
{
  "schema": "wp-codebox/task-input/v1",
  "goal": "Fix the failing settings save flow.",
  "target": { "kind": "plugin", "path": "wp-content/plugins/example" },
  "allowed_tools": ["workspace.read", "workspace.write", "tests.run"],
  "sandbox_tool_policy": {
    "schema": "wp-codebox/sandbox-tool-policy/v1",
    "version": 1,
    "tools": [
      { "id": "workspace.read", "runtime_tool_id": "workspace_read", "execution_location": "sandbox", "transport_visibility": "sandbox", "allowed": true },
      { "id": "workspace.write", "runtime_tool_id": "workspace_write", "execution_location": "sandbox", "transport_visibility": "sandbox", "allowed": true },
      { "id": "tests.run", "runtime_tool_id": "tests_run", "execution_location": "sandbox", "transport_visibility": "sandbox", "allowed": true }
    ]
  },
  "expected_artifacts": ["patch", "tests", "review"],
  "policy": { "applyBack": "reviewed" },
  "context": { "issue": "https://github.com/Automattic/wp-codebox/issues/29" }
}
```

The batch ability accepts a list of task descriptions or structured task inputs
and launches one isolated sandbox per task sequentially. Each task returns its
own status, artifact id, preview URL, and error payload when the task fails. This
is the parent-site primitive for fan-out workflows such as assigning several
GitHub issues to separate sandbox coding agents; parent orchestrators own any
parallelism above WP Codebox.

Parent control planes that need durable job/session state should own that state
outside WP Codebox and pass a caller-owned `sandbox_session_id`. WP Codebox
returns a `wp-codebox/sandbox-session/v1` envelope with that id, optional
`orchestrator` correlation metadata, and artifact references, but it does not
create host-site job tables or depend on a specific queue. See
`docs/sandbox-session-contract.md`.

Both abilities accept optional `provider` and `model` fields. These seed the
disposable sandbox agent configuration for the selected execution mode. Provider
plugins are supplied with `provider_plugin_paths`; WP Codebox mounts and
activates them without knowing provider-specific behavior. Provider credentials
continue to resolve through the provider's normal scoped mechanism.
Pass `secret_env` as a list of environment variable names to expose selected
parent process credentials inside the sandbox; values are read from the process
environment and are not accepted in the ability payload. For example, pass
`"secret_env": ["GITHUB_TOKEN"]` after the host process has `GITHUB_TOKEN` in
its environment; do not pass token values through ability input.

Provider plugins can also own their credential boundary through the generic
credential hooks. `wp_codebox_provider_credential_requirements` returns a
redacted `wp-codebox/provider-credential-requirements/v1` declaration for the
selected provider/model, and `wp_codebox_resolve_provider_credentials` returns a
redacted `wp-codebox/provider-credential-preflight/v1` status plus the env var
names WP Codebox may expose. WP Codebox fails closed on `missing` or `denied`,
merges only allowed env names into `secret_env`, and records only redacted
requirements/preflight diagnostics in the runtime dependency plan. Hook results
must not include raw token values; fields such as `secret_env_values`,
`credentials`, or provider-specific token payloads are ignored by this boundary.

Callers may also pass an `inherit` declaration to request parent-environment
connectors or settings by name:

```json
{
  "inherit": {
    "connectors": ["primary-ai"],
    "settings": ["mode_models"]
  }
}
```

The parent site resolves that declaration through the
`wp_codebox_resolve_inheritance` filter. The resolver may return connector
status, `provider`, `model`, `provider_plugin_paths`, and `secret_env` names. WP
Codebox records the requested names and sanitized resolution status in the
generated recipe/artifact metadata, mounts inherited provider plugins, and merges
inherited `secret_env` names into the sandbox secret-env allowlist. Connector
secret values are passed to the sandbox process environment only; secret values
and setting values are not serialized into recipe JSON, artifact metadata, logs,
or patches by this transport slice.

Product callers may pass `mounts` to add editable or readonly host directories
to the generated recipe. Each mount may include opaque `metadata` such as
`repo`, `default_branch`, `repo_root_relative_to_mount`, and `editable` so tools
inside the sandbox can map changed sandbox paths back to source repositories.
WP Codebox preserves the metadata but does not interpret product-specific repo
topology.

The stable in-sandbox coding workspace root is `/workspace`. Repo-backed mode
mounts a repository there with its repository layout preserved. Site-backed mode
mounts a snapshot of a site's files, usually with `wp-content` under
`/workspace/wp-content`, and produces changed-file artifacts for reviewed
apply-back. If WordPress also needs to load a plugin or theme, callers can mount
the same source into `/wordpress/wp-content/plugins/<slug>` or
`/wordpress/wp-content/themes/<slug>` in addition to `/workspace/...`; both
mounts are captured in artifact metadata.

For browser review, callers may pass `preview_hold_seconds` to keep the live
Playground runtime available after artifact capture. The ability response's
`run.artifacts.preview.url` and the artifact's `files/review.json` `preview`
field point at the same live URL until the hold window expires. Without a hold
window, the preview field is still recorded as evidence but marked
`expired-on-completion` because the sandbox is destroyed when the command exits.

Returned artifact metadata includes the runtime manifest, replay blueprint,
after-state notes, captured readwrite mount index, event streams, and logs. WP
Codebox owns this capture boundary so the parent site can discard the disposable
sandbox while keeping durable evidence and outputs.

`import-artifact-bundle` and `reimport-artifact-bundle` are generic bundle
ingress primitives for consumers that already have a WP Codebox artifact bundle.
They verify the bundle, copy it into the configured artifact store when needed,
and return a stable `wp-codebox/artifact-result-envelope/v1`. Repeating the same
import without `replace` returns `status: "existing"` with the same artifact
reference, so parent orchestrators can safely retry after transport failures.

Browser-contained preview consumers can call `preview-reuse-decision` before
opening a preview. It returns an explicit `action` such as `hydrate-ref` or
`create-new`, plus a stable `identity_key`. `open-or-create-browser-contained-site`
uses that decision to open a reusable contained site when possible and falls back
to fresh session creation only when the decision requires materialization.

`open-or-create-browser-contained-site` preserves the legacy open/create envelope
for existing consumers. New product UIs should prefer the contained-site session
facades: `create-browser-contained-site-session`,
`boot-browser-contained-site-session`, `preview-boot-ref`, and
`destroy-browser-contained-site-session`. Those DTOs expose preview leases,
startup diagnostics, and blueprint hydration refs without returning inline
Playground blueprints, `prepared_runtime`, or low-level boot URLs as the default
consumer contract.

## Apply-Back Approval

Apply-back is a reviewed artifact flow, not part of sandbox execution.
`wp-codebox/apply-approved-artifact` validates the requested `artifact_id`, the
explicit `approved_files[]` list, and the artifact content digest before handing
the exact approved `files/patch.diff` to the `wp_codebox_apply_approved_artifact`
adapter filter.

`wp-codebox/stage-artifact-apply` stages the same apply input through the host
approval adapter. A host approval adapter should present `files/review.json`,
canonical changed files, normalized test results, and the approved file list.
Accepting the staged action delegates back to `wp-codebox/apply-approved-artifact`;
rejecting it leaves the artifact untouched.

Without a host approval adapter, `stage-artifact-apply` fails closed. Direct
reviewed apply remains available through `apply-approved-artifact` for hosts that
provide their own approval surface.

## WP-CLI

The plugin registers focused WP-CLI wrappers for the same PHP service layer used
by Abilities:

- `wp codebox artifacts list --format=json`
- `wp codebox artifacts get <artifact_id> --format=json`
- `wp codebox artifacts stage-apply <artifact_id> --approved-files='/path.php' --format=json`
- `wp codebox artifacts apply <artifact_id> --approved-files='/path.php' --format=json`
- `wp codebox browser-session create --goal='Prepare a browser sandbox' --format=json`
- `wp codebox run-agent-task --goal='Fix the plugin bug' --format=json`

Complex task payloads can be passed with `--input-json='{"goal":"..."}'` or
`--input-file=/path/to/input.json`; command-line flags override fields from the
JSON payload. `--approved-files` accepts either a JSON array or a comma-separated
list. CLI output is JSON-first for automation.

WP-CLI commands run in trusted operator context. They do not call the Ability
permission callbacks; shell/WP-CLI access is the permission boundary. The command
methods delegate to the same PHP services as Abilities, so validation, artifact
digest checks, pending-action staging, apply adapters, and runner errors behave
the same way.

See [External Apply Adapter Contract](../../docs/external-apply-adapter-contract.md)
for the parent-control-plane contract. The documented smoke fixture proves that
an external adapter can consume the verified artifact payload and record adapter
metadata, PR URL, branch, commit, and artifact digest without WP Codebox calling
any product-specific apply-back system.

## Configuration

Runtime components can be supplied by ability input, the
`wp_codebox_component_contracts` option, or the `wp_codebox_component_contracts`
filter. On multisite, WP Codebox reads `wp_codebox_component_contracts` from
network options because component contracts are host-level configuration.

Each contract declares the component instead of relying on product-specific keys:

- `slug`: component plugin slug
- `path` or `source`: host filesystem path to package for the sandbox
- `activate`: whether the plugin should activate in the sandbox
- `loadAs`: optional recipe loading mode, such as `mu-plugin`
- `readiness_probe`: optional caller-declared readiness probe

The CLI binary can be supplied by ability input, the `wp_codebox_bin` option,
or the `wp_codebox_bin` filter. On multisite, WP Codebox reads `wp_codebox_bin`
from network options because the binary path is host-level configuration. Source
checkouts without generated `dist/` files should point at
`bin/wp-codebox-source.mjs`; it builds WP Codebox when needed before delegating
to the compiled CLI.

The artifact root can be supplied per request with `artifacts_path`, by the
`wp_codebox_artifacts_root` option, or by the `wp_codebox_artifacts_root`
filter. On multisite, WP Codebox reads `wp_codebox_artifacts_root` from network
options.

## Package Artifact

Build the installable plugin zip from the repository root:

```bash
npm run package:wordpress-plugin
```

The generated artifact is `packages/wordpress-plugin/dist/wp-codebox.zip`. It
contains a single top-level `wp-codebox/` directory with `wp-codebox.php`, this
README, and the `src/` PHP files. Generated build outputs and package metadata
are intentionally excluded from the plugin zip.

Validate the artifact shape with:

```bash
npm run smoke -- --group package
```

## Boundary

A mounted coding-tools component can provide file-editing tools for agent
sandboxes inside the isolated runtime. This plugin owns the parent-site ability
surface and sandbox lifecycle boundary; mounted tools do not own that control
plane.

Sandbox-safe tool abilities should be an explicit allow-list:

- Workspace read/list/search/edit primitives supplied by the mounted coding
  tools component.
- Read-only GitHub context primitives: issue, PR, PR file, check/status, tree,
  file, and repo list/get abilities.

Parent-only coding-tool abilities include workspace clone/adopt/remove/delete, worktree
lifecycle and cleanup, git status/log/diff/pull/add/commit/push/rebase/reset, GitSync
bind/pull/submit/push/policy changes, issue/PR creation or mutation, comments,
review comments, merges, PR cleanup, GitHub file writes, and code-task creation.
Those abilities must not be exposed through the sandbox agent bundle. The sandbox
produces artifact metadata, changed files, patches, and review evidence; the
parent control plane performs reviewed apply-back, branch pushes, deploys, and PR
creation.

The WordPress runner validates requested `allowed_tools` against the Codebox-owned
`wp-codebox/tool-bridge/v1` envelope before the sandbox process starts. The
bridge carries the enforced `sandbox_tool_policy`, dispatcher metadata,
allowlist authorization notes, and redaction notes. Product layers own their own
tool taxonomy and risk policy; WP Codebox owns the bridge shape, validates the
generic snapshot, and enforces the resolved boundary.

External systems are consumers or mounted tools. They do not own WP Codebox's
artifact contract.
