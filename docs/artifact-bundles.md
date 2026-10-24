# Artifact Bundles

Artifact capture is owned by WP Codebox because WP Codebox knows what was mounted, what executed, and what must survive teardown.

Current bundles include:

- `manifest.json`: artifact index with content types and the content digest used for the bundle id.
- `metadata.json`: runtime, policy, mounts, and caller metadata.
- `blueprint.after.json`: contained-runtime replay blueprint. When a runtime-state snapshot is available, this restores the generated WordPress database, active theme/plugin state, and captured `wp-content` files. Otherwise it falls back to a partial write-file replay for captured text files.
- `blueprint.after-notes.json`: replay status, captured state summary, limitations, and diagnostic pointers.
- `files/blueprint.after.partial.json`: diagnostic partial write-file replay retained when `blueprint.after.json` is backed by a runtime-state snapshot.
- `events.jsonl`, `commands.jsonl`, `observations.jsonl`: runtime evidence streams.
- `logs/runtime.log`, `logs/commands.log`: human-readable logs.
- `files/mounts.json`: mounted input list.
- `files/mounted-files.json`: captured readwrite mount files with size, SHA-256, target path, and replayability metadata.
- `files/changed-files.json`: canonical changed-files manifest for review and apply-back consumers.
- `files/patch.diff`: canonical combined text patch for changed readwrite mounts. A mount is diffed when it declares a `baselineSource`, or when the mounted directory is a git work tree (in which case the diff is taken against its committed `HEAD`, including untracked files as additions). Mounts that are neither are skipped.
- `files/test-results.json`: normalized test-results artifact with schema, summary counts, suites, and raw log references. When WP Codebox has not run test-aware commands, the artifact is present with `status: "unknown"`, zero counts, an empty `suites` array, and pointers to raw command logs instead of inferred pass/fail data.
- `files/review.json`: frontend-oriented review payload with summary, progress labels, changed file labels, evidence links, and approval actions.
- `files/runtime-reference-manifest.json`: stable runtime ref index with artifact-bundle, file, trace/events, and snapshot refs plus SHA-256 digests.
- `files/diffs.json`: diff index for readwrite mounts that declare a baseline or are git work trees.
- `files/diffs/<mount>.patch`: unified text diff from the mount baseline (a seeded baseline directory, or the git `HEAD` of a git work-tree mount) to the sandbox output.
- `files/mounts/<index>/...`: copied file contents from readwrite mounts.

Readwrite mounts capture files and diffs by default. Set `captureArtifacts` to `false` on a mount when its mutations are runtime-only and do not need review or apply-back evidence. WP Codebox then skips both the pre-run filesystem baseline and post-run traversal for that mount while preserving readwrite behavior.

Recipes that import a generated site into a clean runtime can export replay evidence before final artifact collection with a workflow step:

```json
{
  "command": "wordpress.export-replay-package",
  "args": ["label=product-host-replay", "landing-page=/"]
}
```

The step writes `files/replay-package/manifest.json`, `blueprint.after.json`, `blueprint.zip`, `blueprint.after-notes.json`, and `files/runtime-snapshot.json` under the runtime artifact root. Its stdout is a `wp-codebox/wordpress-replay-export/v1` envelope with `importMs`, `materializeMs`, `snapshotMs`, `exportMs`, `databaseTables`, `wpContentFiles`, `snapshotBytes`, and `blueprintBytes`. The exported `blueprint.after.json` keeps the runtime snapshot as a referenced package file instead of embedding the full snapshot as one large `runPHP` string.

Existing `wp-codebox/wordpress-runtime-snapshot/v1` files can be turned into the same replay package without a live contained WordPress runtime or the original recipe-run context:

```bash
wp-codebox materialize-replay-package \
  --snapshot ./files/runtime-snapshot.json \
  --snapshot-ref artifact:r15/files/runtime-snapshot.json \
  --output ./replay-package \
  --json
```

The materializer writes `blueprint.after.json`, `blueprint.zip`, `files/runtime-snapshot.json`, `blueprint.after-notes.json`, and `manifest.json`. With `--json`, stdout is a generic `wp-codebox/materialization-result/v1` envelope; the replay-package-specific `wp-codebox/wordpress-replay-export/v1` data is carried as a projection. The generated notes and manifest record source metadata, including the resolved input snapshot path, optional `--snapshot-ref`, and the `wp-codebox materialize-replay-package` command.

Replay packages use a bundled resource for `files/runtime-snapshot.json` so the blueprint and snapshot travel together as one local artifact directory. `blueprint.after.json` is the local/package validation artifact. Public runtime viewer links must use `blueprint.zip`, because the viewer resolves bundled resources from a bundle archive with a root `blueprint.json` entry; a plain JSON URL cannot resolve `files/runtime-snapshot.json`. The manifest therefore records `replayableWordPressSite.publicViewerArtifactPath: "blueprint.zip"`. Use URL resources only when the snapshot is already hosted at a stable, browser-fetchable URL; this avoids shipping the snapshot beside the blueprint, but replay then depends on network access, CORS, URL lifetime, and the full snapshot download at restore time.

`metadata.json` points to the canonical changed-files, patch, test-results, review, and mount-diff artifact paths under `artifacts`. It also includes `provenance` derived from data WP Codebox already has: task input/context where available, WP Codebox runtime version, WordPress version, mounted component/mount metadata, and agent/provider/model fields passed to the sandbox runner. `files/diffs/<mount>.patch` remains available for per-mount detail; `files/patch.diff` is the combined review/apply-back patch surface.

### `files/test-results.json`

`files/test-results.json` is the normalized contract for future test-aware commands. The artifact exists even when no command produced structured test output, so artifact consumers can read one stable path and treat `status: "unknown"` as "no structured test result was captured."

```json
{
  "schema": "wp-codebox/test-results/v1",
  "status": "unknown",
  "summary": { "total": 0, "passed": 0, "failed": 0, "skipped": 0, "unknown": 0 },
  "suites": [],
  "rawLogReferences": [
    { "path": "commands.jsonl", "kind": "commands-jsonl" },
    { "path": "logs/commands.log", "kind": "commands-log" }
  ]
}
```

Artifact bundle ids are content-addressed for the apply-back contract. The runtime writes `manifest.id` as `artifact-bundle-sha256-<digest>`, where `<digest>` is SHA-256 over the exact bytes of `files/changed-files.json` and `files/patch.diff` with the `wp-codebox/artifact-content/v1` domain separator. The same value is exposed as `manifest.contentDigest.value`, `metadata.contentDigest.value`, the CLI `artifacts.contentDigest` field, and `files/review.json` evidence. Approval and apply-back consumers must recompute it before trusting an approved artifact.

Every `manifest.files[]` entry also carries `sha256: { "algorithm": "sha256", "value": "..." }`. For regular files, `value` is the SHA-256 of that artifact file's bytes. For `manifest.json`, `value` is a canonical self-hash over the parsed manifest with the manifest entry's own hash replaced by 64 zeroes, using the `wp-codebox/artifact-manifest-self/v1` domain separator. `wp-codebox artifacts verify` rejects missing hashes and mismatched hashes for any declared file, so tampering with replay-critical or supporting artifacts is detected even when the top-level content digest inputs are unchanged.

Scenario and fuzz-style workflows can add optional case-level indexes under
`manifest.cases[]` without introducing a dedicated runner contract. Each case
has a stable `id`, optional `hash` or `digest`, `artifacts[]` refs with
bundle-relative paths and optional SHA-256 values, redaction metadata, and
verification metadata such as `status`, `verifiedAt`, and `verifier`:

```json
{
  "cases": [
    {
      "id": "case-1",
      "hash": { "algorithm": "sha256", "value": "..." },
      "artifacts": [
        {
          "path": "files/cases/case-1.json",
          "kind": "case-result",
          "contentType": "application/json",
          "sha256": { "algorithm": "sha256", "value": "..." },
          "publicUrl": "https://example.test/artifacts/files/cases/case-1.json",
          "redaction": { "policy": "none", "sensitive": false }
        }
      ],
      "verification": { "status": "passed", "verifiedAt": "2026-05-27T00:00:00.000Z" }
    }
  ]
}
```

Case artifact paths must be present in `manifest.files[]`. When a case artifact
declares `sha256`, `wp-codebox artifacts verify` hashes the referenced file and
fails on mismatch. Reviewer-facing case `publicUrl` values and manifest viewer
bases must be absolute HTTP(S) URLs and must not point at loopback or local
hosts, so public refs do not expose host-local paths as review evidence.

`wp-codebox artifacts verify` also fails closed on unsafe bundle topology: all
declared file paths must be bundle-relative, non-duplicated, traversal-free,
listed in `manifest.files[]` when used as digest inputs or evidence refs, and
present as regular files under the bundle directory. Symlinks, special files, and
regular files with multiple hard links are rejected so downstream consumers do
not trust artifact evidence that may alias protected content outside the bundle.

### Partial Artifact Discovery

When a run fails, is killed, or times out before its normal result envelope is
available, callers can recover partial evidence with:

```bash
wp-codebox artifacts discover-partial --artifacts <dir> --session-id <id> --started-at <iso> --finished-at <iso> --json
```

The TypeScript API is `discoverPartialRunArtifacts({ artifactsRoot, sessionId,
startedAt, finishedAt })` from `@automattic/wp-codebox-core/artifacts`.
Discovery scans artifact directories under `artifactsRoot`, filters by the run
timestamp window, prefers directories whose path includes `sessionId`, and falls
back to all timestamp-matching candidates when no session match exists.

Stable contract paths returned by discovery are `manifest.json`,
`files/changed-files.json`, and `files/runtime-reference-manifest.json`. The
directory `mtime`, recursive byte size, missing-manifest status, and redacted
runtime-reference payload are best-effort diagnostics for failure enrichment.

### `files/review.json`

`files/review.json` is the frontend contract for chat and owner review flows. It is derived from canonical artifacts and should be safe for a generic frontend to render without parsing unified diffs.

```json
{
  "schema": "wp-codebox/artifact-review/v1",
  "artifactId": "artifact-bundle-...",
  "provenance": {
    "task": { "kind": "agent-sandbox-run", "input": "Add a Dry Rub filter..." },
    "runtime": {
      "backend": "wordpress",
      "version": "0.0.0",
      "wordpressVersion": "7.0"
    },
    "agent": { "agent": "sandbox-agent", "provider": "example-ai", "model": "example-model" },
    "mounts": [
      {
        "type": "directory",
        "source": "/path/to/example-plugin",
        "target": "/wordpress/wp-content/plugins/example-plugin",
        "mode": "readonly",
        "metadata": { "kind": "component", "slug": "example-plugin" }
      }
    ]
  },
  "summary": "Sandbox produced changes in 1 file.",
  "stats": { "added": 1, "modified": 0, "deleted": 0, "total": 1 },
  "changedFiles": [
    {
      "path": "/wordpress/wp-content/plugins/example/generated.txt",
      "status": "added",
      "label": "added generated.txt",
      "mountTarget": "/wordpress/wp-content/plugins/example",
      "relativePath": "generated.txt"
    }
  ],
  "progress": [
    { "type": "boot", "label": "Spinning up a test copy of your site..." },
    { "type": "artifact", "label": "Saving the result for review..." },
    { "type": "complete", "label": "Ready for your review." }
  ],
  "actions": [
    { "kind": "approve", "label": "Approve all changes", "requiresApprovedFiles": true },
    { "kind": "approve-files", "label": "Approve selected files", "requiresApprovedFiles": true },
    { "kind": "discard", "label": "Discard changes" },
    { "kind": "iterate", "label": "Request changes" }
  ],
  "evidence": {
    "patch": "files/patch.diff",
    "patchSha256": "...",
    "artifactContentDigest": "...",
    "changedFiles": "files/changed-files.json",
    "testResults": "files/test-results.json"
  },
  "riskFlags": []
}
```

Review actions are declarative. Frontends call `wp-codebox/apply-approved-artifact` with `artifact_id` and an explicit `approved_files[]` list for approve actions, call `wp-codebox/discard-artifact` for discard, and start a new sandbox task for iterate/request-changes flows.

Browser preview sessions can reuse the core browser review bridge instead of inventing product-specific postMessage contracts. Pass sandbox-visible metadata with schema `wp-codebox/browser-review-bridge/v1` and at least `artifactId`; include `sessionId`, `provenance`, `contentDigest`, `approvedFiles`, `applyTarget`, `requester`, and `context` when the parent needs audit or apply-back correlation. The bridge posts decisions to the parent as `{ type: "wp-codebox:artifact-review-decision", payload }`, where `payload.schema` is `wp-codebox/browser-review-decision/v1` and includes the action, artifact/session identifiers, approved files, provenance/content digest, apply target, approver/reason, and merged context.

Products can render their own UI and call `postBrowserReviewDecision()`, or use the small default overlay from `renderBrowserReviewOverlay()` with caller-supplied labels. Keep product copy outside Codebox by setting labels in metadata. Parent hosts that receive an approve decision can pass `artifactId`, `approvedFiles`, `approver`, `applyTarget`, and `context` into `wp-codebox/stage-artifact-apply`, preserving the host approval-adapter review path before `apply-approved-artifact` resolves the approved artifact.

Binary files and oversized files are copied when allowed by capture limits but are not embedded into `blueprint.after.json`. Database exports, option diffs, uploaded media, active plugin/theme state, screenshots, parsed test command output, and redaction guarantees are still future artifact targets.

## Runtime Evidence

Recipe runs write runtime evidence under `files/runtime-evidence/`. Every recipe
run includes `run-attestation.json`, a generic attestation with the WP Codebox
package identity, git commit when available, runtime backend package/version,
WordPress runtime version, command-policy hash, policy enforcement states,
references to workspace-policy and artifact-verifier results when configured,
and redacted secret-envelope metadata.

The attestation treats runtime command, network, filesystem, secrets, and
approval policies as sealed because WP Codebox enforces them while executing the
run. Workspace policy and artifact verification are sealed only when their
recipe options are enabled with `strict: true`; when enabled without strict mode,
their result artifacts are recorded as advisory/declarative evidence. Secret
values are never written to the attestation; it records only names, counts,
availability, and the redaction mode.

Workspace policy evidence rejects symlinks, special files, nested `.git`
metadata, hidden-policy paths, paths outside writable roots, gitlinks,
unmerged-index entries, ignored files in git-backed mode, and regular files with
more than one hard link. The hard-link check uses the host platform's
`lstat().nlink` value and fails closed if the link count cannot be determined,
because a hard-linked file under an allowed root is not independent evidence.
