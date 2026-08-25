import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

export const CLI_BUILD_PROVENANCE_FILE = "cli-build-provenance.json"

export interface CliBuildProvenance {
  schema: "wp-codebox/cli-build-provenance/v1"
  package: { name: string; version: string }
  source: FileIdentity
  dist: FileIdentity
  git: { commit?: string; ref?: string }
}

interface FileIdentity {
  sha256: string
  files: number
}

interface GitRelationship {
  head: string
  ref?: string
  upstream?: string
  upstreamHead?: string
  ahead?: number
  behind?: number
  evidence: "local-tracking-ref" | "unavailable"
  reason?: string
  remoteFetch: "not-attempted"
}

export interface CliFreshnessCheck {
  id: "wp-codebox.source"
  status: "ok" | "warning" | "error"
  message: string
  details: Record<string, unknown>
}

export async function writeCliBuildProvenance(repositoryRoot: string, packageRoot: string): Promise<CliBuildProvenance> {
  const packageMetadata = await readPackageMetadata(packageRoot)
  const relationship = await gitRelationship(repositoryRoot)
  const expectedCommit = process.env.WP_CODEBOX_SOURCE_SHA
  if (expectedCommit && relationship && expectedCommit !== relationship.head) {
    throw new Error(`WP_CODEBOX_SOURCE_SHA ${expectedCommit} does not match source checkout HEAD ${relationship.head}`)
  }

  const provenance: CliBuildProvenance = {
    schema: "wp-codebox/cli-build-provenance/v1",
    package: packageMetadata,
    source: await sourceIdentity(repositoryRoot, packageRoot),
    dist: await distIdentity(packageRoot),
    git: { commit: relationship?.head ?? expectedCommit, ref: process.env.WP_CODEBOX_SOURCE_REF ?? relationship?.ref },
  }
  await writeFile(join(packageRoot, "dist", CLI_BUILD_PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`)
  return provenance
}

export async function inspectCliFreshness(packageRoot: string, binaryPath: string): Promise<CliFreshnessCheck> {
  const provenancePath = join(packageRoot, "dist", CLI_BUILD_PROVENANCE_FILE)
  const details: Record<string, unknown> = { packageRoot, binaryPath, provenancePath }
  if (!existsSync(provenancePath)) {
    return {
      id: "wp-codebox.source",
      status: "warning",
      message: "CLI build provenance is missing; reinstall a release artifact or run npm run build in the source checkout",
      details,
    }
  }

  let parsedProvenance: unknown
  try {
    parsedProvenance = JSON.parse(await readFile(provenancePath, "utf8"))
  } catch (error) {
    return { id: "wp-codebox.source", status: "error", message: "CLI build provenance is unreadable; rebuild or reinstall WP Codebox", details: { ...details, error: errorMessage(error) } }
  }
  if (!parsedProvenance || typeof parsedProvenance !== "object") {
    return { id: "wp-codebox.source", status: "error", message: "CLI build provenance schema is invalid; rebuild or reinstall WP Codebox", details: { ...details, provenance: parsedProvenance } }
  }
  const provenance = parsedProvenance as CliBuildProvenance
  details.provenance = provenance
  if (provenance.schema !== "wp-codebox/cli-build-provenance/v1") {
    return { id: "wp-codebox.source", status: "error", message: "CLI build provenance schema is invalid; rebuild or reinstall WP Codebox", details }
  }

  const packageMetadata = await readPackageMetadata(packageRoot)
  details.package = packageMetadata
  if (packageMetadata.name !== provenance.package?.name || packageMetadata.version !== provenance.package?.version) {
    return { id: "wp-codebox.source", status: "error", message: "CLI package metadata does not match its immutable build provenance; rebuild or reinstall WP Codebox", details }
  }

  const currentDist = await distIdentity(packageRoot)
  details.dist = currentDist
  if (currentDist.sha256 !== provenance.dist?.sha256) {
    return { id: "wp-codebox.source", status: "error", message: "CLI dist differs from its immutable build provenance; run npm run build or reinstall WP Codebox", details }
  }

  const repositoryRoot = await gitTopLevel(packageRoot)
  if (!repositoryRoot) {
    return { id: "wp-codebox.source", status: "ok", message: "packaged CLI build provenance verified (not running from a Git checkout)", details }
  }

  details.repositoryRoot = repositoryRoot
  const currentSource = await sourceIdentity(repositoryRoot, packageRoot)
  details.source = currentSource
  if (currentSource.sha256 !== provenance.source?.sha256) {
    return { id: "wp-codebox.source", status: "error", message: "CLI source differs from the source identity used to build dist; run npm run build", details }
  }

  const relationship = await gitRelationship(repositoryRoot)
  details.git = relationship ?? { evidence: "unavailable", reason: "Git HEAD could not be read", remoteFetch: "not-attempted" }
  if (!relationship) {
    return { id: "wp-codebox.source", status: "warning", message: "CLI source and dist match, but Git freshness evidence is unavailable", details }
  }
  if (provenance.git?.commit && provenance.git.commit !== relationship.head) {
    return { id: "wp-codebox.source", status: "error", message: "CLI dist was built from a different Git commit; run npm run build", details }
  }
  if (relationship.evidence === "unavailable" && relationship.upstream) {
    return { id: "wp-codebox.source", status: "warning", message: `CLI source and dist match, but configured upstream ${relationship.upstream} is unavailable locally; remote fetch was not attempted`, details }
  }
  if ((relationship.ahead ?? 0) > 0 && (relationship.behind ?? 0) > 0) {
    return { id: "wp-codebox.source", status: "warning", message: `CLI checkout has diverged from locally available upstream ${relationship.upstream}`, details }
  }
  if ((relationship.behind ?? 0) > 0) {
    return { id: "wp-codebox.source", status: "warning", message: `CLI checkout is ${relationship.behind} commit(s) behind locally available upstream ${relationship.upstream}; refresh the checkout, then run npm run build`, details }
  }
  if ((relationship.ahead ?? 0) > 0) {
    return { id: "wp-codebox.source", status: "ok", message: `CLI source/dist provenance verified; checkout is ${relationship.ahead} commit(s) ahead of locally available upstream ${relationship.upstream}`, details }
  }
  if (relationship.upstream) {
    return { id: "wp-codebox.source", status: "ok", message: `CLI source/dist provenance verified against locally available upstream ${relationship.upstream}; remote fetch was not attempted`, details }
  }
  return { id: "wp-codebox.source", status: "ok", message: "CLI source/dist provenance verified; no configured upstream is available and remote fetch was not attempted", details }
}

export async function findPackageRoot(start: string): Promise<string | undefined> {
  let directory = dirname(start)
  while (directory && directory !== dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return directory
    directory = dirname(directory)
  }
  return undefined
}

async function readPackageMetadata(packageRoot: string): Promise<{ name: string; version: string }> {
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string }
  if (!metadata.name || !metadata.version) throw new Error(`CLI package metadata is incomplete at ${packageRoot}`)
  return { name: metadata.name, version: metadata.version }
}

async function sourceIdentity(repositoryRoot: string, packageRoot: string): Promise<FileIdentity> {
  repositoryRoot = await realpath(repositoryRoot)
  packageRoot = await realpath(packageRoot)
  const files = [
    ...(await recursiveFiles(join(packageRoot, "src"))),
    join(packageRoot, "package.json"),
    join(packageRoot, "tsconfig.json"),
    join(repositoryRoot, "tsconfig.base.json"),
  ].filter(existsSync)
  return hashFiles(repositoryRoot, files)
}

async function distIdentity(packageRoot: string): Promise<FileIdentity> {
  const distRoot = join(packageRoot, "dist")
  const files = (await recursiveFiles(distRoot)).filter((path) => path !== join(distRoot, CLI_BUILD_PROVENANCE_FILE) && !path.endsWith(".tsbuildinfo"))
  return hashFiles(packageRoot, files)
}

async function recursiveFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await recursiveFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function hashFiles(root: string, files: string[]): Promise<FileIdentity> {
  const hash = createHash("sha256")
  for (const path of files.sort()) {
    hash.update(relative(root, path).split("\\").join("/"))
    hash.update("\0")
    hash.update(await readFile(path))
    hash.update("\0")
  }
  return { sha256: hash.digest("hex"), files: files.length }
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"])
  return result?.stdout ? resolve(result.stdout) : undefined
}

async function gitRelationship(cwd: string): Promise<GitRelationship | undefined> {
  const head = await git(cwd, ["rev-parse", "HEAD"])
  if (!head?.stdout) return undefined
  const ref = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.stdout
  const upstream = (await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.stdout ?? await configuredUpstream(cwd, ref)
  if (!upstream) {
    return { head: head.stdout, ref, evidence: "unavailable", reason: "no configured upstream", remoteFetch: "not-attempted" }
  }
  const upstreamHead = (await git(cwd, ["rev-parse", upstream]))?.stdout
  const counts = await git(cwd, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])
  if (!upstreamHead || !counts?.stdout) {
    return { head: head.stdout, ref, upstream, evidence: "unavailable", reason: "configured upstream ref is unavailable locally", remoteFetch: "not-attempted" }
  }
  const [ahead, behind] = counts.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10))
  return { head: head.stdout, ref, upstream, upstreamHead, ahead, behind, evidence: "local-tracking-ref", remoteFetch: "not-attempted" }
}

async function configuredUpstream(cwd: string, ref?: string): Promise<string | undefined> {
  if (!ref) return undefined
  const remote = (await git(cwd, ["config", "--get", `branch.${ref}.remote`]))?.stdout
  const merge = (await git(cwd, ["config", "--get", `branch.${ref}.merge`]))?.stdout
  if (!remote || !merge) return undefined
  const branch = merge.replace(/^refs\/heads\//, "")
  return remote === "." ? branch : `${remote}/${branch}`
}

function git(cwd: string, args: string[]): Promise<{ stdout: string } | undefined> {
  return new Promise((resolveGit) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    const stdout: Buffer[] = []
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.once("error", () => resolveGit(undefined))
    child.once("close", (code) => resolveGit(code === 0 ? { stdout: Buffer.concat(stdout).toString().trim() } : undefined))
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
