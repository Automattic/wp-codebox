# Runtime Episodes

Use `createRuntimeEpisode()` when a caller needs a stateful sandbox loop instead
of a one-shot command or recipe. The episode wrapper is generic: it records reset
observations, step executions, optional per-step observations, snapshots, and
artifact bundles without knowing benchmark, reward, or scenario semantics.

Use the Codebox runtime task/session APIs to execute bounded runtime steps such
as `wordpress.wp-cli` or `wordpress.run-php`, then collect the returned artifact
refs from the Codebox result envelope.

When `collectArtifacts()` runs for an episode, WP Codebox persists the trace into
the artifact bundle at `files/runtime-episode-trace.json` and writes a compact
stream form to `files/runtime-episode.jsonl`. The bundle manifest advertises
those files with `runtime-episode-trace` and `runtime-episode-events` kinds,
`metadata.json` lists them under `artifacts.runtimeEpisodeTrace` and
`artifacts.runtimeEpisodeEvents`, and `files/review.json` includes
`evidence.runtimeEpisodeTrace` for review tooling. `verifyArtifactBundle()`
checks the advertised trace file exists and validates against
`wp-codebox/runtime-episode-trace/v1`.

Artifact bundles also include `files/runtime-reference-manifest.json` using
schema `wp-codebox/runtime-reference-manifest/v1`. This manifest is a stable,
hashable index of runtime-related refs: the artifact-bundle id/digest,
bundle-relative artifact file refs with SHA-256 values, optional trace/events
refs, and snapshot refs. Its id is `runtime-reference-manifest-sha256-<digest>`,
where the digest is computed from the declared refs rather than presentation
fields such as `createdAt`. `verifyArtifactBundle()` validates the manifest
shape, referenced file hashes, artifact-bundle digest, and id/digest pairing.

Products such as eval harnesses can project this generic episode trace into their
own action, observation, reward, and report schemas outside WP Codebox.

The episode trace is a versioned machine-verifiable contract with schema
`wp-codebox/runtime-episode-trace/v1`. `@automattic/wp-codebox-core` exports
`RUNTIME_EPISODE_TRACE_JSON_SCHEMA` for schema-aware consumers and
`validateRuntimeEpisodeTrace()` for lightweight runtime checks. The trace stays
generic: it carries runtime, reset, step, action, execution, observation,
snapshot, and artifact references only. Domain fields such as reward, grader,
scenario, benchmark, task-set, and model-eval belong in consumers that project
the trace into their own schemas.

Episode steps include stable ids and refs for the step, requested action,
runtime execution, optional observation, and collected artifact bundle. Actions
use the generic `wp-codebox/runtime-episode-action/v1` envelope with
`kind: "command" | "filesystem" | "http" | "browser"`, the underlying command
execution name, string args, optional replay intent fields such as `method`,
`url`, `path`, `operation`, `selector`, and a SHA-256 digest over that canonical
payload. Non-command action kinds preserve higher-level runtime intent while the
command execution remains the compatibility primitive.

Observations use the generic `wp-codebox/runtime-episode-observation/v1`
envelope with id, type, data, timestamp, optional artifact refs, and digest. The
Playground backend provides structured observation types for `runtime-info`,
`mounts`, `command-result`, `wordpress-state`, `http-response`,
`browser-result`, `runtime-events`, and `runtime-logs`. Large observation
payloads can be stored as bundle-relative artifacts and referenced by digest.
Refs carry matching digests so callers can compare action args, observations,
executions, snapshots, and artifacts without parsing presentation logs.

`wordpress-state` is a generic WordPress runtime state export with schema
`wp-codebox/wordpress-state-export/v1`. The default request remains small and
safe: `{ type: "wordpress-state" }` exports the summary section only, including
site/home URLs, WordPress version, active theme/plugins, and post counts. Callers
that need richer evidence can pass a section allowlist:

```ts
await episode.observe({
  type: "wordpress-state",
  sections: ["summary", "posts", "terms", "menus", "templates", "media", "options", "users", "rest-routes", "abilities"],
  optionNames: ["blogname", "permalink_structure"],
  userFields: ["roles"],
})
```

Each exported section is written as a bundle-relative artifact under
`files/observations/`, with a SHA-256 digest in both the observation data and the
observation `artifactRefs`. The inline observation data summarizes non-summary
sections by count/key metadata so traces stay compact. Posts, templates,
template parts, and global styles include content hashes by default; pass
`includeContent: true` only when full post content, template content, template
part content, or the raw global-style stylesheet is needed. Options require
`optionNames`; users are redacted by default, expose only allowed
role/capability fields, and include identity fields only with `redaction: "none"`
plus an explicit `userFields` allowlist.

The canonical replayable WordPress state artifact contracts are:

- `wp-codebox/wordpress-state-export/v1`: the inline observation data. It is an
  object with `schema`, `version: 1`, `generatedAt`, the normalized request
  `config`, compact `sections` summaries, and an `artifacts` map keyed by section
  name. Each artifact entry contains `artifact`, `sha256`, and `bytes`.
- `wp-codebox/wordpress-state-section/v1`: the artifact-backed full section. It
  is an object with `schema`, `version: 1`, `section`, and `data`. The `section`
  value matches the key in the export `artifacts` map and the artifact filename.

Stable `wordpress-state-section/v1` section fields are intentionally generic
WordPress state, not replay/grader semantics:

| Section | Stable fields |
| --- | --- |
| `summary` | `siteUrl`, `homeUrl`, `wordpressVersion`, `activeTheme`, `activePlugins`, `postCounts` keyed by post type and status. |
| `posts` | Array of public post types ordered by ascending `ID`. Entries include `id`, `type`, `slug`, `status`, `title`, `contentHash`, `modifiedGmt`, and `content` when `includeContent: true`. This covers posts, pages, and public custom post types. |
| `templates` | `theme`, `templates`, `templateParts`, and `globalStyles`. Template entries include `id`, `slug`, `theme`, `type`, `source`, and `contentHash`; template part entries include `id`, `slug`, `theme`, `area`, `source`, and `contentHash`; global styles expose `stylesheetHash` when available. |
| `options` | Object keyed by explicitly requested `optionNames`; no options are exported implicitly. |
| `terms` | Array of terms with `id`, `taxonomy`, `slug`, `name`, `parent`, and `count`. |
| `menus` | Array of menus with `id`, `slug`, `name`, and `items`; menu items include `id`, `title`, `url`, `parentId`, `object`, and `type`. |
| `media` | Array of attachments ordered by ascending `ID`. Entries include `id`, `slug`, `title`, `status`, `mimeType`, `sourceUrl`, `altText`, and `metadataHash`. |
| `users` | Array ordered by ascending `ID`. Entries always include `id` and `redacted`; `roles` and `caps` are allowed safe fields. Identity fields such as `user_login` and `display_name` are emitted only when requested and `redaction: "none"`. |

Redaction is part of the contract. The default `redaction: "safe"` avoids user
identity fields and requires explicit allowlists for options and users.
`redaction: "none"` is an opt-in export mode for trusted callers that need identity fields.
Consumers should verify artifact SHA-256 values before replay and should branch
on `schema` and `version` instead of projecting per-consumer state shapes.

Replay is bounded to the generic runtime contract. A consumer can replay a step
by creating a compatible backend runtime, applying the same mounts/artifact
inputs, and executing the action envelope in order. WP Codebox intentionally
does not record rewards, scenario ids, benchmark metadata, model-eval fields, or
product-specific success semantics; those belong to the caller's projection of
the trace. Backend behavior still matters: command availability, WordPress
version, installed packages, mounted files, network policy, and secrets policy
must be reproduced by the replay harness.

Runtime snapshots are explicit about their semantics. The Playground backend
returns `semantics: "runtime-state-artifact"` for generic WordPress runtime
snapshots. The snapshot artifact declares `wp-codebox/wordpress-runtime-snapshot/v1`
and captures database tables, `wp-content` files, mounted input metadata, active
theme/plugins, WordPress/PHP compatibility metadata, and SHA-256 hashes. Call
`restoreRuntime(snapshot, backend, { runtime, mounts })` to restore a compatible
snapshot into a fresh runtime. The primitive is intentionally generic WordPress
state capture: caller-specific scoring, evaluation, and success semantics belong
outside WP Codebox.

`collectArtifacts({ includeRuntimeSnapshotBundles: true })` includes snapshot
artifact refs in the artifact manifest and runtime reference indexes. Consumers
should branch on the snapshot `semantics` field and verify artifact hashes before
restore or replay.

The runtime reference manifest repeats each snapshot's `semantics` and adds an
explicit `replay.status`. For Playground runtime-state artifacts that status is
`runtime-state-artifact`, with snapshot artifact refs available for restore.
