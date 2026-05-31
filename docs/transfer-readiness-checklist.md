# Transfer Readiness Architecture Checklist

WP Codebox is preparing to move from a personal prototype substrate toward
Automattic-owned infrastructure. This checklist defines the architecture review
surface that should be clean before transfer: package boundaries, artifact
lifecycle, extension seams, browser runtime dependencies, ability contracts,
security gates, and the Studio Web integration seam.

Use this document as a transfer review checklist, not a roadmap for moving
product behavior into WP Codebox. WP Codebox should own the generic sandbox and
artifact substrate. Product orchestrators, including Studio Web, should own
durable jobs, UX, product semantics, and apply policy.

```text
Product control plane
  owns users, jobs, policy, review, PRs, deploys, SSI/BAC semantics
    -> WP Codebox contracts
      owns runtime policy, Playground lifecycle, mounts, execution, artifacts
        -> disposable WordPress Playground runtime
          loads caller-provided plugins, themes, MU plugins, and agent tools
        <- artifact bundle, preview refs, changed files, provenance
    <- review, apply, export, replay, or discard outside WP Codebox
```

## Transfer Acceptance Bar

- A new maintainer can identify which package owns each runtime concern without
  reading product-specific Studio Web code.
- Runtime inputs and outputs are versioned through documented contracts rather
  than implicit CLI output parsing.
- Artifact bundles are durable enough for review, replay, and apply decisions
  after the disposable Playground runtime is gone.
- Caller-provided extensions are loaded through generic recipe/runtime fields,
  not hard-coded Studio Web, SSI, BAC, or personal project assumptions.
- Security-sensitive behavior fails closed: tool allow-lists, file path bounds,
  host/resource controls, secret handling, artifact digest checks, and reviewed
  apply-back all have explicit gates.
- Package names, repository URLs, release artifacts, and dependency ownership are
  ready for the target Automattic namespace before transfer.

## Package Boundaries

Current workspace packages:

- `packages/runtime-core` owns backend-agnostic contracts: runtime policy,
  command registry, task input, workspace policy, recipe schemas, artifact
  verification, sandbox Data Machine tool policy, and shared types.
- `packages/runtime-playground` owns the WordPress Playground backend adapter:
  Playground boot, command routing, WP-CLI/PHP/browser command runners,
  snapshots, observations, mounted-file capture, diagnostics, and artifact bundle
  assembly.
- `packages/cli` owns operator automation: command parsing, recipe parsing,
  recipe source preparation, workflow phase execution, evidence finalization,
  artifact verification commands, and human/JSON output.
- `packages/wordpress-plugin` owns the parent-site WordPress adapter: ability
  registration, WP-CLI wrappers, task input normalization, parent-side sandbox
  launch, artifact listing/get/discard/apply, pending-action staging, host
  configuration, and filter-based integration points.
- `packages/sandbox-datamachine-tool-policy.json` and the generated PHP mirror
  define the sandbox-safe Data Machine ability allow-list shared across JS and
  PHP boundaries.

Transfer checklist:

- Keep generic runtime contracts in `runtime-core`; avoid importing Playground,
  CLI, WordPress plugin, Studio Web, SSI, BAC, wp-gym, or Homeboy semantics into
  that package.
- Keep backend-specific behavior in `runtime-playground`; expose it through the
  `RuntimeBackend` contract and command registry instead of direct caller hooks.
- Keep product orchestration out of `cli`; the CLI should execute recipes and
  return artifacts, not own durable queues, PR creation, deployment, billing,
  review UX, or model-evaluation scoring.
- Keep the WordPress plugin as a parent-site adapter; it should expose abilities
  and host configuration without depending on a specific product database, queue,
  Studio Web UI, or Data Machine install beyond optional integration filters.
- Track helper deduplication through issue #344 so shared object/hash/artifact
  helpers move to stable package homes without creating dependency cycles.

## Runtime Artifact Lifecycle

The durable lifecycle is:

```text
task input / recipe / run args
  -> normalize and validate policy
  -> prepare mounts, staged files, plugin/runtime dependencies, site seeds
  -> create Playground runtime
  -> execute commands, workflow steps, browser actions, or agent task
  -> observe runtime state and collect diagnostics
  -> capture mounted files, diffs, changed files, patch, logs, traces, previews
  -> write manifest, metadata, review, replay/reference data, provenance
  -> destroy or hold preview runtime
  -> parent reviews artifact bundle outside the sandbox
```

Transfer checklist:

- Preserve `wp-codebox/task-input/v1` as the product-facing task envelope for
  `goal`, `target`, `allowed_tools`, `expected_artifacts`, `policy`, and
  non-secret `context`.
- Preserve `wp-codebox/sandbox-session/v1` as a correlation envelope only;
  durable queued/running/cancelled/expired state remains parent-owned.
- Preserve artifact identity as content-addressed evidence: `manifest.json`
  `id` must match `artifact-bundle-sha256-<contentDigest>`.
- Keep `files/changed-files.json` and `files/patch.diff` as the canonical apply
  input pair checked by parent-side artifact verification.
- Keep artifact provenance explicit: runtime backend, policy, mounts, workspace
  root, caller metadata, redacted inheritance state, command traces, and digest
  metadata should be recorded in bundle metadata or evidence files.
- Treat previews as artifact references, not durable runtime ownership. A live
  preview URL can expire; artifact review data should still explain whether the
  preview was held, expired, or unavailable.
- Track runtime reference/replay index completion through issue #316 so browser
  artifacts include enough generic local-file reference metadata for downstream
  asset mapping without teaching WP Codebox SSI/BAC semantics.

## Extension Seams

WP Codebox should let callers provide runtime ingredients while preserving a
generic substrate boundary.

Transfer checklist:

- Support caller-provided plugins through `extraPlugins` with explicit source,
  slug, plugin file, activation behavior, optional hash, and `loadAs` mode.
- Support caller-provided MU plugins through the same generic runtime dependency
  path; prove load order and invocation through issue #317.
- Support caller-provided themes and workspaces as mounts with opaque metadata
  that WP Codebox preserves but does not interpret as product topology.
- Support sandbox-local abilities/tasks as runtime behavior loaded by caller
  plugins, not as hard-coded Studio Web repair commands in WP Codebox core.
- Preserve mount metadata such as repo, branch, component, workspace ref,
  source mode, and WordPress content path as opaque provenance for parent
  adapters.
- Keep provider plugins generic: WP Codebox can mount and activate provider
  plugins, but provider-specific credentials and behavior remain owned by the
  provider and parent control plane.
- Avoid introducing direct imports, command names, options, or schemas that name
  Studio Web, Static Site Importer, Block Artifact Compiler, wp-gym benchmarks,
  rewards, graders, or personal projects inside generic runtime packages.

## Browser Runtime Dependencies

Browser sessions are a runtime mode, not a Studio Web feature. They should expose
generic browser capabilities and accept caller-owned runtime dependencies.

Transfer checklist:

- Keep `wp-codebox/create-browser-playground-session` and related browser paths
  generic: goal, mounts, runtime dependencies, preview configuration, browser
  probes/actions, artifacts, and session metadata.
- Load caller-provided browser/runtime plugins through documented recipe or
  ability input fields; avoid product-specific defaults that assume Studio Web.
- Treat browser action results, screenshots, console logs, HTTP observations,
  and generated files as artifacts with redaction and manifest entries.
- Keep the Playground permission bypass bounded to disposable browser runtimes;
  the generated runner must continue to fail when copied into a normal host site.
- Audit package dependencies and generated browser assets before transfer so the
  target owner knows which dependencies are runtime-critical, build-only,
  browser-only, or inherited from `@wp-playground/cli`.
- Track the generic runtime dependency and MU-plugin invocation path through
  issue #317.

## Ability Contracts

The WordPress plugin should expose a small host-facing contract that is stable
enough for products to integrate without binding WP Codebox to their internals.

Transfer checklist:

- `wp-codebox/run-agent-task` accepts structured task input, parent correlation
  metadata, optional provider/model hints, configured component paths, mounted
  workspaces, runtime dependencies, and non-secret context.
- `wp-codebox/run-agent-task-batch` fans out into isolated sandboxes and returns
  per-task status, artifact ids, preview URLs, and errors; parent orchestrators
  own parallelism and durable state.
- `wp-codebox/list-artifacts`, `wp-codebox/get-artifact`, and
  `wp-codebox/discard-artifact` operate inside the configured artifact root with
  path validation.
- `wp-codebox/stage-artifact-apply` stages a review action when Data Machine
  pending actions are available and fails closed when they are not.
- `wp-codebox/apply-approved-artifact` validates bundle id, content digest,
  changed files, approved file list, and patch hash before delegating through the
  `wp_codebox_apply_approved_artifact` adapter filter.
- WP-CLI wrappers are trusted operator surfaces around the same services; they
  are automation affordances, not substitutes for ability permission callbacks.
- Ability inputs should never include raw secret values. Use connector-scoped
  inheritance and `secret_env` names resolved by the parent process.

## Security Gates

Transfer checklist:

- Runtime policy validates `network`, `filesystem`, `commands`, `secrets`, and
  `approvals`; command execution must call `assertRuntimeCommandAllowed()`.
- Network policy should be treated as declared policy where the current backend
  cannot enforce it fully; transfer notes should identify which fields are shape
  validation versus runtime enforcement.
- Workspace policy must keep sandbox writes inside declared writable roots and
  hide configured paths from artifact capture or tool access.
- Sandbox Data Machine tools must stay on the explicit safe allow-list; parent
  worktree lifecycle, GitSync, PR mutation, issue mutation, comments, deploys,
  cleanup, and apply-back operations remain parent-only.
- Artifact access must resolve paths under the configured artifact root and reject
  outside-root traversal.
- Apply-back must require reviewed `approved_files[]` and digest-verified bundle
  content before invoking the external adapter.
- Secrets should be passed by environment-variable name or connector reference,
  redacted from recipes, logs, metadata, patches, and review files, and excluded
  from artifact provenance except for sanitized availability/status metadata.
- Generated browser runners that bypass host permission checks must assert they
  are executing inside a disposable Playground runtime before registering the
  bypass.

## Studio Web Integration Without Coupling

Studio Web should integrate as a product control plane that calls WP Codebox,
passes runtime ingredients, and consumes artifacts. WP Codebox should not learn
Studio Web's product model.

Transfer checklist:

- Studio Web owns projects, prompts, artifact state, UI, repair loop decisions,
  diagnostics presentation, review UX, and product-specific job/session state.
- Studio Web can pass generated source trees as mounts, pass runtime plugins or
  MU plugins, request browser sessions, run generic browser actions, and read
  artifact bundles.
- Static Site Importer and Block Artifact Compiler semantics stay outside WP
  Codebox. WP Codebox may produce generic files, patches, browser observations,
  reference indexes, and provenance that those products consume.
- Studio Web repair agents should be injected as caller-provided sandbox code or
  sandbox-local tasks, then return changed files and summaries as normal WP
  Codebox artifacts.
- Studio Web apply/materialization paths should use parent-owned adapters and
  artifact review; WP Codebox should not push branches, open PRs, import static
  sites, or mutate production product state directly.

## Transfer Follow-Up Issues

- #344: Deduplicate shared object, hash, and artifact manifest helpers so package
  boundaries stay clear after the architecture split.
- #346: Expand architecture docs for package responsibilities, runtime lifecycle,
  recipe lifecycle, artifact lifecycle, and command policy relationships.
- #317: Support caller-provided sandbox MU plugins and sandbox-local task
  invocation for repair runtimes without Studio Web or SSI coupling.
- #316: Generate a generic runtime reference index for browser artifacts so
  downstream asset mapping can consume references without AI-authored manifests.
- #357: Replace personal package namespace and repository URLs once the target
  Automattic package/repo policy is known.
- #358: Classify browser runtime and packaging dependencies so transfer reviewers
  can distinguish runtime-critical, browser-only, build-only, generated, and
  transitive Playground dependencies.

## Transfer Review Questions

- Which package names and npm scopes will be used after Automattic ownership?
- Which release artifact is authoritative for each environment: npm package,
  plugin zip, or both as one release unit?
- Which browser/runtime dependencies are intentionally public API, runtime
  implementation detail, or build-time-only?
- Which host is responsible for long-term artifact retention and deletion after
  transfer?
- Which parent adapter will own PR creation and apply-back in the first
  Automattic-hosted integration?
