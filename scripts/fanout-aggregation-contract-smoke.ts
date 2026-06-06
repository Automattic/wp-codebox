import assert from "node:assert/strict"
import {
  FANOUT_AGGREGATION_INPUT_SCHEMA,
  FANOUT_AGGREGATION_OUTPUT_SCHEMA,
  aggregateFanoutOutputs,
  defaultFanoutAggregationOutputPath,
  normalizeFanoutAggregationInput,
} from "@automattic/wp-codebox-core"

const successfulInput = {
  plan: {
    id: "fanout-plan-1",
    workers: [
      { id: "worker-a", artifact_namespace: "workers/worker-a" },
      { id: "worker-b", depends_on: ["worker-a"], artifact_namespace: "workers/worker-b" },
    ],
  },
  policy: "fail" as const,
  aggregation: {
    agent: "generic-aggregator",
    outputNamespace: "aggregate/final",
  },
  worker_results: [
    {
      worker_id: "worker-a",
      status: "succeeded",
      artifact_refs: [
        { path: "workers/worker-a/report.json", final_path: "reports/a.json", kind: "report" },
      ],
    },
    {
      worker_id: "worker-b",
      status: "succeeded",
      artifact_refs: [
        { path: "workers/worker-b/report.json", final_path: "reports/b.json", kind: "report" },
      ],
    },
  ],
}

const normalized = normalizeFanoutAggregationInput(successfulInput)
assert.equal(normalized.schema, FANOUT_AGGREGATION_INPUT_SCHEMA)
assert.equal(normalized.workerResultRefs.length, 2)
assert.equal(normalized.artifactRefs.length, 2)
assert.equal(normalized.plan.workers[1].dependsOn[0], "worker-a")

const success = aggregateFanoutOutputs(successfulInput, {
  finalArtifactRefs: [{ path: "aggregate/final/report.json", kind: "aggregate-report" }],
})
assert.equal(success.schema, FANOUT_AGGREGATION_OUTPUT_SCHEMA)
assert.equal(success.status, "succeeded")
assert.equal(success.rawWorkerArtifactRefs.length, 2)
assert.deepEqual(success.finalArtifactRefs, [{ path: "aggregate/final/report.json", kind: "aggregate-report" }])
assert.deepEqual(success.conflicts, [])

const deterministic = aggregateFanoutOutputs(successfulInput)
assert.equal(defaultFanoutAggregationOutputPath(successfulInput), "aggregate/final/result.json")
assert.deepEqual(deterministic.finalArtifactRefs, [{
  path: "aggregate/final/result.json",
  kind: "fanout-aggregate-output",
  contentType: "application/json",
}])

const duplicatePath = aggregateFanoutOutputs({
  ...successfulInput,
  worker_results: [
    {
      worker_id: "worker-a",
      status: "succeeded",
      artifact_refs: [{ path: "workers/worker-a/index.html", final_path: "site/index.html" }],
    },
    {
      worker_id: "worker-b",
      status: "succeeded",
      artifact_refs: [{ path: "workers/worker-b/index.html", final_path: "site/index.html" }],
    },
  ],
})
assert.equal(duplicatePath.status, "failed")
assert.equal(duplicatePath.finalArtifactRefs.length, 0)
assert.equal(duplicatePath.conflicts.length, 1)
assert.equal(duplicatePath.conflicts[0].type, "duplicate-final-artifact-path")
assert.equal(duplicatePath.conflicts[0].path, "site/index.html")
assert.deepEqual(duplicatePath.conflicts[0].workerIds, ["worker-a", "worker-b"])

const failedWorker = aggregateFanoutOutputs({
  ...successfulInput,
  policy: "caller-review-required",
  worker_results: [
    {
      worker_id: "worker-a",
      status: "failed",
      error: { code: "worker-exit", message: "Worker exited with code 1." },
      artifact_refs: [{ path: "workers/worker-a/error.log", kind: "log" }],
    },
    {
      worker_id: "worker-b",
      status: "succeeded",
      artifact_refs: [{ path: "workers/worker-b/report.json", final_path: "reports/b.json" }],
    },
  ],
})
assert.equal(failedWorker.status, "caller_review_required")
assert.ok(failedWorker.conflicts.some((conflict) => conflict.type === "failed-worker" && conflict.workerIds?.includes("worker-a")))
assert.ok(failedWorker.conflicts.some((conflict) => conflict.type === "failed-worker-dependency" && conflict.dependencyId === "worker-a"))

const missingDependency = aggregateFanoutOutputs({
  ...successfulInput,
  policy: "partial",
  worker_results: [
    {
      worker_id: "worker-b",
      status: "succeeded",
      artifact_refs: [{ path: "workers/worker-b/report.json", final_path: "reports/b.json" }],
    },
  ],
})
assert.equal(missingDependency.status, "partial")
assert.ok(missingDependency.conflicts.some((conflict) => conflict.type === "missing-worker-dependency" && conflict.dependencyId === "worker-a"))

const aggregationFailure = aggregateFanoutOutputs(successfulInput, {
  aggregationError: { code: "aggregate-exit", message: "Aggregator failed to merge worker outputs." },
})
assert.equal(aggregationFailure.status, "failed")
assert.equal(aggregationFailure.finalArtifactRefs.length, 0)
assert.ok(aggregationFailure.conflicts.some((conflict) => conflict.type === "aggregation-failure" && conflict.details?.code === "aggregate-exit"))

const repairPolicy = aggregateFanoutOutputs({
  ...successfulInput,
  policy: "repair",
  conflict_candidates: [{ type: "incompatible-schema", severity: "error", message: "Worker schemas differ." }],
})
assert.equal(repairPolicy.status, "repair_required")

console.log("fanout aggregation contract smoke ok")
