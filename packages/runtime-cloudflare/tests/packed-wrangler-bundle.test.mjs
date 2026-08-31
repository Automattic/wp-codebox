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
const productionRoot = join(temporaryRoot, "production-install")
const unsupportedRoot = join(temporaryRoot, "unsupported-production-install")

try {
  await mkdir(tarballRoot)
  await mkdir(installRoot)
  await mkdir(productionRoot)
  await mkdir(unsupportedRoot)
  const { stdout } = await execFileAsync("npm", ["pack", ".", "--json", "--workspaces=false", "--pack-destination", tarballRoot], {
    cwd: packageRoot,
    maxBuffer: 1024 * 1024 * 20,
  })
  const [packed] = JSON.parse(stdout)
  const tarball = resolve(tarballRoot, packed.filename)
  await execFileAsync("tar", ["-xzf", tarball, "-C", installRoot])
  await execFileAsync("tar", ["-xzf", tarball, "-C", productionRoot])
  await execFileAsync("tar", ["-xzf", tarball, "-C", unsupportedRoot])

  const installedPackage = join(installRoot, "package")
  assert.equal(installedPackage.startsWith(`${repositoryRoot}${sep}`), false, "packed runtime must be extracted outside the repository")
  const shrinkwrap = JSON.parse(await readFile(join(installedPackage, "npm-shrinkwrap.json"), "utf8"))
  const packedPackage = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"))
  assert.equal(packedPackage.engines?.node, ">=22.0.0", "the packed production runtime must retain its Node engine")
  assert.deepEqual(shrinkwrap.packages?.[""]?.engines, packedPackage.engines, "the packed production lock must retain the Node engine")
  assert.equal(shrinkwrap.packages?.[""]?.dependencies?.wrangler, "4.127.1", "the packed artifact must carry Wrangler as an exact production dependency")
  await execFileAsync("npm", ["ci", "--include=dev", "--workspaces=false"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  await execFileAsync("npm", ["ls", "--omit=dev"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  await execFileAsync("npm", ["test"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  await execFileAsync("npm", ["run", "build"], { cwd: installedPackage, maxBuffer: 1024 * 1024 * 20 })
  const streamCompression = await readFile(join(installedPackage, "node_modules/@php-wasm/stream-compression/index.js"), "utf8")
  assert.match(streamCompression, /Expected a partial zip range response/, "packed runtime postinstall must apply its package-owned stream patch")
  const universalStreamCompression = JSON.parse(await readFile(join(installedPackage, "node_modules/@php-wasm/universal/node_modules/@php-wasm/stream-compression/package.json"), "utf8"))
  assert.equal(universalStreamCompression.version, "3.1.46", "Universal must retain its independently pinned stream-compression dependency")
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

  const productionPackage = join(productionRoot, "package")
  await execFileAsync("npm", ["ci", "--omit=dev", "--engine-strict", "--workspaces=false"], {
    cwd: productionPackage,
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 1024 * 1024 * 20,
  })
  await execFileAsync("npm", ["ls", "--omit=dev"], {
    cwd: productionPackage,
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 1024 * 1024 * 20,
  })
  const productionWrangler = join(productionPackage, "node_modules/.bin/wrangler")
  const productionWranglerPackage = JSON.parse(await readFile(join(productionPackage, "node_modules/wrangler/package.json"), "utf8"))
  assert.equal(productionWranglerPackage.version, "4.127.1")
  await assert.rejects(readFile(join(productionPackage, "node_modules/playwright/package.json")), { code: "ENOENT" })
  await execFileAsync(productionWrangler, ["deploy", "--dry-run", "--config", join(productionPackage, "wrangler.d1.jsonc"), "--outdir", join(temporaryRoot, "production-bundle")], {
    cwd: productionPackage,
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 1024 * 1024 * 20,
  })

  const unsupportedPackage = join(unsupportedRoot, "package")
  assert.ok(process.env.npm_execpath, "the packed install gate requires npm's CLI path")
  await assert.rejects(execFileAsync("npm", ["exec", "--yes", "--package=node@20", "--", "node", process.env.npm_execpath, "ci", "--omit=dev", "--engine-strict", "--workspaces=false"], {
    cwd: unsupportedPackage,
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 1024 * 1024 * 20,
  }), (error) => error?.code !== 0 && /EBADENGINE|Unsupported engine|not compatible with your version of node/i.test(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}`))

  console.log(`packed Cloudflare Wrangler bundle passed from ${relative(tmpdir(), installedPackage)}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
