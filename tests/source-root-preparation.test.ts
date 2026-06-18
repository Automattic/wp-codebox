import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { listRelativeFiles, withTempDir } from "../scripts/test-kit.js"
import { prepareSourceRoots } from "../packages/runtime-core/src/index.js"

await withTempDir("wp-codebox-source-root-", async (root) => {
  const sourcesRoot = join(root, "sources")
  const alphaSource = join(sourcesRoot, "alpha")
  const betaSource = join(sourcesRoot, "beta")
  const preparedRoot = join(root, "prepared")
  await mkdir(join(alphaSource, "src"), { recursive: true })
  await mkdir(betaSource, { recursive: true })
  await writeFile(join(alphaSource, "src", "index.txt"), "alpha\n")
  await writeFile(join(betaSource, "beta.txt"), "beta\n")

  const manifest = await prepareSourceRoots({
    preparedRoot,
    allowedSourceRoots: [sourcesRoot],
    manifestPath: "manifest/source-roots.json",
    components: [
      { name: "beta", source: betaSource, mode: "reference", target: "runtime/beta", metadata: { kind: "fixture" } },
      { name: "alpha", source: alphaSource, target: "runtime/alpha" },
    ],
  })

  assert.equal(manifest.schema, "wp-codebox/source-root-preparation/v1")
  assert.equal(manifest.preparedRoot, resolve(preparedRoot))
  assert.deepEqual(manifest.components.map((component) => component.name), ["alpha", "beta"])
  assert.deepEqual(manifest.components.map((component) => component.target), ["runtime/alpha", "runtime/beta"])
  assert.equal(manifest.components[0]?.copied, true)
  assert.equal(manifest.components[0]?.preparedPath, resolve(preparedRoot, "runtime/alpha"))
  assert.equal(manifest.components[1]?.copied, false)
  assert.equal(manifest.components[1]?.preparedPath, resolve(betaSource))
  assert.deepEqual(manifest.components[1]?.metadata, { kind: "fixture" })
  assert.deepEqual(manifest.diagnostics.map((diagnostic) => diagnostic.code), ["component-copied", "component-referenced"])
  assert.deepEqual(await listRelativeFiles(preparedRoot), ["manifest/source-roots.json", "runtime/alpha/src/index.txt"])

  const manifestFile = JSON.parse(await readFile(join(preparedRoot, "manifest", "source-roots.json"), "utf8"))
  assert.deepEqual(manifestFile, manifest)

  const secondManifest = await prepareSourceRoots({
    preparedRoot: join(root, "prepared-second"),
    allowedSourceRoots: [sourcesRoot],
    components: [
      { name: "beta", source: betaSource, mode: "reference", target: "runtime/beta", metadata: { kind: "fixture" } },
      { name: "alpha", source: alphaSource, target: "runtime/alpha" },
    ],
  })
  assert.deepEqual(secondManifest.components.map((component) => component.name), ["alpha", "beta"])
  assert.deepEqual(secondManifest.diagnostics.map((diagnostic) => diagnostic.code), ["component-copied", "component-referenced"])

  await writeFile(join(preparedRoot, "runtime", "alpha", "stale.txt"), "stale\n")
  await prepareSourceRoots({
    preparedRoot,
    allowedSourceRoots: [sourcesRoot],
    components: [{ name: "alpha", source: alphaSource, target: "runtime/alpha" }],
  })
  assert.deepEqual(await listRelativeFiles(join(preparedRoot, "runtime", "alpha")), ["src/index.txt"])

  assert.rejects(
    () => prepareSourceRoots({ preparedRoot, allowedSourceRoots: [alphaSource], components: [{ name: "escape", source: betaSource }] }),
    /allowed source root/,
  )
  assert.rejects(
    () => prepareSourceRoots({ preparedRoot, components: [{ name: "escape", source: alphaSource, target: "../escape" }] }),
    /parent-directory/,
  )
  assert.rejects(
    () => prepareSourceRoots({ preparedRoot, components: [{ name: "bad/name", source: alphaSource }] }),
    /component name/,
  )
  assert.rejects(
    () => prepareSourceRoots({ preparedRoot, components: [{ name: "same", source: alphaSource }, { name: "same", source: betaSource, target: "same-beta" }] }),
    /name must be unique/,
  )
})
