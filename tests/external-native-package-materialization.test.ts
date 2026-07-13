import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { withTempDir } from "../scripts/test-kit.js"
import { materializeExternalNativePackage, normalizeExternalPackageSource, packageDirectorySha256, parseExternalPackageSourcePolicy } from "../.github/scripts/run-agent-task/materialize-external-native-package.mjs"

const execFileAsync = promisify(execFile)

await withTempDir("wp-codebox-external-native-package-", async (repository) => {
  const packagePath = join(repository, "packages", "native-agent")
  await mkdir(packagePath, { recursive: true })
  await writeFile(join(packagePath, ".agent.json"), JSON.stringify({ schema: "agents/agent/v1", slug: "native-agent" }))
  await writeFile(join(packagePath, "instructions.md"), "Use the target workspace only.\n")
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository })
  await execFileAsync("git", ["config", "user.email", "test@example.test"], { cwd: repository })
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repository })
  await execFileAsync("git", ["add", "."], { cwd: repository })
  await execFileAsync("git", ["commit", "--quiet", "-m", "native package"], { cwd: repository })
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  const revision = stdout.trim()
  const sha256 = await packageDirectorySha256(packagePath)
  const descriptor = { repository: "example/native-packages", revision, path: "packages/native-agent", sha256 }
  const policy = parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: { [descriptor.repository]: ["packages/*", "README.md"] } }))

  const materialized = await materializeExternalNativePackage(descriptor, { policy, remote: repository })
  assert.equal(await readFile(join(materialized.source, ".agent.json"), "utf8"), await readFile(join(packagePath, ".agent.json"), "utf8"))
  assert.notEqual(materialized.source.startsWith(repository), true, "External source must not be materialized inside the writable target repository.")
  await assert.rejects(writeFile(join(materialized.source, "blocked.txt"), "blocked"), /EACCES|EPERM/)

  await assert.rejects(materializeExternalNativePackage({ ...descriptor, sha256: "b".repeat(64) }, { policy, remote: repository }), /digest does not match/)
  await assert.rejects(materializeExternalNativePackage({ ...descriptor, revision: "main" }, { policy, remote: repository }), /immutable 40-character commit/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, repository: "other/repository" }, policy), /not authorized/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, path: "../packages/native-agent" }, policy), /without traversal/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, path: "packages-evil/native-agent" }, policy), /not authorized/)
  assert.throws(() => normalizeExternalPackageSource({ ...descriptor, path: "Packages/native-agent" }, policy), /not authorized/)
  assert.deepEqual(normalizeExternalPackageSource({ ...descriptor, repository: "EXAMPLE/NATIVE-PACKAGES" }, policy).repository, descriptor.repository)
  assert.throws(() => parseExternalPackageSourcePolicy(JSON.stringify({ version: 1, repositories: { [descriptor.repository]: ["packages*"] } })), /exact paths or subtree paths/)
  assert.throws(() => parseExternalPackageSourcePolicy('{'), /valid JSON/)

  await symlink("/etc/passwd", join(packagePath, "escape"))
  await execFileAsync("git", ["add", "packages/native-agent/escape"], { cwd: repository })
  await execFileAsync("git", ["commit", "--quiet", "-m", "symlink"], { cwd: repository })
  const { stdout: symlinkRevision } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })
  await assert.rejects(materializeExternalNativePackage({ ...descriptor, revision: symlinkRevision.trim() }, { policy, remote: repository }), /symbolic link/)
})

console.log("external native package materialization ok")
