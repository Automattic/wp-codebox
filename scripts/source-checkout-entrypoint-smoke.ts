import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = new URL("..", import.meta.url).pathname
const fixture = await mkdtemp(join(tmpdir(), "wp-codebox-source-entrypoint-"))
const consumerWorkspace = await mkdtemp(join(tmpdir(), "wp-codebox-source-entrypoint-consumer-"))

try {
  await mkdir(join(fixture, "bin"), { recursive: true })
  await mkdir(join(fixture, "node_modules"), { recursive: true })
  await mkdir(join(fixture, "scripts"), { recursive: true })
  for (const packageName of ["runtime-core", "runtime-playground", "cli"]) {
    await mkdir(join(fixture, "packages", packageName, "src"), { recursive: true })
    await writeFile(join(fixture, "packages", packageName, "src", "index.ts"), `${packageName}-v1`)
  }
  await writeFile(join(fixture, "tsconfig.json"), "config-v1")
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
    `import { access, mkdir, readFile, writeFile } from "node:fs/promises"\n` +
      `try { await access("fail-build"); console.error("fixture build failed intentionally"); process.exit(23) } catch (error) { if (error.code !== "ENOENT") throw error; }\n` +
      `const inputs = ["packages/runtime-core/src/index.ts", "packages/runtime-playground/src/index.ts", "packages/cli/src/index.ts", "tsconfig.json"]\n` +
      `const snapshot = await Promise.all(inputs.map(async (path) => await readFile(path, "utf8")))\n` +
      `let builds = 0\n` +
      `try { builds = Number(await readFile("build-count.txt", "utf8")) } catch (error) { if (error.code !== "ENOENT") throw error; }\n` +
      `await mkdir("packages/cli/dist", { recursive: true })\n` +
      `await writeFile("build-count.txt", String(builds + 1))\n` +
      `await writeFile("packages/cli/dist/index.js", "const snapshot = " + JSON.stringify(snapshot) + "; console.log(JSON.stringify({ snapshot, args: process.argv.slice(2), cwd: process.cwd() })); if (process.argv.includes('exit-17')) process.exit(17)\\n")\n`,
  )

  const firstRun = await runLauncher("commands", "--json")
  const output = JSON.parse(firstRun.stdout)

  assert.match(firstRun.stderr, /dist entrypoint is absent/)
  assert.match(firstRun.stderr, /> build/)
  assert.deepEqual(output.args, ["commands", "--json"])
  assert.equal(await realpath(output.cwd), await realpath(consumerWorkspace))
  assert.deepEqual(output.snapshot, ["runtime-core-v1", "runtime-playground-v1", "cli-v1", "config-v1"])

  const currentRun = JSON.parse((await runLauncher("commands", "--json")).stdout)
  assert.deepEqual(currentRun.snapshot, output.snapshot, "current dist still passes through the incremental build")

  const staleInputs = [
    ["packages/runtime-core/src/index.ts", "runtime-core-v2", 0],
    ["packages/runtime-playground/src/index.ts", "runtime-playground-v2", 1],
    ["packages/cli/src/index.ts", "cli-v2", 2],
    ["tsconfig.json", "config-v2", 3],
  ] as const
  for (const [path, value, snapshotIndex] of staleInputs) {
    await writeFile(join(fixture, path), value)
    const rebuilt = JSON.parse((await runLauncher("commands", "--json")).stdout)
    assert.equal(rebuilt.snapshot[snapshotIndex], value, `${path} did not invalidate generated output`)
  }
  assert.equal(await readFile(join(fixture, "build-count.txt"), "utf8"), "6")

  await writeFile(join(fixture, "fail-build"), "yes")
  await assert.rejects(runLauncher("commands", "--json"), (error: NodeJS.ErrnoException & { stderr?: string, stdout?: string }) => {
    assert.equal(error.code, 23)
    assert.equal(error.stdout, "", "stale CLI output must not run after a failed build")
    assert.match(error.stderr ?? "", /fixture build failed intentionally/)
    assert.match(error.stderr ?? "", /failed to build the source checkout \(exit 23\)/)
    return true
  })
  await rm(join(fixture, "fail-build"))

  await assert.rejects(runLauncher("exit-17"), (error: NodeJS.ErrnoException & { code?: number, stderr?: string }) => {
    assert.equal(error.code, 17)
    assert.doesNotMatch(error.stderr ?? "", /source entrypoint failed/)
    return true
  })

  console.log("Source checkout entrypoint smoke passed")
} finally {
  await rm(fixture, { recursive: true, force: true })
  await rm(consumerWorkspace, { recursive: true, force: true })
}

async function runLauncher(...args: string[]) {
  return await execFileAsync(process.execPath, [join(fixture, "bin/wp-codebox-source.mjs"), ...args], { cwd: consumerWorkspace })
}
