import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import type { SmokeCommand } from "./smoke-manifest.js"

/*
 * Test files are discovered by convention rather than registered by hand.
 * Adding tests/<name>.test.ts or scripts/<name>-smoke.ts is enough to make it
 * run. Files are classified into fast, integration, and browser lanes below.
 * Anything that must not run has to be listed with a reason, so exclusions stay
 * short, visible, and reviewable.
 */

export const DISCOVERY_PATTERNS = {
  tests: /^[^/]+\.test\.(ts|mjs)$/,
  scripts: /^[^/]+-smoke\.(ts|php)$/,
} as const

type Exclusion = { file: string; reason: string }
export type SmokeLane = "fast" | "integration" | "browser" | "all"

export const DISCOVERY_EXCLUSIONS: readonly Exclusion[] = [
  { file: "scripts/run-smoke.ts", reason: "the runner itself; discovering it would recurse" },

  // Require an environment the aggregate does not provision.
  { file: "tests/release-package-coverage.test.ts", reason: "needs the 427 MB plugin zip from package:wordpress-plugin; runs in the Homeboy gate" },
  { file: "tests/derive-cloudflare-core-contract-atomic.test.mjs", reason: "covers the Cloudflare-owned derivation writer; runs with package boundaries in the Cloudflare Check workflow" },
  { file: "tests/runtime-package-boundaries.test.mjs", reason: "requires the independent Cloudflare package install; runs in the Cloudflare Check workflow" },
  {
    file: "tests/prepare-declaration-rebuild.test.ts",
    reason:
      "destructive to shared state: deletes packages/runtime-core/dist and runs npm install at the repository root, which breaks every concurrent import of @automattic/wp-codebox-core; runs in the Homeboy gate",
  },
]

const INTEGRATION_FILES: readonly string[] = [
  "scripts/doctor-command-smoke.ts",
  "tests/execute-native-agent-task-playground-e2e.test.ts",
  "tests/playground-custom-archive-cache-process.test.ts",
  "tests/playground-readonly-mounts.test.ts",
  "tests/runtime-sources-playground-integration.test.ts",
]

const BROWSER_FILES: readonly string[] = [
  "tests/browser-accessibility-oracles.test.ts",
  "tests/browser-action-corpus.test.ts",
  "tests/browser-adaptive-exploration.test.ts",
  "tests/browser-canonical-preview-origin.test.ts",
  "tests/browser-multi-actor-scenario.test.ts",
  "tests/browser-recipe-file-payloads.integration.test.ts",
  "tests/browser-routed-command-security.test.ts",
  "tests/browser-visual-compare-animated-media.test.ts",
  "tests/browser-visual-compare-capture-reliability.test.ts",
  "tests/browser-visual-compare-dom-snapshots.test.ts",
  "tests/browser-visual-compare-url-capture.test.ts",
  "tests/browser-viewport-replay.test.ts",
  "tests/editor-actions-save.integration.test.ts",
  "tests/native-docker-runtime.integration.test.ts",
  "tests/playground-mapped-domain-multisite.integration.test.ts",
  "tests/playground-staged-upload-preview.integration.test.ts",
  "tests/runtime-backed-multisite-workload.integration.test.ts",
]

/* Files that share process handlers or Playground caches remain serial within their lane. */
const DISCOVERY_SERIAL: readonly string[] = [
  "tests/bounded-recipe-plan.integration.test.ts",
  "tests/phpunit-runtime-rejection.test.ts",
  "tests/playground-readonly-mounts-integration.test.ts",
  "tests/playground-readonly-mounts.test.ts",
  "tests/playground-phpunit-bootstrap-failure.integration.test.ts",
  "tests/recipe-step-continuation.integration.test.ts",
]

/*
 * Files owned by the declared chains in smoke-manifest.ts. The chains order
 * them deliberately and some depend on an earlier member having run, so they are
 * executed there rather than discovered independently.
 */
export const CHAIN_OWNED_FILES: readonly string[] = [
  "tests/artifact-path-primitives.test.ts",
  "tests/bench-command-step-behavior.test.ts",
  "tests/browser-callback-materialization-contracts.test.ts",
  "tests/external-mysql-runtime-service.test.ts",
  "tests/generic-ability-runtime-run.test.ts",
  "tests/native-mariadb-runtime-service.test.ts",
  "tests/runtime-services.test.ts",
  "tests/source-package-compiler-primitives.test.ts",
]

const excluded = new Set([...DISCOVERY_EXCLUSIONS.map((entry) => entry.file), ...CHAIN_OWNED_FILES])
const serial = new Set(DISCOVERY_SERIAL)
const integrations = new Set(INTEGRATION_FILES)
const browsers = new Set(BROWSER_FILES)

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

function laneFor(file: string): Exclude<SmokeLane, "all"> {
  if (file.endsWith(".browser.test.ts") || browsers.has(file)) return "browser"
  if (/[.-]integration\.test\./.test(file) || integrations.has(file)) return "integration"
  return "fast"
}

function filesForLane(root: string, lane: SmokeLane): string[] {
  const files = discoverSmokeFiles(root)
  return lane === "all" ? files : files.filter((file) => laneFor(file) === lane)
}

function toCommand(file: string, disableTsxCache = false): SmokeCommand {
  return {
    name: file,
    command: file.endsWith(".php") ? "php" : file.endsWith(".mjs") ? "node" : "tsx",
    args: disableTsxCache && file.endsWith(".ts") ? ["--no-cache", file] : [file],
  }
}

export function discoveredCommands(root = process.cwd(), lane: SmokeLane = "all"): SmokeCommand[] {
  return filesForLane(root, lane).map((file) => toCommand(file))
}

/** Files safe to run concurrently. */
export function discoveredParallelCommands(root = process.cwd(), lane: SmokeLane = "all"): SmokeCommand[] {
  return filesForLane(root, lane)
    .filter((file) => laneFor(file) !== "browser" && !serial.has(file))
    .map((file) => toCommand(file, true))
}

/** Files that must run one at a time, after the parallel phase. */
export function discoveredSerialCommands(root = process.cwd(), lane: SmokeLane = "all"): SmokeCommand[] {
  const found = new Set(filesForLane(root, lane))
  const ordered = lane === "browser"
    ? [...found]
    : lane === "all"
      ? [...found].filter((file) => laneFor(file) === "browser" || serial.has(file))
      : DISCOVERY_SERIAL.filter((file) => found.has(file))
  return ordered.map((file) => toCommand(file))
}
