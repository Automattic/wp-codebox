import assert from "node:assert/strict"
import {
  FANOUT_EVENT_SCHEMA,
  FANOUT_EVENT_TYPES,
  FANOUT_PLAN_SCHEMA,
  FANOUT_REQUEST_SCHEMA,
  FANOUT_RESULT_SCHEMA,
  FANOUT_WORKER_SCHEMA,
  RUN_PLAN_EVENT_SCHEMA,
  RUN_PLAN_RESULT_SCHEMA,
  RUN_PLAN_SCHEMA,
  countRunPlanChildResults,
  isFanoutEventType,
  runPlanSucceeded,
  type FanoutExecutionStrategy,
  type FanoutLifecycleEvent,
  type FanoutPlanContract,
  type FanoutRequestContract,
  type RunPlanContract,
  type RunPlanEventContract,
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
const genericPlan: RunPlanContract = {
  schema: RUN_PLAN_SCHEMA,
  sessionId: "generic-parent-1",
  concurrency: 2,
  workers: request.workers,
}
const genericEvent: RunPlanEventContract = {
  schema: RUN_PLAN_EVENT_SCHEMA,
  event: "worker.completed",
  workerId: "design",
  status: "completed",
}
const counts = countRunPlanChildResults([
  { success: true, status: "completed" },
  { success: false, status: "failed" },
  { success: false, status: "cancelled" },
])

assert.equal(FANOUT_RESULT_SCHEMA, "wp-codebox/agent-fanout-result/v1")
assert.equal(RUN_PLAN_RESULT_SCHEMA, "wp-codebox/run-plan-result/v1")
assert.equal(execution, "bounded-concurrent-isolated-sandboxes")
assert.equal(plan.schema, FANOUT_PLAN_SCHEMA)
assert.equal(plan.workers[0].artifact_namespace, "design")
assert.equal(genericPlan.schema, RUN_PLAN_SCHEMA)
assert.equal(genericEvent.schema, RUN_PLAN_EVENT_SCHEMA)
assert.deepEqual(counts, { total: 3, completed: 1, failed: 1, cancelled: 1 })
assert.equal(runPlanSucceeded(counts), false)
assert.ok(events.every((event) => event.schema === FANOUT_EVENT_SCHEMA && isFanoutEventType(event.event)))
assert.equal(isFanoutEventType("worker_finished"), false)
assert.equal(isFanoutEventType("worker.completed"), true)

console.log("fanout contract smoke ok")
