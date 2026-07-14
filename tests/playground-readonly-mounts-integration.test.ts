import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-readonly-mounts-integration-"))
const readonlySource = join(root, "readonly.bin")
const readwriteSource = join(root, "readwrite.bin")
const recipePath = join(root, "recipe.json")
const artifactsPath = join(root, "artifacts")
const readonlyBytes = Buffer.from([0, 255, 1, 2, 3, 127, 128])
const overwrittenBytes = Buffer.from([128, 127, 3, 2, 1, 255, 0])
const stagingDirectoriesBefore = await readonlyStagingDirectories()

try {
  await writeFile(readonlySource, readonlyBytes)
  await writeFile(readwriteSource, readonlyBytes)
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "6.5", blueprint: { steps: [] } },
    inputs: {
      mounts: [
        { source: readonlySource, target: "/wordpress/readonly.bin", mode: "readonly" },
        { source: readwriteSource, target: "/wordpress/readwrite.bin", mode: "readwrite" },
      ],
    },
    workflow: {
      steps: [{
        command: "wordpress.run-php",
        args: [`code=$contents = base64_decode('${overwrittenBytes.toString("base64")}'); file_put_contents('/wordpress/readonly.bin', $contents); file_put_contents('/wordpress/readwrite.bin', $contents);`],
      }],
    },
  })}\n`)

  const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], {
    cwd: process.cwd(),
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const output = JSON.parse(result.stdout)
  assert.equal(output.success, true, JSON.stringify(output))
  assert.equal(sha256(await readFile(readonlySource)), sha256(readonlyBytes), "readonly host bytes must survive an actual Playground PHP overwrite")
  assert.deepEqual(await readFile(readwriteSource), overwrittenBytes, "readwrite host bytes must reflect an actual Playground PHP overwrite")
  assert.deepEqual(await readonlyStagingDirectories(), stagingDirectoriesBefore, "recipe-run cleanup must remove readonly mount staging")
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch failed|Could not resolve host|Connection timed out|network is unreachable/i.test(message)) {
    console.log(`playground readonly mount integration skipped: WordPress runtime source was unreachable (${message})`)
  } else {
    throw error
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function readonlyStagingDirectories(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith("wp-codebox-readonly-mounts-")).sort()
}

console.log("playground readonly mount integration ok")
