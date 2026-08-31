import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { promoteValidatedDirectory } from "../scripts/derive-cloudflare-core-contract.mjs"

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
