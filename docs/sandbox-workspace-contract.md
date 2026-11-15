# In-Sandbox Workspace Contract

WP Codebox reserves `/workspace` as the stable editable workspace root inside a
sandbox. Repo-backed tasks mount a repository at `/workspace` and preserve the
repository layout exactly, so `wing-map-display/blocks/map/render.php` in the
repo is `/workspace/wing-map-display/blocks/map/render.php` in the sandbox.
Site-backed tasks mount a site snapshot under the same root, normally with
`/workspace/wp-content/...` paths, and produce a changed-files bundle rather
than a git patch against a repo `HEAD`.

`wp-content` runtime mounts can coexist with `/workspace` mounts. A caller may
mount the same source into `/wordpress/wp-content/plugins/<slug>` so WordPress
loads it, and into `/workspace/<repo-relative-path>` so sandbox tools edit it with
repo-relative paths. Artifact metadata records both mount targets and any opaque
mount metadata such as `repo`, `gitRef`, `default_branch`, `workspaceRef`,
`component`, `wpContentPath`, and `sourceMode`.

Artifact bundles include `metadata.json.provenance.workspace` with:

- `root`: always `/workspace` for the v1 contract.
- `defaultMode`: `repo-backed` unless a mount declares `sourceMode: site-backed`.
- `mounts`: normalized workspace mount refs for repo components and site
  snapshots.
- `toolPolicy`: optional caller-owned sandbox tool policy snapshot when the
  recipe provides one.

Sandbox agents may read, write, edit, patch, grep, list, and diff files inside
the mounted workspace. Read-only source-host abilities may be exposed for context.
Push, deploy, worktree lifecycle, source sync, PR creation, issue mutation, comments,
merge, cleanup, and apply-back operations stay parent-only. The sandbox produces
artifacts; the parent site decides whether and how to apply them.

## Workspace status and diff tools

The seeded runner workspace is a filtered snapshot: `.git/**` is excluded (see
[Runner Workspace Seed Policy](runner-workspace-seed-policy.md)), and the sandbox
tools never invoke `git` or a shell. `workspace_git_status` and
`workspace_git_diff` therefore compare the workspace against its **seed
baseline**, not a git `HEAD`:

- Before a mutation tool (`workspace_write`, `workspace_edit`,
  `workspace_apply_patch`) first touches a path, the executor records that path's
  seed content (or that it did not exist). Mutation tools are the only way an
  agent can change the sandbox, so this overlay is a complete record of the run's
  changes. `reset_mutation_ledger()` clears it at the start of each run.
- When the host supplies a filesystem baseline (`workspace_baseline_root` in the
  executor context), that full tree is used instead.
- `workspace_git_status` returns `files` (sorted paths), `changes`
  (`{path, status}` with `added`, `modified`, or `deleted`), a `summary` count,
  and `baseline: "seed"` or `"filesystem"`. A file rewritten with identical
  content is clean.
- `workspace_git_diff` returns a unified diff with git-style `a/`/`b/` headers,
  `/dev/null` for adds and deletes, and 3-line context hunks, so it applies with
  `workspace_apply_patch`. An optional `path` limits it to one file. Output is
  capped at 256 KB; files past the cap or with binary content are listed in
  `skipped` and `truncated` is set.

Before v0.33.7 neither tool had a baseline in runtime-package runs, so every
call failed with `tool_call_failed` (`baseline_unavailable`)
([#2591](https://github.com/Automattic/wp-codebox/issues/2591)).
