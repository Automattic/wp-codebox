import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { createRuntime } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

const execFileAsync = promisify(execFile)
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-artifacts-"))

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "packages/cli/dist/index.js",
      "recipe-run",
      "--recipe",
      "./examples/recipes/seeded-plugin-workspace.json",
      "--artifacts",
      artifactsDirectory,
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024 * 10,
    },
  )
  const output = JSON.parse(stdout)
  assert.equal(output.success, true)

  const artifacts = output.artifacts
  assert.ok(artifacts.changedFilesPath, "artifact bundle should expose changedFilesPath")
  assert.ok(artifacts.patchPath, "artifact bundle should expose patchPath")
  assert.ok(artifacts.testResultsPath, "artifact bundle should expose testResultsPath")
  assert.ok(artifacts.reviewPath, "artifact bundle should expose reviewPath")

  const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"))
  const metadata = JSON.parse(await readFile(artifacts.metadataPath, "utf8"))
  const changedFiles = JSON.parse(await readFile(artifacts.changedFilesPath, "utf8"))
  const changedFilesJson = await readFile(artifacts.changedFilesPath, "utf8")
  const patch = await readFile(artifacts.patchPath, "utf8")
  const testResults = JSON.parse(await readFile(artifacts.testResultsPath, "utf8"))
  const review = JSON.parse(await readFile(artifacts.reviewPath, "utf8"))
  const contentDigest = createHash("sha256")
    .update("wp-codebox/artifact-content/v1\n")
    .update("files/changed-files.json\n")
    .update(changedFilesJson)
    .update("\nfiles/patch.diff\n")
    .update(patch)
    .digest("hex")

  assert.equal(artifacts.id, `artifact-bundle-sha256-${contentDigest}`)
  assert.equal(artifacts.contentDigest, contentDigest)
  assert.equal(manifest.id, artifacts.id)
  assert.deepEqual(manifest.contentDigest, {
    algorithm: "sha256",
    inputs: ["files/changed-files.json", "files/patch.diff"],
    value: contentDigest,
  })
  assert.deepEqual(metadata.contentDigest, manifest.contentDigest)
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/changed-files.json" && file.kind === "changed-files"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/patch.diff" && file.kind === "patch"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/test-results.json" && file.kind === "test-results"))
  assert.ok(manifest.files.some((file: { path: string; kind: string }) => file.path === "files/review.json" && file.kind === "review"))
  assert.deepEqual(metadata.artifacts, {
    changedFiles: "files/changed-files.json",
    patch: "files/patch.diff",
    testResults: "files/test-results.json",
    review: "files/review.json",
    mountDiffs: "files/diffs.json",
  })
  assert.equal(metadata.provenance.runtime.backend, "wordpress-playground")
  assert.equal(metadata.provenance.runtime.version, "0.0.0")
  assert.equal(metadata.provenance.runtime.wordpressVersion, "latest")
  assert.equal(metadata.provenance.task.kind, "recipe-run")
  assert.equal(metadata.provenance.task.recipePath.endsWith("examples/recipes/seeded-plugin-workspace.json"), true)
  assert.ok(metadata.provenance.task.inputs.workspaces.length > 0)
  assert.ok(metadata.provenance.mounts.some((mount: { target: string; mode: string; metadata?: { kind?: string } }) =>
    mount.target === "/wordpress/wp-content/plugins/seeded-helper" && mount.mode === "readwrite" && mount.metadata?.kind === "recipe-workspace",
  ))
  assert.equal(changedFiles.schema, "wp-codebox/changed-files/v1")
  assert.ok(
    changedFiles.files.some((file: { path: string; status: string }) =>
      file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
    ),
  )
  assert.match(patch, /generated\.txt/)
  assert.match(patch, /\+cooked/)
  assert.equal(testResults.schema, "wp-codebox/test-results/v1")
  assert.equal(testResults.status, "unknown")
  assert.deepEqual(testResults.summary, { total: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 })
  assert.deepEqual(testResults.suites, [])
  assert.ok(testResults.rawLogReferences.some((log: { path: string }) => log.path === "logs/commands.log"))
  assert.equal(review.schema, "wp-codebox/artifact-review/v1")
  assert.equal(review.artifactId, artifacts.id)
  assert.equal(review.provenance.task.kind, "recipe-run")
  assert.equal(review.provenance.runtime.wordpressVersion, "latest")
  assert.equal(review.evidence.patch, "files/patch.diff")
  assert.equal(review.evidence.artifactContentDigest, contentDigest)
  assert.equal(review.evidence.changedFiles, "files/changed-files.json")
  assert.equal(review.evidence.testResults, "files/test-results.json")
  assert.ok(review.changedFiles.some((file: { path: string; status: string }) =>
    file.path === "/wordpress/wp-content/plugins/seeded-helper/generated.txt" && file.status === "added",
  ))
  assert.ok(review.actions.some((action: { kind: string; requiresApprovedFiles?: boolean }) => action.kind === "approve" && action.requiresApprovedFiles === true))
  assert.ok(review.actions.some((action: { kind: string }) => action.kind === "discard"))
  assert.ok(review.progress.some((event: { type: string; label: string }) => event.type === "complete" && event.label === "Ready for your review."))

  const agentMount = join(artifactsDirectory, "agent-mounted-component")
  await mkdir(agentMount, { recursive: true })
  await writeFile(join(agentMount, "component.php"), "<?php // fixture\n")
  const runtime = await createRuntime(
    {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", name: "provenance-smoke", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.run-php"],
        secrets: "none",
        approvals: "never",
      },
      artifactsDirectory,
      metadata: {
        runtime: { version: "0.0.0" },
        task: { kind: "agent-sandbox-run", input: "Cook provenance smoke" },
        agent: { agent: "sandbox-agent", provider: "openai", model: "gpt-5.5" },
      },
    },
    createPlaygroundRuntimeBackend(),
  )
  await runtime.mount({
    type: "directory",
    source: agentMount,
    target: "/wordpress/wp-content/plugins/provenance-smoke",
    mode: "readonly",
    metadata: { kind: "component", slug: "provenance-smoke" },
  })
  const agentArtifacts = await runtime.collectArtifacts({ includeLogs: true })
  const agentMetadata = JSON.parse(await readFile(agentArtifacts.metadataPath, "utf8"))
  const agentReview = JSON.parse(await readFile(agentArtifacts.reviewPath, "utf8"))
  assert.equal(agentMetadata.provenance.task.input, "Cook provenance smoke")
  assert.deepEqual(agentMetadata.provenance.agent, { agent: "sandbox-agent", provider: "openai", model: "gpt-5.5" })
  assert.equal(agentReview.provenance.agent.model, "gpt-5.5")
  assert.ok(agentReview.provenance.mounts.some((mount: { target: string; metadata?: { slug?: string } }) =>
    mount.target === "/wordpress/wp-content/plugins/provenance-smoke" && mount.metadata?.slug === "provenance-smoke",
  ))
  await runtime.destroy()

  console.log("Artifact contract smoke passed")
} finally {
  await rm(artifactsDirectory, { recursive: true, force: true })
}
