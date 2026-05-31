# Architecture

WP Codebox is the portable sandbox boundary for WordPress-compatible
coding-agent work. It does not fundamentally care whether the parent
orchestrator runs inside WordPress. It can be driven from a WordPress plugin,
CLI, CI job, hosted service, or external agent, then start a disposable
WordPress Playground runtime, mount the target code and agent stack, collect
reviewable artifacts, and return those artifacts to the caller for apply or
discard.

```text
Parent control plane
  owns users, auth, durable jobs, review UX, and apply-back policy
    -> WP Codebox
      owns sandbox lifecycle, mounts, execution policy, and artifact capture
        -> disposable WordPress Playground runtime
          may mount optional agent/tool stacks and providers
          runs controlled commands or sandboxed agent tasks
        <- artifact bundle: patch, changed files, tests, preview, provenance
    <- reviewed apply, export, replay, or discard
```

The durable architecture rule is that WP Codebox stays generic and agnostic. It
is a runtime and artifact substrate, not a product, queue, evaluation harness,
site generator, deploy service, or agent framework. Named products may consume
the substrate, but they must not become package boundaries, runtime contracts, or
artifact semantics.

## Maintainer Map

Read this file as the repo map before opening implementation files. The docs
link to the modules that define each contract, but avoid duplicating every type
definition.

- [`packages/runtime-core`](../packages/runtime-core/src/index.ts) defines the
  backend-agnostic contracts: runtime lifecycle, recipes, artifacts, runtime
  episodes, snapshots, policies, command metadata, workspace policy, task input,
  and artifact verification.
- [`packages/runtime-playground`](../packages/runtime-playground/src/index.ts)
  implements the current `wordpress-playground` backend adapter. It is where
  Playground boot, mounts, WordPress command execution, preview serving,
  browser probing, snapshots, and artifact capture touch concrete runtime
  behavior.
- [`packages/cli`](../packages/cli/src/index.ts) is the host-neutral executable
  surface. It parses commands and recipes, prepares local inputs, creates a
  runtime through a backend adapter, executes workflows, and prints JSON/human
  output.
- [`packages/wordpress-plugin`](../packages/wordpress-plugin/README.md) is an
  optional parent-site adapter. It exposes WordPress Abilities and WP-CLI wrappers
  that call the generic CLI/runtime, stores artifact references for a WordPress
  host, and delegates apply-back to host-provided adapters.

```text
Host product or automation
  calls CLI, package API, or optional WordPress ability surface
    -> runtime-core contracts
      -> runtime backend adapter, currently runtime-playground
        -> disposable runtime instance
          -> mounted inputs and controlled commands
          -> artifact bundle
    <- generic artifact references for host-owned review/apply/replay policy
```

## Product Shape

The core use case is safe code generation for WordPress products without giving
the agent production access. A site owner, host application, CI job, automation
runner, or chat surface can ask for a change; WP Codebox runs the work in
Playground and returns evidence that the parent product can review.

Example control planes include hosted WordPress products, non-WordPress web
apps, local development tools, chat surfaces, CI jobs, GitHub Actions,
evaluation harnesses, import pipelines, and other host applications. They
consume WP Codebox; they do not change the sandbox contract.

Browser-based control planes can orchestrate an in-browser WP Codebox runtime by
calling the clean ability API and passing caller-owned runtime ingredients. That
does not make WP Codebox depend on any specific product; product policy,
defaults, and orchestration state stay outside the sandbox contract.

Product-specific consumers can be useful examples when discussing adoption. They
are intentionally not core concepts. If a docs or code change requires WP
Codebox to know a product by name, the boundary is probably wrong; the
product-specific logic belongs in that product's adapter.

## Package Responsibilities

### `runtime-core`

`runtime-core` is the contract package. It should not import a concrete runtime
backend or host adapter. The important modules are:

- [`src/runtime-contracts.ts`](../packages/runtime-core/src/runtime-contracts.ts):
  `Runtime`, `RuntimeBackend`, `RuntimeCreateSpec`, `MountSpec`,
  `ExecutionSpec`, `ObservationSpec`, `Snapshot`, `ArtifactBundle`, runtime
  episode contracts, and `createRuntime()`.
- [`src/index.ts`](../packages/runtime-core/src/index.ts): the public barrel for
  focused core modules plus artifact verification helpers.
- [`src/runtime-policy.ts`](../packages/runtime-core/src/runtime-policy.ts):
  `RuntimePolicy`, policy validation, and command allow-list enforcement.
- [`src/command-registry.ts`](../packages/runtime-core/src/command-registry.ts):
  stable command catalog metadata and the abstract binding from command ids to
  backend handlers or recipe aliases.
- [`src/recipe-schema.ts`](../packages/runtime-core/src/recipe-schema.ts): JSON
  Schema for `wp-codebox/workspace-recipe/v1`.
- [`src/artifact-manifest.ts`](../packages/runtime-core/src/artifact-manifest.ts):
  manifest and content digest primitives.
- [`src/workspace-policy.ts`](../packages/runtime-core/src/workspace-policy.ts):
  writable-root and hidden-path checks for workspace artifacts.
- [`src/sandbox-datamachine-tool-policy.ts`](../packages/runtime-core/src/sandbox-datamachine-tool-policy.ts):
  generic allow-list policy for optional in-sandbox tools. The core contract is
  the tool boundary, not any parent control-plane operation.
- [`src/task-input.ts`](../packages/runtime-core/src/task-input.ts): normalized
  structured task input shared by host adapters.

Core owns vocabulary such as runtime, mount, command, observation, snapshot,
artifact, recipe, policy, and reviewable apply payload. It must remain agnostic
about product queues, PR systems, deployment targets, benchmark scoring, content
importers, and hosting-specific auth.

### `runtime-playground`

`runtime-playground` is the WordPress Playground backend. It may depend on
Playground behavior, WordPress boot mechanics, WP-CLI/PHP execution details,
preview servers, and browser tooling. The important modules are:

- [`src/playground-runtime.ts`](../packages/runtime-playground/src/playground-runtime.ts):
  `PlaygroundRuntimeBackend` and the concrete `Runtime` implementation for
  create, mount, execute, observe, snapshot, collect artifacts, and destroy.
- [`src/command-router.ts`](../packages/runtime-playground/src/command-router.ts):
  maps core command definitions to backend methods.
- [`src/wordpress-command-runners.ts`](../packages/runtime-playground/src/wordpress-command-runners.ts):
  WordPress-specific command execution such as PHP, WP-CLI, Abilities, tests,
  and checks.
- [`src/playground-cli-runner.ts`](../packages/runtime-playground/src/playground-cli-runner.ts)
  and [`src/preview-server.ts`](../packages/runtime-playground/src/preview-server.ts):
  Playground process and preview lifecycle.
- [`src/runtime-artifact-helpers.ts`](../packages/runtime-playground/src/runtime-artifact-helpers.ts),
  [`src/artifact-bundle-builder.ts`](../packages/runtime-playground/src/artifact-bundle-builder.ts),
  and [`src/artifacts.ts`](../packages/runtime-playground/src/artifacts.ts):
  backend artifact collection, redaction, review summaries, captured files,
  diffs, and patch generation.
- [`src/runtime-snapshot.ts`](../packages/runtime-playground/src/runtime-snapshot.ts):
  backend snapshot export/restore payloads.
- [`src/browser-command-runners.ts`](../packages/runtime-playground/src/browser-command-runners.ts),
  [`src/browser-probe.ts`](../packages/runtime-playground/src/browser-probe.ts),
  and [`src/browser-actions.ts`](../packages/runtime-playground/src/browser-actions.ts):
  optional browser evidence capture for live previews.

Backend code can translate generic contracts into concrete runtime behavior. It
should not add host-product policy, mutate parent repositories, open PRs, deploy,
or decide whether an artifact is accepted.

### `cli`

`cli` is the host-neutral operator surface and recipe runner. It wires the core
contracts to the current backend without requiring a WordPress parent site. The
important modules are:

- [`src/index.ts`](../packages/cli/src/index.ts): command parsing and execution
  for `run`, `boot`, `validate-blueprint`, `commands`, `schema`,
  `recipe validate`, `recipe-run`, `artifact verify`, workspace policy checks,
  and runtime episodes.
- [`src/recipe-validation.ts`](../packages/cli/src/recipe-validation.ts): recipe
  parsing, command validation, and policy construction.
- [`src/recipe-dry-run.ts`](../packages/cli/src/recipe-dry-run.ts): dry-run plan
  resolution without booting a runtime.
- [`src/recipe-sources.ts`](../packages/cli/src/recipe-sources.ts): local source
  preparation for mounts, workspaces, extra plugins, staged files, and site
  seeds.
- [`src/recipe-evidence.ts`](../packages/cli/src/recipe-evidence.ts): final
  evidence and artifact metadata for recipe and agent-sandbox runs.
- [`src/agent-sandbox.ts`](../packages/cli/src/agent-sandbox.ts): generic
  in-sandbox agent recipe construction and workspace contract helpers.
- [`src/output.ts`](../packages/cli/src/output.ts): stable JSON and human output
  formatting.

The CLI may prepare local files and call a backend. It should keep automation
decisions generic: output artifacts and status, not product-specific scoring,
approval, deployment, or PR behavior.

### `wordpress-plugin`

`wordpress-plugin` is a host adapter for WordPress parent sites. It is useful
when a WordPress site owns the user experience, permissions, artifact storage, or
approval UI. It is not the core runtime. See
[`packages/wordpress-plugin/README.md`](../packages/wordpress-plugin/README.md)
and the PHP service classes under
[`packages/wordpress-plugin/src`](../packages/wordpress-plugin/src).

The plugin owns the WordPress ability surface, WP-CLI wrappers, host options,
artifact lookup, pending approval integration when available, and apply-back
adapter hooks. It should call the generic CLI/runtime boundary and keep
parent-site persistence or approval mechanics outside the sandbox.

## Package Ownership Rules

Use the current module map as the placement guide for new code. A change should
usually extend the focused module that already owns the nearest contract instead
of adding another export to an entrypoint or creating a broad helper module.

Examples:

- **New runtime contract:** add backend-agnostic types, schemas, validation, or
  digest/verification primitives to `runtime-core`. For example, a new artifact
  manifest field belongs near `artifact-manifest.ts` or the runtime contract in
  `runtime-core/src/index.ts`; the Playground writer that populates it belongs in
  `runtime-playground`.
- **New command:** add discoverable command metadata to
  `runtime-core/src/command-registry.ts`, add the concrete Playground dispatch in
  `runtime-playground/src/command-router.ts`, and put WordPress/PHP/WP-CLI
  mechanics in the relevant runtime runner module such as
  `wordpress-command-runners.ts` or `browser-command-runners.ts`. Only add CLI
  parsing when the command needs a direct CLI surface beyond recipe execution.
- **New CLI workflow:** put argument parsing and command orchestration in `cli`,
  with source preparation in `recipe-sources.ts`, validation in
  `recipe-validation.ts`, dry-run planning in `recipe-dry-run.ts`, and stable
  output formatting in `output.ts`.
- **New artifact, evidence, or reference helper:** put portable contracts,
  manifest hashing, and verification in `runtime-core`; put captured files,
  diffs, review summaries, browser evidence, and Playground-specific bundle
  writing in `runtime-playground`; put final CLI run evidence summaries in
  `cli/src/recipe-evidence.ts`.
- **New WordPress parent-site behavior:** put Abilities, WP-CLI wrappers, host
  options, pending-action integration, artifact lookup, and apply adapter hooks
  in `packages/wordpress-plugin`. Do not move parent-site persistence or approval
  policy into the runtime packages.

Package entrypoints are public surfaces, not implementation buckets:

- `runtime-core/src/index.ts` may define truly central runtime contracts and
  re-export focused contract modules.
- `runtime-playground/src/index.ts` should stay a thin backend factory/export
  surface.
- `cli/src/index.ts` may remain the executable command orchestrator, but reusable
  parsing, recipe, evidence, output, and runtime wrapper logic should stay in
  focused CLI modules.

Anti-dumping-ground rules:

- Do not add vague `utils.ts`, `helpers.ts`, or `common.ts` modules. Name modules
  after the contract or lifecycle slice they own, such as `runtime-reference`,
  `recipe-sources`, `browser-actions`, or `workspace-policy`.
- Do not grow large `index.ts` files by adding unrelated implementation detail.
  If a block can be named by a lifecycle step, command family, artifact surface,
  or validation contract, move it to a focused module and export only the public
  pieces needed by consumers.
- Do not mix host-product policy with sandbox execution. PR creation, deploys,
  scoring, durable jobs, review UI, auth, billing, and queue semantics belong in
  parent products or adapter packages that call WP Codebox.
- Do not create a new module for one-off indirection. Extend the existing owner
  when the behavior is part of that owner; split only when the new code has a
  clear reusable contract or lifecycle boundary.

## Runtime Lifecycle

The generic `Runtime` contract is defined in
[`runtime-core/src/runtime-contracts.ts`](../packages/runtime-core/src/runtime-contracts.ts).
A backend implements the same lifecycle regardless of how it boots the runtime.

```text
create RuntimeCreateSpec
  -> runtime.info() reports id, backend, environment, createdAt, status
mount MountSpec[]
  -> readonly/readwrite inputs become visible inside the sandbox
execute ExecutionSpec[]
  -> command allow-list policy is checked before backend dispatch
observe ObservationSpec[]
  -> structured observations can reference artifact files
snapshot()
  -> optional runtime-state or metadata snapshot
collectArtifacts(ArtifactSpec)
  -> manifest, metadata, logs, changed files, patch, review, references
destroy()
  -> runtime is no longer usable; artifacts remain durable outside it
```

The current Playground implementation records the lifecycle in
[`PlaygroundRuntime`](../packages/runtime-playground/src/playground-runtime.ts):
`runtime.created`, `runtime.mounted`, `runtime.command.started`,
`runtime.command.finished`, `runtime.observed`, `runtime.snapshot.created`,
`runtime.artifacts.collected`, and `runtime.destroyed`.

`createRuntime()` in core validates `RuntimeCreateSpec.policy` before asking the
backend to create a runtime. `execute()` enforces command policy again in the
backend path before routing the command. This gives callers a stable place to
reason about policy even as backend implementations change.

## Recipe Lifecycle

Recipes are declarative run plans, not product workflows. A recipe may mount
inputs, seed a workspace, activate dependencies, run commands, capture evidence,
and emit artifacts. The host still owns why the recipe exists and what happens
after the artifact is produced.

```text
recipe JSON
  -> parse and validate against wp-codebox/workspace-recipe/v1
  -> resolve command definitions and runtime policy
  -> prepare mounts, workspaces, extra plugins, staged files, seeds, secrets
  -> create runtime through backend adapter
  -> mount prepared inputs
  -> run before steps, main steps, after steps
  -> collect diagnostics and command evidence
  -> collect artifact bundle, even for interrupted or failed runs when possible
  -> destroy runtime and return wp-codebox/recipe-run/v1 output
```

The canonical recipe shape lives in
[`recipe-schema.ts`](../packages/runtime-core/src/recipe-schema.ts). CLI
validation lives in
[`recipe-validation.ts`](../packages/cli/src/recipe-validation.ts). Dry-run
planning lives in [`recipe-dry-run.ts`](../packages/cli/src/recipe-dry-run.ts),
and source preparation lives in
[`recipe-sources.ts`](../packages/cli/src/recipe-sources.ts).

Recipe steps use command ids from the command registry. Recipe aliases can map a
high-level recipe helper onto a lower-level backend command, but the policy still
resolves to allowed command capabilities before execution.

## Artifact Lifecycle

Artifacts are the durable output of a disposable runtime. A host can store,
review, replay, apply, export, or discard them without keeping the sandbox alive.

```text
runtime state and mounted files
  -> redaction over configured secret environment values
  -> captured mounted files and mount diffs
  -> changed-files.json and patch.diff
  -> logs, command/event/observation streams, test results, review summary
  -> runtime-reference-manifest.json and runtime-replay-index.json
  -> manifest.json with per-file sha256 entries
  -> content digest over canonical changed files and patch
  -> optional artifact verification report
```

The artifact manifest primitives live in
[`artifact-manifest.ts`](../packages/runtime-core/src/artifact-manifest.ts).
The concrete Playground bundle writer lives in
[`artifact-bundle-builder.ts`](../packages/runtime-playground/src/artifact-bundle-builder.ts).
Verification lives in `verifyArtifactBundle()` in
[`runtime-core/src/index.ts`](../packages/runtime-core/src/index.ts).

Important artifact files include:

- `manifest.json`: file list and per-file hashes.
- `metadata.json`: runtime, policy, mounts, context, provenance, artifact refs,
  and preview metadata.
- `events.jsonl`, `commands.jsonl`, `observations.jsonl`: execution evidence.
- `logs/runtime.log` and `logs/commands.log`: human-readable logs.
- `files/mounts.json` and `files/mounted-files.json`: captured mount inputs and
  outputs.
- `files/diffs.json`, `files/changed-files.json`, and `files/patch.diff`:
  reviewable file changes.
- `files/review.json`: reviewer-facing summary with changed files, preview, and
  progress/action hints.
- `files/test-results.json`: normalized test/check result surface when commands
  produced test evidence.
- `files/runtime-reference-manifest.json`: durable references to runtime files,
  traces, events, and snapshots.
- `files/runtime-replay-index.json`: replay-oriented index describing which
  actions, observations, snapshots, and artifact refs are available.

Apply-back is intentionally outside runtime execution. WP Codebox validates an
artifact id, content digest, approved file list, and patch/reference integrity;
the parent host decides whether to stage, apply, push, export, or discard.

## Command Registry And Policy

The command registry is the discoverable catalog of runtime capabilities. It is
defined in
[`command-registry.ts`](../packages/runtime-core/src/command-registry.ts) and is
exposed by the CLI through `wp-codebox commands --json`.

Each command definition contains:

- `id`: stable command name used by CLI runs and recipes.
- `description`, `acceptedArgs`, and `outputShape`: discovery metadata for tools
  and humans.
- `policyRequirement`: the policy capability that must be granted.
- `recipe`: whether the command can appear in recipe workflow steps.
- `handler`: either a concrete backend binding or a recipe alias.

Policy is a separate contract in
[`runtime-policy.ts`](../packages/runtime-core/src/runtime-policy.ts). A runtime
policy describes network posture, filesystem posture, allowed commands, secret
scope, and approval expectations. The critical relationship is:

```text
command registry says what exists
runtime policy says what this run may execute
backend command router says how an allowed command executes on this backend
```

For the Playground backend, [`command-router.ts`](../packages/runtime-playground/src/command-router.ts)
maps registry entries with `handler.kind === "playground"` to methods on the
concrete runtime. Adding a new command usually requires updating the registry,
the backend router/runner, CLI parsing or recipe validation if needed, and smoke
coverage. Adding host-specific behavior to the registry is the wrong direction;
host behavior belongs in an adapter that calls generic commands.

## Backend-Specific Vs Runtime-Core Boundaries

Use this rule when deciding where code belongs:

- Put backend-agnostic names, schemas, policy checks, artifact contracts,
  command metadata, digest logic, workspace policy, and verification in
  `runtime-core`.
- Put WordPress Playground boot, preview serving, PHP/WP-CLI mechanics, browser
  automation, runtime snapshot payloads, and backend artifact capture in
  `runtime-playground`.
- Put command-line argument parsing, local path preparation, recipe dry-run
  output, and host-neutral JSON/human output in `cli`.
- Put WordPress parent-site Abilities, WP-CLI wrappers, options, pending approval
  surfaces, and apply adapter hooks in `wordpress-plugin`.
- Put external product orchestration, durable jobs, queues, auth, billing,
  scoring, PR creation, deployment, import pipelines, and review UIs outside WP
  Codebox or in an external adapter package.

Generic extension points are welcome when more than one consumer can use them.
Product names in core contracts are a smell. Prefer neutral inputs like
`metadata`, `context`, `orchestrator`, `task_input`, mount metadata, artifact
refs, and adapter hooks.

## Landed Contracts

- **Sandbox session contract:** parent control planes pass caller-owned
  `sandbox_session_id` and optional `orchestrator` metadata to correlate runs.
  WP Codebox echoes a `wp-codebox/sandbox-session/v1` envelope and artifact refs,
  but durable queued/running/cancelled/expired lifecycle remains external. See
  [`sandbox-session-contract.md`](./sandbox-session-contract.md).
- **Apply-back contract:** sandbox execution returns artifacts only. Reviewed
  apply validates `artifact_id`, `approved_files[]`, the canonical changed-file
  manifest, and the artifact content digest before delegating to the
  `wp_codebox_apply_approved_artifact` adapter. PR creation, bot identity,
  deployment, and package export stay in parent adapters. See
  [`external-apply-adapter-contract.md`](./external-apply-adapter-contract.md).
- **Batch/fan-out primitive:** `wp-codebox/run-agent-task-batch` launches one
  isolated sandbox per task sequentially and returns per-task artifact ids,
  preview URLs, statuses, and errors. Parent orchestrators own parallelism,
  track their own jobs, pass correlation metadata into each sandbox run, and
  store the returned artifact ids as evidence.
- **Transfer-readiness checklist:** package boundaries, artifact lifecycle,
  extension seams, browser runtime dependencies, ability contracts, security
  gates, and external integration review points are tracked in
  [`transfer-readiness-checklist.md`](./transfer-readiness-checklist.md).

## Ownership Boundaries

WP Codebox owns:

- Disposable Playground lifecycle.
- Mount normalization and sandbox workspace layout.
- Controlled command and agent-task execution.
- Artifact bundles, provenance, previews, patch surfaces, and replay metadata.
- WordPress plugin abilities that expose those sandbox operations to a host site.

Parent control planes own:

- Users, permissions, quotas, billing, durable jobs, retries, cancellation, and
  retention.
- Human review UX, approval records, and apply-back policy.
- Branch pushes, pull requests, deploys, package export, or direct apply.
- Bot identities and credentials used outside the sandbox.

Optional in-sandbox tool stacks own only the tools mounted into a disposable run.
They may expose sandbox-scoped read/write/diff helpers for the mounted workspace;
parent-only operations such as worktree lifecycle, pushes, repository hosting
mutation, comments, deploys, and cleanup remain outside the sandbox.

## Design Rule

Keep the seams small and consumer-agnostic: session correlation, sandbox
lifecycle, command execution, artifact capture, and reviewed apply-back are
separate contracts. Integrations can add product policy around those seams
without making WP Codebox depend on a specific queue, review UI, deploy system,
or agent framework.

For dependency-role classification and browser runtime packaging boundaries, see
[`browser-runtime-dependency-audit.md`](./browser-runtime-dependency-audit.md).
