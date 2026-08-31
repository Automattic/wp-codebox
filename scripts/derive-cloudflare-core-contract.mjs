import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, cp, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cloudflareRoot = resolve(repositoryRoot, "packages/runtime-cloudflare")
const vendorRoot = resolve(cloudflareRoot, "vendor/wp-codebox-core")

export async function deriveCloudflareCoreContract({ write = false } = {}) {
  const cloudflarePackage = JSON.parse(await readFile(resolve(cloudflareRoot, "package.json"), "utf8"))
  const version = cloudflarePackage.wpCodeboxCoreCompatibility
  const sourceCommit = cloudflarePackage.wpCodeboxCoreSourceCommit
  assert.match(version, /^\d+\.\d+\.\d+$/, "Cloudflare core compatibility must be an exact release version")
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, "Cloudflare core source must be pinned to an exact commit")
  const tag = `v${version}`
  const tagCommit = (await git(["rev-parse", `${tag}^{commit}`])).trim()
  assert.equal(tagCommit, sourceCommit, `${tag} must resolve to the pinned source commit`)
  const tagPackage = JSON.parse(await git(["show", `${tag}:packages/runtime-core/package.json`]))
  const tagLock = JSON.parse(await git(["show", `${tag}:npm-shrinkwrap.json`]))
  const compilerVersion = tagLock.packages?.["node_modules/typescript"]?.version
  assert.equal(tagPackage.name, "@automattic/wp-codebox-core")
  assert.equal(tagPackage.version, version, `${tag} must own the configured core version`)
  assert.match(compilerVersion, /^\d+\.\d+\.\d+$/, `${tag} must lock its TypeScript compiler`)

  const temporaryRoot = await mkdtemp(join(tmpdir(), "wp-codebox-core-contract-"))
  const sourceRoot = resolve(temporaryRoot, "source")
  try {
    await git(["worktree", "add", "--detach", sourceRoot, tagCommit])
    await execFileAsync("npm", ["ci", "--ignore-scripts"], { cwd: sourceRoot, maxBuffer: 1024 * 1024 * 20 })
    const installedCompiler = JSON.parse(await readFile(resolve(sourceRoot, "node_modules/typescript/package.json"), "utf8"))
    assert.equal(installedCompiler.version, compilerVersion, `${tag} must be derived with its locked TypeScript compiler`)
    await execFileAsync(process.execPath, [resolve(sourceRoot, "node_modules/typescript/bin/tsc"), "-p", resolve(sourceRoot, "packages/runtime-core/tsconfig.json"), "--pretty", "false"], {
      cwd: sourceRoot,
      maxBuffer: 1024 * 1024 * 20,
    })

    const generatedRoot = resolve(sourceRoot, "packages/runtime-core/dist")
    const generatedFiles = await contractFiles(generatedRoot)
    assert.ok(generatedFiles.includes("runtime-archive-component.js"))
    assert.ok(generatedFiles.includes("runtime-archive-component.d.ts"))
    assert.ok(generatedFiles.includes("runtime-package-profile.js"))
    assert.ok(generatedFiles.includes("runtime-package-profile.d.ts"))
    assert.ok(generatedFiles.includes("runtime-command-result.js"))
    assert.ok(generatedFiles.includes("runtime-command-result.d.ts"))

    if (write) {
      for (const entry of await readdir(vendorRoot)) {
        if (entry !== "package.json") await rm(resolve(vendorRoot, entry), { recursive: true, force: true })
      }
      for (const file of generatedFiles) await cp(resolve(generatedRoot, file), resolve(vendorRoot, file))
    }

    const vendorFiles = (await filesBelow(vendorRoot)).filter((file) => file !== "package.json")
    assert.deepEqual(vendorFiles, generatedFiles, "vendored core files must be the complete generated contract dependency closure")
    for (const file of generatedFiles) {
      assert.deepEqual(await readFile(resolve(vendorRoot, file)), await readFile(resolve(generatedRoot, file)), `vendored core contract drifted from ${tag}: ${file}`)
    }
    await assertContractBehavior(generatedRoot)

    const vendorPackage = JSON.parse(await readFile(resolve(vendorRoot, "package.json"), "utf8"))
    assert.deepEqual(vendorPackage, compatibilityPackage(version), "vendored package metadata must expose only the selected generated release contracts")
    return { tag, tagCommit, compilerVersion, generatedRoot }
  } finally {
    await git(["worktree", "remove", "--force", sourceRoot], true)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function compatibilityPackage(version) {
  const contract = (file) => ({ types: `./${file}.d.ts`, import: `./${file}.js`, default: `./${file}.js` })
  return {
    name: "@automattic/wp-codebox-core",
    version,
    type: "module",
    exports: {
      "./package.json": "./package.json",
      "./runtime-archive-component": contract("runtime-archive-component"),
      "./runtime-package-profile": contract("runtime-package-profile"),
      "./runtime-command-result": contract("runtime-command-result"),
    },
  }
}

async function filesBelow(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory)) {
      const path = resolve(directory, entry)
      const stat = await lstat(path)
      if (stat.isDirectory()) await visit(path)
      else files.push(relative(root, path))
    }
  }
  await visit(root)
  return files.sort()
}

async function contractFiles(root) {
  const files = new Set([
    "runtime-archive-component.js",
    "runtime-archive-component.d.ts",
    "runtime-package-profile.js",
    "runtime-package-profile.d.ts",
    "runtime-command-result.js",
    "runtime-command-result.d.ts",
  ])
  const pending = [...files]
  while (pending.length) {
    const file = pending.pop()
    const source = await readFile(resolve(root, file), "utf8")
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)) {
      const imported = relative(root, resolve(root, dirname(file), match[1]))
      for (const candidate of imported.endsWith(".js") ? [imported, imported.replace(/\.js$/, ".d.ts")] : [imported]) {
        if (!files.has(candidate) && await exists(resolve(root, candidate))) {
          files.add(candidate)
          pending.push(candidate)
        }
      }
    }
  }
  for (const file of [...files]) {
    if (await exists(resolve(root, `${file}.map`))) files.add(`${file}.map`)
  }
  return [...files].sort()
}

async function assertContractBehavior(generatedRoot) {
  const generatedArchive = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-archive-component.js")).href}?generated`)
  const vendorArchive = await import(`${pathToFileURL(resolve(vendorRoot, "runtime-archive-component.js")).href}?vendor`)
  const generatedProfile = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-package-profile.js")).href}?generated`)
  const vendorProfile = await import(`${pathToFileURL(resolve(vendorRoot, "runtime-package-profile.js")).href}?vendor`)
  const generatedResult = await import(`${pathToFileURL(resolve(generatedRoot, "runtime-command-result.js")).href}?generated`)
  const vendorResult = await import(`${pathToFileURL(resolve(vendorRoot, "runtime-command-result.js")).href}?vendor`)
  const component = { schema: generatedArchive.RUNTIME_ARCHIVE_COMPONENT_SCHEMA, id: "website-importer", package: { profile: "cloudflare", root: "static-site-importer" }, wordpress: { install_path: "plugins/static-site-importer", bootstrap_file: "plugin.php", load: { mode: "mu-plugin-loader", loader_path: "mu-plugins/loader.php" } }, abilities: { import: "sites/import" }, limits: { files: 100, bytes: 1_000_000 } }
  assert.deepEqual(vendorArchive.runtimeArchiveComponent(component), generatedArchive.runtimeArchiveComponent(component))
  for (const invalid of [null, { ...component, id: "../escape" }, { ...component, limits: { files: 0, bytes: 1 } }, { ...component, wordpress: { ...component.wordpress, bootstrap_file: "../plugin.php" } }]) {
    assertSameRejection(() => vendorArchive.runtimeArchiveComponent(invalid), () => generatedArchive.runtimeArchiveComponent(invalid))
  }
  const source = { schema: generatedArchive.RUNTIME_ARCHIVE_COMPONENT_SOURCE_SCHEMA, source: { url: "https://example.com/component.zip", version: "1.0.0", identity: "revision", sha256: "a".repeat(64) }, component }
  assert.deepEqual(vendorArchive.runtimeArchiveComponentSource(source), generatedArchive.runtimeArchiveComponentSource(source))
  assertSameRejection(() => vendorArchive.runtimeArchiveComponentSource({ ...source, source: { ...source.source, url: "http://example.com/component.zip" } }), () => generatedArchive.runtimeArchiveComponentSource({ ...source, source: { ...source.source, url: "http://example.com/component.zip" } }))

  const manifestSource = JSON.stringify({ schema: "example/runtime-package-manifest/v1", package: "example", package_root: "example", profiles: { cloudflare: { abilities: ["sites/import"], selectors: [{ type: "file", path: "plugin.php" }], required_files: ["plugin.php"] } } })
  const generatedManifest = generatedProfile.parseRuntimePackageManifest(manifestSource)
  const vendorManifest = vendorProfile.parseRuntimePackageManifest(manifestSource)
  assert.deepEqual(vendorManifest, generatedManifest)
  assert.deepEqual(vendorProfile.selectRuntimePackageProfileFiles(vendorManifest, "cloudflare", ["example/runtime-package-manifest.json", "example/plugin.php"], "example/runtime-package-manifest.json"), generatedProfile.selectRuntimePackageProfileFiles(generatedManifest, "cloudflare", ["example/runtime-package-manifest.json", "example/plugin.php"], "example/runtime-package-manifest.json"))
  for (const invalid of ["not-json", JSON.stringify({ package: "../escape" }), JSON.stringify({ schema: "example/runtime-package-manifest/v1", package: "example", package_root: "example", profiles: {} })]) {
    assertSameRejection(() => vendorProfile.parseRuntimePackageManifest(invalid), () => generatedProfile.parseRuntimePackageManifest(invalid))
  }
  assertSameRejection(() => vendorProfile.selectRuntimePackageProfileFiles(vendorManifest, "cloudflare", ["example/../plugin.php"], "example/runtime-package-manifest.json"), () => generatedProfile.selectRuntimePackageProfileFiles(generatedManifest, "cloudflare", ["example/../plugin.php"], "example/runtime-package-manifest.json"))
  for (const input of [{ status: "ok", stdout: "{\"passed\":true}\n" }, { status: "error", stdout: "{invalid", stderr: "failure" }, { stdout: "[1,2,3]" }]) {
    assert.deepEqual(vendorResult.runtimeCommandResultEnvelopeFromOutput(input), generatedResult.runtimeCommandResultEnvelopeFromOutput(input))
  }
}

function assertSameRejection(vendor, generated) {
  assert.throws(vendor, (vendorError) => {
    assert.throws(generated, (generatedError) => {
      assert.equal(vendorError.message, generatedError.message)
      return true
    })
    return true
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function git(args, tolerateFailure = false) {
  try {
    return (await execFileAsync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 * 1024 * 20 })).stdout
  } catch (error) {
    if (tolerateFailure) return ""
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await deriveCloudflareCoreContract({ write: process.argv.includes("--write") })
  console.log(`Cloudflare core contract ${process.argv.includes("--write") ? "generated" : "verified"}`)
}
