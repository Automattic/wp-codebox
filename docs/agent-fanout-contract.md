# Agent Fanout Contract

WP Codebox fanout is a generic runtime primitive for running multiple agent
workers in isolated Playground sandboxes under one parent session. Product hosts
provide the worker list and review the resulting parent artifact envelope; WP
Codebox owns bounded execution, lifecycle events, and parent/child artifact
layout.

The canonical Codebox/Studio Native product-facing orchestration path runs
through Homeboy's durable scheduler and Homeboy Extensions' Codebox executor
adapter. This contract remains the lower-level sandbox-native primitive: typed
workers, lifecycle events, artifact refs, aggregation inputs/outputs, and worker
result envelopes. WP Codebox does not own durable queue state, retry policy,
review/PR state, or product placement policy.

Host delegation is a separate generic runtime primitive for an explicit phase
that asks the product host to run work outside the browser Playground. WP
Codebox owns only the request/result/event envelopes and provider seam; product
hosts own placement policy, scoring, provider selection, review, and any
server-side implementation behind the seam.

## Schemas

- `wp-codebox/agent-fanout-request/v1`: caller request accepted by
  `wp-codebox/run-agent-task-fanout`.
- `wp-codebox/agent-fanout-worker/v1`: optional per-worker marker schema for
  worker definitions inside the request.
- `wp-codebox/agent-fanout-plan/v1`: persisted parent plan at
  `fanout/plan.json`.
- `wp-codebox/agent-fanout-event/v1`: JSONL lifecycle event schema at
  `fanout/events.jsonl`.
- `wp-codebox/agent-fanout-result/v1`: parent result returned by the ability and
  persisted at `fanout/result.json`.
- `wp-codebox/agent-fanout-artifacts/v1`: artifact locator block inside the
  parent result.
- `wp-codebox/host-delegation-request/v1`: explicit product-neutral request for
  a host-side provider.
- `wp-codebox/host-delegation-event/v1`: lifecycle events included in the
  delegation result.
- `wp-codebox/host-delegation-result/v1`: structured provider result or
  unavailable evidence.

Aggregation contracts that are usable by products or future aggregator agents
live in runtime-core as `wp-codebox/agent-fanout-aggregation-input/v1` and
`wp-codebox/agent-fanout-aggregation-output/v1`.

## Request Shape

```json
{
  "schema": "wp-codebox/agent-fanout-request/v1",
  "concurrency": 2,
  "workers": [
    {
      "schema": "wp-codebox/agent-fanout-worker/v1",
      "id": "design",
      "goal": "Draft a homepage design direction.",
      "agent": "design-agent"
    }
  ],
  "orchestrator": {
    "product": "example-product",
    "request_id": "project-123"
  }
}
```

Worker IDs are stable artifact namespaces. They must be unique and match the
safe path segment policy used by the runner. A worker may override task policy,
allowed tools, context, expected artifacts, agent, and timeout while inheriting
the parent runtime stack and mounts.

Every persisted parent plan, result, and lifecycle event includes a stable
`fanout_id`. In v1 this is the parent session ID selected from `session_id`,
`orchestrator.session_id`, `orchestrator.request_id`, or the runtime-generated
fallback. Worker result arrays preserve request order, including skipped workers.

## Execution Strategy

The v1 execution strategy is `bounded-concurrent-isolated-sandboxes`.

Each worker receives its own child sandbox session ID in the form
`<parent-session-id>:<worker-id>` and writes to
`fanout/workers/<worker-id>/artifacts`. Concurrency defaults to `1` and is capped
by the host runtime. The WordPress plugin cap is `8`, filterable through
`wp_codebox_agent_fanout_max_concurrency`.

Browser-runtime fanout should use the same strategy at the product boundary:
start separate browser Playground sessions per worker, keep mutable WordPress
state isolated per session, and aggregate only from captured artifacts. Running
several agents concurrently inside one browser Playground is not the v1 contract
because shared WordPress state, option writes, uploads, and tool events can
interleave in ways the parent cannot audit reliably.

## Lifecycle Events

The parent writes JSONL lifecycle events with schema
`wp-codebox/agent-fanout-event/v1`:

- `fanout.started`
- `worker.started`
- `worker.completed`
- `worker.failed`
- `worker.skipped`
- `aggregation.started`
- `aggregation.completed`
- `fanout.completed`
- `fanout.failed`

Product UIs should render these events as progress only. Durable decisions must
use the final `wp-codebox/agent-fanout-result/v1` envelope and referenced worker
artifacts.

Browser hosts do not need a product-specific progress API. The generic polling
contract is the parent artifact envelope: read `fanout/events.jsonl` for live
progress snapshots, then read `fanout/result.json` and referenced worker or
aggregate artifacts for durable status and review decisions.

Lifecycle events include stable progress counts (`total`, `active`, `completed`,
`failed`, `skipped`, `cancelled`, `timed_out`) when the count is known. Workers
skipped because a dependency did not complete successfully emit structured
worker results with `status: "skipped"`, `error.code: "dependency-skipped"`, and
dependency status details.

Each lifecycle event also carries a forwarding-friendly normalized progress
shape. The top-level event keeps its original `event` and `time` fields, and adds
stable aliases where available: `timestamp`, `phase`, `session_id`, `run_id`,
`label`, `progress`, `artifacts`, and `diagnostics`. The same object is embedded
as `normalized_progress` with schema `wp-codebox/live-progress-event/v1`:

```json
{
  "schema": "wp-codebox/live-progress-event/v1",
  "source_schema": "wp-codebox/agent-fanout-event/v1",
  "source_event": "worker.completed",
  "phase": "worker.completed",
  "status": "succeeded",
  "label": "Worker completed",
  "detail": {},
  "progress": {
    "total": 2,
    "active": 0,
    "completed": 2,
    "failed": 0,
    "skipped": 0,
    "cancelled": 0,
    "timed_out": 0
  },
  "artifacts": [
    { "path": "fanout/workers/one/artifacts/result.json", "kind": "worker-result" }
  ],
  "diagnostics": {},
  "timestamp": "2026-01-02T03:04:05.000Z",
  "run_id": "fanout-test",
  "session_id": "fanout-test",
  "fanout_id": "fanout-test",
  "worker_id": "one"
}
```

The parent result includes the final normalized progress event as `progress`,
with artifact refs for `fanout/events.jsonl`, `fanout/result.json`, aggregate
output, and final aggregate output. Browser startup progress events use the same
`normalized_progress` envelope while preserving
`wp-codebox/browser-startup-progress/v1` for existing consumers.

## Artifact Layout

```text
fanout/
  plan.json
  events.jsonl
  result.json
  workers/
    <worker-id>/
      result.json
      artifacts/
  aggregate/
    result.json
    artifacts/
```

The parent result includes `session.children`, aggregate counts, the requested
concurrency, worker run summaries, failure summaries, and artifact references.
WP Codebox owns this parent result envelope and the referenced child artifact
layout. Parent hosts own durable job/result records, callback delivery,
placement/ranking policy, review, apply, PR creation, deployment, or any other
mutation outside the sandbox.

## Host Delegation

Host delegation lets a browser task phase request server-side execution without
embedding product placement policy in WP Codebox. A phase carries a request in
`request` or `input`:

```json
{
  "name": "server-workspace-offload",
  "kind": "host-delegation",
  "request": {
    "schema": "wp-codebox/host-delegation-request/v1",
    "request_id": "phase-123",
    "goal": "Run the workspace phase on a host provider.",
    "execution": {
      "capability": "workspace-task"
    },
    "orchestrator": {
      "request_id": "project-123"
    }
  }
}
```

WP Codebox passes the canonical request to the WordPress filter
`wp_codebox_host_delegation_request`. Product hosts may satisfy it with any
server-side implementation, including a safe workspace primitive, a queue-backed
worker, or another host runtime. WP Codebox does not call agent runtimes,
coding-tool runtimes, or product-specific APIs from this seam.

If no provider handles the request, WP Codebox returns a structured result:

```json
{
  "success": false,
  "schema": "wp-codebox/host-delegation-result/v1",
  "execution": "host-delegation",
  "status": "unavailable",
  "error": {
    "code": "wp_codebox_host_delegation_unavailable",
    "message": "No host delegation provider handled the request."
  },
  "events": [
    { "schema": "wp-codebox/host-delegation-event/v1", "event": "host-delegation.requested" },
    { "schema": "wp-codebox/host-delegation-event/v1", "event": "host-delegation.unavailable" }
  ]
}
```

Provider results may report `accepted`, `completed`, or `failed`. Product UIs
should render delegation events as progress only; durable decisions should use
the final `wp-codebox/host-delegation-result/v1` envelope plus product-owned
evidence and artifacts.

Product hosts own placement scoring and policy. They may decide when to emit a
host-delegation phase and how to interpret provider evidence, but WP Codebox
remains product-neutral and only standardizes the delegation envelope.
