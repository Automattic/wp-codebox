import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

import { inspectCliFreshness, writeCliBuildProvenance } from "../packages/cli/src/cli-build-provenance.ts"

const execFileAsync = promisify(execFile)

test("reports fresh source/dist and locally available upstream state", async () => {
  await withCheckout(async ({ root, packageRoot, binaryPath }) => {
    const check = await inspectCliFreshness(packageRoot, binaryPath)
    assert.equal(check.status, "ok")
    assert.match(check.message, /locally available upstream origin\/main/)
    assert.deepEqual(check.details.git, {
      head: await git(root, "rev-parse", "HEAD"),
      ref: "main",
      upstream: "origin/main",
      upstreamHead: await git(root, "rev-parse", "HEAD"),
      ahead: 0,
      behind: 0,
      evidence: "local-tracking-ref",
      remoteFetch: "not-attempted",
    })
  })
})

test("rejects dist that differs from build provenance", async () => {
  await withCheckout(async ({ packageRoot, binaryPath }) => {
    await writeFile(binaryPath, "stale dist\n")
    const check = await inspectCliFreshness(packageRoot, binaryPath)
    assert.equal(check.status, "error")
    assert.match(check.message, /dist differs/)
  })
})

test("rejects source changed after dist was built", async () => {
  await withCheckout(async ({ packageRoot, binaryPath }) => {
    await writeFile(join(packageRoot, "src", "index.ts"), "export const source = 'new'\n")
    const check = await inspectCliFreshness(packageRoot, binaryPath)
    assert.equal(check.status, "error")
    assert.match(check.message, /source differs/)
  })
})

test("reports checkout ahead of and behind its local upstream", async () => {
  await withCheckout(async ({ root, packageRoot, binaryPath }) => {
    await writeFile(join(packageRoot, "src", "ahead.ts"), "export const ahead = true\n")
    await git(root, "add", ".")
    await git(root, "commit", "-m", "ahead")
    await writeCliBuildProvenance(root, packageRoot)
    let check = await inspectCliFreshness(packageRoot, binaryPath)
    assert.equal(check.status, "ok")
    assert.match(check.message, /1 commit\(s\) ahead/)

    const upstreamCommit = await git(root, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "upstream")
    await git(root, "update-ref", "refs/remotes/origin/main", upstreamCommit)
    check = await inspectCliFreshness(packageRoot, binaryPath)
    assert.equal(check.status, "warning")
    assert.match(check.message, /1 commit\(s\) behind/)
  })
})

test("makes unavailable upstream evidence explicit", async () => {
  await withCheckout(async ({ root, packageRoot, binaryPath }) => {
    await git(root, "branch", "--unset-upstream")
    const check = await inspectCliFreshness(packageRoot, binaryPath)
    assert.equal(check.status, "ok")
    assert.match(check.message, /no configured upstream.*remote fetch was not attempted/)
    assert.equal((check.details.git as { evidence: string }).evidence, "unavailable")
  })
})

test("warns when a configured upstream ref is unavailable locally", async () => {
  await withCheckout(async ({ root, packageRoot, binaryPath }) => {
    await git(root, "branch", "--unset-upstream")
    await git(root, "config", "branch.main.remote", "origin")
    await git(root, "config", "branch.main.merge", "refs/heads/missing")
    const check = await inspectCliFreshness(packageRoot, binaryPath)
    assert.equal(check.status, "warning")
    assert.match(check.message, /configured upstream origin\/missing is unavailable locally.*remote fetch was not attempted/)
  })
})

test("verifies packaged provenance without a Git checkout or source tree", async () => {
  await withCheckout(async ({ packageRoot, binaryPath }) => {
    const packagedRoot = await mkdtemp(join(tmpdir(), "wp-codebox-packaged-cli-"))
    try {
      await cp(join(packageRoot, "package.json"), join(packagedRoot, "package.json"))
      await cp(join(packageRoot, "dist"), join(packagedRoot, "dist"), { recursive: true })
      const check = await inspectCliFreshness(packagedRoot, join(packagedRoot, "dist", "index.js"))
      assert.equal(check.status, "ok")
      assert.match(check.message, /not running from a Git checkout/)
    } finally {
      await rm(packagedRoot, { recursive: true, force: true })
    }
  })
})

async function withCheckout(run: (fixture: { root: string; packageRoot: string; binaryPath: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-cli-freshness-"))
  const packageRoot = join(root, "packages", "cli")
  const binaryPath = join(packageRoot, "dist", "index.js")
  try {
    await mkdir(join(packageRoot, "src"), { recursive: true })
    await mkdir(join(packageRoot, "dist"), { recursive: true })
    await writeFile(join(packageRoot, "src", "index.ts"), "export const source = 'fresh'\n")
    await writeFile(binaryPath, "export const dist = 'fresh'\n")
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "@automattic/wp-codebox-cli", version: "1.2.3" })}\n`)
    await writeFile(join(packageRoot, "tsconfig.json"), "{}\n")
    await writeFile(join(root, "tsconfig.base.json"), "{}\n")
    await git(root, "init", "-b", "main")
    await git(root, "config", "user.name", "WP Codebox Test")
    await git(root, "config", "user.email", "test@wp-codebox.invalid")
    await git(root, "add", ".")
    await git(root, "commit", "-m", "fixture")
    await git(root, "remote", "add", "origin", root)
    await git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    await git(root, "branch", "--set-upstream-to", "origin/main", "main")
    await writeCliBuildProvenance(root, packageRoot)
    await run({ root, packageRoot, binaryPath })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd })
  return stdout.trim()
}
