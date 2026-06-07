# Agent Fanout Contract

WP Codebox fanout is a generic runtime primitive for running multiple agent
workers in isolated Playground sandboxes under one parent session. Product hosts
provide the worker list and review the resulting parent artifact envelope; WP
Codebox owns bounded execution, lifecycle events, and parent/child artifact
layout.

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
    "product": "studio-web",
    "request_id": "project-123"
  }
}
```

Worker IDs are stable artifact namespaces. They must be unique and match the
safe path segment policy used by the runner. A worker may override task policy,
allowed tools, context, expected artifacts, agent, and timeout while inheriting
the parent runtime stack and mounts.

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
- `aggregation.started`
- `aggregation.completed`
- `fanout.completed`
- `fanout.failed`

Product UIs should render these events as progress only. Durable decisions must
use the final `wp-codebox/agent-fanout-result/v1` envelope and referenced worker
artifacts.

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
Parent products remain responsible for review, apply, PR creation, deployment,
or any other mutation outside the sandbox.

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
server-side implementation, including an Agents API safe workspace primitive, a
queue-backed worker, or another host runtime. WP Codebox does not call Agents
API, Data Machine, Data Machine Code, or product-specific APIs from this seam.

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

Product hosts such as Studio Web own placement scoring and policy. They may
decide when to emit a host-delegation phase and how to interpret provider
evidence, but WP Codebox remains product-neutral and only standardizes the
delegation envelope.
