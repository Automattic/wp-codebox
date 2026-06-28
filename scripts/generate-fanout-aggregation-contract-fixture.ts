import { writeFile } from "node:fs/promises"

import { aggregateFanoutOutputs } from "../packages/runtime-core/src/index.js"

const fixtureUrl = new URL("../tests/fixtures/fanout-aggregation-contract.json", import.meta.url)

const successfulInput = {
  plan: {
    id: "fanout-contract-fixture",
    workers: [
      { id: "alpha", artifactNamespace: "workers/alpha" },
      { id: "beta", dependsOn: ["alpha"], artifactNamespace: "workers/beta" },
    ],
  },
  policy: "fail",
  aggregator: {
    agent: "generic-aggregator",
    outputNamespace: "aggregate/final",
  },
  workerResultRefs: [
    {
      workerId: "alpha",
      status: "completed",
      success: true,
      resultRef: "fanout/workers/alpha/result.json",
      artifactRefs: [
        { path: "fanout/workers/alpha/artifacts/report.json", finalPath: "reports/alpha.json", kind: "worker-report" },
      ],
    },
    {
      workerId: "beta",
      status: "succeeded",
      resultRef: "fanout/workers/beta/result.json",
      artifactRefs: [
        { path: "fanout/workers/beta/artifacts/report.json", finalPath: "reports/beta.json", kind: "worker-report" },
      ],
    },
  ],
}

const vectors = [
  {
    name: "success-with-normalized-status-and-default-output",
    input: successfulInput,
  },
  {
    name: "duplicate-final-path-partial-policy",
    input: {
      ...successfulInput,
      policy: "partial",
      workerResultRefs: [
        { workerId: "alpha", status: "succeeded", artifactRefs: [{ path: "fanout/workers/alpha/index.html", finalPath: "site/index.html" }] },
        { workerId: "beta", status: "succeeded", artifactRefs: [{ path: "fanout/workers/beta/index.html", finalPath: "site/index.html" }] },
      ],
    },
  },
  {
    name: "failed-required-worker-caller-review-policy",
    input: {
      ...successfulInput,
      policy: "caller-review-required",
      workerResultRefs: [
        {
          workerId: "alpha",
          status: "failed",
          error: { code: "worker-exit", message: "Worker exited with code 1." },
          artifactRefs: [{ path: "fanout/workers/alpha/error.log", kind: "log" }],
        },
        { workerId: "beta", status: "succeeded", artifactRefs: [{ path: "fanout/workers/beta/report.json", finalPath: "reports/beta.json" }] },
      ],
    },
  },
  {
    name: "missing-dependency-partial-policy",
    input: {
      ...successfulInput,
      policy: "partial",
      workerResultRefs: [
        { workerId: "beta", status: "succeeded", artifactRefs: [{ path: "fanout/workers/beta/report.json", finalPath: "reports/beta.json" }] },
      ],
    },
  },
  {
    name: "repair-policy-conflict-candidate",
    input: {
      ...successfulInput,
      policy: "repair",
      conflictCandidates: [{ type: "incompatible-schema", severity: "error", message: "Worker schemas differ." }],
    },
  },
].map((vector) => ({
  ...vector,
  expectedOutput: aggregateFanoutOutputs(vector.input),
}))

await writeFile(fixtureUrl, `${JSON.stringify({ generatedBy: "scripts/generate-fanout-aggregation-contract-fixture.ts", source: "packages/runtime-core/src/fanout-aggregation.ts", vectors }, null, 2)}\n`)
