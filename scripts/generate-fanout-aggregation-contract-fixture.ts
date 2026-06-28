import { writeFile } from "node:fs/promises"

import { aggregateFanoutOutputs } from "../packages/runtime-core/src/index.js"

const fixtureUrl = new URL("../tests/fixtures/fanout-aggregation-contract.json", import.meta.url)

const successfulInput = {
  plan: {
    id: "fanout-contract-fixture",
    workers: [
      { id: "alpha", artifact_namespace: "workers/alpha" },
      { id: "beta", depends_on: ["alpha"], artifact_namespace: "workers/beta" },
    ],
  },
  policy: "fail",
  aggregation: {
    agent: "generic-aggregator",
    outputNamespace: "aggregate/final",
  },
  worker_results: [
    {
      worker_id: "alpha",
      status: "completed",
      success: true,
      result_ref: "fanout/workers/alpha/result.json",
      artifact_refs: [
        { path: "fanout/workers/alpha/artifacts/report.json", final_path: "reports/alpha.json", kind: "worker-report" },
      ],
    },
    {
      worker_id: "beta",
      status: "succeeded",
      result_ref: "fanout/workers/beta/result.json",
      artifact_refs: [
        { path: "fanout/workers/beta/artifacts/report.json", final_path: "reports/beta.json", kind: "worker-report" },
      ],
    },
  ],
}

const vectors = [
  {
    name: "success-with-legacy-status-and-default-output",
    input: successfulInput,
  },
  {
    name: "duplicate-final-path-partial-policy",
    input: {
      ...successfulInput,
      policy: "partial",
      worker_results: [
        { worker_id: "alpha", status: "succeeded", artifact_refs: [{ path: "fanout/workers/alpha/index.html", final_path: "site/index.html" }] },
        { worker_id: "beta", status: "succeeded", artifact_refs: [{ path: "fanout/workers/beta/index.html", final_path: "site/index.html" }] },
      ],
    },
  },
  {
    name: "failed-required-worker-caller-review-policy",
    input: {
      ...successfulInput,
      policy: "caller-review-required",
      worker_results: [
        {
          worker_id: "alpha",
          status: "failed",
          error: { code: "worker-exit", message: "Worker exited with code 1." },
          artifact_refs: [{ path: "fanout/workers/alpha/error.log", kind: "log" }],
        },
        { worker_id: "beta", status: "succeeded", artifact_refs: [{ path: "fanout/workers/beta/report.json", final_path: "reports/beta.json" }] },
      ],
    },
  },
  {
    name: "missing-dependency-partial-policy",
    input: {
      ...successfulInput,
      policy: "partial",
      worker_results: [
        { worker_id: "beta", status: "succeeded", artifact_refs: [{ path: "fanout/workers/beta/report.json", final_path: "reports/beta.json" }] },
      ],
    },
  },
  {
    name: "repair-policy-conflict-candidate",
    input: {
      ...successfulInput,
      policy: "repair",
      conflict_candidates: [{ type: "incompatible-schema", severity: "error", message: "Worker schemas differ." }],
    },
  },
].map((vector) => ({
  ...vector,
  expectedOutput: aggregateFanoutOutputs(vector.input),
}))

await writeFile(fixtureUrl, `${JSON.stringify({ generatedBy: "scripts/generate-fanout-aggregation-contract-fixture.ts", source: "packages/runtime-core/src/fanout-aggregation.ts", vectors }, null, 2)}\n`)
