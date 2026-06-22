import assert from "node:assert/strict"
import {
  collectWordPressArtifacts,
  openWordPressAdminPage,
  openWordPressEditor,
  probeWordPressBrowser,
  requestWordPressRest,
  runWordPressBrowserAction,
  runWordPressPhp,
  runWordPressWpCli,
  visitWordPressPage,
  type WordPressRuntimeActionEpisode,
} from "../packages/runtime-playground/src/public.js"

const calls: Array<{ command: string; args: string[]; kind?: string; timeoutMs?: number }> = []

const fakeEpisode: WordPressRuntimeActionEpisode = {
  async step(action, observation) {
    calls.push({ command: action.command, args: action.args ?? [], kind: action.kind, timeoutMs: action.timeoutMs })
    return {
      id: `${action.command}:step`,
      index: calls.length - 1,
      action: {
        schema: "wp-codebox/runtime-episode-action/v1",
        id: `${action.command}:action`,
        kind: action.kind ?? "command",
        command: action.command,
        args: action.args ?? [],
        digest: { algorithm: "sha256", value: action.command },
      },
      actionRef: { kind: "action", id: `${action.command}:action` },
      execution: {
        id: `${action.command}:execution`,
        command: action.command,
        args: action.args ?? [],
        exitCode: 0,
        stdout: action.command.includes("browser") || action.command.includes("editor") || action.command.includes("rest") ? JSON.stringify({ performance: { timing: { durationMs: 12 }, memory: { peakBytes: 1234 }, database: { queryCount: 2, repeatedQueries: [{ fingerprint: "SELECT ?", count: 2 }] } } }) : "ok\n",
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.000Z",
      },
      executionRef: { kind: "execution", id: `${action.command}:execution` },
      ...(observation ? { observation: { type: "runtime-info", data: {}, observedAt: "2026-01-01T00:00:00.000Z" } } : {}),
    }
  },
}

await runWordPressWpCli(fakeEpisode, "option get siteurl")
await runWordPressPhp(fakeEpisode, { code: "echo get_bloginfo('name');", bootstrap: "wordpress", timeout_ms: 5000 })
await requestWordPressRest(fakeEpisode, { path: "/wp/v2/types", method: "GET" })
await runWordPressBrowserAction(fakeEpisode, { operation: "navigate", url: "/", capture: ["html"] })
await probeWordPressBrowser(fakeEpisode, { url: "/", wait_for: "load", capture: ["screenshot"] })
await openWordPressEditor(fakeEpisode, { target: "post-new", post_type: "post", capture: ["editor-state"] })
const adminObservation = await openWordPressAdminPage(fakeEpisode, { path: "plugins.php", capture: ["html"] })
const pageObservation = await visitWordPressPage(fakeEpisode, { path: "/sample-page/", capture: ["html"] })

assert.deepEqual(calls.map((call) => call.command), [
  "wordpress.wp-cli",
  "wordpress.run-php",
  "wordpress.rest-request",
  "wordpress.browser-actions",
  "wordpress.browser-probe",
  "wordpress.editor-open",
  "wordpress.browser-probe",
  "wordpress.browser-probe",
])
assert.deepEqual(calls[0]?.args, ["command=option get siteurl"])
assert.ok(calls[1]?.args.includes("code=echo get_bloginfo('name');"))
assert.ok(calls[1]?.args.includes("bootstrap=wordpress"))
assert.equal(calls[1]?.timeoutMs, 5000)
assert.ok(calls[2]?.args.includes("path=/wp/v2/types"))
assert.ok(calls[3]?.args.some((arg) => arg.startsWith("steps-json=")))
assert.ok(calls[4]?.args.includes("url=/"))
assert.ok(calls[5]?.args.includes("target=post-new"))
assert.ok(calls[6]?.args.includes("url=/wp-admin/plugins.php"))
assert.ok(calls[7]?.args.includes("url=/sample-page/"))
assert.equal(adminObservation.performance?.schema, "wp-codebox/performance-observation/v1")
assert.equal(pageObservation.performance?.target, "/sample-page/")

const artifactBundle = { id: "bundle", directory: "artifacts/runtime", contentDigest: "digest", createdAt: "2026-01-01T00:00:00.000Z" }
assert.equal(await collectWordPressArtifacts({ async collectArtifacts() { return artifactBundle } }), artifactBundle)

console.log("wordpress runtime actions ok")
