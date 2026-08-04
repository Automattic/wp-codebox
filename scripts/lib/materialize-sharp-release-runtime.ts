import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const recursiveRmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }

const sharpRuntimePackages: Record<string, readonly string[]> = {
  "linux-arm64": ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"],
  "linux-x64": ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"],
  "macos-arm64": ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"],
  "macos-x64": ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"],
  "windows-arm64": ["@img/sharp-win32-arm64"],
  "windows-x64": ["@img/sharp-win32-x64"],
}

export interface LockedReleasePackage {
  version?: string
  resolved?: string
  integrity?: string
}

interface DependencyManifest {
  packages?: Record<string, LockedReleasePackage>
}

export function sharpRuntimePackageNames(platformName: string, archName: string): readonly string[] {
  const target = `${platformName}-${archName}`
  const packages = sharpRuntimePackages[target]
  if (!packages) {
    throw new Error(`No Sharp native runtime mapping exists for release target ${target}. Supported targets: ${Object.keys(sharpRuntimePackages).sort().join(", ")}.`)
  }
  return packages
}

export async function materializeSharpReleaseRuntime(
  root: string,
  dependencyManifestPath: string,
  platformName: string,
  archName: string,
): Promise<void> {
  const target = `${platformName}-${archName}`
  const packageNames = sharpRuntimePackageNames(platformName, archName)
  const manifest = JSON.parse(await readFile(dependencyManifestPath, "utf8")) as DependencyManifest

  for (const packageName of packageNames) {
    const lockPath = `node_modules/${packageName}`
    const lockedPackage = manifest.packages?.[lockPath]
    if (!lockedPackage?.version || !lockedPackage.resolved || !lockedPackage.integrity) {
      throw new Error(`Cannot materialize Sharp runtime for release target ${target}: ${lockPath} must have version, resolved, and integrity fields in npm-shrinkwrap.json.`)
    }

    try {
      await materializeLockedPackage(root, packageName, lockedPackage)
    } catch (error) {
      throw new Error(`Failed to materialize Sharp runtime package ${packageName} for release target ${target}: ${(error as Error).message}`, { cause: error })
    }
  }
}

async function materializeLockedPackage(root: string, packageName: string, lockedPackage: Required<LockedReleasePackage>): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "wp-codebox-sharp-runtime-"))
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["pack", lockedPackage.resolved, "--pack-destination", tempRoot, "--json", "--ignore-scripts"],
      { cwd: root, maxBuffer: 1024 * 1024 * 20 },
    )
    const [packed] = JSON.parse(stdout) as Array<{ filename?: string }>
    if (!packed?.filename) {
      throw new Error("npm pack did not report a tarball filename")
    }

    const tarball = join(tempRoot, packed.filename)
    await materializeVerifiedPackageTarball(root, packageName, lockedPackage, tarball)
  } finally {
    await rm(tempRoot, recursiveRmOptions)
  }
}

export async function materializeVerifiedPackageTarball(
  root: string,
  packageName: string,
  lockedPackage: Required<Pick<LockedReleasePackage, "version" | "integrity">>,
  tarball: string,
): Promise<void> {
  await assertIntegrity(tarball, lockedPackage.integrity)
  const packageRoot = join(root, "node_modules", ...packageName.split("/"))
  await rm(packageRoot, recursiveRmOptions)
  await mkdir(packageRoot, { recursive: true })
  await execFileAsync("tar", ["-xzf", tarball, "-C", packageRoot, "--strip-components=1"], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 10,
  })

  const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string }
  if (packageManifest.name !== packageName || packageManifest.version !== lockedPackage.version) {
    throw new Error(`extracted ${packageManifest.name ?? "unknown"}@${packageManifest.version ?? "unknown"}, expected ${packageName}@${lockedPackage.version}`)
  }
}

async function assertIntegrity(path: string, integrity: string): Promise<void> {
  const [algorithm, expected] = integrity.split("-", 2)
  if (!algorithm || !expected) {
    throw new Error(`unsupported package integrity ${integrity}`)
  }
  let hash
  try {
    hash = createHash(algorithm)
  } catch {
    throw new Error(`unsupported package integrity ${integrity}`)
  }
  const actual = hash.update(await readFile(path)).digest("base64")
  if (actual !== expected) {
    throw new Error(`package integrity mismatch: expected ${integrity}, received ${algorithm}-${actual}`)
  }
}
