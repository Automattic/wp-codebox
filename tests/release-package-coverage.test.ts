import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, "..")
const pluginRoot = "packages/wordpress-plugin"
const pluginArtifact = "packages/wordpress-plugin/dist/wp-codebox.zip"

const homeboy = JSON.parse(await readFile(resolve(repositoryRoot, "homeboy.json"), "utf8"))
assert.deepEqual(homeboy.release?.package_coverage, [{
  artifact: pluginArtifact,
  artifact_match: "exact",
  source_roots: [pluginRoot],
  archive_root: "wp-codebox",
}])

await execFileAsync("npm", ["run", "build"], { cwd: repositoryRoot, maxBuffer: 1024 * 1024 * 10 })
const staleDistPath = resolve(repositoryRoot, "packages/runtime-playground/dist/mount-materialization.js")
const currentDist = await readFile(staleDistPath)
await writeFile(staleDistPath, "export const staleBuild = true\n")

let stdout = ""
try {
  ({ stdout } = await execFileAsync("npm", ["run", "release:package"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      WP_CODEBOX_RELEASE_PLATFORM: "linux",
      WP_CODEBOX_RELEASE_ARCH: "x64",
    },
    maxBuffer: 1024 * 1024 * 20,
  }))
} finally {
  await writeFile(staleDistPath, currentDist)
}
const artifacts = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]")
assert.equal(artifacts.length, 2, "release package emitted unexpected artifacts")
assert.deepEqual(artifacts.filter((artifact: { type: string }) => artifact.type === "wordpress-plugin-zip"), [
  { path: pluginArtifact, type: "wordpress-plugin-zip" },
])
const cliArtifacts = artifacts.filter((artifact: { type: string }) => artifact.type === "node-cli-tarball")
assert.equal(cliArtifacts.length, 1, "release package must emit exactly one CLI tarball")
const cliArtifact = cliArtifacts[0] as { path: string, platform: string }
assert.match(cliArtifact.path, /^dist\/wp-codebox-cli-[^/]+\.tar\.gz$/)
assert.match(cliArtifact.platform, /^[a-z0-9]+-[a-z0-9]+$/)
assert.equal(cliArtifact.path, `dist/wp-codebox-cli-${cliArtifact.platform}.tar.gz`)

const { stdout: tracked } = await execFileAsync("git", ["ls-files", "-z", "--", `${pluginRoot}/**`], { cwd: repositoryRoot })
const mappedFiles = tracked
  .split("\0")
  .filter(Boolean)
  .filter((path) => /\.(php|inc|phtml|js|mjs|cjs|css|json)$/.test(path))
  .filter((path) => !path.endsWith("/package.json"))
  .map((path) => `wp-codebox/${path.slice(pluginRoot.length + 1)}`)
assert.ok(mappedFiles.length > 0, "plugin source root has no mapped tracked runtime files")

const { stdout: zipEntries } = await execFileAsync("unzip", ["-Z1", pluginArtifact], {
  cwd: repositoryRoot,
  maxBuffer: 1024 * 1024 * 20,
})
const archiveEntries = new Set(zipEntries.trim().split("\n"))
for (const path of mappedFiles) {
  assert.ok(archiveEntries.has(path), `${pluginArtifact} is missing mapped tracked file ${path}`)
}

assert.equal(archiveEntries.has("wp-codebox/package.json"), false, "package metadata is intentionally excluded from the plugin archive")

const { stdout: tarEntries } = await execFileAsync("tar", ["-tzf", cliArtifact.path], {
  cwd: repositoryRoot,
  maxBuffer: 1024 * 1024 * 20,
})
assert.ok(tarEntries.split("\n").some((path) => path === "wp-codebox-cli/"), "CLI tarball root changed")

const extractionRoot = await mkdtemp(join(tmpdir(), "wp-codebox-release-coverage-"))
try {
  const pluginExtraction = join(extractionRoot, "plugin")
  const cliExtraction = join(extractionRoot, "cli")
  await mkdir(pluginExtraction, { recursive: true })
  await mkdir(cliExtraction, { recursive: true })
  await execFileAsync("unzip", ["-q", resolve(repositoryRoot, pluginArtifact), "-d", pluginExtraction])
  await execFileAsync("tar", ["-xzf", resolve(repositoryRoot, cliArtifact.path), "-C", cliExtraction])

  const pluginCliRoot = join(pluginExtraction, "wp-codebox", "vendor", "wp-codebox-cli")
  const tarCliRoot = join(cliExtraction, "wp-codebox-cli")
  for (const root of [pluginCliRoot, tarCliRoot]) {
    const browserProvenance = JSON.parse(await readFile(join(root, "browser-provenance.json"), "utf8"))
    assert.equal(browserProvenance.schema, "wp-codebox/playwright-browser-provenance/v1")
    assert.equal(browserProvenance.playwrightVersion, "1.61.1")
    assert.equal(browserProvenance.chromiumRevision, "1228")
    assert.equal(browserProvenance.chromiumVersion, "149.0.7827.55")
    assert.equal(browserProvenance.platform, "linux")
    assert.equal(browserProvenance.arch, "x64")
    assert.equal(browserProvenance.dependencyManifestSha256, createHash("sha256").update(await readFile(join(root, "npm-shrinkwrap.json"))).digest("hex"))
    for (const packageName of ["wp-codebox-cli", "wp-codebox-core", "wp-codebox-playground"]) {
      const packagePath = join(root, "node_modules", "@automattic", packageName)
      const packageStat = await lstat(packagePath)
      assert.equal(packageStat.isDirectory(), true, `${packagePath} must be a materialized directory`)
      assert.equal(packageStat.isSymbolicLink(), false, `${packagePath} must not depend on archive symlinks`)
      await lstat(join(packagePath, "package.json"))
    }

    const cliEntrypoint = join(root, "packages", "cli", "dist", "index.js")
    assert.equal((await lstat(cliEntrypoint)).mode & 0o777, 0o755, `${cliEntrypoint} must be executable after extraction`)
    const { stdout: version } = await execFileAsync(process.execPath, [cliEntrypoint, "--version"])
    assert.match(version, /^\d+\.\d+\.\d+\s*$/)
    await execFileAsync(process.execPath, [cliEntrypoint, "commands"])
    const descriptorModule = await import(pathToFileURL(join(root, "packages", "runtime-core", "dist", "runtime-contract-manifest.js")).href) as { runtimeDescriptor(): { capabilities: string[]; packageCapabilities: string[]; runtimeServices: { nativeMariaDb: { status: string } }; contractManifest: { capabilities: { runtimeServices: { packageCapabilities: string[] } } } } }
    const descriptor = descriptorModule.runtimeDescriptor()
    assert.equal(descriptor.capabilities.includes("runtime-service:mysql:native:mariadb"), false, "package support must not claim unknown host readiness")
    assert.ok(descriptor.packageCapabilities.includes("runtime-service:mysql:native:mariadb"), "packaged descriptor must declare native MariaDB package support")
    assert.equal(descriptor.runtimeServices.nativeMariaDb.status, "unknown")
    assert.deepEqual(descriptor.contractManifest.capabilities.runtimeServices.packageCapabilities, ["runtime-service:mysql:native:mariadb"])

    const wrapper = join(root, "bin", "wp-codebox")
    const { stdout: wrapperVersion } = await execFileAsync(wrapper, ["--version"], {
      env: { ...process.env, WP_CODEBOX_NODE_BIN: "" },
    })
    assert.equal(wrapperVersion, version, "wrapper must fall back to host Node when bundled Node is incompatible")

    await assertPackagedReadonlyMaterialization(root)
  }
} finally {
  await rm(extractionRoot, { recursive: true, force: true })
}

const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"))
assert.equal(rootPackage.scripts.postinstall, "node scripts/apply-development-patches.mjs")
assert.ok(rootPackage.files.includes("scripts/apply-development-patches.mjs"))
assert.ok(rootPackage.files.includes("patches"))
assert.equal(rootPackage.dependencies["patch-package"], "^8.0.1")

const lifecycleRoot = await mkdtemp(join(tmpdir(), "wp-codebox-production-lifecycle-"))
try {
  const lifecycleScript = resolve(repositoryRoot, "scripts", "apply-development-patches.mjs")
  const packedLifecycleScript = join(lifecycleRoot, "scripts", "apply-development-patches.mjs")
  await mkdir(join(lifecycleRoot, "scripts"), { recursive: true })
  await cp(lifecycleScript, packedLifecycleScript)
  const { stdout: lifecycleOutput } = await execFileAsync(process.execPath, [packedLifecycleScript], { cwd: lifecycleRoot })
  assert.equal(lifecycleOutput, "Skipping development patches in the production package.\n")
} finally {
  await rm(lifecycleRoot, { recursive: true, force: true })
}

const consumerRoot = await mkdtemp(join(tmpdir(), "wp-codebox-consumer-install-"))
try {
  const packRoot = join(consumerRoot, "pack")
  const installRoot = join(consumerRoot, "install")
  await mkdir(packRoot, { recursive: true })
  const { stdout: packOutput } = await execFileAsync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packRoot], {
    cwd: repositoryRoot,
    maxBuffer: 1024 * 1024 * 20,
  })
  const [packed] = JSON.parse(packOutput) as Array<{ filename: string }>
  const { stdout: packedEntries } = await execFileAsync("tar", ["-tzf", join(packRoot, packed.filename)])
  assert.ok(packedEntries.split("\n").includes("package/npm-shrinkwrap.json"), "npm package must include its deterministic dependency manifest")
  await execFileAsync("npm", ["install", "--global", "--prefix", installRoot, join(packRoot, packed.filename), "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: consumerRoot,
    maxBuffer: 1024 * 1024 * 20,
  })
  const installedCli = join(installRoot, "bin", "wp-codebox")
  const { stdout: installedVersion } = await execFileAsync(installedCli, ["--version"])
  assert.match(installedVersion, /^\d+\.\d+\.\d+\s*$/)
  await execFileAsync(installedCli, ["commands"])
} finally {
  await rm(consumerRoot, { recursive: true, force: true })
}

console.log("release package coverage passed")

async function assertPackagedReadonlyMaterialization(root: string): Promise<void> {
  const modulePath = join(root, "packages", "runtime-playground", "dist", "mount-materialization.js")
  const runtime = await import(pathToFileURL(modulePath).href) as {
    stageReadonlyPlaygroundMounts(mounts: Array<Record<string, unknown>>): Promise<{
      mounts: Array<{ source: string }>
      [Symbol.asyncDispose](): Promise<void>
    }>
  }
  assert.equal(typeof runtime.stageReadonlyPlaygroundMounts, "function", "packaged dist must contain readonly mount isolation")

  const fixtureRoot = await mkdtemp(join(tmpdir(), "wp-codebox-packaged-readonly-"))
  const readonlySource = join(fixtureRoot, "font.woff2")
  const readonlyBytes = Buffer.from("774f4632000100000000108000120000", "hex")
  try {
    await writeFile(readonlySource, readonlyBytes)

    const staging = await runtime.stageReadonlyPlaygroundMounts([{
      type: "file",
      source: readonlySource,
      target: "/wordpress/wp-content/themes/example/font.woff2",
      mode: "readonly",
    }])
    try {
      await writeFile(staging.mounts[0].source, Buffer.from("sandbox overwrite"))
      assert.deepEqual(await readFile(readonlySource), readonlyBytes, "packaged readonly staging must isolate host bytes")
    } finally {
      await staging[Symbol.asyncDispose]()
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}
