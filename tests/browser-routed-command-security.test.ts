import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import test from "node:test"

import type { RuntimeCreateSpec } from "../packages/runtime-core/src/runtime-contracts.js"
import { runBrowserActionsCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { runBrowserMultiActorScenarioCommand } from "../packages/runtime-playground/src/browser-multi-actor-scenario-runner.js"
import { runEditorOpenCommand } from "../packages/runtime-playground/src/editor-command-runners.js"
import { closeHttpServer, listenLocalHttpServer, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"
import { withTempDir } from "../scripts/test-kit.js"

const TOKEN = "SENTINEL_ROUTED_COMMAND_TOKEN_2094"
const PUBLIC_URL = `http://routed.test/editor?token=${TOKEN}`
const editorHtml = `<!doctype html><script>
window.wp = {
  blocks: { getBlockTypes: () => [] },
  data: {
    select: (store) => store === 'core/block-editor'
      ? { getBlocks: () => [] }
      : store === 'core/editor'
        ? { getCurrentPostId: () => 1, getCurrentPostType: () => 'post' }
        : {},
    dispatch: () => ({})
  }
}
</script><main>Editor fixture</main>`

test("real actions, editor, and multi-actor commands sanitize artifacts and stdout", async () => {
  const httpServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(editorHtml)
  })
  const serverUrl = await listenLocalHttpServer(httpServer)
  const server = { serverUrl, playground: {} } as PlaygroundCliServer
  const runtimeSpec = { environment: { blueprint: {} } } as RuntimeCreateSpec
  const runPlaygroundCommand = async () => ({ text: "[]", exitCode: 0 })

  try {
    await withTempDir("wp-codebox-real-browser-actions-security-", async (artifactRoot) => {
      const result = await runBrowserActionsCommand({
        artifactRoot,
        plan: { initialUrl: PUBLIC_URL, steps: [], capture: new Set(["steps", "network"]), stepTimeoutMs: 5_000, totalTimeoutMs: 15_000, networkSettleTimeoutMs: 500, maxDomSnapshotElements: 50 },
        runtimeSpec,
        server,
        spec: { command: "wordpress.browser-actions", args: ["route-host=routed.test"] },
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/action-summary.json", "files/browser/network.jsonl"])
    })

    await withTempDir("wp-codebox-real-editor-security-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=${PUBLIC_URL}`, "route-host=routed.test", "capture=steps,errors", "wait-timeout=5s"] },
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/editor-summary.json", "files/browser/editor-steps.jsonl"])
    })

    await withTempDir("wp-codebox-real-multi-actor-security-", async (artifactRoot) => {
      const actorRuntimeSpec = {
        environment: { blueprint: {} },
        metadata: {
          recipe: {
            inputs: {
              fixtureUsers: [{ name: "author", username: "fixture-author", role: "author", userId: 1 }],
              userSessions: [{ name: "author-session", user: "author" }],
            },
          },
        },
      } as RuntimeCreateSpec
      const result = await runBrowserMultiActorScenarioCommand({
        artifactRoot,
        runtimeSpec: actorRuntimeSpec,
        runPlaygroundCommand,
        scenario: {
          schema: "wp-codebox/browser-multi-actor-scenario/v1",
          seed: "route-security",
          url: `${serverUrl}/editor?token=${TOKEN}`,
          actors: [{ name: "author", userSession: "author-session" }],
          actions: [],
          captures: ["steps", "network"],
        },
        server,
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/multi-actor-scenario-summary.json", "files/browser/multi-actor-network.json"])
    })
  } finally {
    await closeHttpServer(httpServer)
  }
})

async function assertCommandSurfacesSafe(result: { artifact: unknown; output: string }, artifactRoot: string, files: string[]): Promise<void> {
  const surfaces: Record<string, string> = {
    artifact: JSON.stringify(result.artifact),
    stdout: result.output,
  }
  for (const file of files) surfaces[file] = await readFile(join(artifactRoot, file), "utf8")
  for (const [surface, contents] of Object.entries(surfaces)) {
    assert.doesNotMatch(contents, new RegExp(TOKEN), `${surface} leaked the synthetic token`)
  }
  assert.match(JSON.stringify(surfaces), /\[redacted\]/)
}
