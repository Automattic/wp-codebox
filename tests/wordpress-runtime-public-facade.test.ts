import assert from "node:assert/strict"
import {
  collectBrowserArtifactMetrics,
  collectWordPressEpisodeArtifacts,
  collectWordPressRuntimeArtifacts,
  createWordPressEpisode,
  createWordPressRuntime,
  runWordPressEpisodeActions,
} from "../packages/runtime-playground/src/public.js"

assert.equal(typeof createWordPressRuntime, "function")
assert.equal(typeof createWordPressEpisode, "function")
assert.equal(typeof runWordPressEpisodeActions, "function")
assert.equal(typeof collectWordPressRuntimeArtifacts, "function")
assert.equal(typeof collectWordPressEpisodeArtifacts, "function")
assert.equal(typeof collectBrowserArtifactMetrics, "function")

const calls: string[] = []
const fakeEpisode = {
  async step(action: { command: string; args?: string[] }, observation?: unknown) {
    return {
      id: `${action.command}:step`,
      index: calls.filter((call) => call === "step").length,
      action: {
        schema: "wp-codebox/runtime-episode-action/v1" as const,
        id: `${action.command}:action`,
        kind: "command" as const,
        command: action.command,
        args: action.args ?? [],
        digest: { algorithm: "sha256" as const, value: action.command },
      },
      actionRef: { kind: "action", id: `${action.command}:action` },
      execution: {
        id: `${action.command}:execution`,
        command: action.command,
        args: action.args ?? [],
        exitCode: 0,
        stdout: "",
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.000Z",
      },
      executionRef: { kind: "execution", id: `${action.command}:execution` },
      ...(observation ? { observation: { type: "runtime-info", data: observation, observedAt: "2026-01-01T00:00:00.000Z" } } : {}),
    }
  },
}

const results = await runWordPressEpisodeActions(fakeEpisode, [
  { command: "wp-cli", args: ["option", "get", "siteurl"] },
  { command: "wordpress.browser-probe", args: ["url=/"] },
], {
  observation: { type: "runtime-info" },
  onActionStart: (action, index) => calls.push(`start:${index}:${action.command}`),
  onActionFinish: (result, index) => calls.push(`finish:${index}:${result.execution.command}`),
})

assert.deepEqual(calls, [
  "start:0:wp-cli",
  "finish:0:wp-cli",
  "start:1:wordpress.browser-probe",
  "finish:1:wordpress.browser-probe",
])
assert.equal(results.length, 2)
assert.equal(results[0]?.execution.command, "wp-cli")
assert.equal(results[1]?.execution.command, "wordpress.browser-probe")

const artifactBundle = { id: "bundle", directory: "artifacts/runtime", contentDigest: "digest", createdAt: "2026-01-01T00:00:00.000Z" }
assert.equal(await collectWordPressRuntimeArtifacts({ async collectArtifacts() { return artifactBundle } }), artifactBundle)
assert.equal(await collectWordPressEpisodeArtifacts({ async collectArtifacts() { return artifactBundle } }), artifactBundle)

console.log("wordpress runtime public facade ok")
