import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"
import { runBrowserActionsCommand, runBrowserScenarioCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import type { BrowserArtifact } from "../packages/runtime-playground/src/browser-artifacts.js"
import { isBrowserCommandArtifactError } from "../packages/runtime-playground/src/browser-command-artifact-error.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const runtimeSpec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: {},
  policy: { network: "deny", filesystem: "sandbox", commands: ["wordpress.browser-actions", "wordpress.browser-actions.evaluate", "wordpress.browser-scenario"], secrets: "none", approvals: "never" },
}

test("browser actions preserve granted, denied, and prompt environments without leaking between runs", async () => {
  const fixture = await browserFixture()
  try {
    const granted = await runEnvironment(fixture, "granted", `({ permission: (await navigator.permissions.query({ name: "geolocation" })).state, coordinates: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(({ coords }) => resolve([coords.latitude, coords.longitude, coords.accuracy]), ({ code }) => resolve(code), { timeout: 500 })), mobile: /Mobile|Android/.test(navigator.userAgent), touch: navigator.maxTouchPoints > 0 })`, { permission: "granted", coordinates: [32.7765, -79.9311, 9], mobile: true, touch: true })
    assert.deepEqual(granted.summary.environment?.requested.geolocation, { latitude: 32.7765, longitude: -79.9311, accuracy: 9, permission: "granted" })
    assert.equal(granted.summary.viewport?.isMobile, true)
    assert.equal(granted.summary.viewport?.hasTouch, true)

    const denied = await runEnvironment(fixture, "denied", `({ permission: (await navigator.permissions.query({ name: "geolocation" })).state, result: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve(0), ({ code }) => resolve(code), { timeout: 500 })) })`, { permission: "denied", result: 1 })
    assert.equal(denied.summary.environment?.effective.geolocation?.permission, "denied")

    const prompt = await runEnvironment(fixture, "prompt", `(await navigator.permissions.query({ name: "geolocation" })).state`, "prompt")
    assert.equal(prompt.summary.environment?.effective.geolocation?.permission, "prompt")
    assert.deepEqual(prompt.summary.environment?.unsupported, [])
  } finally {
    await fixture.close()
  }
})

test("authored scenarios carry one declared environment into their action journey", async () => {
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
          environment: { geolocation: { latitude: 51.5072, longitude: -0.1276, permission: "granted" } },
          steps: [{ kind: "evaluate", expression: `({ permission: (await navigator.permissions.query({ name: "geolocation" })).state, touch: navigator.maxTouchPoints > 0 })`, assert: { permission: "granted", touch: true } }],
        })}`],
      },
    })
    assert.equal(result.artifact.artifactType, "scenario")
    assert.equal(result.artifact.summary.environment?.requested.geolocation?.latitude, 51.5072)
    assert.equal(result.artifact.summary.environment?.requested.device, "Pixel 5")
    assert.equal(result.artifact.summary.environment?.effective.isMobile, true)
    assert.equal(result.artifact.summary.environment?.effective.hasTouch, true)
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
            `adaptive-exploration-json=${JSON.stringify({ schema: "wp-codebox/browser-adaptive-exploration/v1", startUrl: `http://${routedHost}:${fixture.port}/`, seed: "environment", budgets: { maxStates: 2, maxTransitions: 2, maxDepth: 1, maxDurationMs: 2_000, maxArtifactBytes: 100_000 }, failOnFinding: false })}`,
            `route-host=${routedHost}`,
            "device=Pixel 5",
            "capture=steps",
          ],
        },
      })
      assert.equal(new URL(result.artifact.summary.finalUrl).hostname, routedHost)
      assert.equal(result.artifact.summary.viewport?.isMobile, true)
      assert.equal(result.artifact.summary.viewport?.hasTouch, true)
      assert.equal(result.artifact.summary.environment?.effective.device, "Pixel 5")
      assert.equal(result.artifact.summary.adaptiveExploration?.schema, "wp-codebox/browser-adaptive-exploration/v1")
    } finally {
      await rm(artifactRoot, { recursive: true, force: true })
    }
  } finally {
    await fixture.close()
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
          "url=/",
          `steps-json=${JSON.stringify([{ kind: "evaluate", expression, assert: expected }])}`,
          "device=Pixel 5",
          "geolocation-latitude=32.7765",
          "geolocation-longitude=-79.9311",
          "geolocation-accuracy=9",
          `geolocation-permission=${permission}`,
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
