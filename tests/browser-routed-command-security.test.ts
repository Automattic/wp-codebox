import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import test from "node:test"

import type { RuntimeCreateSpec } from "../packages/runtime-core/src/runtime-contracts.js"
import { runBrowserActionsCommand, runBrowserScenarioCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { isBrowserCommandArtifactError } from "../packages/runtime-playground/src/browser-command-artifact-error.js"
import { runBrowserMultiActorScenarioCommand } from "../packages/runtime-playground/src/browser-multi-actor-scenario-runner.js"
import { runBrowserProbeCommand } from "../packages/runtime-playground/src/browser-probe-runner.js"
import { runEditorCanvasProbeCommand, runEditorOpenCommand } from "../packages/runtime-playground/src/editor-command-runners.js"
import { closeHttpServer, listenLocalHttpServer, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"
import { withTempDir } from "../scripts/test-kit.js"

const TOKEN = "SENTINEL_ROUTED_COMMAND_TOKEN_2094"
const PUBLIC_URL = `http://routed.test/editor?token=${TOKEN}`
const editorHtml = `<!doctype html><script>
globalThis.__name = (value) => value
console.log('normal console text; inspect ${PUBLIC_URL}')
console.log('relative request /api/check?nonce=${TOKEN}; ordinary words remain')
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
</script><main>Editor fixture</main><iframe name="editor-canvas" srcdoc="<script>globalThis.__name = (value) => value<\/script><div class='block-editor-block-list__layout'><div class='block-editor-block-list__block' data-block='fixture'>Block</div></div>"></iframe>`

test("real browser commands sanitize console, artifacts, stdout, and failure stderr", async () => {
  const httpServer = createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(request.url?.startsWith("/broken") ? "<main>Broken editor fixture</main>" : editorHtml)
  })
  const serverUrl = await listenLocalHttpServer(httpServer)
  const server = { serverUrl, playground: {} } as PlaygroundCliServer
  const runtimeSpec = { environment: { blueprint: {} } } as RuntimeCreateSpec
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
  const runPlaygroundCommand = async () => ({ text: "[]", exitCode: 0 })

  try {
    await withTempDir("wp-codebox-real-browser-actions-security-", async (artifactRoot) => {
      const result = await runBrowserActionsCommand({
        artifactRoot,
        plan: { initialUrl: PUBLIC_URL, steps: [], capture: new Set(["steps", "network", "console"]), stepTimeoutMs: 5_000, totalTimeoutMs: 15_000, networkSettleTimeoutMs: 500, maxDomSnapshotElements: 50 },
        runtimeSpec,
        server,
        spec: { command: "wordpress.browser-actions", args: ["route-host=routed.test"] },
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/action-summary.json", "files/browser/network.jsonl", "files/browser/console.jsonl"])
    })

    await withTempDir("wp-codebox-real-editor-security-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=${PUBLIC_URL}`, "route-host=routed.test", "capture=steps,errors,console", "wait-timeout=5s"] },
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/editor-summary.json", "files/browser/editor-steps.jsonl", "files/browser/editor-console.jsonl"])
    })

    await withTempDir("wp-codebox-real-editor-canvas-security-", async (artifactRoot) => {
      const result = await runEditorCanvasProbeCommand({
        artifactRoot,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-canvas-probe", args: [`url=${PUBLIC_URL}`, "route-host=routed.test", "timeout=5s"] },
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/editor-canvas-summary.json"])
    })

    await withTempDir("wp-codebox-real-multi-actor-security-", async (artifactRoot) => {
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
          browserArgs: [],
          captures: ["steps", "network", "console"],
          environment: {},
        },
        server,
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/multi-actor-scenario-summary.json", "files/browser/multi-actor-network.json", "files/browser/author-console.jsonl"])
    })

    await withTempDir("wp-codebox-real-scenario-security-", async (artifactRoot) => {
      const result = await runBrowserScenarioCommand({
        artifactRoot,
        runtimeSpec,
        server,
        spec: { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: PUBLIC_URL, captures: ["console", "network"] })}`, "route-host=routed.test"] },
      })
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/scenario-summary.json", "files/browser/console.jsonl"])
    })

    await assertFailingCommandStderrSafe("actions", async (artifactRoot) => runBrowserActionsCommand({
      artifactRoot,
      plan: { initialUrl: PUBLIC_URL, steps: [{ kind: "click", selector: "#missing" }], capture: new Set(["errors"]), stepTimeoutMs: 250, totalTimeoutMs: 5_000, networkSettleTimeoutMs: 100, maxDomSnapshotElements: 20 },
      runtimeSpec,
      server,
      spec: { command: "wordpress.browser-actions", args: ["route-host=routed.test"] },
    }))
    await assertFailingCommandStderrSafe("scenario", async (artifactRoot) => runBrowserScenarioCommand({
      artifactRoot,
      runtimeSpec,
      server,
      spec: { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: PUBLIC_URL, captures: ["errors"], steps: [{ kind: "click", selector: "#missing" }], stepTimeout: "250ms", timeout: "5s" })}`, "route-host=routed.test"] },
    }))
    await assertFailingCommandStderrSafe("editor", async (artifactRoot) => runEditorOpenCommand({
      artifactRoot,
      runPlaygroundCommand,
      runtimeSpec,
      server,
      spec: { command: "wordpress.editor-open", args: [`url=http://routed.test/broken?token=${TOKEN}`, "route-host=routed.test", "capture=errors", "wait-timeout=250ms"] },
    }))
    await assertFailingCommandStderrSafe("multi-actor", async (artifactRoot) => runBrowserMultiActorScenarioCommand({
      artifactRoot,
      runtimeSpec: actorRuntimeSpec,
      runPlaygroundCommand,
      scenario: {
        schema: "wp-codebox/browser-multi-actor-scenario/v1",
        seed: "route-security-failure",
        url: `${serverUrl}/editor?token=${TOKEN}`,
        actors: [{ name: "author", userSession: "author-session" }],
        actions: [{ id: "missing-click", actor: "author", step: { kind: "click", selector: "#missing" } }],
        browserArgs: [],
        captures: ["errors"],
        environment: {},
        stepTimeoutMs: 250,
      },
      server,
    }))

    const controller = new AbortController()
    controller.abort()
    await assertFailingCommandStderrSafe("cancelled-probe", async (artifactRoot) => runBrowserProbeCommand({
      abortSignal: controller.signal,
      artifactRoot,
      plan: { url: PUBLIC_URL, capture: new Set(["errors", "network"]), waitFor: "domcontentloaded", durationMs: 0, requestedContext: {}, routeHostDrain: "required", failFast: false, stallTimeoutMs: 0, wallTimeoutMs: 5_000, lifecycleSelectors: [], assertions: [] },
      runtimeSpec,
      server,
      spec: { command: "wordpress.browser-probe", args: ["route-host=routed.test"] },
    }), true)
    await assertFailingCommandStderrSafe("final-checkpoint-lifecycle-probe", async (artifactRoot) => runBrowserProbeCommand({
      artifactRoot,
      plan: {
        url: PUBLIC_URL,
        capture: new Set(["errors", "memory"]),
        waitFor: "domcontentloaded",
        durationMs: 0,
        requestedContext: {},
        script: `Object.defineProperty(window, 'performance', { value: null }); Document.prototype.querySelectorAll = () => { throw new Error('lifecycle ${PUBLIC_URL}') }`,
        routeHostDrain: "required",
        failFast: false,
        stallTimeoutMs: 0,
        wallTimeoutMs: 5_000,
        lifecycleSelectors: ["body"],
        assertions: [],
      },
      runtimeSpec,
      server,
      spec: { command: "wordpress.browser-probe", args: ["route-host=routed.test"] },
    }), true)
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
  for (const [surface, contents] of Object.entries(surfaces).filter(([surface]) => surface.includes("console"))) {
    assert.match(contents, /normal console text/, `${surface} over-redacted ordinary console text`)
  }
  assert.match(JSON.stringify(surfaces), /\[redacted\]/)
}

async function assertFailingCommandStderrSafe(name: string, run: (artifactRoot: string) => Promise<unknown>, requireArtifact = false): Promise<void> {
  await withTempDir(`wp-codebox-${name}-failure-security-`, async (artifactRoot) => {
    let failure: unknown
    try {
      await run(artifactRoot)
    } catch (error) {
      failure = error
    }
    assert(failure instanceof Error, `${name} should fail`)
    assert.doesNotMatch(`${failure.message}\n${failure.stack}`, new RegExp(TOKEN), `${name} stderr leaked the synthetic token`)
    if (isBrowserCommandArtifactError(failure)) {
      assert.doesNotMatch(JSON.stringify((failure as { artifact: unknown }).artifact), new RegExp(TOKEN))
    }
    if (requireArtifact) {
      assert.equal(isBrowserCommandArtifactError(failure), true, `${name} should retain a reviewer-safe artifact`)
      await readFile(join(artifactRoot, "files/browser/summary.json"), "utf8")
    }
  })
}
