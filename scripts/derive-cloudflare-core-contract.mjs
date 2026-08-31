import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, cp, lstat, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cloudflareRoot = resolve(repositoryRoot, "packages/runtime-cloudflare")
const vendorRoot = resolve(cloudflareRoot, "vendor/wp-codebox-core")

export async function deriveCloudflareCoreContract({ write = false } = {}) {
  const cloudflarePackage = JSON.parse(await readFile(resolve(cloudflareRoot, "package.json"), "utf8"))
  const version = cloudflarePackage.wpCodeboxCoreCompatibility
  assert.match(version, /^\d+\.\d+\.\d+$/, "Cloudflare core compatibility must be an exact release version")
  const tag = `v${version}`
  const tagCommit = (await git(["rev-parse", `${tag}^{commit}`])).trim()
  const tagPackage = JSON.parse(await git(["show", `${tag}:packages/runtime-core/package.json`]))
  const tagLock = JSON.parse(await git(["show", `${tag}:npm-shrinkwrap.json`]))
  const compilerVersion = tagLock.packages?.["node_modules/typescript"]?.version
  const installedCompiler = JSON.parse(await readFile(resolve(repositoryRoot, "node_modules/typescript/package.json"), "utf8"))
  assert.equal(tagPackage.name, "@automattic/wp-codebox-core")
  assert.equal(tagPackage.version, version, `${tag} must own the configured core version`)
  assert.equal(installedCompiler.version, compilerVersion, `${tag} must be derived with its locked TypeScript compiler`)

  const temporaryRoot = await mkdtemp(join(tmpdir(), "wp-codebox-core-contract-"))
  const sourceRoot = resolve(temporaryRoot, "source")
  try {
    await git(["worktree", "add", "--detach", sourceRoot, tagCommit])
    await symlink(resolve(repositoryRoot, "node_modules"), resolve(sourceRoot, "node_modules"), "dir")
    await execFileAsync(process.execPath, [resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", resolve(sourceRoot, "packages/runtime-core/tsconfig.json"), "--pretty", "false"], {
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
    for (const match of source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
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
