import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { arch, platform } from "node:os"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import { materializeSharpReleaseRuntime, sharpRuntimePackageNames } from "./lib/materialize-sharp-release-runtime.ts"
import { normalizeReleasePlatform } from "./lib/release-target.ts"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const releaseRoot = resolve(repoRoot, "dist", "release")
const stagingReleaseRoot = await mkdtemp(join(tmpdir(), "wp-codebox-release-"))
const packageRoot = join(stagingReleaseRoot, "wp-codebox-cli")
const platformName = process.env.WP_CODEBOX_RELEASE_PLATFORM ?? normalizeReleasePlatform(platform())
const archName = process.env.WP_CODEBOX_RELEASE_ARCH ?? normalizeArch(arch())
sharpRuntimePackageNames(platformName, archName)
const nodeRuntimeVersion = process.env.WP_CODEBOX_NODE_RUNTIME_VERSION ?? "24.16.0"
const artifactName = `wp-codebox-cli-${platformName}-${archName}.tar.gz`
const artifactPath = resolve(repoRoot, "dist", artifactName)
const recursiveRmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }

try {
  await execFileAsync("npm", ["run", "build:release"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 })

  await mkdir(packageRoot, { recursive: true })

  await copyIfPresent("README.md")
  await copyIfPresent("LICENSE")
  await cp(resolve(repoRoot, "patches"), join(packageRoot, "patches"), { recursive: true })
  await cp(resolve(repoRoot, "package.json"), join(packageRoot, "package.json"))
  await cp(resolve(repoRoot, "npm-shrinkwrap.json"), join(packageRoot, "npm-shrinkwrap.json"))
  await cp(resolve(repoRoot, "runtime-overlays"), join(packageRoot, "runtime-overlays"), { recursive: true })
  await mkdir(join(packageRoot, "scripts"), { recursive: true })
  await cp(resolve(repoRoot, "scripts", "apply-development-patches.mjs"), join(packageRoot, "scripts", "apply-development-patches.mjs"))

  for (const packageName of ["runtime-core", "runtime-playground", "cli"]) {
    const sourceRoot = resolve(repoRoot, "packages", packageName)
    const targetRoot = join(packageRoot, "packages", packageName)
    await mkdir(targetRoot, { recursive: true })
    await cp(join(sourceRoot, "package.json"), join(targetRoot, "package.json"))
    await cp(join(sourceRoot, "dist"), join(targetRoot, "dist"), { recursive: true })
    if (packageName === "cli") {
      await chmod(join(targetRoot, "dist", "index.js"), 0o755)
    }
  }

  await execFileAsync("npm", ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-fund", "--no-audit"], {
    cwd: packageRoot,
    maxBuffer: 1024 * 1024 * 20,
  })
  await materializePinnedPhpWasmOverlay(packageRoot)
  await materializeSharpReleaseRuntime(packageRoot, join(packageRoot, "npm-shrinkwrap.json"), platformName, archName)
  await execFileAsync(process.execPath, [resolve(repoRoot, "node_modules", "patch-package", "index.js")], {
    cwd: packageRoot,
    maxBuffer: 1024 * 1024 * 20,
  })
  await materializeWorkspacePackages(packageRoot)
  await writeBrowserProvenance(packageRoot)
  await bundleNodeRuntime(packageRoot, platformName, archName)

  const binDir = join(packageRoot, "bin")
  await mkdir(binDir, { recursive: true })
  const binPath = join(binDir, "wp-codebox")
  await writeFile(binPath, `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="\${WP_CODEBOX_NODE_BIN:-}"
if [ -z "\${NODE_BIN}" ]; then
	if [ -x "\${SCRIPT_DIR}/../vendor/node/bin/node" ] && "\${SCRIPT_DIR}/../vendor/node/bin/node" --version >/dev/null 2>&1; then
		NODE_BIN="\${SCRIPT_DIR}/../vendor/node/bin/node"
	elif command -v node >/dev/null 2>&1; then
		NODE_BIN="$(command -v node)"
	elif command -v nodejs >/dev/null 2>&1; then
		NODE_BIN="$(command -v nodejs)"
	else
		echo "WP Codebox could not find a Node.js runtime. Bundle vendor/node/bin/node, set WP_CODEBOX_NODE_BIN, or install node on PATH." >&2
		exit 127
	fi
fi
exec "\${NODE_BIN}" "\${SCRIPT_DIR}/../packages/cli/dist/index.js" "$@"
`)
  await chmod(binPath, 0o755)

  // npm ci can recreate workspace files using the caller's umask, so enforce
  // the public entrypoint contract again at the final archive boundary.
  await chmod(join(packageRoot, "packages", "cli", "dist", "index.js"), 0o755)

  await rm(releaseRoot, recursiveRmOptions)
  await mkdir(releaseRoot, { recursive: true })
  await cp(packageRoot, join(releaseRoot, "wp-codebox-cli"), { recursive: true })

  await execFileAsync("tar", ["-czf", artifactPath, "-C", stagingReleaseRoot, "wp-codebox-cli"], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  })

  // The deployable artifact is the WordPress plugin zip declared by homeboy.json
  // (build_artifact: packages/wordpress-plugin/dist/wp-codebox.zip). The component
  // build script already assembles it, and `assembleWordpressPluginZip` stages the
  // packages it bundles itself rather than reading the CLI tree staged above, so
  // rebuilding it here produced a second set of bytes at the same path and made
  // the release asset's authority ambiguous. Surface the built artifact in the
  // manifest so the release pipeline uploads it as a GitHub Release asset.

  process.stdout.write(
    JSON.stringify([
      { path: "packages/wordpress-plugin/dist/wp-codebox.zip", type: "wordpress-plugin-zip" },
      { path: `dist/${artifactName}`, type: "node-cli-tarball", platform: `${platformName}-${archName}` },
    ]) + "\n",
  )
} finally {
  await rm(stagingReleaseRoot, recursiveRmOptions)
}

async function copyIfPresent(relativePath: string): Promise<void> {
  try {
    await cp(resolve(repoRoot, relativePath), join(packageRoot, relativePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }
}

async function materializePinnedPhpWasmOverlay(root: string): Promise<void> {
  const source = join(root, "runtime-overlays", "php-wasm-node-8-3")
  const target = join(root, "node_modules", "@php-wasm", "node-8-3")
  await rm(target, recursiveRmOptions)
  await cp(source, target, { recursive: true })
  await cp(join(root, "runtime-overlays", "provenance.json"), join(root, "php-wasm-overlay-provenance.json"))
  await rm(join(root, "runtime-overlays"), recursiveRmOptions)
}

async function materializeWorkspacePackages(root: string): Promise<void> {
  const automatticModules = join(root, "node_modules", "@automattic")
  await mkdir(automatticModules, { recursive: true })

  const packages = new Map([
    ["runtime-core", "wp-codebox-core"],
    ["runtime-playground", "wp-codebox-playground"],
    ["cli", "wp-codebox-cli"],
  ])
  for (const [sourceName, packageName] of packages) {
    const target = join(automatticModules, packageName)
    await rm(target, recursiveRmOptions)
    await cp(join(root, "packages", sourceName), target, { recursive: true, dereference: true })
  }
}

async function writeBrowserProvenance(root: string): Promise<void> {
  const packageRequire = createRequire(join(root, "package.json"))
  const playwright = packageRequire("playwright/package.json") as { version: string }
  const browsers = JSON.parse(await readFile(join(dirname(packageRequire.resolve("playwright-core")), "browsers.json"), "utf8")) as { browsers: Array<{ name: string; revision: string; browserVersion?: string }> }
  const chromium = browsers.browsers.find((browser) => browser.name === "chromium")
  if (!chromium?.browserVersion) throw new Error("Installed Playwright package has no Chromium browser provenance.")
  const dependencyManifest = await readFile(join(root, "npm-shrinkwrap.json"))
  await writeFile(join(root, "browser-provenance.json"), `${JSON.stringify({
    schema: "wp-codebox/playwright-browser-provenance/v1",
    playwrightVersion: playwright.version,
    chromiumRevision: chromium.revision,
    chromiumVersion: chromium.browserVersion,
    platform: platformName,
    arch: archName,
    dependencyManifestSha256: createHash("sha256").update(dependencyManifest).digest("hex"),
  }, null, 2)}\n`)
}

async function bundleNodeRuntime(root: string, platformName: string, archName: string): Promise<void> {
  const nodePackageName = nodeRuntimePackageName(platformName, archName)
  const runtimeRoot = join(root, "vendor", "node")
  await rm(runtimeRoot, recursiveRmOptions)
  await mkdir(join(runtimeRoot, "bin"), { recursive: true })

  if (nodePackageName) {
    const tempRoot = await mkdtemp(join(tmpdir(), "wp-codebox-node-runtime-"))
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", `${nodePackageName}@${nodeRuntimeVersion}`, "--pack-destination", tempRoot, "--json"],
        { cwd: repoRoot, maxBuffer: 1024 * 1024 * 20 },
      )
      const [packed] = JSON.parse(stdout) as Array<{ filename: string }>
      const tarball = join(tempRoot, packed.filename)
      await execFileAsync("tar", ["-xzf", tarball, "-C", tempRoot, "package/bin/node"], {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024 * 10,
      })
      await cp(join(tempRoot, "package", "bin", "node"), join(runtimeRoot, "bin", "node"))
      await chmod(join(runtimeRoot, "bin", "node"), 0o755)
    } finally {
      await rm(tempRoot, recursiveRmOptions)
    }
  } else if (platformName === normalizeReleasePlatform(platform()) && archName === normalizeArch(arch())) {
    await cp(process.execPath, join(runtimeRoot, "bin", "node"))
    await chmod(join(runtimeRoot, "bin", "node"), 0o755)
  } else {
    await writeFile(
      join(runtimeRoot, "README.md"),
      `No bundled Node.js runtime is available for ${platformName}-${archName}. Set WP_CODEBOX_NODE_BIN or install node on PATH.\n`,
    )
  }
}

function nodeRuntimePackageName(platformName: string, archName: string): string | null {
  if (platformName === "linux" && (archName === "x64" || archName === "arm64")) {
    return `node-linux-${archName}`
  }

  return null
}

function normalizeArch(value: string): string {
  if (value === "x64") {
    return "x64"
  }
  if (value === "arm64") {
    return "arm64"
  }
  return value
}
