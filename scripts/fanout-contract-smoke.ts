import assert from "node:assert/strict"
import {
  FANOUT_EVENT_SCHEMA,
  FANOUT_EVENT_TYPES,
  FANOUT_PLAN_SCHEMA,
  FANOUT_REQUEST_SCHEMA,
  FANOUT_RESULT_SCHEMA,
  FANOUT_WORKER_SCHEMA,
  isFanoutEventType,
  type FanoutExecutionStrategy,
  type FanoutLifecycleEvent,
  type FanoutPlanContract,
  type FanoutRequestContract,
} from "@automattic/wp-codebox-core"

const request: FanoutRequestContract = {
  schema: FANOUT_REQUEST_SCHEMA,
  concurrency: 2,
  workers: [
    { schema: FANOUT_WORKER_SCHEMA, id: "design", goal: "Draft design direction.", artifactNamespace: "design" },
    { schema: FANOUT_WORKER_SCHEMA, id: "copy", goal: "Draft page copy.", artifactNamespace: "copy" },
  ],
}

const plan: FanoutPlanContract = {
  schema: FANOUT_PLAN_SCHEMA,
  session_id: "fanout-parent-1",
  concurrency: request.concurrency ?? 1,
  orchestrator: { product: "example" },
  workers: request.workers.map((worker) => ({
    id: worker.id,
    agent: worker.agent ?? "",
    goal: worker.goal,
    artifact_namespace: worker.artifactNamespace ?? worker.id,
  })),
}

const events: FanoutLifecycleEvent[] = FANOUT_EVENT_TYPES.map((event, index) => ({
  schema: FANOUT_EVENT_SCHEMA,
  event,
  time: `2026-06-06T00:00:0${index}Z`,
}))

const execution: FanoutExecutionStrategy = "bounded-concurrent-isolated-sandboxes"

assert.equal(FANOUT_RESULT_SCHEMA, "wp-codebox/agent-fanout-result/v1")
assert.equal(execution, "bounded-concurrent-isolated-sandboxes")
assert.equal(plan.schema, FANOUT_PLAN_SCHEMA)
assert.equal(plan.workers[0].artifact_namespace, "design")
assert.ok(events.every((event) => event.schema === FANOUT_EVENT_SCHEMA && isFanoutEventType(event.event)))
assert.equal(isFanoutEventType("worker_finished"), false)
assert.equal(isFanoutEventType("worker.completed"), true)

console.log("fanout contract smoke ok")
