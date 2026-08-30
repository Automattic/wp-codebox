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
const CANVAS_PRESENTATION_IDENTITY = "a".repeat(64)
const UNRELATED_PRESENTATION_IDENTITY = "b".repeat(64)
const INITIAL_CANVAS_PRESENTATION_IDENTITY = "c".repeat(64)
const REPLACED_CANVAS_PRESENTATION_IDENTITY = "d".repeat(64)
const DELAYED_CANVAS_PRESENTATION_IDENTITY = "e".repeat(64)
const PARENT_CANVAS_PRESENTATION_IDENTITY = "f".repeat(64)
const SLOW_PRESENTATION_IDENTITY = "1".repeat(64)
const PENDING_STYLES_PRESENTATION_IDENTITY = "2".repeat(64)
const matchedPresentationMarkup = `<style>html,body{margin:0}.block-editor-block-list__layout{box-sizing:border-box;width:200px;height:400px;background:linear-gradient(#123,#abc);color:white;padding:12px}</style><div class="block-editor-block-list__layout">Matched presentation</div>`
const editorShell = `<!doctype html><script>
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
</script><main>Editor fixture</main>`
const editorHtml = `${editorShell}<iframe name="unrelated" srcdoc="<style>/* blocks-engine-presentation:${UNRELATED_PRESENTATION_IDENTITY} */<\/style>"></iframe><iframe name="editor-canvas" srcdoc="<script>globalThis.__name = (value) => value;setTimeout(() => { const style = document.createElement('style'); style.textContent = '/* blocks-engine-presentation:${CANVAS_PRESENTATION_IDENTITY} */'; document.head.append(style) }, 400)<\/script><div class='block-editor-block-list__layout'><div class='block-editor-block-list__block' data-block='fixture'>Block</div></div>"></iframe>`
const onboardingEditorHtml = `${editorShell}<script>setTimeout(() => document.body.insertAdjacentHTML('afterbegin', '<div class=components-guide>Late guide without controls</div>'), 1000); const fixtureSelect = wp.data.select; wp.data.select = (store) => store === 'core/edit-post' ? { isFeatureActive: () => true } : fixtureSelect(store); wp.data.dispatch = (store) => store === 'core/preferences' ? { set: (scope, feature, value) => { if (scope === 'core/edit-post' && feature === 'welcomeGuide' && value === false) document.querySelector('.components-guide')?.remove() } } : store === 'core/edit-post' ? { toggleFeature: () => { document.body.insertAdjacentHTML('afterbegin', '<div class=components-guide>Retoggled guide</div>') } } : ({})<\/script><iframe name="editor-canvas" srcdoc="<div class='block-editor-block-list__layout'><div class='block-editor-block-list__block' data-block='fixture'>Block</div></div>"></iframe>`
const matchedPresentationEditorHtml = `${editorShell}<iframe name="editor-canvas" style="border:0;width:200px;height:80px" srcdoc="${matchedPresentationMarkup.replaceAll('"', '&quot;')}"></iframe>`
const parentCanvasEditorHtml = `${editorShell}<style>/* blocks-engine-presentation:${PARENT_CANVAS_PRESENTATION_IDENTITY} */</style><div class="block-editor-block-list__layout"><div class="block-editor-block-list__block" data-block="fixture">Block</div></div>`
const replacingCanvasEditorHtml = `${editorShell}<iframe name="editor-canvas" srcdoc="<style>/* blocks-engine-presentation:${INITIAL_CANVAS_PRESENTATION_IDENTITY} */<\/style>"></iframe><script>setTimeout(() => { document.querySelector('iframe[name=editor-canvas]').srcdoc = '<style>/* blocks-engine-presentation:${REPLACED_CANVAS_PRESENTATION_IDENTITY} */<\\/style>' }, 150)</script>`
const delayedCanvasEditorHtml = `${editorShell}<div class="block-editor-block-list__layout"><div class="block-editor-block-list__block" data-block="transition">Transition</div></div><script>setTimeout(() => { const iframe = document.createElement('iframe'); iframe.name = 'editor-canvas'; iframe.srcdoc = '<style>/* blocks-engine-presentation:${DELAYED_CANVAS_PRESENTATION_IDENTITY} */<\\/style>'; document.body.append(iframe) }, 300)</script>`
const slowPresentationEditorHtml = `${editorShell}<iframe name="editor-canvas" srcdoc="<script>setTimeout(() => { const style = document.createElement('style'); style.textContent = '/* blocks-engine-presentation:${SLOW_PRESENTATION_IDENTITY} */'; document.head.append(style) }, 3500)<\/script><div class='block-editor-block-list__layout'><div class='block-editor-block-list__block' data-block='slow'>Slow</div></div>"></iframe>`
const pendingStylesEditorHtml = `${editorShell}<iframe name="editor-canvas" srcdoc="<link rel='stylesheet' href='http://127.0.0.1:9/unavailable.css'><style>/* blocks-engine-presentation:${PENDING_STYLES_PRESENTATION_IDENTITY} */<\/style><div class='block-editor-block-list__layout'><div class='block-editor-block-list__block' data-block='pending'>Pending</div></div>"></iframe>`

test("real browser commands sanitize console, artifacts, stdout, and failure stderr", async () => {
  const httpServer = createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    response.end(request.url?.startsWith("/broken")
      ? "<main>Broken editor fixture</main>"
      : request.url?.startsWith("/presentation")
        ? "<main>Deliberately different frontend fixture</main>"
      : request.url?.startsWith("/matched-frontend")
        ? matchedPresentationMarkup
      : request.url?.startsWith("/matched-editor")
        ? matchedPresentationEditorHtml
      : request.url?.startsWith("/onboarding-editor")
        ? onboardingEditorHtml
      : request.url?.startsWith("/parent-canvas")
        ? parentCanvasEditorHtml
        : request.url?.startsWith("/replacing-canvas")
          ? replacingCanvasEditorHtml
          : request.url?.startsWith("/delayed-canvas")
            ? delayedCanvasEditorHtml
            : request.url?.startsWith("/slow-presentation")
              ? slowPresentationEditorHtml
              : request.url?.startsWith("/pending-styles")
                ? pendingStylesEditorHtml
              : editorHtml)
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
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { iframeCount: number; generatedPresentationIdentities: string[] } } }
      assert.deepEqual(output.summary.editorPresentation, {
        schema: "wp-codebox/editor-presentation/v1",
        canvasDocumentType: "iframe",
        iframeCount: 1,
        iframeStylesheetUrlCount: 0,
        iframeStylesheetUrls: [],
        generatedPresentationIdentityCount: 1,
        generatedPresentationIdentities: [CANVAS_PRESENTATION_IDENTITY],
        idleCanvas: { schema: "wp-codebox/editor-idle-canvas/v1", status: "captured", onboardingModalCount: 0 },
        matchedRendering: { schema: "wp-codebox/editor-presentation-match/v1", status: "unavailable", diagnostic: "presentation-url was not supplied" },
      })
    })

    await withTempDir("wp-codebox-editor-presentation-match-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=${PUBLIC_URL}`, "presentation-url=/presentation", "route-host=routed.test", "capture=steps", "wait-timeout=5s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { matchedRendering: { status: string; frontendScreenshot: string; editorScreenshot: string; diffScreenshot: string; equivalentCanvasWidths: boolean; majorGeometryDrift: boolean; unreadableContent: boolean; hiddenContent: boolean; unresolvedAssetCount: number } } } }
      const { geometry, ...matchedRendering } = output.summary.editorPresentation.matchedRendering as typeof output.summary.editorPresentation.matchedRendering & { geometry: { frontend: { childCount: number }; liveEditor: { childCount: number }; isolatedEditor: { childCount: number } } }
      assert.deepEqual(matchedRendering, {
        schema: "wp-codebox/editor-presentation-match/v1",
        status: "failed",
        equivalentCanvasWidths: true,
        majorGeometryDrift: true,
        unreadableContent: false,
        hiddenContent: false,
        unresolvedAssetCount: 0,
        frontendScreenshot: "files/browser/presentation-frontend.png",
        editorScreenshot: "files/browser/presentation-editor.png",
        diffScreenshot: "files/browser/presentation-diff.png",
      })
      assert.equal(geometry.frontend.childCount, 1)
      assert.equal(geometry.liveEditor.childCount, 1)
      assert.equal(geometry.isolatedEditor.childCount, 1)
      await assertCommandSurfacesSafe(result, artifactRoot, ["files/browser/presentation-frontend.png", "files/browser/presentation-editor.png", "files/browser/presentation-diff.png"])
    })

    await withTempDir("wp-codebox-editor-presentation-iframe-viewport-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: ["url=http://routed.test/matched-editor", "presentation-url=/matched-frontend", "route-host=routed.test", "capture=steps", "wait-timeout=5s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { matchedRendering: { status: string } } } }
      assert.equal(output.summary.editorPresentation.matchedRendering.status, "passed")
    })

    await withTempDir("wp-codebox-editor-onboarding-preference-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: ["url=http://routed.test/onboarding-editor", "route-host=routed.test", "capture=steps", "wait-timeout=5s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { idleCanvas: { onboardingModalCount: number } } } }
      assert.equal(output.summary.editorPresentation.idleCanvas.onboardingModalCount, 0)
    })

    await withTempDir("wp-codebox-real-editor-parent-canvas-security-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=http://routed.test/parent-canvas?token=${TOKEN}`, "route-host=routed.test", "capture=steps", "wait-timeout=5s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { canvasDocumentType: string; iframeCount: number; generatedPresentationIdentities: string[] } } }
      assert.equal(output.summary.editorPresentation.canvasDocumentType, "parent")
      assert.equal(output.summary.editorPresentation.iframeCount, 0)
      assert.deepEqual(output.summary.editorPresentation.generatedPresentationIdentities, [PARENT_CANVAS_PRESENTATION_IDENTITY])
    })

    await withTempDir("wp-codebox-real-editor-replacing-canvas-security-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=http://routed.test/replacing-canvas?token=${TOKEN}`, "route-host=routed.test", "capture=steps", "wait-timeout=5s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { generatedPresentationIdentities: string[] } } }
      assert.deepEqual(output.summary.editorPresentation.generatedPresentationIdentities, [REPLACED_CANVAS_PRESENTATION_IDENTITY])
    })

    await withTempDir("wp-codebox-real-editor-delayed-canvas-security-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=http://routed.test/delayed-canvas?token=${TOKEN}`, "route-host=routed.test", "capture=steps", "wait-timeout=5s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { generatedPresentationIdentities: string[] } } }
      assert.deepEqual(output.summary.editorPresentation.generatedPresentationIdentities, [DELAYED_CANVAS_PRESENTATION_IDENTITY])
    })

    await withTempDir("wp-codebox-real-editor-slow-presentation-security-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=http://routed.test/slow-presentation?token=${TOKEN}`, "route-host=routed.test", "capture=steps", "wait-timeout=6s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { generatedPresentationIdentities: string[] } } }
      assert.deepEqual(output.summary.editorPresentation.generatedPresentationIdentities, [SLOW_PRESENTATION_IDENTITY])
    })

    await withTempDir("wp-codebox-real-editor-pending-styles-security-", async (artifactRoot) => {
      const result = await runEditorOpenCommand({
        artifactRoot,
        runPlaygroundCommand,
        runtimeSpec,
        server,
        spec: { command: "wordpress.editor-open", args: [`url=http://routed.test/pending-styles?token=${TOKEN}`, "route-host=routed.test", "capture=steps", "wait-timeout=5s"] },
      })
      const output = JSON.parse(result.output) as { summary: { editorPresentation: { generatedPresentationIdentities: string[] } } }
      assert.deepEqual(output.summary.editorPresentation.generatedPresentationIdentities, [PENDING_STYLES_PRESENTATION_IDENTITY])
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
