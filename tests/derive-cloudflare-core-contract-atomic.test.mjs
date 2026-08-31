import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { cloudflareStageParent, contractFiles, DirectoryPromotionError, promoteValidatedDirectory, reclaimStaleStages } from "../scripts/derive-cloudflare-core-contract.mjs"

const execFileAsync = promisify(execFile)

for (const faultPoint of ["before-lock", "validation", "after-validation", "before-promotion", "after-promotion"]) {
  test(`derivation preserves the live tree after ${faultPoint} failure`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-promotion-"))
    const destinationRoot = join(root, "live")
    const stagedRoot = join(root, "staged")
    try {
      await writeTree(destinationRoot, "previous")
      await writeTree(stagedRoot, "replacement")
      await assert.rejects(
        promoteValidatedDirectory({
          stagedRoot,
          destinationRoot,
          validate: async () => {
            if (faultPoint === "validation") throw new Error("injected validation failure")
          },
          fault: async (point) => {
            if (point === faultPoint) throw new Error(`injected ${point} failure`)
          },
        }),
        /injected/,
      )
      assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("derivation promotes a fully validated staged tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-promotion-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    let validated = false
    await promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {
        assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "replacement")
        validated = true
      },
      fault: async (point) => { if (point !== "before-lock") assert.equal(validated, true, `${point} must occur after validation`) },
    })
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "replacement")
    assert.deepEqual(await readdir(root), ["live"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("physical, relative, and symlink-parent destination aliases serialize two writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-concurrent-promotion-"))
  const destinationRoot = join(root, "live")
  const firstStage = join(root, "first")
  const secondStage = join(root, "second")
  const firstValidated = join(root, "first-validated")
  const secondBeforeLock = join(root, "second-before-lock")
  const secondValidated = join(root, "second-validated")
  const releaseFirst = join(root, "release-first")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(firstStage, "first")
    await writeTree(secondStage, "second")
    await symlink(root, join(root, "alias"), "dir")
    const source = `
      import { access, writeFile } from "node:fs/promises"
      import { setTimeout as delay } from "node:timers/promises"
      import { promoteValidatedDirectory } from ${JSON.stringify(resolve(import.meta.dirname, "../scripts/derive-cloudflare-core-contract.mjs"))}
      await promoteValidatedDirectory({
        stagedRoot: process.argv[1],
        destinationRoot: process.argv[2],
        validate: async () => { await writeFile(process.argv[3], "ready") },
        fault: async (point) => {
          if (point === "before-lock" && process.argv[5]) await writeFile(process.argv[5], "ready")
          if (point !== "after-validation" || !process.argv[4]) return
          while (true) { try { await access(process.argv[4]); break } catch { await delay(5) } }
        },
      })
    `
    const firstResult = execFileAsync(process.execPath, ["--input-type=module", "--eval", source, firstStage, destinationRoot, firstValidated, releaseFirst, ""], { cwd: root })
    await waitFor(firstValidated)
    const secondResult = execFileAsync(process.execPath, ["--input-type=module", "--eval", source, secondStage, "alias/live", secondValidated, "", secondBeforeLock], { cwd: root })
    await waitFor(secondBeforeLock)
    await assert.rejects(access(secondValidated), { code: "ENOENT" })
    await writeFile(releaseFirst, "continue")
    await firstResult
    await secondResult
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "second")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rollback reports exact left ownership loss and removes the failed replacement from live", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-left-rollback-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const savedPrevious = join(root, "saved-previous")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "failed-replacement")
    await assert.rejects(
      promoteValidatedDirectory({
        stagedRoot,
        destinationRoot,
        validate: async () => {},
        fault: async (point) => {
          if (point !== "after-promotion") return
          await rename(stagedRoot, savedPrevious)
          await writeTree(stagedRoot, "foreign-left")
          throw new Error("injected promotion failure")
        },
      }),
      (error) => error instanceof DirectoryPromotionError && error.code === "ROLLBACK_FAILED" && error.cause?.errors?.[1]?.code === "LEFT_OWNERSHIP_CHANGED",
    )
    await assert.rejects(readFile(join(destinationRoot, "contract.js")), { code: "ENOENT" })
    assert.equal(await readFile(join(savedPrevious, "contract.js"), "utf8"), "previous")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rollback suppresses exact right ownership loss without overwriting its new owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-right-rollback-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const displacedReplacement = join(root, "displaced-replacement")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "failed-replacement")
    await assert.rejects(
      promoteValidatedDirectory({
        stagedRoot,
        destinationRoot,
        validate: async () => {},
        fault: async (point) => {
          if (point !== "after-promotion") return
          await rename(destinationRoot, displacedReplacement)
          await writeTree(destinationRoot, "new-right-owner")
          throw new Error("injected promotion failure")
        },
      }),
      /injected promotion failure/,
    )
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "new-right-owner")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a descendant rewrite after validation cannot promote unvalidated bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-content-generation-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "validated")
    await assert.rejects(
      promoteValidatedDirectory({
        stagedRoot,
        destinationRoot,
        validate: async () => assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "validated"),
        fault: async (point) => { if (point === "after-validation") await writeFile(join(stagedRoot, "contract.js"), "unvalidated") },
      }),
      (error) => error instanceof DirectoryPromotionError && error.code === "STAGING_CONTENT_CHANGED",
    )
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a symlink destination is rejected without touching its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-symlink-promotion-"))
  const targetRoot = join(root, "target")
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(targetRoot, "target")
    await writeTree(stagedRoot, "replacement")
    await symlink(targetRoot, destinationRoot, "dir")
    await assert.rejects(
      promoteValidatedDirectory({ stagedRoot, destinationRoot, validate: async () => {} }),
      (error) => error instanceof DirectoryPromotionError && error.code === "INVALID_DIRECTORY_ENTRY",
    )
    assert.equal(await readFile(join(targetRoot, "contract.js"), "utf8"), "target")
    assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "replacement")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a missing destination below a symlink parent is canonicalized but rejected without creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-missing-promotion-"))
  const physicalParent = join(root, "physical")
  const stagedRoot = join(root, "staged")
  try {
    await mkdir(physicalParent)
    await symlink(physicalParent, join(root, "alias"), "dir")
    await writeTree(stagedRoot, "replacement")
    await assert.rejects(
      promoteValidatedDirectory({ stagedRoot, destinationRoot: join(root, "alias/missing"), validate: async () => {} }),
      (error) => error instanceof DirectoryPromotionError && error.code === "INVALID_DIRECTORY_ENTRY",
    )
    await assert.rejects(access(join(physicalParent, "missing")), { code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("generated relative imports cannot escape before contract files are copied", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-import-escape-"))
  const generatedRoot = join(root, "dist")
  try {
    await mkdir(generatedRoot)
    await writeFile(join(root, "outside.js"), "export const escaped = true\n")
    for (const file of ["runtime-archive-component.js", "runtime-archive-component.d.ts", "runtime-package-profile.js", "runtime-package-profile.d.ts", "runtime-command-result.js", "runtime-command-result.d.ts"]) {
      await writeFile(join(generatedRoot, file), file === "runtime-archive-component.js" ? 'export { escaped } from "../outside.js"\n' : "export {}\n")
    }
    await assert.rejects(
      contractFiles(generatedRoot),
      (error) => error instanceof DirectoryPromotionError && error.code === "GENERATED_IMPORT_ESCAPE",
    )
    assert.deepEqual(await readdir(generatedRoot), [
      "runtime-archive-component.d.ts",
      "runtime-archive-component.js",
      "runtime-command-result.d.ts",
      "runtime-command-result.js",
      "runtime-package-profile.d.ts",
      "runtime-package-profile.js",
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const symlinkKind of ["file", "directory"]) {
  test(`generated imports reject a symlinked ${symlinkKind} inside the source root`, async () => {
    const root = await mkdtemp(join(tmpdir(), `wp-codebox-core-import-symlink-${symlinkKind}-`))
    const generatedRoot = join(root, "dist")
    try {
      await writeContractRoots(generatedRoot)
      if (symlinkKind === "file") {
        await writeFile(join(generatedRoot, "real.js"), "export const linked = true\n")
        await symlink("real.js", join(generatedRoot, "linked.js"), "file")
        await writeFile(join(generatedRoot, "runtime-archive-component.js"), 'export { linked } from "./linked.js"\n')
      } else {
        await mkdir(join(generatedRoot, "real"))
        await writeFile(join(generatedRoot, "real/value.js"), "export const linked = true\n")
        await symlink("real", join(generatedRoot, "linked"), "dir")
        await writeFile(join(generatedRoot, "runtime-archive-component.js"), 'export { linked } from "./linked/value.js"\n')
      }
      await assert.rejects(
        contractFiles(generatedRoot),
        (error) => error instanceof DirectoryPromotionError && error.code === "GENERATED_SOURCE_SYMLINK",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("dead-writer derivation stages are reclaimed while live-writer stages remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-stale-stages-"))
  const deadStage = join(root, ".runtime-cloudflare-core-stage-99999999-dead")
  const liveStage = join(root, `.runtime-cloudflare-core-stage-${process.pid}-live`)
  const reusedPidStage = join(root, `.runtime-cloudflare-core-stage-${process.pid}-stale`)
  try {
    await mkdir(deadStage)
    await mkdir(liveStage)
    await mkdir(reusedPidStage)
    await writeFile(join(deadStage, "partial-secret.txt"), "dead")
    await writeFile(join(liveStage, "active.txt"), "live")
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    await utimes(reusedPidStage, staleTime, staleTime)
    await reclaimStaleStages(root)
    await assert.rejects(access(deadStage), { code: "ENOENT" })
    await assert.rejects(access(reusedPidStage), { code: "ENOENT" })
    assert.equal(await readFile(join(liveStage, "active.txt"), "utf8"), "live")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a stale partial derivation stage cannot enter the Cloudflare package", async () => {
  const packageRoot = resolve(import.meta.dirname, "../packages/runtime-cloudflare")
  assert.equal(cloudflareStageParent, dirname(packageRoot))
  assert.equal(relative(packageRoot, cloudflareStageParent).startsWith(".."), true, "production stages must remain outside the package root")
  const staleStage = join(cloudflareStageParent, ".runtime-cloudflare-core-stage-stale-test")
  try {
    await mkdir(staleStage)
    await writeFile(join(staleStage, "partial-secret.txt"), "must not pack")
    const { stdout } = await execFileAsync("npm", ["pack", ".", "--dry-run", "--json", "--workspaces=false"], {
      cwd: packageRoot,
      maxBuffer: 1024 * 1024 * 20,
    })
    const [packed] = JSON.parse(stdout)
    assert.equal(packed.files.some(({ path }) => path.includes(relative(packageRoot, staleStage)) || path.includes("partial-secret.txt")), false)
  } finally {
    await rm(staleStage, { recursive: true, force: true })
  }
})

for (const faultPoint of ["before-lock", "after-validation", "before-promotion", "after-promotion"]) {
  test(`abrupt termination at ${faultPoint} leaves a complete live tree`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-interruption-"))
    const destinationRoot = join(root, "live")
    const stagedRoot = join(root, "staged")
    try {
      await writeTree(destinationRoot, "previous")
      await writeTree(stagedRoot, "replacement")
      const source = `
        import { promoteValidatedDirectory } from ${JSON.stringify(resolve(import.meta.dirname, "../scripts/derive-cloudflare-core-contract.mjs"))}
        await promoteValidatedDirectory({
          stagedRoot: process.argv[1],
          destinationRoot: process.argv[2],
          validate: async () => {},
          fault: async (point) => { if (point === process.argv[3]) process.kill(process.pid, "SIGKILL") },
        })
      `
      await assert.rejects(execFileAsync(process.execPath, ["--input-type=module", "--eval", source, stagedRoot, destinationRoot, faultPoint]))
      const live = await readFile(join(destinationRoot, "contract.js"), "utf8")
      assert.equal(live, faultPoint === "after-promotion" ? "replacement" : "previous")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

async function writeTree(root, contents) {
  await mkdir(root)
  await writeFile(join(root, "contract.js"), contents)
}

async function writeContractRoots(root) {
  await mkdir(root)
  for (const file of ["runtime-archive-component.js", "runtime-archive-component.d.ts", "runtime-package-profile.js", "runtime-package-profile.d.ts", "runtime-command-result.js", "runtime-command-result.d.ts"]) {
    await writeFile(join(root, file), "export {}\n")
  }
}

async function waitFor(path) {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    try {
      await access(path)
      return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
  }
  throw new Error(`timed out waiting for ${path}`)
}
