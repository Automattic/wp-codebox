import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { withTempDir } from "../scripts/test-kit.js"
import { materializeExternalNativePackage, normalizeExternalPackageSource, parseExternalPackageSourcePolicy, sha256BytesV1 } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"

const execFileAsync = promisify(execFile)

await withTempDir("wp-codebox-external-native-package-", async (repository) => {
  const packagePath = join(repository, "agents", "naïve.agent.json")
  const bytes = Buffer.from('{"schema":"agents/agent/v1","slug":"naïve","instruction":"café"}\n', "utf8")
  await mkdir(join(repository, "agents"), { recursive: true })
  await mkdir(join(repository, "agents", "legacy.agent.json"), { recursive: true })
  await writeFile(packagePath, bytes)
  await writeFile(join(repository, "agents", "envelope.txt"), "not a standalone agent\n")
  await writeFile(join(repository, "agents", "legacy.agent.json", "manifest.json"), "{}\n")
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository })
  await execFileAsync("git", ["config", "user.email", "test@example.test"], { cwd: repository })
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repository })
  await execFileAsync("git", ["add", "."], { cwd: repository })
  await execFileAsync("git", ["commit", "--quiet", "-m", "native agent"], { cwd: repository })
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  const descriptor = { repository: "example/native-packages", revision: stdout.trim(), path: "agents/naïve.agent.json", digest: sha256BytesV1(bytes) }
  const policy = parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: { [descriptor.repository]: [descriptor.path] } }))

  const materialized = await materializeExternalNativePackage(descriptor, { policy, remote: repository })
  assert.deepEqual(materialized.bytes, bytes, "The versioned digest covers raw UTF-8 bytes, not decoded JSON or a package tree.")
  assert.equal(materialized.descriptor.digest, descriptor.digest)

  await assert.rejects(materializeExternalNativePackage({ ...descriptor, digest: `sha256-bytes-v1:${"b".repeat(64)}` }, { policy, remote: repository }), /byte digest does not match/)
  await assert.rejects(materializeExternalNativePackage({ ...descriptor, revision: "main" }, { policy, remote: repository }), /immutable 40-character commit/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, repository: "other/repository" }, policy), /not authorized/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, path: "agents" }, policy), /standalone .agent.json/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, path: "agents/envelope.txt" }, policy), /standalone .agent.json/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, path: "../agents/naïve.agent.json" }, policy), /without traversal/)
  await assert.rejects(materializeExternalNativePackage({ ...descriptor, path: "agents/legacy.agent.json" }, { policy: parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: { [descriptor.repository]: ["agents/legacy.agent.json"] } })), remote: repository }), /standalone .agent.json file, not a directory or package envelope/)
  assert.throws(() => parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: { [descriptor.repository]: ["agents/*"] } })), /exact standalone/)
  assert.throws(() => parseExternalPackageSourcePolicy('{'), /valid JSON/)
})

console.log("external native package materialization ok")
