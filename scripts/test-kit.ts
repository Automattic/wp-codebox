import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const cliPath = resolve(repoRoot, "packages/cli/dist/index.js")

export async function runCliJson<T>(args: string[]): Promise<T> {
  const stdout = await runCliText(args)
  return JSON.parse(stdout) as T
}

export async function runCliText(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: repoRoot })
  return stdout
}

export async function withTempDir<T>(prefix: string, callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

export async function listRelativeFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  await collectFiles(directory, directory, files)
  return files
}

async function collectFiles(root: string, directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(root, path, files)
    } else if (entry.isFile()) {
      files.push(relative(root, path).replace(/\\/g, "/"))
    }
  }
}
