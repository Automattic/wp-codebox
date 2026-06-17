import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const cliPath = resolve(repoRoot, "packages/cli/dist/index.js")

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export async function runCliJson<T>(args: string[]): Promise<T> {
  const stdout = await runCliText(args)
  return JSON.parse(stdout) as T
}

export async function runCliText(args: string[]): Promise<string> {
  return runCommandText(process.execPath, [cliPath, ...args], { cwd: repoRoot })
}

export async function runCommandJson<T>(command: string, args: string[], options: CommandOptions = {}): Promise<T> {
  return JSON.parse(await runCommandText(command, args, options)) as T
}

export async function runCommandText(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd: options.cwd ?? repoRoot, env: options.env })
  return stdout
}

export async function runPhpJson<T>(code: string, options: CommandOptions = {}): Promise<T> {
  return runCommandJson<T>("php", ["-r", code], options)
}

export async function runPhpFileJson<T>(path: string, options: CommandOptions = {}): Promise<T> {
  return runCommandJson<T>("php", [path], options)
}

export async function evaluatePhpJson<T>(expression: string, requires: string[] = []): Promise<T> {
  const code = [
    `define('ABSPATH', ${phpStringLiteral(repoRoot)});`,
    ...requires.map((path) => `require ${phpStringLiteral(resolve(repoRoot, path))};`),
    `echo json_encode(${expression}, JSON_UNESCAPED_SLASHES);`,
  ].join(" ")
  return runPhpJson<T>(code)
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

export async function assertTextFile(path: string, expected: string): Promise<void> {
  assert.equal(await readFile(path, "utf8"), expected)
}

export async function assertJsonFile<T>(path: string, expected?: T): Promise<T> {
  const json = await readJson<T>(path)
  if (arguments.length > 1) {
    assert.deepEqual(json, expected)
  }
  return json
}

export async function listRelativeFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  await collectFiles(directory, directory, files)
  return files
}

export function phpFunctionBlock(source: string, method: string): string {
  const signature = source.indexOf(`function ${method}(`)
  assert.notEqual(signature, -1, `${method} method exists`)

  const bodyStart = source.indexOf("{", signature)
  assert.notEqual(bodyStart, -1, `${method} method has a body`)
  return source.slice(signature, findBalancedEnd(source, bodyStart, "{", "}") + 1)
}

export function phpCallBlock(source: string, callName: string, containing: string): string {
  const containingIndex = source.indexOf(containing)
  assert.notEqual(containingIndex, -1, `${containing} exists`)

  const callStart = source.lastIndexOf(`${callName}(`, containingIndex)
  assert.notEqual(callStart, -1, `${callName} call exists before ${containing}`)

  const argsStart = source.indexOf("(", callStart)
  const argsEnd = findBalancedEnd(source, argsStart, "(", ")")
  const statementEnd = source.indexOf(";", argsEnd)
  assert.notEqual(statementEnd, -1, `${callName} call has a statement terminator`)
  return source.slice(callStart, statementEnd + 1)
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

function findBalancedEnd(source: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let index = start; index < source.length; index++) {
    if (source[index] === open) depth++
    if (source[index] === close) depth--
    if (depth === 0) return index
  }
  assert.fail(`Unbalanced ${open}${close} block`)
}

export function phpStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
}
