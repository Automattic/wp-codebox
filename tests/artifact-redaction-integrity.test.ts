import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { artifactFileDigest, type ArtifactManifest, type Runtime, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { verifyArtifactBundle } from "../packages/runtime-core/src/artifact-bundle-verifier.js"
import { collectRecipeDeclaredArtifacts, materializeTypedRecipeDeclaredArtifacts } from "../packages/cli/src/commands/recipe-declared-artifacts.js"
import { collectPlaygroundArtifacts } from "../packages/runtime-playground/src/runtime-artifact-helpers.js"
import type { BrowserArtifact } from "../packages/runtime-playground/src/browser-artifacts.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-redaction-integrity-"))
const artifactRoot = join(root, "artifacts")
const screenshots = [
  "files/browser/screenshot-gardner-granted-social-operator.png",
  "files/browser/screenshot-ordinary-team-social-denial.png",
]
const secretToken = "sk-abcdefghijklmnopqrstuvwxyz"
interface TypedArtifactIndexFixture {
  artifacts: Array<{
    name: string
    type: string
    payload: { oracleIds: string[] }
    artifact: { path: string; sha256: string }
  }>
}
const typedPayload = {
  schema: "fixture/state-transition-ledger/v1",
  oracleIds: ["state-loss", "authorization-bypass"],
  authorization: "Bearer fixture-authorization-secret",
  api_token: secretToken,
}

try {
  await mkdir(join(artifactRoot, "files/browser"), { recursive: true })
  await Promise.all(screenshots.map((path, index) => writeFile(join(artifactRoot, path), Buffer.from([index + 1]))))
  await writeFile(join(artifactRoot, "files/browser/action-summary.json"), `${JSON.stringify({ schema: "wp-codebox/browser-actions/v1", files: { screenshots } }, null, 2)}\n`)

  const browserArtifact: BrowserArtifact = {
    artifactType: "actions",
    requestedUrl: "https://example.test/",
    url: "https://example.test/",
    preview: { requestedMode: "local", effectiveMode: "local", localOrigin: "https://example.test", effectiveOrigin: "https://example.test", diagnostics: [] },
    files: { screenshots, summary: "files/browser/action-summary.json" },
    summary: { actions: 2, steps: 2, consoleMessages: 0, errors: 0, finalUrl: "https://example.test/", htmlSnapshot: false, networkEvents: 0, replayability: "partial", screenshot: false, viewport: null },
  }
  const artifacts = await collectPlaygroundArtifacts({
    artifactRoot,
    browserProbes: [browserArtifact],
    commands: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    events: [],
    info: async () => ({ id: "artifact-redaction-integrity", backend: "wordpress-playground", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", environment: { kind: "wordpress" } }),
    mounts: [],
    observations: [],
    pluginChecks: [],
    previewInfo: async () => undefined,
    recordArtifactsCollected: () => {},
    runtimeId: "artifact-redaction-integrity",
    snapshots: [],
    spec: { environment: { blueprint: {} } },
    themeChecks: [],
  })

  const recipe = {
    schema: "wp-codebox/recipe/v1",
    runtime: { kind: "wordpress-playground" },
    workflow: { steps: [] },
    artifacts: {
      verify: { enabled: true, strict: true },
      typed: [{ name: "state-transition-ledger", type: "fixture/state-transition-ledger/v1", path: "/tmp/state-transition-ledger.json", contentType: "application/json", parseJson: true }],
    },
  } as unknown as WorkspaceRecipe
  const payloadContents = Buffer.from(JSON.stringify(typedPayload))
  const runtime = {
    execute: async () => ({
      id: "collect-typed-artifact",
      command: "wordpress.run-php",
      args: [],
      exitCode: 0,
      stdout: `${JSON.stringify({ exists: true, type: "file", size: payloadContents.byteLength, sha256: artifactFileDigest(payloadContents).value, parsedJson: typedPayload, contentBase64: payloadContents.toString("base64") })}\n`,
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
    }),
  } as unknown as Runtime
  const declaredArtifacts = await collectRecipeDeclaredArtifacts(recipe, runtime)
  await materializeTypedRecipeDeclaredArtifacts(artifacts, declaredArtifacts)

  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as ArtifactManifest
  for (const screenshot of screenshots) {
    assert.equal(manifest.files.filter((file) => file.path === screenshot).length, 1)
  }
  const index = JSON.parse(await readFile(join(artifactRoot, "files/runtime-evidence/typed-artifacts/index.json"), "utf8")) as TypedArtifactIndexFixture
  assert.equal(index.artifacts[0].name, "state-transition-ledger")
  assert.equal(index.artifacts[0].type, "fixture/state-transition-ledger/v1")
  assert.deepEqual(index.artifacts[0].payload.oracleIds, ["state-loss", "authorization-bypass"])
  const materializedPath = index.artifacts[0].artifact.path as string
  const materializedContents = await readFile(join(artifactRoot, materializedPath), "utf8")
  const materializedPayload = JSON.parse(materializedContents)
  assert.deepEqual(materializedPayload.oracleIds, ["state-loss", "authorization-bypass"])
  assert.equal(materializedPayload.authorization, "[redacted]")
  assert.equal(materializedPayload.api_token, "[redacted]")
  assert.doesNotMatch(`${JSON.stringify(index)}\n${materializedContents}`, new RegExp(secretToken))
  assert.equal(artifactFileDigest(materializedContents).value, index.artifacts[0].artifact.sha256)

  const verification = await verifyArtifactBundle(artifactRoot, { strict: true })
  assert.equal(verification.valid, true, JSON.stringify(verification.violations, null, 2))
  assert.deepEqual(verification.violations, [])
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("artifact redaction integrity ok")
