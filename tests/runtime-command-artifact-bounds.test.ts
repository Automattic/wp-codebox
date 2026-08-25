import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COMMAND_ARTIFACT_STRING_MAX_BYTES,
  COMMAND_ARTIFACT_COMMAND_STRING_MAX_BYTES,
  COMMAND_ARTIFACT_MAX_NODES,
  COMMAND_ARTIFACT_MAX_RECORDS,
  COMMAND_ARTIFACT_TOTAL_STRING_MAX_BYTES,
  boundedExecutionResultsForArtifacts,
} from "../packages/runtime-core/src/bounded-execution-results.js"
import { collectPlaygroundArtifacts, formatCommandsLog } from "../packages/runtime-playground/src/runtime-artifact-helpers.js"
import { collectRecipeRuntimeArtifacts } from "../packages/cli/src/recipe-evidence.js"
import { boundedRecipeJsonOutput, serializeRecipeRunError } from "../packages/cli/src/commands/recipe-run-output.js"
import type { ExecutionResult } from "../packages/runtime-core/src/runtime-contracts.js"

const oversized = "x".repeat(COMMAND_ARTIFACT_STRING_MAX_BYTES + 1024)
const command: ExecutionResult = {
  id: "command-7",
  command: "wordpress.apply-site-plan",
  args: ["--plan", "fixture.json"],
  exitCode: 0,
  stdout: oversized,
  stderr: "",
  result: {
    schema: "wp-codebox/runtime-command-result/v1",
    status: "ok",
    stdout: oversized,
    json: { artifact: oversized },
  },
  diagnostics: { retained: oversized },
  startedAt: "2026-07-21T20:00:00.000Z",
  finishedAt: "2026-07-21T20:01:00.000Z",
}

const projected = boundedExecutionResultsForArtifacts([command])
const record = projected[0]
assert(record, "the command remains represented")
assert.equal(record.id, command.id)
assert.equal(record.command, command.command)
assert.equal(record.startedAt, command.startedAt)
assert.equal(Buffer.byteLength(record.stdout), COMMAND_ARTIFACT_STRING_MAX_BYTES)
assert.equal(Buffer.byteLength(record.result?.stdout ?? ""), 0)
assert(record.artifactCapture?.truncated)
assert.deepEqual(record.artifactCapture?.fields.map(({ path }) => path), [
  "stdout",
  "result.json.artifact",
  "result.schema",
  "result.status",
  "result.stdout",
  "diagnostics.retained",
])
assert.deepEqual(record.artifactCapture?.fields.map(({ reason }) => reason), [
  "string-byte-limit",
  "command-string-byte-limit",
  "command-string-byte-limit",
  "command-string-byte-limit",
  "command-string-byte-limit",
  "command-string-byte-limit",
])
assert.equal(record.artifactCapture?.fields.find((field) => field.path === "stdout")?.observedBytes, Buffer.byteLength(oversized))
assert(Buffer.byteLength(JSON.stringify(projected)) < COMMAND_ARTIFACT_TOTAL_STRING_MAX_BYTES)

const commandsLog = formatCommandsLog(projected)
assert.match(commandsLog, /wordpress\.apply-site-plan --plan fixture\.json/)
assert(Buffer.byteLength(commandsLog) <= COMMAND_ARTIFACT_STRING_MAX_BYTES + 1024)
assert(!commandsLog.includes(oversized))

const unicode = "😀".repeat(COMMAND_ARTIFACT_STRING_MAX_BYTES)
const unicodeRecord = boundedExecutionResultsForArtifacts([{ ...command, stdout: unicode, result: undefined, diagnostics: undefined }])[0]
assert(unicodeRecord)
assert(Buffer.byteLength(unicodeRecord.stdout) <= COMMAND_ARTIFACT_STRING_MAX_BYTES)
assert(!/[\uD800-\uDBFF]$/.test(unicodeRecord.stdout), "UTF-8 truncation does not split a surrogate pair")

const commandBudgetRecord = boundedExecutionResultsForArtifacts([{
  ...command,
  stdout: "",
  result: undefined,
  diagnostics: Array.from({ length: 20 }, () => oversized),
}])[0]
assert(commandBudgetRecord?.artifactCapture?.fields.some((field) => field.reason === "command-string-byte-limit"))
assert.equal(commandBudgetRecord?.artifactCapture?.limits.capturedStringBytesPerCommand, COMMAND_ARTIFACT_COMMAND_STRING_MAX_BYTES)
assert(Buffer.byteLength(JSON.stringify(commandBudgetRecord)) < COMMAND_ARTIFACT_COMMAND_STRING_MAX_BYTES + 64 * 1024)

const totalBudgetRecords = boundedExecutionResultsForArtifacts(Array.from({ length: 10 }, (_, index) => ({
  ...command,
  id: `total-budget-${index}`,
  stdout: "",
  result: undefined,
  diagnostics: [oversized, oversized],
})))
assert(totalBudgetRecords.some((record) => record.artifactCapture?.fields.some((field) => field.reason === "total-string-byte-limit")))

const nodeBudgetRecord = boundedExecutionResultsForArtifacts([{
  ...command,
  stdout: "",
  result: undefined,
  diagnostics: Array.from({ length: 20 }, () => Array.from({ length: 2_000 }, () => "x")),
}])[0]
assert(nodeBudgetRecord?.artifactCapture?.fields.some((field) => field.reason === "node-limit"))
assert.equal(nodeBudgetRecord?.artifactCapture?.limits.nodes, COMMAND_ARTIFACT_MAX_NODES)

const fixture37Commands: ExecutionResult[] = [
  {
    ...command,
    id: "fixture-37-import",
    command: "wordpress.import",
    stdout: "",
    result: undefined,
    diagnostics: Array.from({ length: COMMAND_ARTIFACT_MAX_NODES }, () => ({ import: "node" })),
  },
  ...Array.from({ length: 7 }, (_, index) => ({
    ...command,
    id: `fixture-37-editor-open-${index}`,
    command: "wordpress.editor-open",
    args: [`/page-${index}`],
    stdout: "editor opened",
    result: { status: "ok", page: index },
    diagnostics: { session: `editor-${index}` },
  })),
  ...Array.from({ length: 7 }, (_, index) => ({
    ...command,
    id: `fixture-37-editor-validate-${index}`,
    command: "wordpress.editor-validate-blocks",
    args: [`/page-${index}`],
    stdout: "validation passed",
    result: { status: "ok", valid: true, metrics: { blockCount: index + 1 } },
    diagnostics: { validation: "passed" },
  })),
  ...Array.from({ length: 7 }, (_, index) => ({
    ...command,
    id: `fixture-37-visual-compare-${index}`,
    command: "wordpress.visual-compare",
    args: [`/page-${index}`],
    stdout: "visual comparison passed",
    result: { status: "ok", artifactRefs: [`visual-${index}.png`], metrics: { similarity: 1 } },
    diagnostics: { comparison: "passed" },
  })),
]
const fixture37Records = boundedExecutionResultsForArtifacts(fixture37Commands)
assert.equal(fixture37Records.length, fixture37Commands.length)
assert(fixture37Records[0]?.artifactCapture?.fields.some((field) => field.reason === "node-limit"))
const capturedImportNodes = (fixture37Records[0]?.diagnostics as Array<{ import?: string }>).filter(({ import: value }) => value === "node").length
assert(capturedImportNodes <= Math.ceil(COMMAND_ARTIFACT_MAX_NODES / fixture37Commands.length))
for (const record of fixture37Records.slice(1)) {
  assert(record.args.length > 0)
  assert(record.stdout.length > 0)
  assert.equal((record.result as { status?: string } | undefined)?.status, "ok")
  assert(Object.keys(record.diagnostics ?? {}).length > 0)
}
assert.deepEqual(boundedExecutionResultsForArtifacts(fixture37Commands), fixture37Records)

const manyCommands = Array.from({ length: COMMAND_ARTIFACT_MAX_RECORDS + 2 }, (_, index) => ({
  ...command,
  id: `command-${index}`,
  stdout: "ok",
  result: undefined,
  diagnostics: undefined,
}))
const boundedCommands = boundedExecutionResultsForArtifacts(manyCommands)
assert.equal(boundedCommands.length, COMMAND_ARTIFACT_MAX_RECORDS)
assert.equal(boundedCommands.at(-1)?.id, `command-${COMMAND_ARTIFACT_MAX_RECORDS + 1}`)
assert.equal(boundedCommands.at(-1)?.artifactCapture?.omittedCommandCount, 2)

const boundedRecipeOutput = boundedRecipeJsonOutput({
  schema: "wp-codebox/recipe-run/v1",
  executions: [{ ...command, recipePhase: "workflow", recipeStepIndex: 4, recipeCommand: "wordpress.apply-site-plan" }],
}) as { executions: Array<ExecutionResult & { recipePhase?: string; recipeStepIndex?: number; recipeCommand?: string; artifactCapture?: unknown }> }
assert.equal(boundedRecipeOutput.executions[0]?.recipePhase, "workflow")
assert.equal(boundedRecipeOutput.executions[0]?.recipeStepIndex, 4)
assert.equal(boundedRecipeOutput.executions[0]?.recipeCommand, "wordpress.apply-site-plan")
assert(boundedRecipeOutput.executions[0]?.artifactCapture)
assert(Buffer.byteLength(JSON.stringify(boundedRecipeOutput)) < COMMAND_ARTIFACT_TOTAL_STRING_MAX_BYTES)

const boundedRecipeSequence = boundedRecipeJsonOutput({
  executions: [
    { ...command, result: undefined, diagnostics: [oversized, oversized, oversized], recipePhase: "steps", recipeStepIndex: 1, recipeCommand: "wordpress.import" },
    { ...command, id: "later-command", stdout: "later evidence", result: undefined, diagnostics: undefined, recipePhase: "steps", recipeStepIndex: 2, recipeCommand: "wordpress.visual-compare" },
  ],
}) as { executions: Array<ExecutionResult & { recipePhase?: string; recipeStepIndex?: number; recipeCommand?: string }> }
assert.equal(boundedRecipeSequence.executions[1]?.stdout, "later evidence")
assert.equal(boundedRecipeSequence.executions[1]?.recipePhase, "steps")
assert.equal(boundedRecipeSequence.executions[1]?.recipeCommand, "wordpress.visual-compare")

const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-command-artifact-bounds-"))
try {
  await collectPlaygroundArtifacts({
    artifactRoot,
    browserProbes: [],
    commands: [command],
    createdAt: "2026-07-21T19:59:00.000Z",
    events: [],
    info: async () => ({ id: "runtime-1", backend: "playground", status: "ready", environment: { version: "latest" } }),
    mounts: [],
    observations: [],
    pluginChecks: [],
    previewInfo: async () => undefined,
    recordArtifactsCollected: () => {},
    runtimeId: "runtime-1",
    snapshots: [],
    spec: { environment: { blueprint: {} } },
    themeChecks: [],
  })
  const persistedRecord = JSON.parse((await readFile(join(artifactRoot, "commands.jsonl"), "utf8")).trim())
  assert.equal(persistedRecord.command, command.command)
  assert.equal(persistedRecord.artifactCapture.schema, "wp-codebox/command-artifact-capture/v1")
  assert(Buffer.byteLength(await readFile(join(artifactRoot, "logs", "commands.log"), "utf8")) <= COMMAND_ARTIFACT_STRING_MAX_BYTES + 1024)
} finally {
  await rm(artifactRoot, { recursive: true, force: true })
}

const partialBrowserArtifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-partial-browser-artifact-"))
try {
  await mkdir(join(partialBrowserArtifactRoot, "files/browser"), { recursive: true })
  await writeFile(join(partialBrowserArtifactRoot, "files/browser/summary.json"), "{}\n")
  const partialBrowserBundle = await collectPlaygroundArtifacts({
    artifactRoot: partialBrowserArtifactRoot,
    browserProbes: [{
      artifactType: "actions",
      requestedUrl: "http://127.0.0.1:9400/",
      url: "http://127.0.0.1:9400/",
      preview: { requestedMode: "local", mode: "local", requestedOrigin: "http://127.0.0.1:9400", localOrigin: "http://127.0.0.1:9400", effectiveOrigin: "http://127.0.0.1:9400", secureContext: false, capabilities: [], fallbacks: [] },
      files: { summary: "files/browser/summary.json", screenshot: "files/browser/screenshot.png" },
      summary: { actions: 1, steps: 1, consoleMessages: 0, errors: 1, networkEvents: 0, screenshot: true, finalUrl: "http://127.0.0.1:9400/", viewport: null, replayability: "partial" },
    }],
    commands: [], createdAt: "2026-07-21T19:59:00.000Z", events: [],
    info: async () => ({ id: "partial-browser", backend: "playground", status: "ready", environment: { version: "latest" } }),
    mounts: [], observations: [{ type: "adversarial-finding", data: { diagnostics: [{ severity: "error", message: "navigation blocked" }] } }], pluginChecks: [],
    previewInfo: async () => undefined, recordArtifactsCollected: () => {}, runtimeId: "partial-browser", snapshots: [], spec: { environment: { blueprint: {} } }, themeChecks: [],
  })
  const diagnostics = JSON.parse(await readFile(join(partialBrowserArtifactRoot, "files/diagnostics.json"), "utf8"))
  assert.equal(diagnostics.diagnostics.some((diagnostic: { message?: string }) => diagnostic.message === "navigation blocked"), true)
  assert.equal(diagnostics.diagnostics.some((diagnostic: { code?: string }) => diagnostic.code === "browser-capture-not-materialized"), true)
  const review = JSON.parse(await readFile(partialBrowserBundle.reviewPath, "utf8"))
  assert.equal(review.browser.probes[0].screenshot, undefined)
  const manifest = JSON.parse(await readFile(partialBrowserBundle.manifestPath, "utf8"))
  assert.equal(manifest.files.some((file: { path?: string }) => file.path === "files/browser/screenshot.png"), false)
  assert.equal(manifest.files.some((file: { path?: string }) => file.path === "files/browser/summary.json"), true)
} finally {
  await rm(partialBrowserArtifactRoot, { recursive: true, force: true })
}

const collectionCause = Object.assign(new RangeError("Invalid string length"), {
  code: "command-artifact-collection-failed",
  artifactPath: "commands.jsonl",
  payload: { commandCount: 7, stdoutBytes: 65_683_096 },
  limits: { totalStringBytes: COMMAND_ARTIFACT_TOTAL_STRING_MAX_BYTES },
  causeStack: "RangeError: Invalid string length\n    at ArtifactBundleBuilder.build",
})
let collectionError: unknown
try {
  await collectRecipeRuntimeArtifacts({
    collectArtifacts: async () => { throw collectionCause },
  } as any, {}, {
    activeExecution: { ...command, recipePhase: "workflow", recipeStepIndex: 4, recipeCommand: "wordpress.apply-site-plan" },
  })
} catch (error) {
  collectionError = error
}
const serializedError = serializeRecipeRunError(collectionError)
assert.equal(serializedError.code, "recipe-artifact-collection-failed")
assert.equal(serializedError.operation, "runtime.collect-artifacts")
assert.equal(serializedError.workflowStepIndex, 4)
assert.equal(serializedError.command, "wordpress.apply-site-plan")
assert.equal(serializedError.artifactPath, "commands.jsonl")
assert.deepEqual(serializedError.payload, collectionCause.payload)
assert.deepEqual(serializedError.limits, collectionCause.limits)
assert.equal(serializedError.causeStack, collectionCause.causeStack)
assert.equal((serializedError.cause as { code?: string } | undefined)?.code, "command-artifact-collection-failed")

console.log("runtime command artifact bounds ok")
