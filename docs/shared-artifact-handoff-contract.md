# Shared Artifact Handoff Contract Proposal

This proposal is the minimum shared contract for coordinating native hosts,
site-generation workers, and WP Codebox sandboxes. It does not create a queue,
database table, product workflow, or deployment path. It names the envelopes and
ownership boundaries each track can implement independently.

## Canonical Workflow

1. Parent control plane creates a durable job/run record and chooses a
   caller-owned `sandbox_session_id`.
2. Parent calls a Codebox-owned entrypoint such as `wp-codebox/run-agent-task`,
   `wp-codebox/run-agent-task-fanout`, `wp-codebox/create-browser-task-contract`,
   or `wp-codebox/run-runtime-package`.
3. WP Codebox runs disposable sandbox work, captures artifacts, and emits
   Codebox-owned progress and result envelopes.
4. Parent stores final result refs on its job record and decides retry, review,
   apply-back, publication, cancellation, retention, and UI state.
5. Rehydration opens an existing Codebox artifact or contained-site handle by id,
   digest, or recovery ref. A miss starts a new run from the same parent job
   inputs; it does not mutate the old bundle.

## Source Of Truth

- Parent control plane owns durable jobs, queues, retries, cancellation requests,
  retention, user-visible history, callback delivery, and final decision state.
- WP Codebox owns sandbox/session execution, safe runtime entrypoints, artifact
  bundle verification, normalized result envelopes, progress event schemas, and
  disposable contained-site recovery handles.
- Site generators and other workers own domain outputs inside their declared
  artifacts. They do not own the durable orchestration state unless they are also
  the parent control plane.
- Product hosts own policy: provider choice, placement, scoring, ranking,
  approval, apply-back, PR creation, publishing, and deployment.

## Artifact Bundle Envelope

Use `wp-codebox/artifact-result-envelope/v1` as the durable result wrapper for
artifact import, reimport, materialization, and handoff. The envelope carries:

```json
{
  "schema": "wp-codebox/artifact-result-envelope/v1",
  "operation": "handoff-artifacts",
  "status": "created",
  "success": true,
  "artifactBundle": {
    "kind": "artifact-bundle",
    "id": "bundle-123",
    "path": "artifacts/bundle-123",
    "digest": {
      "algorithm": "sha256",
      "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  },
  "artifactRefs": [],
  "evidenceRefs": [],
  "verification": {},
  "result": {},
  "diagnostics": [],
  "metadata": {
    "sandbox_session_id": "job-123",
    "source_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

Bundle refs are bundle-relative and digest-addressed. Host filesystem paths,
local-only URLs, raw credentials, cookies, bearer tokens, and unpublished secrets
stay out of envelopes and artifact manifests.

## Progress Event Envelope

Progress is advisory. Durable state comes from the final result envelope and the
parent job record.

- Fanout progress uses `wp-codebox/agent-fanout-event/v1` in
  `fanout/events.jsonl` and finalizes with `wp-codebox/agent-fanout-result/v1`.
- Host delegation progress uses `wp-codebox/host-delegation-event/v1` inside the
  `wp-codebox/host-delegation-result/v1` envelope.
- Run-plan snapshots use `wp-codebox/run-plan-progress/v1` when a host needs a
  normalized UI-facing snapshot over worker/run state.

Events and snapshots should carry stable correlation keys when known:
`sandbox_session_id`, `session_id`, `request_id`, `fanout_id`, `worker_id`,
`source_digest`, and `artifactBundle.id`.

## Delegation And Rehydrate APIs

Use these API names as coordination anchors:

- `wp-codebox/run-agent-task`: single sandbox agent task.
- `wp-codebox/run-agent-task-fanout`: bounded isolated multi-worker fanout.
- `wp-codebox/host-delegation-request/v1`: product-neutral request for a
  host-side provider.
- `wp_codebox_host_delegation_request`: WordPress filter where product hosts may
  satisfy host delegation.
- `wp-codebox/host-delegation-result/v1`: provider result, failure, or
  unavailable evidence.
- `wp-codebox/handoff-artifacts`: artifact envelope handoff across a trust
  boundary.
- `wp-codebox/import-artifact-bundle`: durable ingress for an existing bundle.
- `wp-codebox/reimport-artifact-bundle`: idempotent rehydrate/reverify path for
  an existing bundle.
- `wp-codebox/get-browser-contained-site-status`: read-only contained-site
  recovery check.
- `wp-codebox/open-or-create-browser-contained-site`: preview rehydrate/open path
  with explicit `mode`.

Rehydrate calls must be read-only unless they explicitly create a fresh contained
site or import a new immutable bundle. Parent control planes decide whether a
rehydrate miss means retry, create-new, or surface a stale/missing artifact state.

## Durable Orchestration Split

WP Codebox remains the portable runtime and artifact boundary. It should not grow
product job tables, placement policy, domain-specific bundle interpretation, or
deployment decisions. Parent systems should not depend on sandbox-local paths,
private backend ability ids, runtime package internals, or product-specific
aliases when a Codebox-owned ability/schema exists.

The shared contract is complete when each track can map its local objects to:
`sandbox_session_id`, one Codebox entrypoint, one final result envelope, optional
progress events, and a rehydrate path that can prove whether the artifact or
contained site is still recoverable.
