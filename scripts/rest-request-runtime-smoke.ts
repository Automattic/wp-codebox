import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RUNTIME_ACTION_OBSERVATION_SCHEMA,
  createRuntimeEpisode,
  runRuntimeAction,
  validateRuntimeEpisodeTrace,
} from "@automattic/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@automattic/wp-codebox-playground"

const tempRoot = await mkdtemp(join(tmpdir(), "wp-codebox-rest-request-"))

try {
  const episode = await createRuntimeEpisode(
    {
      runtime: {
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "rest-request-runtime-smoke", version: "7.0", blueprint: { steps: [] } },
        policy: {
          network: "deny",
          filesystem: "readwrite-mounts",
          commands: ["wordpress.rest-request"],
          secrets: "none",
          approvals: "never",
        },
        artifactsDirectory: join(tempRoot, "artifacts"),
        metadata: { task: { kind: "rest-request-runtime-smoke" } },
      },
      resetObservations: [{ type: "runtime-info" }],
      artifactSpec: { includeLogs: true, includeObservations: true },
    },
    createPlaygroundRuntimeBackend(),
  )

  try {
    const direct = await episode.step(
      { kind: "http", command: "wordpress.rest-request", method: "GET", path: "/wp/v2/types", args: ["method=GET", "path=/wp/v2/types"] },
      { type: "command-result" },
    )
    assert.equal(direct.execution.exitCode, 0)
    const directBody = JSON.parse(direct.execution.stdout) as { command: string; status: number; body: Record<string, unknown>; data: Record<string, unknown>; timing: { duration_ms: number }; diagnostics: Record<string, unknown> }
    assert.equal(directBody.command, "wordpress.rest-request")
    assert.equal(directBody.status, 200)
    assert.ok(directBody.body.post)
    assert.ok(directBody.data.post)
    assert.equal(typeof directBody.timing.duration_ms, "number")
    assert.deepEqual(directBody.diagnostics, {})

    const action = await runRuntimeAction(episode, { type: "rest_request", method: "GET", path: "/wp-json/wp/v2/types", params: { context: "view" } })
    assert.equal(action.schema, RUNTIME_ACTION_OBSERVATION_SCHEMA)
    assert.equal(action.type, "rest_request")
    assert.equal(action.step?.action.kind, "http")
    assert.equal(action.step?.execution.command, "wordpress.rest-request")
    assert.deepEqual(action.step?.execution.args, ["path=/wp-json/wp/v2/types", "method=GET", 'params-json={"context":"view"}'])
    assert.equal(action.data.method, "GET")
    assert.equal(action.data.path, "/wp-json/wp/v2/types")
    assert.equal(action.data.route, "/wp/v2/types")
    assert.equal(action.data.status, 200)
    assert.equal(typeof action.data.headers, "object")
    assert.ok((action.data.body as { post?: unknown }).post)
    assert.equal(typeof (action.data.timing as { durationMs?: number }).durationMs, "number")
    assert.equal((action.data.diagnostics as { exitCode?: number; stderr?: string }).exitCode, 0)
    assert.equal((action.data.diagnostics as { exitCode?: number; stderr?: string }).stderr, "")
    assert.equal((action.data.stdout as { status: number }).status, 200)

    const trace = await episode.trace()
    assert.equal(trace.steps.length, 2)
    assert.equal(trace.steps.every((step) => step.action.command === "wordpress.rest-request"), true)
    assert.equal(validateRuntimeEpisodeTrace(trace).valid, true)
  } finally {
    await episode.close()
  }

  console.log("REST request runtime smoke passed")
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
