import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
const repositoryRoot = resolve(packageRoot, "../..")
const temporaryRoot = await mkdtemp(join(tmpdir(), "wp-codebox-cloudflare-pack-"))
const tarballRoot = join(temporaryRoot, "tarballs")
const installRoot = join(temporaryRoot, "install")

try {
  await mkdir(tarballRoot)
  await mkdir(installRoot)
  const { stdout } = await execFileAsync("npm", ["pack", ".", "--json", "--workspaces=false", "--pack-destination", tarballRoot], {
    cwd: packageRoot,
    maxBuffer: 1024 * 1024 * 20,
  })
  const [packed] = JSON.parse(stdout)
  const tarball = resolve(tarballRoot, packed.filename)
  await execFileAsync("tar", ["-xzf", tarball, "-C", installRoot])

  const installedPackage = join(installRoot, "package")
  assert.equal(installedPackage.startsWith(`${repositoryRoot}${sep}`), false, "packed runtime must be extracted outside the repository")
  const shrinkwrap = JSON.parse(await readFile(join(installedPackage, "npm-shrinkwrap.json"), "utf8"))
  assert.equal(shrinkwrap.packages?.[""]?.devDependencies?.wrangler, "4.127.1", "the packed artifact must carry its exact Wrangler lock")
  await execFileAsync("npm", ["ci", "--include=dev", "--workspaces=false"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  await execFileAsync("npm", ["test"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  await execFileAsync("npm", ["run", "build"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  const streamCompression = await readFile(join(installedPackage, "node_modules/@php-wasm/stream-compression/index.js"), "utf8")
  assert.match(streamCompression, /Expected a partial zip range response/, "packed runtime postinstall must apply its package-owned stream patch")
  const corePackage = JSON.parse(await readFile(join(installedPackage, "node_modules/@automattic/wp-codebox-core/package.json"), "utf8"))
  assert.equal(corePackage.version, "0.26.2", "the packed runtime must install its explicit compatible core contract")

  for (const source of ["src/worker.ts", "src/runtime-archive-artifact.ts", "src/public-reader.ts"]) {
    const contents = await readFile(join(installedPackage, source), "utf8")
    assert.doesNotMatch(contents, /\.\.\/\.\.\/runtime-core\/src\//, `${source} must not import checkout-only sibling source`)
    assert.match(contents, /@automattic\/wp-codebox-core\/runtime-archive-component/, `${source} must use the versioned shared contract`)
  }

  const wranglerPackage = JSON.parse(await readFile(join(installedPackage, "node_modules/wrangler/package.json"), "utf8"))
  assert.equal(wranglerPackage.version, "4.127.1")
  const playwrightPackage = JSON.parse(await readFile(join(installedPackage, "node_modules/playwright/package.json"), "utf8"))
  assert.equal(playwrightPackage.version, "1.61.1")
  await execFileAsync(join(installedPackage, "node_modules/.bin/playwright"), ["install", "--dry-run", "chromium"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  const wrangler = join(installedPackage, "node_modules/.bin/wrangler")
  for (const config of ["wrangler.jsonc", "wrangler.d1.jsonc", "wrangler.control.jsonc", "wrangler.public-reader.jsonc"]) {
    const outdir = join(temporaryRoot, "bundle", config.replace(/\.jsonc$/, ""))
    await execFileAsync(wrangler, ["deploy", "--dry-run", "--config", join(installedPackage, config), "--outdir", outdir], {
      cwd: installedPackage,
      maxBuffer: 1024 * 1024 * 20,
    })
  }

  console.log(`packed Cloudflare Wrangler bundle passed from ${relative(tmpdir(), installedPackage)}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
