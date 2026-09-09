import type { ArtifactBundle, ExecutionResult, RuntimeInfo } from "@automattic/wp-codebox-core"
import type { ArtifactBundleVerificationResult } from "@automattic/wp-codebox-core/artifacts"
import { isSensitiveKey, redactString } from "@automattic/wp-codebox-core"
import { listCliRecipeCommandDefinitions } from "./runtime-backends.js"

interface CliError {
  name: string
  message: string
  code?: string
  [key: string]: unknown
}

interface RunOutputLike {
  success: boolean
  runtime?: RuntimeInfo
  execution?: ExecutionResult
  artifacts?: ArtifactBundle
  error?: CliError
}

interface RecipeRunOutputLike extends RunOutputLike {
  executions?: ExecutionResult[]
  dryRun?: boolean
  plan?: {
    workflow?: { steps?: unknown[] }
    mounts?: unknown[]
    workspaces?: unknown[]
    extra_plugins?: unknown[]
    siteSeeds?: unknown[]
    stagedFiles?: unknown[]
  }
  validation?: {
    issues?: Array<{ code: string; path: string; message: string }>
  }
}

interface RecipeValidateOutputLike {
  recipePath?: string
  valid: boolean
  issues: Array<{ code: string; path: string; message: string }>
  summary?: {
    steps: number
    mounts: number
    workspaces: number
    extraPlugins: number
    stagedFiles?: number
  }
}

interface BlueprintValidateOutputLike extends RunOutputLike {
  blueprintPath?: string
}

interface BatchOutputLike {
  concurrency: number
  total: number
  completed: number
  runs: Array<RunOutputLike & { index: number; task: string }>
}

interface CommandCatalogOutputLike {
  commands: Array<{
    id: string
    description: string
    acceptedArgs: Array<{ name: string; required?: boolean }>
    outputShape: string
    policyRequirement: string
  }>
}

interface RecipeSchemaOutputLike {
  id: string
  jsonSchema: Record<string, unknown>
}

export async function captureStdout<T>(callback: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    logs.push(typeof chunk === "string" ? chunk : chunk.toString())

    if (typeof encodingOrCallback === "function") {
      encodingOrCallback()
    } else if (callback) {
      callback()
    }

    return true
  }) as typeof process.stdout.write

  try {
    return { result: await callback(), logs: logs.map((log) => log.trim()).filter(Boolean) }
  } finally {
    process.stdout.write = write
  }
}

const MAX_ERROR_DEPTH = 8
const MAX_ERROR_ENTRIES = 50
const MAX_ERROR_NODES = 500
export const MAX_ERROR_OUTPUT_BYTES = 192 * 1024
const MAX_ERROR_STRING_BYTES = 8 * 1024

export function serializeError(error: unknown): CliError {
  const budget = new ErrorSerializationBudget()
  const serialized = serializeErrorValue(error, 0, new WeakSet(), budget)
  return isCliError(serialized) ? serialized : { name: "Error", message: errorMessage(error) }
}

class ErrorSerializationBudget {
  bytes = 0
  nodes = 0
  exhausted = false

  canAdd(value: unknown): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.nodes >= MAX_ERROR_NODES || this.bytes + bytes > MAX_ERROR_OUTPUT_BYTES) {
      this.exhausted = true
      return false
    }
    this.nodes += 1
    this.bytes += bytes
    return true
  }
}

function serializeErrorValue(value: unknown, depth: number, seen: WeakSet<object>, budget: ErrorSerializationBudget): unknown {
  if (!budget.canAdd(typeof value)) {
    return truncation("output-budget")
  }
  if (isBinary(value)) {
    const binary = { type: binaryType(value), byteLength: binaryByteLength(value), omitted: true }
    return budget.canAdd(binary) ? binary : truncation("output-budget")
  }
  if (typeof value === "string") {
    return budgetedString(value, budget)
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value
  }
  if (typeof value === "bigint") {
    return budgetedString(`${value}n`, budget)
  }
  if (typeof value === "undefined") {
    return undefined
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return { type: typeof value, omitted: true }
  }
  if (depth >= MAX_ERROR_DEPTH) {
    return truncation("max-depth")
  }

  if (seen.has(value)) {
    return truncation("circular-reference")
  }
  seen.add(value)

  if (value instanceof Error) {
    const name = safeProperty(value, "name")
    const message = safeProperty(value, "message")
    const code = safeProperty(value, "code")
    const causeValue = safeProperty(value, "cause")
    // Reserve the identity needed to diagnose this error before traversing extras.
    const serializedName = budgetedText(typeof name === "string" ? name : "Error", "Error", budget)
    const serializedMessage = budgetedText(typeof message === "string" ? message : "Unknown error", "Unknown error", budget)
    const serializedCode = typeof code === "string" ? budgetedText(code, undefined, budget) : undefined
    const extras = serializeEntries(value, depth, seen, budget, new Set(["name", "message", "stack", "cause", "code"]))
    const cause = causeValue === undefined ? undefined : serializeErrorValue(causeValue, depth + 1, seen, budget)
    return {
      name: serializedName,
      message: serializedMessage,
      ...(serializedCode === undefined ? {} : { code: serializedCode }),
      ...extras,
      ...(cause === undefined ? {} : { cause }),
    }
  }

  if (Array.isArray(value)) {
    const entries: unknown[] = []
    for (let index = 0; index < Math.min(value.length, MAX_ERROR_ENTRIES); index += 1) {
      entries.push(serializeErrorValue(safeProperty(value, String(index)), depth + 1, seen, budget))
    }
    return value.length > MAX_ERROR_ENTRIES ? [...entries, truncation("max-entries", value.length - MAX_ERROR_ENTRIES)] : entries
  }

  return serializeEntries(value, depth, seen, budget)
}

function serializeEntries(value: object, depth: number, seen: WeakSet<object>, budget: ErrorSerializationBudget, excluded = new Set<string>()): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const keys = safeEnumerableKeys(value).filter((key) => !excluded.has(key))
  for (const key of keys.slice(0, MAX_ERROR_ENTRIES)) {
    const descriptor = safeDescriptor(value, key)
    if (!descriptor) continue
    const outputKey = boundedKey(key)
    if (!budget.canAdd(outputKey)) {
      output.serialization = truncation("output-budget")
      return output
    }
    // Define untrusted keys as data properties so __proto__ cannot change the output prototype.
    Object.defineProperty(output, outputKey, {
      value: isSensitiveKey(key) ? "[redacted]" : "value" in descriptor ? serializeErrorValue(descriptor.value, depth + 1, seen, budget) : truncation("accessor-property"),
      enumerable: true,
      configurable: true,
      writable: true,
    })
    if (budget.exhausted) {
      output.serialization = truncation("output-budget")
      return output
    }
  }
  if (keys.length > MAX_ERROR_ENTRIES && !output.serialization) {
    output.serialization = truncation("max-entries", keys.length - MAX_ERROR_ENTRIES)
  }
  return output
}

function safeEnumerableKeys(value: object): string[] {
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

function safeDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return undefined
  }
}

function safeProperty(value: object, key: string): unknown {
  let current: object | null = value
  while (current) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined
      current = Object.getPrototypeOf(current)
    } catch {
      return undefined
    }
  }
  return undefined
}

function boundedKey(key: string): string {
  if (isSensitiveKey(key)) return "[redacted]"
  const redacted = redactString(key)
  return Buffer.byteLength(redacted) <= MAX_ERROR_STRING_BYTES ? redacted : `${Buffer.from(redacted).subarray(0, MAX_ERROR_STRING_BYTES).toString("utf8")}...[truncated]`
}

function truncation(reason: string, omittedEntries?: number): Record<string, unknown> {
  return { omitted: true, reason, ...(omittedEntries === undefined ? {} : { omittedEntries }) }
}

function isCliError(value: unknown): value is CliError {
  return Boolean(value && typeof value === "object" && typeof (value as CliError).name === "string" && typeof (value as CliError).message === "string")
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return boundedText(value)
  if (value instanceof Error) {
    const message = safeProperty(value, "message")
    return boundedText(typeof message === "string" ? message : "Unknown error")
  }
  try {
    return boundedText(String(value))
  } catch {
    return "Unknown error"
  }
}

function budgetedString(value: string, budget: ErrorSerializationBudget): string | Record<string, unknown> {
  const bounded = boundedString(value)
  return budget.canAdd(bounded) ? bounded : truncation("output-budget")
}

function boundedString(value: string): string | { value: string; truncated: true; originalByteLength: number } {
  const redacted = redactString(value)
  const bytes = Buffer.byteLength(redacted)
  if (bytes <= MAX_ERROR_STRING_BYTES) {
    return redacted
  }
  return { value: Buffer.from(redacted).subarray(0, MAX_ERROR_STRING_BYTES).toString("utf8"), truncated: true, originalByteLength: bytes }
}

function boundedText(value: string): string {
  const bounded = boundedString(value)
  return typeof bounded === "string" ? bounded : `${bounded.value}\n[truncated; originalByteLength=${bounded.originalByteLength}]`
}

function budgetedText(value: string, fallback: string | undefined, budget: ErrorSerializationBudget): string | undefined {
  const bounded = boundedText(value)
  if (budget.canAdd(bounded)) return bounded
  if (fallback && budget.canAdd(fallback)) return fallback
  return undefined
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

function binaryType(value: ArrayBuffer | ArrayBufferView): string {
  if (value instanceof ArrayBuffer) return "ArrayBuffer"
  if (Buffer.isBuffer(value)) return "Buffer"
  if (value instanceof DataView) return "DataView"
  for (const constructor of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array]) {
    if (value instanceof constructor) return constructor.name
  }
  return "ArrayBufferView"
}

function binaryByteLength(value: ArrayBuffer | ArrayBufferView): number {
  try {
    if (value instanceof ArrayBuffer) {
      const byteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
      return typeof byteLengthGetter === "function" ? byteLengthGetter.call(value) : 0
    }
    if (value instanceof DataView) {
      const byteLengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get
      return typeof byteLengthGetter === "function" ? byteLengthGetter.call(value) : 0
    }
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as { byteLength: number }
    const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get
    return typeof byteLengthGetter === "function" ? byteLengthGetter.call(value) : 0
  } catch {
    return 0
  }
}

export function cliFailureEnvelope(command: string | undefined, message: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  const { error, ...diagnosticDetails } = details
  return {
    schema: "wp-codebox/cli-failure/v1",
    success: false,
    status: "error",
    ...(command ? { command } : {}),
    error: isCliError(error) ? error : {
      name: "Error",
      message,
    },
    diagnostics: [
      {
        code: "cli-error",
        message,
        ...diagnosticDetails,
      },
    ],
  }
}

export function wantsJsonOutput(args: readonly string[]): boolean {
  return args.includes("--json") || args.includes("--format=json") || args.some((arg, index) => arg === "--format" && args[index + 1] === "json")
}

export function writeJsonFailure(command: string | undefined, message: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify(cliFailureEnvelope(command, message, details), null, 2)}\n`)
}

export function printHumanOutput(output: RunOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox failed")
    return
  }

  console.log("WP Codebox run")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Executed: ${output.execution?.command ?? "unknown"}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
  printPreviewAccess(output.artifacts)
}

export function printBootHumanOutput(output: RunOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox boot failed")
    return
  }

  console.log("WP Codebox boot")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
  printPreviewAccess(output.artifacts)
}

export function printBlueprintValidateHumanOutput(output: BlueprintValidateOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox blueprint validation failed")
    return
  }

  console.log("WP Codebox blueprint validation")
  console.log(`Blueprint: ${output.blueprintPath ?? "inline"}`)
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
  printPreviewAccess(output.artifacts)
}

export function printRecipeHumanOutput(output: RecipeRunOutputLike): void {
  if (!output.success) {
    console.error(output.error?.message ?? "WP Codebox recipe failed")
    for (const issue of output.validation?.issues ?? []) {
      console.error(`- ${issue.code} ${issue.path}: ${issue.message}`)
    }
    return
  }

  if (output.dryRun) {
    console.log("WP Codebox recipe dry-run")
    console.log(`Steps: ${output.plan?.workflow?.steps?.length ?? 0}`)
    console.log(`Mounts: ${output.plan?.mounts?.length ?? 0}`)
    console.log(`Workspaces: ${output.plan?.workspaces?.length ?? 0}`)
    console.log(`Extra plugins: ${output.plan?.extra_plugins?.length ?? 0}`)
    console.log(`Site seeds: ${output.plan?.siteSeeds?.length ?? 0}`)
    console.log(`Staged files: ${output.plan?.stagedFiles?.length ?? 0}`)
    return
  }

  console.log("WP Codebox recipe")
  console.log(`Runtime: ${output.runtime?.backend ?? "unknown"}`)
  console.log(`Steps: ${output.executions?.length ?? 0}`)
  console.log(`Artifacts: ${output.artifacts?.directory ?? "none"}`)
  printPreviewAccess(output.artifacts)
}

function printPreviewAccess(artifacts: ArtifactBundle | undefined): void {
  const preview = artifacts?.preview
  if (!preview) {
    return
  }

  const access = preview.reviewerAccess
  if (access?.openUrl) {
    const lease = access.lease ? `, lease=${access.lease.status}, alignment=${access.lease.alignmentStatus ?? "unknown"}, reviewerSafe=${access.lease.reviewerSafe ? "yes" : "no"}` : ""
    console.log(`Preview: ${access.openUrl} (${access.status}, ${access.mode}${lease})`)
    return
  }

  if (access?.reason) {
    const lease = access.lease ? `, lease=${access.lease.status}, alignment=${access.lease.alignmentStatus ?? "unknown"}, reviewerSafe=${access.lease.reviewerSafe ? "yes" : "no"}` : ""
    console.log(`Preview: ${access.status} (${access.reason}${lease})`)
    return
  }

  console.log(`Preview: ${preview.status}`)
}

export function printRecipeValidateHumanOutput(output: RecipeValidateOutputLike): void {
  console.log("WP Codebox recipe validation")
  console.log(`Recipe: ${output.recipePath ?? "unknown"}`)
  console.log(`Valid: ${output.valid ? "yes" : "no"}`)
  if (output.summary) {
    console.log(`Steps: ${output.summary.steps}`)
    console.log(`Mounts: ${output.summary.mounts}`)
    console.log(`Workspaces: ${output.summary.workspaces}`)
    console.log(`Extra plugins: ${output.summary.extraPlugins}`)
    if (output.summary.stagedFiles !== undefined) {
      console.log(`Staged files: ${output.summary.stagedFiles}`)
    }
  }

  for (const issue of output.issues) {
    console.log(`- ${issue.code} ${issue.path}: ${issue.message}`)
  }
}

export function printArtifactVerifyHumanOutput(output: ArtifactBundleVerificationResult): void {
  console.log("WP Codebox artifact bundle verification")
  console.log(`Bundle: ${output.bundleDirectory}`)
  console.log(`Valid: ${output.valid ? "yes" : "no"}`)
  for (const violation of output.violations) {
    console.log(`- ${violation.code} ${violation.path}: ${violation.message}`)
  }
}

export function printBatchHumanOutput(output: BatchOutputLike): void {
  console.log("WP Codebox batch")
  console.log(`Runs: ${output.completed}/${output.total} completed`)
  console.log(`Concurrency: ${output.concurrency}`)
  for (const run of output.runs) {
    console.log(`${run.success ? "ok" : "fail"} #${run.index + 1}: ${run.task}`)
    if (run.artifacts?.directory) {
      console.log(`  Artifacts: ${run.artifacts.directory}`)
    }
  }
}

export function printCommandCatalogHumanOutput(output: CommandCatalogOutputLike): void {
  console.log("WP Codebox commands")
  for (const command of output.commands) {
    const requiredArgs = command.acceptedArgs.filter((arg) => arg.required).map((arg) => arg.name)
    console.log(`${command.id}: ${command.description}`)
    if (requiredArgs.length > 0) {
      console.log(`  Required args: ${requiredArgs.join(", ")}`)
    }
    console.log(`  Output: ${command.outputShape}`)
    console.log(`  Policy: ${command.policyRequirement}`)
  }
}

export function printRecipeSchemaHumanOutput(output: RecipeSchemaOutputLike): void {
  const properties = output.jsonSchema.properties && typeof output.jsonSchema.properties === "object" ? Object.keys(output.jsonSchema.properties) : []
  console.log("WP Codebox recipe schema")
  console.log(`Schema: ${output.id}`)
  console.log(`Top-level fields: ${properties.join(", ")}`)
}

export function printRuntimeDescriptorHumanOutput(output: { schema: string; readiness: { status: string }; capabilities: readonly string[]; contractManifest: { schema: string } }): void {
  console.log("WP Codebox runtime descriptor")
  console.log(`Schema: ${output.schema}`)
  console.log(`Readiness: ${output.readiness.status}`)
  console.log(`Contract manifest: ${output.contractManifest.schema}`)
  console.log(`Capabilities: ${output.capabilities.join(", ")}`)
}

export function printHelp(): void {
  const recipeCommandIds = listCliRecipeCommandDefinitions().map((command) => command.id)

  console.log(`Usage:
  wp-codebox version
  wp-codebox commands [--json]
  wp-codebox runtime descriptor [--json]
  wp-codebox schema recipe [--json]
  wp-codebox doctor [--json] [--fix] [--archive-root <dir>] [--run-registry <dir>] [--stale-after-seconds <n>] [--temp-scan-limit <n>] [--temp-usage-entry-limit <n>]
  wp-codebox cleanup [--json] [--archive-root <dir>] [--run-registry <dir>] [--stale-after-seconds <n>] [--temp-scan-limit <n>] [--temp-usage-entry-limit <n>]
  wp-codebox workspace-policy check --workspace-root <path> --writable-root <path> [options]
  wp-codebox recipe build phpunit|bench|template|generic-ability-runtime-run|runtime-package-run --options <path> [--output <path>]
  wp-codebox recipe validate --recipe <path> [--policy <json|file>] [--json]
  wp-codebox bench matrix --matrix <path> [--recipe <path>] [--artifacts <dir>] [--json]
  wp-codebox bench summarize (--input <recipe-run.json>|--bundle <dir>) [--json]
  wp-codebox bench compare --baseline <recipe-run.json> --candidate <recipe-run.json> [--json]
  wp-codebox artifacts verify --bundle <dir> [--json]
  wp-codebox artifacts apply-preflight --bundle <dir> --approved-file <path> [--json]
  wp-codebox artifacts browser-metrics --bundle <dir> [--json]
  wp-codebox artifacts diagnostics --input <json> [--source <id>] [--stage <id>] [--observation-type <id>] [--ref <path[:kind]>] [--json]
  wp-codebox artifacts transfer-verify --bundle <dir> [--private-host-pattern <host>] [--json]
  wp-codebox artifacts transfer-probes --bundle <dir> [--json]
  wp-codebox artifacts discover-partial --artifacts <dir> [--session-id <id>] [--started-at <iso>] [--finished-at <iso>] [--json]
  wp-codebox artifacts benchmark --bundle <dir> [--scenario-id <id>] [--extract-to <dir>] [--json]
  wp-codebox artifacts bench-results --bundle <dir> [--json]
  wp-codebox artifacts bench-compare --baseline-bundle <dir> --candidate-bundle <dir> [--json]
  wp-codebox runs status --registry <dir> --run-id <id> [--json]
  wp-codebox runs artifacts --registry <dir> --run-id <id> [--json]
  wp-codebox runs cancel --registry <dir> --run-id <id> [--reason <text>] [--json]
  wp-codebox preview-lease status (--registry <dir> --lease-id <id>|--lease-file <path>) [--json]
  wp-codebox preview-lease release (--registry <dir> --lease-id <id>|--lease-file <path>) [--json]
  wp-codebox target provision [--id <id>] [--kind <kind>] [--workspace-root <dir>] [--json]
  wp-codebox run-fuzz-suite --input-file <path> [--format=json] [--dry-run] [--runner-mode=simple|runtime-backed]
  wp-codebox adversarial run --recipe <path> [recipe-run options]
  wp-codebox adversarial replay --recipe <path> --replay <path> [recipe-run options]
  wp-codebox fuzz-minimize-case --input-file <path> [--format=json] [--dry-run]
  wp-codebox run-wordpress-workload --input-file <path> [--format=json] [--dry-run]
  wp-codebox run-agent-task --input-file <path> [--json] [--preview-hold-seconds <n>] [--preview-hold-blocking] [--preview-port <port>] [--preview-bind <host>] [--preview-public-url <url>] [--preview-lease-json <json>]
  wp-codebox agent-task-run --input-file <path> [--json] [--result-file <path>] [--preview-hold-seconds <n>] [--preview-hold-blocking] [--preview-port <port>] [--preview-bind <host>] [--preview-public-url <url>] [--preview-lease-json <json>]
  wp-codebox validate-blueprint --blueprint <json|file> [options]
  wp-codebox materialize-replay-package --snapshot <path> --output <dir> [--snapshot-ref <ref>] [--json]
  wp-codebox recipe-run --recipe <path> [options]
  wp-codebox boot [--mount <host>:<vfs>] [options]
  wp-codebox run --mount <host>:<vfs> --command <id> [options]

Options:
  --recipe <path>     Workspace recipe JSON file for recipe-run or recipe validate.
  --options <path>    Recipe builder options JSON file for recipe build.
  --output <path>     Recipe build/run output JSON path, or materialize-replay-package output directory.
  --input-file <path> Input JSON for public workload/fuzz commands or agent-task-run.
  --result-file <path> Atomically write the final agent-task-run JSON result to a caller-owned file.
  --format=json       Emit machine-readable JSON; accepted by public workload/fuzz commands.
  --preview-hold-seconds <n>
                    Keep preview runtimes alive after run-agent-task/agent-task-run/recipe-run.
                    Max 3600s by default; operators may raise the cap with WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS.
  --preview-hold-blocking
                    Block before releasing held previews after run-agent-task/agent-task-run/recipe-run.
  --preview-port <port>
                    Fixed local preview proxy port for run-agent-task/agent-task-run/recipe-run.
  --preview-bind <host>
                    Bind host or IP for a fixed preview proxy port. Requires --preview-port.
  --preview-public-url <url>
                    Public preview URL passed through to run-agent-task/agent-task-run/recipe-run.
  --preview-lease-json <json>
                    wp-codebox/preview-lease/v1 envelope to report for external preview handoff metadata.
  --bundle <dir>      Artifact bundle directory for artifact verification/probe commands.
  --source <id>       Default source for artifacts diagnostics normalization.
  --stage <id>        Default stage for artifacts diagnostics normalization.
  --observation-type <id>
                       Default observation type for artifacts diagnostics normalization.
  --ref <path[:kind]> Default artifact diagnostic reference. Repeatable.
  --approved-file <path>
                       Changed file approved for artifacts apply-preflight. Repeatable.
  --approved-files <paths>
                        Comma-separated changed files approved for artifacts apply-preflight.
  --private-host-pattern <host>
                       Host pattern treated as private reviewer evidence for transfer-verify.
                       Repeatable; supports exact hosts and *.suffix patterns. Can also be set with
                       WP_CODEBOX_TRANSFER_PROOF_PRIVATE_HOSTS.
  --scenario-id <id>  Filter benchmark artifact refs to one scenario.
  --extract-to <dir>  Copy listed benchmark artifact refs to a directory.
  --input <path>      Saved recipe-run JSON output for benchmark summarization.
  --matrix <path>     Benchmark recipe matrix JSON file for bench matrix.
  --baseline <path>
                        Saved baseline recipe-run JSON for benchmark comparison.
  --candidate <path>
                        Saved candidate recipe-run JSON for benchmark comparison.
  --baseline-bundle <dir>
                       Baseline artifact bundle directory for benchmark comparison.
  --candidate-bundle <dir>
                       Candidate artifact bundle directory for benchmark comparison.
  --baseline-index <n>
                       Benchmark envelope index to compare when a source has multiple results.
  --candidate-index <n>
                       Benchmark envelope index to compare when a source has multiple results.
  --artifacts <dir>   Artifact root directory. Also accepted by artifacts verify.
  --session-id <id>   Prefer partial artifact directories matching this sandbox/session id.
  --started-at <iso>  Lower timestamp bound for partial artifact discovery.
  --finished-at <iso> Upper timestamp bound for partial artifact discovery.
  --run-registry <dir>
                       Durable run registry directory for recipe-run.
  --registry <dir>    Durable run registry directory for runs lookup commands.
  --run-id <id>       Run ID for runs lookup commands.
  --lease-id <id>     Preview lease ID for preview-lease status/release.
  --lease-file <path> Preview lease metadata file for preview-lease status/release.
  --id <id>           Target id for target provision. Defaults to default.
  --kind <kind>       Target kind for target provision. Defaults to generic.
  --artifact-public-url-root <url>
                       Optional public artifact URL root for target provision.
  --artifact-path-prefix <path>
                       Optional safe relative artifact prefix for target provision.
  --trusted-origin <url>
                       Trusted browser-session origin for target provision. Repeatable.
  --mount <host:vfs>   Mount a host path into the runtime. Repeatable.
  --command <id>       Command/action id to execute.
  --arg <key=value>    Command argument. Repeatable.
  --wp <version>       WordPress version for Playground. Defaults to latest; accepts trunk, nightly, or numeric versions.
  --blueprint <json|file>
                        WordPress Playground blueprint JSON or path for boot or validate-blueprint.
  --snapshot <path>     Runtime snapshot JSON file for materialize-replay-package.
  --snapshot-ref <ref>  Optional external reference for the input snapshot source metadata.
  --artifacts <dir>    Artifact root directory.
  --preview-hold-seconds <n>
                       Keep the live Playground preview available after a successful run. Accepts seconds, minutes, or hours, e.g. 30s, 15m, or 2h; max 3600s unless WP_CODEBOX_PREVIEW_HOLD_MAX_SECONDS raises the cap.
  --preview-lease     Return after the preview is available while a detached child keeps the runtime alive until released or expired.
  --preview-port <n>   Start Playground on a fixed local port. Defaults to a random available port.
  --preview-bind <host>
                       Host/IP for the fixed-port WP Codebox preview proxy. Requires --preview-port.
                       Defaults to 127.0.0.1; use 0.0.0.0 only behind trusted network controls.
  --preview-public-url <url>
                         Public tunnel/proxy URL to report in preview artifacts and pass to Playground as site-url.
                         Upstream Playground remains loopback-bound; this only changes the WP Codebox proxy bind.
  --preview-lease-json <json>
                         wp-codebox/preview-lease/v1 envelope for public/local URL, expiry, alignment, and handoff metadata.
  --timeout <duration>  Maximum live recipe-run duration before emitting a structured timeout failure. Defaults to 25m.
  --policy <json|file> Runtime policy JSON or path to a JSON file. For recipe-run and recipe validate, this overrides the recipe-derived runtime policy and must include every command required by the recipe setup, probes, and workflow.
  --approve-external-service-writes
                       Explicitly approve short-lived managed writes to declared external-service boundaries when policy.approvals is on-write.
  --dry-run            Validate recipe-run and emit a resolved JSON plan without booting Playground or writing temp workspaces.
  --json               Emit machine-readable JSON.

Doctor and cleanup:
  doctor               Report binary/source fingerprint, stale processes, owned temp runtimes, and corrupt archives.
  cleanup              Remove only age-gated, inactive owned temp runtimes and safe corrupt runtime state.
  --fix                Allow mutating cleanup when command is doctor.
  --stale-after-seconds <n>
                       Age threshold for stale recipe-run processes and orphaned temp runtimes. Defaults to 3600.
  --archive-root <dir> Additional archive/cache root to scan for invalid .zip files. Repeatable.
  --run-registry <dir> Run registry checked for active preview leases and recent run heartbeats. Repeatable.
                       Defaults to ./artifacts/runs; additional defaults may be set with WP_CODEBOX_RUN_REGISTRY_ROOTS.

Workspace policy:
  --workspace-root <dir>
                       Workspace root to inspect. Defaults to the current directory.
  --writable-root <path>
                       Relative path that may be changed. Repeatable.
  --hidden-path <path> Relative path that must not be changed or exposed. Repeatable.
  --git                Use git status metadata, including ignored and unmerged entries.

Discovery:
  commands             Print supported runtime and recipe command metadata.
  runtime descriptor   Print public runtime readiness, capabilities, ability names, and contract manifest.
  schema recipe        Print the wp-codebox/workspace-recipe/v1 JSON Schema.

Version:
  version | --version | -v
                       Print the wp-codebox CLI version (read from the CLI package.json) and exit.

Recipe commands:
${recipeCommandIds.map((id) => `  ${id}`).join("\n")}

Example:
  wp-codebox run --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin --command wordpress.run-php --arg code-file=./examples/simple-plugin/probe.php --artifacts ./artifacts --json`)
}
