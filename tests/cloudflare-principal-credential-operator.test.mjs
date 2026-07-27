import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"

const script = resolve("scripts/operator-cloudflare-principal-credential.ts")
const base = ["--config", "packages/runtime-cloudflare/wrangler.d1.jsonc", "--credential-id", "deployer", "--version", "v1"]
const policy = ["--principal", "ci:deploy", "--scopes", "sites:create,sites:read", "--expires-at", "2027-01-01T00:00:00.000Z", "--max-sites", "3"]

test("credential operator passes only a digest to D1 and emits redacted evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-credential-test-"))
  const calls = join(directory, "calls")
  const wrangler = join(directory, "wrangler")
  const bearer = "private-operator-bearer"
  const digest = createHash("sha256").update(bearer).digest("hex")
  try {
    await writeFile(wrangler, `#!${process.execPath}\nimport { appendFileSync, readFileSync, statSync } from "node:fs"; const args=process.argv.slice(2); const file=args[args.indexOf("--file")+1]; appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,sql:readFileSync(file,"utf8"),mode:statSync(file).mode&0o777})+"\\n"); process.stdout.write(JSON.stringify([{results:[{wp_codebox_operator_result:"issued"}]}]));`)
    await chmod(wrangler, 0o755)
    const result = await run(["issue", ...base, ...policy, "--wrangler", wrangler, "--local"], bearer)
    const call = JSON.parse(await readFile(calls, "utf8"))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.includes(bearer) || result.stdout.includes(digest), false)
    assert.equal(result.stderr.includes(bearer) || result.stderr.includes(digest), false)
    assert.equal(JSON.stringify(call.args).includes(bearer) || JSON.stringify(call.args).includes(digest), false)
    assert.equal(call.sql.includes(bearer), false)
    assert.equal(call.sql.includes(digest), true)
    assert.equal(call.mode, 0o600)
    await assert.rejects(readFile(call.args[call.args.indexOf("--file") + 1]), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("credential operator validates private input and action boundaries before Wrangler", async () => {
  const missing = await run(["issue", ...base, ...policy], "")
  const oversized = await run(["issue", ...base, ...policy], "x".repeat(4_097))
  const revokeInput = await run(["revoke", ...base], "private")
  const bearerFlag = await run(["issue", ...base, ...policy, "--bearer", "private"], "private")
  for (const result of [missing, oversized, revokeInput, bearerFlag]) assert.equal(result.status, 1)
  assert.equal([missing, oversized, revokeInput, bearerFlag].some((result) => result.stderr.includes("private")), false)
})

test("credential operator uses an atomic parameterized D1 API batch remotely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-credential-api-"))
  const capture = join(directory, "request")
  const hook = join(directory, "fetch-hook.mjs")
  const bearer = "remote-private-bearer"
  const digest = createHash("sha256").update(bearer).digest("hex")
  try {
    await writeFile(hook, `import { writeFileSync } from "node:fs"; globalThis.fetch=async(url,init)=>{const request=JSON.parse(init.body);writeFileSync(process.env.CAPTURE,JSON.stringify({url,headers:init.headers,body:init.body}));const result=request.batch.map((query,index)=>({success:process.env.FAIL_INDEX!==String(index),results:index===request.batch.length-1?[{wp_codebox_operator_result:process.env.MARKER||"issued"}]:[]}));return new Response(JSON.stringify({success:true,result}),{status:200,headers:{"content-type":"application/json"}})};`)
    const result = await run(["issue", ...base, ...policy, "--account-id", "a".repeat(32)], bearer, { imports: [hook], env: { CAPTURE: capture, CLOUDFLARE_API_TOKEN: "cloudflare-test-token" } })
    const request = JSON.parse(await readFile(capture, "utf8"))
    const body = JSON.parse(request.body)
    assert.equal(result.status, 0, result.stderr)
    assert.match(request.url, /accounts\/a{32}\/d1\/database\/00000000-0000-0000-0000-000000000000\/query$/)
    assert.equal(request.headers.authorization, "Bearer cloudflare-test-token")
    assert.equal(Array.isArray(body.batch), true)
    assert.equal(request.body.includes(bearer), false)
    assert.equal(request.body.includes(digest), true)
    assert.equal((result.stdout + result.stderr).includes(bearer) || (result.stdout + result.stderr).includes(digest), false)
    const revoked = await run(["revoke", ...base, "--account-id", "a".repeat(32)], "", { imports: [hook], env: { CAPTURE: capture, CLOUDFLARE_API_TOKEN: "cloudflare-test-token", MARKER: "revoked" } })
    const failed = await run(["issue", ...base, ...policy, "--account-id", "a".repeat(32)], bearer, { imports: [hook], env: { CAPTURE: capture, CLOUDFLARE_API_TOKEN: "cloudflare-test-token", FAIL_INDEX: "1" } })
    assert.equal(JSON.parse(revoked.stdout).action, "revoked")
    assert.equal(failed.status, 1)
    assert.equal((failed.stdout + failed.stderr).includes(bearer) || (failed.stdout + failed.stderr).includes(digest), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("credential operator converges issue and revocation against local D1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wp-codebox-credential-d1-"))
  const local = ["--local", "--persist-to", join(directory, "state")]
  const bearer = "local-durable-bearer"
  const digest = createHash("sha256").update(bearer).digest("hex")
  try {
    const issued = await run(["issue", ...base, ...policy, ...local], bearer)
    const replayed = await run(["issue", ...base, ...policy, ...local], bearer)
    const conflict = await run(["issue", ...base, ...policy.slice(0, -1), "4", ...local], bearer)
    const duplicate = await run(["issue", ...base.slice(0, -1), "v2", ...policy, ...local], bearer)
    const revoked = await run(["revoke", ...base, ...local], "")
    const unchanged = await run(["revoke", ...base, ...local], "")
    assert.equal(issued.status, 0, issued.stderr)
    assert.equal(replayed.status, 0, replayed.stderr)
    assert.equal(JSON.parse(issued.stdout).action, "issued")
    assert.equal(JSON.parse(replayed.stdout).action, "issued")
    assert.equal(conflict.status, 1)
    assert.equal(duplicate.status, 1)
    assert.equal(JSON.parse(revoked.stdout).action, "revoked")
    assert.equal(JSON.parse(unchanged.stdout).action, "unchanged")
    const evidence = [issued, replayed, conflict, duplicate, revoked, unchanged].map(({ stdout, stderr }) => stdout + stderr).join("")
    assert.equal(evidence.includes(bearer) || evidence.includes(digest), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function run(args, stdin, options = {}) {
  return new Promise((resolveRun, reject) => {
    const imports = (options.imports ?? []).flatMap((value) => ["--import", value])
    const child = spawn(process.execPath, [...imports, "--import", "tsx", script, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env } })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("exit", (status) => resolveRun({ status, stdout, stderr }))
    child.stdin.end(stdin)
  })
}
