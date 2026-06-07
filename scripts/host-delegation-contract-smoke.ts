import assert from "node:assert/strict"
import {
  HOST_DELEGATION_EVENT_SCHEMA,
  HOST_DELEGATION_EVENT_TYPES,
  HOST_DELEGATION_REQUEST_SCHEMA,
  HOST_DELEGATION_RESULT_SCHEMA,
  isHostDelegationEventType,
  type HostDelegationLifecycleEvent,
  type HostDelegationRequestContract,
  type HostDelegationResultContract,
} from "@automattic/wp-codebox-core"

const request: HostDelegationRequestContract = {
  schema: HOST_DELEGATION_REQUEST_SCHEMA,
  request_id: "host-delegation-1",
  goal: "Run the workspace task server-side.",
  execution: { capability: "workspace-task" },
  orchestrator: { product: "example", request_id: "project-123" },
}

const events: HostDelegationLifecycleEvent[] = HOST_DELEGATION_EVENT_TYPES.map((event, index) => ({
  schema: HOST_DELEGATION_EVENT_SCHEMA,
  event,
  time: `2026-06-06T00:00:0${index}Z`,
  request_id: request.request_id ?? "",
  status: event.endsWith("unavailable") ? "unavailable" : event.endsWith("failed") ? "failed" : "completed",
}))

const result: HostDelegationResultContract = {
  success: true,
  schema: HOST_DELEGATION_RESULT_SCHEMA,
  execution: "host-delegation",
  status: "completed",
  request_id: request.request_id ?? "",
  request,
  provider: "fake-host-provider",
  result: { artifact_refs: [{ path: "host/result.json" }] },
  events: events.filter((event) => event.event !== "host-delegation.unavailable" && event.event !== "host-delegation.failed"),
  orchestrator: request.orchestrator,
}

assert.equal(HOST_DELEGATION_REQUEST_SCHEMA, "wp-codebox/host-delegation-request/v1")
assert.equal(HOST_DELEGATION_RESULT_SCHEMA, "wp-codebox/host-delegation-result/v1")
assert.equal(result.schema, HOST_DELEGATION_RESULT_SCHEMA)
assert.equal(result.execution, "host-delegation")
assert.equal(result.status, "completed")
assert.ok(events.every((event) => event.schema === HOST_DELEGATION_EVENT_SCHEMA && isHostDelegationEventType(event.event)))
assert.equal(isHostDelegationEventType("host-delegation.completed"), true)
assert.equal(isHostDelegationEventType("host_delegation.completed"), false)

console.log("host delegation contract smoke ok")
