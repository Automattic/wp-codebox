import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
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
  await writeFile(join(installRoot, "package.json"), JSON.stringify({
    private: true,
    dependencies: { "@automattic/wp-codebox-runtime-cloudflare": `file:${tarball}` },
    devDependencies: { wrangler: "^4.127.1" },
  }, null, 2))
  await execFileAsync("npm", ["install", "--workspaces=false"], { cwd: installRoot, maxBuffer: 1024 * 1024 * 20 })

  const installedPackage = await realpath(join(installRoot, "node_modules/@automattic/wp-codebox-runtime-cloudflare"))
  assert.equal(installedPackage.startsWith(`${repositoryRoot}${sep}`), false, "packed runtime must be extracted outside the repository")
  const streamCompression = await readFile(join(installedPackage, "node_modules/@php-wasm/stream-compression/index.js"), "utf8")
  assert.match(streamCompression, /Expected a partial zip range response/, "packed runtime postinstall must apply its package-owned stream patch")

  for (const source of ["src/worker.ts", "src/runtime-archive-artifact.ts", "src/public-reader.ts"]) {
    const contents = await readFile(join(installedPackage, source), "utf8")
    assert.doesNotMatch(contents, /\.\.\/\.\.\/runtime-core\/src\//, `${source} must not import checkout-only sibling source`)
    assert.doesNotMatch(contents, /@automattic\/wp-codebox-core/, `${source} must use package-owned runtime assets`)
  }

  const wrangler = join(installRoot, "node_modules/.bin/wrangler")
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
