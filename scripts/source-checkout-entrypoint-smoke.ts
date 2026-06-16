import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = new URL("..", import.meta.url).pathname
const fixture = await mkdtemp(join(tmpdir(), "wp-codebox-source-entrypoint-"))

try {
  await mkdir(join(fixture, "bin"), { recursive: true })
  await mkdir(join(fixture, "node_modules"), { recursive: true })
  await mkdir(join(fixture, "scripts"), { recursive: true })
  await copyFile(join(root, "bin/wp-codebox-source.mjs"), join(fixture, "bin/wp-codebox-source.mjs"))

  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        build: "node scripts/build-fixture.mjs",
      },
    }),
  )

  await writeFile(
    join(fixture, "scripts/build-fixture.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises"\n` +
      `await mkdir("packages/cli/dist", { recursive: true })\n` +
      `await writeFile("build-ran.txt", "yes")\n` +
      `await writeFile("packages/cli/dist/index.js", "console.log(JSON.stringify({ built: true, args: process.argv.slice(2) }))\\n")\n`,
  )

  const { stdout, stderr } = await execFileAsync(process.execPath, ["bin/wp-codebox-source.mjs", "commands", "--json"], { cwd: fixture })
  const output = JSON.parse(stdout)

  assert.match(stderr, /dist entrypoint is absent/)
  assert.match(stderr, /> build/)
  assert.equal(output.built, true)
  assert.deepEqual(output.args, ["commands", "--json"])

  console.log("Source checkout entrypoint smoke passed")
} finally {
  await rm(fixture, { recursive: true, force: true })
}
