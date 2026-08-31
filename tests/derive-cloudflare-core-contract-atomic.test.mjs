import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { cloudflareStageParent, contractFiles, createStageLease, DirectoryPromotionError, promoteValidatedDirectory, reclaimStaleStages, resumePromotedCleanup } from "../scripts/derive-cloudflare-core-contract.mjs"

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
      (error) => error instanceof DirectoryPromotionError && error.code === "RIGHT_OWNERSHIP_CHANGED",
    )
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "new-right-owner")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed-left fallback restores a foreign destination exchanged after its native check", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-rollback-fallback-race-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const savedPrevious = join(root, "saved-previous")
  const displacedPromotion = join(root, "displaced-promotion")
  const barrier = join(root, "rollback-barrier")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "failed-replacement")
    const source = `
      import { mkdir, rename, writeFile } from "node:fs/promises"
      import { join } from "node:path"
      import { promoteValidatedDirectory } from ${JSON.stringify(resolve(import.meta.dirname, "../scripts/derive-cloudflare-core-contract.mjs"))}
      await promoteValidatedDirectory({
        stagedRoot: process.argv[1],
        destinationRoot: process.argv[2],
        validate: async () => {},
        fault: async (point) => {
          if (point !== "after-promotion") return
          await rename(process.argv[1], process.argv[3])
          await mkdir(process.argv[1])
          await writeFile(join(process.argv[1], "contract.js"), "foreign-left")
          throw new Error("force fallback")
        },
      })
    `
    const promotion = execFileAsync(process.execPath, ["--input-type=module", "--eval", source, stagedRoot, destinationRoot, savedPrevious], {
      env: { ...process.env, WP_CODEBOX_ROLLBACK_BARRIER: barrier },
    })
    await waitFor(barrier)
    await rename(destinationRoot, displacedPromotion)
    await writeTree(destinationRoot, "foreign-right")
    await rm(barrier)
    await assert.rejects(promotion, /ROLLBACK_FAILED/)
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "foreign-right")
    assert.equal(await readFile(join(displacedPromotion, "contract.js"), "utf8"), "failed-replacement")
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

test("validation reads the pinned generation when the staging pathname is swapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-validation-swap-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const pinnedRoot = join(root, "pinned")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "validated")
    let validated
    await assert.rejects(promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async (validationRoot) => {
        await rename(stagedRoot, pinnedRoot)
        await writeTree(stagedRoot, "foreign")
        validated = await readFile(join(validationRoot, "contract.js"), "utf8")
      },
    }), (error) => error instanceof DirectoryPromotionError && error.code === "STAGING_OWNERSHIP_CHANGED")
    assert.equal(validated, "validated")
    assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "foreign")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a staging write racing the native snapshot cannot validate torn bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-snapshot-race-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const barrier = join(root, "snapshot-barrier")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "validated")
    const promotion = promoteValidatedDirectory({ stagedRoot, destinationRoot, snapshotBarrier: barrier, validate: async () => {} })
    await waitFor(barrier)
    await writeFile(join(stagedRoot, "contract.js"), "raced")
    await rm(barrier)
    await assert.rejects(promotion, (error) => error instanceof DirectoryPromotionError && error.code === "STAGING_CONTENT_CHANGED")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("validation cannot mutate its snapshot away from the promoted manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-validation-mutation-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "validated")
    await assert.rejects(promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async (validationRoot) => writeFile(join(validationRoot, "contract.js"), "different"),
    }), (error) => error instanceof DirectoryPromotionError && error.code === "STAGING_CONTENT_CHANGED")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("destination replacement before promotion is typed and never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-right-before-promotion-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const savedPrevious = join(root, "saved-previous")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    await assert.rejects(promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      fault: async (point) => {
        if (point !== "before-promotion") return
        await rename(destinationRoot, savedPrevious)
        await writeTree(destinationRoot, "foreign")
      },
    }), (error) => error instanceof DirectoryPromotionError && error.code === "RIGHT_OWNERSHIP_CHANGED")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "foreign")
    assert.equal(await readFile(join(savedPrevious, "contract.js"), "utf8"), "previous")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a descendant mutation after the final native manifest rolls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-final-manifest-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "validated")
    await assert.rejects(promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      nativeFault: async (point) => { if (point === "after-final-manifest") await writeFile(join(destinationRoot, "contract.js"), "mutated") },
    }), (error) => error instanceof DirectoryPromotionError && error.code === "STAGING_CONTENT_CHANGED")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
    assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "mutated")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("destination replacement in the helper check/exchange barrier is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-helper-race-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const savedPrevious = join(root, "saved-previous")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    await assert.rejects(promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      nativeFault: async (point) => {
        if (point !== "helper-checked") return
        await rename(destinationRoot, savedPrevious)
        await writeTree(destinationRoot, "foreign")
      },
    }), (error) => error instanceof DirectoryPromotionError && error.code === "RIGHT_OWNERSHIP_CHANGED")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "foreign")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("staging replacement in the helper check/exchange barrier restores live and preserves foreign staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-helper-left-race-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const savedStage = join(root, "saved-stage")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    await assert.rejects(promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      nativeFault: async (point) => {
        if (point !== "helper-checked") return
        await rename(stagedRoot, savedStage)
        await writeTree(stagedRoot, "foreign-stage")
      },
    }), (error) => error instanceof DirectoryPromotionError && error.code === "STAGING_CONTENT_CHANGED")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
    assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "foreign-stage")
    assert.equal(await readFile(join(savedStage, "contract.js"), "utf8"), "replacement")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a destination parent symlink swap cannot redirect the native exchange", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-parent-swap-"))
  const physical = join(root, "physical")
  const decoy = join(root, "decoy")
  const alias = join(root, "alias")
  const stagedRoot = join(root, "staged")
  try {
    await mkdir(physical)
    await mkdir(decoy)
    await writeTree(join(physical, "live"), "previous")
    await writeTree(join(decoy, "live"), "decoy")
    await writeTree(stagedRoot, "replacement")
    await symlink(physical, alias, "dir")
    await promoteValidatedDirectory({
      stagedRoot,
      destinationRoot: join(alias, "live"),
      validate: async () => {},
      nativeFault: async (point) => {
        if (point !== "helper-checked") return
        await rename(alias, join(root, "old-alias"))
        await symlink(decoy, alias, "dir")
      },
    })
    assert.equal(await readFile(join(physical, "live/contract.js"), "utf8"), "replacement")
    assert.equal(await readFile(join(decoy, "live/contract.js"), "utf8"), "decoy")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an intermediate destination ancestor swap cannot redirect descriptor-relative exchange", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-ancestor-swap-"))
  const ancestor = join(root, "ancestor")
  const movedAncestor = join(root, "moved-ancestor")
  const destinationRoot = join(ancestor, "parent/live")
  const stagedRoot = join(root, "staged")
  try {
    await mkdir(join(ancestor, "parent"), { recursive: true })
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    await promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      nativeFault: async (point) => {
        if (point !== "helper-checked") return
        await rename(ancestor, movedAncestor)
        await mkdir(join(ancestor, "parent"), { recursive: true })
        await writeTree(join(ancestor, "parent/live"), "decoy")
      },
    })
    assert.equal(await readFile(join(movedAncestor, "parent/live/contract.js"), "utf8"), "replacement")
    assert.equal(await readFile(join(ancestor, "parent/live/contract.js"), "utf8"), "decoy")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a generated source parent swap cannot redirect descriptor-relative reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-source-parent-swap-"))
  const physical = join(root, "physical")
  const movedPhysical = join(root, "moved-physical")
  const generatedRoot = join(physical, "dist")
  try {
    await mkdir(physical)
    await writeContractRoots(generatedRoot)
    await assert.rejects(contractFiles(generatedRoot, {
      fault: async (point) => {
        if (point !== "source-root-opened") return
        await rename(physical, movedPhysical)
        await mkdir(physical)
        await writeContractRoots(join(physical, "dist"))
      },
    }), (error) => error instanceof DirectoryPromotionError && error.code === "GENERATED_SOURCE_CHANGED")
    assert.equal(await readFile(join(movedPhysical, "dist/runtime-archive-component.js"), "utf8"), "export {}\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unlinking and recreating the protected lock generation aborts the writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-lock-continuity-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    const protectedLockDirectory = join(await realpath(tmpdir()), `wp-codebox-directory-exchange-${process.getuid()}-${createHash("sha256").update(await realpath(destinationRoot)).digest("hex")}`)
    await assert.rejects(promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      fault: async (point) => {
        if (point !== "after-validation") return
        await chmod(protectedLockDirectory, 0o700)
        await rm(protectedLockDirectory, { recursive: true })
        await mkdir(protectedLockDirectory, { mode: 0o500 })
      },
    }), (error) => error instanceof DirectoryPromotionError && error.code === "DIRECTORY_LOCK_LOST")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
    await chmod(protectedLockDirectory, 0o700)
    await rm(protectedLockDirectory, { recursive: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const faultPoint of ["after-promoted", "after-final-manifest"]) {
  test(`lock continuity loss at ${faultPoint} rolls back before reporting`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-post-exchange-lock-"))
    const destinationRoot = join(root, "live")
    const stagedRoot = join(root, "staged")
    let protectedLockDirectory
    try {
      await writeTree(destinationRoot, "previous")
      await writeTree(stagedRoot, "replacement")
      protectedLockDirectory = join(await realpath(tmpdir()), `wp-codebox-directory-exchange-${process.getuid()}-${createHash("sha256").update(await realpath(destinationRoot)).digest("hex")}`)
      await assert.rejects(promoteValidatedDirectory({
        stagedRoot,
        destinationRoot,
        validate: async () => {},
        nativeFault: async (point) => {
          if (point !== faultPoint) return
          await chmod(protectedLockDirectory, 0o700)
          await rm(protectedLockDirectory, { recursive: true })
          await mkdir(protectedLockDirectory, { mode: 0o500 })
        },
      }), (error) => error instanceof DirectoryPromotionError && error.code === "DIRECTORY_LOCK_LOST")
      assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "previous")
      assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "replacement")
    } finally {
      if (protectedLockDirectory) {
        await chmod(protectedLockDirectory, 0o700).catch(() => {})
        await rm(protectedLockDirectory, { recursive: true, force: true })
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("failed displaced-tree cleanup is explicit and resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-cleanup-pending-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    const result = await promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      nativeFault: async (point) => { if (point === "before-cleanup") throw new Error("injected cleanup failure") },
    })
    assert.equal(result.outcome, "promoted_cleanup_pending")
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "replacement")
    assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "previous")
    assert.deepEqual(await resumePromotedCleanup(result), { outcome: "cleaned" })
    await assert.rejects(access(stagedRoot), { code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("resumable cleanup never deletes a foreign replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-cleanup-foreign-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  const displacedRoot = join(root, "displaced")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    const result = await promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      nativeFault: async (point) => { if (point === "before-cleanup") throw new Error("injected cleanup failure") },
    })
    await rename(stagedRoot, displacedRoot)
    await writeTree(stagedRoot, "foreign")
    await assert.rejects(resumePromotedCleanup(result), (error) => error instanceof DirectoryPromotionError && error.code === "RIGHT_OWNERSHIP_CHANGED")
    assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "foreign")
    assert.equal(await readFile(join(displacedRoot, "contract.js"), "utf8"), "previous")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cleanup quarantine survives native helper termination and resumes by leased identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-cleanup-death-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, ".runtime-cloudflare-core-stage-99999999-cleanup-death")
  const barrier = join(root, "cleanup-barrier")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    const stageLease = await createStageLease(stagedRoot, { pid: 99999999, createdAt: Date.now() - 25 * 60 * 60 * 1_000 })
    const result = await promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      stageLease,
      validate: async () => {},
      nativeFault: async (point) => { if (point === "before-cleanup") throw new Error("defer cleanup") },
    })
    const interrupted = resumePromotedCleanup({ ...result, cleanupLease: stageLease.cleanupLease, cleanupBarrier: barrier })
    await waitFor(barrier)
    process.kill(Number((await readFile(barrier, "utf8")).trim()), "SIGKILL")
    await assert.rejects(interrupted)
    await writeTree(stagedRoot, "foreign")
    await reclaimStaleStages(root)
    assert.equal(await readFile(join(stagedRoot, "contract.js"), "utf8"), "foreign")
    await assert.rejects(access(stageLease.cleanupLease), { code: "ENOENT" })
    assert.equal((await readdir(root)).some((name) => name.startsWith(".wp-codebox-cleanup-")), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const cleanupBarrierPoint of ["before-exchange", "after-exchange"]) {
  test(`cleanup resumes after termination ${cleanupBarrierPoint}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `wp-codebox-core-cleanup-${cleanupBarrierPoint}-`))
    const destinationRoot = join(root, "live")
    const stagedRoot = join(root, "staged")
    const barrier = join(root, "cleanup-barrier")
    try {
      await writeTree(destinationRoot, "previous")
      await writeTree(stagedRoot, "replacement")
      const result = await promoteValidatedDirectory({
        stagedRoot,
        destinationRoot,
        validate: async () => {},
        nativeFault: async (point) => { if (point === "before-cleanup") throw new Error("defer cleanup") },
      })
      const interrupted = resumePromotedCleanup({ ...result, cleanupBarrier: barrier, cleanupBarrierPoint })
      await waitFor(barrier)
      process.kill(Number((await readFile(barrier, "utf8")).trim()), "SIGKILL")
      await assert.rejects(interrupted)
      assert.deepEqual(await resumePromotedCleanup(result), { outcome: "cleaned" })
      await assert.rejects(access(stagedRoot), { code: "ENOENT" })
      assert.equal((await readdir(root)).some((name) => name.startsWith(".wp-codebox-cleanup-")), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("cleanup preserves a foreign pre-existing predictable quarantine", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-foreign-quarantine-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, "staged")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(stagedRoot, "replacement")
    const result = await promoteValidatedDirectory({
      stagedRoot,
      destinationRoot,
      validate: async () => {},
      nativeFault: async (point) => { if (point === "before-cleanup") throw new Error("defer cleanup") },
    })
    const foreign = join(root, `.wp-codebox-cleanup-${result.cleanupIdentity.dev}-${result.cleanupIdentity.ino}`)
    await mkdir(foreign)
    await writeFile(join(foreign, "foreign.txt"), "preserve")
    assert.deepEqual(await resumePromotedCleanup(result), { outcome: "cleaned" })
    assert.equal(await readFile(join(foreign, "foreign.txt"), "utf8"), "preserve")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cleanup traversal failures remain resumable rather than becoming ownership errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-cleanup-traversal-"))
  const destinationRoot = join(root, "live")
  const stagedRoot = join(root, ".runtime-cloudflare-core-stage-traversal")
  try {
    await writeTree(destinationRoot, "previous")
    await symlink("contract.js", join(destinationRoot, "linked.js"), "file")
    await writeTree(stagedRoot, "replacement")
    const stageLease = await createStageLease(stagedRoot)
    const result = await promoteValidatedDirectory({ stagedRoot, destinationRoot, stageLease, validate: async () => {} })
    assert.equal(result.outcome, "promoted_cleanup_pending")
    const resumed = await resumePromotedCleanup(result)
    assert.equal(resumed.outcome, "promoted_cleanup_pending")
    assert.deepEqual(resumed.cleanupIdentity, result.cleanupIdentity)
    assert.deepEqual(resumed.cleanupFallbackIdentity, result.cleanupFallbackIdentity)
    assert.equal(resumed.cleanupLease, result.cleanupLease)
    assert.equal(resumed.cleanupToken, result.cleanupToken)
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

test("only exact persisted stage leases are reclaimed and foreign replacements survive", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-stale-stages-"))
  const deadStage = join(root, ".runtime-cloudflare-core-stage-99999999-dead")
  const liveStage = join(root, `.runtime-cloudflare-core-stage-${process.pid}-live`)
  const reusedPidStage = join(root, `.runtime-cloudflare-core-stage-${process.pid}-stale`)
  const unleasedStage = join(root, ".runtime-cloudflare-core-stage-99999999-unleased")
  const displacedStage = join(root, "displaced-owned-stage")
  try {
    await mkdir(deadStage)
    await mkdir(liveStage)
    await mkdir(reusedPidStage)
    await mkdir(unleasedStage)
    await writeFile(join(deadStage, "partial-secret.txt"), "dead")
    await writeFile(join(liveStage, "active.txt"), "live")
    await writeFile(join(reusedPidStage, "owned.txt"), "owned")
    await writeFile(join(unleasedStage, "foreign.txt"), "unleased")
    await createStageLease(deadStage, { pid: 99999999, createdAt: Date.now() - 25 * 60 * 60 * 1_000 })
    await createStageLease(liveStage)
    const replacedLease = await createStageLease(reusedPidStage, { pid: 99999999, createdAt: Date.now() - 25 * 60 * 60 * 1_000 })
    await rename(reusedPidStage, displacedStage)
    await mkdir(reusedPidStage)
    await writeFile(join(reusedPidStage, "foreign.txt"), "replacement")
    await reclaimStaleStages(root)
    await assert.rejects(access(deadStage), { code: "ENOENT" })
    assert.equal(await readFile(join(liveStage, "active.txt"), "utf8"), "live")
    assert.equal(await readFile(join(unleasedStage, "foreign.txt"), "utf8"), "unleased")
    assert.equal(await readFile(join(reusedPidStage, "foreign.txt"), "utf8"), "replacement")
    assert.equal(await readFile(join(displacedStage, "owned.txt"), "utf8"), "owned")
    await access(replacedLease.cleanupLease)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("generated reads reject a file replaced after descriptor EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-read-replacement-"))
  const generatedRoot = join(root, "dist")
  const barrier = join(root, "read-barrier")
  try {
    await writeContractRoots(generatedRoot)
    const reading = contractFiles(generatedRoot, { readBarrier: barrier })
    await waitFor(barrier)
    const target = join(generatedRoot, "runtime-command-result.d.ts")
    await rename(target, `${target}.old`)
    await writeFile(target, "export const torn = true\n")
    await rm(barrier)
    await assert.rejects(reading, (error) => error instanceof DirectoryPromotionError && error.code === "GENERATED_SOURCE_CHANGED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("dependency discovery stays on one generated generation after the source mutates", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-generated-generation-"))
  const generatedRoot = join(root, "dist")
  try {
    await writeContractRoots(generatedRoot)
    const files = await contractFiles(generatedRoot, {
      fault: async (point) => {
        if (point !== "source-snapshotted") return
        await writeFile(join(generatedRoot, "runtime-archive-component.js"), 'export { changed } from "./changed.js"\n')
        await writeFile(join(generatedRoot, "changed.js"), "export const changed = true\n")
      },
    })
    assert.equal(files.includes("changed.js"), false)
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

for (const faultPoint of ["before-lock", "after-validation", "before-promotion", "after-promotion", "after-final-manifest"]) {
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
          nativeFault: async (point) => { if (point === process.argv[3]) process.kill(process.pid, "SIGKILL") },
        })
      `
      await assert.rejects(execFileAsync(process.execPath, ["--input-type=module", "--eval", source, stagedRoot, destinationRoot, faultPoint]))
      if (["after-promotion", "after-final-manifest"].includes(faultPoint)) await waitForContents(join(destinationRoot, "contract.js"), "previous")
      const live = await readFile(join(destinationRoot, "contract.js"), "utf8")
      assert.equal(live, "previous")
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

async function waitForContents(path, expected) {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (await readFile(path, "utf8") === expected) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
  }
  throw new Error(`timed out waiting for ${path} contents`)
}
