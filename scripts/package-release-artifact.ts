import { execFile } from "node:child_process"
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { arch, platform } from "node:os"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { assembleWordpressPluginZip } from "./lib/assemble-wordpress-plugin-zip.ts"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const releaseRoot = resolve(repoRoot, "dist", "release")
const stagingReleaseRoot = await mkdtemp(join(tmpdir(), "wp-codebox-release-"))
const packageRoot = join(stagingReleaseRoot, "wp-codebox-cli")
const platformName = process.env.WP_CODEBOX_RELEASE_PLATFORM ?? normalizePlatform(platform())
const archName = process.env.WP_CODEBOX_RELEASE_ARCH ?? normalizeArch(arch())
const nodeRuntimeVersion = process.env.WP_CODEBOX_NODE_RUNTIME_VERSION ?? "24.16.0"
const artifactName = `wp-codebox-cli-${platformName}-${archName}.tar.gz`
const artifactPath = resolve(repoRoot, "dist", artifactName)
const recursiveRmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }

try {
  await execFileAsync("npm", ["run", "build"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 })

  await mkdir(packageRoot, { recursive: true })

  await copyIfPresent("README.md")
  await copyIfPresent("LICENSE")
  await cp(resolve(repoRoot, "package.json"), join(packageRoot, "package.json"))
  await cp(resolve(repoRoot, "package-lock.json"), join(packageRoot, "package-lock.json"))

  for (const packageName of ["runtime-core", "runtime-playground", "cli"]) {
    const sourceRoot = resolve(repoRoot, "packages", packageName)
    const targetRoot = join(packageRoot, "packages", packageName)
    await mkdir(targetRoot, { recursive: true })
    await cp(join(sourceRoot, "package.json"), join(targetRoot, "package.json"))
    await cp(join(sourceRoot, "dist"), join(targetRoot, "dist"), { recursive: true })
  }

  await execFileAsync("npm", ["install", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-fund", "--no-audit"], {
    cwd: packageRoot,
    maxBuffer: 1024 * 1024 * 20,
  })
  await bundleNodeRuntime(packageRoot, platformName, archName)

  const binDir = join(packageRoot, "bin")
  await mkdir(binDir, { recursive: true })
  const binPath = join(binDir, "wp-codebox")
  await writeFile(binPath, `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="\${WP_CODEBOX_NODE_BIN:-}"
if [ -z "\${NODE_BIN}" ]; then
	if [ -x "\${SCRIPT_DIR}/../vendor/node/bin/node" ]; then
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

  await rm(releaseRoot, recursiveRmOptions)
  await mkdir(releaseRoot, { recursive: true })
  await cp(packageRoot, join(releaseRoot, "wp-codebox-cli"), { recursive: true })

  await execFileAsync("tar", ["-czf", artifactPath, "-C", stagingReleaseRoot, "wp-codebox-cli"], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 10,
  })

  // The deployable artifact is the WordPress plugin zip declared by homeboy.json
  // (build_artifact: packages/wordpress-plugin/dist/wp-codebox.zip). It bundles
  // the CLI release tree staged above, so build it here and surface it in the
  // manifest so the release pipeline uploads it as a GitHub Release asset.
  await assembleWordpressPluginZip(repoRoot)

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
  } else if (platformName === normalizePlatform(platform()) && archName === normalizeArch(arch())) {
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

function normalizePlatform(value: NodeJS.Platform): string {
  if (value === "darwin") {
    return "macos"
  }
  if (value === "win32") {
    return "windows"
  }
  return value
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
