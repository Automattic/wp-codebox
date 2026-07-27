import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { ArtifactTestResults, ExecutionResult } from "@automattic/wp-codebox-core"

export const PHPUNIT_COMPLETED_RESULT_PREFIX = "WP_CODEBOX_PHPUNIT_RESULT:"

export interface PhpunitCompletedResult {
  schema: "wp-codebox/phpunit-result/v1"
  status: "passed" | "failed"
  total: number
  passed: number
  failed: number
  skipped: number
  assertions: number
  failures: number
  errors: number
}

export interface CapturedPhpunitCompletedResult {
  path: string
  result: PhpunitCompletedResult
}

export function parsePhpunitCompletedResult(log: string): PhpunitCompletedResult | undefined {
  for (const line of log.split("\n").reverse()) {
    if (!line.startsWith(PHPUNIT_COMPLETED_RESULT_PREFIX)) continue

    try {
      const value = JSON.parse(line.slice(PHPUNIT_COMPLETED_RESULT_PREFIX.length)) as Record<string, unknown>
      if (
        value.schema !== "wp-codebox/phpunit-result/v1"
        || (value.status !== "passed" && value.status !== "failed")
        || !validCount(value.total)
        || !validCount(value.skipped)
        || !validCount(value.assertions)
        || !validCount(value.failures)
        || !validCount(value.errors)
        || value.failures + value.errors + value.skipped > value.total
        || (value.status === "passed") !== (value.failures + value.errors === 0)
      ) {
        return undefined
      }
      const failed = value.failures + value.errors
      return {
        schema: value.schema,
        status: value.status,
        total: value.total,
        passed: value.total - failed - value.skipped,
        failed,
        skipped: value.skipped,
        assertions: value.assertions,
        failures: value.failures,
        errors: value.errors,
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

export function parsePhpunitOutput(output: string): PhpunitCompletedResult | undefined {
  const summaries = [...output.matchAll(/Tests:\s*(\d+)([^\r\n]*)/g)]
  const summary = summaries.at(-1)
  if (summary) {
    const count = (label: string): number => Number(summary[2].match(new RegExp(`(?:^|,\\s*)${label}:\\s*(\\d+)`))?.[1] ?? 0)
    const total = Number(summary[1])
    const failures = count("Failures")
    const errors = count("Errors")
    const skipped = count("Skipped")
    const assertions = count("Assertions")
    return completedResult(total, assertions, failures, errors, skipped)
  }

  const successful = [...output.matchAll(/OK \((\d+) tests?,\s*(\d+) assertions?\)/g)].at(-1)
  return successful ? completedResult(Number(successful[1]), Number(successful[2]), 0, 0, 0) : undefined
}

export async function readCapturedPhpunitCompletedResults(artifactRoot: string): Promise<CapturedPhpunitCompletedResult[]> {
  const paths = await phpunitResultPaths(join(artifactRoot, "files", "phpunit"))
  const results: CapturedPhpunitCompletedResult[] = []

  for (const path of paths) {
    const result = parsePhpunitCompletedResult(await readFile(path, "utf8"))
    if (result) results.push({ path: relative(artifactRoot, path), result })
  }
  return results
}

export function buildPhpunitTestResults(commands: ExecutionResult[], completed: CapturedPhpunitCompletedResult[]): ArtifactTestResults {
  const phpunitCommands = commands.filter((command) => command.command === "wordpress.phpunit")
  const rawLogReferences = [
    { path: "commands.jsonl", kind: "commands-jsonl" },
    { path: "logs/commands.log", kind: "commands-log" },
    ...completed.flatMap(({ path }) => [
      { path, kind: "phpunit-result" },
      { path: phpunitDiagnosticPath(path), kind: "phpunit-output" },
    ]),
  ]
  const suites: ArtifactTestResults["suites"] = completed.map(({ path, result }, index) => ({
    name: completed.length === 1 ? "wordpress.phpunit" : `wordpress.phpunit:${index + 1}`,
    status: result.status,
    tests: result.total,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    unknown: 0,
    rawLogReferences: [{ path, kind: "phpunit-result" }, { path: phpunitDiagnosticPath(path), kind: "phpunit-output" }, { path: "logs/commands.log", kind: "commands-log" }],
  }))
  for (let index = completed.length; index < phpunitCommands.length; index += 1) {
    suites.push({
      name: phpunitCommands.length === 1 ? "wordpress.phpunit" : `wordpress.phpunit:${index + 1}`,
      status: "unknown",
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      unknown: 0,
      rawLogReferences: [{ path: "logs/commands.log", kind: "commands-log" }],
    })
  }

  const summary = completed.reduce((aggregate, { result }) => ({
    total: aggregate.total + result.total,
    passed: aggregate.passed + result.passed,
    failed: aggregate.failed + result.failed,
    skipped: aggregate.skipped + result.skipped,
    unknown: aggregate.unknown,
  }), { total: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 })
  const hasUnknownSuite = suites.some((suite) => suite.status === "unknown")
  const status = suites.some((suite) => suite.status === "failed")
    ? "failed"
    : hasUnknownSuite || suites.length === 0
      ? "unknown"
      : summary.total > 0 && summary.skipped === summary.total
        ? "skipped"
        : "passed"

  return { schema: "wp-codebox/test-results/v1", status, summary, suites, rawLogReferences }
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

async function phpunitResultPaths(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }

  const paths: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await phpunitResultPaths(path))
    else if (entry.isFile() && entry.name === ".wp-codebox-result.txt") paths.push(path)
  }
  return paths.sort()
}

function completedResult(total: number, assertions: number, failures: number, errors: number, skipped: number): PhpunitCompletedResult {
  const failed = failures + errors
  return {
    schema: "wp-codebox/phpunit-result/v1",
    status: failed === 0 ? "passed" : "failed",
    total,
    passed: Math.max(0, total - failed - skipped),
    failed,
    skipped,
    assertions,
    failures,
    errors,
  }
}

export function phpunitDiagnosticPath(completedResultPath: string): string {
  return completedResultPath.replace(/\.wp-codebox-result\.txt$/, ".pg-test-result.txt")
}
