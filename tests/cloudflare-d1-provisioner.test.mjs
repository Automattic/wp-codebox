import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"

const script = resolve("packages/runtime-cloudflare/scripts/provision-d1-coordinator.mjs")

test("D1 provisioner creates once and emits a deployable config deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-d1-provision-"))
  try {
    const wrangler = join(directory, "wrangler")
    const state = join(directory, "state")
    const calls = join(directory, "calls")
    const template = join(directory, "wrangler.d1.jsonc")
    const output = join(directory, "production.json")
    await writeFile(state, "missing")
    await writeFile(calls, "")
    await writeFile(template, `// template\n{"name":"worker","main":"src/worker-d1.ts","d1_databases":[{"binding":"WORDPRESS_STATE_DATABASE","database_name":"wp-codebox-runtime-state","database_id":"00000000-0000-0000-0000-000000000000"}],"rules":[{"globs":["**/*.wasm","https://example.test/*"]}],}`)
    await writeFile(wrangler, `#!${process.execPath}\nimport { appendFileSync, readFileSync, writeFileSync } from "node:fs"; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+"\\n"); if(args[1]==="list") process.stdout.write(readFileSync(${JSON.stringify(state)},"utf8")==="created"?JSON.stringify([{name:"wp-codebox-runtime-state",uuid:"11111111-2222-3333-4444-555555555555"}]):"[]"); else if(args[1]==="create") writeFileSync(${JSON.stringify(state)},"created");`)
    await chmod(wrangler, 0o755)

    const first = await run(["--template", template, "--output", output, "--wrangler", wrangler])
    const second = await run(["--template", template, "--output", output, "--wrangler", wrangler])
    assert.equal(first.databaseId, "11111111-2222-3333-4444-555555555555")
    assert.deepEqual(second, first)
    const config = JSON.parse(await readFile(output, "utf8"))
    assert.equal(config.d1_databases[0].database_id, first.databaseId)
    assert.equal(config.main, join(directory, "src/worker-d1.ts"))
    assert.deepEqual(config.rules[0].globs, ["**/*.wasm", "https://example.test/*"])
    const invocations = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(invocations.filter((args) => args[1] === "create").length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolveRun(JSON.parse(stdout)) : reject(new Error(stderr)))
  })
}
