import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { ArtifactBundleBuilder } from "../packages/runtime-playground/src/artifact-bundle-builder.js"
import { captureMountedFiles, captureMountDiffs } from "../packages/runtime-playground/src/mounted-artifact-capture.js"
import { applyRunnerWorkspacePatch } from "../packages/runtime-core/src/runner-workspace-apply.js"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-trusted-apply-integration-"))
const artifactRoot = join(root, "artifacts")
const trustedRoot = join(root, "trusted")
const baseline = join(root, "baseline")
const mounted = join(root, "mounted")
const host = join(root, "host")
const secretName = "CONFIGURED_SECRET"
const previousChannel = process.env.WP_CODEBOX_TRUSTED_APPLY_ARTIFACT_ROOT

try {
  for (const directory of [baseline, mounted, host, trustedRoot]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "README.md"), `${secretName}\nbefore\n`)
  }
  await writeFile(join(mounted, "README.md"), `${secretName}\nafter\n`)
  await execFileAsync("git", ["init"], { cwd: host })
  process.env.WP_CODEBOX_TRUSTED_APPLY_ARTIFACT_ROOT = trustedRoot

  const mounts = [{ source: mounted, target: "/workspace", mode: "readwrite", metadata: { baselineSource: baseline } }]
  await new ArtifactBundleBuilder({
    artifactRoot,
    runtimeId: "trusted-apply-test",
    runtimeCreatedAt: new Date().toISOString(),
    spec: { environment: { blueprint: {} }, secretEnv: { [secretName]: "secret-value" } },
    mounts,
    commands: [], observations: [], snapshots: [], events: [],
    info: async () => ({ id: "trusted-apply-test", backend: "playground", status: "ready", environment: { version: "latest" } }),
    previewInfo: async () => undefined,
    browserReviewSummary: () => undefined,
    browserArtifacts: () => [],
    captureMountedFiles: (filesDirectory, redactor) => captureMountedFiles(filesDirectory, mounts, redactor),
    captureMountDiffs: (filesDirectory, redactor) => captureMountDiffs(artifactRoot, filesDirectory, mounts, redactor),
    redactBrowserArtifacts: async () => {}, redactPluginCheckArtifacts: async () => {}, redactThemeCheckArtifacts: async () => {},
    browserManifestFiles: () => [], pluginCheckArtifactPaths: () => [], themeCheckArtifactPaths: () => [], observationManifestFiles: () => [], pluginCheckManifestFiles: () => [], themeCheckManifestFiles: () => [],
    formatRuntimeLog: () => "", formatCommandsLog: () => "", recordArtifactsCollected: () => {},
  } as any).build()

  const durablePatch = await readFile(join(artifactRoot, "files", "patch.diff"), "utf8")
  assert(!durablePatch.includes(secretName), "durable artifact redacts configured secret names")
  assert.match(durablePatch, /\[REDACTED:configured-secret-name\]/)
  await assert.rejects(
    applyRunnerWorkspacePatch({
      artifactRoot,
      artifactRefs: [
        { kind: "codebox-patch", path: "files/patch.diff" },
        { kind: "codebox-changed-files", path: "files/changed-files.json" },
      ],
      workspaceRoot: host,
      writablePaths: ["README.md"],
    }),
    /Host git apply failed/,
    "the durable redacted patch cannot apply where configured secret context is unchanged",
  )
  const trustedPatch = await readFile(join(trustedRoot, "files", "patch.diff"), "utf8")
  assert.match(trustedPatch, new RegExp(secretName), "private apply bytes retain unchanged diff context")

  const applied = await applyRunnerWorkspacePatch({
    artifactRoot: trustedRoot,
    artifactRefs: [
      { kind: "codebox-patch", path: "files/patch.diff" },
      { kind: "codebox-changed-files", path: "files/changed-files.json" },
    ],
    workspaceRoot: host,
    writablePaths: ["README.md"],
  })
  assert.equal(applied.status, "applied", "the host applies pre-redaction bytes")
  assert.equal(await readFile(join(host, "README.md"), "utf8"), `${secretName}\nafter\n`)
} finally {
  if (previousChannel === undefined) delete process.env.WP_CODEBOX_TRUSTED_APPLY_ARTIFACT_ROOT
  else process.env.WP_CODEBOX_TRUSTED_APPLY_ARTIFACT_ROOT = previousChannel
  await rm(root, { recursive: true, force: true })
}

console.log("trusted apply artifact channel integration ok")
