import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserArtifact } from "../packages/runtime-playground/src/browser-artifacts.ts"
import { BrowserCommandArtifactError } from "../packages/runtime-playground/src/browser-command-runners.ts"
import { collectPlaygroundArtifacts } from "../packages/runtime-playground/src/runtime-artifact-helpers.ts"

const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-browser-error-artifacts-"))

try {
  const artifactRoot = join(workspace, "artifacts")
  await mkdir(join(artifactRoot, "files/browser"), { recursive: true })
  await writeFile(join(artifactRoot, "files/browser/summary.json"), "{\"status\":\"failed\"}\n")

  const browserArtifact = browserArtifactFixture()
  const error = new BrowserCommandArtifactError("painted-readiness-stabilization exceeded 1000ms", browserArtifact)
  ;(browserArtifact as BrowserArtifact & { self?: unknown }).self = browserArtifact
  ;(browserArtifact as BrowserArtifact & { advisoryFailure?: unknown }).advisoryFailure = error

  const bundle = await collectPlaygroundArtifacts({
    artifactRoot,
    browserProbes: [browserArtifact],
    commands: [],
    createdAt: "2026-06-16T00:00:00.000Z",
    events: [
      {
        id: "event-browser-advisory-failed",
        type: "runtime.browser-command-progress",
        timestamp: "2026-06-16T00:00:01.000Z",
        data: {
          specCommand: "wordpress.browser-actions",
          error,
        },
      },
    ],
    info: async () => ({
      id: "runtime-browser-error-fixture",
      backend: "wordpress-playground",
      environment: { kind: "wordpress", version: "latest" },
      createdAt: "2026-06-16T00:00:00.000Z",
      status: "destroyed",
    }),
    mounts: [],
    observations: [],
    pluginChecks: [],
    previewInfo: async () => undefined,
    recordArtifactsCollected: () => undefined,
    runtimeId: "runtime-browser-error-fixture",
    snapshots: [],
    spec: {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", version: "latest" },
      policy: { network: "deny", filesystem: "readwrite-mounts", commands: [], secrets: "none", approvals: "never" },
    },
    themeChecks: [],
  })

  const runtimeLog = await readFile(bundle.runtimeLogPath, "utf8")
  assert.match(runtimeLog, /BrowserCommandArtifactError/)
  assert.match(runtimeLog, /painted-readiness-stabilization exceeded 1000ms/)
  assert.match(runtimeLog, /"artifactType":"actions"/)
  assert.match(runtimeLog, /"self":"\[circular\]"/)

  const commandsLog = await readFile(bundle.commandsLogPath, "utf8")
  assert.equal(commandsLog, "\n")

  const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"))
  assert.equal(manifest.files.some((file: { path?: string }) => file.path === "files/browser/summary.json"), true)

  console.log("Artifact browser error collection smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

function browserArtifactFixture(): BrowserArtifact {
  return {
    artifactType: "actions",
    requestedUrl: "http://127.0.0.1:9400/",
    url: "http://127.0.0.1:9400/",
    preview: {
      requestedMode: "local",
      mode: "local",
      requestedOrigin: "http://127.0.0.1:9400",
      localOrigin: "http://127.0.0.1:9400",
      effectiveOrigin: "http://127.0.0.1:9400",
      secureContext: false,
      capabilities: [],
      fallbacks: [],
    },
    files: {
      summary: "files/browser/summary.json",
    },
    summary: {
      actions: 1,
      steps: 1,
      consoleMessages: 0,
      errors: 1,
      networkEvents: 0,
      screenshot: false,
      finalUrl: "http://127.0.0.1:9400/",
      windowLocationOrigin: "http://127.0.0.1:9400",
      viewport: null,
      capabilities: [],
      replayability: { status: "not-replayable", reasons: ["advisory failure fixture"] },
    },
  }
}
