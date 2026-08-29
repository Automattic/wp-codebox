import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import type { SmokeCommand } from "./smoke-manifest.js"

/*
 * Test files are discovered by convention rather than registered by hand.
 * Adding tests/<name>.test.ts or scripts/<name>-smoke.ts is enough to make it
 * run. Anything that must not run has to be listed below with a reason, so the
 * exclusions stay short, visible, and reviewable.
 */

export const DISCOVERY_PATTERNS = {
  tests: /^[^/]+\.test\.(ts|mjs)$/,
  scripts: /^[^/]+-smoke\.(ts|php)$/,
} as const

type Exclusion = { file: string; reason: string }

export const DISCOVERY_EXCLUSIONS: readonly Exclusion[] = [
  { file: "scripts/run-smoke.ts", reason: "the runner itself; discovering it would recurse" },

  // Require an environment the aggregate does not provision.
  { file: "tests/mysqli-poll.integration.test.ts", reason: "requires Docker; runs in the agent-task-contracts workflow" },
  { file: "tests/runtime-sources-playground-integration.test.ts", reason: "exceeds the per-file budget; runs in the agent-task-contracts workflow" },
  { file: "tests/release-package-coverage.test.ts", reason: "needs the 427 MB plugin zip from package:wordpress-plugin; runs in the Homeboy gate" },
  {
    file: "tests/prepare-declaration-rebuild.test.ts",
    reason:
      "destructive to shared state: deletes packages/runtime-core/dist and runs npm install at the repository root, which breaks every concurrent import of @automattic/wp-codebox-core; runs in the Homeboy gate",
  },

  // Known-failing and unmaintained. Tracked for triage; see the discovery audit
  // in issue #2402. These were added in June 2026, never wired to a gate, and
  // have not been touched since.
  { file: "tests/artifact-reference-dtos.test.ts", reason: "failing and unmaintained; pending triage" },
  { file: "tests/browser-blueprint-ref-permission.test.ts", reason: "failing and unmaintained; pending triage" },
  { file: "tests/command-diagnostics.test.ts", reason: "failing and unmaintained; pending triage" },
  { file: "tests/docs-boundary-language.test.ts", reason: "failing and unmaintained; pending triage" },
  { file: "tests/performance-observation-contracts.test.ts", reason: "blocked on raw NUL in generated PHP; pending triage" },
  { file: "tests/rest-request-query-params.test.ts", reason: "blocked on raw NUL in generated PHP; pending triage" },
  { file: "tests/wordpress-crud-contracts.test.ts", reason: "blocked on raw NUL in generated PHP; pending triage" },
  { file: "tests/temp-runtime-cleanup.test.ts", reason: "failing and unmaintained; pending triage" },
  { file: "tests/wordpress-runtime-discovery-coverage-plan.test.ts", reason: "failing and unmaintained; pending triage" },
  { file: "scripts/agent-runtime-task-ability-smoke.ts", reason: "failing and unmaintained; pending triage" },
]

/*
 * These contend on the shared Playground WordPress archive cache, or boot a
 * full browser and WordPress runtime and time out when starved of CPU. They are
 * correct in isolation, so they run in a serial phase after the parallel one
 * rather than being excluded.
 */
export const DISCOVERY_SERIAL: readonly string[] = [
  "scripts/doctor-command-smoke.ts",
  "tests/bounded-recipe-plan.integration.test.ts",
  "tests/phpunit-runtime-rejection.test.ts",
  "tests/playground-readonly-mounts.test.ts",
  "tests/playground-phpunit-bootstrap-failure.integration.test.ts",
  "tests/browser-actions-navigation-capture.browser.test.ts",
  "tests/editor-actions-save.integration.test.ts",
]

const excluded = new Set(DISCOVERY_EXCLUSIONS.map((entry) => entry.file))
const serial = new Set(DISCOVERY_SERIAL)

function listFiles(root: string, directory: string, pattern: RegExp): string[] {
  return readdirSync(join(root, directory))
    .filter((entry) => pattern.test(entry))
    .filter((entry) => statSync(join(root, directory, entry)).isFile())
    .map((entry) => `${directory}/${entry}`)
}

export function discoverSmokeFiles(root = process.cwd()): string[] {
  const files = [
    ...listFiles(root, "tests", DISCOVERY_PATTERNS.tests),
    ...listFiles(root, "scripts", DISCOVERY_PATTERNS.scripts),
  ]
  return files.filter((file) => !excluded.has(file)).sort()
}

function toCommand(file: string): SmokeCommand {
  return {
    name: file,
    command: file.endsWith(".php") ? "php" : file.endsWith(".mjs") ? "node" : "tsx",
    args: [file],
  }
}

export function discoveredCommands(root = process.cwd()): SmokeCommand[] {
  return discoverSmokeFiles(root).map(toCommand)
}

/** Files safe to run concurrently. */
export function discoveredParallelCommands(root = process.cwd()): SmokeCommand[] {
  return discoverSmokeFiles(root).filter((file) => !serial.has(file)).map(toCommand)
}

/** Files that must run one at a time, after the parallel phase. */
export function discoveredSerialCommands(root = process.cwd()): SmokeCommand[] {
  const found = new Set(discoverSmokeFiles(root))
  return DISCOVERY_SERIAL.filter((file) => found.has(file)).map(toCommand)
}
