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
