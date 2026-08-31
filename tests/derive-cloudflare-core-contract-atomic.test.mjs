import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { contractFiles, DirectoryPromotionError, promoteValidatedDirectory } from "../scripts/derive-cloudflare-core-contract.mjs"

const execFileAsync = promisify(execFile)

for (const faultPoint of ["validation", "after-validation", "before-promotion", "after-promotion"]) {
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
      fault: async (point) => assert.equal(validated, true, `${point} must occur after validation`),
    })
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "replacement")
    assert.deepEqual(await readdir(root), ["live"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failing writer cannot roll back a later successful writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-core-concurrent-promotion-"))
  const destinationRoot = join(root, "live")
  const firstStage = join(root, "first")
  const secondStage = join(root, "second")
  const firstPromoted = join(root, "first-promoted")
  const releaseFirst = join(root, "release-first")
  try {
    await writeTree(destinationRoot, "previous")
    await writeTree(firstStage, "first")
    await writeTree(secondStage, "second")
    const source = `
      import { access, writeFile } from "node:fs/promises"
      import { setTimeout as delay } from "node:timers/promises"
      import { promoteValidatedDirectory } from ${JSON.stringify(resolve(import.meta.dirname, "../scripts/derive-cloudflare-core-contract.mjs"))}
      await promoteValidatedDirectory({
        stagedRoot: process.argv[1],
        destinationRoot: process.argv[2],
        validate: async () => {},
        fault: async (point) => {
          if (point !== "after-promotion") return
          await writeFile(process.argv[3], "ready")
          while (true) {
            try { await access(process.argv[4]); break } catch { await delay(5) }
          }
          throw new Error("injected first-writer failure")
        },
      })
    `
    const firstResult = execFileAsync(process.execPath, ["--input-type=module", "--eval", source, firstStage, destinationRoot, firstPromoted, releaseFirst])
      .then(() => null, (error) => error)
    await waitFor(firstPromoted)
    await promoteValidatedDirectory({ stagedRoot: secondStage, destinationRoot, validate: async () => {} })
    await writeFile(releaseFirst, "continue")
    const firstError = await firstResult
    assert.match(firstError?.stderr ?? "", /injected first-writer failure/)
    assert.equal(await readFile(join(destinationRoot, "contract.js"), "utf8"), "second")
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

test("a stale partial derivation stage cannot enter the Cloudflare package", async () => {
  const packageRoot = resolve(import.meta.dirname, "../packages/runtime-cloudflare")
  const staleStage = join(dirname(packageRoot), ".runtime-cloudflare-core-stage-stale-test")
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

for (const faultPoint of ["after-validation", "before-promotion", "after-promotion"]) {
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
