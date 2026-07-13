import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { withTempDir } from "../scripts/test-kit.js"
import { canonicalExternalNativeAgentIdentity, canonicalPublicGithubRepositorySource, materializeExternalNativePackage, normalizeExternalPackageSource, parseExternalPackageSourcePolicy, publicGitEnvironment, sha256BytesV1 } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"

const execFileAsync = promisify(execFile)

await withTempDir("wp-codebox-external-native-package-", async (repository) => {
  const packagePath = join(repository, "agents", "naïve.agent.json")
  const bytes = await readFile(new URL("./fixtures/external-native-package/flat-agent.agent.json", import.meta.url))
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

  assert.equal(canonicalPublicGithubRepositorySource("Example/Native-Packages"), "https://github.com/example/native-packages.git")
  const sourceEnvironment = publicGitEnvironment(repository)
  for (const credential of ["GITHUB_TOKEN", "GH_TOKEN", "ACCESS_TOKEN", "OPENAI_API_KEY"]) {
    assert.equal(sourceEnvironment[credential], undefined, `public source transport must not receive ${credential}`)
  }
  assert.equal(sourceEnvironment.GIT_TERMINAL_PROMPT, "0")
  assert.equal(sourceEnvironment.GIT_CONFIG_NOSYSTEM, "1")

  const materialized = await materializeExternalNativePackage(descriptor, { policy, remote: repository })
  assert.deepEqual(materialized.bytes, bytes, "The versioned digest covers raw UTF-8 bytes, not decoded JSON or a package tree.")
  assert.equal(materialized.descriptor.digest, descriptor.digest)
  assert.deepEqual(materialized.identity, { slug: "naive-agent" })
  assert.deepEqual(canonicalExternalNativeAgentIdentity(bytes), { slug: "naive-agent" })
  assert.throws(() => canonicalExternalNativeAgentIdentity(Buffer.from('{"schema_version":1,"bundle_slug":"native-agent","slug":"caller-controlled"}')), /canonical agent\.agent_slug identity/)
  assert.throws(() => canonicalExternalNativeAgentIdentity(Buffer.from('{"schema_version":1,"bundle_slug":"native-agent","agent":{"agent_slug":"native-agent"},"package_slug":"caller-controlled"}')), /ambiguous agent identities/)

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

const docsAgentDirectory = process.env.DOCS_AGENT_DIR
if (docsAgentDirectory) {
  const packagePath = join(docsAgentDirectory, "bundles", "technical-docs-agent", "native", "technical-docs-maintenance-agent.agent.json")
  const bytes = await readFile(packagePath)
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: docsAgentDirectory })
  const descriptor = {
    repository: "automattic/docs-agent",
    revision: stdout.trim(),
    path: "bundles/technical-docs-agent/native/technical-docs-maintenance-agent.agent.json",
    digest: sha256BytesV1(bytes),
  }
  const policy = parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: { [descriptor.repository]: [descriptor.path] } }))
  const materialized = await materializeExternalNativePackage(descriptor, { policy, remote: docsAgentDirectory })
  assert.deepEqual(materialized.identity, { slug: "technical-docs-maintenance-agent" })
  assert.deepEqual(materialized.bytes, bytes)
  console.log("Docs Agent native package materialization ok")
}

console.log("external native package materialization ok")
