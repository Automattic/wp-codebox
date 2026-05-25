# External Apply Adapter Contract

WP Codebox owns the sandbox and artifact boundary. A parent control plane owns
the product-specific apply-back adapter, such as opening a branch and pull
request in an external system.

## Boundary

```text
WP Codebox sandbox
  -> artifact bundle
  -> parent review approval
  -> wp-codebox/apply-approved-artifact
  -> wp_codebox_apply_approved_artifact filter payload
  -> external adapter records branch, commit, PR URL, and artifact digest
```

WP Codebox core validates the artifact before delegation:

- `manifest.json` id matches `artifact-bundle-sha256-<contentDigest>`.
- `contentDigest.value` matches `files/changed-files.json` plus `files/patch.diff`.
- `approved_files[]` contains only sandbox paths from `changed-files.json`.
- `patch_sha256` identifies the exact delegated patch body.

The external adapter receives the validated payload through
`wp_codebox_apply_approved_artifact`. The adapter may use opaque artifact
metadata such as mount `repo`, `branch`, `commit`, or product routing fields, but
WP Codebox does not interpret those fields or call the adapter's system directly.

## Adapter Result

An adapter should return product metadata that the parent control plane can audit
outside WP Codebox:

```json
{
  "adapter": "parent-control-plane",
  "artifact_id": "artifact-bundle-sha256-...",
  "artifact_content_digest": "...",
  "patch_sha256": "...",
  "branch": "codebox/apply-generated-file",
  "commit": "abc1234",
  "pr_url": "https://github.com/example/example-plugin/pull/123"
}
```

WP Codebox records the adapter result in `apply-audit.jsonl` with sensitive keys
redacted. The external system remains responsible for durable branch, commit, PR,
and reviewer workflow records.

## Smoke Fixture

`npm run external-adapter-contract-smoke` demonstrates the contract without
depending on Homeboy, Data Machine Code, or any other apply-back implementation.
The fixture builds a verified artifact payload, runs a stand-in parent control
plane adapter, and persists this external record shape:

```json
{
  "schema": "wp-codebox/external-apply-record/v1",
  "adapter": { "name": "fixture-parent-control-plane", "version": "2026-05-25" },
  "artifact": {
    "id": "artifact-bundle-sha256-...",
    "content_digest": "...",
    "patch_sha256": "...",
    "approved_files": ["/wordpress/wp-content/plugins/example/generated.txt"]
  },
  "target": {
    "repo": "example/example-plugin",
    "branch": "codebox/apply-generated-file",
    "commit": "abc1234",
    "files": ["generated.txt"]
  },
  "result": {
    "status": "pr-opened",
    "pr_url": "https://github.com/example/example-plugin/pull/123"
  }
}
```

The smoke asserts that the external record includes adapter metadata, PR URL,
branch, commit, and artifact digest while excluding the raw patch body.
