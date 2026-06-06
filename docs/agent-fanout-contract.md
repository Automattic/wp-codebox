# Agent Fanout Contract

WP Codebox fanout is a generic runtime primitive for running multiple agent
workers in isolated Playground sandboxes under one parent session. Product hosts
provide the worker list and review the resulting parent artifact envelope; WP
Codebox owns bounded execution, lifecycle events, and parent/child artifact
layout.

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
