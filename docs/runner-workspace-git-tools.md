# Runner-native git + GitHub agent tools (Refs #1602)

## Problem

The WP Codebox **runner** (the WordPress runtime the coding agent executes inside,
mounted by `packages/cli`) gets its git / GitHub / file agent tools from
**Data Machine Code (DMC)**, an Extra-Chill plugin. The runner should own a
native git + GitHub agent-tool surface so it no longer depends on DMC.

## Phase 1 — Scope findings

### How the runner resolves agent tools today (the seam)

1. `packages/cli/src/agent-sandbox.ts` → `defaultRuntimeComponentSources()`
   (lines ~493-504) mounts **`data-machine`, `data-machine-code`, and
   `agents-api`** into the sandbox WordPress as default runtime components.
   `data-machine-code` is what supplies the agent's `workspace_*` /
   `create_github_*` tools.
2. Inside the sandbox, the agent runs through the Agents API conversation loop
   (`agents-api/.../class-wp-agent-conversation-loop.php`). Tool calls are
   executed by a `WP_Agent_Tool_Executor` passed in `$options['tool_executor']`.
   The default executor (`WP_Agent_Ability_Tool_Executor`) dispatches
   `tool_name → wp_get_ability(tool_name)->execute()` via
   `WP_Agent_Ability_Dispatcher`.
3. Those abilities are DMC's `datamachine-code/workspace-*` and
   `datamachine-code/*-github-*` abilities
   (`data-machine-code/inc/Abilities/WorkspaceAbilities.php`,
   `GitHubAbilities.php`), which shell out to `git` / call the GitHub API on the
   workspace checkout.
4. Host-side, `wp-codebox`'s `WP_Codebox_Runner_Workspace_Adapter` already
   delegates runner-workspace *operations* to host abilities through the
   `wp_codebox_runner_workspace_backend` filter — but that is host orchestration
   (prepare / publish / capture), and the abilities it points at are still DMC's.

**Minimal seam:** give the runner a codebox-owned executor + tool engine that
performs the agent-facing git/GitHub/file operations natively against the
runner's `workspaceRoot`, and stop mounting `data-machine-code` as a default
runtime component. The Agents API executor contract (`WP_Agent_Tool_Executor`)
is the clean injection point.

### Agents API executor contract (reused)

`agents-api/src/Tools/class-wp-agent-tool-executor.php` defines
`WP_Agent_Tool_Executor::executeWP_Agent_Tool_Call($tool_call, $tool_definition,
$context)`. We implement it with `WP_Codebox_Runner_Workspace_Executor`
(target id `wp-codebox/runner-workspace`), which maps tool names to a native
engine bound to the resolved workspace root. Root resolution mirrors how the
adapter already reads `client_context` (`default_workspace.target` /
`sandbox_workspace.mounts[].target`), plus an explicit param, a
`WP_CODEBOX_RUNNER_WORKSPACE_ROOT` constant, and a
`wp_codebox_runner_workspace_root` filter.

### Reference semantics (DMC) — what we mirror vs drop

Mirrored input/output shapes from DMC's `WorkspaceAbilities` / `GitHubAbilities`
so consumers behave identically:

| Surface | DMC ability | Codebox-native tool |
|---|---|---|
| read file | `workspace-read` | `workspace-read` |
| list dir | `workspace-ls` | `workspace-ls` |
| search | `workspace-grep` | `workspace-grep` |
| write file | `workspace-write` | `workspace-write` |
| edit file | `workspace-edit` | `workspace-edit` |
| apply patch | `workspace-apply-patch` | `workspace-apply-patch` |
| git status | `workspace-git-status` | `workspace-git-status` |
| git diff | `workspace-git-diff` | `workspace-git-diff` |
| git add | `workspace-git-add` | `workspace-git-add` |
| git commit | `workspace-git-commit` | `workspace-git-commit` |
| git push | `workspace-git-push` | `workspace-git-push` |
| clone | `workspace-clone` | (Phase 2 — reuse CLI clone plumbing) |
| worktree add | `workspace-worktree-add` | (Phase 2) |
| open PR | `create-github-pull-request` | `create-github-pull-request` |
| open issue | `create-github-issue` | `create-github-issue` |
| comment PR | `comment-github-pull-request` | `comment-github-pull-request` |

**Dropped (stays host-side, out of scope):** the workspace registry /
`<repo>@<slug>` model, worktree hygiene, cleanup-eligibility, PR-rebase,
freshness / primary-safety policy, and the ~30 `workspace-worktree-*` /
`workspace-cleanup-*` host-orchestration abilities. The runner gets a flat,
single-workspace-root tool surface, not the host's multi-worktree manager.

### GitHub auth — finding (no blocker for the env-token path)

DMC's `GitHubCredentialResolver::resolveEnvironmentToken()` reads
`GITHUB_TOKEN` then `GH_TOKEN` from the environment first. The runner already
injects a token env (`github_token_env`, default `GITHUB_TOKEN`, used for clone
auth in `WP_Codebox_Runner_Workspace_Adapter::prepare()` and surfaced through
`--secret-env`). So **the env-token path is a clean, already-wired credential
mechanism** for an agent opening a PR from the runner; the native engine reads
the same env vars and surfaces a hard `github_token_missing` failure rather than
faking success.

The other DMC credential mode — option-stored GitHub **App installation**
profiles (`github_credential_profiles` via `PluginSettings`) — is host-owned
configuration and is intentionally **out of scope** for the runner. If a future
need arises to give runners App-installation auth without an env token, that is a
host-owned credential-provisioning change to track separately; it is not
required for #1602's env-token flow.

## Phase 2 — One PR or phased?

**Phased.** DMC's surface is ~10k lines across two ability files; a single PR
that natively reimplements every tool *and* swaps the CLI mount *and* removes the
DMC default mount *and* validates end-to-end in the playground is not one clean,
reviewable change. This PR ships the tractable, deterministically-tested core.

### This PR (core)

- `WP_Codebox_Runner_Workspace_Tools` — WordPress-independent engine: native
  file tools (read/ls/grep/write/edit/apply-patch) + git tools
  (status/diff/add/commit, push-construction) + GitHub request construction
  (create PR / issue / comment, env-token auth), all bound to one workspace root
  with path-escape confinement. No DMC, no WordPress required for the core logic.
- `WP_Codebox_Runner_Workspace_Executor` (target `wp-codebox/runner-workspace`)
  implementing `WP_Agent_Tool_Executor`, mapping tool names to the engine and
  resolving the workspace root from call input / client context / constant /
  filter.
- `scripts/php-runner-workspace-tools-smoke.php` — deterministic test on a real
  temp git repo: write→read→edit→grep, status→add→commit→diff, apply-patch,
  push argv construction, GitHub PR/issue/comment request construction, and
  executor `target_id`/workspace-root resolution. No DMC, no network.

### Follow-up PRs (deferred)

1. **Network-level GitHub verification** (recorded-cassette or live-token gated)
   for create-PR / issue / comment, plus `git push` against a throwaway remote.
2. **Legacy removal** (held): remove any remaining Data-Machine-Code-specific
   wiring once the runner has run end-to-end on the codebox-native surface in the
   Playground. This PR already stops mounting it by default; the held step is
   pruning dead references, not behavior.

## Phase 2 — Wired (this is the dependency-shedding change)

Phase 2 wires the executor onto the now-live contract and flips the CLI runner
mount off the external coding-agent plugin.

### Wired onto the live contract (mirrors the merged sandbox executor #1605)

- `WP_Codebox_Runner_Workspace_Executor::register()` registers the executor onto
  the canonical Agents API filters exactly as the git-less sandbox executor does:
  - `agents_api_tool_sources` — declares the 14 file/git/GitHub tools under the
    `wp-codebox-runner` source, each carrying
    `runtime.executor_target = wp-codebox/runner-workspace` and a `host` executor
    kind, with per-tool capability + side-effect metadata.
  - `agents_api_executor_targets` / `agents_api_execution_targets` — registers the
    `wp-codebox/runner-workspace` target descriptor.
  - `agents_api_tool_executors` — registers the executor instance under the target
    id so the registry-based dispatch in `WP_Agent_Tool_Execution_Core`
    (`executePreparedTool` → `resolveExecutorForTool`) routes matching calls here.
- `register()` is invoked from `WP_Codebox_Abilities` next to the sandbox
  executor registration, and gates on `substrate_exists()` (both the
  `WP_Agent_Tool_Executor` interface **and** `WP_Agent_Tool_Source_Registry` must
  be loaded — the gotcha the merged sandbox harness surfaced).
- The runner agent already runs through the Agents API conversation loop, which
  instantiates `WP_Agent_Tool_Execution_Core` and calls `executePreparedTool`;
  that path builds the executor registry from `agents_api_tool_executors`. So
  registering the executor is sufficient — no conversation-loop change is needed.

### CLI mount flip (the dependency shed)

`defaultRuntimeComponentSources()` in **both** `packages/cli/src/agent-sandbox.ts`
and `packages/runtime-core/src/agent-task-recipe.ts` stops mounting the external
coding-agent plugin (and the data-machine plugin it sat next to). Only the Agents
API runtime is mounted by default, alongside the bundled wp-codebox plugin
(`wordpress-plugin`) that registers the runner executor. A host/deploy that still
needs extra substrate opts back in through `CONTAINED_RUNTIME_COMPONENT_PATHS` /
`WP_CODEBOX_AGENT_RUNTIME_COMPONENT_PATHS`.

wp-codebox no longer names the data-machine plugins anywhere on the runner path:
Agents API resolution takes an explicit `WP_CODEBOX_AGENTS_API_PATH`, then a
generic vendoring root via `WP_CODEBOX_AGENTS_API_VENDOR_ROOT`
(`<root>/vendor/wordpress/agents-api`), then a sibling `agents-api` checkout.

### Verification

- `scripts/php-runner-workspace-executor-dispatch-smoke.php` drives the **real**
  Agents API `WP_Agent_Tool_Execution_Core` + `WP_Agent_Tool_Executor_Registry`
  (no shims for the registry/core) against a real temp git repo: a tool with
  `runtime.executor_target = wp-codebox/runner-workspace` routes to the runner
  executor (NOT the default), returns real workspace content/git state, and an
  untargeted control tool falls back to the default executor (backward compat).
- No-DMC-needed: the runner agent-facing surface is exactly the 14 file/git/GitHub
  tools the executor covers (the mirrored subset above). The host-side
  `WP_Codebox_Runner_Workspace_Adapter` handles `clone` / `worktree-add` /
  prepare / publish through the `wp_codebox_runner_workspace_backend` filter —
  host orchestration, not an in-runner agent tool — so dropping the default mount
  does not strip any agent-called surface.

### Integration notes for the follow-up

- **Load order:** `WP_Codebox_Runner_Workspace_Executor` only `implements
  WP_Agent_Tool_Executor` when that interface is already loaded at require time.
  In the sandbox both plugins are mounted as mu-plugins, so the conversation-loop
  wiring (follow-up #1) should ensure agents-api loads first, or define the
  executor class on a `plugins_loaded`/agents-api-ready hook. The engine and the
  `execute_tool()` behavior are interface-independent and already exercised.
- **Executor-registration overlap (#1600):** this executor is a *tool-call*
  executor (`WP_Agent_Tool_Executor`, injected per conversation), which is
  distinct from the runtime-task executor *targets* registered through
  `WP_Codebox_Agents_API_Adapter::register_executor_adapters` (browser/host
  playground). No change was made to that shared registration path, but the
  follow-up that injects this executor into the runner conversation loop should
  reconcile with any concurrent sandbox-tools work (#1600) touching that area.

## Non-goals / boundaries

- No Extra-Chill / Studio-Native / Data-Machine specific names in wp-codebox.
- No `dm_`-as-`datamachine_` shorthand.
- No host orchestration (registry, hygiene, rebase, freshness) reimplemented.
