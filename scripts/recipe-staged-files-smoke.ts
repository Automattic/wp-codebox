import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-staged-files-smoke")
const recipePath = resolve(workspace, "recipe.json")
const dryRunArtifacts = resolve(workspace, "dry-run-artifacts")
const stagedFileSource = resolve(workspace, "source-file.txt")
const stagedDirectorySource = resolve(workspace, "source-directory")

mkdirSync(stagedDirectorySource, { recursive: true })
writeFileSync(stagedFileSource, "staged file content\n")
writeFileSync(resolve(stagedDirectorySource, "nested.txt"), "staged directory content\n")

writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-staged-files-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    stagedFiles: [
      {
        source: "./source-file.txt",
        target: "/wordpress/wp-content/uploads/staged-file.txt",
      },
      {
        source: "./source-directory",
        target: "/wordpress/wp-content/uploads/staged-directory",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [
          "code=$file = file_get_contents('/wordpress/wp-content/uploads/staged-file.txt'); $dir = file_get_contents('/wordpress/wp-content/uploads/staged-directory/nested.txt'); if ($file !== \"staged file content\\n\") { throw new RuntimeException('staged file missing'); } if ($dir !== \"staged directory content\\n\") { throw new RuntimeException('staged directory missing'); } echo wp_json_encode(array('file' => $file, 'directory' => $dir));",
        ],
      },
    ],
  },
}, null, 2)}\n`)

const beforeDryRunFileContent = readFileSync(stagedFileSource, "utf8")
const beforeDryRunDirectoryContent = readFileSync(resolve(stagedDirectorySource, "nested.txt"), "utf8")
const dryRunResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  dryRunArtifacts,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(dryRunResult.status, 0, dryRunResult.stderr || dryRunResult.stdout)
assert.equal(existsSync(dryRunArtifacts), false, "dry-run must not create artifact directories")
assert.equal(readFileSync(stagedFileSource, "utf8"), beforeDryRunFileContent, "dry-run must not mutate staged file sources")
assert.equal(readFileSync(resolve(stagedDirectorySource, "nested.txt"), "utf8"), beforeDryRunDirectoryContent, "dry-run must not mutate staged directory sources")

const dryRunOutput = JSON.parse(dryRunResult.stdout)
assert.equal(dryRunOutput.success, true)
assert.equal(dryRunOutput.plan.stagedFiles.length, 2)
assert.equal(dryRunOutput.plan.stagedFiles[0].source, stagedFileSource)
assert.equal(dryRunOutput.plan.stagedFiles[0].target, "/wordpress/wp-content/uploads/staged-file.txt")
assert.equal(dryRunOutput.plan.stagedFiles[0].type, "file")
assert.equal(dryRunOutput.plan.stagedFiles[0].provenance.kind, "local")
assert.equal(dryRunOutput.plan.stagedFiles[1].source, stagedDirectorySource)
assert.equal(dryRunOutput.plan.stagedFiles[1].target, "/wordpress/wp-content/uploads/staged-directory")
assert.equal(dryRunOutput.plan.stagedFiles[1].type, "directory")
assert.equal(dryRunOutput.plan.mounts.some((mount: { target: string; planned: string }) => mount.target === "/wordpress/wp-content/uploads/staged-file.txt" && mount.planned === "generated"), true)

const runResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  resolve(workspace, "artifacts"),
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(runResult.status, 0, runResult.stderr || runResult.stdout)
const runOutput = JSON.parse(runResult.stdout)
assert.equal(runOutput.success, true)
assert.equal(runOutput.stagedFiles.length, 2)
assert.equal(runOutput.stagedFiles[0].action, "staged")
assert.equal(runOutput.stagedFiles[0].source, stagedFileSource)
assert.equal(runOutput.stagedFiles[1].source, stagedDirectorySource)
const workflowResult = JSON.parse(runOutput.executions[0].stdout)
assert.equal(workflowResult.file, "staged file content\n")
assert.equal(workflowResult.directory, "staged directory content\n")

const metadata = JSON.parse(readFileSync(runOutput.artifacts.metadataPath, "utf8"))
assert.equal(metadata.context.recipe.inputs.stagedFiles.length, 2)
assert.equal(metadata.context.recipe.inputs.stagedFileProvenance[0].target, "/wordpress/wp-content/uploads/staged-file.txt")
assert.equal(metadata.context.recipe.inputs.stagedFileProvenance[1].target, "/wordpress/wp-content/uploads/staged-directory")
assert.equal(metadata.context.preparedStagedFiles[0].target, "/wordpress/wp-content/uploads/staged-file.txt")
assert.equal(metadata.provenance.mounts.some((mount: { target: string; metadata?: { kind?: string } }) => mount.target === "/wordpress/wp-content/uploads/staged-file.txt" && mount.metadata?.kind === "staged-file"), true)

console.log("recipe staged files smoke passed")
