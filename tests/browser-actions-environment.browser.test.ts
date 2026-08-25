import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runBrowserActionsCommand, runBrowserScenarioCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { runBrowserProbeCommand } from "../packages/runtime-playground/src/browser-probe-runner.js"
import type { BrowserArtifact } from "../packages/runtime-playground/src/browser-artifacts.js"
import { isBrowserCommandArtifactError } from "../packages/runtime-playground/src/browser-command-artifact-error.js"
import { closeHttpServer, listenLocalHttpServer, withPreviewProxy, type PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

const runtimeSpec = wordpressRuntimeSpec({ commands: ["wordpress.browser-actions", "wordpress.browser-actions.evaluate", "wordpress.browser-probe", "wordpress.browser-scenario"] })

test("standalone probes use the shared environment context adapter", async () => {
  const fixture = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-probe-environment-"))
  try {
    const result = await runBrowserProbeCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-probe", args: ["url=/", "device=Pixel 5", "geolocation-latitude=32.7765", "geolocation-longitude=-79.9311", "geolocation-permission=granted", "script=return { touch: navigator.maxTouchPoints > 0, permission: (await navigator.permissions.query({ name: 'geolocation' })).state }", "capture=console"] },
    })
    assert.deepEqual(result.artifact.summary.scriptResult, { touch: true, permission: "granted" })
    assert.equal(result.artifact.summary.viewport?.hasTouch, true)
    assert.equal(result.artifact.summary.context?.requested.device, "Pixel 5")
  } finally {
    await fixture.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("browser actions preserve granted, denied, and prompt environments without leaking between runs", async () => {
  const fixture = await browserFixture()
  try {
    const granted = await runEnvironment(fixture, "granted", `({ permission: (await navigator.permissions.query({ name: "geolocation" })).state, coordinates: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(({ coords }) => resolve([coords.latitude, coords.longitude, coords.accuracy]), ({ code }) => resolve(code), { timeout: 500 })), mobile: /Mobile|Android/.test(navigator.userAgent), touch: navigator.maxTouchPoints > 0 })`, { permission: "granted", coordinates: [32.7765, -79.9311, 9], mobile: true, touch: true })
    assert.deepEqual(granted.summary.environment?.requested.geolocation, { latitude: 32.7765, longitude: -79.9311, accuracy: 9, permission: "granted" })
    assert.equal(granted.summary.viewport?.isMobile, true)
    assert.equal(granted.summary.viewport?.hasTouch, true)

    const denied = await runEnvironment(fixture, "denied", `({ permission: (await navigator.permissions.query({ name: "geolocation" })).state, result: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve(0), ({ code }) => resolve(code), { timeout: 500 })) })`, { permission: "denied", result: 1 })
    assert.equal(denied.summary.environment?.resolved.geolocation?.permission, "denied")
    assert.equal(denied.summary.environment?.observed?.geolocationPermission, "denied")

    const prompt = await runEnvironment(fixture, "prompt", `(await navigator.permissions.query({ name: "geolocation" })).state`, "prompt")
    assert.equal(prompt.summary.environment?.resolved.geolocation?.permission, "prompt")
    assert.equal(prompt.summary.environment?.observed?.geolocationPermission, "prompt")
    assert.deepEqual(prompt.summary.environment?.unsupported, [])
  } finally {
    await fixture.close()
  }
})

test("authored scenarios preserve init-script and page state from probe collection into actions", async () => {
  const fixture = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-environment-"))
  try {
    const result = await runBrowserScenarioCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: {
        command: "wordpress.browser-scenario",
        args: [`scenario-json=${JSON.stringify({
          url: "/",
          profile: "mobile-chrome",
          environment: { userAgent: "Scenario Continuity Agent", permissions: ["notifications"], geolocation: { latitude: 51.5072, longitude: -0.1276, permission: "granted" } },
          captures: ["performance", "steps"],
          prePageScript: "globalThis.__scenarioInit = { token: 'probe-owned' }; sessionStorage.setItem('scenario-state', 'preserved')",
          steps: [{ kind: "evaluate", expression: `({ permission: (await navigator.permissions.query({ name: "geolocation" })).state, notifications: (await navigator.permissions.query({ name: "notifications" })).state, touch: navigator.maxTouchPoints > 0, userAgent: navigator.userAgent, init: globalThis.__scenarioInit?.token, state: sessionStorage.getItem('scenario-state') })`, assert: { permission: "granted", notifications: "granted", touch: true, userAgent: "Scenario Continuity Agent", init: "probe-owned", state: "preserved" } }],
        })}`],
      },
    })
    assert.equal(result.artifact.artifactType, "scenario")
    assert.equal(result.artifact.summary.environment?.requested.geolocation?.latitude, 51.5072)
    assert.equal(result.artifact.summary.environment?.requested.device, "Pixel 5")
    assert.equal(result.artifact.summary.environment?.resolved.isMobile, true)
    assert.equal(result.artifact.summary.environment?.resolved.hasTouch, true)
    assert.equal(result.artifact.summary.environment?.observed?.hasTouch, true)
    assert(result.artifact.summary.environment?.inconclusive.includes("browser.environment.device"))
    assert.equal(Object.prototype.hasOwnProperty.call(result.artifact.summary.environment ?? {}, "effective"), false)
    const output = JSON.parse(result.output)
    assert(output.scenario.files.probeSummary)
    assert(output.scenario.files.actionSummary)
  } finally {
    await fixture.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("shared probe and actions sessions preserve canonical proxy transport and topology evidence", async () => {
  const canonicalHost = "shared-scenario.invalid"
  const upstreamRequests: Array<{ host?: string; url?: string }> = []
  const upstream = createServer((request, response) => {
    upstreamRequests.push({ host: request.headers.host, url: request.url })
    response.setHeader("content-type", "text/html")
    response.end("<!doctype html><title>Shared canonical scenario</title><button>Continue</button>")
  })
  const upstreamUrl = await listenLocalHttpServer(upstream)
  const proxy = await withPreviewProxy({
    playground: { async run() { return { text: "", exitCode: 0 } } },
    serverUrl: upstreamUrl,
    async [Symbol.asyncDispose]() {},
  } satisfies PlaygroundCliServer, 0)
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-canonical-"))
  const canonicalUrl = `http://${canonicalHost}/preview/`
  try {
    const result = await runBrowserScenarioCommand({
      artifactRoot,
      runtimeSpec: { ...runtimeSpec, preview: { siteUrl: canonicalUrl } },
      server: proxy,
      spec: {
        command: "wordpress.browser-scenario",
        args: [
          `scenario-json=${JSON.stringify({
            url: canonicalUrl,
            captures: ["performance", "steps", "network"],
            prePageScript: "sessionStorage.setItem('shared-scenario-state', 'probe-preserved')",
            steps: [{ kind: "evaluate", expression: "({ origin: location.origin, state: sessionStorage.getItem('shared-scenario-state') })", assert: { origin: `http://${canonicalHost}`, state: "probe-preserved" } }],
          })}`,
          `route-host=${canonicalHost}`,
        ],
      },
    })

    assert.equal(new URL(result.artifact.canonicalBrowserOrigin!).origin, `http://${canonicalHost}`)
    assert.equal(new URL(result.artifact.localProxyOrigin!).origin, new URL(proxy.serverUrl).origin)
    assert.equal(new URL(result.artifact.upstreamRuntimeOrigin!).origin, new URL(upstreamUrl).origin)
    assert.equal(new URL(result.artifact.summary.finalUrl).hostname, canonicalHost)
    assert(upstreamRequests.some((request) => request.host === canonicalHost && request.url === "/preview/"), JSON.stringify(upstreamRequests))
    const output = JSON.parse(result.output)
    assert.equal(output.scenario.summary.probe.finalUrl, canonicalUrl)
    assert.equal(output.scenario.summary.actions.finalUrl, canonicalUrl)
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await proxy[Symbol.asyncDispose]()
    await closeHttpServer(upstream)
  }
})

test("scenario storage state and auth remain available after probe collection", async () => {
  const fixture = await browserFixture()
  try {
    const storageRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-storage-"))
    try {
      const storageState = {
        cookies: [{ name: "scenario_storage_cookie", value: "ready", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
        origins: [{ origin: fixture.server.serverUrl, localStorage: [{ name: "scenario-storage", value: "ready" }] }],
      }
      const stored = await runBrowserScenarioCommand({
        artifactRoot: storageRoot,
        runtimeSpec,
        server: fixture.server,
        spec: { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: "/", captures: ["performance", "steps"], steps: [{ kind: "evaluate", expression: "({ storage: localStorage.getItem('scenario-storage'), importedCookie: document.cookie.includes('scenario_storage_cookie=ready'), authCookie: document.cookie.includes('scenario_auth=ready') })", assert: { storage: "ready", importedCookie: true, authCookie: false } }] })}`, `storage-state=${JSON.stringify(storageState)}`] },
      })
      assert.equal(stored.artifact.summary.auth?.mode, "storage-state")
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }

    const authRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-auth-"))
    try {
      const authenticated = await runBrowserScenarioCommand({
        artifactRoot: authRoot,
        runtimeSpec,
        server: fixture.server,
        runPlaygroundCommand: async () => ({ exitCode: 0, text: JSON.stringify([{ name: "scenario_auth", value: "ready", domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }]) }),
        spec: { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: "/", captures: ["performance", "steps"], auth: "wordpress-admin", authUserId: 7, steps: [{ kind: "evaluate", expression: "({ authCookie: document.cookie.includes('scenario_auth=ready'), importedCookie: document.cookie.includes('scenario_storage_cookie=ready'), storage: localStorage.getItem('scenario-storage') })", assert: { authCookie: true, importedCookie: false, storage: null } }] })}`] },
      })
      assert.equal(authenticated.artifact.summary.auth?.mode, "wordpress-admin")
      assert.equal(authenticated.artifact.summary.auth?.userId, 7)
    } finally {
      await rm(authRoot, { recursive: true, force: true })
    }

    const isolatedStorageRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-storage-isolated-"))
    try {
      const storageState = {
        cookies: [{ name: "scenario_storage_cookie", value: "ready", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
        origins: [{ origin: fixture.server.serverUrl, localStorage: [{ name: "scenario-storage", value: "ready" }] }],
      }
      await runBrowserScenarioCommand({
        artifactRoot: isolatedStorageRoot,
        runtimeSpec,
        server: fixture.server,
        spec: { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: "/", captures: ["performance", "steps"], steps: [{ kind: "evaluate", expression: "({ storage: localStorage.getItem('scenario-storage'), importedCookie: document.cookie.includes('scenario_storage_cookie=ready'), authCookie: document.cookie.includes('scenario_auth=ready') })", assert: { storage: "ready", importedCookie: true, authCookie: false } }] })}`, `storage-state=${JSON.stringify(storageState)}`] },
      })
    } finally {
      await rm(isolatedStorageRoot, { recursive: true, force: true })
    }
  } finally {
    await fixture.close()
  }
})

test("scenario declarations override command arguments and reject unknown profiles", async () => {
  const fixture = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-precedence-"))
  try {
    const result = await runBrowserScenarioCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: {
        command: "wordpress.browser-scenario",
        args: [
          `scenario-json=${JSON.stringify({ url: "/", profile: "mobile-chrome", viewport: "800x600", environment: { geolocation: { latitude: 51.5072, longitude: -0.1276, permission: "granted" } }, steps: [{ kind: "evaluate", expression: "({ width: innerWidth, height: innerHeight, permission: (await navigator.permissions.query({ name: 'geolocation' })).state })", assert: { width: 800, height: 600, permission: "granted" } }] })}`,
          "viewport=320x640",
          "device=Desktop Chrome",
          "geolocation-latitude=32.7765",
          "geolocation-longitude=-79.9311",
          "geolocation-permission=denied",
        ],
      },
    })
    assert.deepEqual(result.artifact.summary.environment?.requested.viewport, { width: 800, height: 600 })
    assert.equal(result.artifact.summary.environment?.requested.device, "Pixel 5")
    assert.equal(result.artifact.summary.environment?.requested.geolocation?.latitude, 51.5072)
    assert.equal(result.artifact.summary.environment?.observed?.geolocationPermission, "granted")

    const unknownProfileRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-profile-"))
    try {
      await assert.rejects(runBrowserScenarioCommand({
        artifactRoot: unknownProfileRoot,
        runtimeSpec,
        server: fixture.server,
        spec: { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: "/", profile: "unknown-mobile" })}`] },
      }), /unknown profile: unknown-mobile/)
    } finally {
      await rm(unknownProfileRoot, { recursive: true, force: true })
    }
  } finally {
    await fixture.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("unsupported action environments fail with structured requested and unsupported evidence", async () => {
  const fixture = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-actions-unsupported-"))
  try {
    await assert.rejects(runBrowserActionsCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-actions", args: ["url=/", "device=Unknown Device", "capture=steps"] },
    }), (error: unknown) => {
      assert(isBrowserCommandArtifactError(error))
      assert.equal(error.artifact.summary.environment?.requested.device, "Unknown Device")
      assert.deepEqual(error.artifact.summary.environment?.unsupported, ["browser.environment.device"])
      assert.equal(error.artifact.summary.environment?.capabilities.find(({ id }) => id === "browser.environment.device")?.fidelity, "unsupported")
      return true
    })
  } finally {
    await fixture.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("adaptive actions retain their declared environment through routed preview origins", async () => {
  const fixture = await browserFixture()
  const routedHost = "browser-actions.test"
  try {
    const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-actions-adaptive-"))
    try {
      const result = await runBrowserActionsCommand({
        artifactRoot,
        runtimeSpec,
        server: fixture.server,
        spec: {
          command: "wordpress.browser-actions",
          args: [
            `adaptive-exploration-json=${JSON.stringify({ schema: "wp-codebox/browser-adaptive-exploration/v1", startUrl: `http://${routedHost}:${fixture.port}/`, seed: "environment", environment: { device: "Pixel 5" }, budgets: { maxStates: 2, maxTransitions: 2, maxDepth: 1, maxDurationMs: 2_000, maxArtifactBytes: 100_000 }, failOnFinding: false })}`,
            `route-host=${routedHost}`,
            "capture=steps",
          ],
        },
      })
      assert.equal(new URL(result.artifact.requestedUrl).hostname, routedHost)
      assert.equal(result.artifact.summary.viewport?.isMobile, true)
      assert.equal(result.artifact.summary.viewport?.hasTouch, true)
      assert.equal(result.artifact.summary.environment?.resolved.device, "Pixel 5")
      assert.equal(result.artifact.summary.adaptiveExploration?.schema, "wp-codebox/browser-adaptive-exploration/v1")
      const adaptiveArtifact = JSON.parse(await readFile(join(artifactRoot, "files/browser/adaptive-exploration.json"), "utf8"))
      assert.equal(adaptiveArtifact.result.replay.environment.device, "Pixel 5")
      assert.equal(adaptiveArtifact.result.replay.environmentDigest, adaptiveArtifact.contract.environmentDigest)

      await assert.rejects(runBrowserActionsCommand({
        artifactRoot,
        runtimeSpec,
        server: fixture.server,
        spec: {
          command: "wordpress.browser-actions",
          args: [
            `adaptive-exploration-json=${JSON.stringify({ schema: "wp-codebox/browser-adaptive-exploration/v1", startUrl: "/", environment: { locale: "en-GB" } })}`,
            "device=Pixel 5",
          ],
        },
      }), /environment cannot be combined with outer browser environment arguments/)
    } finally {
      await rm(artifactRoot, { recursive: true, force: true })
    }
  } finally {
    await fixture.close()
  }
})

test("browser actions close active Playwright work when the runtime signal aborts", async () => {
  const fixture = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-actions-cancellation-"))
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), 50)
  try {
    await assert.rejects(runBrowserActionsCommand({
      abortSignal: controller.signal,
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: {
        command: "wordpress.browser-actions",
        args: [`steps-json=${JSON.stringify([{ kind: "navigate", url: "/" }, { kind: "evaluate", expression: "await new Promise(() => {})" }])}`, "capture=steps"],
      },
    }), /aborted during runtime cleanup/)
    assert(Date.now() - started < 1_000, "browser cleanup must settle within the adversarial cancellation grace period")
  } finally {
    clearTimeout(timer)
    await fixture.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test("scenario steps-json file payloads execute instead of being dropped", async () => {
  const fixture = await browserFixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-browser-scenario-steps-file-"))
  try {
    const stepsPath = join(artifactRoot, "steps.json")
    await writeFile(stepsPath, JSON.stringify([{ kind: "evaluate", expression: "document.title", assert: "" }]))
    const result = await runBrowserScenarioCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: { command: "wordpress.browser-scenario", args: ["url=/", `steps-json=@${stepsPath}`, "capture=steps"] },
    })
    assert.equal(result.artifact.summary.actions, 2)
  } finally {
    await fixture.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

async function runEnvironment(fixture: Awaited<ReturnType<typeof browserFixture>>, permission: "granted" | "denied" | "prompt", expression: string, expected: unknown): Promise<BrowserArtifact> {
  const artifactRoot = await mkdtemp(join(tmpdir(), `wp-codebox-browser-actions-${permission}-`))
  try {
    const result = await runBrowserActionsCommand({
      artifactRoot,
      runtimeSpec,
      server: fixture.server,
      spec: {
        command: "wordpress.browser-actions",
        args: [
          `url=http://localhost:${fixture.port}/`,
          `steps-json=${JSON.stringify([{ kind: "evaluate", expression, assert: expected }])}`,
          "device=Pixel 5",
          "geolocation-latitude=32.7765",
          "geolocation-longitude=-79.9311",
          "geolocation-accuracy=9",
          `geolocation-permission=${permission}`,
          "route-host=localhost",
          "capture=steps",
        ],
      },
    })
    return result.artifact
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
}

async function browserFixture(): Promise<{ port: number; server: PlaygroundCliServer; close(): Promise<void> }> {
  const httpServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html")
    response.end("<!doctype html><meta name=viewport content='width=device-width'><button>Explore</button>")
  })
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
  const address = httpServer.address()
  assert(address && typeof address === "object")
  const server = {
    serverUrl: `http://127.0.0.1:${address.port}`,
    playground: { async run() { return { text: "", exitCode: 0 } } },
    async [Symbol.asyncDispose]() {},
  } satisfies PlaygroundCliServer
  return {
    port: address.port,
    server,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
  }
}
